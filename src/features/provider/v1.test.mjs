import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccountRouterAdapter, normalizeBaseUrl, parseToolCalls, toolDefinitions } from './v1.mjs';
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

const discoveryEngine = Object.create(AgentEngine.prototype);
discoveryEngine.isolated = false;
const originalTier = { id: 'codex-primary', provider: 'codex' };
discoveryEngine.priorityChain = {
  chain: { enabled: true, tiers: [originalTier] },
  upsertTier(tier) { this.chain.tiers.push(tier); }
};
discoveryEngine.accountRouterAdapter = { getChain: async () => ({ enabled: true, accounts: [{ id: 'provider-1', enabled: true, provider: 'openai', model: 'gpt-model' }] }) };
assert.equal(await discoveryEngine._ensureAccountRouterTier(), true);
assert.deepEqual(discoveryEngine.priorityChain.chain.tiers.map(tier => tier.id), ['codex-primary', 'account-router-local']);
assert.equal(await discoveryEngine._ensureAccountRouterTier(), false, 'a discovered Router tier is not duplicated');
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
const result = await adapter.call({ model: 'auto' }, [{ role: 'user', content: 'hi' }], { onMessageDelta: text => deltas.push(text) });
assert.equal(request.url, 'http://127.0.0.1:18880/v1/chat/completions');
const payload = JSON.parse(request.init.body);
assert.equal(payload.model, 'auto');
assert.deepEqual(payload.messages, [{ role: 'user', content: 'hi' }]);
assert.equal(payload.stream, false);
assert.equal(payload.tool_choice, 'auto');
assert.equal(payload.tools.length, 43, 'default policy exposes the current complete provider tool set');
assert.equal(request.init.headers.Authorization, undefined);
assert.deepEqual(result, { content: 'hello', toolCalls: [], usage: { total_tokens: 2 }, protocol: 'openai-compatible' });
assert.deepEqual(deltas, ['hello']);
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
assert.ok(!readOnlyPayload.tools.some(tool => ['task_registry_create', 'task_registry_claim', 'task_registry_checkpoint'].includes(tool.function.name)));

const toolAdapter = createAccountRouterAdapter({ fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"x"}' } }] } }] }), { status: 200 }) });
const toolResult = await toolAdapter.call({}, [{ role: 'user', content: 'read x' }]);
assert.equal(toolResult.toolCalls[0].name, 'read_file');
assert.deepEqual(toolResult.toolCalls[0].args, { path: 'x' });
assert.equal(toolResult.protocol, 'openai-compatible');

let routedTier;
const engine = Object.create(AgentEngine.prototype);
engine.isolated = false;
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
} finally {
  integrationEngine?.dispatcher.stop();
  integrationEngine?.skills.stopWatching();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
assert.equal(fs.existsSync(tempRoot), false, 'temporary integration profile is removed');

const errorAdapter = createAccountRouterAdapter({ fetch: async () => new Response(JSON.stringify({ error: { code: 'provider_unconfigured' } }), { status: 503 }) });
await assert.rejects(errorAdapter.call({}, [{ role: 'user', content: 'hi' }]), error => error.code === 'provider_unconfigured' && /no configured provider/.test(error.message));
console.log('PASS account router provider adapter: loopback boundary, chat forwarding, tool-call mapping and follow-up history, no credential forwarding, provider errors');
