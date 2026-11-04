'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { CodexCliAdapter } = require('../src/providers/CodexCliAdapter.js');

test('Codex calls expose workspace-confined lease tools with the selected workspace and session identity', async () => {
  const workspaceDir = path.resolve(__dirname, '..');
  let spawnArgs;
  let spawnOptions;
  const adapter = new CodexCliAdapter({ command: '/fake/codex', projectRoot: workspaceDir, spawn: (_command, args, options) => {
    spawnArgs = args;
    spawnOptions = options;
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin.on('finish', () => {
      const outputPath = args[args.indexOf('--output-last-message') + 1];
      fs.writeFileSync(outputPath, 'Done');
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  } });
  adapter._accountProfile = () => '/fake/profile';

  const result = await adapter.call(
    { id: 'codex-primary', model: 'gpt-6-luna', email: 'user@example.com' },
    [{ role: 'user', content: 'Inspect the current workspace.' }],
    {},
    {
      workspaceDir, sessionId: 'session_test_0001', reasoningEffort: 'low', approvalPolicy: 'on-request',
      requestWorkspaceWriteApproval: async () => true
    }
  );

  assert.equal(result.content, 'Done');
  if (process.platform === 'darwin') {
    assert.ok(spawnArgs.includes('mcp_servers.onlychat_workspace_coordination.enabled=true'));
    assert.ok(spawnArgs.includes(`mcp_servers.onlychat_workspace_coordination.args=${JSON.stringify([path.join(workspaceDir, 'src/connectors/WorkspaceCoordinationMcpServer.js')])}`));
    assert.ok(spawnArgs.includes(`mcp_servers.onlychat_workspace_coordination.env.ONLY_CHAT_WORKSPACE_DIR=${JSON.stringify(workspaceDir)}`));
    assert.ok(spawnArgs.includes('mcp_servers.onlychat_workspace_coordination.env.ONLY_CHAT_SESSION_ID="session_test_0001"'));
    const developerInstructions = spawnArgs.find(arg => String(arg).startsWith('developer_instructions='));
    assert.match(developerInstructions, /workspace_lease_status/);
    assert.match(developerInstructions, /workspace_lease_claim/);
    assert.match(developerInstructions, /workspace_lease_release/);
    assert.match(developerInstructions, /leases_clear:false/);
    assert.match(developerInstructions, /정확한 경로 또는 리소스, 잠금 종류/);
    assert.match(developerInstructions, /다른 저장소나 다른 작업에서 얻은 결과/);
    assert.match(developerInstructions, /hot reload 가능 여부와 source 소유권/);
    assert.equal(spawnOptions.env.ONLY_CHAT_WORKSPACE_DIR, workspaceDir);
    assert.equal(spawnOptions.env.ONLY_CHAT_SESSION_ID, 'session_test_0001');
  } else {
    assert.equal(spawnArgs.some(arg => String(arg).includes('onlychat_workspace_coordination')), false);
  }
});
