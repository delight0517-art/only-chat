'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { DesktopServer } = require('../src/ui/desktop/server.js');
const { EvolutionInbox } = require('../src/sync/EvolutionInbox.js');

function request(port, pathname, method = 'GET', body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method,
      headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', ...(body ? { 'Content-Type': 'application/json' } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject); req.end(body);
  });
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'OnlyChat-EvolutionInboxServer-'));
  const source = path.join(temp, 'source'); const data = path.join(temp, 'data'); const relayRoot = path.join(temp, 'relay');
  let inbox; let server;
  try {
    fs.mkdirSync(source); fs.mkdirSync(relayRoot);
    inbox = new EvolutionInbox({ canonicalRoot: source, dataDir: data, platform: 'darwin' });
    const app = Object.create(DesktopServer.prototype);
    app.port = 0; app.isolated = false; app.evolutionInbox = inbox; app.evolutionInboxClients = new Set();
    server = http.createServer((req, res) => app._handleRequest(req, res));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); app.port = server.address().port;
    const connected = await request(app.port, '/api/evolution/configure', 'POST', JSON.stringify({ relayRoot }));
    assert.equal(connected.status, 200); assert.equal(connected.body.status.enabled, true);
    const listed = await request(app.port, '/api/evolution/inbox');
    assert.equal(listed.status, 200); assert.equal(listed.body.configured, true); assert.deepEqual(listed.body.pending, []);
    const disconnected = await request(app.port, '/api/evolution/disable', 'POST', '{}');
    assert.equal(disconnected.status, 200); assert.equal(disconnected.body.status.enabled, false);

    const isolated = Object.create(DesktopServer.prototype); isolated.port = app.port; isolated.isolated = true;
    const blocked = await (async () => {
      const isolatedServer = http.createServer((req, res) => isolated._handleRequest(req, res));
      await new Promise(resolve => isolatedServer.listen(0, '127.0.0.1', resolve));
      try { isolated.port = isolatedServer.address().port; return await request(isolated.port, '/api/evolution/inbox'); }
      finally { await new Promise(resolve => isolatedServer.close(resolve)); }
    })();
    assert.equal(blocked.status, 403);
    console.log('evolutionInboxServer.test.js: passed (configure, read pending, disable, isolated-mode deny)');
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    inbox?.stop();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
