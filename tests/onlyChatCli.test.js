'use strict';

const assert = require('node:assert/strict');
const { parseGoalDuration, parseChatCommand, safeToolError, loadOnlyChatWorkspaceContext, streamOnlyChatTurn, runOnlyChatGoal } = require('../bin/codex.js');

async function main() {
  assert.equal(parseGoalDuration('3h'), 10_800_000);
  assert.throws(() => parseGoalDuration('4h'), /1분에서 3시간/);
  assert.throws(() => parseGoalDuration('0m'), /1분에서 3시간/);
  const args = parseChatCommand(['--duration', '2h', '--fixed-duration', '--approve-tool', 'edit_file', '이 목표를 계속 진행']);
  assert.equal(args.durationMs, 7_200_000);
  assert.equal(args.fixedDuration, true);
  assert.equal(args.model, 'gemini-3.8-flash-medium');
  const scopedArgs = parseChatCommand(['--model', 'gpt-6-luna', '--approve-workspace-write', '/workspace/only-chat', '한 번 진행']);
  assert.equal(scopedArgs.approveWorkspaceWrite, '/workspace/only-chat');
  assert.equal(scopedArgs.model, 'gpt-6-luna');
  assert.throws(() => parseChatCommand(['--approve-workspace-write', 'relative/path', 'unsafe']), /절대 경로/);
  assert.throws(() => parseChatCommand(['--approve-tool', 'exec_command', 'unsafe']), /승인 가능 도구/);
  assert.equal(safeToolError({ error: 'MCP bridge failed Bearer abc.def; access_token=secret user@example.com' }),
    'MCP bridge failed Bearer [redacted]; access_token=[redacted] [redacted-email]');
  assert.equal(safeToolError({ isError: true, content: [{ type: 'text', text: 'File unavailable; access_token=hidden' }] }),
    'File unavailable; access_token=[redacted]');
  assert.equal(safeToolError('const error = "file not found";'), '', 'successful tool text must never be printed as an error');

  const contextCommands = [];
  const liveContext = await loadOnlyChatWorkspaceContext({
    baseUrl: 'http://127.0.0.1:8899', workspaceRoot: '/workspace/only-chat',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:8899/api/status');
      assert.equal(options.headers.Host, '127.0.0.1:8899');
      return new Response(JSON.stringify({ sessionWorkspaceDir: '/workspace/only-chat' }), { status: 200 });
    },
    execFileSyncImpl: (command, args) => {
      contextCommands.push({ command, args });
      if (command.endsWith('/agent-coord')) return 'No active leases.\n';
      if (command.endsWith('/app-integration-guard')) return JSON.stringify({ ok: true, leases_clear: true, current_branch: 'main', current_status: { entries: 0, untracked: 0 } });
      if (command.endsWith('/integration-backlog')) return JSON.stringify([
        { id: 'todo_1', kind: 'todo', title: 'Open Only Chat TODO', status: 'recorded', source: 'user', blocker: 'Bearer abc.def; account@example.com' },
        { id: 'todo_2', title: 'Already done', status: 'complete' }
      ]);
      if (args.includes('rev-parse')) return '0123456789abcdef';
      if (args.includes('--show-current')) return 'main';
      throw new Error(`unexpected command ${command}`);
    }
  });
  assert.equal(liveContext.workspaceRoot, '/workspace/only-chat');
  assert.equal(liveContext.gitHead, '0123456789abcdef');
  assert.equal(liveContext.integrationBranch, 'main');
  assert.equal(liveContext.leases, 'No active leases.');
  assert.equal(liveContext.integrationGuard.leasesClear, true);
  assert.equal(liveContext.activeBacklog.length, 1, 'completed integration backlog rows are excluded');
  assert.equal(liveContext.activeBacklog[0].blocker, 'Bearer [redacted]; [redacted-email]');
  assert.equal(contextCommands.length, 5, 'the CLI calls only fixed read-only status commands for the approved repository');
  await assert.rejects(loadOnlyChatWorkspaceContext({
    baseUrl: 'http://127.0.0.1:8899', workspaceRoot: '/workspace/other',
    fetchImpl: async () => new Response(JSON.stringify({ sessionWorkspaceDir: '/workspace/only-chat' }), { status: 200 }),
    execFileSyncImpl: () => { throw new Error('must not inspect a mismatched root'); }
  }), /경로와 일치하지 않습니다/);

  const writes = [];
  const approvals = [];
  const events = [
    { type: 'session_started', sessionId: 'ses_0123456789abcdef' },
    { type: 'tier_resolved', tier: { name: 'Antigravity', model: 'gemini-3.8-flash-medium' } },
    { type: 'tool_start', call: { id: 'tool-1', name: 'read_file' } },
    { type: 'tool_end', result: { call: { id: 'tool-1', name: 'read_file' }, result: { content: [{ type: 'text', text: '{"isError":true,"content":[{"type":"text","text":"MCP bridge unavailable; access_token=hidden"}]}' }] } } },
    { type: 'tool_approval_required', requestId: 'req-1', sessionId: 'ses_0123456789abcdef', name: 'edit_file', scopeRequiresExplicit: false },
    { type: 'message_delta', delta: 'Only Chat 응답' },
    { type: 'turn_complete' }
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/api/tool-approval')) {
      approvals.push(JSON.parse(options.body));
      return new Response('{"ok":true}', { status: 200 });
    }
    const payload = JSON.parse(options.body);
    assert.equal(payload.fullAccess, false);
    assert.equal(payload.managerMode, false);
    assert.equal(payload.modelSelection, 'gemini-3.8-flash-medium');
    assert.equal(payload.reasoningEffort, 'medium');
    return new Response(events, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const result = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_1793780000000', prompt: 'test',
    model: 'gemini-3.8-flash-medium', approveTools: ['edit_file'], fetchImpl, write: text => writes.push(text)
  });
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'ses_0123456789abcdef');
  assert.equal(result.response, 'Only Chat 응답');
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].decision, 'allow_tool');
  assert.ok(writes.some(text => text.includes('[Only Chat 승인 범위: edit_file]')));
  assert.ok(writes.some(text => text.includes('[도구 실패: read_file · MCP bridge unavailable; access_token=[redacted]]')));
  assert.ok(!writes.join('').includes('hidden'));

  const workspaceScopeEvent = {
    type: 'tool_approval_required', requestId: 'req-workspace', sessionId: 'ses_0123456789abcdef',
    name: 'codex_cli_workspace_write_scope', scopeRequiresExplicit: false,
    args: { directory: '/workspace/only-chat', reason: 'Codex CLI may write in this workspace.' }
  };
  const workspaceEvents = [
    { type: 'session_started', sessionId: 'ses_0123456789abcdef' },
    workspaceScopeEvent,
    { type: 'message_delta', delta: '작업공간 승인 후 응답' },
    { type: 'turn_complete' }
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  const workspaceApprovals = [];
  const workspaceWrites = [];
  const workspaceTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_1793780000000', prompt: 'scoped approval',
    approveWorkspaceWrite: '/workspace/only-chat',
    fetchImpl: async (url, options) => {
      if (url.endsWith('/api/tool-approval')) {
        workspaceApprovals.push(JSON.parse(options.body));
        return new Response('{"ok":true}', { status: 200 });
      }
      return new Response(workspaceEvents, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    write: text => workspaceWrites.push(text)
  });
  assert.equal(workspaceTurn.ok, true, 'an exact, explicit workspace path can approve one bounded Codex request');
  assert.equal(workspaceApprovals.length, 1);
  assert.equal(workspaceApprovals[0].decision, 'approve', 'workspace approval does not persist as a session tool grant');
  assert.ok(workspaceWrites.some(text => text.includes('[Only Chat 작업공간 쓰기 승인: /workspace/only-chat]')));

  let mismatchedScopeApprovalCount = 0;
  const mismatchedScopeTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_1793780000000', prompt: 'mismatch guard',
    approveWorkspaceWrite: '/workspace/only-chat',
    fetchImpl: async (url, options) => {
      if (url.endsWith('/api/tool-approval')) mismatchedScopeApprovalCount++;
      return new Response(`data: ${JSON.stringify({ ...workspaceScopeEvent, args: { directory: '/workspace/other' } })}\n\n`, {
        status: 200, headers: { 'content-type': 'text/event-stream' }
      });
    },
    write: () => {}
  });
  assert.equal(mismatchedScopeTurn.category, 'approval_required', 'a different workspace is not approved');
  assert.equal(mismatchedScopeApprovalCount, 0);

  const fullAccessScopeTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_1793780000000', prompt: 'full access guard',
    approveWorkspaceWrite: '/workspace/only-chat',
    fetchImpl: async () => new Response(`data: ${JSON.stringify({ ...workspaceScopeEvent, scopeRequiresExplicit: true })}\n\n`, {
      status: 200, headers: { 'content-type': 'text/event-stream' }
    }),
    write: () => {}
  });
  assert.equal(fullAccessScopeTurn.category, 'approval_required', 'the workspace flag cannot approve Full Access');

  let goalNow = 1_000;
  let goalWorkspaceTurns = 0;
  let goalWorkspaceContextReads = 0;
  const goalWorkspaceApprovals = [];
  const goalWorkspaceRun = await runOnlyChatGoal({
    baseUrl: 'http://127.0.0.1:8899', prompt: 'continue scoped goal', durationMs: 1_000, fixedDuration: true,
    model: 'gpt-6-luna', approveWorkspaceWrite: '/workspace/only-chat', now: () => goalNow, write: () => {},
    workspaceContextLoader: async () => {
      goalWorkspaceContextReads++;
      return { workspaceRoot: '/workspace/only-chat', integrationBranch: 'main', gitHead: 'abc123', leases: 'No active leases.', activeBacklog: [{ id: 'todo_1', title: 'Open TODO', status: 'recorded' }] };
    },
    fetchImpl: async (url, options) => {
      if (url.endsWith('/api/tool-approval')) {
        goalWorkspaceApprovals.push(JSON.parse(options.body));
        return new Response('{"ok":true}', { status: 200 });
      }
      goalWorkspaceTurns++;
      assert.match(JSON.parse(options.body).prompt, /Open TODO/, 'the current lease/backlog snapshot reaches every Goal turn');
      goalNow += 600;
      const turnEvents = [
        { type: 'session_started', sessionId: 'ses_0123456789abcdef' },
        workspaceScopeEvent,
        { type: 'message_delta', delta: 'goal step' },
        { type: 'turn_complete' }
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
      return new Response(turnEvents, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
  });
  assert.equal(goalWorkspaceRun.ok, true);
  assert.equal(goalWorkspaceTurns, 2, 'Goal keeps running sequential Only Chat turns until the deadline');
  assert.equal(goalWorkspaceContextReads, 2, 'Goal refreshes the ownership snapshot before each turn');
  assert.equal(goalWorkspaceApprovals.length, 2, 'each Goal turn rechecks the exact workspace scope');
  assert.ok(goalWorkspaceApprovals.every(approval => approval.decision === 'approve'));

  const loopEvents = Array.from({ length: 4 }, (_, index) => `data: ${JSON.stringify({ type: 'tool_start', call: { id: `loop-${index}`, name: 'call_mcp_tool' } })}\n\n`).join('');
  const limitedTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_1793780000000', prompt: 'loop guard', maxToolCalls: 3,
    fetchImpl: async () => new Response(loopEvents, { status: 200, headers: { 'content-type': 'text/event-stream' } }), write: () => {}
  });
  assert.equal(limitedTurn.ok, false);
  assert.equal(limitedTurn.category, 'tool_call_limit', 'CLI stops a provider turn that begins too many tool calls');
  assert.equal(limitedTurn.limit, 3);

  const timedTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_1793780000000', prompt: 'timeout guard', timeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })),
    write: () => {}
  });
  assert.equal(timedTurn.ok, false);
  assert.equal(timedTurn.category, 'turn_timeout', 'CLI reports a bounded provider-turn timeout');

  let now = 1_000;
  const goalRequests = [];
  const goalFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    goalRequests.push(body);
    now += goalRequests.length === 1 ? 400 : 700;
    return new Response([
      `data: ${JSON.stringify({ type: 'session_started', sessionId: 'ses_0123456789abcdef' })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: 'step complete' })}\n\n`,
      `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const goal = await runOnlyChatGoal({
    baseUrl: 'http://127.0.0.1:8899', prompt: 'start goal', durationMs: 1_000,
    fetchImpl: goalFetch, now: () => now, write: () => {}
  });
  assert.equal(goal.ok, true);
  assert.equal(goal.iteration, 2, 'the Goal performs sequential turns until its deadline');
  assert.match(goalRequests[1].prompt, /같은 Goal/);
  assert.equal(goalRequests[1].sessionId, 'ses_0123456789abcdef', 'continuation stays in the same Only Chat session');

  now = 1_000;
  const fixedRequests = [];
  const fixedGoal = await runOnlyChatGoal({
    baseUrl: 'http://127.0.0.1:8899', prompt: 'three-hour goal', durationMs: 1_000, fixedDuration: true,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      fixedRequests.push(body);
      now += fixedRequests.length === 1 ? 400 : 700;
      const responseText = fixedRequests.length === 1 ? 'GOAL_COMPLETE' : 'step complete';
      return new Response([
        `data: ${JSON.stringify({ type: 'session_started', sessionId: 'ses_0123456789abcdef' })}\n\n`,
        `data: ${JSON.stringify({ type: 'message_delta', delta: responseText })}\n\n`,
        `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
        'data: [DONE]\n\n'
      ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    now: () => now, write: () => {}
  });
  assert.equal(fixedGoal.ok, true);
  assert.equal(fixedGoal.iteration, 2, 'fixed-duration ignores an early GOAL_COMPLETE marker and continues to the deadline');
  assert.equal(fixedGoal.completedEarly, false);
  assert.match(fixedRequests[1].prompt, /전체 시간이 끝나기 전에는 GOAL_COMPLETE/);

  now = 1_000;
  const stepBlockedRequests = [];
  const stepBlockedGoal = await runOnlyChatGoal({
    baseUrl: 'http://127.0.0.1:8899', prompt: 'multi-task goal', durationMs: 1_000, fixedDuration: true,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      stepBlockedRequests.push(body);
      now += stepBlockedRequests.length === 1 ? 400 : 700;
      const responseText = stepBlockedRequests.length === 1
        ? 'GOAL_STEP_BLOCKED: one candidate overlaps an active lease.'
        : 'second task advanced';
      return new Response([
        `data: ${JSON.stringify({ type: 'session_started', sessionId: 'ses_0123456789abcdef' })}\n\n`,
        `data: ${JSON.stringify({ type: 'message_delta', delta: responseText })}\n\n`,
        `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
        'data: [DONE]\n\n'
      ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    now: () => now, write: () => {}
  });
  assert.equal(stepBlockedGoal.ok, true);
  assert.equal(stepBlockedGoal.iteration, 2, 'a blocked subtask advances to a distinct next task in fixed-duration mode');
  assert.match(stepBlockedRequests[1].prompt, /one candidate overlaps an active lease/);

  now = 1_000;
  const blockedGoal = await runOnlyChatGoal({
    baseUrl: 'http://127.0.0.1:8899', prompt: 'blocked goal', durationMs: 1_000, fixedDuration: true,
    fetchImpl: async () => {
      now += 100;
      return new Response([
        `data: ${JSON.stringify({ type: 'session_started', sessionId: 'ses_0123456789abcdef' })}\n\n`,
        `data: ${JSON.stringify({ type: 'message_delta', delta: 'GOAL_BLOCKED: MCP workspace read returned an error; verify canonical root access.' })}\n\n`,
        `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
        'data: [DONE]\n\n'
      ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    now: () => now, write: () => {}
  });
  assert.equal(blockedGoal.ok, false);
  assert.equal(blockedGoal.category, 'goal_blocked', 'fixed-duration stops instead of idling when no safe next step exists');
  assert.equal(blockedGoal.reason, 'MCP workspace read returned an error; verify canonical root access.');

  console.log('Only Chat CLI duration, scoped approval, and SSE response checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
