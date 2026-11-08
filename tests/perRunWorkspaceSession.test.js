'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { ToolRegistry } = require('../src/tools/ToolRegistry.js');
const { DesktopServer } = require('../src/ui/desktop/server.js');
const { AccountRouterModuleSlot } = require('../src/features/provider/AccountRouterModuleSlot.js');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'only-chat-per-run-workspace-'));
  const defaultWorkspace = path.join(profile, 'only-chat-workspace');
  const selectedWorkspace = path.join(profile, 'moasis-workspace');
  fs.mkdirSync(defaultWorkspace);
  fs.mkdirSync(selectedWorkspace);
  const canonicalSelectedWorkspace = fs.realpathSync(selectedWorkspace);
  const probePath = path.join(selectedWorkspace, 'async-read-probe.txt');
  const readRegistry = new ToolRegistry({ workspaceDir: selectedWorkspace, browserEnabled: false, providerConnectionsEnabled: false });
  let observedProviderWorkspace = null;
  let routedModel = null;
  let routedWorkspace = null;
  let routerChain = { enabled: false, providerState: 'unverified', accounts: [] };
  let liveRouterModuleLoadAttempts = 0;
  const originalRouterLoad = AccountRouterModuleSlot.prototype.load;
  AccountRouterModuleSlot.prototype.load = async function() {
    liveRouterModuleLoadAttempts++;
    throw new Error('Live Account Router modules are disabled in this synthetic test.');
  };
  const accountRouterAdapter = {
    getChain: async () => routerChain,
    call: async (tier, _history, _hooks, context) => {
      routedModel = tier.model;
      routedWorkspace = context.workspaceDir;
      return { content: tier.model === 'openrouter/free' ? 'Only Chat used the selected free model.' : 'Only Chat used the selected GPT Router model.', toolCalls: [] };
    }
  };
  let app;
  try {
    let markReadStarted;
    let releaseRead;
    const readStarted = new Promise(resolve => { markReadStarted = resolve; });
    const pendingRead = new Promise(resolve => { releaseRead = resolve; });
    const originalReadFile = fs.promises.readFile;
    let readSettled = false;
    fs.promises.readFile = (filePath, ...args) => {
      if (filePath === probePath) {
        markReadStarted();
        return pendingRead;
      }
      return originalReadFile.call(fs.promises, filePath, ...args);
    };
    try {
      const read = readRegistry.readFile('async-read-probe.txt').then(value => { readSettled = true; return value; });
      await readStarted;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(readSettled, false, 'the file read remains pending without blocking the event loop');
      releaseRead('first line\nsecond line');
      assert.equal(await read, 'first line\nsecond line');
      assert.equal(await readRegistry.readFile('async-read-probe.txt', 2, 2), 'second line');
    } finally {
      fs.promises.readFile = originalReadFile;
    }
    await assert.rejects(readRegistry.readFile('missing-probe.txt'), /File not found: missing-probe\.txt/);

    app = new DesktopServer({
      port: await freePort(), dataDir: path.join(profile, 'profile'), workspaceDir: defaultWorkspace,
      enableQuotaRefresh: false, enableSchedules: false, dispatcherAutoStart: false,
      isTierReady: () => true,
      accountRouterAdapter,
      providerAdapter: async (_tier, _history, _hooks, context) => {
        observedProviderWorkspace = context.workspaceDir;
        return { content: 'Only Chat selected the approved session workspace.', toolCalls: [] };
      }
    });
    app.engine.priorityChain.setTiers([{
      tier: 1, id: 'workspace-test', name: 'Workspace test', provider: 'synthetic', model: 'workspace-test-model', enabled: true
    }]);
    const { url } = await app.start();
    const sessionId = `session_${Date.now()}`;
    const response = await fetch(`${url}/api/turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId, prompt: 'run with the selected workspace', reasoningEffort: 'low',
        modelSelection: 'workspace-test-model', workspaceDir: selectedWorkspace, workspaceWriteApproval: true
      })
    });
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.match(stream, /Only Chat selected the approved session workspace/);
    assert.equal(app.engine.currentSession.workspaceDir, canonicalSelectedWorkspace);
    assert.equal(app.engine.tools.workspaceDir, canonicalSelectedWorkspace);
    assert.equal(observedProviderWorkspace, canonicalSelectedWorkspace, 'provider tools receive the selected workspace, not the server default');
    const saved = app.engine.sessions.resumeSession(app.engine.currentSession.sessionId);
    assert.equal(saved.cwd, canonicalSelectedWorkspace, 'the exact session workspace persists for subsequent turns');

    const rejected = await fetch(`${url}/api/turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: `session_${Date.now() + 1}`, prompt: 'unapproved workspace must not run', reasoningEffort: 'low',
        modelSelection: 'workspace-test-model', workspaceDir: selectedWorkspace
      })
    });
    assert.equal(rejected.status, 403, 'workspace selection without explicit approval is rejected before execution');
    assert.equal(app.engine.currentSession.workspaceDir, canonicalSelectedWorkspace, 'a rejected request does not change the active session');

    app.engine.priorityChain.setTiers([{
      tier: 1, id: 'account-router-local', name: 'Free router', provider: 'account-router', model: 'auto', enabled: true
    }]);
    app.engine.priorityChain.chain.enabled = true;
    routerChain = { enabled: true, providerState: 'unverified', accounts: [
        { id: 'openrouter-primary', provider: 'openai-compatible', model: 'openrouter/free', enabled: true, availability: 'unverified' },
        { id: 'paid-secondary', provider: 'chatgpt-plan', model: 'gpt-6-luna', models: [
          { id: 'gpt-6-luna', name: 'GPT-6-Luna' }, { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' }
        ], enabled: true, availability: 'unverified' }
      ] };
    const priorityStatusResponse = await fetch(`${url}/api/status`);
    assert.equal(priorityStatusResponse.status, 200);
    const priorityStatus = await priorityStatusResponse.json();
    assert.deepEqual(priorityStatus.routerModels, ['openrouter/free', 'gpt-6-luna', 'gpt-6.1-sol'], 'status exposes enabled Router account defaults and catalog model IDs');
    assert.equal(JSON.stringify(priorityStatus.routerModels).includes('paid-secondary'), false, 'Router account IDs remain private');
    assert.equal(priorityStatus.accountRouterReadiness.connected, false, 'a configured Router model is not represented as an authenticated connection before a successful request');
    assert.equal(priorityStatus.accountRouterReadiness.verified, false);
    assert.equal(priorityStatus.accountRouterReadiness.state, 'unverified');
    assert.equal(priorityStatus.tiers.find(tier => tier.provider === 'account-router').providerReady.connected, false);
    const freeResponse = await fetch(`${url}/api/turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: `session_${Date.now() + 2}`, prompt: 'use only the free route', reasoningEffort: 'low',
        modelSelection: 'openrouter/free', workspaceDir: selectedWorkspace, workspaceWriteApproval: true
      })
    });
    assert.equal(freeResponse.status, 200);
    assert.match(await freeResponse.text(), /Only Chat used the selected free model/);
    assert.equal(routedModel, 'openrouter/free', 'the router receives an explicit free model instead of auto fallback');
    assert.equal(routedWorkspace, canonicalSelectedWorkspace, 'the free model still receives the selected Only Chat session workspace');
    const verifiedRouterStatus = await (await fetch(`${url}/api/status`)).json();
    assert.equal(verifiedRouterStatus.accountRouterReadiness.connected, true, 'only a successful Router request marks the route connected');
    assert.equal(verifiedRouterStatus.accountRouterReadiness.verified, true);


    const routerGptResponse = await fetch(`${url}/api/turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: `session_${Date.now() + 4}`, prompt: 'use the explicitly selected GPT Router model', reasoningEffort: 'low',
        modelSelection: 'account-router:gpt-6.1-sol'
      })
    });
    assert.equal(routerGptResponse.status, 200);
    assert.match(await routerGptResponse.text(), /Only Chat used the selected GPT Router model/);
    assert.equal(routedModel, 'gpt-6.1-sol', 'an exact enabled GPT model is sent through Account Router');

    const catalogRouterResponse = await fetch(`${url}/api/turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: `session_${Date.now() + 7}`, prompt: 'use a GPT model listed in the account catalog', reasoningEffort: 'low',
        modelSelection: 'account-router:gpt-6-luna'
      })
    });
    assert.equal(catalogRouterResponse.status, 200, 'a selected model from the live Router account catalog is accepted');
    assert.equal(routedModel, 'gpt-6-luna', 'Only Chat routes the selected catalog model even when it is not the account default');

    const missingRouterGptResponse = await fetch(`${url}/api/turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: `session_${Date.now() + 5}`, prompt: 'do not select an unconfigured Router model', reasoningEffort: 'low',
        modelSelection: 'account-router:gpt-not-configured'
      })
    });
    assert.equal(missingRouterGptResponse.status, 400, 'an Account Router model must be present in its enabled account chain');
    assert.equal(routedModel, 'gpt-6-luna', 'unconfigured Router models do not fall through to another provider');

    const paidResponse = await fetch(`${url}/api/turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: `session_${Date.now() + 6}`, prompt: 'paid model must not be selected', reasoningEffort: 'low',
        modelSelection: 'gpt-6.1-sol'
      })
    });
    assert.equal(paidResponse.status, 400, 'a paid Account Router model is not accepted through the free-only selection path');
    assert.equal(routedModel, 'gpt-6-luna', 'the unprefixed paid model never reaches Account Router');
  } finally {
    app?.stop();
    AccountRouterModuleSlot.prototype.load = originalRouterLoad;
    assert.equal(liveRouterModuleLoadAttempts, 0, 'synthetic tests never load the live Account Router module');
    fs.rmSync(profile, { recursive: true, force: true });
    assert.equal(fs.existsSync(profile), false, 'temporary test profile is removed');
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
