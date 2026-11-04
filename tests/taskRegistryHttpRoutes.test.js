'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { DesktopServer } = require('../src/ui/desktop/server.js');

function postJson(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function withServer(app, operation) {
  const server = http.createServer((req, res) => {
    app._handleRequest(req, res).catch(error => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  app.port = server.address().port;
  try { await operation(server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function main() {
  const localHostId = '57e8cd4f-6f75-4c4d-a4e4-3a657d31a8ac';
  const remoteHostId = 'f82f72f9-1641-4a38-bc15-275b17c79a8c';
  let received;
  const app = Object.create(DesktopServer.prototype);
  Object.assign(app, {
    isolated: false,
    syncEnabled: false,
    taskRegistryStore: {
      hostId: localHostId,
      sendMessage: async input => {
        received = input;
        return { sent: true, message: { messageId: 'message-1', ...input, senderHostId: localHostId } };
      }
    }
  });

  await withServer(app, async port => {
    const result = await postJson(port, '/api/task-registry/tasks/shared-task/messages', {
      senderChatId: 'mac-chat', recipientChatId: 'windows-chat', recipientHostId: remoteHostId,
      senderHostId: 'client-spoofed-host', text: 'Task-scoped message', idempotencyKey: 'same-task-message-1'
    });
    assert.equal(result.status, 200);
    assert.equal(received.recipientHostId, remoteHostId);
    assert.equal(received.senderChatId, 'mac-chat');
    assert.equal(Object.hasOwn(received, 'senderHostId'), false, 'sender host identity must come from the local store');
    assert.equal(result.body.message.senderHostId, localHostId);
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
