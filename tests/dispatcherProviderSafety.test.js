'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { AgentEngine } = require('../src/core/AgentEngine.js');

function makeEngine(accounts) {
  const engine = Object.create(AgentEngine.prototype);
  engine.isolated = false;
  engine.priorityChain = {
    chain: { tiers: [{ id: 'antigravity-free', provider: 'antigravity-cli', enabled: true }, { id: 'account-router-local', provider: 'account-router', enabled: true }] }
  };
  engine._getAccountRouterAdapter = async () => ({ getChain: async () => ({ enabled: true, providerState: 'verified', accounts }) });
  return engine;
}

test('dispatcher accepts verified Router models regardless of free or paid model pricing', async () => {
  const free = makeEngine([{ id: 'free', provider: 'openai-compatible', model: 'google/gemma-4-31b:free', availability: 'available', enabled: true }]);
  assert.deepEqual(await free._getDispatcherAllowedProviderIds(), ['account-router-local']);

  const paid = makeEngine([{ id: 'paid', provider: 'chatgpt-plan', model: 'gpt-6-luna', availability: 'available', enabled: true }]);
  assert.deepEqual(await paid._getDispatcherAllowedProviderIds(), ['account-router-local']);

  const mixed = makeEngine([
    { id: 'free', provider: 'openai-compatible', model: 'google/gemma-4-31b:free', availability: 'available', enabled: true },
    { id: 'paid', provider: 'chatgpt-plan', model: 'gpt-6-luna', availability: 'available', enabled: true }
  ]);
  assert.deepEqual(await mixed._getDispatcherAllowedProviderIds(), ['account-router-local'], 'a paid route remains eligible alongside free accounts');

  const unverified = makeEngine([{ id: 'pending', provider: 'chatgpt-plan', model: 'gpt-6-luna', availability: 'unverified', enabled: true }]);
  assert.deepEqual(await unverified._getDispatcherAllowedProviderIds(), [], 'unverified Router accounts must remain blocked');
});

test('dispatcher admits only configured Ollama tiers whose exact model is installed locally', async () => {
  const engine = makeEngine([{ id: 'paid', provider: 'openai-compatible', model: 'google/gemini-2.5-flash', enabled: true }]);
  const ollama = { id: 'ollama-qwen', provider: 'ollama', model: 'qwen2.5:3b', enabled: true };
  engine.priorityChain.chain.tiers.push(ollama);
  const requests = [];
  const installed = await engine._getVerifiedLocalOllamaProviderIds([ollama], async (url, options) => {
    requests.push({ url, host: options.headers.Host });
    return new Response(JSON.stringify({ models: [{ name: 'qwen2.5:3b' }, { name: 'mistral:7b' }] }), { status: 200 });
  });
  assert.deepEqual(installed, ['ollama-qwen']);
  assert.deepEqual(requests, [{ url: 'http://127.0.0.1:11434/api/tags', host: '127.0.0.1:11434' }]);

  const unavailable = await engine._getVerifiedLocalOllamaProviderIds([ollama], async () =>
    new Response(JSON.stringify({ models: [{ name: 'mistral:7b' }] }), { status: 200 }));
  assert.deepEqual(unavailable, [], 'a different installed model must not validate the configured tier');

  engine._getVerifiedLocalOllamaProviderIds = async () => ['ollama-qwen'];
  assert.deepEqual(await engine._getDispatcherAllowedProviderIds(), ['ollama-qwen'], 'a verified local model remains eligible even when the separate Router tier is paid');
});

test('dispatcher blocks before creating a worker when no verified scoped-tool provider is ready', async () => {
  const engine = makeEngine([{ id: 'pending', provider: 'chatgpt-plan', model: 'gpt-6-luna', availability: 'unverified', enabled: true }]);
  engine.isolated = false;
  engine.dataDir = '/tmp/onlychat-provider-safety-test';
  engine.workspaceDir = '/tmp/onlychat-provider-safety-test/workspace';
  const result = await engine._executeDispatchedTask({ id: 'must-stay-blocked', title: 'Read-only task', prompt: 'Do not run.', allowedTools: ['read_file'] });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /검증된 AI Account Router 계정·모델/);
});
