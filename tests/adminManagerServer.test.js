'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { DesktopServer } = require('../src/ui/desktop/server.js');

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'only-chat-admin-server-'));
  const server = new DesktopServer({
    port: await freePort(),
    isolated: true,
    dataDir: profile,
    workspaceDir: path.join(profile, 'workspace'),
    providerAdapter: async (_tier, history, _hooks, context) => {
      assert.equal(history[0].role, 'system');
      assert.match(history[0].content, /workspace\.file-write/);
      assert.equal(history.some(item => item.content === '사용자 대화'), true);
      assert.equal(context.reasoningEffort, 'high');
      return { content: 'attempted', toolCalls: [{ id: 'blocked', name: 'exec_command', args: { command: 'touch forbidden' } }] };
    }
  });
  let url;
  try {
    server.engine.priorityChain.upsertTier({ id: 'synthetic', name: 'Synthetic', provider: 'test', model: 'offline' });
    ({ url } = await server.start());
    const statusResponse = await fetch(`${url}/api/admin-manager/status`);
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.apiVersion, 1);
    assert.ok(status.capabilities.length >= 10);
    assert.equal(status.modules.find(module => module.id === 'admin-manager').state, 'loaded');
    assert.equal(status.modules.some(module => module.sourceHash && !/^[a-f0-9]{64}$/.test(module.sourceHash)), false);
    assert.equal(JSON.stringify(status).includes(profile), false);
    assert.deepEqual(status.dispatcher, { ready: false, blockedReason: 'isolated_runtime' });
    assert.equal(status.capabilities.find(capability => capability.id === 'work.delegate').state, 'unavailable');

    const originalIsolated = server.isolated;
    const originalDispatcherReadiness = server.engine._getDispatcherAllowedProviderIds;
    try {
      server.isolated = false;
      server.engine._getDispatcherAllowedProviderIds = async () => [];
      const blockedResponse = await fetch(`${url}/api/admin-manager/status`);
      const blockedStatus = await blockedResponse.json();
      assert.deepEqual(blockedStatus.dispatcher, { ready: false, blockedReason: 'no_verified_free_provider' });
      assert.equal(blockedStatus.capabilities.find(capability => capability.id === 'work.delegate').state, 'unavailable');

      server.engine._getDispatcherAllowedProviderIds = async () => ['account-router-local'];
      const readyResponse = await fetch(`${url}/api/admin-manager/status`);
      const readyStatus = await readyResponse.json();
      assert.deepEqual(readyStatus.dispatcher, { ready: true, blockedReason: null });
      assert.equal(readyStatus.capabilities.find(capability => capability.id === 'work.delegate').state, 'executable');
    } finally {
      server.isolated = originalIsolated;
      server.engine._getDispatcherAllowedProviderIds = originalDispatcherReadiness;
    }

    const staleFiles = new Set([
      path.join(server.projectRoot, 'src/core/SessionStore.js'),
      path.join(server.projectRoot, 'src/core/NativeSessionBridge.js')
    ]);
    const originalStatSync = fs.statSync;
    fs.statSync = function (filePath, ...args) {
      const stats = originalStatSync.call(fs, filePath, ...args);
      return staleFiles.has(path.resolve(String(filePath)))
        ? new Proxy(stats, { get(target, property) { return property === 'mtimeMs' ? Date.now() + 60_000 : Reflect.get(target, property, target); } })
        : stats;
    };
    let staleStatus;
    try { staleStatus = server._adminManagerSnapshot('1.0.0'); }
    finally { fs.statSync = originalStatSync; }
    assert.equal(staleStatus.modules.find(module => module.id === 'session-store').state, 'stale');
    assert.equal(staleStatus.modules.find(module => module.id === 'native-session-bridge').state, 'stale');
    assert.equal(staleStatus.capabilities.find(capability => capability.id === 'sessions.read').state, 'unavailable');

    const invalidEffort = await fetch(`${url}/api/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '사용자 대화', managerMode: true, reasoningEffort: 'turbo' })
    });
    assert.equal(invalidEffort.status, 400);

    const response = await fetch(`${url}/api/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '사용자 대화', managerMode: true, reasoningEffort: 'high' })
    });
    assert.equal(response.status, 200);
    const events = await response.text();
    assert.match(events, /관리자 모드는 작업을 직접 실행하지 않습니다/);
    assert.doesNotMatch(events, /manager_delegated/);
    assert.doesNotMatch(events, /tool_start/);
    assert.match(events, /turn_complete/);
    const saved = server.engine.sessions.readSession(server.engine.currentSession.sessionId);
    assert.equal(saved.some(item => typeof item.content === 'string' && item.content.startsWith('Only Chat 관리자 모드입니다.')), false);
    assert.equal(saved.some(item => item.type === 'tool_result'), false);
    console.log('admin manager readiness API, free-provider gating, ephemeral context and tool-call rejection passed');
  } finally {
    server.stop();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
