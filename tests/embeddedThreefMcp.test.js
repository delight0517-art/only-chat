'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-mcp-test-'));
  const todoPath = path.join(workspaceDir, 'TODO_ROADMAP.md');
  fs.writeFileSync(todoPath, 'old\nsecond line', 'utf8');
  const app = Object.create(DesktopServer.prototype);
  const calls = [];
  const approvals = [];
  let approvalDecision = true;
  app.port = 0;
  app.isolated = false;
  app.syncEnabled = true;
  app.engine = {
    currentSession: { sessionId: 'ses-current' },
    workspaceDir,
    tools: {
      approvalPolicy: 'on-request',
      browserStatus: async () => ({ controlAvailable: true, activeUrl: 'https://youtube.com/watch?v=video', title: 'Video' }),
      browserNavigate: async url => { calls.push(['threef_navigate', url]); return { ok: true, url }; },
      browserRead: async () => ({ ok: true, stdout: 'Standalone 3F page text' }),
      browserAria: async () => ({ ok: true, ariaTree: 'button Play' }),
      browserAct: async action => { calls.push(['threef_act', action]); return { ok: true, stdout: 'Standalone action complete' }; },
      browserHistory: async action => { calls.push(['threef_history', action]); return { ok: true, url: 'https://youtube.com/watch?v=video' }; }
    },
    ownership: {
      acquireLocks: (_session, files) => { calls.push(['lock', files]); return { acquired: true }; },
      releaseLocks: (_session, files) => calls.push(['unlock', files])
    },
    _executeToolCall: async call => {
      calls.push([call.name, call.args]);
      if (call.name === 'read_file') return 'line 1\nline 2';
      throw new Error('unexpected tool');
    }
  };
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
    requestToolApproval: async request => { approvals.push(request); return approvalDecision; }
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
      'read_file', 'edit_file', 'embedded_3f_status', 'embedded_3f_navigate', 'embedded_3f_read', 'embedded_3f_aria', 'embedded_3f_act', 'embedded_3f_history',
      'threef_browser_status', 'threef_browser_navigate', 'threef_browser_read', 'threef_browser_aria', 'threef_browser_act', 'threef_browser_history'
    ]);
    const status = await post(app.port, base, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'embedded_3f_status', arguments: {} } }, sessionHeaders);
    assert.equal(status.body.result.structuredContent.activeUrl, 'https://example.org/');
    assert.equal(approvals.length, 0, 'read-only browser status does not trigger an approval');

    const threefStatus = await post(app.port, base, { jsonrpc: '2.0', id: 34, method: 'tools/call', params: { name: 'threef_browser_status', arguments: {} } }, sessionHeaders);
    assert.equal(threefStatus.body.result.structuredContent.activeUrl, 'https://youtube.com/watch?v=video', 'standalone app status is separate from embedded panel status');
    const threefRead = await post(app.port, base, { jsonrpc: '2.0', id: 35, method: 'tools/call', params: { name: 'threef_browser_read', arguments: {} } }, sessionHeaders);
    assert.equal(threefRead.body.result.structuredContent.stdout, 'Standalone 3F page text');
    assert.equal(approvals.length, 0, 'standalone status and reads are read-only');

    const fileRead = await post(app.port, base, { jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'TODO_ROADMAP.md' } } }, sessionHeaders);
    assert.equal(fileRead.body.result.structuredContent, 'line 1\nline 2');
    assert.equal(calls[0][0], 'read_file');
    assert.equal(calls[0][1].end_line - calls[0][1].start_line, 39, 'workspace reads default to a compact 40-line range');

    const tooWide = await post(app.port, base, { jsonrpc: '2.0', id: 32, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'TODO_ROADMAP.md', start_line: 1, end_line: 500 } } }, sessionHeaders);
    assert.equal(tooWide.body.result.isError, true, 'oversized workspace reads fail closed');

    const edit = await post(app.port, base, { jsonrpc: '2.0', id: 33, method: 'tools/call', params: { name: 'edit_file', arguments: { path: 'TODO_ROADMAP.md', target: 'old', replacement: 'new' } } }, sessionHeaders);
    assert.equal(edit.body.result.isError, undefined);
    assert.equal(approvals.at(-1).name, 'edit_file', 'workspace edits use the Only Chat approval route');
    assert.equal(fs.readFileSync(todoPath, 'utf8'), 'new\nsecond line', 'an exact single occurrence is changed while locked');

    const outside = await post(app.port, base, { jsonrpc: '2.0', id: 35, method: 'tools/call', params: { name: 'read_file', arguments: { path: '/etc/hosts' } } }, sessionHeaders);
    assert.equal(outside.body.result.isError, true, 'absolute paths outside the Only Chat workspace are rejected');
    const repeatedPath = path.join(workspaceDir, 'repeated.md');
    fs.writeFileSync(repeatedPath, 'same same', 'utf8');
    const repeated = await post(app.port, base, { jsonrpc: '2.0', id: 36, method: 'tools/call', params: { name: 'edit_file', arguments: { path: 'repeated.md', target: 'same', replacement: 'new' } } }, sessionHeaders);
    assert.equal(repeated.body.result.isError, true, 'ambiguous edit targets are rejected');
    assert.equal(fs.readFileSync(repeatedPath, 'utf8'), 'same same', 'ambiguous edit leaves the file unchanged');

    approvalDecision = false;
    const contentBeforeDeniedEdit = fs.readFileSync(todoPath, 'utf8');
    const deniedEdit = await post(app.port, base, { jsonrpc: '2.0', id: 34, method: 'tools/call', params: { name: 'edit_file', arguments: { path: 'TODO_ROADMAP.md', target: 'old', replacement: 'new' } } }, sessionHeaders);
    assert.equal(deniedEdit.body.result.isError, true);
    assert.equal(fs.readFileSync(todoPath, 'utf8'), contentBeforeDeniedEdit, 'denied workspace edits never change the file');
    approvalDecision = true;

    const navigate = await post(app.port, base, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'embedded_3f_navigate', arguments: { url: 'https://example.org/' } } }, sessionHeaders);
    assert.equal(navigate.body.result.isError, undefined);
    assert.deepEqual(calls.filter(([name]) => name === 'navigate'), [['navigate', 'https://example.org/']]);
    assert.equal(approvals.at(-1).name, 'embedded_3f_navigate');

    const threefNavigate = await post(app.port, base, { jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'threef_browser_navigate', arguments: { url: 'https://youtube.com/watch?v=video' } } }, sessionHeaders);
    assert.equal(threefNavigate.body.result.structuredContent.url, 'https://youtube.com/watch?v=video');
    assert.equal(approvals.at(-1).name, 'threef_browser_navigate', 'standalone navigation uses Only Chat approval');
    assert.deepEqual(calls.filter(([name]) => name === 'threef_navigate'), [['threef_navigate', 'https://youtube.com/watch?v=video']]);
    const threefAct = await post(app.port, base, { jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'threef_browser_act', arguments: { action: 'click ref1' } } }, sessionHeaders);
    assert.equal(threefAct.body.result.structuredContent.stdout, 'Standalone action complete');
    assert.equal(approvals.at(-1).name, 'threef_browser_act', 'standalone page actions use Only Chat approval');

    const wrongSession = await post(app.port, base, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'embedded_3f_act', arguments: { action: 'click ref1' } } }, { ...auth, 'Mcp-Session-Id': 'wrong' });
    assert.equal(wrongSession.status, 404, 'MCP session mismatch is rejected before tool execution');
    assert.equal(calls.filter(([name]) => name === 'act').length, 0);

    app.engine.currentSession.sessionId = 'ses-next';
    const stale = await post(app.port, base, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'embedded_3f_status', arguments: {} } }, sessionHeaders);
    assert.equal(stale.status, 401, 'a new Only Chat turn invalidates the previous MCP capability');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
  console.log('Only Chat embedded 3F MCP session isolation and approval routing passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
