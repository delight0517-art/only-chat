import assert from 'node:assert/strict';
import { createOllamaAdapter } from '../src/features/provider/v1.mjs';

let requestUrl = '';
let requestBody = null;
const adapter = createOllamaAdapter({ fetch: async (url, init) => {
  requestUrl = url;
  requestBody = JSON.parse(init.body);
  return new Response(JSON.stringify({
    choices: [{ message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'status-1', type: 'function', function: { name: 'embedded_3f_status', arguments: '{}' } }]
    } }]
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
} });

const result = await adapter.call(
  { model: 'qwen2.5:3b' },
  [{ role: 'user', content: 'Only Chat의 embedded_3f_status를 호출해 3F Browser 연결 상태만 확인해.' }],
  {},
  { approvalPolicy: 'read-only' }
);

assert.equal(requestUrl, 'http://127.0.0.1:11434/v1/chat/completions');
assert.deepEqual(requestBody.tools.map(tool => tool.function.name), ['embedded_3f_status']);
assert.deepEqual(requestBody.tool_choice, { type: 'function', function: { name: 'embedded_3f_status' } });
assert.deepEqual(result.toolCalls, [{ id: 'status-1', name: 'embedded_3f_status', args: {} }]);

console.log('Only Chat local 3F status profile: PASS');
