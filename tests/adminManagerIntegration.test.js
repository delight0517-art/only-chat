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
  const leaseTimers = [];
  const taskRegistryStore = new TaskRegistryStore({ dataDir: path.join(profile, 'registry') });
  const engine = new AgentEngine({
    isolated: true,
    dataDir: profile,
    workspaceDir: workspace,
    taskRegistryStore,
    scheduleManagerLeaseRenewal: (callback, intervalMs) => {
      const timer = { callback, intervalMs, cancelled: false, unref() {} };
      leaseTimers.push(timer);
      return timer;
    },
    cancelManagerLeaseRenewal: timer => { timer.cancelled = true; },
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
    const worker = enqueued[0];
    assert.equal(worker.managerOwnerChatId, managerSessionId);
    engine.dispatcher.emit('worker_started', { task: worker });
    await engine.managerProgressQueues.get(delegated.registryTaskKey);
    assert.equal(leaseTimers[0].intervalMs, 5 * 60_000);
    const revisionBeforeRenewal = taskRegistryStore.getTask(delegated.registryTaskKey).revision;
    await leaseTimers[0].callback();
    assert.ok(taskRegistryStore.getTask(delegated.registryTaskKey).revision > revisionBeforeRenewal);
    engine.dispatcher.emit('worker_completed', { task: worker, result: {
      status: 'completed', sessionId: 'worker-session-1', result: '작업 결과가 저장되었습니다.', executionEvidence: null
    } });
    await engine.managerProgressQueues.get(delegated.registryTaskKey);
    const completedParent = taskRegistryStore.getTask(delegated.registryTaskKey);
    assert.equal(completedParent.status, 'verifying');
    assert.equal(completedParent.executionProgress[0].status, 'completed');
    assert.equal(completedParent.executionProgress[0].result, '작업 결과가 저장되었습니다.');
    assert.equal(completedParent.executionProgress[0].sessionId, 'worker-session-1');
    assert.equal(leaseTimers[0].cancelled, true);
    const recoveryPlan = {
      kind: 'executor-plan', summary: 'Retry only unfinished work', tasks: [
        { title: 'Review docs', prompt: 'Review the selected doc.', files: ['docs/retry.md'], allowedTools: ['read_file'] },
        { title: 'Review tests', prompt: 'Review the selected test.', files: ['docs/retry.test.md'], allowedTools: ['read_file'] }
      ]
    };
    await taskRegistryStore.createTask({ taskKey: 'manager-resume-fixture', title: recoveryPlan.summary,
      creatorChatId: managerSessionId, repositoryPath: workspace, baseSha: 'a'.repeat(40), paths: ['docs/retry.md', 'docs/retry.test.md'],
      nextAction: 'Run saved tasks', idempotencyKey: 'create-resume-fixture', execution: recoveryPlan });
    await taskRegistryStore.claimTask({ taskKey: 'manager-resume-fixture', ownerChatId: managerSessionId, idempotencyKey: 'claim-resume-fixture' });
    await taskRegistryStore.recordExecutorProgress({ taskKey: 'manager-resume-fixture', ownerChatId: managerSessionId,
      executorId: 'manager-resume-fixture-1', status: 'running', idempotencyKey: 'resume-fixture-start-1' });
    await taskRegistryStore.recordExecutorProgress({ taskKey: 'manager-resume-fixture', ownerChatId: managerSessionId,
      executorId: 'manager-resume-fixture-1', status: 'blocked', idempotencyKey: 'resume-fixture-block-1',
      reason: 'Approval unavailable.', result: 'Keep this result.' });
    await taskRegistryStore.recordExecutorProgress({ taskKey: 'manager-resume-fixture', ownerChatId: managerSessionId,
      executorId: 'manager-resume-fixture-2', status: 'running', idempotencyKey: 'resume-fixture-start-2' });
    await taskRegistryStore.recordExecutorProgress({ taskKey: 'manager-resume-fixture', ownerChatId: managerSessionId,
      executorId: 'manager-resume-fixture-2', status: 'completed', idempotencyKey: 'resume-fixture-done-2', result: 'Already done.' });
    const deniedResume = await engine.resumeManagerPlan({ taskKey: 'manager-resume-fixture', ownerChatId: 'different-chat', idempotencyKey: 'resume-fixture-denied' });
    assert.equal(deniedResume.reason, 'creator_chat_mismatch');
    const resumed = await engine.resumeManagerPlan({ taskKey: 'manager-resume-fixture', ownerChatId: managerSessionId, idempotencyKey: 'resume-fixture-ok' });
    assert.equal(resumed.accepted, true);
    assert.equal(resumed.queuedCount, 1);
    assert.deepEqual(enqueued.map(task => task.id), ['manager-resume-fixture-1']);
    assert.equal(taskRegistryStore.getTask('manager-resume-fixture').executionProgress[0].history[0].result, 'Keep this result.');
    assert.equal(taskRegistryStore.getTask('manager-resume-fixture').executionProgress[1].status, 'completed');
    engine.dispatcher.emit('worker_started', { task: enqueued[0] });
    await engine.managerProgressQueues.get('manager-resume-fixture');
    const enqueueCountAfterResume = enqueueCalls;
    const replayedResume = await engine.resumeManagerPlan({ taskKey: 'manager-resume-fixture', ownerChatId: managerSessionId, idempotencyKey: 'resume-fixture-ok' });
    assert.equal(replayedResume.replayed, true);
    assert.equal(enqueueCalls, enqueueCountAfterResume, 'replayed resume must not enqueue duplicate workers');
    engine.dispatcher.emit('worker_completed', { task: enqueued[0], result: { sessionId: 'retry-session', result: 'Retry complete.', executionEvidence: null } });
    await engine.managerProgressQueues.get('manager-resume-fixture');
    assert.equal(leaseTimers[1].cancelled, true);
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
