'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ParallelDispatcher,
  parseDarwinAvailablePercent
} = require('../src/core/ParallelDispatcher.js');
const { AgentEngine } = require('../src/core/AgentEngine.js');
const { DEFAULT_PRESET_TIERS } = require('../src/priority/PriorityChainEngine.js');

const GIB = 1024 ** 3;

test('parses only a bounded macOS memory_pressure percentage', () => {
  assert.equal(parseDarwinAvailablePercent('System-wide memory free percentage: 37%'), 37);
  assert.equal(parseDarwinAvailablePercent('System-wide memory free percentage: 37.5%'), 37.5);
  assert.equal(parseDarwinAvailablePercent('no reading'), null);
  assert.equal(parseDarwinAvailablePercent('System-wide memory free percentage: 101%'), null);
});

test('uses cached macOS available memory instead of free pages for worker limits', () => {
  let now = 100_000;
  let sample = 37;
  let sampleCount = 0;
  const dispatcher = new ParallelDispatcher({
    autoStart: false,
    platform: 'darwin',
    getTotalMemory: () => 16 * GIB,
    getFreeMemory: () => 80 * 1024 ** 2,
    readAvailablePercent: () => { sampleCount += 1; return sample; },
    now: () => now
  });

  try {
    const first = dispatcher.getMemoryMetrics();
    assert.equal(first.freePercent, 0);
    assert.equal(first.availablePercent, 37);
    assert.equal(first.memorySource, 'memory_pressure');
    assert.equal(first.allowedWorkers, 3);
    assert.ok(first.availableBytes >= 4 * GIB);

    sample = 12;
    now += 14_999;
    assert.equal(dispatcher.getMemoryMetrics().availablePercent, 37);
    assert.equal(sampleCount, 1);

    now += 1;
    const refreshed = dispatcher.getMemoryMetrics();
    assert.equal(refreshed.availablePercent, 12);
    assert.equal(refreshed.allowedWorkers, 0);
    assert.equal(refreshed.pressureLevel, 'critical (대기/스로틀링)');
    assert.equal(sampleCount, 2);
  } finally {
    dispatcher.stop();
  }
});

test('falls back to os.freemem if the macOS sample is unavailable', () => {
  const dispatcher = new ParallelDispatcher({
    autoStart: false,
    platform: 'darwin',
    getTotalMemory: () => 16 * GIB,
    getFreeMemory: () => 2 * GIB,
    readAvailablePercent: () => null,
    now: () => 100_000
  });

  try {
    const metrics = dispatcher.getMemoryMetrics();
    assert.equal(metrics.availablePercent, metrics.freePercent);
    assert.equal(metrics.availablePercent, 13);
    assert.equal(metrics.availableBytes, Math.floor((16 * GIB * 13) / 100));
    assert.equal(metrics.memorySource, 'os.freemem');
    assert.equal(metrics.allowedWorkers, 0);
  } finally {
    dispatcher.stop();
  }
});

test('keeps non-macOS memory calculations on os.freemem without spawning a sampler', () => {
  let sampleCount = 0;
  const dispatcher = new ParallelDispatcher({
    autoStart: false,
    platform: 'linux',
    getTotalMemory: () => 16 * GIB,
    getFreeMemory: () => 4.5 * GIB,
    readAvailablePercent: () => { sampleCount += 1; return 90; }
  });

  try {
    const metrics = dispatcher.getMemoryMetrics();
    assert.equal(metrics.availablePercent, metrics.freePercent);
    assert.equal(metrics.memorySource, 'os.freemem');
    assert.equal(metrics.allowedWorkers, 2);
    assert.equal(sampleCount, 0);
  } finally {
    dispatcher.stop();
  }
});

test('blocks a tool-required task when the executor reports completed without evidence', async () => {
  const dispatcher = new ParallelDispatcher({
    autoStart: false,
    getTotalMemory: () => 16 * GIB,
    getFreeMemory: () => 8 * GIB,
    executeTask: async () => ({ status: 'completed', result: 'agent response' })
  });
  try {
    const task = { id: 'completed-task', prompt: 'do work', status: 'queued' };
    await dispatcher._runWorker(task);
    assert.equal(task.status, 'blocked');
    assert.match(task.blockReason, /도구 실행 증거/);
    assert.equal(task.result, 'agent response');
    assert.deepEqual(dispatcher.completedTasks, []);
    assert.deepEqual(dispatcher.terminalTasks, [task]);
  } finally {
    dispatcher.stop();
  }
});

test('records a tool-required task completed only with successful execution evidence', async () => {
  const dispatcher = new ParallelDispatcher({
    autoStart: false,
    executeTask: async () => ({
      status: 'completed',
      result: 'agent response',
      executionEvidence: {
        attemptedCount: 1, successfulCount: 1, failedCount: 0, toolNames: ['read_file'],
        allowedToolViolationCount: 0, disallowedToolNames: [],
        provider: 'codex', model: 'gpt-6-luna', tierId: 'codex-primary'
      }
    })
  });
  try {
    const task = { id: 'evidenced-completion', prompt: 'do work', status: 'queued' };
    await dispatcher._runWorker(task);
    assert.equal(task.status, 'completed');
    assert.equal(task.executionEvidence.successfulCount, 1);
    assert.deepEqual(dispatcher.completedTasks, [task]);
  } finally {
    dispatcher.stop();
  }
});

test('blocks successful tool counts when route metadata or tool names are missing or malformed', async () => {
  const invalidEvidence = [
    { attemptedCount: 1, successfulCount: 1, failedCount: 0, toolNames: ['read_file'], allowedToolViolationCount: 0, disallowedToolNames: [], model: 'gpt-6-luna', tierId: 'codex-primary' },
    { attemptedCount: 1, successfulCount: 1, failedCount: 0, toolNames: ['read_file'], allowedToolViolationCount: 0, disallowedToolNames: [], provider: 'codex', tierId: 'codex-primary' },
    { attemptedCount: 1, successfulCount: 1, failedCount: 0, toolNames: ['read_file'], allowedToolViolationCount: 0, disallowedToolNames: [], provider: 'codex', model: 'gpt-6-luna' },
    { attemptedCount: 1, successfulCount: 1, failedCount: 0, toolNames: ['bad tool'], allowedToolViolationCount: 0, disallowedToolNames: [], provider: 'codex', model: 'gpt-6-luna', tierId: 'codex-primary' },
    { attemptedCount: 1, successfulCount: 1, failedCount: 0, toolNames: ['read_file', 'write_file'], allowedToolViolationCount: 0, disallowedToolNames: [], provider: 'codex', model: 'gpt-6-luna', tierId: 'codex-primary' },
    { attemptedCount: 1, successfulCount: 1, failedCount: 0, toolNames: ['exec_command'], disallowedToolNames: ['exec_command'], allowedToolViolationCount: 1, provider: 'codex', model: 'gpt-6-luna', tierId: 'codex-primary' },
    { attemptedCount: 1, successfulCount: 1, failedCount: 0, toolNames: ['read_file'], disallowedToolNames: 'write_file', allowedToolViolationCount: 0, provider: 'codex', model: 'gpt-6-luna', tierId: 'codex-primary' },
    { attemptedCount: 1, successfulCount: 1, failedCount: 0, toolNames: ['read_file'], disallowedToolNames: [], allowedToolViolationCount: '0', provider: 'codex', model: 'gpt-6-luna', tierId: 'codex-primary' },
    { attemptedCount: 1, successfulCount: 1, failedCount: 0, toolNames: ['read_file'], disallowedToolNames: [], provider: 'codex', model: 'gpt-6-luna', tierId: 'codex-primary' }
  ];
  for (const [index, executionEvidence] of invalidEvidence.entries()) {
    const dispatcher = new ParallelDispatcher({
      autoStart: false,
      executeTask: async () => ({ status: 'completed', result: 'agent response', executionEvidence })
    });
    try {
      const task = { id: `incomplete-evidence-${index}`, prompt: 'do work', status: 'queued' };
      await dispatcher._runWorker(task);
      assert.equal(task.status, 'blocked');
      if (Number(executionEvidence.allowedToolViolationCount) > 0) assert.match(task.blockReason, /허용 목록 밖 도구 이벤트/);
      else assert.match(task.blockReason, /실행 계정 메타데이터가 부족/);
      assert.equal(dispatcher.completedTasks.length, 0);
    } finally {
      dispatcher.stop();
    }
  }
});

test('preserves blocked and failed executor outcomes without counting them completed', async () => {
  const dispatcher = new ParallelDispatcher({
    autoStart: false,
    executeTask: async task => task.id === 'blocked-task'
      ? { status: 'blocked', reason: 'approval required' }
      : { status: 'failed', error: 'provider failed' }
  });

  try {
    const blocked = { id: 'blocked-task', prompt: 'blocked', status: 'queued' };
    const failed = { id: 'failed-task', prompt: 'failed', status: 'queued' };
    await dispatcher._runWorker(blocked);
    await dispatcher._runWorker(failed);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockReason, 'approval required');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'provider failed');
    assert.equal(dispatcher.completedTasks.length, 0);
  } finally {
    dispatcher.stop();
  }
});

test('marks queued tasks blocked when no real execution handler is configured', async () => {
  const dispatcher = new ParallelDispatcher({ autoStart: false });
  try {
    const task = { id: 'no-handler', prompt: 'work', status: 'queued' };
    await dispatcher._runWorker(task);
    assert.equal(task.status, 'blocked');
    assert.match(task.blockReason, /실행기가 연결되지 않았습니다/);
    assert.equal(dispatcher.completedTasks.length, 0);
  } finally {
    dispatcher.stop();
  }
});

test('executes a queued task through an isolated AgentEngine session and preserves the active chat', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-dispatch-agent-'));
  const seenHistory = [];
  const engine = new AgentEngine({
    isolated: true,
    dataDir: tmpDir,
    workspaceDir: path.join(tmpDir, 'workspace'),
    dispatcherAutoStart: false,
    providerAdapter: async (_tier, history) => {
      seenHistory.push(history.map(item => ({ ...item })));
      return { content: 'queued agent response', toolCalls: [] };
    }
  });

  try {
    engine.priorityChain.setTiers([DEFAULT_PRESET_TIERS[0]]);
    const activeSession = engine.initSession({ title: 'active chat' });
    engine.conversationHistory = [{ role: 'user', content: 'existing chat context' }];
    engine.handoff.saveCheckpoint({ sessionId: activeSession.sessionId, lastPrompt: 'active checkpoint' });
    const checkpointBefore = engine.handoff.loadCheckpoint();
    const task = { id: 'for-ai-feedback', title: 'For AI feedback', prompt: 'Run this queued task', status: 'queued', requireToolExecution: false };

    await engine.dispatcher._runWorker(task);

    assert.equal(task.status, 'completed');
    assert.equal(task.result, 'queued agent response');
    assert.ok(task.sessionId);
    assert.notEqual(task.sessionId, activeSession.sessionId);
    assert.deepEqual(engine.conversationHistory, [{ role: 'user', content: 'existing chat context' }]);
    assert.equal(engine.currentSession.sessionId, activeSession.sessionId);
    assert.deepEqual(engine.handoff.loadCheckpoint(), checkpointBefore);
    assert.equal(seenHistory.length, 1);
    assert.equal(seenHistory[0].some(item => item.content === 'existing chat context'), false);
    assert.equal(engine.sessions.readSession(task.sessionId).some(item => item.content === 'queued agent response'), true);
    assert.equal(engine.dispatcher.getSnapshot().completedTasks[0].sessionId, task.sessionId);
  } finally {
    engine.dispatcher.stop();
    engine.skills.stopWatching();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('leaves queued tasks waiting while the workspace is busy', async () => {
  let executions = 0;
  const dispatcher = new ParallelDispatcher({
    autoStart: false,
    canStartTask: () => false,
    executeTask: async () => { executions += 1; return { status: 'completed' }; }
  });
  try {
    const [task] = dispatcher.enqueueTasks([{ id: 'busy-workspace', prompt: 'wait', allowedTools: ['read_file'] }]);
    await dispatcher.tick();
    assert.equal(task.status, 'queued');
    assert.equal(executions, 0);
  } finally {
    dispatcher.stop();
  }
});

test('enqueueTasks defaults execution requirement to true and preserves explicit opt-out', () => {
  const dispatcher = new ParallelDispatcher({ autoStart: false });
  try {
    assert.throws(() => dispatcher.enqueueTasks([{ id: 'missing-allowlist', prompt: 'must reject' }]), /allowedTools/);
    assert.equal(dispatcher.queue.length, 0, 'invalid batches are rejected before queue mutation');
    const [required, optedOut] = dispatcher.enqueueTasks([
      { id: 'default-tool-requirement', prompt: 'default', allowedTools: ['read_file'] },
      { id: 'opt-out-tool-requirement', prompt: 'pure answer', allowedTools: ['read_file'], requireToolExecution: false }
    ]);
    assert.equal(required.requireToolExecution, true);
    assert.equal(optedOut.requireToolExecution, false);
  } finally {
    dispatcher.stop();
  }
});
