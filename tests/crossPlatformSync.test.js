/**
 * @project Only Chat / NCHI Sim
 * @provenance:rogan-core
 * @description Unit & Integration Tests for CrossPlatformSyncEngine.
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { CrossPlatformSyncEngine } = require('../src/sync/CrossPlatformSyncEngine.js');
const { HandoffAdapter } = require('../src/core/HandoffAdapter.js');

console.log('🧪 [Test Suite] CrossPlatformSyncEngine (Mac <-> Windows) 검증 시작...\n');

const testRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'only-chat-sync-'));
const previousRelayDir = process.env.ONLY_CHAT_SYNC_RELAY_DIR;
const previousHandoffDir = process.env.ONLY_CHAT_HANDOFF_DIR;
try {
  delete process.env.ONLY_CHAT_SYNC_RELAY_DIR;
  delete process.env.ONLY_CHAT_HANDOFF_DIR;
  const defaultSync = new CrossPlatformSyncEngine({ appDir: testRoot, localStateDir: path.join(testRoot, 'default-state') });
  assert.strictEqual(defaultSync.gdriveRelayDir, null, 'sync must not infer a user Drive path');
  assert.throws(() => new CrossPlatformSyncEngine({ appDir: testRoot, enabled: true }), /explicit Drive relay directory/);
  const defaultHandoff = new HandoffAdapter({ storageDir: path.join(testRoot, 'default-handoff') });
  assert.strictEqual(defaultHandoff.gdriveHandoffDir, null, 'handoffs must not infer a user Drive path');
  assert.strictEqual(new HandoffAdapter({ storageDir: testRoot, gdriveHandoffDir: false }).gdriveHandoffDir, null);

  const handoffTarget = path.join(testRoot, 'handoff-outside.json');
  const handoffLinkDir = path.join(testRoot, 'handoff-link-dir');
  fs.writeFileSync(handoffTarget, 'preserve handoff target');
  fs.symlinkSync(handoffTarget, path.join(testRoot, 'default-handoff', 'handoff_state.json'));
  assert.equal(defaultHandoff.loadCheckpoint(), null, 'handoff reader must not follow a state-file symlink');
  assert.throws(() => defaultHandoff.saveCheckpoint({ sessionId: 'must-not-overwrite' }));
  assert.equal(fs.readFileSync(handoffTarget, 'utf8'), 'preserve handoff target');
  fs.symlinkSync(path.join(testRoot, 'missing-handoff-dir'), handoffLinkDir);
  assert.throws(() => new HandoffAdapter({ storageDir: handoffLinkDir }), /unsafe/);

  const atomicStateDir = path.join(testRoot, 'atomic-handoff');
  const atomicHandoff = new HandoffAdapter({ storageDir: atomicStateDir, gdriveHandoffDir: false });
  atomicHandoff.saveCheckpoint({ sessionId: 'last-good' });
  const statePath = path.join(atomicStateDir, 'handoff_state.json');
  const previousRename = fs.renameSync;
  try {
    fs.renameSync = () => { throw new Error('synthetic rename failure'); };
    assert.throws(() => atomicHandoff.saveCheckpoint({ sessionId: 'must-not-replace' }), /synthetic rename failure/);
  } finally { fs.renameSync = previousRename; }
  assert.equal(atomicHandoff.loadCheckpoint().sessionId, 'last-good', 'failed checkpoint replacement must preserve the prior complete record');
  assert.deepEqual(fs.readdirSync(atomicStateDir), ['handoff_state.json'], 'failed replacement must remove its temporary file');

  const linkedStateDir = path.join(testRoot, 'hardlinked-handoff');
  const outsideCheckpoint = path.join(testRoot, 'outside-checkpoint.json');
  fs.mkdirSync(linkedStateDir);
  fs.writeFileSync(outsideCheckpoint, 'preserve linked checkpoint');
  fs.linkSync(outsideCheckpoint, path.join(linkedStateDir, 'handoff_state.json'));
  const linkedHandoff = new HandoffAdapter({ storageDir: linkedStateDir, gdriveHandoffDir: false });
  linkedHandoff.saveCheckpoint({ sessionId: 'new-checkpoint' });
  assert.equal(linkedHandoff.loadCheckpoint().sessionId, 'new-checkpoint', 'atomic replace must install the new handoff state');
  assert.equal(fs.readFileSync(outsideCheckpoint, 'utf8'), 'preserve linked checkpoint', 'atomic replace must not modify an external hardlink target');

  process.env.ONLY_CHAT_SYNC_RELAY_DIR = path.join(testRoot, 'configured-relay');
  process.env.ONLY_CHAT_HANDOFF_DIR = path.join(testRoot, 'configured-handoff');
  const configuredSync = new CrossPlatformSyncEngine({ appDir: testRoot, enabled: true });
  const configuredHandoff = new HandoffAdapter({ storageDir: path.join(testRoot, 'configured-state') });
  assert.strictEqual(configuredSync.gdriveRelayDir, process.env.ONLY_CHAT_SYNC_RELAY_DIR);
  assert.strictEqual(configuredHandoff.gdriveHandoffDir, process.env.ONLY_CHAT_HANDOFF_DIR);
  fs.mkdirSync(process.env.ONLY_CHAT_HANDOFF_DIR, { recursive: true });
  configuredHandoff.saveCheckpoint({ sessionId: 'isolated-test' });
  const checkpointFile = path.join(process.env.ONLY_CHAT_HANDOFF_DIR, 'my-codex-latest-handoff.json');
  assert.ok(fs.existsSync(checkpointFile));
  assert.strictEqual(fs.statSync(checkpointFile).mode & 0o777, 0o600);
  delete process.env.ONLY_CHAT_SYNC_RELAY_DIR;
  delete process.env.ONLY_CHAT_HANDOFF_DIR;

  const appDir = path.join(testRoot, 'mac-app');
  const relayDir = path.join(testRoot, 'relay');
  fs.mkdirSync(path.join(appDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'src', 'app.js'), 'v1');
  fs.writeFileSync(path.join(appDir, 'README.md'), 'Only Chat');
  const syncEngine = new CrossPlatformSyncEngine({ appDir, gdriveRelayDir: relayDir, localStateDir: path.join(testRoot, 'mac-state'), enabled: true });

  const pushed = syncEngine.pushToRelay('darwin');
  assert.strictEqual(pushed.success, true, 'initial push should seed the relay');
  assert.strictEqual(fs.readFileSync(path.join(relayDir, 'app_source/src/app.js'), 'utf8'), 'v1');

  const windowsDir = path.join(testRoot, 'windows-app');
  fs.cpSync(path.join(relayDir, 'app_source'), windowsDir, { recursive: true });
  const windowsSync = new CrossPlatformSyncEngine({ appDir: windowsDir, gdriveRelayDir: relayDir, localStateDir: path.join(testRoot, 'windows-state'), enabled: true });
  assert.strictEqual(windowsSync.pullFromRelay().success, true, 'Windows should accept the matching initial snapshot');

  fs.writeFileSync(path.join(appDir, 'src', 'app.js'), 'mac update');
  assert.strictEqual(syncEngine.pushToRelay('darwin').success, true, 'Mac edit should push');
  fs.copyFileSync(path.join(relayDir, 'app_source/src/app.js'), path.join(windowsDir, 'src/app.js'));
  assert.strictEqual(windowsSync.pullFromRelay().success, true, 'Windows should accept a remote edit');
  assert.strictEqual(fs.readFileSync(path.join(windowsDir, 'src/app.js'), 'utf8'), 'mac update');

  fs.writeFileSync(path.join(appDir, 'README.md'), 'mac concurrent edit');
  fs.writeFileSync(path.join(windowsDir, 'README.md'), 'windows concurrent edit');
  fs.writeFileSync(path.join(windowsDir, 'new-file.txt'), 'safe unrelated update');
  assert.ok(syncEngine.pushToRelay('darwin').success, 'first concurrent edit becomes visible in relay');
  const conflict = windowsSync.pushToRelay('win32');
  assert.strictEqual(conflict.success, false, 'conflicting edits must not be overwritten');
  assert.ok(conflict.conflicts.includes('README.md'));
  assert.strictEqual(fs.readFileSync(path.join(windowsDir, 'README.md'), 'utf8'), 'windows concurrent edit');
  assert.strictEqual(fs.readFileSync(path.join(relayDir, 'app_source/new-file.txt'), 'utf8'), 'safe unrelated update');

  assert.match(fs.readFileSync(path.join(relayDir, 'run-windows.ps1'), 'utf8'), /ONLY_CHAT_SYNC_RELAY_DIR/);
  assert.match(fs.readFileSync(path.join(relayDir, 'watch-sync-windows.ps1'), 'utf8'), /api\/sync\/pull/);
  assert.ok(fs.existsSync(path.join(relayDir, 'run-windows.bat')));
  const manifest = JSON.parse(fs.readFileSync(syncEngine.manifestFile, 'utf8'));
  assert.strictEqual(manifest.files['src/app.js'].hash, syncEngine.hashFile(path.join(relayDir, 'app_source/src/app.js')));
  console.log('✓ 양방향 갱신, 매니페스트 무결성, 동시 편집 충돌 보존 및 Windows 실행기 확인');
} finally {
  if (previousRelayDir === undefined) delete process.env.ONLY_CHAT_SYNC_RELAY_DIR;
  else process.env.ONLY_CHAT_SYNC_RELAY_DIR = previousRelayDir;
  if (previousHandoffDir === undefined) delete process.env.ONLY_CHAT_HANDOFF_DIR;
  else process.env.ONLY_CHAT_HANDOFF_DIR = previousHandoffDir;
  fs.rmSync(testRoot, { recursive: true, force: true });
}
