'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ThreefBrowserControlSettings } = require('../src/browser/ThreefBrowserControlSettings.js');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'only-chat-3f-settings-'));
  try {
    const file = path.join(dir, 'settings.json');
    const settings = new ThreefBrowserControlSettings(file);
    assert.deepEqual(settings.get(), { enabled: true });
    assert.deepEqual(settings.set(true), { enabled: true });
    assert.deepEqual(settings.set(false), { enabled: false });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { enabled: false });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(new ThreefBrowserControlSettings(file).get(), { enabled: false });
    assert.deepEqual(new ThreefBrowserControlSettings(path.join(dir, 'missing.json')).get(), { enabled: true });
    const malformed = path.join(dir, 'malformed.json');
    fs.writeFileSync(malformed, '{broken');
    assert.deepEqual(new ThreefBrowserControlSettings(malformed).get(), { enabled: false });

    const desktopServerSource = fs.readFileSync(require.resolve('../src/ui/desktop/server.js'), 'utf8');
    const desktopHtml = fs.readFileSync(require.resolve('../src/ui/desktop/index.html'), 'utf8');
    const desktopApp = fs.readFileSync(require.resolve('../src/ui/desktop/app.js'), 'utf8');
    assert.match(desktopServerSource, /engineOptions\.browser\s*=\s*this\.isolated\s*\?\s*null\s*:\s*this\.threefBridge/);
    assert.match(desktopHtml, /<label for="threefControlEnabled"><input id="threefControlEnabled" type="checkbox"/);
    assert.match(desktopHtml, /id="btnThreefRefresh"/);
    assert.match(desktopApp, /function setThreefControlUi\(enabled\)/);
    assert.match(desktopApp, /btnToggleBrowser\?\.addEventListener\('click', \(\) => \{[\s\S]*?if \(opening\) void refreshThreefControlStatus\(\);/,
      'opening the 3F panel refreshes connection state instead of leaving a stale unavailable banner');
    const navBrowser = desktopApp.match(/async function navBrowser\(url\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(navBrowser, 'navigation action stays in one auditable function');
    assert.match(navBrowser, /postNativeBrowserPanelAction\('navigate'/,
      'the Only Chat address bar must navigate the embedded browser session');
    assert.match(navBrowser, /fetch\('\/api\/browser\/threef\/open'/);
    assert.match(navBrowser, /finally\s*\{\s*await refreshThreefControlStatus\(\);/,
      'a navigation failure must refresh the panel so stale connected-page status is cleared');
    assert.match(desktopApp, /function handleBrowserOpenInThreef\(\)[\s\S]*?fetch\('\/api\/browser\/threef\/open'/,
      'opening a URL in the standalone 3F app remains a separate explicit action');
    assert.match(desktopApp, /function handleBrowserAria\(\)[\s\S]*?postNativeBrowserPanelAction\('aria'\)[\s\S]*?fetch\('\/api\/browser\/aria'/);
    assert.match(desktopApp, /function handleBrowserRead\(\)[\s\S]*?postNativeBrowserPanelAction\('read'\)[\s\S]*?fetch\('\/api\/browser\/read'/);
    assert.match(desktopApp, /function sendBrowserPanelAction\(action\)[\s\S]*?postNativeBrowserPanelAction\(action\)[\s\S]*?fetch\('\/api\/browser\/history'/);
    assert.match(desktopApp, /function postNativeBrowserPanelAction\(action, payload = \{\}\)[\s\S]*?handler\.postMessage\(\{ action, \.\.\.payload \}\)/);
    const controlUi = desktopApp.match(/function setThreefControlUi\(enabled\) \{[\s\S]*?\n\}/)?.[0];
    assert.doesNotMatch(controlUi, /btnBrowserNav|data-browser-action/,
      'manual embedded browsing stays available when AI browser control is off');
    assert.match(desktopApp, /url \? `\[3F Browser 세션\] \$\{url\}` : '\[3F Browser 새 탭\]'/,
      'switching to a blank tab clears the outer address bar');
    assert.match(desktopApp, /독립 3F Browser 연결됨/);

    const { DesktopServer } = require('../src/ui/desktop/server.js');
    const server = Object.create(DesktopServer.prototype);
    server.isolated = false;
    server.threefControlSettings = settings;
    let bridgeCalls = 0;
    server.threefBridge = { getStatus: async () => { bridgeCalls++; return { statusText: 'service unavailable' }; } };
    server.engine = { tools: { browserStatus: async () => { bridgeCalls++; return { statusText: 'service unavailable' }; }, browserOpen: async () => { bridgeCalls++; return { ok: true }; }, browserAria: async () => { bridgeCalls++; return {}; }, browserRead: async () => { bridgeCalls++; return { ok: true }; }, browserHistory: async () => { bridgeCalls++; return { ok: true }; }, browserAct: async () => { bridgeCalls++; return { ok: true }; } } };
    server.openExternal = async () => {};
    server.focusFencePolicy = { check: async () => ({ allowed:true }) };
    server.browserCommands = [];
    server.browserCommandWaiters = [];
    server.browserPanelWaiter = null;
    const http = require('node:http');
    const net = require('node:net');
    const socket = net.createServer();
    await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', resolve).once('error', reject));
    const { port } = socket.address();
    await new Promise(resolve => socket.close(resolve));
    server.port = port;
    const httpServer = http.createServer((req, res) => server._handleRequest(req, res));
    await new Promise((resolve, reject) => httpServer.listen(port, '127.0.0.1', resolve).once('error', reject));
    try {
      settings.set(false);
      const disabledStatus = await fetch(`http://127.0.0.1:${port}/api/browser/status`);
      assert.equal(disabledStatus.status, 200);
      assert.equal((await disabledStatus.json()).enabled, false);
      const disabledSettings = await fetch(`http://127.0.0.1:${port}/api/browser/threef/settings`);
      assert.deepEqual(await disabledSettings.json(), { enabled: false });
      assert.equal(bridgeCalls, 0, 'disabled status/settings must not contact the browser bridge');
      for (const [route, method] of [['/api/browser/threef/open','POST'], ['/api/browser/nav','POST'], ['/api/browser/authorize','POST'], ['/api/browser/aria','POST'], ['/api/browser/read','POST'], ['/api/browser/history','POST'], ['/api/browser/act','POST'], ['/api/browser/panel/next','GET'], ['/api/browser/panel/complete','POST']]) {
        const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, ...(method === 'POST' ? { headers:{'Content-Type':'application/json'}, body:JSON.stringify({url:'https://synthetic.test', action:'read'}) } : {}) });
        assert.equal(response.status, 403, route);
        assert.match((await response.json()).error, /꺼져/);
      }
      await assert.rejects(server._dispatchEmbeddedBrowserCommand({ action:'read' }), /꺼져/);
      const enabled = await fetch(`http://127.0.0.1:${port}/api/browser/threef/settings`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ enabled:true }) });
      assert.deepEqual(await enabled.json(), { ok:true, enabled:true });
      const response = await fetch(`http://127.0.0.1:${port}/api/browser/status`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).statusText, 'service unavailable');
      assert.equal(bridgeCalls, 1);
    } finally { await new Promise(resolve => httpServer.close(resolve)); }
    console.log('3F Browser control settings default/on/off persistence and disabled/enabled HTTP routes passed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
