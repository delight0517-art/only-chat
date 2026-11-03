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
