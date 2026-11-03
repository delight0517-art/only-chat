'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentEngine } = require('../src/core/AgentEngine.js');

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'only-chat-admin-manager-'));
  let receivedHistory;
  let delegated;
  let enqueued;
  const engine = new AgentEngine({
    isolated: true,
    dataDir: profile,
    workspaceDir: path.join(profile, 'workspace'),
    providerAdapter: async (_tier, history) => {
      receivedHistory = history;
      return { content: JSON.stringify({ type: 'executor_plan', summary: '설정 구현을 나눕니다', tasks: [{ title: '필요 범위 확인', prompt: '사용자 요청에서 구현 범위와 검증 조건을 정리합니다.', files: ['src/core/AgentEngine.js'], allowedTools: ['read_file'] }] }), toolCalls: [] };
    }
  });
  try {
    engine.priorityChain.upsertTier({ id: 'synthetic', name: 'Synthetic', provider: 'test', model: 'offline' });
    engine.isolated = false;
    engine.initSession();
    engine.dispatcher.enqueueTasks = tasks => {
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
    assert.match(response.content, /실행자: 1개 작업/);
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].requireToolExecution, true);
    assert.deepEqual(enqueued[0].allowedTools, ['read_file']);
    assert.equal(delegated.tasks[0].id, enqueued[0].id);
    assert.deepEqual(deltas, [response.content]);
    const saved = engine.sessions.readSession(engine.currentSession.sessionId);
    assert.equal(saved.some(item => item.content === '실제 capability 요약'), false);
    assert.equal(saved.some(item => item.type === 'tool_result'), false);
    assert.equal(saved.some(item => item.type === 'manager_delegation' && item.tasks[0].id === enqueued[0].id), true);
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
