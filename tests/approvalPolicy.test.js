'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ToolRegistry } = require('../src/tools/ToolRegistry.js');
const { AgentEngine, providerFailureCategory } = require('../src/core/AgentEngine.js');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'only-chat-approval-'));
  try {
    let snapshotCalls = 0;
    const registry = new ToolRegistry({
      workspaceDir: dir,
      approvalPolicy: 'read-only',
      browserEnabled: false,
      providerConnectionsEnabled: false,
      browserWorkspace: { snapshot: async () => { snapshotCalls++; return { saved: true }; } }
    });
    const target = path.join(dir, 'target.txt');
    fs.writeFileSync(target, 'original');
    await assert.rejects(registry.writeFile(target, 'changed'), /read-only/);
    await assert.rejects(registry.editFile(target, 'original', 'changed'), /read-only/);
    await assert.rejects(registry.applyPatch('diff --git a/x b/x'), /read-only/);
    await assert.rejects(registry.execCommand('echo harmless'), /read-only/);
    await assert.rejects(registry.browserWorkspaceSnapshot('saved-workspace'), /read-only/);
    assert.equal(snapshotCalls, 0, 'read-only snapshot must not invoke the persistence handler');
    for (const [method, args] of [
      ['googleDriveCreate', ['n', 'text/plain', 'c']], ['googleDriveUpdate', ['id', 'c']], ['gmailSend', ['a', 's', 'b']],
      ['notionCreatePage', ['db', 'title']], ['notionUpdatePage', ['page']], ['notionAppendBlocks', ['block', []]],
      ['browserOpen', ['https://example.com']], ['browserNavigate', ['https://example.com']], ['browserAct', [{}]],
      ['browserHistory', ['back']], ['browserRecipe', ['recipe']], ['browserWorkspaceSnapshot', ['name']], ['browserWorkspaceRestore', ['name']],
      ['browserWorkspaceFocus', ['query']], ['browserWorkspaceOpen', ['https://example.com']], ['vaultRequestCredential', ['service']]
    ]) await assert.rejects(registry[method](...args), /read-only/);
    assert.equal(await registry.readFile(target), 'original');

    const engine = Object.create(AgentEngine.prototype);
    engine.tools = { approvalPolicy: 'on-request', isNotionMcpReadOnlyCall: () => false };
    engine.currentSession = { sessionId: 'session-a' };
    const call = { id: 'model-call-1', name: 'write_file', args: { path: target, content: 'model supplied' } };
    assert.equal(engine._requiresToolApproval(call), true);
    await assert.rejects(engine._requestToolApproval(call, {}), /Approval unavailable/);
    await assert.rejects(engine._requestToolApproval(call, { requestToolApproval: async () => false }), /not approved/);
    assert.equal(await engine._requestToolApproval(call, { requestToolApproval: async request => request.sessionId === 'session-a' }), true);
    assert.equal(engine._requiresToolApproval({ name: 'read_file' }), false);
    assert.equal(engine._requiresToolApproval({ name: 'google_drive_create' }), true);
    assert.equal(engine._requiresToolApproval({ name: 'browser_navigate' }), true);
    engine.tools.approvalPolicy = 'read-only';
    assert.equal(engine._requiresToolApproval({ name: 'browser_workspace_snapshot' }), true, 'persisting a browser snapshot is classified as a mutation');
    engine.tools.approvalPolicy = 'never';
    assert.equal(engine._requiresToolApproval(call), false);

    const makeEngine = (policy, toolCall = { id: 'id', name: 'google_drive_create', args: {} }) => {
      const testEngine = Object.create(AgentEngine.prototype);
      testEngine.tools = { approvalPolicy: policy, isNotionMcpReadOnlyCall: () => false };
      testEngine.currentSession = { sessionId: 'integration-session' };
      testEngine.workspaceDir = dir;
      testEngine.isolated = true;
      testEngine.skills = { resolvePromptShortcuts: prompt => ({ text: prompt, injectedSkills: [] }) };
      testEngine.handoff = { saveCheckpoint() {} };
      testEngine.sessions = { appendItem() {} };
      testEngine.priorityChain = {
        chain: { tiers: [{}], enabled: true },
        resolveActiveTier: () => ({ id: 'mock-tier', name: 'mock' }),
        reportTierSuccess() {}, reportTierFailure() {}
      };
      testEngine.conversationHistory = [];
      const providerResponses = [
        { content: '', toolCalls: [toolCall] },
        { content: 'done', toolCalls: [] }
      ];
      testEngine.providerAdapter = async () => {
        assert.ok(providerResponses.length, 'provider fixture must not be called after its final response');
        return providerResponses.shift();
      };
      testEngine._callProviderWithFallback = async (...args) => testEngine.providerAdapter(...args);
      testEngine.assertProviderFixtureCompleted = () => assert.equal(providerResponses.length, 0, 'turn must consume the tool request and final response');
      testEngine.ownership = { acquireLocks: () => ({ acquired: true }), releaseLocks() {} };
      testEngine.workspaceExecutionLease = { run: (_workspace, _session, task) => task() };
      return testEngine;
    };
    const scopeEngine = makeEngine('on-request', { content: 'done', toolCalls: [] });
    let requestedScope;
    scopeEngine._callProviderWithFallback = async (_tier, _history, _hooks, options) => {
      assert.equal(await options.requestWorkspaceWriteApproval({ directory: '/sdk/bin/cache', reason: 'Flutter test cache' }), true);
      return { content: 'done', toolCalls: [] };
    };
    await scopeEngine._executeTurn('run Flutter test', {
      requestToolApproval: async request => {
        requestedScope = request;
        return request.sessionId === 'integration-session' && request.name === 'codex_cli_workspace_write_scope';
      }
    });
    assert.deepEqual(requestedScope, {
      requestId: requestedScope.requestId,
      sessionId: 'integration-session',
      name: 'codex_cli_workspace_write_scope',
      scopeRequiresExplicit: false,
      args: { directory: '/sdk/bin/cache', reason: 'Flutter test cache' }
    });
    const deniedEngine = makeEngine('on-request');
    deniedEngine.priorityChain.chain.tiers = [{}, {}];
    let providerAttempts = 0;
    let tierFailures = 0;
    deniedEngine.priorityChain.reportTierFailure = () => { tierFailures++; };
    deniedEngine._callProviderWithFallback = async () => {
      providerAttempts++;
      const error = new Error('approval denied');
      error.category = 'approval_denied';
      throw error;
    };
    await assert.rejects(deniedEngine._executeTurn('run Flutter test'), error => error.category === 'approval_denied');
    assert.equal(providerAttempts, 1, 'approval denial must not silently fall back to another provider');
    assert.equal(tierFailures, 0, 'a user denial is not a provider reliability failure');
    assert.equal(providerFailureCategory(Object.assign(new Error('승인이 거부되었습니다.'), { category: 'approval_denied' })), 'approval_denied');
    const pendingEngine = makeEngine('on-request');
    let dispatches = 0;
    pendingEngine._executeToolCall = async () => { dispatches++; return { ok: true }; };
    let releaseApproval;
    const pending = pendingEngine._executeTurn('test', { requestToolApproval: () => new Promise(resolve => { releaseApproval = resolve; }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(dispatches, 0, 'tool must remain undispatched while approval is pending');
    releaseApproval(false);
    await pending;
    pendingEngine.assertProviderFixtureCompleted();
    assert.equal(dispatches, 0, 'rejection must not dispatch');

    const unavailableEngine = makeEngine('on-request');
    unavailableEngine._executeToolCall = async () => { dispatches++; };
    await unavailableEngine._executeTurn('test');
    unavailableEngine.assertProviderFixtureCompleted();
    assert.equal(dispatches, 0, 'unavailable approval must not dispatch');

    const approvedEngine = makeEngine('on-request');
    approvedEngine._executeToolCall = async () => { dispatches++; return 'approved'; };
    await approvedEngine._executeTurn('test', { requestToolApproval: async () => true });
    approvedEngine.assertProviderFixtureCompleted();
    assert.equal(dispatches, 1, 'explicit approval must dispatch exactly once');

    const readOnlyEngine = makeEngine('read-only');
    readOnlyEngine._executeToolCall = async () => { assert.fail('read-only mutation reached tool dispatcher'); };
    await readOnlyEngine._executeTurn('test');
    readOnlyEngine.assertProviderFixtureCompleted();
    assert.equal(dispatches, 1, 'read-only mutation must never dispatch');

    for (const name of [
      'google_drive_create', 'google_drive_update', 'gmail_send',
      'notion_create_page', 'notion_update_page', 'notion_append_blocks',
      'browser_open', 'browser_navigate', 'browser_act', 'browser_history', 'browser_recipe',
      'browser_workspace_snapshot', 'browser_workspace_restore', 'browser_workspace_focus', 'browser_workspace_open'
    ]) {
      const routeEngine = makeEngine('read-only', { id: `blocked-${name}`, name, args: {} });
      routeEngine.tools[name] = async () => assert.fail(`read-only route ${name} handler was invoked`);
      await routeEngine._executeTurn('test');
      routeEngine.assertProviderFixtureCompleted();
    }

    const readEngine = makeEngine('read-only', { id: 'read', name: 'google_drive_list', args: {} });
    let reads = 0;
    readEngine.tools.googleDriveList = async () => { reads++; return []; };
    await readEngine._executeToolCall({ name: 'google_drive_list', args: {} });
    assert.equal(reads, 1, 'read-only policy must retain safe read routes');
    readEngine.tools.googleDriveRead = async () => { reads++; return { content: 'fixture' }; };
    await readEngine._executeToolCall({ name: 'google_drive_read', args: { fileId: 'file-id' } });
    assert.equal(reads, 2, 'read-only policy must retain Google Drive content reads');
    const neverEngine = makeEngine('never');
    assert.equal(neverEngine._requiresToolApproval({ name: 'google_drive_create' }), false);
    neverEngine.tools.googleDriveCreate = async () => 'never-allowed';
    assert.equal(await neverEngine._executeToolCall({ name: 'google_drive_create', args: {} }), 'never-allowed');
    console.log('approval policy: pending/reject/unavailable/approve dispatch, read-only dispatcher guards, registry direct guards, safe reads and never policy passed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
