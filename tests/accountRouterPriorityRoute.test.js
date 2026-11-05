'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentEngine } = require('../src/core/AgentEngine.js');
const { PriorityChainEngine } = require('../src/priority/PriorityChainEngine.js');

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-router-priority-'));
  try {
    const chain = new PriorityChainEngine({ configDir: path.join(tempRoot, 'priority'), seedDefaults: false, notify: () => {} });
    chain.setTiers([
      { id: 'antigravity-first', tier: 1, provider: 'antigravity-cli', model: 'gemini-test', enabled: true },
      { id: 'codex-secondary', tier: 2, provider: 'codex', model: 'gpt-test', enabled: true },
      { id: 'codex-primary', tier: 3, provider: 'codex', model: 'gpt-test', enabled: true }
    ]);

    const routedCalls = [];
    const attemptedTiers = [];
    const engine = Object.create(AgentEngine.prototype);
    Object.assign(engine, {
      isolated: false,
      priorityChain: chain,
      accountRouterDiscoveryRetryAt: 0,
      currentSession: { sessionId: 'synthetic-priority-route' },
      conversationHistory: [],
      workspaceDir: tempRoot,
      tools: { approvalPolicy: 'read-only' },
      skills: { resolvePromptShortcuts: prompt => ({ text: prompt, injectedSkills: [] }) },
      handoff: { saveCheckpoint: () => {} },
      sessions: { appendItem: () => {} },
      providerAdapter: async tier => {
        attemptedTiers.push(tier.id);
        throw new Error('synthetic provider unavailable');
      },
      accountRouterAdapter: {
        getChain: async () => ({
          apiVersion: 1,
          enabled: true,
          accounts: [{ id: 'router-profile', provider: 'openai-compatible', model: 'test-model', enabled: true }]
        }),
        call: async (...args) => {
          routedCalls.push(args);
          return { content: 'router-fallback', toolCalls: [], protocol: 'openai-compatible' };
        }
      }
    });

    assert.equal(await engine._ensureAccountRouterTier(), true);
    assert.deepEqual(chain.chain.tiers.map(tier => tier.id), [
      'account-router-local', 'antigravity-first', 'codex-secondary', 'codex-primary'
    ], 'newly discovered Router is the default first route');
    chain.setTierRank('account-router-local', 4);
    engine.accountRouterDiscoveryRetryAt = 0;
    assert.equal(await engine._ensureAccountRouterTier(), false, 'rediscovery preserves the user-edited rank');
    assert.deepEqual(chain.chain.tiers.map(tier => tier.id), [
      'antigravity-first', 'codex-secondary', 'codex-primary', 'account-router-local'
    ]);
    chain.isTierReady = tier => ['antigravity-first', 'codex-primary', 'account-router-local'].includes(tier.id);
    const result = await engine._executeTurn('synthetic full-turn route test', {
      reasoningEffort: 'low',
      onTierResolved: tier => attemptedTiers.push(tier.id)
    });
    assert.equal(result.content, 'router-fallback');
    assert.equal(routedCalls.length, 1);
    assert.deepEqual(attemptedTiers, [
      'antigravity-first', 'antigravity-first', 'codex-primary', 'codex-primary', 'account-router-local'
    ]);

    const demoOnlyChain = new PriorityChainEngine({ configDir: path.join(tempRoot, 'demo'), seedDefaults: false, notify: () => {} });
    const demoEngine = Object.create(AgentEngine.prototype);
    Object.assign(demoEngine, {
      isolated: false,
      priorityChain: demoOnlyChain,
      accountRouterDiscoveryRetryAt: 0,
      accountRouterAdapter: {
        getChain: async () => ({ apiVersion: 1, enabled: true, accounts: [{ provider: 'demo', model: 'placeholder', enabled: true }] })
      }
    });
    assert.equal(await demoEngine._ensureAccountRouterTier(), false);
    assert.equal(demoOnlyChain.chain.tiers.some(tier => tier.provider === 'account-router'), false);

    const restored = new PriorityChainEngine({ configDir: path.join(tempRoot, 'priority'), notify: () => {} });
    assert.equal(restored.adoptAccountRouter(), false);
    assert.equal(restored.chain.tiers[3].id, 'account-router-local', 'user order survives restart');
    console.log('Router priority: automatic first discovery, persistent user reorder, fallback and demo exclusion passed.');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
