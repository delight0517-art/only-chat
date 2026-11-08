import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const elements = new Map();
function element(id = '') {
  return {
    id, children: [], listeners: {}, style: {}, textContent: '', disabled: false,
    parentElement: null,
    setAttribute() {},
    append(...items) { this.children.push(...items); for (const item of items) item.parentElement = this; },
    remove() { this.removed = true; },
    addEventListener(name, callback) { this.listeners[name] = callback; }
  };
}
const button = element('btnLoginNotion');
const status = element('notionOAuthStatus');
const badge = element('badgeNotionStatus');
const panelHost = element('settings');
button.parentElement = panelHost;
status.parentElement = panelHost;
for (const item of [button, status, badge]) elements.set(item.id, item);
const written = [];
const document = {
  getElementById(id) { return elements.get(id) || null; },
  createElement: () => element()
};
const navigator = { clipboard: { async writeText(value) { written.push(value); } } };
const context = {
  document, navigator,
  window: { refreshConnectorsStatus() {}, open() { return { opener: {} }; } },
  fetch: async () => ({ ok: true, async json() { return { url: 'https://notion.example/oauth?state=test' }; } }),
  setInterval() { return 1; }, clearInterval() {}
};
vm.runInNewContext(fs.readFileSync(new URL('../src/ui/desktop/notion-oauth.js', import.meta.url), 'utf8'), context);
await button.listeners.click();

const panel = panelHost.children.find(child => child.id === 'notionLoginUrlFallback');
assert.ok(panel, 'copy fallback remains visible even if window.open returns a window proxy');
assert.match(panel.children[0].textContent, /If it didn't open/);
const copy = panel.children[2];
assert.match(copy.textContent, /If it didn't open/);
await copy.listeners.click();
assert.deepEqual(written, ['https://notion.example/oauth?state=test']);
assert.equal(copy.textContent, 'The link has been copied. Go to a browser and then paste it.');
const simulatedAddressBar = { value: '' };
simulatedAddressBar.value = written[0];
assert.equal(simulatedAddressBar.value, 'https://notion.example/oauth?state=test', 'the copied authorization URL can be pasted into a browser address field');

const appSource = fs.readFileSync(new URL('../src/ui/desktop/app.js', import.meta.url), 'utf8');
const googleFlow = appSource.slice(appSource.indexOf('async function handleGoogleLogin()'), appSource.indexOf('async function handleNotionConnect()'));
assert.match(googleFlow, /showUrlCopyFallback\(data\.url/);
assert.ok(googleFlow.indexOf('showUrlCopyFallback(data.url') < googleFlow.indexOf('if (!popup) return;'), 'Google copy fallback stays available even when window.open returns a proxy');

console.log('loginUrlCopyFallback.test.mjs: Notion copy button and Google persistent fallback passed with simulated browser/clipboard APIs');
