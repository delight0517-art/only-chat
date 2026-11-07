'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
const start = source.indexOf('async function refreshAdminManagerStatus()');
const end = source.indexOf('\nasync function handleSend()', start);
assert(start >= 0 && end > start, 'admin manager status handler should exist');
const handler = source.slice(start, end);

assert.match(handler, /\['agent-engine', 'tool-registry'\]/, 'stale core runtime modules must be checked');
assert.match(handler, /module\.state !== 'loaded'/, 'stale or unavailable modules must not count as current');
assert.match(handler, /managerModeToggle\.disabled = true/, 'manager mode must remain disabled for a stale core runtime');
assert.match(handler, /관리자 AI · 서버 업데이트 필요/, 'the user must see that the running server needs an update');
assert.match(handler, /labelContainer\.title = reason/, 'the accessibility label must explain a stale core runtime');
assert.match(handler, /labelContainer\.title = managerModeToggle\.title/, 'the accessibility label must reflect the current manager capability state');
assert.match(handler, /\['executable', 'settings-only'\]/, 'only actionable capabilities count as available');
assert.match(handler, /availableCount\}\//, 'the UI must distinguish available capabilities from total entries');
assert.match(handler, /status\.dispatcher\?\.blockedReason === 'no_verified_dispatch_provider'/, 'the UI must explain when no verified dispatcher is configured');
assert.match(handler, /관리자 AI · 실행자 모델 확인 필요/, 'the visible label must distinguish planning from unavailable delegation');
assert.match(handler, /adminManagerStatusInFlight/, 'overlapping focus refreshes must not race');
assert.match(handler, /adminManagerStatusLastRequestAt/, 'focus and visibility events must be throttled');
assert.match(source, /window\.addEventListener\('focus', \(\) => \{[\s\S]*?void refreshAdminManagerStatus\(\);[\s\S]*?\}\)/, 'returning focus must refresh live manager readiness');
assert.match(source, /document\.addEventListener\('visibilitychange', \(\) => \{\s*if \(!document\.hidden\) void refreshAdminManagerStatus\(\);\s*\}\)/, 'becoming visible must refresh manager readiness');

async function verifyReadinessLabelPreservesDraft() {
  const label = { textContent: '', parentElement: { title: '' } };
  const toggle = { disabled: false, checked: true, title: '' };
  const draft = { value: 'saved draft stays here' };
  const status = {
    apiVersion: 1,
    modules: [{ id: 'admin-manager', state: 'loaded' }, { id: 'agent-engine', state: 'loaded' }, { id: 'tool-registry', state: 'loaded' }],
    capabilities: [
      { id: 'chat.respond', state: 'executable' },
      { id: 'work.delegate', state: 'unavailable' }
    ],
    dispatcher: { ready: false, blockedReason: 'no_verified_dispatch_provider' }
  };
  const context = {
    managerModeToggle: toggle,
    composerInput: draft,
    isRecording: true,
    document: { getElementById: id => id === 'managerModeLabel' ? label : null },
    fetch: async () => ({ ok: true, json: async () => status }),
    Date
  };
  const refreshStart = source.indexOf('let adminManagerStatusInFlight = false;');
  const refreshEnd = source.indexOf('\nasync function handleSend()', refreshStart);
  assert(refreshStart >= 0 && refreshEnd > refreshStart, 'refresh implementation should be isolated for behavior testing');
  vm.runInNewContext(`${source.slice(refreshStart, refreshEnd)}\nglobalThis.refresh = refreshAdminManagerStatus;`, context);
  await context.refresh();
  assert.equal(label.textContent, '관리자 AI · 실행자 모델 확인 필요');
  assert.match(toggle.title, /검증된 AI Account Router 계정·모델/);
  assert.equal(toggle.disabled, false, 'manager planning remains available while execution is unavailable');
  assert.equal(draft.value, 'saved draft stays here', 'status refresh must not alter the composer draft');
}

verifyReadinessLabelPreservesDraft().then(() => {
  console.log('admin manager UI refreshes truthful readiness on focus and preserves composer draft');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
