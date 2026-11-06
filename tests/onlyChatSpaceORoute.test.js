'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CodexCliAdapter } = require('../src/providers/CodexCliAdapter.js');

test('default and explicitly assigned conversations use SpaceO without the Mac screen bridge', {
  skip: process.platform !== 'darwin'
}, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-spaceo-'));
  try {
    const adapter = new CodexCliAdapter({ dataDir, command: '/test/codex' });
    fs.writeFileSync(adapter.agentWorkspacesFile, JSON.stringify({
      onlyChatSessionAssignments: {
        version: 1, default: { transport: 'spaceo' }, sessions: { 'mac-chat': { transport: 'spaceo' } }
      }
    }), { mode: 0o600 });
    adapter._accountProfile = () => dataDir;
    adapter.macScreenBridge = () => ({ enabled: true, port: 8899, token: 'test-token' });
    let options;
    let bridge;
    adapter._run = async (args, _prompt, _profile, _cwd, _tier, _hooks, screenBridge) => {
      options = args;
      bridge = screenBridge;
      return 'ok';
    };
    const invoke = (sessionId, toolProfile) => adapter.call({ model: 'test-model' },
      [{ role: 'user', content: 'Test' }], {}, {
        sessionId, toolProfile, workspaceDir: dataDir, reasoningEffort: 'low', approvalPolicy: 'never'
      });
    await invoke('mac-chat');
    assert.ok(options.includes('mcp_servers.onlychat_agent_workspace.required=true'));
    assert.ok(options.includes('mcp_servers.onlychat_agent_workspace.args=["mcp","--cleanup-on-eof"]'));
    assert.ok(options.includes('mcp_servers.onlychat_agent_workspace.command='
      + JSON.stringify(path.join(os.homedir(), '.local', 'bin', 'spaceo'))));
    assert.ok(options.some(arg => arg.startsWith('developer_instructions=') && arg.includes('SpaceO')));
    assert.equal(bridge, null);
    assert.ok(!options.some(arg => arg.startsWith('mcp_servers.onlychat_mac_screen.')));

    await invoke('unassigned');
    assert.ok(options.includes('mcp_servers.onlychat_agent_workspace.required=true'));
    assert.ok(options.includes('mcp_servers.onlychat_agent_workspace.args=["mcp","--cleanup-on-eof"]'));
    assert.equal(bridge, null, 'the default SpaceO route never falls back to the Mac screen bridge');

    await invoke('mac-chat', 'no-tools');
    assert.ok(!options.some(arg => arg.startsWith('mcp_servers.onlychat_agent_workspace.')));
    assert.equal(bridge, null);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
