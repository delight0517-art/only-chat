'use strict';

const assert = require('node:assert/strict');
const { parseGoalDuration, parseChatCommand, streamOnlyChatTurn } = require('../bin/codex.js');

async function main() {
  assert.equal(parseGoalDuration('3h'), 10_800_000);
  assert.throws(() => parseGoalDuration('4h'), /1분에서 3시간/);
  assert.throws(() => parseGoalDuration('0m'), /1분에서 3시간/);
  const args = parseChatCommand(['--duration', '2h', '--approve-tool', 'edit_file', '이 목표를 계속 진행']);
  assert.equal(args.durationMs, 7_200_000);
  assert.equal(args.model, 'gemini-3.8-flash-medium');
  assert.throws(() => parseChatCommand(['--approve-tool', 'exec_command', 'unsafe']), /승인 가능 도구/);

  const writes = [];
  const approvals = [];
  const events = [
    { type: 'session_started', sessionId: 'ses_0123456789abcdef' },
    { type: 'tier_resolved', tier: { name: 'Antigravity', model: 'gemini-3.8-flash-medium' } },
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

  console.log('Only Chat CLI duration, scoped approval, and SSE response checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
