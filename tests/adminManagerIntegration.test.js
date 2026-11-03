'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { AgentEngine } = require('../src/core/AgentEngine.js');
const { TaskRegistryStore } = require('../src/core/TaskRegistryStore.js');

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'only-chat-admin-manager-'));
  const workspace = path.join(profile, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'README.md'), 'manager fixture\n');
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Only Chat Test', GIT_AUTHOR_EMAIL: 'only-chat-test@example.invalid', GIT_COMMITTER_NAME: 'Only Chat Test', GIT_COMMITTER_EMAIL: 'only-chat-test@example.invalid' };
  execFileSync('git', ['init', '--quiet'], { cwd: workspace, env: gitEnv });
  execFileSync('git', ['add', 'README.md'], { cwd: workspace, env: gitEnv });
  execFileSync('git', ['commit', '--quiet', '-m', 'manager fixture'], { cwd: workspace, env: gitEnv });
  let receivedHistory;
  let delegated;
  let enqueued;
  let enqueueCalls = 0;
  const taskRegistryStore = new TaskRegistryStore({ dataDir: path.join(profile, 'registry') });
  const engine = new AgentEngine({
    isolated: true,
    dataDir: profile,
    workspaceDir: workspace,
    taskRegistryStore,
    providerAdapter: async (_tier, history) => {
      receivedHistory = history;
      return { content: JSON.stringify({ type: 'executor_plan', summary: '설정 구현을 나눕니다', feasibility: { status: 'ready', reason: '실행자와 읽기 권한이 준비되어 있습니다.' }, tasks: [{ title: '필요 범위 확인', prompt: '사용자 요청에서 구현 범위와 검증 조건을 정리합니다.', files: ['src/core/AgentEngine.js'], allowedTools: ['read_file'] }] }), toolCalls: [] };
    }
  });
  try {
    engine.priorityChain.upsertTier({ id: 'synthetic', name: 'Synthetic', provider: 'test', model: 'offline' });
    engine.isolated = false;
    engine.initSession();
    const managerSessionId = engine.currentSession.sessionId;
    engine.dispatcher.enqueueTasks = tasks => {
      enqueueCalls += 1;
      enqueued = tasks.map(task => ({ ...task, status: 'queued' }));
      return enqueued;
    };
    const deltas = [];
    const response = await engine.executeTurn('이 요청을 수행해 줘', {
      managerMode: true,
      managerSystemMessage: { role: 'system', content: '실제 capability 요약' },
      onMessageDelta: text => deltas.push(text),
      onManagerDelegation: event => { delegated = event; }
    });

    assert.equal(receivedHistory[0].role, 'system');
    assert.match(receivedHistory[0].content, /실제 capability/);
    assert.deepEqual(engine.conversationHistory.map(item => item.role), ['user', 'assistant']);
    assert.equal(response.toolCalls.length, 0);
    assert.match(response.content, /실행자 1개 작업을 큐에 접수/);
    assert.match(response.content, /실행 가능:/);
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].requireToolExecution, true);
    assert.deepEqual(enqueued[0].allowedTools, ['read_file']);
    assert.match(enqueued[0].registryTaskKey, /^manager-[a-f0-9]{48}$/);
    assert.equal(enqueued[0].id, `${enqueued[0].registryTaskKey}-1`);
    assert.equal(delegated.tasks[0].id, enqueued[0].id);
    assert.equal(delegated.registryTaskKey, enqueued[0].registryTaskKey);
    const storedPlan = taskRegistryStore.getTask(delegated.registryTaskKey);
    assert.equal(storedPlan.status, 'claimed');
    assert.equal(storedPlan.repositoryPath, fs.realpathSync(workspace));
    assert.equal(storedPlan.execution.tasks[0].prompt, '사용자 요청에서 구현 범위와 검증 조건을 정리합니다.');
    assert.deepEqual(deltas, [response.content]);
    const saved = engine.sessions.readSession(engine.currentSession.sessionId);
    assert.equal(saved.some(item => item.content === '실제 capability 요약'), false);
    assert.equal(saved.some(item => item.type === 'tool_result'), false);
    assert.equal(saved.some(item => item.type === 'manager_delegation' && item.tasks[0].id === enqueued[0].id), true);
    const duplicate = await engine.executeTurn('이 요청을 수행해 줘', {
      managerMode: true,
      managerSystemMessage: { role: 'system', content: '실제 capability 요약' }
    });
    assert.equal(engine.currentSession.sessionId, managerSessionId);
    assert.match(duplicate.content, /중복 실행은 추가하지 않았습니다/);
    assert.equal(enqueueCalls, 1, 'identical manager plans must not be queued twice');
    engine.providerAdapter = async () => ({ content: JSON.stringify({ type: 'executor_plan', summary: '대상 파일을 특정하지 못했습니다', feasibility: { status: 'blocked', reason: '변경 범위와 소유 파일을 확인할 수 없습니다.' }, tasks: [] }), toolCalls: [] });
    let blockedEnqueueCount = 0;
    engine.dispatcher.enqueueTasks = () => { blockedEnqueueCount += 1; return []; };
    const blocked = await engine.executeTurn('실행 가능성을 확인해 주세요', { managerMode: true, managerSystemMessage: { role: 'system', content: '실제 capability 요약' } });
    assert.match(blocked.content, /실행 불가/);
    assert.equal(blockedEnqueueCount, 0);
    console.log('manager plan validation and executor queue handoff passed');
  } finally {
    engine.skills.stopWatching();
    engine.dispatcher.stop();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
