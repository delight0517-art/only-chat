'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { DesktopServer } = require('../src/ui/desktop/server.js');

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-approval-policy-'));
  const workspaceDir = path.join(dataDir, 'workspace');
  const app = new DesktopServer({
    port: 0, isolated: true, dataDir, workspaceDir,
    enableQuotaRefresh: false, enableSchedules: false, dispatcherAutoStart: false
  });
  const server = http.createServer((req, res) => app._handleRequest(req, res));
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    app.port = server.address().port;
    const base = `http://127.0.0.1:${app.port}`;
    const getPolicy = () => fetch(`${base}/api/settings/approval-policy`, { headers: { Origin: base } });
    const setPolicy = policy => fetch(`${base}/api/settings/approval-policy`, {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ policy })
    });

    const initial = await getPolicy();
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), { policy: 'never' });

    const invalid = await setPolicy('allow-everything');
    assert.equal(invalid.status, 400);
    const afterInvalid = await getPolicy();
    assert.equal(afterInvalid.status, 200);
    assert.equal((await afterInvalid.json()).policy, 'never');

    app.activeTurns = 1;
    const duringTurn = await setPolicy('read-only');
    assert.equal(duringTurn.status, 409);
    assert.equal(app.engine.tools.approvalPolicy, 'never');
    app.activeTurns = 0;

    for (const policy of ['on-request', 'never', 'read-only']) {
      const saved = await setPolicy(policy);
      assert.equal(saved.status, 200);
      assert.deepEqual(await saved.json(), { ok: true, policy });
      assert.equal(app.engine.tools.approvalPolicy, policy, 'the active AgentEngine policy changes immediately');
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'approval-policy.json'), 'utf8')), { version: 1, policy });
    }

    const restored = new DesktopServer({
      port: 0, isolated: true, dataDir, workspaceDir,
      enableQuotaRefresh: false, enableSchedules: false, dispatcherAutoStart: false
    });
    assert.equal(restored.engine.tools.approvalPolicy, 'read-only', 'the persisted policy is applied before engine startup');
    restored.stop();
    console.log('approvalPolicySettingsRoute passed: validation, active update, busy guard, and restart persistence');
  } finally {
    await new Promise(resolve => server.close(resolve));
    app.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    assert.equal(fs.existsSync(dataDir), false, 'temporary isolated profile is removed');
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
