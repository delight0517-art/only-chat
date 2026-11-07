'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { DesktopServer } = require('../src/ui/desktop/server.js');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-full-access-router-'));
  const workspaceDir = path.join(profile, 'workspace');
  const outsideFile = path.join(profile, 'outside-workspace.txt');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(outsideFile, 'FULL_ACCESS_ROUTER_PATH_OK', 'utf8');
  let providerCalls = 0;
  const approvalPolicies = [];
  const accountRouterAdapter = {
    getChain: async () => ({
      enabled: true,
      providerState: 'verified',
      accounts: [{ id: 'synthetic-router', provider: 'chatgpt-plan', model: 'gpt-6-luna', availability: 'available', enabled: true }]
    }),
    call: async (_tier, history, _hooks, context) => {
      approvalPolicies.push(context.approvalPolicy);
      providerCalls += 1;
      if (providerCalls === 1) {
        return { content: '', toolCalls: [{ id: 'read-outside-workspace', name: 'read_file', args: { path: outsideFile } }] };
      }
      assert.match(JSON.stringify(history), /FULL_ACCESS_ROUTER_PATH_OK/);
      return { content: 'router-full-access-complete', toolCalls: [] };
    }
  };
  const app = new DesktopServer({
    port: await freePort(),
    dataDir: path.join(profile, 'data'),
    workspaceDir,
    approvalPolicy: 'never',
    enableQuotaRefresh: false,
    enableSchedules: false,
    dispatcherAutoStart: false,
    isTierReady: () => true,
    accountRouterAdapter
  });

  try {
    app.engine.priorityChain.setTiers([{
      tier: 1, id: 'account-router-local', name: 'Router', provider: 'account-router', model: 'auto', enabled: true
    }]);
    const { url } = await app.start();
    const response = await fetch(`${url}/api/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: `session_${Date.now()}`,
        prompt: 'Read the approved full-access test file.',
        reasoningEffort: 'low',
        modelSelection: 'account-router:gpt-6-luna',
        fullAccess: true
      })
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /router-full-access-complete/);
    assert.equal(providerCalls, 2, 'the Router model completes its tool call and follow-up without an approval prompt');
    assert.deepEqual(approvalPolicies, ['never', 'never']);
  } finally {
    app.stop();
    fs.rmSync(profile, { recursive: true, force: true });
    assert.equal(fs.existsSync(profile), false, 'the synthetic profile is removed');
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
