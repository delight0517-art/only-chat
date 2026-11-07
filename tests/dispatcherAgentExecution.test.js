'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { DesktopServer } = require('../src/ui/desktop/server.js');
const { DEFAULT_PRESET_TIERS } = require('../src/priority/PriorityChainEngine.js');

function request(port, pathname, method = 'GET', body) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {})
      }
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch (_) {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('dispatcher HTTP route runs an isolated AgentEngine task and reports its result', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-dispatch-e2e-'));
  let releaseProvider;
  let notifyProviderStarted;
  const providerStarted = new Promise(resolve => { notifyProviderStarted = resolve; });
  let providerCalls = 0;
  let app;
  try {
    app = new DesktopServer({
      isolated: true,
      approvalPolicy: 'on-request',
      dataDir,
      workspaceDir: path.join(dataDir, 'workspace'),
      port: 0,
      enableQuotaRefresh: false,
      providerAdapter: async () => {
        providerCalls += 1;
        notifyProviderStarted();
        await new Promise(resolve => { releaseProvider = resolve; });
        return { content: 'synthetic agent completed the feedback task', toolCalls: [] };
      }
    });
    app.engine.priorityChain.setTiers([DEFAULT_PRESET_TIERS[0]]);
    const activeSession = app.engine.initSession({ title: 'existing chat' });
    app.engine.conversationHistory = [{ role: 'user', content: 'existing chat context' }];
    app.engine.handoff.saveCheckpoint({ sessionId: activeSession.sessionId, lastPrompt: 'keep this checkpoint' });
    const previousCheckpoint = app.engine.handoff.loadCheckpoint();
    app.engine.dispatcher.getMemoryMetrics = () => ({ allowedWorkers: 1 });
    await app.start();

    const started = new Promise(resolve => app.engine.dispatcher.once('worker_started', resolve));
    const blocked = new Promise(resolve => app.engine.dispatcher.once('worker_blocked', resolve));
    const missingAllowlist = await request(app.port, '/api/dispatcher/enqueue', 'POST', {
      id: 'forai-feedback-missing-tools', title: 'Missing tool policy', prompt: 'Do work.'
    });
    assert.equal(missingAllowlist.status, 400);
    assert.equal(app.engine.dispatcher.getSnapshot().queue.length, 0, 'missing tool policy must not enqueue a task');
    const invalidAllowlist = await request(app.port, '/api/dispatcher/enqueue', 'POST', {
      id: 'forai-feedback-invalid-tools', title: 'Invalid tool policy', prompt: 'Do work.', allowedTools: ['read_file', '../exec_command']
    });
    assert.equal(invalidAllowlist.status, 400);
    assert.equal(app.engine.dispatcher.getSnapshot().queue.length, 0, 'invalid tool policy must not enqueue a task');
    const accepted = await request(app.port, '/api/dispatcher/enqueue', 'POST', {
      id: 'forai-feedback-e2e',
      title: 'For AI feedback execution check',
      prompt: 'Process the synthetic feedback and return the result.',
      allowedTools: ['read_file'],
      requireToolExecution: false
    });
    assert.equal(accepted.status, 200);
    assert.ok(['queued', 'running'].includes(accepted.body.enqueued[0].status));

    await started;
    await providerStarted;
    assert.equal(app.activeTurns, 1, 'dispatcher execution must hold the shared workspace activity guard');
    const rejectedConcurrentTurn = await request(app.port, '/api/turn', 'POST', {
      prompt: 'do not overlap this chat turn',
      reasoningEffort: 'low'
    });
    assert.equal(rejectedConcurrentTurn.status, 409);
    assert.match(rejectedConcurrentTurn.body.error, /다른 작업을 실행 중/);

    releaseProvider();
    await blocked;
    const snapshot = await request(app.port, '/api/dispatcher');
    assert.equal(snapshot.status, 200);
    const task = snapshot.body.terminalTasks.find(item => item.id === 'forai-feedback-e2e');
    assert.equal(task.status, 'blocked');
    assert.equal(task.result, 'synthetic agent completed the feedback task');
    assert.match(task.blockReason, /도구 실행/);
    assert.equal(task.executionEvidence.attemptedCount, 0);
    assert.equal(task.executionEvidence.successfulCount, 0);
    assert.equal(snapshot.body.completedTasks.some(item => item.id === 'forai-feedback-e2e'), false);
    assert.ok(task.sessionId);
    assert.notEqual(task.sessionId, activeSession.sessionId);
    assert.equal(providerCalls, 1);
    assert.equal(app.activeTurns, 0);
    assert.deepEqual(app.engine.conversationHistory, [{ role: 'user', content: 'existing chat context' }]);
    assert.equal(app.engine.currentSession.sessionId, activeSession.sessionId);
    assert.deepEqual(app.engine.handoff.loadCheckpoint(), previousCheckpoint);
  } finally {
    releaseProvider?.();
    if (app) app.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('dispatcher falls back after an empty provider response before requiring a real workspace tool call', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-dispatch-tool-e2e-'));
  let providerCalls = 0;
  let app;
  try {
    app = new DesktopServer({
      isolated: true,
      approvalPolicy: 'on-request',
      dataDir,
      workspaceDir: path.join(dataDir, 'workspace'),
      port: 0,
      enableQuotaRefresh: false,
      providerAdapter: async () => {
        providerCalls += 1;
        if (providerCalls === 1) {
          return { content: '', toolCalls: [] };
        }
        if (providerCalls === 2) {
          return { content: '', toolCalls: [{ id: 'read-fixture', name: 'read_file', args: { path: 'todo-fixture.txt' } }] };
        }
        return { content: 'TODO fixture read successfully.', toolCalls: [] };
      }
    });
    fs.mkdirSync(app.engine.workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(app.engine.workspaceDir, 'todo-fixture.txt'), 'fixture for the Only Chat dispatcher');
    const fallbackTier = { ...DEFAULT_PRESET_TIERS[0], id: 'antigravity-fallback', tier: 2 };
    app.engine.priorityChain.setTiers([DEFAULT_PRESET_TIERS[0], fallbackTier]);
    app.engine.dispatcher.getMemoryMetrics = () => ({ allowedWorkers: 1 });
    await app.start();

    const completed = new Promise(resolve => {
      for (const eventName of ['worker_completed', 'worker_blocked', 'worker_failed']) {
        app.engine.dispatcher.once(eventName, value => resolve({ eventName, value }));
      }
    });
    const accepted = await request(app.port, '/api/dispatcher/enqueue', 'POST', {
      id: 'tool-backed-todo-e2e',
      title: 'Tool-backed TODO execution',
      prompt: 'Read todo-fixture.txt in the active workspace and report that it was read.',
      allowedTools: ['read_file']
    });
    assert.equal(accepted.status, 200);
    const outcome = await completed;
    const observedToolResults = outcome.value?.task?.sessionId
      ? app.engine.sessions.readSession(outcome.value.task.sessionId)
        .filter(item => item.type === 'tool_result')
        .map(item => ({ tool: item.tool, error: item.result?.error || null, blocked: item.result?.blocked === true }))
      : [];
    assert.equal(outcome.eventName, 'worker_completed', JSON.stringify({
      reason: outcome.value?.reason || outcome.value?.error || null,
      executionEvidence: outcome.value?.task?.executionEvidence || null,
      toolResults: observedToolResults
    }));

    const snapshot = await request(app.port, '/api/dispatcher');
    const task = snapshot.body.completedTasks.find(item => item.id === 'tool-backed-todo-e2e');
    assert.equal(task.status, 'completed');
    assert.equal(task.result, 'TODO fixture read successfully.');
    assert.equal(task.executionEvidence.attemptedCount, 1);
    assert.equal(task.executionEvidence.successfulCount, 1);
    assert.equal(task.executionEvidence.failedCount, 0);
    assert.deepEqual(task.executionEvidence.toolNames, ['read_file']);
    assert.deepEqual(task.allowedTools, ['read_file']);
    assert.equal(providerCalls, 3, 'an empty first-tier response must fall back, then the provider must receive the tool result');
    assert.equal(task.executionEvidence.provider, fallbackTier.provider);
    assert.equal(task.executionEvidence.tierId, fallbackTier.id);
    const records = app.engine.sessions.readSession(task.sessionId);
    assert.ok(records.some(item => item.type === 'tool_result' && item.tool === 'read_file'));
    assert.equal(JSON.stringify(records.filter(item => item.type === 'session_metadata')).includes('fixture for the Only Chat dispatcher'), false);
  } finally {
    if (app) app.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('dispatcher task allowlist blocks disallowed tools before approval and runner dispatch', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-dispatch-allowlist-'));
  let providerCalls = 0;
  let commandCalls = 0;
  let approvalCalls = 0;
  let app;
  try {
    app = new DesktopServer({
      isolated: true,
      approvalPolicy: 'on-request',
      dataDir,
      workspaceDir: path.join(dataDir, 'workspace'),
      port: 0,
      enableQuotaRefresh: false,
      commandRunner: async () => { commandCalls++; return { exitCode: 0, stdout: 'should not run' }; },
      providerAdapter: async () => {
        providerCalls++;
        return providerCalls === 1
          ? { content: '', toolCalls: [{ id: 'disallowed-command', name: 'exec_command', args: { command: 'printf should-not-run' } }] }
          : { content: 'The disallowed command was refused.', toolCalls: [] };
      }
    });
    app.engine.priorityChain.setTiers([DEFAULT_PRESET_TIERS[0]]);
    app.engine.tools.approvalPolicy = 'on-request';
    app.engine.dispatcherApprovalHandler = async () => { approvalCalls++; return true; };
    app.engine.dispatcher.getMemoryMetrics = () => ({ allowedWorkers: 1 });
    await app.start();

    const blocked = new Promise(resolve => app.engine.dispatcher.once('worker_blocked', resolve));
    const accepted = await request(app.port, '/api/dispatcher/enqueue', 'POST', {
      id: 'allowlist-e2e',
      title: 'Per-task allowlist enforcement',
      prompt: 'Use read_file only.',
      allowedTools: ['read_file']
    });
    assert.equal(accepted.status, 200);
    const outcome = await blocked;
    assert.match(outcome.reason, /작업 허용 목록 밖의 제공자 도구 이벤트가 감지되어 완료를 차단했습니다/);
    assert.equal(approvalCalls, 0, 'a disallowed tool must not open an approval request');
    assert.equal(commandCalls, 0, 'a disallowed exec_command must not reach the injected runner');
    const task = (await request(app.port, '/api/dispatcher')).body.terminalTasks.find(item => item.id === 'allowlist-e2e');
    assert.equal(task.status, 'blocked');
    assert.deepEqual(task.allowedTools, ['read_file']);
    assert.deepEqual(task.executionEvidence.toolNames, ['exec_command']);
    assert.equal(task.executionEvidence.attemptedCount, 1);
    assert.equal(task.executionEvidence.successfulCount, 0);
    assert.equal(task.executionEvidence.failedCount, 1);
    assert.ok(app.engine.sessions.readSession(task.sessionId).some(item => item.type === 'tool_result' && item.tool === 'exec_command' && item.result?.blocked === true));
  } finally {
    if (app) app.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('dispatcher waits for session-bound UI approval before executing a tool', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-dispatch-approval-'));
  let providerCalls = 0;
  let commandCalls = 0;
  let app;
  try {
    app = new DesktopServer({
      isolated: true,
      approvalPolicy: 'on-request',
      dataDir,
      workspaceDir: path.join(dataDir, 'workspace'),
      port: 0,
      enableQuotaRefresh: false,
      commandRunner: async command => { commandCalls++; return { exitCode: 0, stdout: command }; },
      providerAdapter: async () => {
        providerCalls++;
        return providerCalls === 1
          ? { content: '', toolCalls: [{ id: 'approved-command', name: 'exec_command', args: { command: 'printf approved' } }] }
          : { content: 'Tool result received.', toolCalls: [] };
      }
    });
    app.engine.priorityChain.setTiers([DEFAULT_PRESET_TIERS[0]]);
    app.engine.dispatcher.getMemoryMetrics = () => ({ allowedWorkers: 1 });
    await app.start();
    const approvalVisible = new Promise(resolve => app.engine.dispatcher.on('queue_updated', () => {
      const task = app.engine.dispatcher.activeWorkers.get('approval-e2e')?.task;
      if (task?.pendingApproval) resolve(task.pendingApproval);
    }));
    const completed = new Promise(resolve => app.engine.dispatcher.once('worker_completed', resolve));
    const accepted = await request(app.port, '/api/dispatcher/enqueue', 'POST', {
      id: 'approval-e2e', title: 'Approval test', prompt: 'Run the requested safe command.', allowedTools: ['exec_command']
    });
    assert.equal(accepted.status, 200);
    const approval = await approvalVisible;
    assert.equal(commandCalls, 0, 'command must remain undispatched while approval is pending');
    assert.equal(approval.name, 'exec_command');
    assert.equal(approval.args.command, 'printf approved');
    const stale = await request(app.port, '/api/dispatcher/approval', 'POST', {
      taskId: 'approval-e2e', requestId: approval.requestId, sessionId: 'wrong-session', decision: 'approve'
    });
    assert.equal(stale.status, 409);
    const approved = await request(app.port, '/api/dispatcher/approval', 'POST', {
      taskId: 'approval-e2e', requestId: approval.requestId, sessionId: approval.sessionId, decision: 'approve'
    });
    assert.equal(approved.status, 200);
    const replayed = await request(app.port, '/api/dispatcher/approval', 'POST', {
      taskId: 'approval-e2e', requestId: approval.requestId, sessionId: approval.sessionId, decision: 'approve'
    });
    assert.equal(replayed.status, 409, 'an approval request must be one-shot');
    await completed;
    assert.equal(commandCalls, 1);
    const snapshot = await request(app.port, '/api/dispatcher');
    const task = snapshot.body.completedTasks.find(item => item.id === 'approval-e2e');
    assert.equal(task.status, 'completed');
    assert.equal(task.executionEvidence.successfulCount, 1);
    assert.equal(task.pendingApproval, null);
  } finally {
    if (app) app.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('rejecting dispatcher approval leaves the tool unexecuted and task blocked', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-dispatch-reject-'));
  let providerCalls = 0;
  let commandCalls = 0;
  let app;
  try {
    app = new DesktopServer({
      isolated: true,
      approvalPolicy: 'on-request',
      dataDir,
      workspaceDir: path.join(dataDir, 'workspace'),
      port: 0,
      enableQuotaRefresh: false,
      commandRunner: async () => { commandCalls++; return { exitCode: 0 }; },
      providerAdapter: async () => {
        providerCalls++;
        return providerCalls === 1
          ? { content: '', toolCalls: [{ id: 'rejected-command', name: 'exec_command', args: { command: 'safe command' } }] }
          : { content: 'Approval was declined.', toolCalls: [] };
      }
    });
    app.engine.priorityChain.setTiers([DEFAULT_PRESET_TIERS[0]]);
    app.engine.dispatcher.getMemoryMetrics = () => ({ allowedWorkers: 1 });
    await app.start();
    const approvalVisible = new Promise(resolve => app.engine.dispatcher.on('queue_updated', () => {
      const task = app.engine.dispatcher.activeWorkers.get('reject-e2e')?.task;
      if (task?.pendingApproval) resolve(task.pendingApproval);
    }));
    const blocked = new Promise(resolve => app.engine.dispatcher.once('worker_blocked', resolve));
    const accepted = await request(app.port, '/api/dispatcher/enqueue', 'POST', {
      id: 'reject-e2e', title: 'Approval rejection test', prompt: 'Run a command only if approved.', allowedTools: ['exec_command']
    });
    assert.equal(accepted.status, 200);
    const approval = await approvalVisible;
    const rejected = await request(app.port, '/api/dispatcher/approval', 'POST', {
      taskId: 'reject-e2e', requestId: approval.requestId, sessionId: approval.sessionId, decision: 'reject'
    });
    assert.equal(rejected.status, 200);
    const outcome = await blocked;
    assert.match(outcome.reason, /사용자가 도구 실행을 거절해 작업을 차단/);
    assert.equal(commandCalls, 0);
  } finally {
    if (app) app.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('dispatcher provides a sanitized live priority snapshot to every task', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-dispatch-priority-context-'));
  let providerCalls = 0;
  let receivedPrompt = '';
  let app;
  try {
    app = new DesktopServer({
      isolated: true,
      approvalPolicy: 'on-request',
      dataDir,
      workspaceDir: path.join(dataDir, 'workspace'),
      port: 0,
      enableQuotaRefresh: false,
      providerAdapter: async (tier, history) => {
        providerCalls += 1;
        const promptEntry = history.find(item => item.role === 'user' && item.content?.includes('Only Chat trusted runtime priority snapshot'));
        if (promptEntry) receivedPrompt = JSON.stringify([promptEntry]);
        if (providerCalls === 1) return { content: '', toolCalls: [{ id: 'read-fixture', name: 'read_file', args: { path: 'todo-fixture.txt' } }] };
        return { content: 'Priority snapshot was checked.' };
      }
    });
    fs.mkdirSync(app.engine.workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(app.engine.workspaceDir, 'todo-fixture.txt'), 'read-only fixture');
    const tiers = [
      { ...DEFAULT_PRESET_TIERS[0], id: 'tier-one', tier: 1, email: 'private@example.com' },
      { ...DEFAULT_PRESET_TIERS[1], id: 'tier-two', tier: 2, email: 'secret2@example.com' },
      { ...DEFAULT_PRESET_TIERS[2], id: 'tier-three', tier: 3, email: 'secret3@example.com' }
    ];
    app.engine.priorityChain.setTiers(tiers);
    app.engine.priorityChain.isTierReady = tier => tier.id !== 'tier-two';
    app.engine.priorityChain.updateTierQuota('tier-one', 0);
    app.engine.dispatcher.getMemoryMetrics = () => ({ allowedWorkers: 1 });
    await app.start();

    const completed = new Promise(resolve => {
      for (const eventName of ['worker_completed', 'worker_blocked', 'worker_failed']) {
        app.engine.dispatcher.once(eventName, value => resolve({ eventName, value }));
      }
    });
    const accepted = await request(app.port, '/api/dispatcher/enqueue', 'POST', {
      id: 'priority-context-e2e',
      title: 'Priority runtime context',
      prompt: 'Read todo-fixture.txt and explain the active priority tier.',
      allowedTools: ['read_file']
    });
    assert.equal(accepted.status, 200);
    const outcome = await completed;
    assert.equal(outcome.eventName, 'worker_completed', JSON.stringify(outcome.value));

    const userPrompt = JSON.parse(receivedPrompt).findLast(item => item.role === 'user')?.content || '';
    assert.match(userPrompt, /Only Chat trusted runtime priority snapshot/, `provider prompt lacked status context: history=${receivedPrompt}`);
    const snapshot = JSON.parse(userPrompt.split('[Only Chat trusted runtime priority snapshot]\n')[1]);
    assert.equal(snapshot.activeTierId, 'tier-three');
    assert.equal(snapshot.tiers[0].remainingPercent, 0);
    assert.equal(snapshot.tiers[1].connected, false);
    assert.equal(snapshot.tiers[2].active, true);
    assert.doesNotMatch(userPrompt, /private@example\.com|secret2@example\.com|secret3@example\.com/);
    assert.equal(outcome.value.task.executionEvidence.successfulCount, 1);
  } finally {
    if (app) app.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
