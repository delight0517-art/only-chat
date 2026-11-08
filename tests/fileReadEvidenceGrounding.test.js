'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { streamOnlyChatTurn } = require('../bin/codex.js');

function eventStream(events) {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
}

test('file-read profile refuses ungrounded analysis and returns the exact source evidence', async () => {
  const source = '<h3>시간대별 기본 타이머</h3>\n<p>지정한 시간대에는 집중/휴식 시간을 사용합니다.</p>';
  const events = [
    { type: 'session_started', sessionId: 'session_file_read_grounding' },
    { type: 'tool_start', call: { id: 'read-ui', name: 'read_file' } },
    { type: 'tool_end', result: { call: { id: 'read-ui', name: 'read_file', args: { path: 'renderer/dashboard/index.html', start_line: 323, end_line: 324 } }, result: source } },
    { type: 'message_delta', delta: 'The UI has no morning timer setting.' },
    { type: 'turn_complete' }
  ];
  const output = [];
  const result = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899',
    sessionId: 'session_file_read_grounding',
    prompt: 'Read renderer/dashboard/index.html and explain whether the morning timer setting exists. Include an exact quote.',
    toolProfile: 'file-read',
    fetchImpl: async () => new Response(eventStream(events), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: value => output.push(value)
  });

  assert.equal(result.ok, false);
  assert.equal(result.category, 'source_analysis_incomplete');
  assert.match(result.response, /요청한 근거 파일 index\.html/);
  assert.match(result.response, /Only Chat read_file 실제 결과/);
  assert.match(result.response, /시간대별 기본 타이머/);
  assert.doesNotMatch(result.response, /The UI has no morning timer setting/);
  assert.match(output.join(''), /지정한 시간대에는 집중\/휴식 시간을 사용합니다/);
});

test('file-read profile fails closed when the model answers without a successful read_file result', async () => {
  const events = [
    { type: 'session_started', sessionId: 'session_missing_read' },
    { type: 'message_delta', delta: 'The requested source does not exist.' },
    { type: 'turn_complete' }
  ];
  const result = await streamOnlyChatTurn({
    baseUrl: 'http://127.0.0.1:8899',
    sessionId: 'session_missing_read',
    prompt: 'Read TODO.md and return its contents.',
    toolProfile: 'file-read',
    fetchImpl: async () => new Response(eventStream(events), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write: () => {}
  });

  assert.equal(result.ok, false);
  assert.equal(result.category, 'read_evidence_missing');
  assert.match(result.response, /read_file 도구 결과가 없어/);
});
