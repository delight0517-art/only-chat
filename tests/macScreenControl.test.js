'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { MacScreenControlSettings } = require('../src/browser/MacScreenControlSettings.js');
const { DesktopServer } = require('../src/ui/desktop/server.js');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function testMcpSurface(dataDir) {
  const child = spawn(process.execPath, [path.join(__dirname, '../src/connectors/MacScreenControlMcpServer.js')], {
    env: { ...process.env, ONLY_CHAT_MAC_SCREEN_TOKEN: '' }, stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Mac screen MCP did not exit.')); }, 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  try {
    child.stdin.end([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'screen_status', arguments: {} } }
    ].map(JSON.stringify).join('\n') + '\n');
    assert.equal(await closed, 0, stderr);
    const replies = stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(replies.find(item => item.id === 1).result.serverInfo.name, 'onlychat-mac-screen');
    const tools = replies.find(item => item.id === 2).result.tools;
    assert.deepEqual(tools.map(tool => tool.name), ['screen_status', 'screen_capture', 'screen_click', 'screen_type', 'screen_key', 'screen_scroll']);
    assert.equal(tools.find(tool => tool.name === 'screen_capture').annotations.readOnlyHint, true);
    assert.equal(tools.find(tool => tool.name === 'screen_click').annotations.destructiveHint, true);
    assert.equal(replies.find(item => item.id === 3).result.isError, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('close', resolve)); }
    void dataDir;
  }
}

async function testHttpBridge(dataDir) {
  if (process.platform !== 'darwin') return;
  const port = await freePort();
  const settings = new MacScreenControlSettings(path.join(dataDir, 'mac-screen-control.json'));
  assert.deepEqual(settings.get(), { enabled: false });
  const handler = Object.create(DesktopServer.prototype);
  Object.assign(handler, {
    port, isolated: false, macScreenControlSettings: settings,
    macScreenToken: 'test-only-local-token', macScreenCommands: [], macScreenCommandWaiters: [], macScreenCommandSequence: 0,
    macScreenLastCaptureAt: 0, macScreenNativeBridgeAvailable: true
  });
  const server = http.createServer((req, res) => { void handler._handleRequest(req, res); });
  await new Promise((resolve, reject) => server.listen(port, '127.0.0.1', resolve).once('error', reject));
  const base = `http://127.0.0.1:${port}`;
  try {
    const initial = await fetch(`${base}/api/mac-screen/settings`);
    assert.deepEqual(await initial.json(), { enabled: false, nativeAvailable: true });
    const unauthorized = await fetch(`${base}/api/mac-screen/dispatch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' }, body: JSON.stringify({ action: 'status', input: {} })
    });
    assert.equal(unauthorized.status, 401);
    const enabled = await fetch(`${base}/api/mac-screen/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true })
    });
    assert.deepEqual(await enabled.json(), { ok: true, enabled: true });
    const blindClick = await fetch(`${base}/api/mac-screen/dispatch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-only-local-token' },
      body: JSON.stringify({ action: 'click', input: { x: 20, y: 30, button: 'left' } })
    });
    assert.equal(blindClick.status, 409);
    assert.match((await blindClick.json()).error, /screen_capture/);
    const dispatchAction = async (action, input, nativeResult) => {
      const pending = fetch(`${base}/api/mac-screen/dispatch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-only-local-token' },
        body: JSON.stringify({ action, input })
      });
      let command;
      for (let attempt = 0; attempt < 30 && !command; attempt += 1) {
        const poll = await fetch(`${base}/api/mac-screen/panel/next`);
        if (poll.status === 200) command = await poll.json();
        else await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(command.action, action);
      const complete = await fetch(`${base}/api/mac-screen/panel/complete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: command.id, result: nativeResult })
      });
      assert.equal(complete.status, 200);
      const response = await pending;
      return { response, result: await response.json() };
    };
    const capture = await dispatchAction('capture', {}, { image: 'synthetic-jpeg', mimeType: 'image/jpeg', width: 1280, height: 800 });
    assert.equal(capture.response.status, 200);
    assert.equal(capture.result.image, 'synthetic-jpeg');
    const click = await dispatchAction('click', { x: 20, y: 30, button: 'left' }, { ok: true, text: 'synthetic click' });
    assert.equal(click.response.status, 200);
    assert.deepEqual(click.result, { ok: true, text: 'synthetic click' });
    const secondBlindClick = await fetch(`${base}/api/mac-screen/dispatch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-only-local-token' },
      body: JSON.stringify({ action: 'click', input: { x: 40, y: 50, button: 'left' } })
    });
    assert.equal(secondBlindClick.status, 409);
    const disabled = await fetch(`${base}/api/mac-screen/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false })
    });
    assert.deepEqual(await disabled.json(), { ok: true, enabled: false });
    const blocked = await fetch(`${base}/api/mac-screen/dispatch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-only-local-token' }, body: JSON.stringify({ action: 'status', input: {} })
    });
    assert.equal(blocked.status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-mac-screen-'));
  try {
    await testMcpSurface(dataDir);
    await testHttpBridge(dataDir);
    console.log('Mac screen control: default-off setting, MCP tool surface, authenticated queue bridge, and synthetic completion passed');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
