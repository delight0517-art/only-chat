'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const { DesktopServer } = require('../src/ui/desktop/server.js');
const { TaskRegistryStore } = require('../src/core/TaskRegistryStore.js');

function request(port, route, method = 'GET', body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: route, method,
      headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin',
        ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('loopback API shares task records between chat owners with idempotent writes and conflict readback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-task-registry-api-'));
  const repo = path.join(root, 'repo');
  let server;
  try {
    fs.mkdirSync(repo);
    const app = Object.create(DesktopServer.prototype);
    app.port = 0;
    app.isolated = false;
    app.taskRegistryStore = new TaskRegistryStore({ dataDir: path.join(root, 'data') });
    server = http.createServer((req, res) => app._handleRequest(req, res));
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    app.port = server.address().port;

    const taskBody = { taskKey: 'cross-chat-check', title: 'Avoid repeated work', creatorChatId: 'chat-origin',
      repositoryPath: repo, baseSha: 'b'.repeat(40), paths: ['src/core'], nextAction: 'Inspect existing checkpoint', idempotencyKey: 'create-1' };
    const created = await request(app.port, '/api/task-registry/tasks', 'POST', taskBody);
    assert.equal(created.status, 201);
    const replay = await request(app.port, '/api/task-registry/tasks', 'POST', taskBody);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.task.taskKey, 'cross-chat-check');
    const duplicate = await request(app.port, '/api/task-registry/tasks', 'POST', { ...taskBody, idempotencyKey: 'create-2' });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.created, false);

    const chatA = await request(app.port, '/api/task-registry/tasks/cross-chat-check/claim', 'POST', { ownerChatId: 'chat-a', idempotencyKey: 'claim-a' });
    assert.equal(chatA.status, 200);
    assert.equal(chatA.body.accepted, true);
    const chatB = await request(app.port, '/api/task-registry/tasks/cross-chat-check/claim', 'POST', { ownerChatId: 'chat-b', idempotencyKey: 'claim-b' });
    assert.equal(chatB.status, 409);
    assert.equal(chatB.body.reason, 'owned_by_other_chat');

    const checkpoint = await request(app.port, '/api/task-registry/tasks/cross-chat-check/checkpoint', 'POST', {
      ownerChatId: 'chat-a', idempotencyKey: 'checkpoint-1', status: 'executing', nextAction: 'Check the recorded source', evidenceRefs: ['commit:base']
    });
    assert.equal(checkpoint.status, 200);
    const readByOtherChat = await request(app.port, '/api/task-registry/tasks/cross-chat-check');
    assert.equal(readByOtherChat.status, 200);
    assert.equal(readByOtherChat.body.task.checkpoint.nextAction, 'Check the recorded source');

    let resumeRequest;
    app.engine = { resumeManagerPlan: async input => {
      resumeRequest = input;
      return { accepted: true, taskKey: input.taskKey, queuedCount: 1 };
    } };
    const resumed = await request(app.port, '/api/task-registry/tasks/cross-chat-check/resume', 'POST', {
      ownerChatId: 'chat-origin', idempotencyKey: 'resume-from-workbench'
    });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.queuedCount, 1);
    assert.deepEqual(resumeRequest, { taskKey: 'cross-chat-check', ownerChatId: 'chat-origin', idempotencyKey: 'resume-from-workbench' });

    const list = await request(app.port, '/api/task-registry/tasks?ownerChatId=chat-a');
    assert.equal(list.status, 200);
    assert.equal(list.body.tasks.length, 1);
    const mailbox = await request(app.port, '/api/task-registry/tasks/cross-chat-check/messages', 'POST', {
      senderChatId: 'chat-a', recipientChatId: 'chat-b', text: 'Please verify the checkpoint.', idempotencyKey: 'message-1'
    });
    assert.equal(mailbox.status, 200);
    const inbox = await request(app.port, '/api/task-registry/tasks/cross-chat-check/messages?viewerChatId=chat-b');
    assert.equal(inbox.status, 200);
    assert.equal(inbox.body.messages.length, 1);
    const ack = await request(app.port, '/api/task-registry/tasks/cross-chat-check/ack', 'POST', {
      senderChatId: 'chat-b', messageId: mailbox.body.message.messageId, text: 'Received.', idempotencyKey: 'ack-1'
    });
    assert.equal(ack.status, 200);
    const senderReadback = await request(app.port, '/api/task-registry/tasks/cross-chat-check/messages?viewerChatId=chat-a');
    assert.equal(senderReadback.body.messages.length, 2);
    const unrelatedReadback = await request(app.port, '/api/task-registry/tasks/cross-chat-check/messages?viewerChatId=chat-c');
    assert.equal(unrelatedReadback.body.messages.length, 0);
    const missing = await request(app.port, '/api/task-registry/tasks/not-found');
    assert.equal(missing.status, 404);
    const overLimit = await request(app.port, '/api/task-registry/tasks?limit=201');
    assert.equal(overLimit.status, 400);
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(root), false);
});

test('task registry rejects non-local origins and remains disabled in isolated mode', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-task-registry-api-'));
  let server;
  let isolatedServer;
  try {
    const app = Object.create(DesktopServer.prototype);
    app.port = 0;
    app.isolated = false;
    app.taskRegistryStore = new TaskRegistryStore({ dataDir: path.join(root, 'data') });
    server = http.createServer((req, res) => app._handleRequest(req, res));
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    app.port = server.address().port;
    const crossOrigin = await request(app.port, '/api/task-registry/tasks', 'GET', undefined, { Origin: 'https://attacker.example', 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(crossOrigin.status, 403);

    const isolated = Object.create(DesktopServer.prototype);
    isolated.port = 0;
    isolated.isolated = true;
    isolatedServer = http.createServer((req, res) => isolated._handleRequest(req, res));
    await new Promise((resolve, reject) => isolatedServer.listen(0, '127.0.0.1', resolve).once('error', reject));
    isolated.port = isolatedServer.address().port;
    const blocked = await request(isolated.port, '/api/task-registry/tasks');
    assert.equal(blocked.status, 403);
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (isolatedServer?.listening) await new Promise(resolve => isolatedServer.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(root), false);
});
