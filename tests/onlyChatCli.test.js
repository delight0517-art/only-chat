'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { parseGoalDuration, parseChatCommand, safeToolError, loadOnlyChatWorkspaceContext, formatLockEvidenceSummary, formatOnlyChatWorkspaceContext, streamOnlyChatTurn, runOnlyChatGoal } = require('../bin/codex.js');

async function main() {
  for (const command of ['chat', 'goal']) {
    const help = spawnSync(process.execPath, [require.resolve('../bin/codex.js'), command, '--help'], {
      encoding: 'utf8', env: { ...process.env, ONLY_CHAT_URL: 'http://127.0.0.1:1' }
    });
    assert.equal(help.status, 0, `${command} --help exits without connecting to Only Chat`);
    assert.match(help.stdout, new RegExp(`my-codex ${command}`));
  }
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
      `data: ${JSON.stringify({ type: 'message_delta', delta: `step ${goalRequests.length} complete` })}\n\n`,
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

  let contextGoalNow = 1_000;
  let workspaceContextLoadArgs = null;
  let workspaceContextPrompt = '';
  const workspaceContextGoal = await runOnlyChatGoal({
    baseUrl: 'http://127.0.0.1:8899', prompt: 'audit the current workspace locks', durationMs: 10_000,
    toolProfile: 'file-edit',
    workspaceContextLoader: async options => {
      workspaceContextLoadArgs = options;
      return {
        workspaceRoot: '/workspace/only-chat', integrationBranch: 'main', gitHead: 'abc123',
        lockEvidence: {
          repositoryLeaseInventory: { available: true, records: [] },
          inProcessPathLocks: { available: true, locks: [] },
          workspaceExecution: { available: true, state: 'none' }
        },
        integrationGuard: { leasesClear: true }, activeBacklog: []
      };
    },
    fetchImpl: async (url, options) => {
      workspaceContextPrompt = JSON.parse(options.body).prompt;
      contextGoalNow += 100;
      return new Response([
        `data: ${JSON.stringify({ type: 'message_delta', delta: 'GOAL_COMPLETE' })}\n\n`,
        `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
        'data: [DONE]\n\n'
      ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    now: () => contextGoalNow, write: () => {}
  });
  assert.equal(workspaceContextLoadArgs.baseUrl, 'http://127.0.0.1:8899');
  assert.equal(workspaceContextLoadArgs.workspaceRoot, undefined, 'read scope uses the default workspace without approving writes');
  assert.match(workspaceContextPrompt, /\[Only Chat local coordination snapshot; refreshed for this turn\]/);
  assert.match(workspaceContextPrompt, /agent-coord leases \(exact paths and owners only\): none/);
  assert.equal(workspaceContextGoal.ok, true);
  assert.equal(workspaceContextGoal.completedEarly, true);

  let repeatedNoProgressCalls = 0;
  let repeatedNoProgressNow = 1_000;
  const repeatedNoProgressGoal = await runOnlyChatGoal({
    baseUrl: 'http://127.0.0.1:8899', prompt: 'audit workspace state', durationMs: 60_000,
    fetchImpl: async () => {
      repeatedNoProgressCalls++;
      repeatedNoProgressNow += 100;
      return new Response([
        `data: ${JSON.stringify({ type: 'message_delta', delta: 'GOAL_COMPLETE: pending workspace/lease inspection.' })}\n\n`,
        `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
        'data: [DONE]\n\n'
      ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    now: () => repeatedNoProgressNow, write: () => {}
  });
  assert.equal(repeatedNoProgressCalls, 2, 'a non-fixed Goal stops when it repeats the same no-tool answer');
  assert.equal(repeatedNoProgressGoal.ok, false);
  assert.equal(repeatedNoProgressGoal.category, 'goal_no_progress');

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

  const failedToolOutput = [];
  const failedToolTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_failed_tool', prompt: 'edit the TODO',
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'session_started', sessionId: 'ses_failed_tool' })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'edit-1', name: 'edit_file' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'edit-1', name: 'edit_file' }, result: { ok: false, error: 'Target string not found' } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: 'TODO updated successfully.' })}\n\n`,
      `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: text => failedToolOutput.push(text)
  });
  assert.equal(failedToolTurn.ok, false, 'a completed model turn cannot override a failed edit tool');
  assert.equal(failedToolTurn.category, 'tool_execution_failed');
  assert.equal(failedToolTurn.execution.failedTools, 1);
  assert.match(failedToolOutput.join(''), /도구 실패: edit_file/);

  const successfulEditOutput = [];
  const successfulEditTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_successful_edit',
    prompt: 'Read the anchor, then use edit_file to append one line to TODO_ROADMAP.md. Use read_file only for checking the result afterward.',
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'session_started', sessionId: 'ses_successful_edit' })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'edit-1', name: 'edit_file' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'edit-1', name: 'edit_file', args: { path: 'TODO_ROADMAP.md' } }, result: { ok: true } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: 'The requested TODO note is complete.' })}\n\n`,
      `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: text => successfulEditOutput.push(text)
  });
  assert.equal(successfulEditTurn.ok, true, 'a successful requested file edit must not be reported as a missing read');
  assert.equal(successfulEditTurn.execution.successfulMutatingTools, 1);
  assert.match(successfulEditTurn.response, /mutation tool success/);
  assert.match(successfulEditTurn.response, /independently read the target/);
  assert.match(successfulEditOutput.join(''), /mutation tool success/);

  const unverifiedReadTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_unverified_read',
    prompt: 'Read bin/codex.js lines 890-902 exactly with read_file. Do not call edit_file or write_file.',
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'session_started', sessionId: 'ses_unverified_read' })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: 'I read those lines and they say the CLI is ready.' })}\n\n`,
      `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  });
  assert.equal(unverifiedReadTurn.ok, false, 'model claims cannot replace a read_file result');
  assert.equal(unverifiedReadTurn.category, 'read_evidence_missing');
  assert.match(unverifiedReadTurn.response, /도구 결과가 없어/);

  const verifiedReadTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_verified_read',
    prompt: 'Read bin/codex.js lines 890-902 exactly with read_file.',
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'session_started', sessionId: 'ses_verified_read' })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'read-1', name: 'read_file' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'read-1', name: 'read_file' }, result: { ok: true, content: 'const verifiedSource = true;' } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: 'The file contains invented content.' })}\n\n`,
      `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  });
  assert.equal(verifiedReadTurn.ok, true);
  assert.match(verifiedReadTurn.response, /const verifiedSource = true;/);
  assert.doesNotMatch(verifiedReadTurn.response, /invented content/);

  const sourceAnalysisOutput = [];
  const sourceAnalysisPrompt = 'Read Sources/AutoWiFi/HealthProbe.swift and Sources/AutoWiFi/NetworkQualityProbe.swift, analyze the throughput failure path.';
  const sourceAnalysisTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_source_analysis', prompt: sourceAnalysisPrompt,
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'session_started', sessionId: 'ses_source_analysis' })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'read-health', name: 'read_file' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'read-health', name: 'read_file', args: { path: 'Sources/AutoWiFi/HealthProbe.swift' } }, result: { ok: true, content: 'RAW HEALTH SOURCE MUST NOT REPLACE ANALYSIS' } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'read-quality', name: 'read_file' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'read-quality', name: 'read_file', args: { path: 'Sources/AutoWiFi/NetworkQualityProbe.swift' } }, result: { ok: true, content: 'RAW NETWORK SOURCE MUST NOT REPLACE ANALYSIS' } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: 'HealthProbe.swift starts a new path monitor. NetworkQualityProbe.swift reports typed failures.' })}\n\n`,
      `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: text => sourceAnalysisOutput.push(text)
  });
  assert.equal(sourceAnalysisTurn.ok, true);
  assert.match(sourceAnalysisTurn.response, /HealthProbe\.swift starts a new path monitor/);
  assert.match(sourceAnalysisTurn.response, /NetworkQualityProbe\.swift reports typed failures/);
  assert.doesNotMatch(sourceAnalysisTurn.response, /RAW .* SOURCE/);

  const incompleteSourceAnalysis = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_incomplete_source_analysis', prompt: sourceAnalysisPrompt,
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'session_started', sessionId: 'ses_incomplete_source_analysis' })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'read-health', name: 'read_file' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'read-health', name: 'read_file', args: { path: 'Sources/AutoWiFi/HealthProbe.swift' } }, result: { ok: true, content: 'health source' } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'read-quality', name: 'read_file' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'read-quality', name: 'read_file', args: { path: 'Sources/AutoWiFi/NetworkQualityProbe.swift' } }, result: { ok: true, content: 'network source' } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: 'HealthProbe.swift was inspected; no other file was discussed.' })}\n\n`,
      `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  });
  assert.equal(incompleteSourceAnalysis.ok, false);
  assert.equal(incompleteSourceAnalysis.category, 'source_analysis_incomplete');
  assert.match(incompleteSourceAnalysis.response, /NetworkQualityProbe\.swift/);
  assert.doesNotMatch(incompleteSourceAnalysis.response, /health source|network source/);

  const longEnglishSourcePrompt = 'Analyze the Auto WiFi throughput recovery path using actual workspace files. Read and cite every exact file below: Sources/AutoWiFi/HealthProbe.swift, Sources/AutoWiFi/NetworkQualityProbe.swift, Sources/AutoWiFi/Persistence.swift, Sources/Algorithms/Hysteresis.swift, Tests/AlgorithmsRunner/Runner.swift.';
  const ungroundedEnglishSourceAnalysis = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_ungrounded_english_source_analysis', prompt: longEnglishSourcePrompt,
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'session_started', sessionId: 'ses_ungrounded_english_source_analysis' })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'read-health', name: 'read_file' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'read-health', name: 'read_file', args: { path: 'Sources/AutoWiFi/HealthProbe.swift' } }, result: { ok: true, content: 'actual source evidence' } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: 'Generic state machine discussion without any requested filenames.' })}\n\n`,
      `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  });
  assert.equal(ungroundedEnglishSourceAnalysis.ok, false, 'natural English source-analysis requests must not bypass evidence coverage');
  assert.equal(ungroundedEnglishSourceAnalysis.category, 'source_analysis_incomplete');
  assert.match(ungroundedEnglishSourceAnalysis.response, /NetworkQualityProbe\.swift/);
  assert.match(ungroundedEnglishSourceAnalysis.response, /Hysteresis\.swift/);

  const codexCommandReadTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_codex_command_read',
    prompt: 'Analyze Sources/AutoWiFi/HealthProbe.swift from the workspace source.',
    workspaceContext: { workspaceRoot: '/workspace/autowifi' },
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'session_started', sessionId: 'ses_codex_command_read' })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'cat-health', name: 'exec_command', args: { command: '/bin/zsh -lc "cat Sources/AutoWiFi/HealthProbe.swift"' } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_output', text: 'struct HealthProbe { let verified = true }' })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'cat-health', name: 'exec_command', args: { command: '/bin/zsh -lc "cat Sources/AutoWiFi/HealthProbe.swift"' } }, result: { exitCode: 0, stdout: '', stderr: '' } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: 'HealthProbe.swift defines the measured throughput probe.' })}\n\n`,
      `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`, 'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  });
  assert.equal(codexCommandReadTurn.ok, true, 'a successful direct Codex cat of a requested workspace file is source evidence');
  assert.match(codexCommandReadTurn.response, /measured throughput probe/);

  const unsafeCodexCommandReadTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_unsafe_codex_command_read',
    prompt: 'Analyze Sources/AutoWiFi/HealthProbe.swift from the workspace source.',
    workspaceContext: { workspaceRoot: '/workspace/autowifi' },
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'session_started', sessionId: 'ses_unsafe_codex_command_read' })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'unsafe-cat', name: 'exec_command', args: { command: 'cat Sources/AutoWiFi/HealthProbe.swift && touch marker' } }, result: { exitCode: 0, stdout: 'struct HealthProbe {}', stderr: '' } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: 'HealthProbe.swift defines the measured throughput probe.' })}\n\n`,
      `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`, 'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  });
  assert.equal(unsafeCodexCommandReadTurn.ok, false, 'shell commands are never accepted as read evidence');
  assert.equal(unsafeCodexCommandReadTurn.category, 'read_evidence_missing');

  const todoListOutput = [];
  const todoListTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_todo_list',
    prompt: 'TODO_ROADMAP.md에서 미완료 TODO 중 소스 작업 가능한 항목 하나를 찾아라.',
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'session_started', sessionId: 'ses_todo_list' })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'todo-list', name: 'read_file' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'todo-list', name: 'read_file' }, result: { ok: true, content: '- [ ] **TODO-REAL-01. Real source item**: verified details\n- [ ] **TODO-REAL-02. Another source item**: more details' } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: 'TODO-FAKE-99 is the safest task.' })}\n\n`,
      `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: text => todoListOutput.push(text)
  });
  assert.equal(todoListTurn.ok, true);
  assert.match(todoListTurn.response, /TODO-REAL-01\. Real source item/);
  assert.doesNotMatch(todoListTurn.response, /TODO-FAKE-99/);
  assert.ok(todoListOutput.join('').includes('TODO-REAL-01'));

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

  const exactTodoSection = '- [ ] **TODO-3FBROWSER-01. Only Chat과 3F Browser 연결 확인**:\n  - 실제 탐색 응답 확인\n  - 페이지 읽기 결과 확인';
  const exactTodoSectionTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_todo_section_grounding',
    prompt: 'TODO-3FBROWSER-01 exact requirements and acceptance-criteria from the source.',
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'todo-read', name: 'read_file' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'todo-read', name: 'read_file' }, result: exactTodoSection } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: 'The requested TODO does not exist.' })}\n\n`,
      `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: () => {}
  });
  assert.equal(exactTodoSectionTurn.ok, true);
  assert.match(exactTodoSectionTurn.response, /TODO-3FBROWSER-01/);
  assert.match(exactTodoSectionTurn.response, /실제 탐색 응답 확인/);
  assert.doesNotMatch(exactTodoSectionTurn.response, /does not exist/);

  const mismatchedTodoSectionTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_todo_section_mismatch',
    prompt: 'TODO-3FBROWSER-01 exact requirements and acceptance-criteria from the source.',
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'todo-read', name: 'read_file' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'todo-read', name: 'read_file' }, result: '- [ ] **TODO-OTHER-02. unrelated item**:\\n  - unrelated evidence' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: 'TODO-3FBROWSER-01 is complete.' })}\n\n`,
      `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: () => {}
  });
  assert.equal(mismatchedTodoSectionTurn.ok, true);
  assert.match(mismatchedTodoSectionTurn.response, /TODO-3FBROWSER-01 원문이 없어 요구사항을 검증하지 못했습니다/);
  assert.doesNotMatch(mismatchedTodoSectionTurn.response, /is complete/);

  const truncatedTodoSectionTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_todo_section_truncated',
    prompt: 'TODO-202 exact requirements and acceptance-criteria from the source.',
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'todo-read', name: 'read_file' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'todo-read', name: 'read_file' }, result: 'File head\n[Only Chat read_file bounded output: omitted 120 middle lines (6000 characters). Call read_file again with start_line and end_line for a specific section.]\nFile tail' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: 'TODO-202 is not in the file.' })}\n\n`,
      `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: () => {}
  });
  assert.equal(truncatedTodoSectionTurn.ok, true);
  assert.match(truncatedTodoSectionTurn.response, /중간 내용이 생략되어 TODO-202 원문을 확인하지 못했습니다/);
  assert.doesNotMatch(truncatedTodoSectionTurn.response, /TODO-202 is not in the file/);

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

  const navigateOutput = [];
  const embeddedNavigateTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_embedded_3f_navigate_grounding',
    prompt: 'Call embedded_3f_navigate with https://example.com/ and report the verified address.',
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'threef-navigate', name: 'embedded_3f_navigate' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'threef-navigate', name: 'embedded_3f_navigate', args: { url: 'https://example.com/' } }, result: { ok: true, addressMatchesRequested: true, requestedUrl: 'https://example.com/', url: 'https://example.com/', stdout: 'verified', stderr: '' } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: '{}' })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: '</tool_call>' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: text => navigateOutput.push(text)
  });
  assert.equal(embeddedNavigateTurn.ok, true, 'a matching navigation readback must recover a malformed model follow-up');
  assert.equal(embeddedNavigateTurn.recoveredFrom, 'invalid_provider_output');
  assert.match(embeddedNavigateTurn.response, /navigate 성공.*https:\/\/example\.com\//);
  assert.ok(!navigateOutput.join('').includes('{}'), 'the malformed navigation follow-up is withheld');

  const historyOutput = [];
  const embeddedHistoryTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_embedded_3f_history_grounding',
    prompt: 'Call embedded_3f_history with action back and report the result.',
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'threef-history', name: 'embedded_3f_history' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'threef-history', name: 'embedded_3f_history', args: { action: 'back' } }, result: { ok: true, stdout: '3F Browser back 완료', stderr: '', url: 'https://www.youtube.com/' } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: '{}' })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: '</tool_call>' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: text => historyOutput.push(text)
  });
  assert.equal(embeddedHistoryTurn.ok, true, 'a verified browser history result must recover a malformed model follow-up');
  assert.equal(embeddedHistoryTurn.recoveredFrom, 'invalid_provider_output');
  assert.match(embeddedHistoryTurn.response, /back 완료, 현재 주소 https:\/\/www\.youtube\.com\//);
  assert.ok(!historyOutput.join('').includes('{}'), 'the malformed empty history follow-up is withheld');

  const failedEmbeddedHistoryTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_embedded_3f_history_failed',
    prompt: 'Call embedded_3f_history with action forward and report the result.',
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'threef-history-fail', name: 'embedded_3f_history' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'threef-history-fail', name: 'embedded_3f_history', args: { action: 'forward' } }, result: { ok: false, stderr: 'No safe forward page is available.', url: 'https://www.youtube.com/' } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: '{}' })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: '</tool_call>' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: () => {}
  });
  assert.equal(failedEmbeddedHistoryTurn.ok, true, 'the CLI can report a grounded tool failure as a completed response');
  assert.match(failedEmbeddedHistoryTurn.response, /embedded_3f_history 실패 또는 미검증: No safe forward page is available/);

  const fencedStatusTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_embedded_3f_fence_status',
    prompt: 'Use embedded_3f_status and report the exact status.',
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'threef-status', name: 'embedded_3f_status' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'threef-status', name: 'embedded_3f_status' }, result: { available: true, isOpen: true, activeUrl: 'about:blank', controlAvailable: true, statusText: 'Focus Fence 정책을 확인할 수 없어 브라우저 접근을 중단했습니다.' } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: '{}' })}\n\n`,
      `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: () => {}
  });
  assert.match(fencedStatusTurn.response, /Focus Fence 정책을 확인할 수 없어 브라우저 접근을 중단했습니다/);

  const emptyEmbeddedReadTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_embedded_3f_empty_read',
    prompt: 'Call embedded_3f_read and report whether page text was returned.',
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'threef-read', name: 'embedded_3f_read' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'threef-read', name: 'embedded_3f_read' }, result: { ok: true, stdout: '', stderr: '' } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: 'The page was read successfully.' })}\n\n`,
      `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: () => {}
  });
  assert.match(emptyEmbeddedReadTurn.response, /페이지 텍스트와 오류가 모두 비어 있어 읽기 성공을 검증하지 못했습니다/);
  assert.doesNotMatch(emptyEmbeddedReadTurn.response, /read successfully/);

  const failedEmbeddedReadTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_embedded_3f_failed_read',
    prompt: 'Call embedded_3f_read and report the error.',
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'threef-read', name: 'embedded_3f_read' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'threef-read', name: 'embedded_3f_read' }, result: { ok: false, stdout: '', stderr: 'Focus Fence policy is unavailable.' } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: 'The read worked.' })}\n\n`,
      `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: () => {}
  });
  assert.match(failedEmbeddedReadTurn.response, /embedded_3f_read 실패: Focus Fence policy is unavailable/);
  assert.doesNotMatch(failedEmbeddedReadTurn.response, /read worked/);

  const failedReadOutput = [];
  const failedReadTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_read_failure_grounding',
    prompt: 'Call read_file for TODO_ROADMAP.md and return the exact TODO-202 acceptance criteria.',
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'roadmap-read', name: 'read_file' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'roadmap-read', name: 'read_file' }, result: { error: 'The path argument must be a string. access_token=hidden' } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: '{}' })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: '</tool_call>' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: text => failedReadOutput.push(text)
  });
  assert.equal(failedReadTurn.ok, true, 'a grounded tool failure can be delivered as a completed CLI response');
  assert.match(failedReadTurn.response, /Only Chat 도구 실행 실패 \(1건\):\nread_file: The path argument must be a string/);
  assert.doesNotMatch(failedReadTurn.response, /TODO-202 .*완료|access_token=hidden/);
  assert.ok(!failedReadOutput.join('').includes('{}'), 'malformed output is suppressed while the tool failure is recovered');

  const registryListOutput = [];
  const registryListTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_task_registry_list_grounding',
    prompt: 'Call task_registry_list and report exact task IDs, titles, statuses, and owners.',
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'registry-list', name: 'task_registry_list' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'registry-list', name: 'task_registry_list' }, result: [{ taskKey: 'onlychat-goal-1', title: 'Only Chat goal', status: 'blocked', ownerChatId: null, blocker: 'private blocker', repositoryPath: '/private/path' }] } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: '{"name":"task_registry_list","arguments":{"limit":10}}' })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: '</tool_call>' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: text => registryListOutput.push(text)
  });
  assert.equal(registryListTurn.ok, true);
  assert.equal(registryListTurn.recoveredFrom, 'invalid_provider_output');
  assert.match(registryListTurn.response, /onlychat-goal-1 \| Only Chat goal \| blocked \| 담당자: 미할당/);
  assert.doesNotMatch(registryListTurn.response, /private blocker|\/private\/path/);
  assert.doesNotMatch(registryListOutput.join(''), /private blocker|\/private\/path/);

  const registryReadTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_task_registry_read_grounding',
    prompt: 'Call task_registry_read with taskKey exactly onlychat-evolution-loop-20261103 and report nextAction/blocker.',
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'registry-read', name: 'task_registry_read' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'registry-read', name: 'task_registry_read' }, result: { taskKey: 'onlychat-evolution-loop-20261103', title: 'Goal loop', status: 'blocked', ownerChatId: null, checkpoint: { nextAction: 'Use a verified free dispatcher provider.', blocker: 'dispatcher.ready=false, no_verified_free_provider' }, privateMessages: ['do not expose'] } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: '{}' })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: '</tool_call>' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: () => {}
  });
  assert.equal(registryReadTurn.ok, true);
  assert.equal(registryReadTurn.recoveredFrom, 'invalid_provider_output');
  assert.match(registryReadTurn.response, /onlychat-evolution-loop-20261103 .* blocked .* 담당자: 미할당/);
  assert.match(registryReadTurn.response, /다음 조치: Use a verified free dispatcher provider/);
  assert.match(registryReadTurn.response, /차단 사유: dispatcher\.ready=false, no_verified_free_provider/);
  assert.doesNotMatch(registryReadTurn.response, /do not expose/);

  const mismatchedRegistryReadTurn = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899', sessionId: 'session_task_registry_read_mismatch',
    prompt: 'Call task_registry_read with taskKey exactly onlychat-evolution-loop-20261103.',
    fetchImpl: async () => new Response([
      `data: ${JSON.stringify({ type: 'tool_start', call: { id: 'registry-read', name: 'task_registry_read' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_end', result: { call: { id: 'registry-read', name: 'task_registry_read' }, result: { taskKey: 'other-task', title: 'Wrong task', status: 'complete' } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: 'The requested task is complete.' })}\n\n`,
      `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: () => {}
  });
  assert.match(mismatchedRegistryReadTurn.response, /작업 ID가 요청한 onlychat-evolution-loop-20261103와 일치하지 않아 세부 상태를 검증하지 못했습니다/);
  assert.doesNotMatch(mismatchedRegistryReadTurn.response, /Wrong task|complete/);

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
