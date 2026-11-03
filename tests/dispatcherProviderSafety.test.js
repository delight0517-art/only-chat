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
  engine._getAccountRouterAdapter = async () => ({ getChain: async () => ({ enabled: true, accounts }) });
  return engine;
}

test('dispatcher only selects a centrally-enforced provider when every active router account is explicitly free', async () => {
  const free = makeEngine([{ id: 'free', provider: 'openai-compatible', model: 'google/gemma-4-31b:free', enabled: true }]);
  assert.deepEqual(await free._getDispatcherAllowedProviderIds(), ['account-router-local']);

  const paid = makeEngine([{ id: 'paid', provider: 'openai-compatible', model: 'google/gemini-2.5-flash', enabled: true }]);
  assert.deepEqual(await paid._getDispatcherAllowedProviderIds(), []);

  const mixed = makeEngine([
    { id: 'free', provider: 'openai-compatible', model: 'google/gemma-4-31b:free', enabled: true },
    { id: 'paid', provider: 'openai-compatible', model: 'google/gemini-2.5-flash', enabled: true }
  ]);
  assert.deepEqual(await mixed._getDispatcherAllowedProviderIds(), [], 'any enabled paid route disqualifies automatic selection');
});

test('dispatcher blocks before creating a worker when no free scoped-tool provider is verified', async () => {
  const engine = makeEngine([{ id: 'paid', provider: 'openai-compatible', model: 'google/gemini-2.5-flash', enabled: true }]);
  engine.isolated = false;
  engine.dataDir = '/tmp/onlychat-provider-safety-test';
  engine.workspaceDir = '/tmp/onlychat-provider-safety-test/workspace';
  const result = await engine._executeDispatchedTask({ id: 'must-stay-blocked', title: 'Read-only task', prompt: 'Do not run.', allowedTools: ['read_file'] });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /비용이 0원으로 확인된/);
});
