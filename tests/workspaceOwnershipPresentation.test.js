'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const { presentWorkspaceOwnership, presentTaskResumeFailure } = require('../src/ui/desktop/workspaceOwnershipPresentation.js');

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
      workspace: '/private/path', sourceChatId: 'source-chat-123', sessionId: 'secret-session', token: 'secret-token',
      releaseCondition: 'operation_completion_or_verified_process_death'
    },
    gitStatus: { available: false, error: 'raw git error' }
  });
  assert.match(output.leaseText, /이 작업공간의 실행 임대/);
  assert.match(output.leaseText, /개별 경로 잠금 및 통합 준비 상태와 별도/);
  assert.match(output.leaseDetail, /PID 1234/);
  assert.match(output.leaseDetail, /출처 채팅 source-chat-123/);
  assert.match(output.leaseDetail, /고정 만료 시각 없음/);
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
  const foreign = presentWorkspaceOwnership({ workspaceLease: { state: 'held', sameHost: false,
    releaseCondition: 'owner_operation_completion_or_explicit_owner_release' } });
  assert.match(foreign.leaseText, /이 작업공간의 실행 임대/);
  assert.match(foreign.leaseText, /개별 경로 잠금과도 별도/);
  assert.match(foreign.leaseDetail, /원격 소유자의 실행 완료 또는 명시적 해제/);
  const unknown = presentWorkspaceOwnership({ workspaceLease: { state: 'unknown', sameHost: null, reason: 'lock_unreadable' } });
  assert.equal(unknown.leaseText, '작업 상태를 알 수 없습니다.');
  assert.match(unknown.leaseDetail, /출처 확인 불가/);
  assert.match(unknown.leaseDetail, /lock_unreadable/);
});

test('free workspace execution lease is not presented as repository unlock', () => {
  const output = presentWorkspaceOwnership({
    pathLocks: { available: true, scope: 'active_in_process_paths', locks: [{ file: '/repo/a.js', taskId: 'task-a' }] },
    workspaceLease: { state: 'free', sameHost: null },
    gitStatus: { available: true, uncommitted: ['src/b.js'] }
  });
  assert.match(output.pathLockText, /개별 경로 잠금 1개/);
  assert.match(output.leaseText, /작업공간의 실행 임대가 없습니다/);
  assert.match(output.leaseText, /저장소 전체 잠금 상태를 뜻하지는 않습니다/);
  assert.match(output.gitText, /커밋되지 않은 변경 경로 1개/);
});

test('task lease conflicts identify request source, last reporter, owner, expiry and path', () => {
  const blockingTask = {
    taskKey: 'other-task', title: 'Blocking work', sourceChatId: 'request-chat', sourceHostId: 'source-host',
    lastUpdatedByChatId: 'report-chat', lastUpdatedByHostId: 'report-host', lastUpdatedAt: '2026-11-03T03:00:00Z',
    ownerChatId: 'owner-chat', leaseExpiresAt: '2026-11-03T03:15:00Z', paths: ['src/shared.js']
  };
  const owned = presentTaskResumeFailure({ reason: 'owned_by_other_chat', ownerChatId: 'owner-chat',
    leaseExpiresAt: blockingTask.leaseExpiresAt, blockingTask });
  assert.match(owned, /요청 채팅 request-chat/);
  assert.match(owned, /요청 기기 source-host/);
  assert.match(owned, /마지막 기록 채팅 report-chat/);
  assert.match(owned, /기록 기기 report-host/);
  assert.match(owned, /담당 채팅 owner-chat/);
  assert.match(owned, /잠금 경로 src\/shared\.js/);
  assert.match(owned, /임대/);

  const pathConflict = presentTaskResumeFailure({ reason: 'path_scope_conflict', blockingTaskKey: 'other-task',
    blockingTask, paths: ['src/shared.js'] });
  assert.match(pathConflict, /요청 채팅 request-chat/);
  assert.match(pathConflict, /마지막 기록 채팅 report-chat/);
  assert.match(pathConflict, /겹치지 않는 경로의 작업은 계속 진행할 수 있습니다/);
});
