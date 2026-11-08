'use strict';

const assert = require('node:assert');
const http = require('node:http');
const { DesktopServer } = require('../src/ui/desktop/server.js');

async function request(port, headers = {}, pathname = '/api/status') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, cors: res.headers['access-control-allow-origin'], body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function postJson(port, pathname, value) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(value);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let response = '';
      res.setEncoding('utf8'); res.on('data', chunk => { response += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(response) }));
    });
    req.on('error', reject); req.end(body);
  });
}

async function main() {
  const app = Object.create(DesktopServer.prototype);
  app.port = 0;
  app.engine = {
    priorityChain: { getStatus: () => ({ ok: true, tiers: [], activeTier: null }) },
    tools: {
      google: { isConnected: () => false },
      notion: { isConnected: () => false },
      notionMcp: { status: async () => ({ connected: false, workspaceName: null, auth: 'Notion MCP OAuth + PKCE' }) }
    }
  };
  const server = http.createServer((req, res) => app._handleRequest(req, res));
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    app.port = server.address().port;
    const localOrigin = `http://127.0.0.1:${app.port}`;
    const blocked = await request(app.port, { Origin: 'https://attacker.example', 'Sec-Fetch-Site': 'cross-site' });
    assert.strictEqual(blocked.status, 403);
    const allowed = await request(app.port, { Origin: localOrigin, 'Sec-Fetch-Site': 'same-origin' });
    assert.strictEqual(allowed.status, 200);
    assert.strictEqual(allowed.cors, undefined);
    const connectors = await request(app.port, { Origin: localOrigin, 'Sec-Fetch-Site': 'same-origin' }, '/api/connectors/status');
    assert.strictEqual(connectors.status, 200);
    assert.deepStrictEqual(JSON.parse(connectors.body).google.scopes, [
      'Google Drive (Full Edit)',
      'Gmail (Read, Compose, Modify & Send)',
      'User Profile'
    ]);
    const retiredSync = await request(app.port, { Origin: localOrigin, 'Sec-Fetch-Site': 'same-origin' }, '/api/sync/push');
    assert.strictEqual(retiredSync.status, 409);

    const feedbackApp = Object.create(DesktopServer.prototype);
    let mailto = '';
    feedbackApp.port = 0;
    feedbackApp.openExternal = async value => { mailto = value; };
    const feedbackServer = http.createServer((req, res) => feedbackApp._handleRequest(req, res));
    try {
      await new Promise(resolve => feedbackServer.listen(0, '127.0.0.1', resolve));
      feedbackApp.port = feedbackServer.address().port;
      const feedback = await postJson(feedbackApp.port, '/api/feedback/developer-email', {
        source: '채팅\n오류 user@example.com',
        error: 'Bearer abcdefghijklmnop user@example.com /Users/alice/private/file.txt sk-abcdefghijklmnop'
      });
      assert.strictEqual(feedback.status, 200);
      assert.strictEqual(feedback.body.ok, true);
      assert.match(mailto, /^mailto:/);
      const emailBody = decodeURIComponent(new URL(mailto).searchParams.get('body'));
      assert.match(emailBody, /\[이메일 숨김\]/);
      assert.match(emailBody, /\[인증 정보 숨김\]/);
      assert.match(emailBody, /\[토큰 숨김\]/);
      assert.doesNotMatch(emailBody, /user@example\.com|\/Users\/alice|sk-abcdefghijklmnop/);
      assert.match(emailBody, /대화 내용, 첨부 파일, 음성 녹음이 포함되지 않습니다/);

      const invalidFeedback = await postJson(feedbackApp.port, '/api/feedback/developer-email', { source: 'chat', error: null });
      assert.strictEqual(invalidFeedback.status, 400);
    } finally {
      await new Promise(resolve => feedbackServer.close(resolve));
    }

    // The HTTP route queues work on the engine-owned dispatcher; worker execution is tested separately.
    const dispatcherApp = Object.create(DesktopServer.prototype);
    let queued = null;
    dispatcherApp.port = 0;
    dispatcherApp.isolated = false;
    dispatcherApp.syncEnabled = false;
    dispatcherApp.nativeSessions = {
      loadCodexQueuedItems: () => ({ available: true, error: null, count: 1, items: [{ id: 'queued-1', threadId: 'thread-1', title: 'Read-only queue fixture', prompt: 'Inspect fixture', hasImageAttachment: true, hasUnsupportedContent: true, promptTruncated: true }] }),
      loadCodexThreadMetadata: () => [{ rawId: 'thread-1', title: 'Original Codex conversation', isArchived: true }]
    };
    dispatcherApp._readBody = async () => ({ id: 'forai-probe', prompt: 'probe-only', allowedTools: ['read_file'] });
    dispatcherApp.engine = { dispatcher: {
      enqueueTasks: tasks => { queued = tasks; return [{ id: 'forai-probe', status: 'queued' }]; },
      getSnapshot: () => ({ queue: queued })
    } };
    const probeServer = http.createServer((req, res) => dispatcherApp._handleRequest(req, res));
    try {
      await new Promise(resolve => probeServer.listen(0, '127.0.0.1', resolve));
      const probePort = probeServer.address().port;
      dispatcherApp.port = probePort;
      const accepted = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: probePort, path: '/api/dispatcher/enqueue', method: 'POST', headers: { Host: `127.0.0.1:${probePort}`, Origin: `http://127.0.0.1:${probePort}`, 'Sec-Fetch-Site': 'same-origin' } }, res => {
          let body = ''; res.setEncoding('utf8'); res.on('data', chunk => body += chunk);
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        });
        req.on('error', reject); req.end('{}');
      });
      assert.strictEqual(accepted.status, 200);
      assert.strictEqual(accepted.body.ok, true);
      assert.strictEqual(accepted.body.enqueued[0].status, 'queued');
      assert.strictEqual(queued[0].prompt, 'probe-only');
      assert.strictEqual(typeof dispatcherApp.engine.executeTurn, 'undefined', 'dispatcher route has no actual AgentEngine execution hook');

      const inbox = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: probePort, path: '/api/codex-queue', headers: { Host: `127.0.0.1:${probePort}`, Origin: `http://127.0.0.1:${probePort}`, 'Sec-Fetch-Site': 'same-origin' } }, res => {
          let body = ''; res.setEncoding('utf8'); res.on('data', chunk => body += chunk);
          res.on('end', () => resolve({ status: res.statusCode, cache: res.headers['cache-control'], body: JSON.parse(body) }));
        });
        req.on('error', reject); req.end();
      });
      assert.strictEqual(inbox.status, 200);
      assert.strictEqual(inbox.cache, 'no-store');
      assert.strictEqual(inbox.body.readOnly, true);
      assert.strictEqual(inbox.body.count, 1);
      assert.strictEqual(inbox.body.items[0].id, 'queued-1');
      assert.strictEqual(inbox.body.items[0].threadTitle, 'Original Codex conversation');
      assert.strictEqual(inbox.body.items[0].threadArchived, true);
      assert.strictEqual(inbox.body.items[0].threadVerified, true);
      assert.strictEqual(inbox.body.items[0].hasImageAttachment, true, 'image attachment availability must survive HTTP inbox mapping');
      assert.strictEqual(inbox.body.items[0].hasUnsupportedContent, true, 'unsupported content metadata must survive HTTP inbox mapping');
      assert.strictEqual(inbox.body.items[0].promptTruncated, true, 'prompt truncation metadata must survive HTTP inbox mapping');

      dispatcherApp.nativeSessions.loadCodexThreadMetadata = () => [];
      const unverifiedInbox = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: probePort, path: '/api/codex-queue', headers: { Host: `127.0.0.1:${probePort}`, Origin: `http://127.0.0.1:${probePort}`, 'Sec-Fetch-Site': 'same-origin' } }, res => {
          let body = ''; res.setEncoding('utf8'); res.on('data', chunk => body += chunk);
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        });
        req.on('error', reject); req.end();
      });
      assert.strictEqual(unverifiedInbox.status, 200);
      assert.strictEqual(unverifiedInbox.body.items[0].threadVerified, false, 'missing source metadata must be reported as unverified');
    } finally {
      await new Promise(resolve => probeServer.close(resolve));
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log('desktop server origin guard passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
