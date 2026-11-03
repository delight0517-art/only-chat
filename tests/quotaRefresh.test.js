'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DesktopServer, QUOTA_REFRESH_INTERVAL_MS } = require('../src/ui/desktop/server.js');
const { DEFAULT_PRESET_TIERS } = require('../src/priority/PriorityChainEngine.js');

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-quota-refresh-'));
  let server;
  try {
    let reads = 0;
    let resolveRead;
    server = new DesktopServer({
      isolated: true,
      dataDir: tempDir,
      workspaceDir: path.join(tempDir, 'workspace'),
      enableQuotaRefresh: true,
      quotaRefreshReader: tier => {
        assert.equal(tier.id, 'antigravity-flash-med');
        reads += 1;
        return new Promise(resolve => { resolveRead = resolve; });
      }
    });

    server.engine.priorityChain.setTiers(DEFAULT_PRESET_TIERS);
    // The isolated server has no real Codex adapter; make the fixture tiers ready so
    // this test exercises quota routing rather than local account discovery.
    server.engine.priorityChain.isTierReady = () => true;
    assert.equal(server.quotaRefreshIntervalMs, QUOTA_REFRESH_INTERVAL_MS, 'production quota refresh interval must be exactly 30 minutes');
    server._startQuotaRefresh();
    assert.equal(reads, 1, 'startup should begin one immediate quota read');
    const firstRefresh = server.quotaRefreshInFlight;
    const secondRefresh = server.refreshProviderQuotas();
    assert.strictEqual(secondRefresh, firstRefresh, 'a concurrent refresh should join the in-flight read');
    assert.equal(reads, 1, 'a concurrent refresh must not duplicate the provider call');

    resolveRead({ remainingPercent: 0, nextResetAt: '2026-10-31T01:37:09Z' });
    await firstRefresh;
    const priority = server.engine.priorityChain;
    assert.equal(priority.resolveActiveTier()?.id, 'codex-secondary', 'an exhausted refresh should route to tier 2');

    for (const malformed of [null, {}, { remainingPercent: '100' }, { remainingPercent: Number.NaN }]) {
      const health = priority.tierHealth.get('antigravity-flash-med');
      health.isThrottled = true;
      health.totalRemainingPercent = null;
      health.quotaState = 'limit-detected';
      const previousReads = reads;
      server.quotaRefreshReader = async () => { reads += 1; return malformed; };
      await server.refreshProviderQuotas();
      assert.equal(reads, previousReads + 1);
      assert.equal(health.totalRemainingPercent, null, 'malformed quota must not invent a numeric percentage');
      assert.equal(health.isThrottled, true, 'malformed quota must preserve exhausted/throttled state');
      assert.equal(priority.resolveActiveTier()?.id, 'codex-secondary', 'failed/malformed refresh must keep exhausted account out of active pool');
    }
    server.quotaRefreshReader = async () => { reads += 1; throw new Error('synthetic read failure'); };
    await server.refreshProviderQuotas();
    assert.equal(priority.tierHealth.get('antigravity-flash-med').totalRemainingPercent, null);
    assert.equal(priority.resolveActiveTier()?.id, 'codex-secondary');
    assert.equal(reads, 6);
    console.log('Quota refresh passed: 30-minute interval, immediate startup read, in-flight deduplication, and exhausted-state preservation on malformed/failed reads.');
  } finally {
    server?.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
