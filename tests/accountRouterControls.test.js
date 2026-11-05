'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DesktopServer } = require('../src/ui/desktop/server');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-router-controls-'));
  let app;
  try {
    let snapshot = { apiVersion: 1, enabled: true, revision: 1, thresholdPercent: 10, activeAccountId: 'a', accounts: [
      { id: 'a', rank: 1, name: 'Primary', provider: 'chatgpt-plan', model: 'alpha', enabled: true, models: [{ id: 'alpha' }, { id: 'beta' }] },
      { id: 'b', rank: 2, name: 'Secondary', provider: 'chatgpt-plan', model: 'beta', enabled: true }
    ] };
    app = new DesktopServer({ port: 0, isolated: true, dataDir: root, enableQuotaRefresh: false, notify: () => {} });
    await app.start();
    // Enable discovery with a synthetic adapter after isolated construction; no external provider is used.
    app.isolated = false;
    app.engine.isolated = false;
    app.engine.accountRouterAdapter = {
      getChain: async () => snapshot,
      async reorderAccounts(input) {
        if (input.expectedRevision !== snapshot.revision) throw Object.assign(new Error('stale_revision'), { status: 409 });
        snapshot = { ...snapshot, revision: snapshot.revision + 1, accounts: input.accountIds.map((id, index) => ({ ...snapshot.accounts.find(account => account.id === id), rank: index + 1 })) };
      },
      async setAccountModel(id, model) { snapshot.accounts.find(account => account.id === id).model = model; }
    };
    const url = `http://127.0.0.1:${app.port}`;
    const post = (endpoint, body, origin = url) => fetch(`${url}${endpoint}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const initial = await (await fetch(`${url}/api/status`)).json();
    assert.equal(initial.tiers[0].provider, 'account-router');
    assert.equal(initial.accountRouter.accounts[0].model, 'alpha');
    const reorder = await post('/api/account-router/reorder', { accountIds: ['b', 'a'], expectedRevision: 1 });
    assert.equal(reorder.status, 200);
    assert.deepEqual((await reorder.json()).accountRouter.accounts.map(account => account.id), ['b', 'a']);
    assert.equal((await post('/api/account-router/reorder', { accountIds: ['a', 'b'], expectedRevision: 1 })).status, 409);
    assert.equal((await post('/api/account-router/model', { accountId: 'a', model: 'beta' })).status, 200);
    assert.equal(snapshot.accounts.find(account => account.id === 'a').model, 'beta');
    assert.equal((await post('/api/account-router/model', { accountId: 'a', model: 'alpha' }, 'https://untrusted.example')).status, 403);

    const ui = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
    const stage = ui.slice(ui.indexOf('async function loadStagePriorityTiers()'), ui.indexOf('// Ensure loadStagePriorityTiers'));
    const container = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
    const data = { enabled: true, tiers: Array.from({ length: 5 }, (_, index) => ({ id: `tier${index}`, tier: index + 1, name: `Provider ${index}`, provider: 'synthetic', health: {} })) };
    await new Function('fetch', 'document', 'escapeHtml', 'displayPriorityModel', 'resolveModelTierFromStatus', 'priorityRouteHealth', 'tierQuotaLabel', 'bindRouterAccountControls', `let stagePriorityLoadRequestId=0; const selectedModelId='auto'; ${stage}; return loadStagePriorityTiers();`)(
      async () => ({ ok: true, json: async () => data }), { getElementById: () => container }, String, String, () => null, () => ({ label: 'unknown' }), () => 'unknown', () => {}
    );
    for (let rank = 1; rank <= 5; rank += 1) assert.equal(container.innerHTML.split(`<span>${rank}순위</span>`).length - 1, 1, `rank ${rank} appears exactly once`);
    console.log('Only Chat Router controls: automatic first route, inline account/model metadata, revisioned reorder, model proxy, origin rejection and 5 unique rendered ranks passed.');
  } finally {
    await app?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
