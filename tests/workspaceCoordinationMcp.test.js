'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createServer, tools } = require('../src/connectors/WorkspaceCoordinationMcpServer.js');

const workspaceDir = path.resolve(__dirname, '..');
const leaseId = '11111111-1111-4111-8111-111111111111';

function fixture(options = {}) {
  const calls = [];
  const server = createServer({
    workspaceDir,
    sessionId: 'session_test_0001',
    execFileSync: (_file, args) => {
      assert.deepEqual(args.slice(0, 3), ['-C', workspaceDir, 'rev-parse']);
      if (args[3] === '--show-toplevel') return `${workspaceDir}\n`;
      assert.equal(args[3], '--git-common-dir');
      return '.git\n';
    },
    runAgentCoord: args => {
      calls.push(args);
      if (args[0] === 'status') return 'No active leases.\n';
      if (args[0] === 'claim') return JSON.stringify({ lease_id: leaseId, mode: 'edit', repo: `${workspaceDir}/.git`, workspace: workspaceDir, paths: [`${workspaceDir}/src/ui/desktop/app.js`], expires_at: '2026-11-04T16:00+09:00' });
      if (args[0] === 'release') return 'Lease released.\n';
      throw new Error('unexpected command');
    },
    readOwnedLeaseRows: () => [],
    readRepoLeaseRows: () => [],
    ...options
  });
  return { server, calls };
}

test('workspace coordination exposes only status, scoped edit claim, and own-session release tools', async () => {
  assert.deepEqual(tools.map(item => item.name), ['workspace_lease_status', 'workspace_lease_claim', 'workspace_lease_release']);
  assert.equal(tools[1].inputSchema.properties.paths.maxItems, 40);
  assert.equal(tools[1].inputSchema.properties.lease_minutes.maximum, 60);
  assert.equal(tools[1].annotations.destructiveHint, false);

  const { server, calls } = fixture();
  const status = await server.invoke('workspace_lease_status', {});
  assert.equal(status.repository, workspaceDir);
  assert.equal(status.evidenceComplete, true);
  assert.equal(status.activeLeaseCount, 0);
  assert.deepEqual(status.pathAssessment, { kind: 'edit-path lease conflict check only', status: 'not-requested' });

  const claim = await server.invoke('workspace_lease_claim', { task: 'onlychat-feature-1', paths: ['src/ui/desktop/app.js'], lease_minutes: 10 });
  assert.equal(claim.lease_id, leaseId);
  assert.match(claim.owner, /^onlychat-[a-f0-9]{20}$/);
  assert.doesNotMatch(claim.owner, /session_test_0001/);
  assert.deepEqual(calls[1], ['claim', '--mode', 'edit', '--repo', workspaceDir, '--task', 'onlychat-feature-1', '--owner', claim.owner, '--lease-minutes', '10', '--paths', 'src/ui/desktop/app.js']);
});

test('workspace lease status reports exact path conflicts without labeling unrelated paths or the whole repo locked', async () => {
  const { server } = fixture({ readRepoLeaseRows: () => [
    { id: leaseId, workspace: workspaceDir, mode: 'edit', task: 'parallel-test', paths: [`${workspaceDir}/src/ui/desktop/app.js`], owner: 'agent-abc', expiresAt: Date.now() + 60_000 },
    { id: '22222222-2222-4222-8222-222222222222', workspace: workspaceDir, mode: 'edit', task: 'other-path', paths: [`${workspaceDir}/src/providers/responseGuidance.js`], owner: 'agent-def', expiresAt: Date.now() + 60_000 }
  ] });
  const overlapping = await server.invoke('workspace_lease_status', { paths: ['src/ui/desktop/app.js'] });
  assert.equal(overlapping.pathAssessment.status, 'conflict');
  assert.deepEqual(overlapping.pathAssessment.conflictingLeaseIds, [leaseId]);
  assert.equal(overlapping.leases[0].repositoryWide, false);
  const independent = await server.invoke('workspace_lease_status', { paths: ['src/connectors/WorkspaceCoordinationMcpServer.js'] });
  assert.equal(independent.pathAssessment.status, 'no-agent-coord-conflict');
  assert.equal(independent.limitation.includes('cannot establish that the repository or product is globally unlocked'), true);
  await assert.rejects(server.invoke('workspace_lease_status', { paths: ['../outside.js'] }), /Lease paths/);
});

test('workspace coordination rejects absolute, traversing, directory, malformed, and overlong claims before invoking the lease tool', async () => {
  const { server, calls } = fixture();
  for (const paths of [['../outside.js'], [path.join(workspaceDir, 'src/ui/desktop/app.js')], ['.git/config'], ['src'], ['src//ui/app.js']]) {
    await assert.rejects(server.invoke('workspace_lease_claim', { task: 'safe-task', paths }), /Lease paths|Lease target|Lease parent/);
  }
  await assert.rejects(server.invoke('workspace_lease_claim', { task: 'bad task', paths: ['src/ui/desktop/app.js'] }), /task is invalid/);
  await assert.rejects(server.invoke('workspace_lease_claim', { task: 'safe-task', paths: ['src/ui/desktop/app.js'], lease_minutes: 61 }), /lease_minutes/);
  assert.equal(calls.length, 0);
});

test('workspace lease release requires a current lease owned by this session and current workspace', async () => {
  const { server, calls } = fixture({
    readOwnedLeaseRows: ({ owner }) => [{ id: leaseId, mode: 'edit', task: 'onlychat-feature-1', paths: [`${workspaceDir}/src/ui/desktop/app.js`], expiresAt: Date.now() + 60_000, owner }]
  });
  await assert.rejects(server.invoke('workspace_lease_release', { lease_id: '22222222-2222-4222-8222-222222222222' }), /owned by this Only Chat session/);
  const released = await server.invoke('workspace_lease_release', { lease_id: leaseId });
  assert.equal(released.released, true);
  assert.deepEqual(released.paths, ['src/ui/desktop/app.js']);
  assert.deepEqual(calls[0], ['release', leaseId]);
});

test('workspace coordination implements the MCP initialize, list, and tool-call protocol', async () => {
  const { server } = fixture();
  const initialized = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(initialized.result.serverInfo.name, 'onlychat-workspace-coordination');
  const listed = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(listed.result.tools.length, 3);
  const called = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'workspace_lease_status', arguments: {} } });
  assert.equal(called.result.isError, false);
  assert.equal(called.result.structuredContent.activeLeaseCount, 0);
  assert.equal(called.result.structuredContent.pathAssessment.status, 'not-requested');
});

test('workspace coordination claims and releases an exact lease through the real local registry', async () => {
  const temporaryRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-coord-'));
  let claimedLeaseId = '';
  const cli = path.join(os.homedir(), '.codex/bin/agent-coord');
  try {
    execFileSync('git', ['init', '--quiet', temporaryRepo], { stdio: 'ignore' });
    fs.mkdirSync(path.join(temporaryRepo, 'src'));
    fs.writeFileSync(path.join(temporaryRepo, 'src', 'candidate.js'), 'module.exports = 1;\n');
    const canonicalTempRepo = fs.realpathSync(temporaryRepo);
    const server = createServer({ workspaceDir: canonicalTempRepo, sessionId: `coord-test-${crypto.randomUUID()}` });
    const claimed = await server.invoke('workspace_lease_claim', {
      task: 'onlychat-coord-smoke', paths: ['src/candidate.js'], lease_minutes: 1
    });
    claimedLeaseId = claimed.lease_id;
    assert.match(claimedLeaseId, /^[a-f0-9-]{36}$/i);
    assert.deepEqual(claimed.paths, [path.join(canonicalTempRepo, 'src/candidate.js')]);
    const status = await server.invoke('workspace_lease_status', {});
    assert.equal(status.activeLeaseCount, 1);
    assert.equal(status.leases[0].task, 'onlychat-coord-smoke');
    assert.equal(status.leases[0].mode, 'edit');
    assert.deepEqual(status.leases[0].paths, [path.join(canonicalTempRepo, 'src/candidate.js')]);
    const released = await server.invoke('workspace_lease_release', { lease_id: claimedLeaseId });
    claimedLeaseId = '';
    assert.equal(released.released, true);
    assert.deepEqual(released.paths, ['src/candidate.js']);
  } finally {
    if (claimedLeaseId) {
      try { execFileSync(cli, ['release', claimedLeaseId], { stdio: 'ignore' }); } catch (_) {}
    }
    fs.rmSync(temporaryRepo, { recursive: true, force: true });
  }
});
