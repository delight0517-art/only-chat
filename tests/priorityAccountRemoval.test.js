'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PriorityChainEngine } = require('../src/priority/PriorityChainEngine');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-account-removal-'));
try {
  const engine = new PriorityChainEngine({ configDir: root, seedDefaults: false, notify: () => {} });
  engine.upsertTier({ id: 'first', name: 'First', provider: 'synthetic', model: 'test' });
  engine.upsertTier({ id: 'second', name: 'Second', provider: 'synthetic', model: 'test' });
  engine.chain.manualTierId = 'first';
  assert.equal(engine.removeTier('first'), true);
  assert.deepEqual(engine.chain.tiers.map(t => [t.id, t.tier]), [['second', 1]]);
  assert.equal(engine.chain.manualTierId, 'second');
  assert.equal(engine.tierHealth.has('first'), false);
  assert.equal(engine.removeTier('missing'), false);
  assert.equal(engine.removeTier('second'), true);
  assert.equal(engine.chain.manualTierId, null);
  const reloaded = new PriorityChainEngine({ configDir: root, notify: () => {} });
  assert.deepEqual(reloaded.chain.tiers, [], 'explicitly empty account list must survive restart even with default seeding enabled');
  assert.equal(reloaded.chain.manualTierId, null);
  assert.equal(reloaded.tierHealth.size, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'priority_chain.json'), 'utf8')).tiers, []);
  console.log('priorityAccountRemoval: exact removal, rank normalization, stale reference cleanup and empty-list restart durability passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
