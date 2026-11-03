'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
const start = source.indexOf('function startNewSession() {');
const end = source.indexOf('\nlet currentFilter', start);
assert.ok(start >= 0 && end > start, 'startNewSession remains independently checkable');

const calls = [];
const timeline = { innerHTML: '', appendChild() {} };
const emptyState = { style: { display: 'none' } };
const composerInput = { value: 'existing draft', focus() { calls.push('focus'); } };
const status = { textContent: 'old status' };
const title = { textContent: 'Prior session' };
const context = {
  Date: { now: () => 1234567890123 },
  currentSessionId: 'ses_0123456789abcdef',
  currentCodexThreadId: 'old-thread',
  timeline, emptyState, composerInput, titlebarThreadTitle: title,
  document: { getElementById: id => id === 'composerStatus' ? status : null },
  applyPendingUiMorphReloadWhenSafe() { calls.push('morph-safe-check'); },
  refreshPriorityStatus() { calls.push('refresh-workspace-status'); return Promise.resolve(); }
};
vm.runInNewContext(`${source.slice(start, end)}; startNewSession();`, context);

assert.equal(context.currentSessionId, 'session_1234567890123');
assert.equal(context.currentCodexThreadId, null, 'new chat drops the previous Codex source binding');
assert.equal(composerInput.value, '', 'new chat clears the prior composer draft');
assert.equal(title.textContent, 'Only Chat · 연결되는 작업실');
assert.equal(emptyState.style.display, 'flex');
assert.equal(status.textContent, '');
assert.deepEqual(calls, ['refresh-workspace-status', 'focus', 'morph-safe-check'], 'new chat refreshes its status without issuing a reload itself');
console.log('sessionBindingRenderer passed: new chat resets identity and requests a fresh workspace status');
