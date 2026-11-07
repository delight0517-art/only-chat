'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const css = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.css'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
const navItem = css.match(/\.nav-item\s*\{([^}]*)\}/)?.[1] || '';
const assistantBubble = css.match(/\.message-row\.assistant \.bubble\s*\{([^}]*)\}/)?.[1] || '';

assert.match(navItem, /color:\s*var\(--text-main\)/, 'session and project titles use the active theme foreground');
assert.doesNotMatch(navItem, /color:\s*#[0-9a-f]{6}/i, 'session and project titles must not force a light-only color');
assert.match(assistantBubble, /color:\s*var\(--text-main\)/, 'assistant replies use the active theme foreground for readable light and dark mode');
assert.doesNotMatch(assistantBubble, /color:\s*#[0-9a-f]{6}/i, 'assistant replies must not force a light-only foreground');
for (const id of ['btnTogglePriority', 'btnToggleMorph', 'btnToggleBrowser']) {
  assert.match(app, new RegExp(`${id}\\?\\.addEventListener`), `${id} may be absent from the active Mac UI`);
}
const sessionsLoadStartup = app.indexOf('const sessionsLoad = loadSessions();');
const newSessionStartup = app.indexOf('startNewSession();', sessionsLoadStartup);
assert.ok(sessionsLoadStartup >= 0 && newSessionStartup > sessionsLoadStartup, 'session loading starts before the new-session view is initialized');
const startNewSessionStart = app.indexOf('function startNewSession() {');
const startNewSessionEnd = app.indexOf('\nlet currentFilter', startNewSessionStart);
assert.ok(startNewSessionStart >= 0 && startNewSessionEnd > startNewSessionStart, 'startNewSession remains extractable');
assert.match(app.slice(startNewSessionStart, startNewSessionEnd), /void refreshPriorityStatus\(\)/, 'starting a new chat refreshes the active workspace after a prior session resume');
for (const id of ['railHomeBtn', 'railProjectsBtn', 'railHistoryBtn']) {
  assert.match(app, new RegExp(`${id}\\?\\.addEventListener`), `${id} navigates to its sidebar section`);
}
assert.match(app, /target\?\.scrollIntoView\(/, 'sidebar navigation scrolls to the requested section');
assert.match(app, /ensureSidebarVisible\(\)/, 'sidebar navigation restores sidebar visibility if hidden');
assert.match(app, /e\.key\.toLowerCase\(\) === 'b'/, 'Cmd+B or Ctrl+B toggles sidebar');

console.log('session sidebar theme and startup wiring passed');

test('stale session-list responses cannot overwrite the latest refresh', async () => {
  const start = app.indexOf('async function loadSessions() {');
  const end = app.indexOf('\nfunction isValidSessionListData(', start);
  assert.ok(start >= 0 && end > start, 'session list loader remains independently checkable');
  const validator = app.match(/function isValidSessionListData\(data\) \{[\s\S]*?\n\}/);
  assert.ok(validator, 'nested session list schema validator remains independently checkable');
  const isValidSessionListData = new Function(`${validator[0]}; return isValidSessionListData;`)();
  const validList = { internal: [{ id: 'ses_0123456789abcdef', title: 'Internal', source: 'internal' }], unified: { sections: [{ id: 'recents', items: [{ id: 'codex_thread', title: 'External', source: 'codex' }] }], projects: [{ name: 'Project', items: [] }], pinned: [] } };
  assert.equal(isValidSessionListData(validList), true);
  assert.equal(isValidSessionListData({ ...validList, unified: { ...validList.unified, sections: [{ id: 'recents', items: [null] }] } }), false, 'invalid nested section rows reject the response');
  assert.equal(isValidSessionListData({ ...validList, unified: { ...validList.unified, projects: [{ name: 'Project', items: {} }] } }), false, 'invalid nested project items reject the response');
  assert.equal(isValidSessionListData({ ...validList, internal: [{ id: 'ses_0123456789abcdef', title: 'Unknown', source: 'external' }] }), false, 'unknown source types reject the response');
  const pending = [];
  const rendered = [];
  const timeoutDurations = [];
  const listStatus = { textContent: '' };
  const sidebarList = {
    textContent: '',
    children: [],
    replaceChildren(...children) {
      this.children = children;
      this.textContent = children.map(child => child.children.map(node => node.textContent || '').join('')).join('');
    },
  };
  const createElement = tagName => ({
    tagName,
    children: [],
    listeners: {},
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this[name] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
  });
  const context = vm.createContext({
    sessionsLoadRequestId: 0,
    cachedUnifiedData: null,
    document: { getElementById: id => id === 'sessionListStatus' ? listStatus : id === 'sessionList' ? sidebarList : null, createElement },
    AbortSignal: { timeout: milliseconds => { timeoutDurations.push(milliseconds); return { milliseconds }; } },
    fetch: (url, options) => new Promise(resolve => pending.push({ resolve, url, options })),
    renderFilteredSessions() { rendered.push(context.cachedUnifiedData.title); sidebarList.textContent = context.cachedUnifiedData.title; },
    console: { warn() {} }
  });
  vm.runInContext(`${validator[0]}\n${app.slice(start, end)}\nglobalThis.load = loadSessions;`, context);
  const listResponse = title => ({
    internal: [], title,
    unified: { sections: [{ id: 'recents', items: [] }], projects: [] }
  });
  const initialFailure = context.load();
  assert.equal(pending[0].url, '/api/sessions');
  assert.equal(pending[0].options.signal.milliseconds, 10000, 'session-list requests use a bounded timeout');
  assert.deepEqual(timeoutDurations, [10000]);
  pending[0].resolve({ ok: false, status: 503, json: async () => ({ error: 'unavailable' }) });
  await initialFailure;
  assert.match(sidebarList.textContent, /세션 목록을 불러오지 못했습니다/, 'initial load failure is visible when no cached list exists');
  const retryButton = sidebarList.children[0].children[1];
  assert.equal(retryButton.textContent, '다시 시도', 'initial load failure includes a visible retry action');
  assert.equal(retryButton['aria-label'], '세션 목록 다시 시도');

  const retry = retryButton.listeners.click();
  pending[1].resolve({ ok: true, json: async () => listResponse('retry') });
  await retry;
  assert.equal(context.cachedUnifiedData.title, 'retry', 'retry loads the session list again');
  assert.equal(listStatus.textContent, '', 'successful retry clears the accessible error announcement');

  const older = context.load();
  const newer = context.load();
  pending[3].resolve({ ok: true, json: async () => listResponse('newest') });
  await newer;
  pending[2].resolve({ ok: true, json: async () => listResponse('older') });
  await older;
  assert.equal(context.cachedUnifiedData.title, 'newest');
  assert.deepEqual(rendered, ['retry', 'newest']);

  const failed = context.load();
  pending[4].resolve({ ok: false, status: 503, json: async () => ({ error: 'unavailable' }) });
  await failed;
  assert.equal(context.cachedUnifiedData.title, 'newest', 'HTTP failures retain the last valid sidebar data');
  assert.deepEqual(rendered, ['retry', 'newest'], 'HTTP failures do not render an error payload as an empty session list');
  assert.equal(sidebarList.textContent, 'newest', 'HTTP failures retain the rendered previous session list');
  assert.match(listStatus.textContent, /세션 목록을 불러오지 못했습니다/, 'the latest HTTP failure is announced accessibly');
  const recovered = context.load();
  pending[5].resolve({ ok: true, json: async () => listResponse('recovered') });
  await recovered;
  assert.equal(context.cachedUnifiedData.title, 'recovered');
  assert.equal(listStatus.textContent, '', 'a successful refresh clears the previous error announcement');

  const malformed = context.load();
  pending[6].resolve({ ok: true, json: async () => ({ internal: {}, unified: { sections: [], projects: [] } }) });
  await malformed;
  assert.equal(context.cachedUnifiedData.title, 'recovered', 'malformed HTTP 200 payloads retain the last valid data');
  assert.deepEqual(rendered, ['retry', 'newest', 'recovered'], 'malformed data does not reach the renderer');
  assert.match(listStatus.textContent, /세션 목록을 불러오지 못했습니다/, 'malformed payloads are announced accessibly');

  const malformedNested = context.load();
  pending[7].resolve({ ok: true, json: async () => ({ ...listResponse('nested-corrupt'), unified: { sections: [{ id: 'recents', items: [null] }], projects: [] } }) });
  await malformedNested;
  assert.equal(context.cachedUnifiedData.title, 'recovered', 'malformed nested rows also retain the last valid data');
  assert.deepEqual(rendered, ['retry', 'newest', 'recovered'], 'nested malformed data never reaches the renderer');
});
