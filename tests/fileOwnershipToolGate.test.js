'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AgentEngine } = require('../src/core/AgentEngine.js');
const { ToolRegistry } = require('../src/tools/ToolRegistry.js');

async function withWorkspace(run) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-file-owner-'));
  try { await run(workspace); }
  finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    assert.equal(fs.existsSync(workspace), false, 'temporary workspace must be removed');
  }
}

function createEngine(workspace, calls) {
  const store = {
    hostId: 'f86ce49e-c2b6-4aa0-a691-d2c66bd42b87',
    async authorizeFileMutation(input) {
      calls.authorize.push(input);
      const allowed = input.allowedPaths.some(scope => {
        const relative = path.relative(workspace, input.filePaths[0]).split(path.sep).join('/');
        return scope === relative || relative.startsWith(`${scope}/`);
      });
      return allowed ? { authorized: true, snapshots: [{ path: 'src', expected: { exists: true, kind: 'tree', sha256: 'a'.repeat(64), fileCount: 1, byteCount: 1 } }] }
        : { authorized: false, reason: 'exact_path_not_leased' };
    },
    async recordFileMutation(input) {
      calls.record.push(input);
      return { updated: true };
    }
  };
  const registry = new ToolRegistry({
    workspaceDir: workspace, sandboxRoot: workspace, browserEnabled: false, providerConnectionsEnabled: false,
    taskRegistryStore: store,
    commandRunner: async (command, _onChunk, options) => {
      calls.command.push({ command, options });
      return { exitCode: 0, stdout: '', stderr: '' };
    }
  });
  const engine = Object.create(AgentEngine.prototype);
  engine.requireTaskOwnership = true;
  engine.workspaceDir = workspace;
  engine.tools = registry;
  engine.ownership = { acquireLocks: () => ({ acquired: true }), releaseLocks: () => {} };
  engine.currentSession = { sessionId: 'ses_0123456789abcdef' };
  return engine;
}

test('executor file mutations require a verified task lease at the ToolRegistry boundary', async () => {
  await withWorkspace(async workspace => {
    const calls = { authorize: [], record: [], command: [] };
    const engine = createEngine(workspace, calls);
    const context = {
      origin: 'only-chat-internal', originHostId: engine.tools.taskRegistryStore.hostId,
      taskKey: 'file-slice', ownerChatId: 'manager-session', repositoryPath: workspace,
      allowedPaths: ['src/allowed.js']
    };
    const pathInScope = path.join(workspace, 'src/allowed.js');

    await assert.rejects(engine._executeToolCall({ name: 'write_file', args: { path: pathInScope, content: 'no lease' } }, null), /소유권 lease/i);
    await engine._executeToolCall({ name: 'write_file', args: { path: pathInScope, content: 'owned' } }, null, context);
    assert.equal(fs.readFileSync(pathInScope, 'utf8'), 'owned');
    assert.equal(calls.authorize.length, 1);
    assert.equal(calls.record.length, 1);

    await assert.rejects(engine._executeToolCall({ name: 'write_file', args: { path: path.join(workspace, 'src/outside.js'), content: 'blocked' } }, null, context), /exact_path_not_leased/);
    assert.equal(fs.existsSync(path.join(workspace, 'src/outside.js')), false);
  });
});

test('executor apply_patch checks every parsed target and executor shell commands are blocked', async () => {
  await withWorkspace(async workspace => {
    const calls = { authorize: [], record: [], command: [] };
    const engine = createEngine(workspace, calls);
    const context = {
      origin: 'only-chat-internal', originHostId: engine.tools.taskRegistryStore.hostId,
      taskKey: 'file-slice', ownerChatId: 'manager-session', repositoryPath: workspace,
      allowedPaths: ['src/allowed.js']
    };
    const patch = [
      'diff --git a/src/outside.js b/src/outside.js',
      'index 1111111..2222222 100644',
      '--- a/src/outside.js',
      '+++ b/src/outside.js',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      ''
    ].join('\n');
    await assert.rejects(engine._executeToolCall({ name: 'apply_patch', args: { patch } }, null, context), /exact_path_not_leased/);
    assert.equal(calls.command.length, 0, 'out-of-scope patches must not reach git apply');
    await assert.rejects(engine._executeToolCall({ name: 'exec_command', args: { command: 'touch src/allowed.js' } }, null, context), /셸.*차단/);
    assert.equal(calls.command.length, 0, 'shell commands must not bypass the exact file gate');
  });
});
