'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AgentEngine } = require('../src/core/AgentEngine.js');
const { DEFAULT_PRESET_TIERS } = require('../src/priority/PriorityChainEngine.js');

async function runTask({ content = 'response', toolCalls = [], allowedTools, requireToolExecution, failTool = false, toolResult, toolResults = [], skipToolStart = false, duplicateToolEnd = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-tool-evidence-'));
  const secret = 'credential-secret-should-not-persist';
  const engine = new AgentEngine({
    isolated: true,
    dataDir: root,
    workspaceDir: path.join(root, 'workspace'),
    dispatcherAutoStart: false,
    providerAdapter: async (_tier, _history, hooks) => {
      for (const [index, call] of toolCalls.entries()) {
        if (!skipToolStart) hooks.onToolStart?.(call);
        const result = toolResults[index] ?? toolResult ?? (failTool ? { error: secret, output: `sensitive output ${secret}` } : { ok: true, output: `sensitive output ${secret}` });
        hooks.onToolEnd?.({ call, result });
        if (duplicateToolEnd) hooks.onToolEnd?.({ call, result });
      }
      return { content, toolCalls: [] };
    }
  });
  engine.priorityChain.setTiers([DEFAULT_PRESET_TIERS[0]]);
  const task = { id: 'tool-evidence-case', title: 'Evidence case', prompt: `do work ${secret}`, allowedTools: allowedTools || [...new Set(toolCalls.map(call => call.name))], requireToolExecution };
  try {
    await engine.dispatcher._runWorker(task);
    const records = engine.sessions.readSession(task.sessionId);
    const serialized = JSON.stringify({ task: { ...task, prompt: undefined, title: undefined }, records: records.filter(item => !['user_message', 'assistant_message'].includes(item.type)) });
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes('sensitive output'), false);
    assert.equal(serialized.includes('secret command'), false);
    assert.equal(serialized.includes('/private/secret'), false);
    assert.equal(serialized.includes('private'), false);
    return { task, records, snapshot: engine.dispatcher.getSnapshot() };
  } finally {
    engine.dispatcher.stop();
    engine.skills.stopWatching();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('text-only dispatched response is blocked and retained for diagnosis', async () => {
  const { task } = await runTask();
  assert.equal(task.status, 'blocked');
  assert.equal(task.result, 'response');
  assert.ok(task.sessionId);
  assert.equal(task.executionEvidence.attemptedCount, 0);
  assert.equal(task.executionEvidence.successfulCount, 0);
});

test('failed operation does not satisfy the default execution requirement', async () => {
  const { task } = await runTask({ toolCalls: [{ id: 'c1', name: 'exec_command', args: { command: 'secret command' } }], failTool: true });
  assert.equal(task.status, 'blocked');
  assert.equal(task.executionEvidence.attemptedCount, 1);
  assert.equal(task.executionEvidence.successfulCount, 0);
  assert.equal(task.executionEvidence.failedCount, 1);
});

test('a failed tool keeps the task blocked even when another tool succeeded', async () => {
  const { task, snapshot } = await runTask({
    toolCalls: [
      { id: 'read-source', name: 'read_file', args: { path: 'src.dart' } },
      { id: 'run-test', name: 'exec_command', args: { command: 'flutter test test/example_test.dart' } }
    ],
    toolResults: [
      { ok: true },
      { exitCode: 1, stderr: 'verification failed' }
    ]
  });
  assert.equal(task.status, 'blocked');
  assert.equal(task.executionEvidence.attemptedCount, 2);
  assert.equal(task.executionEvidence.successfulCount, 1);
  assert.equal(task.executionEvidence.failedCount, 1);
  assert.equal(snapshot.completedTasks.length, 0);
  assert.equal(snapshot.terminalTasks[0].status, 'blocked');
});

test('non-command result with ok false does not satisfy the default execution requirement', async () => {
  const { task } = await runTask({
    toolCalls: [{ id: 'not-ok', name: 'read_file', args: { path: '/private/secret' } }],
    toolResult: { ok: false, output: 'sensitive output' }
  });
  assert.equal(task.status, 'blocked');
  assert.equal(task.executionEvidence.attemptedCount, 1);
  assert.equal(task.executionEvidence.successfulCount, 0);
});

test('approval-denied completion without a start does not satisfy execution requirement', async () => {
  const { task } = await runTask({
    toolCalls: [{ name: 'read_file', args: { path: '/private/secret' } }],
    toolResult: { error: "Tool call 'read_file' was not approved for this session.", blocked: true },
    skipToolStart: true
  });
  assert.equal(task.status, 'blocked');
  assert.equal(task.executionEvidence.attemptedCount, 1);
  assert.equal(task.executionEvidence.successfulCount, 0);
});

test('missing dispatcher approval UI is reported distinctly and never counts as execution', async () => {
  const { task } = await runTask({
    toolCalls: [{ id: 'approval-unavailable', name: 'exec_command', args: { command: 'safe command' } }],
    toolResult: { error: "Approval unavailable; blocked tool call 'exec_command'.", blocked: true },
    skipToolStart: true
  });
  assert.equal(task.status, 'blocked');
  assert.match(task.blockReason, /승인 UI가 연결되지 않아 실행을 보류/);
  assert.equal(task.executionEvidence.approvalBlockedCount, 1);
  assert.equal(task.executionEvidence.successfulCount, 0);
});

test('expired dispatcher approval is not reported as a user rejection', async () => {
  const { task } = await runTask({
    toolCalls: [{ id: 'approval-expired', name: 'exec_command', args: { command: 'safe command' } }],
    toolResult: { error: 'Approval request expired.', blocked: true },
    skipToolStart: true
  });
  assert.equal(task.status, 'blocked');
  assert.match(task.blockReason, /승인 대기 시간이 만료/);
  assert.equal(task.executionEvidence.approvalExpiredCount, 1);
  assert.equal(task.executionEvidence.approvalDeniedCount, 0);
});

test('exec_command only succeeds with exitCode zero', async t => {
  for (const exitCode of [2, null, 7]) {
    await t.test(`exitCode ${String(exitCode)} is blocked`, async () => {
      const { task } = await runTask({
        toolCalls: [{ id: `exit-${String(exitCode)}`, name: 'exec_command', args: { command: 'safe test command' } }],
        toolResult: { exitCode, output: 'command completed' }
      });
      assert.equal(task.status, 'blocked');
      assert.equal(task.executionEvidence.successfulCount, 0);
    });
  }
});

test('exec_command exitCode zero succeeds', async () => {
  const { task } = await runTask({
    toolCalls: [{ id: 'exit-zero', name: 'exec_command', args: { command: 'safe test command' } }],
    toolResult: { exitCode: 0, output: 'command completed' }
  });
  assert.equal(task.status, 'completed');
  assert.equal(task.executionEvidence.successfulCount, 1);
});

test('completed file_change succeeds without an exec exit code', async () => {
  const { task } = await runTask({
    toolCalls: [{ id: 'edit-complete', name: 'file_change', args: { path: '/private/secret' } }],
    toolResult: { changes: [{ path: '/private/secret' }] }
  });
  assert.equal(task.status, 'completed');
  assert.equal(task.executionEvidence.successfulCount, 1);
});

test('successful operation completes and stores redacted execution evidence', async () => {
  const { task, records, snapshot } = await runTask({ toolCalls: [{ id: 'c2', name: 'read_file', args: { path: '/private/secret' } }] });
  assert.equal(task.status, 'completed');
  assert.deepEqual(task.executionEvidence.toolNames, ['read_file']);
  assert.equal(task.executionEvidence.attemptedCount, 1);
  assert.equal(task.executionEvidence.successfulCount, 1);
  assert.equal(task.executionEvidence.failedCount, 0);
  assert.deepEqual(records.find(item => item.type === 'session_metadata')?.metadata.executionEvidence, task.executionEvidence);
  assert.equal(snapshot.completedTasks[0].executionEvidence.successfulCount, 1);
});

test('provider-native tool events outside the task allowlist cannot complete a task', async () => {
  const { task } = await runTask({
    toolCalls: [{ id: 'native-shell', name: 'exec_command', args: { command: 'read-only probe' } }],
    allowedTools: ['read_file']
  });
  assert.equal(task.status, 'blocked');
  assert.match(task.blockReason, /허용 목록 밖의 제공자 도구 이벤트/);
  assert.deepEqual(task.executionEvidence.disallowedToolNames, ['exec_command']);
  assert.equal(task.executionEvidence.allowedToolViolationCount, 1);
  assert.equal(task.executionEvidence.successfulCount, 0);
});

test('duplicate tool-end notifications cannot inflate execution evidence', async () => {
  const { task, snapshot } = await runTask({
    toolCalls: [{ id: 'duplicate-end', name: 'read_file', args: { path: 'fixture.txt' } }],
    duplicateToolEnd: true
  });
  assert.equal(task.status, 'completed');
  assert.equal(task.executionEvidence.attemptedCount, 1);
  assert.equal(task.executionEvidence.successfulCount, 1);
  assert.equal(task.executionEvidence.failedCount, 0);
  assert.equal(snapshot.completedTasks.length, 1);
});

test('default requires execution while explicit opt-out permits pure-answer tasks', async () => {
  const required = await runTask({ content: 'diagnostic response' });
  const optedOut = await runTask({ content: 'pure answer', requireToolExecution: false });
  assert.equal(required.task.status, 'blocked');
  assert.equal(optedOut.task.status, 'completed');
});

test('blocked dispatcher outcomes preserve session, response, and evidence', async () => {
  const run = await runTask({ toolCalls: [{ id: 'c3', name: 'exec_command', args: { command: 'private' } }], failTool: true });
  assert.equal(run.snapshot.terminalTasks[0].sessionId, run.task.sessionId);
  assert.equal(run.snapshot.terminalTasks[0].result, run.task.result);
  assert.equal(run.snapshot.terminalTasks[0].executionEvidence.successfulCount, 0);
});

test('executor enforces the task allowlist before reaching the tool handler', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-allowlist-'));
  let providerCalls = 0;
  let toolExecutions = 0;
  const engine = new AgentEngine({
    isolated: true,
    dataDir: root,
    workspaceDir: path.join(root, 'workspace'),
    dispatcherAutoStart: false,
    providerAdapter: async () => {
      providerCalls++;
      return providerCalls === 1
        ? { content: '', protocol: 'openai-compatible', toolCalls: [{ id: 'blocked-shell', name: 'exec_command', args: { command: 'echo must-not-run' } }] }
        : { content: 'The requested tool was outside the task allowlist.', toolCalls: [] };
    }
  });
  engine.priorityChain.setTiers([DEFAULT_PRESET_TIERS[0]]);
  engine._executeToolCall = async () => { toolExecutions++; return { exitCode: 0 }; };
  const task = { id: 'allowlist-boundary', title: 'Allowlist boundary', prompt: 'Use read_file only.', allowedTools: ['read_file'] };
  try {
    await engine.dispatcher._runWorker(task);
    assert.equal(toolExecutions, 0, 'disallowed exec_command must never reach the handler');
    assert.equal(task.status, 'blocked', 'blocked tool calls cannot count as successful task execution');
    assert.deepEqual(task.executionEvidence.toolNames, ['exec_command']);
    assert.equal(task.executionEvidence.successfulCount, 0);
    const records = engine.sessions.readSession(task.sessionId);
    assert.ok(records.some(item => item.type === 'tool_result' && item.tool === 'exec_command' && item.result?.blocked === true));
  } finally {
    engine.dispatcher.stop();
    engine.skills.stopWatching();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
