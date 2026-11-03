'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { OwnershipLock } = require('../src/core/OwnershipLock.js');
const { DesktopServer } = require('../src/ui/desktop/server.js');

test('Git status distinguishes a clean repository from a non-Git directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-ownership-status-'));
  const cleanRepo = path.join(root, 'clean-repo');
  const nonGit = path.join(root, 'non-git');
  fs.mkdirSync(cleanRepo);
  fs.mkdirSync(nonGit);

  try {
    execFileSync('git', ['init', '--quiet', cleanRepo], { stdio: 'ignore' });

    const cleanOwnership = new OwnershipLock({ workspaceDir: cleanRepo });
    assert.deepEqual(cleanOwnership.getUncommittedChanges(), []);
    assert.deepEqual(cleanOwnership.getGitStatus(), {
      available: true,
      error: null,
      uncommitted: []
    });

    const nonGitOwnership = new OwnershipLock({ workspaceDir: nonGit });
    assert.deepEqual(nonGitOwnership.getUncommittedChanges(), []);
    const status = nonGitOwnership.getGitStatus();
    assert.equal(status.available, false);
    assert.equal(status.error, 'git_status_unavailable');
    assert.deepEqual(status.uncommitted, []);
    assert.equal(JSON.stringify(status).includes(root), false);
    assert.equal(JSON.stringify(status).includes('fatal:'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ownership API preserves the legacy array and reports Git status from one snapshot', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-ownership-api-'));
  const workspace = path.join(dataDir, 'workspace');
  const cleanRepo = path.join(dataDir, 'clean-repo');
  fs.mkdirSync(workspace);
  fs.mkdirSync(cleanRepo);
  execFileSync('git', ['init', '--quiet', cleanRepo], { stdio: 'ignore' });

  let app;
  try {
    app = new DesktopServer({
      port: 0,
      isolated: true,
      dataDir,
      workspaceDir: workspace,
      enableQuotaRefresh: false
    });
    let statusReads = 0;
    const getGitStatus = app.engine.ownership.getGitStatus.bind(app.engine.ownership);
    app.engine.ownership.getGitStatus = () => { statusReads += 1; return getGitStatus(); };
    const { url } = await app.start();

    const unavailable = await (await fetch(`${url}/api/ownership`)).json();
    assert.deepEqual(unavailable.uncommitted, []);
    assert.deepEqual(unavailable.gitStatus, { available: false, error: 'git_status_unavailable' });
    assert.equal(statusReads, 1, 'the route should get both fields from one Git-status snapshot');

    app.engine.ownership = new OwnershipLock({ workspaceDir: cleanRepo });
    const clean = await (await fetch(`${url}/api/ownership`)).json();
    assert.deepEqual(clean.uncommitted, []);
    assert.deepEqual(clean.gitStatus, { available: true, error: null });
  } finally {
    app?.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
