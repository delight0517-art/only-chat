'use strict';

const assert = require('node:assert/strict');
const { parseGoalDuration, parseChatCommand, safeToolError, streamOnlyChatTurn, runOnlyChatGoal } = require('../bin/codex.js');

async function main() {
  assert.equal(parseGoalDuration('3h'), 10_800_000);
  assert.throws(() => parseGoalDuration('4h'), /1분에서 3시간/);
  assert.throws(() => parseGoalDuration('0m'), /1분에서 3시간/);
  const args = parseChatCommand(['--duration', '2h', '--fixed-duration', '--approve-tool', 'edit_file', '이 목표를 계속 진행']);
  assert.equal(args.durationMs, 7_200_000);
  assert.equal(args.fixedDuration, true);
  assert.equal(args.model, 'gemini-3.8-flash-medium');
  assert.throws(() => parseChatCommand(['--approve-tool', 'exec_command', 'unsafe']), /승인 가능 도구/);
  assert.equal(safeToolError({ error: 'MCP bridge failed Bearer abc.def; access_token=secret user@example.com' }),
    'MCP bridge failed Bearer [redacted]; access_token=[redacted] [redacted-email]');
  assert.equal(safeToolError({ isError: true, content: [{ type: 'text', text: 'File unavailable; access_token=hidden' }] }),
    'File unavailable; access_token=[redacted]');
  assert.equal(safeToolError('const error = "file not found";'), '', 'successful tool text must never be printed as an error');

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
  const blockedGoal = await runOnlyChatGoal({
    baseUrl: 'http://127.0.0.1:8899', prompt: 'blocked goal', durationMs: 1_000, fixedDuration: true,
    fetchImpl: async () => {
      now += 100;
      return new Response([
        `data: ${JSON.stringify({ type: 'session_started', sessionId: 'ses_0123456789abcdef' })}\n\n`,
        `data: ${JSON.stringify({ type: 'message_delta', delta: 'GOAL_BLOCKED' })}\n\n`,
        `data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`,
        'data: [DONE]\n\n'
      ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    now: () => now, write: () => {}
  });
  assert.equal(blockedGoal.ok, false);
  assert.equal(blockedGoal.category, 'goal_blocked', 'fixed-duration stops instead of idling when no safe next step exists');

  console.log('Only Chat CLI duration, scoped approval, and SSE response checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
