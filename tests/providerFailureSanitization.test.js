'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentEngine, providerFailureCategory } = require('../src/core/AgentEngine.js');
const { DEFAULT_PRESET_TIERS } = require('../src/priority/PriorityChainEngine.js');

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'only-chat-provider-failure-'));
  const markers = ['private@example.invalid', 'sk-fake-token-12345', 'PROMPT_SECRET_MARKER', 'OUTPUT_SECRET_MARKER', 'stderr-secret-marker'];
  const syntheticError = new Error(`network unavailable ${markers.join(' ')}`);
  syntheticError.stderr = `stderr ${markers[4]}`;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));

  try {
    const engine = new AgentEngine({
      isolated: true,
      dataDir,
      workspaceDir: path.join(dataDir, 'workspace'),
      notify: () => {},
      providerAdapter: async () => { throw syntheticError; }
    });
    engine.priorityChain.setTiers(DEFAULT_PRESET_TIERS.slice(0, 1));
    engine.priorityChain.setTiers([{
      ...DEFAULT_PRESET_TIERS[0], tier: 2,
      id: 'synthetic-attempted-tier',
      model: 'gpt-6-luna'
    }]);

    let surfacedFailure;
    try {
      await engine.executeTurn('synthetic prompt', { reasoningEffort: 'low' });
      assert.fail('expected provider failure');
    } catch (error) {
      surfacedFailure = error;
    }

    assert.strictEqual(surfacedFailure.category, 'network_unavailable');
    assert.strictEqual(surfacedFailure.model, 'gpt-6-luna');
    assert.strictEqual(surfacedFailure.rank, 2, 'error metadata retains the numeric rank of the attempted tier');
    assert.strictEqual(surfacedFailure.message, 'All eligible provider tiers failed.');
    const exposed = JSON.stringify({
      logs: warnings,
      failure: { message: surfacedFailure.message, category: surfacedFailure.category, model: surfacedFailure.model, tier: surfacedFailure.tier, stderr: surfacedFailure.stderr }
    });
    for (const marker of markers) assert.ok(!exposed.includes(marker), `sensitive marker leaked: ${marker}`);
    assert.ok(warnings.some(line => line.includes('network_unavailable')), 'safe category must remain in the logs');
    assert.ok(warnings.some(line => line.includes('gpt-6-luna')), 'safe model must remain in the logs');
    assert.equal(providerFailureCategory(new Error('HTTP 403')), 'provider_failure', 'bare HTTP 403 is not enough to classify a sandbox block');
    assert.equal(providerFailureCategory(new Error('sandbox permission denied')), 'sandbox_permission_blocked');
  } finally {
    console.warn = originalWarn;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().then(() => console.log('PASS provider failure sanitization')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
