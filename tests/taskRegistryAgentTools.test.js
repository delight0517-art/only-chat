'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AgentEngine } = require('../src/core/AgentEngine.js');
const { TaskRegistryStore } = require('../src/core/TaskRegistryStore.js');
const { ToolRegistry } = require('../src/tools/ToolRegistry.js');

function makeEngine(store, sessionId, approvalPolicy = 'never') {
  const engine = Object.create(AgentEngine.prototype);
  engine.currentSession = { sessionId };
  engine.tools = new ToolRegistry({
    taskRegistryStore: store,
    approvalPolicy,
    providerConnectionsEnabled: false,
    browserEnabled: false
  });
  return engine;
}

test('Account Router tools share tasks across sessions and derive creator and claimant from the current session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-task-registry-tools-'));
  let store;
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    store = new TaskRegistryStore({ dataDir: path.join(root, 'data') });
    const chatA = makeEngine(store, 'session-chat-a');
    const created = await chatA._executeToolCall({ id: 'create-call-1', name: 'task_registry_create', args: {
      taskKey: 'coordinated-change', title: 'Update one shared feature', creatorChatId: 'spoofed-creator',
      repositoryPath: repo, baseSha: 'c'.repeat(40), paths: ['src/core/feature.js'],
      nextAction: 'Inspect the existing implementation'
    } });
    assert.equal(created.created, true);
    assert.equal(created.task.creatorChatId, 'session-chat-a');

    const chatB = makeEngine(store, 'session-chat-b');
    const listed = await chatB._executeToolCall({ id: 'list-call-1', name: 'task_registry_list', args: { limit: 20 } });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].taskKey, 'coordinated-change');
    const read = await chatB._executeToolCall({ id: 'read-call-1', name: 'task_registry_read', args: { taskKey: 'coordinated-change' } });
    assert.equal(read.creatorChatId, 'session-chat-a');

    const claim = await chatB._executeToolCall({ id: 'claim-call-1', name: 'task_registry_claim', args: {
      taskKey: 'coordinated-change', ownerChatId: 'spoofed-owner'
    } });
    assert.equal(claim.accepted, true);
    assert.equal(claim.ownerChatId, 'session-chat-b');

    const denied = await chatA._executeToolCall({ id: 'foreign-checkpoint', name: 'task_registry_checkpoint', args: {
      taskKey: 'coordinated-change', status: 'executing', nextAction: 'This must fail'
    } });
    assert.equal(denied.updated, false);
    assert.equal(denied.reason, 'claim_not_held');

    const checkpoint = await chatB._executeToolCall({ id: 'checkpoint-call-1', name: 'task_registry_checkpoint', args: {
      taskKey: 'coordinated-change', status: 'executing', nextAction: 'Implement the owned paths'
    } });
    assert.equal(checkpoint.updated, true);
    assert.equal(checkpoint.task.ownerChatId, 'session-chat-b');
    assert.equal(chatA.tools.taskRegistryRead('coordinated-change').checkpoint.nextAction, 'Implement the owned paths');

    const message = await chatB._executeToolCall({ id: 'send-call-1', name: 'task_registry_send', args: {
      taskKey: 'coordinated-change', recipientChatId: 'session-chat-a', text: 'The change is ready for verification.'
    } });
    assert.equal(message.message.senderChatId, 'session-chat-b');
    assert.equal((await chatA._executeToolCall({ id: 'messages-a', name: 'task_registry_messages', args: { taskKey: 'coordinated-change' } })).length, 1);
    assert.equal((await chatB._executeToolCall({ id: 'messages-b', name: 'task_registry_messages', args: { taskKey: 'coordinated-change' } })).length, 1);
    assert.equal((await makeEngine(store, 'session-chat-c')._executeToolCall({ id: 'messages-c', name: 'task_registry_messages', args: { taskKey: 'coordinated-change' } })).length, 0);
    const ack = await chatA._executeToolCall({ id: 'ack-call-1', name: 'task_registry_ack', args: {
      taskKey: 'coordinated-change', messageId: message.message.messageId, text: 'Received.'
    } });
    assert.equal(ack.message.type, 'ack');
    assert.equal(ack.message.senderChatId, 'session-chat-a');
    assert.equal(ack.message.recipientChatId, 'session-chat-b');
    assert.equal((await chatB._executeToolCall({ id: 'messages-b-after-ack', name: 'task_registry_messages', args: { taskKey: 'coordinated-change' } })).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(root), false);
});

test('task registry reads are allowed under read-only policy while mutations are blocked', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-task-registry-read-only-'));
  let store;
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    store = new TaskRegistryStore({ dataDir: path.join(root, 'data') });
    const creator = makeEngine(store, 'session-origin');
    await creator._executeToolCall({ id: 'create-1', name: 'task_registry_create', args: {
      taskKey: 'read-only-task', title: 'Read only task', repositoryPath: repo,
      baseSha: 'd'.repeat(40), paths: ['README.md']
    } });
    const reader = makeEngine(store, 'session-reader', 'read-only');
    assert.equal((await reader._executeToolCall({ id: 'read-1', name: 'task_registry_read', args: { taskKey: 'read-only-task' } })).taskKey, 'read-only-task');
    await assert.rejects(reader._executeToolCall({ id: 'claim-1', name: 'task_registry_claim', args: { taskKey: 'read-only-task' } }), /blocked under read-only policy/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(root), false);
});

test('Account Router publishes task registry schemas as read-only or mutating tools by policy', async () => {
  const { toolDefinitions } = await import('../src/features/provider/v1.mjs');
  const normal = toolDefinitions('on-request').map(tool => tool.function.name);
  for (const name of ['task_registry_list', 'task_registry_read', 'task_registry_create', 'task_registry_claim', 'task_registry_checkpoint', 'task_registry_messages', 'task_registry_send', 'task_registry_ack']) {
    assert.ok(normal.includes(name));
  }
  const readOnly = toolDefinitions('read-only').map(tool => tool.function.name);
  assert.ok(readOnly.includes('task_registry_list'));
  assert.ok(readOnly.includes('task_registry_read'));
  assert.ok(readOnly.includes('task_registry_messages'));
  assert.ok(!readOnly.includes('task_registry_create'));
  assert.ok(!readOnly.includes('task_registry_claim'));
  assert.ok(!readOnly.includes('task_registry_checkpoint'));
  assert.ok(!readOnly.includes('task_registry_send'));
  assert.ok(!readOnly.includes('task_registry_ack'));
  const claim = toolDefinitions().find(tool => tool.function.name === 'task_registry_claim');
  assert.ok(!Object.hasOwn(claim.function.parameters.properties, 'ownerChatId'));
  assert.ok(!claim.function.parameters.required.includes('idempotencyKey'));
});
