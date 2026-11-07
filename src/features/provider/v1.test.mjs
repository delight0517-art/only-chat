import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccountRouterAdapter, createOllamaAdapter, DEFAULT_OLLAMA_BASE_URL, normalizeBaseUrl, parseToolCalls, toolDefinitions } from './v1.mjs';
const { AgentEngine } = await import('../../core/AgentEngine.js');

assert.equal(normalizeBaseUrl(), 'http://127.0.0.1:18880');
assert.throws(() => normalizeBaseUrl('https://example.com'), /loopback/);
assert.throws(() => normalizeBaseUrl('http://example.com'), /loopback/);
assert.throws(() => normalizeBaseUrl('http://user:pass@127.0.0.1:18880'), /loopback/);
assert.deepEqual(parseToolCalls([{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }]), [
  { id: 'call-1', name: 'read_file', args: { path: 'README.md' } }
]);
assert.equal(parseToolCalls([{ function: { name: 'read_file', arguments: '{}' } }, { function: { name: 'read_file', arguments: '{}' } }])[1].id, 'router-1-read_file');
assert.throws(() => parseToolCalls([{ function: { name: 'read_file', arguments: '[]' } }]), /invalid tool arguments/);
assert.throws(() => parseToolCalls([{ id: 7, function: { name: 'read_file', arguments: '{}' } }]), /invalid tool call ID/);
assert.throws(() => parseToolCalls([{ id: '  ', function: { name: 'read_file', arguments: '{}' } }]), /invalid tool call ID/);
assert.throws(() => parseToolCalls([
  { id: 'duplicate', function: { name: 'read_file', arguments: '{}' } },
  { id: 'duplicate', function: { name: 'read_file', arguments: '{}' } }
]), /duplicate tool call IDs/);
assert.throws(() => parseToolCalls([{ function: { name: 'vault_get_credential', arguments: '{}' } }]), /unavailable/);
assert.ok(toolDefinitions().some(tool => tool.function.name === 'exec_command'));
assert.ok(toolDefinitions().some(tool => tool.function.name === 'gmail_send'));
assert.ok(toolDefinitions().some(tool => tool.function.name === 'google_drive_read'));
assert.ok(!toolDefinitions().some(tool => tool.function.name === 'vault_get_credential'));
assert.deepEqual(toolDefinitions('on-request', 'file-edit').map(tool => tool.function.name), ['read_file', 'edit_file']);
assert.deepEqual(toolDefinitions('on-request', 'file-write').map(tool => tool.function.name), ['read_file', 'write_file']);
assert.deepEqual(toolDefinitions('on-request', 'file-read').map(tool => tool.function.name), ['read_file'], 'file-read must not expose edit_file to the model');
assert.deepEqual(toolDefinitions('on-request', 'no-tools'), [], 'no-tools must expose no callable functions');
assert.deepEqual(toolDefinitions('read-only', 'file-edit').map(tool => tool.function.name), ['read_file'], 'tool profiles must intersect with the read-only policy');
assert.deepEqual(toolDefinitions('read-only', 'file-write').map(tool => tool.function.name), ['read_file'], 'read-only policy must suppress file writes');
const fileReadTool = toolDefinitions('on-request', 'file-edit').find(tool => tool.function.name === 'read_file').function;
assert.deepEqual(fileReadTool.parameters.required, ['path']);
assert.match(fileReadTool.parameters.properties.end_line.description, /inclusive 1-based last line, not a line count/i);
assert.match(fileReadTool.parameters.properties.end_line.description, /start_line=151 and end_line=152/i);
assert.equal(fileReadTool.parameters.properties.path.description.includes('TODO_ROADMAP.md'), true);
assert.match(fileReadTool.description, /never prepend the project name or use a filesystem-root path/);
assert.match(fileReadTool.description, /small range.*do not load a large document wholesale/i);
const fileWriteTool = toolDefinitions('on-request', 'file-write').find(tool => tool.function.name === 'write_file').function;
assert.deepEqual(fileWriteTool.parameters.required, ['path', 'content']);
assert.match(fileWriteTool.parameters.properties.path.description, /exact workspace-relative path explicitly approved/);
assert.equal(DEFAULT_OLLAMA_BASE_URL, 'http://127.0.0.1:11434');

const discoveryEngine = Object.create(AgentEngine.prototype);
discoveryEngine.isolated = false;
discoveryEngine.accountRouterReadiness = { verified: false };
const originalTier = { id: 'codex-primary', provider: 'codex' };
discoveryEngine.priorityChain = {
  chain: { enabled: true, tiers: [originalTier] },
  adoptAccountRouter() { return false; },
  upsertTier(tier) { this.chain.tiers.push(tier); }
};
discoveryEngine.accountRouterAdapter = { getChain: async () => ({ enabled: true, accounts: [{ id: 'provider-1', enabled: true, provider: 'openai', model: 'gpt-model' }] }) };
assert.equal(await discoveryEngine._ensureAccountRouterTier(), true);
assert.deepEqual(discoveryEngine.priorityChain.chain.tiers.map(tier => tier.id), ['codex-primary', 'account-router-local']);
assert.equal(await discoveryEngine._ensureAccountRouterTier(), false, 'a discovered Router tier is not duplicated');
const existingRouterEngine = Object.create(AgentEngine.prototype);
existingRouterEngine.isolated = false;
existingRouterEngine.accountRouterDiscoveryRetryAt = 0;
existingRouterEngine.accountRouterReadiness = { verified: false };
const existingRouterTier = { id: 'account-router-local', provider: 'account-router', model: 'auto' };
existingRouterEngine.priorityChain = { chain: { enabled: true, tiers: [existingRouterTier] }, adoptAccountRouter() { return false; }, upsertTier() { throw new Error('an existing Router tier must not be duplicated'); } };
let existingRouterDiscoveryCount = 0;
existingRouterEngine.accountRouterAdapter = { getChain: async () => {
  existingRouterDiscoveryCount += 1;
  return { enabled: true, providerState: 'unverified', accounts: [{ id: 'provider-1', enabled: true, provider: 'openai', model: 'gpt-model' }] };
} };
assert.equal(await existingRouterEngine._ensureAccountRouterTier(), false);
assert.equal(existingRouterDiscoveryCount, 1, 'a persisted Router tier still refreshes shared Router state');
assert.equal(existingRouterEngine.accountRouterReadiness.state, 'unverified');
assert.equal(existingRouterEngine.priorityChain.chain.tiers.length, 1);
const emptyRouterEngine = Object.create(AgentEngine.prototype);
emptyRouterEngine.isolated = false;
emptyRouterEngine.priorityChain = { chain: { enabled: true, tiers: [originalTier] }, upsertTier() { throw new Error('empty profiles must not alter the chain'); } };
emptyRouterEngine.accountRouterAdapter = { getChain: async () => ({ enabled: true, accounts: [{ id: 'demo', enabled: true, provider: 'demo', model: 'demo-model' }] }) };
assert.equal(await emptyRouterEngine._ensureAccountRouterTier(), false);

let request;
const adapter = createAccountRouterAdapter({ fetch: async (url, init) => {
  request = { url, init };
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hello', tool_calls: [] } }], usage: { total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
} });
const metadataAdapter = createAccountRouterAdapter({ fetch: async url => {
  assert.equal(url, 'http://127.0.0.1:18880/api/v1/account-chain');
  return new Response(JSON.stringify({ apiVersion: 1, enabled: true, accounts: [] }), { status: 200 });
} });
assert.deepEqual(await metadataAdapter.getChain(), { apiVersion: 1, enabled: true, accounts: [] });
const deltas = [];
const routerHistory = [{ role: 'user', content: 'hi' }];
const result = await adapter.call({ model: 'auto' }, routerHistory, { onMessageDelta: text => deltas.push(text) });
assert.equal(request.url, 'http://127.0.0.1:18880/v1/chat/completions');
const payload = JSON.parse(request.init.body);
assert.equal(payload.model, 'auto');
assert.equal(payload.messages[0].role, 'system');
assert.match(payload.messages[0].content, /“막힘”은 조사와 다음 행동이 끝난 상태가 아니라/);
assert.deepEqual(payload.messages[1], { role: 'user', content: 'hi' });
assert.deepEqual(routerHistory, [{ role: 'user', content: 'hi' }], 'Router guidance injection must not mutate caller history');
assert.equal(payload.stream, false);
assert.equal(payload.tool_choice, 'auto');
assert.deepEqual(payload.tools.map(item => item.function.name), toolDefinitions().map(item => item.function.name), 'default policy exposes the current complete provider tool set');
for (const name of ['joint_development_list', 'joint_development_read', 'joint_development_assess', 'joint_development_create']) {
  assert.ok(payload.tools.some(tool => tool.function.name === name), `default policy exposes ${name}`);
}
assert.equal(request.init.headers.Authorization, undefined);
assert.deepEqual(result, { content: 'hello', toolCalls: [], usage: { total_tokens: 2 }, protocol: 'openai-compatible' });
assert.deepEqual(deltas, ['hello']);

const timeoutAdapter = createAccountRouterAdapter({
  timeoutMs: 20,
  fetch: async (_url, init) => new Promise((_resolve, reject) => {
    const rejectOnAbort = () => reject(init.signal.reason);
    if (init.signal.aborted) rejectOnAbort();
    else init.signal.addEventListener('abort', rejectOnAbort, { once: true });
  })
});
let timeoutFallback;
const timeoutOutcome = await Promise.race([
  timeoutAdapter.call({ model: 'gpt-6-luna' }, [{ role: 'user', content: 'diagnose' }], {}, {
    signal: new AbortController().signal
  }).then(() => null, error => error),
  new Promise(resolve => { timeoutFallback = setTimeout(() => resolve(null), 250); })
]);
clearTimeout(timeoutFallback);
assert.ok(timeoutOutcome instanceof Error, 'the provider request must honor its timeout when a caller signal is also supplied');
assert.match(timeoutOutcome.message, /AI Account Router request timed out or was cancelled/);

let noToolsRouterRequest;
const noToolsRouter = createAccountRouterAdapter({ fetch: async (_url, init) => {
  noToolsRouterRequest = JSON.parse(init.body);
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ONLYCHAT_ROUTER_TEXT_OK' } }] }), { status: 200 });
} });
const noToolsRouterResult = await noToolsRouter.call({ model: 'gpt-6-luna' }, [{ role: 'user', content: 'Reply exactly. Do not use tools.' }]);
assert.deepEqual(noToolsRouterRequest.tools, [], 'Router text-only turns must send no tool definitions');
assert.equal(noToolsRouterRequest.messages[0].role, 'system', 'Router guidance applies to the primary AI route');
assert.match(noToolsRouterRequest.messages[0].content, /막혔다고 보고하기 전에는 관찰된 상태가 정확히 어떤 작업을 막는지 확인하고/);
assert.equal(noToolsRouterRequest.tool_choice, 'none', 'Router text-only turns must explicitly disable tool calls');
assert.equal(noToolsRouterResult.content, 'ONLYCHAT_ROUTER_TEXT_OK');
const statusRouterRequests = [];
const statusRouter = createAccountRouterAdapter({ fetch: async (_url, init) => {
  const body = JSON.parse(init.body);
  statusRouterRequests.push(body);
  const responseMessage = statusRouterRequests.length === 1
    ? { role: 'assistant', content: '', tool_calls: [
      { id: 'status-only', type: 'function', function: { name: 'embedded_3f_status', arguments: '{}' } }
    ] }
    : { role: 'assistant', content: 'Status received.', tool_calls: [] };
  return new Response(JSON.stringify({ choices: [{ message: responseMessage }] }), { status: 200 });
} });
const statusHistory = [{ role: 'user', content: 'Use embedded_3f_status.' }];
const statusResult = await statusRouter.call({ model: 'qwen2.5:3b' }, statusHistory, {}, {
  approvalPolicy: 'read-only', toolProfile: 'embedded-3f-status'
});
assert.deepEqual(statusRouterRequests[0].tools.map(tool => tool.function.name), ['embedded_3f_status'], '3F status profile exposes only the read-only status tool');
assert.deepEqual(statusRouterRequests[0].tool_choice, { type: 'function', function: { name: 'embedded_3f_status' } }, 'initial 3F status request forces the status function');
assert.equal(statusResult.toolCalls[0].name, 'embedded_3f_status');
statusHistory.push(
  { role: 'assistant', tool_calls: [{ id: 'status-only', type: 'function', function: { name: 'embedded_3f_status', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'status-only', content: '3F Browser status: connected' }
);
await statusRouter.call({ model: 'qwen2.5:3b' }, statusHistory, {}, {
  approvalPolicy: 'read-only', toolProfile: 'embedded-3f-status'
});
assert.deepEqual(statusRouterRequests[1].tools.map(tool => tool.function.name), ['embedded_3f_status'], '3F follow-up continues to expose only the status tool');
assert.equal(statusRouterRequests[1].tool_choice, 'auto', 'after the status tool result, the Router may finish without another call');
assert.deepEqual(statusRouterRequests[1].messages.slice(-2), statusHistory.slice(-2), 'follow-up includes matching assistant tool_call and tool result messages');
let standaloneRouterRequest;
const standaloneStatusRouter = createAccountRouterAdapter({ fetch: async (_url, init) => {
  standaloneRouterRequest = JSON.parse(init.body);
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
    { id: 'standalone-only', type: 'function', function: { name: 'browser_status', arguments: '{}' } }
  ] } }] }), { status: 200 });
} });
const standaloneStatusResult = await standaloneStatusRouter.call({ model: 'gpt-6-luna' }, [
  { role: 'user', content: 'Use threef_browser_status to inspect the independent 3F Browser.' }
], {}, { approvalPolicy: 'read-only', toolProfile: 'threef-browser-status' });
assert.deepEqual(standaloneRouterRequest.tools.map(tool => tool.function.name), ['browser_status'], 'standalone 3F profile exposes only the external browser status tool');
assert.deepEqual(standaloneRouterRequest.tool_choice, { type: 'function', function: { name: 'browser_status' } }, 'standalone status profile forces the correct tool on its initial request');
assert.equal(standaloneStatusResult.toolCalls[0].name, 'browser_status');
let inferredStandaloneTools;
const inferredStandaloneOllama = createOllamaAdapter({ fetch: async (_url, init) => {
  const request = JSON.parse(init.body);
  inferredStandaloneTools = request.tools.map(tool => tool.function.name);
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
    { id: 'standalone-local', type: 'function', function: { name: 'browser_status', arguments: '{}' } }
  ] } }] }), { status: 200 });
} });
const inferredStandaloneResult = await inferredStandaloneOllama.call({ model: 'qwen2.5:3b' }, [
  { role: 'user', content: '3F Browser 연결 상태를 확인해.' }
]);
assert.deepEqual(inferredStandaloneTools, ['browser_status'], 'ordinary 3F status wording defaults to the standalone browser tool');
assert.equal(inferredStandaloneResult.toolCalls[0].name, 'browser_status');
const readOnlyRouterRequests = [];
const readOnlyRouter = createAccountRouterAdapter({ fetch: async (_url, init) => {
  const body = JSON.parse(init.body);
  readOnlyRouterRequests.push(body);
  return new Response(JSON.stringify({ choices: [{ message: readOnlyRouterRequests.length === 1
    ? { role: 'assistant', content: '', tool_calls: [
      { id: 'todo-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"TODO_ROADMAP.md","start_line":240,"end_line":252}' } }
    ] }
    : { role: 'assistant', content: 'Read result received.', tool_calls: [] } }] }), { status: 200 });
} });
await readOnlyRouter.call({ model: 'gpt-6-luna' }, [{ role: 'user', content: 'Read TODO-3FBROWSER-01.' }], {}, {
  approvalPolicy: 'read-only', toolProfile: 'file-read'
});
await readOnlyRouter.call({ model: 'gpt-6-luna' }, [
  { role: 'user', content: 'Read TODO-3FBROWSER-01.' },
  { role: 'assistant', tool_calls: [{ id: 'todo-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"TODO_ROADMAP.md"}' } }] },
  { role: 'tool', tool_call_id: 'todo-read', content: 'TODO source' }
], {}, { approvalPolicy: 'read-only', toolProfile: 'file-read' });
assert.deepEqual(readOnlyRouterRequests[0].tools.map(tool => tool.function.name), ['read_file']);
assert.deepEqual(readOnlyRouterRequests[0].tool_choice, { type: 'function', function: { name: 'read_file' } }, 'Router must execute the first read in an explicit file-read task');
assert.equal(readOnlyRouterRequests[1].tool_choice, 'auto', 'after read evidence arrives Router may finish without repeating tools');
const violatingNoToolsRouter = createAccountRouterAdapter({ fetch: async () => new Response(JSON.stringify({ choices: [{ message: {
  role: 'assistant', content: '', tool_calls: [{ id: 'unexpected-no-tools', type: 'function', function: { name: 'read_file', arguments: '{"path":"TODO.md"}' } }]
} }] }), { status: 200 }) });
await assert.rejects(
  violatingNoToolsRouter.call({ model: 'gpt-6-luna' }, [{ role: 'user', content: 'Do not use tools.' }]),
  /tool call for a no-tools request/
);

let ollamaRequest;
const ollamaAdapter = createOllamaAdapter({ fetch: async (url, init) => {
  ollamaRequest = { url, init };
  return new Response(JSON.stringify({ choices: [{ message: {
    role: 'assistant', content: '', tool_calls: [{ id: 'ollama-read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"TODO.md"}' } }]
  } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
} });
const ollamaResult = await ollamaAdapter.call({ model: 'qwen2.5:7b' }, [{ role: 'user', content: 'Read the TODO.' }], {}, { approvalPolicy: 'on-request', toolProfile: 'file-edit' });
assert.equal(ollamaRequest.url, 'http://127.0.0.1:11434/v1/chat/completions');
assert.equal(JSON.parse(ollamaRequest.init.body).model, 'qwen2.5:7b');
const ollamaTools = JSON.parse(ollamaRequest.init.body).tools.map(item => item.function.name);
assert.deepEqual(ollamaTools, ['read_file', 'edit_file'], 'a compact file-edit profile keeps the local-model tool schema within context');
const ollamaMessages = JSON.parse(ollamaRequest.init.body).messages;
assert.equal(ollamaMessages[0].role, 'system');
assert.match(ollamaMessages[0].content, /ordinary conversation.*without calling tools/i);
assert.match(ollamaMessages[0].content, /preserve explicit checkboxes and negations/i, 'the local assistant must preserve explicit TODO state');
assert.match(ollamaMessages[0].content, /distinguish source or test evidence from live runtime evidence/i, 'local summaries must not promote source checks into runtime proof');
assert.match(ollamaMessages[0].content, /\[ \] means unchecked\/open\/incomplete and \[x\] or \[X\] means checked\/complete/i, 'local summaries must interpret TODO checkbox markers correctly');
assert.match(ollamaMessages[0].content, /end_line must be greater than or equal to start_line/i, 'the local assistant must construct ordered inclusive line ranges');
assert.match(ollamaMessages[0].content, /확인하지 않은 일을 완료했다고 말하지 않는다/, 'local summaries must not invent unobserved completion evidence');
assert.deepEqual(ollamaMessages.at(-1), { role: 'user', content: 'Read the TODO.' });
assert.deepEqual(ollamaResult.toolCalls, [{ id: 'ollama-read-1', name: 'read_file', args: { path: 'TODO.md' } }]);
let readOnlyOllamaTools;
const readOnlyOllama = createOllamaAdapter({ fetch: async (_url, init) => {
  readOnlyOllamaTools = JSON.parse(init.body).tools.map(item => item.function.name);
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'read only' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
} });
await readOnlyOllama.call({ model: 'qwen2.5:3b' }, [{ role: 'user', content: 'Read only.' }], {}, { approvalPolicy: 'on-request', toolProfile: 'file-read' });
assert.deepEqual(readOnlyOllamaTools, ['read_file'], 'file-read profile must send only read_file to Ollama');
const violatingReadOnlyOllama = createOllamaAdapter({ fetch: async () => new Response(JSON.stringify({ choices: [{ message: {
  role: 'assistant', content: '', tool_calls: [{ id: 'edit-under-read-only', type: 'function', function: { name: 'edit_file', arguments: '{"path":"TODO.md","target":"old","replacement":"new"}' } }]
} }] }), { status: 200, headers: { 'content-type': 'application/json' } }) });
await assert.rejects(
  violatingReadOnlyOllama.call({ model: 'qwen2.5:3b' }, [{ role: 'user', content: 'Read only.' }], {}, { approvalPolicy: 'on-request', toolProfile: 'file-read' }),
  /outside the selected file-read tool profile/
);
let defaultOllamaTools;
const defaultProfileOllama = createOllamaAdapter({ fetch: async (_url, init) => {
  defaultOllamaTools = JSON.parse(init.body).tools.map(item => item.function.name);
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'local reply' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
} });
await defaultProfileOllama.call({ model: 'qwen2.5:3b' }, [{ role: 'user', content: 'Reply briefly.' }]);
assert.deepEqual(defaultOllamaTools, ['read_file', 'edit_file'], 'Ollama defaults to the compact workspace file tool profile');
const todoEvidenceHistory = [
  { role: 'user', content: 'Read TODO-PRIO-01 and tell me its status.' },
  { role: 'assistant', tool_calls: [{ id: 'read-todo', type: 'function', function: { name: 'read_file', arguments: '{"path":"TODO_ROADMAP.md"}' } }] },
  { role: 'tool', tool_call_id: 'read-todo', content: '- [ ] **TODO-PRIO-01. Verify model, account, current selection, and 10% fallback.\n  - The installed UI and activeTier disagree; these fields do not prove a provider call.' }
];
const hallucinatedTodoOllama = createOllamaAdapter({ fetch: async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'The marker [x] proves a successful provider call.' } }] }), { status: 200 }) });
const hallucinatedTodoDeltas = [];
const verifiedTodoResult = await hallucinatedTodoOllama.call({ model: 'qwen2.5:3b' }, todoEvidenceHistory, { onMessageDelta: text => hallucinatedTodoDeltas.push(text) }, { toolProfile: 'file-edit' });
assert.equal(verifiedTodoResult.content, '원문 검증 결과: TODO-PRIO-01 [ ] (미완료). 원문은 현재 UI/status 값만으로 실제 provider 호출을 증명할 수 없다고 명시합니다.', 'contradictory local TODO summaries are replaced with source-grounded status');
assert.deepEqual(hallucinatedTodoDeltas, [verifiedTodoResult.content], 'only the verified TODO status is streamed to the user');
const missingTodoEvidenceHistory = [
  { role: 'user', content: 'Read TODO-PRIO-02 and tell me its status.' },
  ...todoEvidenceHistory.slice(1)
];
const missingTodoEvidenceResult = await hallucinatedTodoOllama.call({ model: 'qwen2.5:3b' }, missingTodoEvidenceHistory, {}, { toolProfile: 'file-edit' });
assert.equal(missingTodoEvidenceResult.content, '읽은 원문에서 TODO-PRIO-02 항목을 찾지 못해 상태를 확인할 수 없습니다.', 'a local model cannot invent the status of a requested TODO ID absent from a successful read');
const failedTodoReadResult = await hallucinatedTodoOllama.call({ model: 'qwen2.5:3b' }, [
  { role: 'user', content: 'Read TODO-PRIO-02 and tell me its status.' },
  { role: 'assistant', tool_calls: [{ id: 'failed-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"TODO_ROADMAP.md","start_line":22,"end_line":22}' } }] },
  { role: 'tool', tool_call_id: 'failed-read', content: '{"error":"start_line exceeds file length (3 lines)."}' }
], {}, { toolProfile: 'file-edit' });
assert.equal(failedTodoReadResult.content, 'TODO 원문을 읽지 못해 TODO-PRIO-02 상태를 확인할 수 없습니다.', 'a failed read is not reported as evidence that the requested TODO is absent');
const nonStatusTodoResult = await hallucinatedTodoOllama.call({ model: 'qwen2.5:3b' }, [
  { role: 'user', content: 'Read TODO-PRIO-02 and explain what the identifier refers to.' },
  ...todoEvidenceHistory.slice(1)
], {}, { toolProfile: 'file-edit' });
assert.equal(nonStatusTodoResult.content, 'The marker [x] proves a successful provider call.', 'the missing-status fallback does not rewrite non-status TODO questions');
const fabricatedTodoChecklist = createOllamaAdapter({ fetch: async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '- [ ] [TODO-REVISION]. Revision status\n- [x] [TODO-DATA-VALIDATION]. Verified data sources' } }] }), { status: 200 }) });
const fabricatedTodoChecklistResult = await fabricatedTodoChecklist.call({ model: 'qwen2.5:3b' }, todoEvidenceHistory, {}, { toolProfile: 'file-read' });
assert.equal(fabricatedTodoChecklistResult.content, '읽은 원문에서 답변에 제시된 TODO 체크박스 항목을 확인할 수 없어 해당 목록을 검증하지 못했습니다.', 'local models cannot invent TODO IDs and checkbox states absent from source rows');
const fabricatedTodoProse = createOllamaAdapter({ fetch: async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'TODO-PRIO-01 is open, and TODO-FAKE-99 is complete.' } }] }), { status: 200 }) });
const fabricatedTodoProseResult = await fabricatedTodoProse.call({ model: 'qwen2.5:3b' }, [
  { role: 'user', content: 'Read TODO-PRIO-01 and explain the verifier behavior.' },
  { role: 'assistant', tool_calls: [{ id: 'read-verifier', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/features/provider/v1.mjs","start_line":309,"end_line":355}' } }] },
  { role: 'tool', tool_call_id: 'read-verifier', content: 'function verifyTodoStatusAnswer(history, answer) { return answer; }' }
], {}, { toolProfile: 'file-read' });
assert.equal(fabricatedTodoProseResult.content, '읽은 원문에서 답변에 제시된 TODO ID를 확인할 수 없어 답변을 검증하지 못했습니다.', 'local models cannot invent TODO IDs in prose even when the user supplied a different ID');
const filenameOnlyTodoHistory = [
  { role: 'user', content: 'Read TODO_ROADMAP.md lines 151-152 and report the checkbox.' },
  ...todoEvidenceHistory.slice(1)
];
const filenameOnlyTodoOllama = createOllamaAdapter({ fetch: async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'The marker is [x].' } }] }), { status: 200 }) });
const filenameOnlyTodoResult = await filenameOnlyTodoOllama.call({ model: 'qwen2.5:3b' }, filenameOnlyTodoHistory, {}, { toolProfile: 'file-edit' });
assert.equal(filenameOnlyTodoResult.content, '원문 검증 결과: TODO-PRIO-01 [ ] (미완료). 원문은 현재 UI/status 값만으로 실제 provider 호출을 증명할 수 없다고 명시합니다.', 'TODO_ROADMAP filenames activate the same source-grounded status guard');
const groundedTodoOllama = createOllamaAdapter({ fetch: async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'TODO-PRIO-01 [ ] remains open; the UI/status fields do not prove a provider call.' } }] }), { status: 200 }) });
const groundedTodoResult = await groundedTodoOllama.call({ model: 'qwen2.5:3b' }, todoEvidenceHistory, {}, { toolProfile: 'file-edit' });
assert.equal(groundedTodoResult.content, 'TODO-PRIO-01 [ ] remains open; the UI/status fields do not prove a provider call.', 'accurate TODO summaries are preserved');
const draftCausalityTodoOllama = createOllamaAdapter({ fetch: async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'TODO-PRIO-01 [ ] is open. The provider call is unverified because the protected draft must be preserved.' } }] }), { status: 200 }) });
const draftCausalityTodoResult = await draftCausalityTodoOllama.call({ model: 'qwen2.5:3b' }, todoEvidenceHistory, {}, { toolProfile: 'file-edit' });
assert.equal(draftCausalityTodoResult.content, '원문 검증 결과: TODO-PRIO-01 [ ] (미완료). 원문은 현재 UI/status 값만으로 실제 provider 호출을 증명할 수 없다고 명시합니다.', 'unsupported draft-preservation causality is removed from verified TODO answers');
const todoListHistory = [
  { role: 'user', content: 'TODO_ROADMAP.md에서 남은 미완료 항목을 목록으로 정확히 나열해.' },
  { role: 'assistant', tool_calls: [{ id: 'read-range', type: 'function', function: { name: 'read_file', arguments: '{"path":"TODO_ROADMAP.md","start_line":1,"end_line":30}' } }] },
  { role: 'tool', tool_call_id: 'read-range', content: [
    '- [ ] **TODO-OC-VOICE. 음성 메모 실제 전사**: UI 확인 미완료',
    '- [x] **TODO-OC-TESTS. 회귀 테스트**: 소스 검사 통과',
    '- [ ] **2026-11-03 개발자 피드백 버튼**: 설치 UI 미검증'
  ].join('\n') }
];
const hallucinatedTodoList = createOllamaAdapter({ fetch: async () => new Response(JSON.stringify({ choices: [{ message: {
  role: 'assistant', content: 'I read lines 31-60 too. All TODO tasks are complete.'
} }] }), { status: 200 }) });
const groundedTodoListResult = await hallucinatedTodoList.call({ model: 'qwen2.5:3b' }, todoListHistory, {}, { toolProfile: 'file-edit' });
assert.equal(groundedTodoListResult.content,
  'Only Chat read_file 반환 내용에서 확인한 체크박스입니다. 읽지 않은 범위의 상태는 포함하지 않았습니다.\n- [ ] TODO-OC-VOICE. 음성 메모 실제 전사\n- [ ] 2026-11-03 개발자 피드백 버튼',
  'TODO list answers come only from returned checkbox rows and omit unchecked evidence outside the read range');
const emptyTodoList = createOllamaAdapter({ fetch: async () => new Response(JSON.stringify({ choices: [{ message: {
  role: 'assistant', content: 'There are no remaining TODOs.'
} }] }), { status: 200 }) });
const emptyTodoListResult = await emptyTodoList.call({ model: 'qwen2.5:3b' }, [
  { role: 'user', content: 'List remaining TODOs.' },
  { role: 'assistant', tool_calls: [{ id: 'empty-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"TODO_ROADMAP.md","start_line":1,"end_line":30}' } }] },
  { role: 'tool', tool_call_id: 'empty-read', content: 'No checklist rows in the returned range.' }
], {}, { toolProfile: 'file-edit' });
assert.match(emptyTodoListResult.content, /읽지 않은 범위에 항목이 더 있을 수 있습니다/,
  'an empty partial read must not be reported as a fully completed TODO list');
let noToolsOllamaRequest;
const noToolsOllama = createOllamaAdapter({ fetch: async (_url, init) => {
  noToolsOllamaRequest = JSON.parse(init.body);
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ONLYCHAT_LOCAL_TEXT_OK' } }] }), { status: 200 });
} });
const noToolsOllamaResult = await noToolsOllama.call({ model: 'qwen2.5:3b' }, [{ role: 'user', content: '도구를 호출하지 말고 정확히 ONLYCHAT_LOCAL_TEXT_OK 라고만 답해.' }]);
assert.deepEqual(noToolsOllamaRequest.tools, [], 'explicit Korean no-tools prompts must automatically omit tools');
assert.equal(noToolsOllamaRequest.tool_choice, 'none', 'explicit Korean no-tools prompts must disable tool selection');
assert.equal(noToolsOllamaResult.content, 'ONLYCHAT_LOCAL_TEXT_OK');
const violatingNoToolsOllama = createOllamaAdapter({ fetch: async () => new Response(JSON.stringify({ choices: [{ message: {
  role: 'assistant', content: '', tool_calls: [{ id: 'unexpected-local-no-tools', type: 'function', function: { name: 'read_file', arguments: '{"path":"TODO.md"}' } }]
} }] }), { status: 200 }) });
await assert.rejects(
  violatingNoToolsOllama.call({ model: 'qwen2.5:3b' }, [{ role: 'user', content: 'Do not use tools.' }]),
  /tool call for a no-tools request/
);
const unadvertisedOllamaTool = createOllamaAdapter({ fetch: async () => new Response(JSON.stringify({ choices: [{ message: {
  role: 'assistant', content: 'should not stream', tool_calls: [{ id: 'unexpected', type: 'function', function: { name: 'browser_navigate', arguments: '{"url":"https://example.com"}' } }]
} }] }), { status: 200, headers: { 'content-type': 'application/json' } }) });
const unadvertisedDeltas = [];
await assert.rejects(
  unadvertisedOllamaTool.call({ model: 'qwen2.5:3b' }, [{ role: 'user', content: 'Read a file.' }], { onMessageDelta: delta => unadvertisedDeltas.push(delta) }),
  /outside the selected file-edit tool profile/
);
assert.deepEqual(unadvertisedDeltas, [], 'Ollama must fail closed on tools outside its compact default profile');
let malformedOllamaCalls = 0;
const malformedOllamaAdapter = createOllamaAdapter({ fetch: async () => {
  malformedOllamaCalls++;
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: '{}\n</tool_call>' } }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
} });
const malformedDeltas = [];
await assert.rejects(
  malformedOllamaAdapter.call({ model: 'qwen2.5:3b' }, [{ role: 'user', content: 'Read status.' }], { onMessageDelta: delta => malformedDeltas.push(delta) }),
  /leaked tool-call marker/,
  'Ollama control markers must not be accepted as a completed assistant answer'
);
assert.equal(malformedOllamaCalls, 2, 'a leaked local tool marker gets one no-tools recovery attempt and then fails closed');
assert.deepEqual(malformedDeltas, [], 'malformed Ollama output must be rejected before streaming to the UI');
let recoveryCall = 0;
let recoveryPayload;
const recoveredOllama = createOllamaAdapter({ fetch: async (_url, init) => {
  recoveryCall++;
  const payload = JSON.parse(init.body);
  if (recoveryCall === 1) return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'I am done. </tool_call>' } }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  recoveryPayload = payload;
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'TODO-OC-VOICE [ ] remains open.' } }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
} });
const recoveredDeltas = [];
const recoveredResult = await recoveredOllama.call({ model: 'qwen2.5:3b' }, [
  { role: 'user', content: 'Read the TODO and summarize its state.' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'todo-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"TODO_ROADMAP.md"}' } }] },
  { role: 'tool', tool_call_id: 'todo-read', content: '- [ ] TODO-OC-VOICE remains open.' }
], { onMessageDelta: delta => recoveredDeltas.push(delta) }, { toolProfile: 'file-edit' });
assert.equal(recoveryCall, 2, 'malformed tool markup triggers exactly one recovery generation');
assert.deepEqual(recoveryPayload.tools, [], 'the recovery generation cannot call tools');
assert.equal(recoveryPayload.tool_choice, 'none');
assert.ok(recoveryPayload.messages.some(message => message.role === 'tool' && message.content.includes('TODO-OC-VOICE')),
  'the recovery generation receives the actual result from the prior successful read');
assert.match(recoveryPayload.messages.find(message => message.role === 'system' && message.content.includes('invalid tool-call markup')).content,
  /Do not call tools/);
assert.equal(recoveredResult.content, 'TODO-OC-VOICE [ ] remains open.');
assert.deepEqual(recoveredDeltas, ['TODO-OC-VOICE [ ] remains open.'], 'only the recovered, markup-free answer is streamed');
const normalOllamaAdapter = createOllamaAdapter({ fetch: async () => new Response(JSON.stringify({
  choices: [{ message: { role: 'assistant', content: '3F Browser 제어 연결됨 · 열린 페이지 없음' } }]
}), { status: 200, headers: { 'content-type': 'application/json' } }) });
const normalDeltas = [];
const normalResponse = await normalOllamaAdapter.call({ model: 'qwen2.5:3b' }, [{ role: 'user', content: 'Read status.' }], {
  onMessageDelta: delta => normalDeltas.push(delta)
});
assert.equal(normalResponse.content, '3F Browser 제어 연결됨 · 열린 페이지 없음', 'normal Ollama text remains a valid final answer');
assert.deepEqual(normalDeltas, ['3F Browser 제어 연결됨 · 열린 페이지 없음'], 'valid Ollama text streams only after validation');
await adapter.call({ model: 'auto' }, [{ role: 'user', content: 'read only' }], {}, { approvalPolicy: 'read-only' });
const readOnlyPayload = JSON.parse(request.init.body);
assert.ok(readOnlyPayload.tools.some(tool => tool.function.name === 'read_file'));
assert.ok(readOnlyPayload.tools.some(tool => tool.function.name === 'notion_rea_search'));
assert.ok(readOnlyPayload.tools.some(tool => tool.function.name === 'notion_rea_read'));
assert.ok(!readOnlyPayload.tools.some(tool => tool.function.name === 'notion_rea_act'));
assert.ok(!readOnlyPayload.tools.some(tool => ['exec_command', 'write_file', 'gmail_send', 'browser_open'].includes(tool.function.name)),
  'read-only policy must keep mutation tools out of the Router request');
assert.ok(readOnlyPayload.tools.some(tool => tool.function.name === 'task_registry_list'));
assert.ok(readOnlyPayload.tools.some(tool => tool.function.name === 'task_registry_read'));
assert.ok(readOnlyPayload.tools.some(tool => tool.function.name === 'task_registry_messages'));
assert.ok(readOnlyPayload.tools.some(tool => tool.function.name === 'task_registry_check'));
assert.ok(!readOnlyPayload.tools.some(tool => ['task_registry_create', 'task_registry_claim', 'task_registry_checkpoint'].includes(tool.function.name)));
assert.ok(!readOnlyPayload.tools.some(tool => ['task_registry_send', 'task_registry_ack'].includes(tool.function.name)));

const toolAdapter = createAccountRouterAdapter({ fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"x"}' } }] } }] }), { status: 200 }) });
const toolResult = await toolAdapter.call({}, [{ role: 'user', content: 'read x' }]);
assert.equal(toolResult.toolCalls[0].name, 'read_file');
assert.deepEqual(toolResult.toolCalls[0].args, { path: 'x' });
assert.equal(toolResult.protocol, 'openai-compatible');

let routedTier;
const engine = Object.create(AgentEngine.prototype);
engine.isolated = false;
engine.accountRouterReadiness = {};
engine.tools = { approvalPolicy: 'read-only' };
engine.accountRouterAdapter = { call: async (tier, history, hooks, context) => {
  routedTier = { tier, history, context };
  return { content: 'router result', toolCalls: [] };
} };
engine.workspaceDir = '/tmp/only-chat-router-test';
const routed = await engine._callProviderWithFallback({ id: 'router-local', provider: 'account-router', model: 'auto' }, [{ role: 'user', content: 'hi' }], {}, { reasoningEffort: 'low', approvalPolicy: 'read-only' });
assert.equal(routed.content, 'router result');
assert.equal(routedTier.tier.id, 'router-local');
assert.equal(routedTier.context.reasoningEffort, 'low');
assert.equal(routedTier.context.approvalPolicy, 'read-only');
assert.deepEqual(engine.accountRouterReadiness, { available: true, connected: true, verified: true, state: 'connected', message: 'AI Account Router 실제 요청 성공' });
const failedRouterEngine = Object.create(AgentEngine.prototype);
failedRouterEngine.isolated = false;
failedRouterEngine.accountRouterReadiness = {};
failedRouterEngine.tools = { approvalPolicy: 'read-only' };
failedRouterEngine.accountRouterAdapter = { call: async () => { throw new Error('AI Account Router returned HTTP 503 (missing_credential).'); } };
await assert.rejects(failedRouterEngine._callProviderWithFallback({ id: 'router-failed', provider: 'account-router', model: 'auto' }, [{ role: 'user', content: 'hi' }], {}, { reasoningEffort: 'low' }), /missing_credential/);
assert.deepEqual(failedRouterEngine.accountRouterReadiness, { available: false, connected: false, verified: false, state: 'authentication', message: 'AI Account Router 인증을 확인해야 합니다.' });

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-router-tool-loop-'));
let integrationEngine;
try {
  const engineData = path.join(tempRoot, 'profile');
  integrationEngine = new AgentEngine({
    isolated: true,
    dataDir: engineData,
    configDir: path.join(engineData, 'config'),
    storageDir: path.join(engineData, 'sessions'),
    workspaceDir: path.join(engineData, 'workspace'),
    watchSkills: false,
    dispatcherAutoStart: false,
    approvalPolicy: 'on-request',
    notify: () => {}
  });
  // Exercise the special provider branch with the fully isolated test profile and a fake local adapter.
  integrationEngine.isolated = false;
  integrationEngine.priorityChain.setTiers([{ tier: 1, id: 'router-loop', name: 'Router test', provider: 'account-router', model: 'auto', enabled: true }]);
  const routerHistories = [];
  const approvalOrder = [];
  let turn = 0;
  integrationEngine.accountRouterAdapter = { call: async (_tier, history) => {
    routerHistories.push(structuredClone(history));
    turn += 1;
    if (turn === 1) return { content: '', toolCalls: [
      { id: 'call-1', name: 'write_file', args: { path: 'first.txt', content: 'first' } },
      { id: 'call-2', name: 'write_file', args: { path: 'second.txt', content: 'second' } }
    ], protocol: 'openai-compatible' };
    return { content: 'done', toolCalls: [] };
  } };
  integrationEngine._executeToolCall = async call => {
    approvalOrder.push(`execute:${call.args.path}`);
    return { path: call.args.path, content: 'fixture' };
  };
  const routedTurn = await integrationEngine.executeTurn('Write both files', {
    reasoningEffort: 'low',
    requestToolApproval: async request => {
      approvalOrder.push(`approve:${request.args.path}`);
      return request.args.path === 'first.txt';
    }
  });
  assert.equal(routedTurn.content, 'done');
  assert.equal(routerHistories.length, 2);
  assert.deepEqual(routerHistories[1].filter(item => item.role === 'user').map(item => item.content), ['Write both files'],
    'tool follow-up keeps the original prompt without appending an empty user message');
  assert.deepEqual(approvalOrder, ['approve:first.txt', 'execute:first.txt', 'approve:second.txt'],
    'each Router mutation must be approved immediately before its own execution; denial prevents that call');
  assert.equal(routerHistories[1].some(item => item.role === 'assistant' && item.tool_calls?.[0]?.id === 'call-1'), true);
  assert.equal(routerHistories[1].some(item => item.role === 'tool' && item.tool_call_id === 'call-2'), true,
    'denied calls still receive a tool result so the provider history remains valid');
  integrationEngine.tools.approvalPolicy = 'read-only';
  turn = 0;
  integrationEngine.accountRouterAdapter = { call: async (_tier, history) => {
    routerHistories.push(structuredClone(history));
    turn += 1;
    if (turn === 1) return { content: '', toolCalls: [{ id: 'call-readonly', name: 'write_file', args: { path: 'blocked.txt', content: 'blocked' } }], protocol: 'openai-compatible' };
    return { content: 'read-only done', toolCalls: [] };
  } };
  const readOnlyTurn = await integrationEngine.executeTurn('Write a file', { reasoningEffort: 'low' });
  assert.equal(readOnlyTurn.content, 'read-only done');
  assert.deepEqual(approvalOrder, ['approve:first.txt', 'execute:first.txt', 'approve:second.txt'],
    'read-only must block a Router mutation before executor dispatch');
  assert.equal(routerHistories[3].some(item => item.role === 'tool' && item.tool_call_id === 'call-readonly'), true,
    'read-only blocked calls also need a tool result for a valid follow-up history');
  integrationEngine.tools.approvalPolicy = 'on-request';
  turn = 0;
  const originalToolExecutor = integrationEngine._executeToolCall.bind(integrationEngine);
  let profileExecutionCount = 0;
  integrationEngine._executeToolCall = async () => { profileExecutionCount++; return { ok: true }; };
  integrationEngine.accountRouterAdapter = { call: async () => {
    turn += 1;
    if (turn === 1) return { content: '', toolCalls: [{ id: 'profile-blocked', name: 'write_file', args: { path: 'blocked.txt', content: 'blocked' } }], protocol: 'openai-compatible' };
    return { content: 'profile enforced', toolCalls: [] };
  } };
  const profileTurn = await integrationEngine.executeTurn('Write a file', { reasoningEffort: 'low', toolProfile: 'file-edit' });
  assert.equal(profileTurn.content, 'profile enforced');
  assert.equal(profileExecutionCount, 0, 'the file-edit profile blocks unadvertised tools even if a provider returns one');
  turn = 0;
  integrationEngine.accountRouterAdapter = { call: async () => {
    turn += 1;
    if (turn === 1) return { content: '', toolCalls: [{ id: 'file-write-allowed', name: 'write_file', args: { path: 'new.txt', content: 'new' } }], protocol: 'openai-compatible' };
    return { content: 'file-write profile enforced', toolCalls: [] };
  } };
  const fileWriteTurn = await integrationEngine.executeTurn('Create a file', {
    reasoningEffort: 'low',
    toolProfile: 'file-write',
    requestToolApproval: async request => request.name === 'write_file'
  });
  assert.equal(fileWriteTurn.content, 'file-write profile enforced');
  assert.equal(profileExecutionCount, 1, 'file-write exposes write_file only after the selected profile and approval allow it');
  let standaloneBrowserStatusCalls = 0;
  integrationEngine.tools.browserStatus = async () => {
    standaloneBrowserStatusCalls++;
    return { controlAvailable: true, isOpen: false, activeUrl: '', statusText: '3F Browser service ready' };
  };
  integrationEngine._executeToolCall = async (call, ...args) => call?.name === 'browser_status'
    ? integrationEngine.tools.browserStatus()
    : originalToolExecutor(call, ...args);
  let standaloneTurn = 0;
  integrationEngine.accountRouterAdapter = { call: async () => {
    standaloneTurn++;
    if (standaloneTurn === 1) return { content: '', toolCalls: [{ id: 'standalone-status', name: 'browser_status', args: {} }], protocol: 'openai-compatible' };
    return { content: 'standalone status received', toolCalls: [] };
  } };
  const standaloneProfileTurn = await integrationEngine.executeTurn('Read standalone 3F status', { reasoningEffort: 'low', toolProfile: 'threef-browser-status' });
  assert.equal(standaloneProfileTurn.content, 'standalone status received');
  assert.equal(standaloneBrowserStatusCalls, 1, 'standalone status profile dispatches the real browser_status tool exactly once');
} finally {
  integrationEngine?.dispatcher.stop();
  integrationEngine?.skills.stopWatching();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
assert.equal(fs.existsSync(tempRoot), false, 'temporary integration profile is removed');

const errorAdapter = createAccountRouterAdapter({ fetch: async () => new Response(JSON.stringify({ error: { code: 'provider_unconfigured' } }), { status: 503 }) });
await assert.rejects(errorAdapter.call({}, [{ role: 'user', content: 'hi' }]), error => error.code === 'provider_unconfigured' && /no configured provider/.test(error.message));
const ollamaLoadError = createOllamaAdapter({ fetch: async () => new Response(JSON.stringify({
  error: 'error loading model /Users/rogan/Library/CloudStorage/GoogleDrive-rogan@example.com/My Drive/Model Backups/qwen.gguf: read error: Undefined error: 0'
}), { status: 500 }) });
await assert.rejects(ollamaLoadError.call({ model: 'qwen2.5:7b' }, [{ role: 'user', content: 'Read status.' }]), error => {
  assert.equal(error.status, 500);
  assert.equal(error.code, 'router_error');
  assert.match(error.message, /Ollama returned HTTP 500: error loading model \[local path\]: read error: Undefined error: 0/);
  assert.doesNotMatch(error.message, /\/Users\/|GoogleDrive-rogan@example\.com|qwen\.gguf/);
  return true;
}, 'Ollama errors retain a useful load failure while removing local and account paths');
console.log('PASS account router provider adapter: loopback boundary, chat forwarding, tool-call mapping and follow-up history, no credential forwarding, provider errors');
