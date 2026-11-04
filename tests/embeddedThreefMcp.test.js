'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { DesktopServer } = require('../src/ui/desktop/server.js');

async function post(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', ...headers }
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function main() {
  const app = Object.create(DesktopServer.prototype);
  const calls = [];
  const approvals = [];
  app.port = 0;
  app.isolated = false;
  app.syncEnabled = true;
  app.engine = { currentSession: { sessionId: 'ses-current' }, tools: { approvalPolicy: 'on-request' } };
  app.embeddedBrowserPanel = {
    getStatus: async () => ({ controlAvailable: true, activeUrl: 'https://example.org/' }),
    navigate: async url => { calls.push(['navigate', url]); return { ok: true, url }; },
    readText: async () => ({ ok: true, stdout: 'Visible text' }),
    getAriaTree: async () => ({ ok: true, ariaTree: 'button Search' }),
    act: async action => { calls.push(['act', action]); return { ok: true, stdout: 'Action complete' }; },
    history: async action => { calls.push(['history', action]); return { ok: true, url: 'https://example.org/' }; }
  };
  const token = 'turn-scoped-secret';
  app.embeddedThreefMcpSessions = new Map([[token, {
    sessionId: 'ses-current', expiresAt: Date.now() + 60_000,
    requestToolApproval: async request => { approvals.push(request); return true; }
  }]]);
  const server = http.createServer((req, res) => app._handleRequest(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  app.port = server.address().port;
  const base = '/api/mcp/embedded-3f';
  const auth = { Authorization: `Bearer ${token}` };
  try {
    const denied = await post(app.port, base, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    assert.equal(denied.status, 401, 'MCP relay rejects requests without the turn-scoped capability');

    const initialized = await post(app.port, base, {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' }
    }, auth);
    assert.equal(initialized.status, 200);
    assert.equal(initialized.body.result.protocolVersion, '2025-03-26');
    const mcpSession = initialized.headers['mcp-session-id'];
    assert.ok(mcpSession);
    const sessionHeaders = { ...auth, 'Mcp-Session-Id': mcpSession };

    const tools = await post(app.port, base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionHeaders);
    assert.deepEqual(tools.body.result.tools.map(tool => tool.name), [
      'embedded_3f_status', 'embedded_3f_navigate', 'embedded_3f_read', 'embedded_3f_aria', 'embedded_3f_act', 'embedded_3f_history'
    ]);
    const status = await post(app.port, base, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'embedded_3f_status', arguments: {} } }, sessionHeaders);
    assert.equal(status.body.result.structuredContent.activeUrl, 'https://example.org/');
    assert.equal(approvals.length, 0, 'read-only browser status does not trigger an approval');

    const navigate = await post(app.port, base, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'embedded_3f_navigate', arguments: { url: 'https://example.org/' } } }, sessionHeaders);
    assert.equal(navigate.body.result.isError, undefined);
    assert.deepEqual(calls, [['navigate', 'https://example.org/']]);
    assert.equal(approvals[0].name, 'embedded_3f_navigate');

    const wrongSession = await post(app.port, base, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'embedded_3f_act', arguments: { action: 'click ref1' } } }, { ...auth, 'Mcp-Session-Id': 'wrong' });
    assert.equal(wrongSession.status, 404, 'MCP session mismatch is rejected before tool execution');
    assert.equal(calls.length, 1);

    app.engine.currentSession.sessionId = 'ses-next';
    const stale = await post(app.port, base, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'embedded_3f_status', arguments: {} } }, sessionHeaders);
    assert.equal(stale.status, 401, 'a new Only Chat turn invalidates the previous MCP capability');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log('Only Chat embedded 3F MCP session isolation and approval routing passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
