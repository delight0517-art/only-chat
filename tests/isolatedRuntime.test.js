'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DesktopServer } = require('../src/ui/desktop/server.js');

const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

async function main() {
  assert.throws(() => new DesktopServer({ isolated: true, dataDir: os.homedir() }), /inside the system temporary folder/);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'only-chat-isolated-'));
  const sourceTheme = path.join(__dirname, '../src/morph/organs/theme/theme.json');
  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(sourceTheme)).digest('hex');
  const app = new DesktopServer({ isolated: true, dataDir: profile, workspaceDir: path.join(profile, 'workspace') });
  try {
    const engine = app.engine;
    for (const statePath of [
      engine.dataDir, engine.workspaceDir, engine.priorityChain.configDir, engine.auth.authFile,
      engine.sessions.storageDir, engine.handoff.storageDir, engine.tools.google.storageDir,
      engine.tools.notion.storageDir, engine.tools.vault.vaultDir, engine.skills.globalSkillsDir,
      engine.tools.browserWorkspace.workspaceDir, app.hub.organsDir,
      app.nativeSessions.codexStateDb, app.nativeSessions.antigravityBrainDir
    ]) assert.ok(inside(profile, statePath), `state path escaped profile: ${statePath}`);

    assert.deepEqual(engine.auth.listAccounts(), []);
    assert.equal(engine.priorityChain.chain.tiers.length, 0);
    assert.equal(engine.tools.google.clientConfigFile, null);
    assert.equal(engine.tools.notion.apiKey, null);
    assert.equal(engine.tools.browser, null);
    assert.equal(engine.tools.browserWorkspace.enabled, false);
    assert.equal(engine.tools.browserWorkspace.cliPath, null);
    assert.equal(engine.skills.pluginCacheDir, null);
    assert.equal(engine.skills.watchers.length, 0);
    assert.equal(app.hub.watchers.length, 0);
    assert.equal(app.syncEnabled, false);
    const workspaceFixture = path.join(engine.workspaceDir, 'sandbox-path-proof.txt');
    fs.writeFileSync(workspaceFixture, 'valid isolated workspace path');
    assert.equal(engine.tools.resolvePath(workspaceFixture), workspaceFixture);
    assert.equal(await engine.tools.readFile('sandbox-path-proof.txt'), 'valid isolated workspace path');
    const qaScript = fs.readFileSync(path.join(__dirname, '../scripts/run-isolated-windows.ps1'), 'utf8');
    assert.match(qaScript, /ONLY_CHAT_ISOLATED_PROFILE/);
    assert.match(qaScript, /finally/);
    assert.match(qaScript, /Remove-Item .*ProfilePath.*Recurse/);

    assert.throws(() => engine.tools.resolvePath('/etc/passwd'), /outside the isolated profile/);
    if (process.platform !== 'win32') {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'only-chat-outside-'));
      try {
        const symlink = path.join(profile, 'workspace', 'escape');
        fs.symlinkSync(outside, symlink);
        assert.throws(() => engine.tools.resolvePath(path.join(symlink, 'private.txt')), /resolves outside the isolated profile/);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    }
    await assert.rejects(engine.tools.execCommand('cat /etc/passwd'), /Shell commands are disabled/);
    await assert.rejects(engine.tools.googleDriveList(), /Google Drive is disabled/);
    await assert.rejects(engine.tools.notionSearch('private'), /Notion is disabled/);
    await assert.rejects(engine.tools.browserOpen('https://example.com'), /Browser is disabled/);

    const providerless = Object.create(Object.getPrototypeOf(engine));
    providerless.isolated = false;
    providerless.providerAdapter = null;
    await assert.rejects(
      providerless._callProviderWithFallback({ id: 'missing', provider: 'unconfigured' }, [{ role: 'user', content: 'hello' }]),
      /No live provider adapter is configured.*Refusing to return a simulated answer/
    );

    const ui = app.hub.getOrganData('ui');
    const uiFile = path.join(app.hub.organsDir, 'ui/layout.json');
    const hash = crypto.createHash('sha256').update(fs.readFileSync(uiFile)).digest('hex');
    app.activeTurns = 1;
    assert.throws(() => app.hub.mutateOrgan('ui', 'compactMode', true, 'test', { expectedHash: hash }), /blocked while a request/);
    app.activeTurns = 0;
    assert.throws(() => app.hub.mutateOrgan('ui', 'compactMode', true, 'test', { expectedHash: '0'.repeat(64) }), /changed since it was read/);
    const originalUi = fs.readFileSync(uiFile, 'utf8');
    const rename = fs.renameSync;
    try {
      fs.renameSync = (from, to) => to === uiFile ? (() => { throw new Error('synthetic rename failure'); })() : rename(from, to);
      assert.throws(() => app.hub.mutateOrgan('ui', 'compactMode', true, 'test', { expectedHash: hash }), /synthetic rename failure/);
    } finally {
      fs.renameSync = rename;
    }
    assert.equal(fs.readFileSync(uiFile, 'utf8'), originalUi);
    assert.equal(fs.readdirSync(path.dirname(uiFile)).some(name => name.endsWith('.tmp')), false);
    const changed = app.hub.mutateOrgan('ui', 'compactMode', true, 'test', { expectedHash: hash, expectedSchemaVersion: 1 });
    assert.equal(changed.ok, true);
    assert.equal(app.hub.getOrganData('ui').compactMode, true);
    assert.match(changed.hash, /^[a-f0-9]{64}$/);
    assert.equal(app.hub.getHubStatus().hotReload.mainProcessModules, 'restart Only Chat');

    engine.providerAdapter = async () => ({ content: 'synthetic', toolCalls: [] });
    assert.deepEqual(await engine._callProviderWithFallback({ id: 'synthetic', name: 'Synthetic', model: 'offline' }, []), { content: 'synthetic', toolCalls: [] });
    console.log('isolated runtime paths, provider/browser/sync shutdown, morph hash and failed-write rollback passed');
  } finally {
    app.stop();
    fs.rmSync(profile, { recursive: true, force: true });
    assert.equal(fs.existsSync(profile), false);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(sourceTheme)).digest('hex'), sourceHash, 'source organ template must remain unchanged');
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
