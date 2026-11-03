'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const { WorkspaceExecutionLease } = require('../src/core/WorkspaceExecutionLease.js');
const { DesktopServer } = require('../src/ui/desktop/server.js');

function writeLease(lockRoot, workspace, owner) {
  const lease = new WorkspaceExecutionLease({ lockRoot });
  fs.mkdirSync(lockRoot, { recursive: true });
  fs.writeFileSync(path.join(lockRoot, `${lease._workspaceKey(workspace)}.lock`), JSON.stringify(owner));
  return lease;
}

test('workspace lease status is read-only and classifies free, local, foreign, stale, and malformed locks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-lease-status-'));
  const workspace = path.join(root, 'workspace');
  const lockRoot = path.join(root, 'locks');
  fs.mkdirSync(workspace);
  const lease = new WorkspaceExecutionLease({ lockRoot });
  try {
    assert.deepEqual(lease.getStatus(workspace), { state: 'free', sameHost: null });

    const start = new Date().toISOString();
    writeLease(lockRoot, workspace, { token: 'secret-token', sessionId: 'secret-session', workspace: '/secret/path', pid: process.pid, host: os.hostname(), startedAt: start });
    assert.deepEqual(lease.getStatus(workspace), { state: 'held', sameHost: true, pid: process.pid, startedAt: start });

    writeLease(lockRoot, workspace, { token: 'secret-token', sessionId: 'secret-session', pid: 2, host: 'another-host', startedAt: start });
    assert.deepEqual(lease.getStatus(workspace), { state: 'held', sameHost: false });

    const deadPid = 2147483647;
    writeLease(lockRoot, workspace, { token: 'secret-token', sessionId: 'secret-session', workspace: '/secret/path', pid: deadPid, host: os.hostname(), startedAt: start });
    assert.deepEqual(lease.getStatus(workspace), { state: 'stale', sameHost: true, pid: deadPid, startedAt: start });
    assert.equal(fs.readdirSync(lockRoot).length, 1, 'status reads must not reclaim stale lock files');

    fs.writeFileSync(path.join(lockRoot, `${lease._workspaceKey(workspace)}.lock`), '{bad json');
    assert.deepEqual(lease.getStatus(workspace), { state: 'unknown', sameHost: null });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ownership API includes a safe workspace lease snapshot and preserves existing fields', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-lease-api-'));
  const workspace = path.join(dataDir, 'workspace');
  fs.mkdirSync(workspace);
  let app;
  try {
    app = new DesktopServer({ port: 0, isolated: true, dataDir, workspaceDir: workspace, enableQuotaRefresh: false });
    const headers = { 'content-type': '' };
    let body = '';
    const req = { url: '/api/ownership', method: 'GET', headers: { host: '127.0.0.1:8899' } };
    const res = {
      writeHead(statusCode, values) { this.statusCode = statusCode; Object.assign(headers, values); },
      end(value) { body = value; }
    };
    app.port = 8899;
    await app._handleRequest(req, res);
    assert.equal(res.statusCode, 200);
    const response = JSON.parse(body);
    assert.deepEqual(response.workspaceLease, { state: 'free', sameHost: null });
    assert.ok(Array.isArray(response.locks));
    assert.ok(Array.isArray(response.uncommitted));
    assert.deepEqual(response.gitStatus, { available: false, error: 'git_status_unavailable' });
    assert.equal(JSON.stringify(response.workspaceLease).includes(dataDir), false);
    assert.equal(JSON.stringify(response.workspaceLease).includes('token'), false);
    assert.equal(JSON.stringify(response.workspaceLease).includes('sessionId'), false);
  } finally {
    app?.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('workspace lease blocks another process and releases after the owner finishes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-lease-test-'));
  const workspace = path.join(root, 'workspace');
  const lockRoot = path.join(root, 'locks');
  fs.mkdirSync(workspace);

  let child;
  try {
    const script = [
      "const { WorkspaceExecutionLease } = require(process.env.ONLYCHAT_LOCK_MODULE);",
      "const lease = new WorkspaceExecutionLease({ lockRoot: process.env.ONLYCHAT_LOCK_ROOT });",
      "lease.run(process.env.ONLYCHAT_WORKSPACE, 'child-session', async () => {",
      "  process.stdout.write('ready\\n');",
      "  await new Promise(resolve => setTimeout(resolve, 500));",
      "}).catch(error => { console.error(error); process.exitCode = 1; });"
    ].join('\n');

    child = spawn(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        ONLYCHAT_LOCK_MODULE: path.resolve(__dirname, '../src/core/WorkspaceExecutionLease.js'),
        ONLYCHAT_LOCK_ROOT: lockRoot,
        ONLYCHAT_WORKSPACE: workspace
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const childExit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`child exit ${code}`)));
    });

    await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('child lease did not become ready')), 5000);
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        if (output.includes('ready\n')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', code => {
        if (code !== 0) {
          clearTimeout(timeout);
          reject(new Error(`child exited before lease was ready (${code})`));
        }
      });
    });

    const second = new WorkspaceExecutionLease({ lockRoot });
    await assert.rejects(
      second.run(workspace, 'other-session', async () => {}),
      /다른 Only Chat 작업이 사용 중입니다/
    );

    await childExit;
    child = null;

    await second.run(workspace, 'other-session', async () => 'acquired');
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent contenders reclaim one stale workspace lease without admitting overlapping work', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-lease-reclaim-'));
  const workspace = path.join(root, 'workspace');
  const lockRoot = path.join(root, 'locks');
  const readyRoot = path.join(root, 'ready');
  const startPath = path.join(root, 'start');
  fs.mkdirSync(workspace);
  fs.mkdirSync(readyRoot);
  const lease = new WorkspaceExecutionLease({ lockRoot });
  fs.mkdirSync(lockRoot, { recursive: true });
  fs.writeFileSync(path.join(lockRoot, `${lease._workspaceKey(workspace)}.lock`), JSON.stringify({
    token: 'stale-owner', sessionId: 'stale-session', workspace,
    pid: 2147483647, host: os.hostname(), startedAt: new Date().toISOString()
  }));

  const children = [];
  const childOutput = new Map();
  try {
    const script = [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const { WorkspaceExecutionLease } = require(process.env.ONLYCHAT_LOCK_MODULE);",
      "const lease = new WorkspaceExecutionLease({ lockRoot: process.env.ONLYCHAT_LOCK_ROOT });",
      "fs.writeFileSync(path.join(process.env.ONLYCHAT_READY_ROOT, String(process.pid)), 'ready');",
      "const waitForStart = new Promise(resolve => { const timer = setInterval(() => { if (fs.existsSync(process.env.ONLYCHAT_START_PATH)) { clearInterval(timer); resolve(); } }, 5); });",
      "waitForStart.then(() => lease.run(process.env.ONLYCHAT_WORKSPACE, 'contender', async () => {",
      "  const fd = fs.openSync(process.env.ONLYCHAT_ACTIVE_MARKER, 'wx');",
      "  fs.closeSync(fd);",
      "  process.stdout.write('acquired\\n');",
      "  await new Promise(resolve => setTimeout(resolve, 300));",
      "  fs.unlinkSync(process.env.ONLYCHAT_ACTIVE_MARKER);",
      "}).catch(error => {",
      "  if (/다른 Only Chat 작업이 사용 중입니다/.test(error.message)) { process.stdout.write('busy\\n'); process.exitCode = 2; }",
      "  else { console.error(error); process.exitCode = 1; }",
      "}));"
    ].join('\n');
    const env = {
      ...process.env,
      ONLYCHAT_LOCK_MODULE: path.resolve(__dirname, '../src/core/WorkspaceExecutionLease.js'),
      ONLYCHAT_LOCK_ROOT: lockRoot,
      ONLYCHAT_WORKSPACE: workspace,
      ONLYCHAT_READY_ROOT: readyRoot,
      ONLYCHAT_START_PATH: startPath,
      ONLYCHAT_ACTIVE_MARKER: path.join(root, 'active')
    };
    for (let i = 0; i < 8; i++) {
      const child = spawn(process.execPath, ['-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      const output = { stdout: '', stderr: '' };
      child.stdout.on('data', chunk => { output.stdout += chunk.toString(); });
      child.stderr.on('data', chunk => { output.stderr += chunk.toString(); });
      childOutput.set(child, output);
      children.push(child);
    }
    const readyDeadline = Date.now() + 10000;
    while (fs.readdirSync(readyRoot).length !== 8) {
      if (Date.now() >= readyDeadline) throw new Error(`lease contenders did not reach the start barrier (${children.map(child => `${child.exitCode}: ${childOutput.get(child).stderr}`).join('; ')})`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    fs.writeFileSync(startPath, 'start');
    const results = await Promise.all(children.map(child => new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolve({ code, ...childOutput.get(child) }));
    })));
    assert.equal(results.filter(result => result.code === 0 && result.stdout.includes('acquired')).length, 1);
    assert.equal(results.filter(result => result.code === 2 && result.stdout.includes('busy')).length, 7);
    assert.equal(results.some(result => result.code === 1 || result.stderr), false, JSON.stringify(results));
    assert.equal(fs.existsSync(path.join(lockRoot, `${lease._workspaceKey(workspace)}.lock`)), false, 'the acquired lease is released');
    assert.equal(fs.readdirSync(lockRoot).length, 0, 'the reclaimer guard is released');
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace lease fails closed and preserves malformed owner records', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-lease-malformed-'));
  const workspace = path.join(root, 'workspace');
  const lockRoot = path.join(root, 'locks');
  fs.mkdirSync(workspace);
  const lease = new WorkspaceExecutionLease({ lockRoot });
  fs.mkdirSync(lockRoot, { recursive: true });
  const lockPath = path.join(lockRoot, `${lease._workspaceKey(workspace)}.lock`);
  fs.writeFileSync(lockPath, '{invalid owner');
  try {
    await assert.rejects(lease.run(workspace, 'new-session', async () => {}), /잠금 정보를 읽을 수 없습니다/);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), '{invalid owner');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('nested tool follow-up calls reuse their parent workspace lease', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-lease-nested-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);

  try {
    const lease = new WorkspaceExecutionLease({ lockRoot: path.join(root, 'locks') });
    const result = await lease.run(workspace, 'session', async () =>
      lease.run(workspace, 'session', async () => 'nested-ok'));
    assert.equal(result, 'nested-ok');
    assert.deepEqual(fs.readdirSync(path.join(root, 'locks')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
