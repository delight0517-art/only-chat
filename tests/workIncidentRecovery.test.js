'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { WorkspaceExecutionLease } = require('../src/core/WorkspaceExecutionLease');
const { workspaceRecovery } = require('../src/core/CoordinationRecovery');
const { ParallelDispatcher } = require('../src/core/ParallelDispatcher');
const { DesktopServer } = require('../src/ui/desktop/server');
const { AgentEngine } = require('../src/core/AgentEngine');
const { TaskRegistryStore } = require('../src/core/TaskRegistryStore');
const { DEFAULT_PRESET_TIERS } = require('../src/priority/PriorityChainEngine');

const emptyEvidence = () => ({ attemptedCount: 0, successfulCount: 0, failedCount: 0, allowedToolViolationCount: 0 });
function incident(lease, workspace) {
  const error = Object.assign(new Error('busy'), { code: 'WORKSPACE_BUSY', retryable: true, evidence: lease.getEvidence(workspace) });
  const evidence = emptyEvidence();
  return { status: 'blocked', reason: 'same workspace occupied', executionEvidence: evidence,
    recovery: workspaceRecovery(error, evidence, lease._workspaceKey(workspace)) };
}
function event(emitter, names, id) {
  return new Promise((resolve, reject) => {
    const handlers = new Map();
    const clean = () => { clearTimeout(timer); for (const [name, handler] of handlers) emitter.off(name, handler); };
    const timer = setTimeout(() => { clean(); reject(new Error(`event timeout: ${names}`)); }, 5000);
    for (const name of names) {
      const handler = value => { if (id && value.task?.id !== id) return; clean(); resolve({ name, ...value }); };
      handlers.set(name, handler); emitter.on(name, handler);
    }
  });
}
async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-incident-'));
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    await run({ root, workspace });
  } finally { fs.rmSync(root, { recursive: true, force: true }); assert.equal(fs.existsSync(root), false); }
}

test('only a typed same-resource pre-tool incident authorizes recovery', async () => fixture(async ({ root, workspace }) => {
  const lease = new WorkspaceExecutionLease({ lockRoot: path.join(root, 'locks') });
  const error = Object.assign(new Error('busy'), { code: 'WORKSPACE_BUSY', retryable: true, evidence: lease.getEvidence(workspace) });
  assert.ok(workspaceRecovery(error, emptyEvidence(), lease._workspaceKey(workspace)));
  assert.equal(workspaceRecovery(error, emptyEvidence(), lease._workspaceKey(path.join(root, 'M-Oasis'))), null);
  assert.equal(workspaceRecovery(error, { ...emptyEvidence(), attemptedCount: 1 }, lease._workspaceKey(workspace)), null);
  assert.equal(workspaceRecovery({ ...error, code: 'AUTH_REQUIRED' }, emptyEvidence(), lease._workspaceKey(workspace)), null);
  assert.equal(workspaceRecovery({ ...error, evidence: { ...error.evidence, state: 'held', sameHost: false } }, emptyEvidence(), lease._workspaceKey(workspace)), null);
}));

test('a blocked worker frees the slot, independent work runs, then the original work actually executes once', async () => fixture(async ({ root, workspace }) => {
  const lease = new WorkspaceExecutionLease({ lockRoot: path.join(root, 'locks') });
  let release;
  const holding = lease.run(workspace, 'holder', () => new Promise(resolve => { release = resolve; }));
  const output = path.join(root, 'result.txt');
  const executionOrder = [];
  const dispatcher = new ParallelDispatcher({ autoStart: false, maxGlobalConcurrency: 1,
    recoverTask: (_task, _result, options) => lease.waitUntilAvailable(workspace, { ...options, waitMs: 1000 }),
    executeTask: async task => {
      if (task.id === 'independent') { executionOrder.push(task.id); release(); return { status: 'completed' }; }
      try {
        return await lease.run(workspace, 'resume', async () => {
          executionOrder.push(task.id); fs.appendFileSync(output, 'executed once\n'); return { status: 'completed' };
        });
      } catch (error) { return { status: 'blocked', reason: error.message, executionEvidence: emptyEvidence(), recovery: workspaceRecovery(error, emptyEvidence(), lease._workspaceKey(workspace)) }; }
    }
  });
  dispatcher.getMemoryMetrics = () => ({ allowedWorkers: 1 });
  try {
    const completed = event(dispatcher, ['worker_completed', 'worker_blocked', 'worker_failed'], 'original');
    dispatcher.enqueueTasks(['original', 'independent'].map(id => ({ id, prompt: id, files: ['result.txt'], allowedTools: ['read_file'], requireToolExecution: false })));
    const result = await completed;
    assert.equal(result.name, 'worker_completed');
    assert.deepEqual(executionOrder, ['independent', 'original']);
    assert.equal(fs.readFileSync(output, 'utf8'), 'executed once\n');
    assert.equal(dispatcher.terminalTasks.length, 0);
    assert.equal(result.task.recoveryAttempts, 1);
  } finally { release(); await holding; dispatcher.stop(); }
}));

test('actual AgentEngine resumes a real read tool and persists diagnosis/plan instead of terminally blocking the manager', async () => fixture(async ({ root, workspace }) => {
  const dataDir = root;
  const registry = new TaskRegistryStore({ dataDir });
  const execution = { kind: 'executor-plan', summary: 'Recover original read', tasks: [
    { title: 'Read proof', prompt: 'Read proof.txt and report the actual content.', files: ['proof.txt'], allowedTools: ['read_file'] }
  ] };
  await registry.createTask({ taskKey: 'incident-read', title: 'Incident read', creatorChatId: 'creator', repositoryPath: workspace,
    baseSha: 'a'.repeat(40), paths: ['proof.txt'], execution, nextAction: 'Read proof', idempotencyKey: 'create-read' });
  await registry.claimTask({ taskKey: 'incident-read', ownerChatId: 'creator', idempotencyKey: 'claim-read' });
  fs.writeFileSync(path.join(workspace, 'proof.txt'), 'actual recovered tool result');
  let calls = 0;
  let system = '';
  const app = new DesktopServer({ isolated: true, dataDir, workspaceDir: workspace, port: 0, enableQuotaRefresh: false,
    taskRegistryStore: registry, workspaceLeaseWaitMs: 10, workspaceRecoveryWaitMs: 1000,
    providerAdapter: async (_tier, history) => {
      calls++;
      system = history.filter(item => item.role === 'system').map(item => item.content).join('\n');
      return history.some(item => item.role === 'tool')
        ? { content: 'Verified actual recovered tool result.' }
        : { content: '', toolCalls: [{ id: 'proof-read', name: 'read_file', args: { path: 'proof.txt' } }] };
    } });
  app.engine.priorityChain.setTiers([DEFAULT_PRESET_TIERS[0]]);
  app.engine.dispatcher.getMemoryMetrics = () => ({ allowedWorkers: 1 });
  const parent = app.engine.initSession({ title: 'existing parent session' });
  app.engine.conversationHistory = [{ role: 'user', content: 'preserve parent conversation' }];
  const holder = new WorkspaceExecutionLease({ lockRoot: path.join(dataDir, 'workspace-leases') });
  let release;
  const holding = holder.run(workspace, 'live-owner', () => new Promise(resolve => { release = resolve; }));
  try {
    await app.start();
    const waiting = event(app.engine.dispatcher, ['worker_waiting'], 'incident-read-1');
    const completed = event(app.engine.dispatcher, ['worker_completed', 'worker_blocked', 'worker_failed'], 'incident-read-1');
    app.engine.dispatcher.enqueueTasks([{ id: 'incident-read-1', ...execution.tasks[0] }], {
      registryTaskKey: 'incident-read', managerOwnerChatId: 'creator'
    });
    const wait = await waiting;
    await app.engine.managerProgressQueues.get('incident-read');
    assert.equal(calls, 0, 'no provider/tool replay before verified lease release');
    assert.equal(app.activeTurns, 0, 'waiting does not keep the global activity guard occupied');
    const saved = new TaskRegistryStore({ dataDir }).getTask('incident-read');
    assert.equal(saved.status, 'executing');
    assert.match(saved.checkpoint.nextAction, /소유권.*확인.*재개/);
    assert.ok(app.engine.sessions.readSession(wait.task.sessionId).some(item => item.metadata?.workIncident?.phase === 'waiting'));
    const snapshot = await fetch(`http://127.0.0.1:${app.port}/api/dispatcher`).then(response => response.json());
    assert.equal(snapshot.recovery.version, 1);
    assert.equal(snapshot.recovery.waitingCount, 1);
    const otherWorkspace = path.join(root, 'other-workspace');
    fs.mkdirSync(otherWorkspace);
    app.engine.workspaceDir = otherWorkspace;
    release(); await holding;
    const done = await completed;
    await app.engine.managerProgressQueues.get('incident-read');
    assert.equal(done.name, 'worker_completed', done.task.blockReason || done.task.error);
    assert.equal(done.task.executionEvidence.successfulCount, 1);
    assert.match(system, /작업이 막히면 먼저 실패 사건을 진단/);
    assert.equal(system.includes('[object Object]'), false);
    assert.equal(registry.getTask('incident-read').status, 'verifying');
    assert.equal(registry.getTask('incident-read').executionProgress[0].status, 'completed');
    assert.equal(app.activeTurns, 0);
    assert.equal(app.engine.currentSession.sessionId, parent.sessionId);
    assert.deepEqual(app.engine.conversationHistory, [{ role: 'user', content: 'preserve parent conversation' }]);
  } finally { release(); await holding; app.stop(); }
}));

test('recovery is bounded and never retries a task after any tool attempt', async () => fixture(async ({ root, workspace }) => {
  const lease = new WorkspaceExecutionLease({ lockRoot: path.join(root, 'locks') });
  for (const toolAttempts of [0, 1]) {
    let calls = 0;
    const dispatcher = new ParallelDispatcher({ autoStart: false,
      executeTask: async () => { calls++; const value = incident(lease, workspace); value.executionEvidence.attemptedCount = toolAttempts; return value; },
      recoverTask: async () => ({ ready: true, evidence: lease.getEvidence(workspace) }) });
    dispatcher.getMemoryMetrics = () => ({ allowedWorkers: 1 });
    try {
      const terminal = event(dispatcher, ['worker_blocked']);
      dispatcher.enqueueTasks([{ id: 'bounded', prompt: 'original scope', allowedTools: ['read_file'] }]);
      const result = await terminal;
      assert.equal(calls, toolAttempts ? 1 : 3);
      assert.equal(result.task.prompt, 'original scope');
      assert.deepEqual(result.task.allowedTools, ['read_file']);
    } finally { dispatcher.stop(); }
  }
}));

test('stopping a live recovery cancels it and cannot launch the deferred work later', async () => fixture(async ({ root, workspace }) => {
  const lease = new WorkspaceExecutionLease({ lockRoot: path.join(root, 'locks') });
  let release;
  const holding = lease.run(workspace, 'holder', () => new Promise(resolve => { release = resolve; }));
  let calls = 0;
  const dispatcher = new ParallelDispatcher({ autoStart: false,
    executeTask: async () => { calls++; return incident(lease, workspace); },
    recoverTask: (_task, _result, options) => lease.waitUntilAvailable(workspace, { ...options, waitMs: 1000 }) });
  dispatcher.getMemoryMetrics = () => ({ allowedWorkers: 1 });
  try {
    const waiting = event(dispatcher, ['worker_waiting']);
    const terminal = event(dispatcher, ['worker_blocked']);
    dispatcher.enqueueTasks([{ id: 'cancelled', prompt: 'do not replay', allowedTools: ['read_file'] }]);
    await waiting; dispatcher.stop();
    const result = await terminal;
    release(); await holding;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.match(result.reason, /취소/);
    assert.equal(dispatcher.recoveryControllers.size, 0);
  } finally { release(); await holding; dispatcher.stop(); }
}));

test('untrusted queue input cannot inject manager ownership metadata', async () => {
  const dispatcher = new ParallelDispatcher({ autoStart: false, canStartTask: () => false });
  dispatcher.getMemoryMetrics = () => ({ allowedWorkers: 1 });
  try {
    const [queued] = dispatcher.enqueueTasks([{ prompt: 'external request', allowedTools: ['read_file'], registryTaskKey: 'victim', managerOwnerChatId: 'other-owner' }]);
    assert.equal(queued.registryTaskKey, undefined);
    assert.equal(queued.managerOwnerChatId, undefined);
  } finally { dispatcher.stop(); }
});

test('an unconfirmed saved plan prevents replay even when the workspace is now free', async () => fixture(async ({ root, workspace }) => {
  const lease = new WorkspaceExecutionLease({ lockRoot: path.join(root, 'locks') });
  const engine = { dispatchedRecoveryWorkspaces: new Map([['t', workspace]]), workspaceExecutionLease: lease,
    managerProgressQueues: new Map([['t', Promise.resolve(null)]]) };
  const result = await AgentEngine.prototype._recoverDispatchedTask.call(engine,
    { id: 't' }, incident(lease, workspace));
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'recovery_checkpoint_unconfirmed');
  assert.equal(engine.dispatchedRecoveryWorkspaces.size, 0);
}));

test('a waiting task ending cannot release another running task activity guard', async () => fixture(async ({ root, workspace }) => {
  const app = new DesktopServer({ isolated: true, dataDir: root, workspaceDir: workspace, port: 0, enableQuotaRefresh: false });
  const dispatcher = app.engine.dispatcher;
  dispatcher.getMemoryMetrics = () => ({ allowedWorkers: 1 });
  const lease = new WorkspaceExecutionLease({ lockRoot: path.join(root, 'locks') });
  let endRecovery;
  let endIndependent;
  dispatcher.recoverTask = () => new Promise(resolve => { endRecovery = resolve; });
  dispatcher.executeTask = task => task.id === 'wait'
    ? Promise.resolve(incident(lease, workspace))
    : new Promise(resolve => { endIndependent = () => resolve({ status: 'completed' }); });
  try {
    const independentStarted = event(dispatcher, ['worker_started'], 'independent');
    const waitingEnded = event(dispatcher, ['worker_blocked'], 'wait');
    const independentEnded = event(dispatcher, ['worker_completed'], 'independent');
    dispatcher.enqueueTasks(['wait', 'independent'].map(id => ({ id, prompt: id, allowedTools: ['read_file'], requireToolExecution: false })));
    await independentStarted;
    assert.equal(app.activeTurns, 1);
    endRecovery({ ready: false, reason: 'owner_still_active' });
    await waitingEnded;
    assert.equal(app.activeTurns, 1, 'the independent active worker still owns its activity guard');
    endIndependent(); await independentEnded;
    assert.equal(app.activeTurns, 0);
  } finally { endRecovery?.({ ready: false }); endIndependent?.(); app.stop(); }
}));
