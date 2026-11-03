'use strict';

const assert = require('node:assert/strict');

async function main() {
  const { buildAdminManagerSystemMessage, buildExecutorSystemMessage, parseExecutorPlan, withAdminManagerMessage } = await import('../src/features/admin-manager/v1.mjs');
  const hash = 'a'.repeat(64);
  const snapshot = {
    modules: [
      { id: 'desktop-server', version: '1.0.1', state: 'loaded', sourceHash: hash },
      { id: 'recently-edited', version: '1.0.1', state: 'stale' },
      { id: 'unwired-qa', version: '0', state: 'unavailable' }
    ],
    capabilities: [
      { id: 'browser.read', name: '현재 페이지 읽기', state: 'executable', moduleId: 'desktop-server' },
      { id: 'qa.external', name: '외부 앱 QA', state: 'unavailable', moduleId: 'unwired-qa' }
    ]
  };
  const history = [{ role: 'user', content: '질문' }];
  const prepared = withAdminManagerMessage(history, snapshot);

  assert.equal(prepared.length, 2);
  assert.equal(prepared[0].role, 'system');
  assert.match(prepared[0].content, /browser\.read: 현재 페이지 읽기; state=executable/);
  assert.match(prepared[0].content, new RegExp(`sha256=${hash}`));
  assert.match(prepared[0].content, /recently-edited: version=1\.0\.1; state=stale; sha256=not-loaded/);
  assert.match(prepared[0].content, /현재 실행 프로세스 시작 뒤 소스가 바뀌어/);
  assert.match(prepared[0].content, /qa\.external: 외부 앱 QA; state=unavailable/);
  assert.match(prepared[0].content, /변경을 완료했다고 말하지 마세요/);
  assert.match(prepared[0].content, /executor_plan/);
  assert.deepEqual(history, [{ role: 'user', content: '질문' }]);
  assert.throws(() => buildAdminManagerSystemMessage({ modules: [], capabilities: [{ id: 'x', name: 'x', state: 'executable', moduleId: 'missing' }] }), /unregistered module/);
  assert.throws(() => buildAdminManagerSystemMessage({ modules: [{ id: 'broken', version: '1', state: 'loaded' }], capabilities: [] }), /requires source hash/);
  const feasiblePlan = { type: 'executor_plan', summary: '요약', feasibility: { status: 'ready', reason: '읽기 도구와 범위가 준비됨' }, tasks: [{ title: '검토', prompt: '파일을 읽어 확인', files: ['README.md'], allowedTools: ['read_file', 'read_file'] }] };
  assert.deepEqual(parseExecutorPlan(feasiblePlan, {
    hasAvailableExecutor: () => true
  }).tasks[0], { title: '검토', prompt: '파일을 읽어 확인', files: ['README.md'], allowedTools: ['read_file'] });
  const plan = (tasks, feasibility = { status: 'ready', reason: '범위 확인됨' }) => ({ type: 'executor_plan', summary: '요약', feasibility, tasks });
  const task = (files, allowedTools = ['read_file']) => ({ title: '검토', prompt: '확인', files, allowedTools });
  assert.throws(() => parseExecutorPlan(plan([task(['README.md'], ['read_file', '../write_file'])])), /허용 도구 목록/);
  assert.throws(() => parseExecutorPlan(plan([task(['README.md'], 'read_file')])), /허용 도구 목록/);
  assert.throws(() => parseExecutorPlan(plan([task([])])), /대상 경로가 비어/);
  assert.throws(() => parseExecutorPlan(plan([task(['../secret'])])), /대상 경로/);
  assert.throws(() => parseExecutorPlan(plan([task(['src/core']), { ...task(['src/core/a.js']), title: '수정' }])), /소유 범위와 겹칩니다/);
  assert.throws(() => parseExecutorPlan({ type: 'executor_plan', summary: '요약', tasks: [task(['README.md'])] }), /형식이나 작업 수/);
  assert.deepEqual(parseExecutorPlan(plan([], { status: 'blocked', reason: '실행자 없음' })), { summary: '요약', feasibility: { status: 'blocked', reason: '실행자 없음' }, tasks: [] });
  assert.throws(() => parseExecutorPlan(plan([task(['README.md'])]), {
    hasAvailableExecutor: () => false
  }), /사용 가능한 실행자/);
  const executorMessage = buildExecutorSystemMessage({ taskTitle: '읽기', workspaceDir: '/tmp/work', files: ['src/core/A.js'] }).content;
  assert.match(executorMessage, /한 작업만 수행/);
  assert.match(executorMessage, /허용 파일 경로: src\/core\/A\.js/);
  assert.match(executorMessage, /실제 이 요청에서 사용할 수 있게 제공된 도구만 사용하세요/);
  assert.match(executorMessage, /Codex CLI의 exec_command와 Only Chat의 read_file, list_files, search_files는 해당 도구가 실제 세션에 있을 때만 사용하세요/);
  assert.doesNotMatch(executorMessage, /이 실행자는 Only Chat 내부 도구가 아니라 Codex CLI로 동작합니다/);
  assert.throws(() => buildExecutorSystemMessage({ taskTitle: '잘못된 범위', workspaceDir: '/tmp/work', files: ['../secret'] }), /file scope is invalid/);
  assert.match(executorMessage, /테스트 파일을 읽은 것은 테스트 실행이 아니며/);
  assert.match(executorMessage, /설치 앱 UI, 실제 provider, 기기 또는 Windows 실행 증거가 아닙니다/);
  assert.throws(() => buildExecutorSystemMessage({ taskTitle: '', workspaceDir: '/tmp/work' }), /taskTitle/);
  console.log('admin manager contract passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
