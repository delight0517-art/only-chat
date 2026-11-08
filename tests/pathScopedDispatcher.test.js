'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { AgentEngine, hasPathScopedOwnership } = require('../src/core/AgentEngine.js');
const { ParallelDispatcher } = require('../src/core/ParallelDispatcher.js');
const { TaskRegistryStore } = require('../src/core/TaskRegistryStore.js');
const { DEFAULT_PRESET_TIERS } = require('../src/priority/PriorityChainEngine.js');
const { DesktopServer } = require('../src/ui/desktop/server.js');

async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function ownedTask(overrides = {}) {
  const task = {
    id: 'manager-demo-1',
    registryTaskKey: 'manager-demo',
    managerOwnerChatId: 'manager-owner',
    targetFiles: ['src/one.js'],
    allowedTools: ['read_file', 'write_file']
  };
  const record = {
    taskKey: 'manager-demo',
    ownerChatId: 'manager-owner',
    status: 'claimed',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    leasePaths: ['src/one.js'],
    executionProgress: [{ id: 'manager-demo-1', status: 'queued' }],
    execution: {
      kind: 'executor-plan',
      tasks: [{ files: ['src/one.js'], allowedTools: ['read_file', 'write_file'] }]
    }
  };
  return { task: { ...task, ...overrides.task }, record: { ...record, ...overrides.record } };
}

test('path-scoped concurrency requires an active owner and an exact safe child plan', () => {
  const { task, record } = ownedTask();
  assert.equal(hasPathScopedOwnership(task, record), true);
  assert.equal(hasPathScopedOwnership({ ...task, allowedTools: ['read_file', 'exec_command'] }, record), false);
  assert.equal(hasPathScopedOwnership({ ...task, targetFiles: ['src/other.js'] }, record), false);
  assert.equal(hasPathScopedOwnership(task, { ...record, ownerChatId: 'other-owner' }), false);
  assert.equal(hasPathScopedOwnership(task, { ...record, leaseExpiresAt: new Date(0).toISOString() }), false);
  assert.equal(hasPathScopedOwnership(task, {
    ...record,
    executionProgress: [{ id: 'manager-demo-1', status: 'completed' }]
  }), false);
  assert.equal(hasPathScopedOwnership(task, { ...record, leasePaths: ['src/two.js'] }), false);
  assert.equal(hasPathScopedOwnership({ ...task, targetFiles: ['.'] }, record), false);
  assert.equal(hasPathScopedOwnership({ ...task, id: 'manager-demo-3' }, record), false);
});

test('only verified path-scoped executor turns bypass the workspace-wide lease', async () => {
  let leaseCalls = 0;
  const engine = Object.create(AgentEngine.prototype);
  engine.workspaceDir = '/workspace';
  engine.currentSession = { sessionId: 'ses_0123456789abcdef' };
  engine._ensureAccountRouterTier = async () => {};
  engine._executeTurn = async () => 'executed';
  engine.workspaceExecutionLease = {
    run: async (_workspace, _owner, execute) => {
      leaseCalls++;
      return execute();
    }
  };

  const validContext = {
    executorMode: true,
    pathScopedConcurrency: true,
    taskOwnershipContext: { origin: 'only-chat-internal', allowedPaths: ['src/one.js'] }
  };
  assert.equal(await engine.executeTurn('scoped work', validContext), 'executed');
  assert.equal(leaseCalls, 0);
  assert.equal(await engine.executeTurn('ordinary work', { ...validContext, executorMode: false }), 'executed');
  assert.equal(leaseCalls, 1);
  assert.equal(await engine.executeTurn('empty scope', {
    ...validContext,
    taskOwnershipContext: { origin: 'only-chat-internal', allowedPaths: [] }
  }), 'executed');
  assert.equal(leaseCalls, 2);
});

test('registry-owned disjoint child tasks write concurrently through their exact scopes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-path-parallel-'));
  const repo = path.join(root, 'repo');
  const dataDir = root;
  let engine;
  let releaseProviderBarrier;
  let providerStarts = 0;
  let notifyBothProviders;
  let completedCount = 0;
  let notifyBothCompleted;
  const bothProvidersStarted = new Promise(resolve => { notifyBothProviders = resolve; });
  const providerBarrier = new Promise(resolve => { releaseProviderBarrier = resolve; });
  const bothCompleted = new Promise(resolve => { notifyBothCompleted = resolve; });
  try {
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Only Chat Test'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'onlychat-test@example.invalid'], { cwd: repo, stdio: 'ignore' });
    fs.writeFileSync(path.join(repo, 'alpha.txt'), 'before alpha');
    fs.writeFileSync(path.join(repo, 'beta.txt'), 'before beta');
    execFileSync('git', ['add', 'alpha.txt', 'beta.txt'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'test baseline'], { cwd: repo, stdio: 'ignore' });
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const registry = new TaskRegistryStore({ dataDir: path.join(root, 'registry') });
    const providerAdapter = async (_tier, history) => {
      if (history.some(item => item.role === 'tool')) return { content: 'write confirmed', toolCalls: [] };
      const prompt = [...history].reverse().find(item => item.role === 'user')?.content || '';
      const file = String(prompt).includes('beta') ? 'beta.txt' : 'alpha.txt';
      if (++providerStarts === 2) notifyBothProviders();
      await providerBarrier;
      return {
        content: '',
        toolCalls: [{ id: `write-${file}`, name: 'write_file', args: { path: file, content: `written ${file}` } }]
      };
    };
    engine = new AgentEngine({
      isolated: true,
      dataDir,
      workspaceDir: repo,
      taskRegistryStore: registry,
      dispatcherAutoStart: false,
      watchSkills: false,
      approvalPolicy: 'never',
      providerAdapter,
      isTierReady: () => true
    });
    engine.priorityChain.setTiers([DEFAULT_PRESET_TIERS[0]]);
    engine._getDispatcherAllowedProviderIds = async () => [DEFAULT_PRESET_TIERS[0].id];
    engine.dispatcher.getMemoryMetrics = () => ({ allowedWorkers: 2 });
    const ownerChatId = engine.initSession({ title: 'parallel owner' }).sessionId;
    const execution = {
      kind: 'executor-plan',
      summary: 'Write two independent fixtures',
      tasks: [
        { title: 'Write alpha', prompt: 'Write alpha fixture.', files: ['alpha.txt'], allowedTools: ['write_file'] },
        { title: 'Write beta', prompt: 'Write beta fixture.', files: ['beta.txt'], allowedTools: ['write_file'] }
      ]
    };
    await registry.createTask({
      taskKey: 'manager-path-parallel',
      title: execution.summary,
      creatorChatId: ownerChatId,
      repositoryPath: repo,
      baseSha,
      paths: ['alpha.txt', 'beta.txt'],
      nextAction: 'Run two independent file slices.',
      idempotencyKey: 'create-manager-path-parallel',
      execution
    });
    const claimed = await registry.claimTask({
      taskKey: 'manager-path-parallel', ownerChatId, idempotencyKey: 'claim-manager-path-parallel'
    });
    assert.equal(claimed.accepted, true);
    engine.dispatcher.on('worker_completed', () => {
      if (++completedCount === 2) notifyBothCompleted();
    });
    const failed = new Promise((_, reject) => {
      for (const event of ['worker_blocked', 'worker_failed']) {
        engine.dispatcher.on(event, value => reject(new Error(value.reason || value.error || event)));
      }
    });
    engine.dispatcher.enqueueTasks(execution.tasks.map((task, index) => ({
      id: `manager-path-parallel-${index + 1}`,
      ...task,
      requireToolExecution: true
    })), { registryTaskKey: 'manager-path-parallel', managerOwnerChatId: ownerChatId });
    await Promise.race([
      withTimeout(bothProvidersStarted, 3000, 'disjoint workers did not enter the provider concurrently'),
      failed
    ]);
    releaseProviderBarrier();
    await Promise.race([
      withTimeout(bothCompleted, 5000, 'disjoint workers did not complete'),
      failed
    ]);
    await engine.managerProgressQueues.get('manager-path-parallel');
    assert.equal(fs.readFileSync(path.join(repo, 'alpha.txt'), 'utf8'), 'written alpha.txt');
    assert.equal(fs.readFileSync(path.join(repo, 'beta.txt'), 'utf8'), 'written beta.txt');
    assert.deepEqual(registry.getTask('manager-path-parallel').executionProgress.map(item => item.status), ['completed', 'completed']);
  } finally {
    releaseProviderBarrier?.();
    engine?.dispatcher.stop();
    engine?.skills.stopWatching();
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false, 'temporary repository and Only Chat data must be removed');
  }
});

test('dispatcher starts two disjoint manager workers concurrently when memory allows', async () => {
  const releases = new Map();
  let startedCount = 0;
  let completedCount = 0;
  let notifyStarted;
  let notifyCompleted;
  const bothStarted = new Promise(resolve => { notifyStarted = resolve; });
  const bothCompleted = new Promise(resolve => { notifyCompleted = resolve; });
  const dispatcher = new ParallelDispatcher({
    autoStart: false,
    maxGlobalConcurrency: 3,
    executeTask: task => new Promise(resolve => releases.set(task.id, resolve))
  });
  dispatcher.getMemoryMetrics = () => ({ allowedWorkers: 2 });
  dispatcher.on('worker_started', () => {
    if (++startedCount === 2) notifyStarted();
  });
  dispatcher.on('worker_completed', () => {
    if (++completedCount === 2) notifyCompleted();
  });
  try {
    dispatcher.enqueueTasks([
      { id: 'manager-demo-1', files: ['src/one.js'], allowedTools: ['write_file'], requireToolExecution: false },
      { id: 'manager-demo-2', files: ['src/two.js'], allowedTools: ['write_file'], requireToolExecution: false }
    ], { registryTaskKey: 'manager-demo', managerOwnerChatId: 'manager-owner' });
    let timeout;
    try {
      await Promise.race([
        bothStarted,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('workers did not start together')), 2000);
        })
      ]);
    } finally {
      clearTimeout(timeout);
    }
    assert.equal(dispatcher.activeWorkers.size, 2);
    releases.get('manager-demo-1')({ status: 'completed', result: 'one done' });
    releases.get('manager-demo-2')({ status: 'completed', result: 'two done' });
    await bothCompleted;
  } finally {
    for (const release of releases.values()) release({ status: 'blocked', reason: 'test cleanup' });
    dispatcher.stop();
  }
});

test('server keeps the dispatcher closed for interactive turns, not background worker turns', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-dispatch-gate-'));
  let app;
  try {
    app = new DesktopServer({
      isolated: true,
      dataDir,
      workspaceDir: path.join(dataDir, 'workspace'),
      port: 0,
      enableQuotaRefresh: false
    });
    app.activeTurns = 2;
    app.interactiveTurns = 0;
    assert.equal(app.engine.dispatcher.canStartTask(), true);
    app.interactiveTurns = 1;
    assert.equal(app.engine.dispatcher.canStartTask(), false);
  } finally {
    app?.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
