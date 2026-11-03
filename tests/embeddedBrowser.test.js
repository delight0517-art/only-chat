'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { EmbeddedBrowser } = require('../src/browser/EmbeddedBrowser.js');
const { buildFocusFenceContentScript } = require('../src/browser/FocusFenceContent.js');

const pageScript = buildFocusFenceContentScript({ protectionEnabled: true, blockedDomains: ['</script>'] });
assert.equal(pageScript.toLowerCase().includes('</script>'), false);
assert.doesNotThrow(() => new Function(pageScript));

class FakeContents extends EventEmitter {
  constructor() { super(); this.id = 42; this.urls = []; }
  setWindowOpenHandler(handler) { this.openHandler = handler; }
  async loadURL(url) { this.urls.push(url); this.url = url; }
  getURL() { return this.url || ''; }
  isDestroyed() { return false; }
  async executeJavaScript(script) { this.scripts ??= []; this.scripts.push(script); return 'text'; }
  async executeJavaScriptInIsolatedWorld(worldId, scripts) { this.isolatedCalls = { worldId, scripts }; }
  focus() {}
}

class FakeWindow extends EventEmitter {
  static instances = [];
  constructor(options) { super(); this.options = options; this.webContents = new FakeContents(); this.destroyed = false; FakeWindow.instances.push(this); }
  setTitle() {}
  show() {}
  focus() {}
  isDestroyed() { return this.destroyed; }
  async loadURL(url) { return this.webContents.loadURL(url); }
}

async function main() {
  let subframeListener;
  const browser = new EmbeddedBrowser({
    BrowserWindow: FakeWindow,
    session: { webRequest: { onBeforeRequest(_filter, listener) { subframeListener = listener; } } },
    policy: { check: async url => ({ allowed: !url.includes('blocked.test'), reason: 'blocked', rule: 'blocked.test' }), getRules: async () => ({ rules: { protectionEnabled: true } }) }
  });
  const opened = await browser.launch('https://allowed.test');
  assert.equal(opened.ok, true);
  assert.equal(FakeWindow.instances[0].webContents.getURL(), 'https://allowed.test/');
  assert.equal(FakeWindow.instances[0].options.webPreferences.nodeIntegration, false);
  FakeWindow.instances[0].webContents.emit('did-finish-load');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(FakeWindow.instances[0].webContents.isolatedCalls.worldId, 991);
  assert(FakeWindow.instances[0].webContents.isolatedCalls.scripts[0].code.includes('blockedDomains'));

  let canceled;
  subframeListener({ webContentsId: 42, resourceType: 'subFrame', url: 'https://blocked.test/frame' }, value => { canceled = value.cancel; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(canceled, true);

  const blocked = await browser.navigate('https://blocked.test');
  assert.equal(blocked.blocked, true);
  assert.match(FakeWindow.instances[0].webContents.getURL(), /^data:text\/html/);
  await assert.rejects(() => browser.navigate('file:///etc/passwd'), /HTTP와 HTTPS/);
  console.log('Embedded browser policy checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
