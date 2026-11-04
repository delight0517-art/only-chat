'use strict';

const assert = require('node:assert/strict');
const { parseGoalDuration, parseChatCommand, safeToolError, loadOnlyChatWorkspaceContext, formatLockEvidenceSummary, formatOnlyChatWorkspaceContext, streamOnlyChatTurn, runOnlyChatGoal } = require('../bin/codex.js');

async function main() {
  assert.equal(parseGoalDuration('3h'), 10_800_000);
  assert.throws(() => parseGoalDuration('4h'), /1분에서 3시간/);
  assert.throws(() => parseGoalDuration('0m'), /1분에서 3시간/);
  const args = parseChatCommand(['--duration', '2h', '--fixed-duration', '--approve-tool', 'edit_file', '이 목표를 계속 진행']);
  assert.equal(args.durationMs, 7_200_000);
  assert.equal(args.fixedDuration, true);
  assert.equal(args.model, 'auto');
  const scopedArgs = parseChatCommand(['--model', 'gpt-6-luna', '--approve-workspace-write', '/workspace/only-chat', '한 번 진행']);
  assert.equal(scopedArgs.approveWorkspaceWrite, '/workspace/only-chat');
  assert.equal(scopedArgs.model, 'gpt-6-luna');
  assert.throws(() => parseChatCommand(['--approve-workspace-write', 'relative/path', 'unsafe']), /절대 경로/);
  assert.throws(() => parseChatCommand(['--approve-tool', 'exec_command', 'unsafe']), /승인 가능 도구/);
  const compactToolArgs = parseChatCommand(['--model', 'qwen2.5:3b', '--tool-profile', 'file-edit', '--approve-tool', 'edit_file', '파일 TODO 처리']);
  assert.equal(compactToolArgs.toolProfile, 'file-edit');
  const readOnlyToolArgs = parseChatCommand(['--model', 'qwen2.5:3b', '--tool-profile', 'file-read', 'TODO 상태 읽기']);
  assert.equal(readOnlyToolArgs.toolProfile, 'file-read');
  assert.throws(() => parseChatCommand(['--tool-profile', 'file-read', '--approve-tool', 'edit_file', '읽기만']), /file-read 프로필/);
  assert.throws(() => parseChatCommand(['--tool-profile', 'all', 'unsafe']), /tool-profile/);
  assert.equal(safeToolError({ error: 'MCP bridge failed Bearer abc.def; access_token=secret user@example.com' }),
    'MCP bridge failed Bearer [redacted]; access_token=[redacted] [redacted-email]');
  assert.equal(safeToolError({ isError: true, content: [{ type: 'text', text: 'File unavailable; access_token=hidden' }] }),
    'File unavailable; access_token=[redacted]');
  assert.equal(safeToolError('const error = "file not found";'), '', 'successful tool text must never be printed as an error');

  const mixedLockSummary = formatLockEvidenceSummary({
    repositoryWideLockConclusion: 'unknown',
    repositoryLeaseInventory: { available: true, records: [{ mode: 'edit', leaseId: 'lease-1', owner: 'task-a', paths: [{ path: 'lib/owned.dart' }] }] },
    inProcessPathLocks: { available: true, locks: [] },
    workspaceExecution: { available: true, state: 'free' },
    integrationGuard: { available: true, leasesClear: false },
    applicationRuntimeOrFeatureLock: { available: false, state: 'unknown' }
  });
  assert.match(mixedLockSummary, /저장소 전체 편집 잠금: unknown/);
  assert.match(mixedLockSummary, /현재 저장소의 agent-coord lease: edit lease lease-1 \(task-a; lib\/owned\.dart\)/);
  assert.match(mixedLockSummary, /통합 준비 상태: 대기 필요 .*저장소 전체 편집 잠금이 아님/);
  assert.match(mixedLockSummary, /앱 실행\/기능 잠금: 알 수 없음/);

  const contextCommands = [];
  const liveContext = await loadOnlyChatWorkspaceContext({
    baseUrl: 'http://127.0.0.1:8899', workspaceRoot: '/workspace/only-chat',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:8899/api/status');
      assert.equal(options.headers.Host, '127.0.0.1:8899');
      return new Response(JSON.stringify({ sessionWorkspaceDir: '/workspace/only-chat-runtime' }), { status: 200 });
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
  assert.equal(liveContext.serverDefaultWorkspaceRoot, '/workspace/only-chat-runtime', 'an explicit workspace selection may differ from the server launch default');
  assert.equal(liveContext.gitHead, '0123456789abcdef');
  assert.equal(liveContext.integrationBranch, 'main');
  assert.equal(liveContext.leases, 'No active leases.');
  assert.equal(liveContext.integrationGuard.leasesClear, true);
  assert.equal(liveContext.activeBacklog.length, 1, 'completed integration backlog rows are excluded');
  assert.equal(liveContext.activeBacklog[0].blocker, 'Bearer [redacted]; [redacted-email]');
  const compactContext = formatOnlyChatWorkspaceContext(liveContext);
  assert.ok(compactContext.length < 2500, `compact workspace context should fit local-model context (got ${compactContext.length} chars)`);
  assert.match(compactContext, /not a repository-wide edit lock/);
  assert.match(compactContext, /Tool paths are relative to the Workspace root/);
  assert.match(compactContext, /do not invent prefixes such as src\/_tools/);
  assert.match(compactContext, /todo_1 recorded: Open Only Chat TODO/);
  assert.equal(contextCommands.length, 5, 'the CLI calls only fixed read-only status commands for the approved repository');
  const defaultContext = await loadOnlyChatWorkspaceContext({
    baseUrl: 'http://127.0.0.1:8899',
    fetchImpl: async url => new Response(JSON.stringify(url.endsWith('/api/ownership') ? {} : {
      sessionWorkspaceDir: '/workspace/only-chat-runtime'
    }), { status: 200 }),
    execFileSyncImpl: (command, args) => {
      if (command.endsWith('/agent-coord')) return 'No active leases.\n';
      if (command.endsWith('/app-integration-guard')) return JSON.stringify({ ok: true, leases_clear: true, current_branch: 'main', current_status: { entries: 0, untracked: 0 } });
      if (command.endsWith('/integration-backlog')) return '[]';
      if (args.includes('rev-parse')) return '0123456789abcdef';
      if (args.includes('--show-current')) return 'main';
      throw new Error(`unexpected command ${command}`);
    }
  });
  assert.equal(defaultContext.workspaceRoot, '/workspace/only-chat-runtime', 'file-edit chats without an explicit write root use the verified active workspace');
  const selectedWorkspaceContext = await loadOnlyChatWorkspaceContext({
    baseUrl: 'http://127.0.0.1:8899', workspaceRoot: '/workspace/other',
    fetchImpl: async () => new Response(JSON.stringify({ sessionWorkspaceDir: '/workspace/only-chat-runtime' }), { status: 200 }),
    execFileSyncImpl: (command, args) => {
      if (command.endsWith('/agent-coord')) return 'No active leases.\n';
      if (command.endsWith('/app-integration-guard')) return JSON.stringify({ ok: true, leases_clear: true, current_branch: 'main', current_status: { entries: 0, untracked: 0 } });
      if (command.endsWith('/integration-backlog')) return '[]';
      if (args.includes('rev-parse')) return '0123456789abcdef';
      if (args.includes('--show-current')) return 'main';
      throw new Error(`unexpected command ${command}`);
    }
  });
  assert.equal(selectedWorkspaceContext.workspaceRoot, '/workspace/other', 'the user-selected root is inspected even when it differs from the Only Chat launch root');

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
    assert.equal(payload.toolProfile, 'file-edit');
    return new Response(events, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const result = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_1793780000000', prompt: 'test',
    model: 'gemini-3.8-flash-medium', approveTools: ['edit_file'], toolProfile: 'file-edit', fetchImpl, write: text => writes.push(text)
  });
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'ses_0123456789abcdef');
  assert.equal(result.response, 'Only Chat 응답');
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].decision, 'allow_tool');
  assert.ok(writes.some(text => text.includes('[Only Chat 승인 범위: edit_file]')));
  assert.ok(writes.some(text => text.includes('[도구 실패: read_file · MCP bridge unavailable; access_token=[redacted]]')));
  assert.ok(!writes.join('').includes('hidden'));

  const leakedToolCallEvents = [
    { type: 'session_started', sessionId: 'ses_0123456789abcdef' },
    { type: 'message_delta', delta: 'I will inspect the file. ' },
    { type: 'message_delta', delta: '</tool_' },
    { type: 'message_delta', delta: 'call>' },
    { type: 'turn_complete' }
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  const leakedOutput = [];
  const leakedToolCallTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_1793780000001', prompt: 'read a file',
    fetchImpl: async () => new Response(leakedToolCallEvents, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: text => leakedOutput.push(text)
  });
  assert.equal(leakedToolCallTurn.ok, false, 'provider tool-call markup must not be accepted as a successful user-facing answer');
  assert.equal(leakedToolCallTurn.category, 'invalid_provider_output');
  assert.equal(leakedToolCallTurn.response, 'I will inspect the file. ');
  assert.ok(!leakedOutput.join('').includes('tool_call'));

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
  let approvedWorkspacePayload;
  const workspaceWrites = [];
  const workspaceTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_1793780000000', prompt: 'scoped approval',
    approveWorkspaceWrite: '/workspace/only-chat',
    fetchImpl: async (url, options) => {
      if (url.endsWith('/api/tool-approval')) {
        workspaceApprovals.push(JSON.parse(options.body));
        return new Response('{"ok":true}', { status: 200 });
      }
      approvedWorkspacePayload = JSON.parse(options.body);
      return new Response(workspaceEvents, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    write: text => workspaceWrites.push(text)
  });
  assert.equal(workspaceTurn.ok, true, 'an exact, explicit workspace path can approve one bounded Codex request');
  assert.equal(workspaceApprovals.length, 1);
  assert.equal(workspaceApprovals[0].decision, 'approve', 'workspace approval does not persist as a session tool grant');
  assert.equal(approvedWorkspacePayload.workspaceDir, '/workspace/only-chat', 'CLI routes the selected root into the new Only Chat session');
  assert.equal(approvedWorkspacePayload.workspaceWriteApproval, true, 'workspace routing carries the explicit one-run approval');
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

  let boundedGoalNow = 10_000;
  let boundedGoalOutput = '';
  const boundedGoalToolEvents = Array.from({ length: 13 }, (_, index) => ({
    type: 'tool_start', call: { id: `goal-tool-${index}`, name: 'call_mcp_tool' }
  })).map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
    + `data: ${JSON.stringify({ type: 'message_delta', delta: 'GOAL_STEP_BLOCKED: narrow test stop' })}\n\n`
    + `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`
    + 'data: [DONE]\n\n';
  const boundedGoalRun = await runOnlyChatGoal({
    baseUrl: 'http://127.0.0.1:8899', prompt: 'bounded goal turn', durationMs: 1_000, fixedDuration: true,
    fetchImpl: async () => {
      boundedGoalNow = 11_001;
      return new Response(boundedGoalToolEvents, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    now: () => boundedGoalNow, write: text => { boundedGoalOutput += text; }
  });
  assert.equal(boundedGoalRun.iteration, 1);
  assert.doesNotMatch(boundedGoalOutput, /회차 제한 도달/, 'a fixed Goal turn can complete more than the old 12-tool ceiling');
  assert.match(boundedGoalOutput, /GOAL_STEP_BLOCKED: narrow test stop/);

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

  const busyTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_busy', prompt: 'must not overlap',
    fetchImpl: async () => new Response('{"error":"Only Chat busy"}', { status: 409 }), write: () => {}
  });
  assert.equal(busyTurn.ok, false);
  assert.equal(busyTurn.category, 'turn_busy', 'an active Only Chat turn is reported as a recoverable busy state');

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
  let repeatedCompletionCalls = 0;
  const repeatedCompletionGoal = await runOnlyChatGoal({
    baseUrl: 'http://127.0.0.1:8899', prompt: 'make real progress', durationMs: 10_000, fixedDuration: true,
    fetchImpl: async () => {
      repeatedCompletionCalls++;
      now += 100;
      return new Response([
        `data: ${JSON.stringify({ type: 'message_delta', delta: repeatedCompletionCalls === 1
          ? 'There are no remaining actionable tasks. Goal complete.'
          : 'Everything is done; nothing left to do.' })}\n\n`,
        `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
        'data: [DONE]\n\n'
      ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    now: () => now, write: () => {}
  });
  assert.equal(repeatedCompletionCalls, 2, 'fixed Goal stops when consecutive text-only turns repeat the completion claim in different words');
  assert.equal(repeatedCompletionGoal.ok, false);
  assert.equal(repeatedCompletionGoal.category, 'goal_no_progress');

  let countedToolsNow = 1_000;
  const countedTools = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_tools', prompt: 'read one item',
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'read-1', name: 'read_file' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { name: 'read_file' }, result: { ok: true } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: 'Read complete.' })}\n\n`,
      `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: () => {}
  });
  assert.equal(countedTools.execution.toolCalls, 1);
  assert.equal(countedTools.execution.successfulTools, 1);
  assert.equal(countedTools.execution.failedTools, 0);

  const groundedTodoOutput = [];
  const groundedTodoTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_todo_grounding',
    prompt: 'TODO-PRIO-01 완료 여부와 제목을 알려주세요.',
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'todo-read', name: 'read_file' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'todo-read', name: 'read_file' }, result: '- [ ] **TODO-PRIO-01. 우선순위 모델 검증**:\\n  - 상세 내용' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: 'TODO-PRIO-01 is complete and all model checks passed.' })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: '</tool_call>' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: text => groundedTodoOutput.push(text)
  });
  assert.equal(groundedTodoTurn.ok, true);
  assert.equal(groundedTodoTurn.recoveredFrom, 'invalid_provider_output');
  assert.match(groundedTodoTurn.response, /\[ \].*미완료/);
  assert.match(groundedTodoTurn.response, /TODO-PRIO-01\. 우선순위 모델 검증/);
  assert.ok(!groundedTodoOutput.join('').includes('all model checks passed'), 'unverified model claims are withheld for TODO status prompts');
  assert.match(groundedTodoOutput.join(''), /\[ \].*미완료/);

  const checkboxLineOutput = [];
  const checkboxLineTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_todo_checkbox_line',
    prompt: 'TODO-PRIO-01 체크박스 한 줄만 보여주세요.',
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'todo-read', name: 'read_file' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'todo-read', name: 'read_file' }, result: '- [ ] **TODO-PRIO-01. 우선순위별 실제 모델·계정·현재 선택 상태 검증**:' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: 'TODO-PRIO-01 is done.' })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: '</tool_call>' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: text => checkboxLineOutput.push(text)
  });
  assert.equal(checkboxLineTurn.ok, true, 'checkbox-line wording should recover from malformed model output using the read_file evidence');
  assert.equal(checkboxLineTurn.recoveredFrom, 'invalid_provider_output');
  assert.match(checkboxLineTurn.response, /\[ \].*미완료/);
  assert.ok(!checkboxLineOutput.join('').includes('is done'), 'unverified completion claims are withheld for checkbox-line requests');
  assert.match(checkboxLineOutput.join(''), /\[ \].*미완료/);

  const embeddedStatusOutput = [];
  const embeddedStatusTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_embedded_3f_status_grounding',
    prompt: 'Use embedded_3f_status to report whether the panel is connected and a site page is open.',
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'threef-status', name: 'embedded_3f_status' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'threef-status', name: 'embedded_3f_status' }, result: { available: true, isOpen: true, activeUrl: 'about:blank', title: '', controlAvailable: true, statusText: '3F Browser 제어 연결됨 · 열린 페이지 없음' } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: '{}' })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: '</tool_call>' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: text => embeddedStatusOutput.push(text)
  });
  assert.equal(embeddedStatusTurn.ok, true, 'a successful embedded 3F status tool result must recover a malformed model follow-up');
  assert.equal(embeddedStatusTurn.recoveredFrom, 'invalid_provider_output');
  assert.match(embeddedStatusTurn.response, /제어 연결됨/);
  assert.match(embeddedStatusTurn.response, /패널 열림/);
  assert.match(embeddedStatusTurn.response, /웹사이트 페이지 없음/);
  assert.ok(!embeddedStatusOutput.join('').includes('{}'), 'the malformed empty model response is withheld from the CLI user');

  now = 1_000;
  const interruptedGoalRequests = [];
  const interruptedGoal = await runOnlyChatGoal({
    baseUrl: 'http://127.0.0.1:8899', prompt: 'continue after a bounded turn', durationMs: 1_000, fixedDuration: true,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/api/tool-approval')) return new Response('{"ok":true}', { status: 200 });
      const body = JSON.parse(options.body);
      interruptedGoalRequests.push(body);
      now += interruptedGoalRequests.length === 1 ? 400 : 700;
      if (interruptedGoalRequests.length === 1) {
        const limitEvents = [
          { type: 'session_started', sessionId: 'ses_0123456789abcdef' },
        ...Array.from({ length: 25 }, (_, index) => ({ type: 'tool_start', call: { id: `bounded-${index}`, name: 'call_mcp_tool' } }))
        ];
        return new Response(limitEvents.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response([
        `data: ${JSON.stringify({ type: 'session_started', sessionId: 'ses_0123456789abcdef' })}\n\n`,
        `data: ${JSON.stringify({ type: 'message_delta', delta: 'next safe step' })}\n\n`,
        `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
        'data: [DONE]\n\n'
      ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    now: () => now, write: () => {}
  });
  assert.equal(interruptedGoal.ok, true);
  assert.equal(interruptedGoal.iteration, 2, 'fixed-duration continues after one bounded tool-call turn');
  assert.equal(interruptedGoalRequests[1].sessionId, 'ses_0123456789abcdef', 'continuation uses the same Only Chat session');
  assert.match(interruptedGoalRequests[1].prompt, /tool_call_limit/, 'the next turn receives the prior bound as a no-repeat clue');

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

  let repeatedLimitNow = 1_000;
  let repeatedLimitTurn = 0;
  const repeatedLimitRequests = [];
  const repeatedLimitOutput = [];
  const repeatedLimitStream = Array.from({ length: 25 }, (_, index) =>
    `data: ${JSON.stringify({ type: 'tool_start', call: { id: `repeat-${index}`, name: 'call_mcp_tool' } })}\n\n`
  ).join('');
  const repeatedLimitGoal = await runOnlyChatGoal({
    baseUrl: 'http://127.0.0.1:8899', prompt: 'continue after tool limits and one blocked task', durationMs: 10_000, fixedDuration: true,
    fetchImpl: async (_url, options) => {
      repeatedLimitNow += repeatedLimitTurn === 6 ? 20_000 : 100;
      const body = JSON.parse(options.body);
      repeatedLimitRequests.push(body);
      repeatedLimitTurn++;
      const response = repeatedLimitTurn <= 5
        ? repeatedLimitStream
        : [
          `data: ${JSON.stringify({ type: 'message_delta', delta: repeatedLimitTurn === 6 ? 'GOAL_STEP_BLOCKED: YouTube quota gate.' : 'next unrelated Only Chat task advanced' })}\n\n`,
          `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
          'data: [DONE]\n\n'
        ].join('');
      return new Response(response, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    now: () => repeatedLimitNow, write: text => repeatedLimitOutput.push(text)
  });
  assert.equal(repeatedLimitGoal.iteration, 7, 'five limited turns block only the current subtask and the fixed Goal continues');
  assert.equal(repeatedLimitTurn, 7, 'after one budget-blocked task and one policy-blocked task, another task starts');
  assert.match(repeatedLimitRequests[4].prompt, /tool_call_limit/);
  assert.match(repeatedLimitRequests[5].prompt, /도구\/시간 제한 5회 연속/);
  assert.match(repeatedLimitRequests[6].prompt, /YouTube quota gate/);
  assert.doesNotMatch(repeatedLimitOutput.join(''), /서로 다른 하위 작업 5개가 연속으로 막혀/);

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

const testWatchdog = setTimeout(() => {
  console.error('Only Chat CLI test timed out before completing.');
  process.exitCode = 1;
}, 30_000);
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(testWatchdog));
