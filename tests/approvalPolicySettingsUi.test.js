'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
const start = source.indexOf('function setApprovalPolicyControls(policy) {');
const end = source.indexOf('// Initialize', start);
assert.ok(start >= 0 && end > start, 'approval policy UI handlers must remain extractable');

function harness(fetchImpl) {
  const selects = [{ value: 'on-request', disabled: true }, { value: 'on-request', disabled: true }];
  const statuses = [{ textContent: '승인 정책을 불러오는 중…' }, { textContent: '승인 정책을 불러오는 중…' }];
  const context = {
    approvalPolicySelects: selects,
    approvalPolicyStatuses: statuses,
    APPROVAL_POLICY_VALUES: new Set(['on-request', 'never', 'read-only']),
    fetch: fetchImpl
  };
  vm.runInNewContext(`let activeApprovalPolicy = null;\n${source.slice(start, end)}\nglobalThis.handlers = { loadApprovalPolicy, saveApprovalPolicy, getActive: () => activeApprovalPolicy };`, context);
  return Object.assign(context, { selects, statuses });
}

(async () => {
  const calls = [];
  const ui = harness(async (url, options) => {
    calls.push({ url, options });
    if (options?.method !== 'POST') return { ok: true, json: async () => ({ policy: 'read-only' }) };
    return { ok: true, json: async () => ({ ok: true, policy: JSON.parse(options.body).policy }) };
  });
  await ui.handlers.loadApprovalPolicy();
  assert.deepEqual(ui.selects.map(item => item.value), ['read-only', 'read-only']);
  assert.ok(ui.selects.every(item => item.disabled === false));
  assert.ok(ui.statuses.every(item => /불러왔습니다/.test(item.textContent)));
  await ui.handlers.saveApprovalPolicy('never');
  assert.deepEqual(ui.selects.map(item => item.value), ['never', 'never']);
  assert.equal(ui.handlers.getActive(), 'never');
  assert.equal(calls[1].url, '/api/settings/approval-policy');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.body, '{"policy":"never"}');
  assert.ok(ui.statuses.every(item => /저장되었습니다/.test(item.textContent)));

  ui.fetch = async () => ({ ok: false });
  await ui.handlers.saveApprovalPolicy('read-only');
  assert.deepEqual(ui.selects.map(item => item.value), ['never', 'never'], 'failed saves restore both controls to the last persisted choice');

  const unavailable = harness(async () => { throw new Error('offline'); });
  await unavailable.handlers.loadApprovalPolicy();
  assert.ok(unavailable.selects.every(item => item.disabled === true));
  assert.ok(unavailable.statuses.every(item => /안전을 위해 선택을 비활성화/.test(item.textContent)));

  const unsupported = harness(async () => ({ ok: false, status: 404 }));
  await unsupported.handlers.loadApprovalPolicy();
  assert.ok(unsupported.selects.every(item => item.disabled === true));
  assert.ok(unsupported.statuses.every(item => /서버에서 승인 정책 API를 찾을 수 없습니다/.test(item.textContent)));
  assert.ok(unsupported.statuses.every(item => /서버 업데이트가 필요할 수 있습니다/.test(item.textContent)));
  console.log('approvalPolicySettingsUi passed: load, dual-selector sync, save, rollback, and fail-closed loading');
})().catch(error => { console.error(error); process.exitCode = 1; });
