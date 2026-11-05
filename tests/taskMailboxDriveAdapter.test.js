'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { TaskMailboxDriveAdapter, MAILBOX_PREFIX } = require('../src/core/TaskMailboxDriveAdapter.js');

const ACCOUNT_HASH = 'a'.repeat(64);
const digest = (value, size = 32) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, size);

function makeHarness({ accountHash = ACCOUNT_HASH, folderValid = true, pageSize = 100, storeOverrides = {} } = {}) {
  const files = new Map();
  let nextId = 0;
  const calls = { listed: [], created: [], importedTasks: [], importedMessages: [] };
  const connector = {
    async driveGetAccountIdentityHash() { return accountHash; },
    async driveVerifyMailboxFolder(folderId) {
      return folderValid
        ? { folderId, canListChildren: true, canAddChildren: true }
        : { folderId, canListChildren: true, canAddChildren: false };
    },
    async driveListFiles({ q, pageSize: limit, pageToken }) {
      calls.listed.push({ q, pageToken });
      const matching = [...files.values()].filter(file => q.includes(file.name) || q.includes(MAILBOX_PREFIX) || q.includes("name = '"));
      const offset = pageToken ? Number(pageToken) : 0;
      return { files: matching.slice(offset, offset + limit).map(({ id, name }) => ({ id, name })),
        ...(offset + limit < matching.length ? { nextPageToken: String(offset + limit) } : {}) };
    },
    async driveReadFile(fileId) {
      const file = [...files.values()].find(candidate => candidate.id === fileId);
      return file ? { content: file.content } : { error: { message: 'not found' } };
    },
    async driveCreateFile(name, mimeType, content, parentId) {
      calls.created.push({ name, mimeType, content, parentId });
      const id = `drive-${++nextId}`;
      files.set(id, { id, name, mimeType, content, parentId });
      return { id, name };
    }
  };
  const store = {
    hostId: 'host-local',
    exportConversationTask(taskKey) {
      return { schemaVersion: 1, taskKey, title: 'Bounded task', creatorChatId: 'chat-local', sourceHostId: 'host-local', createdAt: '2026-11-04T00:00:00.000Z' };
    },
    async importConversationTask(task) {
      calls.importedTasks.push(task);
      return { imported: true, replayed: false };
    },
    async importRemoteMessage(message) {
      calls.importedMessages.push(message);
      return { imported: true, replayed: false };
    },
    ...storeOverrides
  };
  return { adapter: new TaskMailboxDriveAdapter({ connector, store, folderId: 'folder-1', expectedAccountIdentityHash: ACCOUNT_HASH, peerHostId: 'host-remote', pageSize }), files, calls, connector, store };
}

test('publishes a path-free task envelope idempotently', async () => {
  const { adapter, calls, files } = makeHarness();
  const first = await adapter.publishTask('task-123');
  const replay = await adapter.publishTask('task-123');
  assert.equal(first.created, true);
  assert.equal(replay.replayed, true);
  assert.equal(calls.created.length, 1);
  const stored = JSON.parse([...files.values()][0].content);
  assert.deepEqual(Object.keys(stored), ['schemaVersion', 'type', 'task']);
  assert.equal(stored.task.sourceHostId, 'host-local');
  assert.equal('repositoryPath' in stored.task, false);
  const forwardedStore = makeHarness({ storeOverrides: { exportConversationTask: taskKey => ({ ...{
    schemaVersion: 1, taskKey, title: 'Remote task', creatorChatId: 'remote-chat', createdAt: '2026-11-04T00:00:00.000Z'
  }, sourceHostId: 'host-remote' }) } });
  await assert.rejects(forwardedStore.adapter.publishTask('task-forwarded'), /locally originated/);
});

test('publishes only host-targeted message fields and detects same-ID content conflicts', async () => {
  const { adapter, calls } = makeHarness();
  const message = { messageId: 'message-1', taskKey: 'task-123', senderChatId: 'chat-local', senderHostId: 'host-local',
    recipientChatId: 'chat-remote', recipientHostId: 'host-remote', type: 'message', text: 'Continue the task',
    inReplyToMessageId: null, createdAt: '2026-11-04T00:01:00.000Z', repositoryPath: '/private/path' };
  assert.equal((await adapter.publishMessage(message)).created, true);
  assert.equal((await adapter.publishMessage(message)).replayed, true);
  const published = JSON.parse(calls.created[0].content);
  assert.equal(published.message.repositoryPath, undefined);
  assert.equal(published.message.recipientHostId, 'host-remote');
  await assert.rejects(adapter.publishMessage({ ...message, text: 'Different payload' }), /different content/);
  await assert.rejects(adapter.publishMessage({ ...message, senderHostId: 'forged-host' }), /locally sent/);
  await assert.rejects(adapter.publishMessage({ ...message, recipientHostId: 'host-other' }), /not the configured Only Chat peer/);
});

test('imports only remote tasks and messages addressed to this host', async () => {
  const { adapter, connector, store, calls, files } = makeHarness();
  const incomingTask = { schemaVersion: 1, type: 'task', task: { schemaVersion: 1, taskKey: 'task-remote', title: 'Remote task',
    creatorChatId: 'chat-remote', sourceHostId: 'host-remote', createdAt: '2026-11-04T00:00:00.000Z' } };
  const addressed = { schemaVersion: 1, type: 'message', message: { messageId: 'remote-message', taskKey: 'task-remote',
    senderChatId: 'chat-remote', senderHostId: 'host-remote', recipientChatId: 'chat-local', recipientHostId: 'host-local',
    type: 'message', text: 'Hello', inReplyToMessageId: null, createdAt: '2026-11-04T00:02:00.000Z' } };
  const otherHost = { ...addressed, message: { ...addressed.message, messageId: 'other-message', recipientHostId: 'host-other' } };
  const ownHost = { ...addressed, message: { ...addressed.message, messageId: 'own-message', senderHostId: 'host-local' } };
  const unknownPeerTask = { ...incomingTask, task: { ...incomingTask.task, taskKey: 'task-rogue', sourceHostId: 'host-rogue' } };
  const unknownPeerMessage = { ...addressed, message: { ...addressed.message, messageId: 'rogue-message', senderHostId: 'host-rogue' } };
  const incoming = [
    [incomingTask, `${MAILBOX_PREFIX}task-${digest('task-remote', 24)}-${digest('host-remote', 24)}.json`],
    [addressed, `${MAILBOX_PREFIX}message-${digest('host-local', 24)}-${digest('remote-message')}.json`],
    [otherHost, `${MAILBOX_PREFIX}message-${digest('host-other', 24)}-${digest('other-message')}.json`],
    [ownHost, `${MAILBOX_PREFIX}message-${digest('host-local', 24)}-${digest('own-message')}.json`],
    [unknownPeerTask, `${MAILBOX_PREFIX}task-${digest('task-rogue', 24)}-${digest('host-rogue', 24)}.json`],
    [unknownPeerMessage, `${MAILBOX_PREFIX}message-${digest('host-local', 24)}-${digest('rogue-message')}.json`]
  ];
  for (const [index, [envelope, name]] of incoming.entries()) {
    const id = `in-${index}`;
    files.set(id, { id, name, content: JSON.stringify(envelope) });
  }
  const result = await adapter.syncIncoming();
  assert.deepEqual(result, { tasksImported: 1, messagesImported: 1, replayed: 0, ignored: 4 });
  assert.equal(calls.importedTasks.length, 1);
  assert.equal(calls.importedMessages.length, 1);
  assert.equal(calls.importedMessages[0].messageId, 'remote-message');
  assert.ok(connector);
  assert.ok(store);
});

test('fails closed when the Drive account or mailbox folder differs', async () => {
  const mismatched = makeHarness({ accountHash: 'b'.repeat(64) });
  await assert.rejects(mismatched.adapter.syncIncoming(), /account does not match/);
  assert.equal(mismatched.calls.listed.length, 0);
  const unreadable = makeHarness({ folderValid: false });
  await assert.rejects(unreadable.adapter.publishTask('task-123'), /folder is not verified/);
  assert.equal(unreadable.calls.created.length, 0);
});

test('follows Drive pagination and rejects a repeated cursor', async () => {
  const paged = makeHarness({ pageSize: 1 });
  paged.files.set('a', { id: 'a', name: `${MAILBOX_PREFIX}noise-a`, content: '{"schemaVersion":1,"type":"other"}' });
  paged.files.set('b', { id: 'b', name: `${MAILBOX_PREFIX}noise-b`, content: '{"schemaVersion":1,"type":"other"}' });
  const result = await paged.adapter.syncIncoming();
  assert.equal(result.ignored, 2);
  assert.equal(paged.calls.listed.length, 2);
  const repeated = makeHarness();
  repeated.connector.driveListFiles = async () => ({ files: [], nextPageToken: 'same' });
  await assert.rejects(repeated.adapter.syncIncoming(), /pagination cursor is invalid/);
});
