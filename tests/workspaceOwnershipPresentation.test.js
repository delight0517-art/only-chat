'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const { presentWorkspaceOwnership } = require('../src/ui/desktop/workspaceOwnershipPresentation.js');

test('browser-like VM publishes the helper on window without CommonJS', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/ui/desktop/workspaceOwnershipPresentation.js'), 'utf8'), context);
  assert.equal(typeof context.window.workspaceOwnershipPresentation.presentWorkspaceOwnership, 'function');
  assert.equal(
    context.window.workspaceOwnershipPresentation.presentWorkspaceOwnership({ gitStatus: { available: true, uncommitted: [] } }).gitText,
    '커밋되지 않은 변경 사항이 없습니다.'
  );
});

test('settings ownership refresh has one call site per General entry and manual click', () => {
  const app = fs.readFileSync(require.resolve('../src/ui/desktop/app.js'), 'utf8');
  assert.equal((app.match(/void refreshWorkspaceOwnership\(\)/g) || []).length, 3);
  assert.match(app, /btnRefreshWorkspaceOwnership[\s\S]*?void refreshWorkspaceOwnership\(\)/);
  assert.match(app, /if \(tabId === 'general'\) void refreshWorkspaceOwnership\(\)/);
  assert.match(app, /if \(targetTab === 'general'\) void refreshWorkspaceOwnership\(\)/);
});

test('workspace and Git statuses are presented without exposing private API fields', () => {
  const output = presentWorkspaceOwnership({
    workspaceLease: {
      state: 'held', sameHost: true, pid: 1234, startedAt: '2026-10-30T01:00:00.000Z',
      workspace: '/private/path', sessionId: 'secret-session', token: 'secret-token'
    },
    gitStatus: { available: false, error: 'raw git error' }
  });
  assert.equal(output.leaseText, '이 Mac에서 작업 중입니다.');
  assert.match(output.leaseDetail, /PID 1234/);
  assert.equal(output.gitText, 'Git 상태를 확인할 수 없습니다.');
  assert.equal(JSON.stringify(output).includes('/private/path'), false);
  assert.equal(JSON.stringify(output).includes('secret-session'), false);
  assert.equal(JSON.stringify(output).includes('raw git error'), false);
});

test('available Git status distinguishes clean and changed paths without listing paths', () => {
  const clean = presentWorkspaceOwnership({ gitStatus: { available: true, uncommitted: [] } });
  assert.equal(clean.gitText, '커밋되지 않은 변경 사항이 없습니다.');

  const dirty = presentWorkspaceOwnership({
    gitStatus: { available: true, uncommitted: ['src/private.js', 'TODO_ROADMAP.md'] }
  });
  assert.equal(dirty.gitText, '커밋되지 않은 변경 경로 2개가 있습니다.');
  assert.equal(dirty.gitText.includes('src/private.js'), false);
  assert.equal(dirty.gitText.includes('TODO_ROADMAP.md'), false);
});

test('unavailable or unknown Git status remains distinct from a clean status', () => {
  assert.equal(
    presentWorkspaceOwnership({ gitStatus: { available: false, uncommitted: [] } }).gitText,
    'Git 상태를 확인할 수 없습니다.'
  );
  assert.equal(presentWorkspaceOwnership({}).gitText, 'Git 상태를 확인할 수 없습니다.');
});

test('foreign-host lease is explicitly not judged stale and unknown data stays unknown', () => {
  assert.match(presentWorkspaceOwnership({ workspaceLease: { state: 'held', sameHost: false } }).leaseText, /오래된 잠금인지 판단할 수 없습니다/);
  assert.equal(presentWorkspaceOwnership({ workspaceLease: { state: 'unknown', sameHost: null } }).leaseText, '작업 상태를 알 수 없습니다.');
});
