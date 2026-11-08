'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { DesktopServer } = require('../src/ui/desktop/server.js');

test('backend restart is same-origin only and shutdown aborts active turns for checkpoint recovery', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-supervised-restart-'));
  const calls = [];
  const app = new DesktopServer({
    port: 0,
    isolated: true,
    dataDir,
    workspaceDir: path.join(dataDir, 'workspace'),
    enableQuotaRefresh: false,
    enableSchedules: false,
    requestServerRestart: () => calls.push('restart')
  });
  let controller;
  try {
    await app.start();
    const url = `http://127.0.0.1:${app.port}/api/server/restart`;
    const rejected = await fetch(url, { method: 'POST' });
    assert.equal(rejected.status, 403, 'requests without the Only Chat origin cannot restart its server');
    assert.deepEqual(calls, []);

    const headers = { Origin: `http://127.0.0.1:${app.port}`, 'Sec-Fetch-Site': 'same-origin' };
    const accepted = await fetch(url, { method: 'POST', headers });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { ok: true, status: 'restart_pending' });
    assert.deepEqual(calls, ['restart']);

    const duplicate = await fetch(url, { method: 'POST', headers });
    assert.equal(duplicate.status, 202);
    assert.deepEqual(await duplicate.json(), { ok: true, status: 'already_requested' });
    assert.deepEqual(calls, ['restart'], 'duplicate requests do not trigger duplicate server launches');

    controller = new AbortController();
    app.activeTurns = 1;
    app.activeTurnControllers.add(controller);
    const checkpointUpdates = [];
    app.engine.handoff.loadCheckpoint = () => ({ status: 'running', sessionId: 'ses_0000000000000000' });
    app.engine.handoff.updateCheckpoint = (sessionId, update) => checkpointUpdates.push({ sessionId, update });
    app.stop();
    assert.equal(controller.signal.aborted, true, 'active provider work is interrupted when shutdown writes its recovery checkpoint');
    assert.equal(checkpointUpdates[0]?.update?.status, 'restart_pending');
  } finally {
    app.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('approved restart request exits with the supervisor handoff code and serves again after relaunch', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-supervised-process-'));
  const probe = net.createServer();
  let child;
  try {
    await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const launch = () => spawn(process.execPath, ['-e', [
      "const path=require('node:path');",
      "const {DesktopServer}=require('./src/ui/desktop/server.js');",
      `const dataDir=${JSON.stringify(dataDir)};`,
      `const server=new DesktopServer({port:${port},isolated:true,dataDir,workspaceDir:path.join(dataDir,'workspace'),enableSchedules:false,enableQuotaRefresh:false});`,
      "process.on('SIGTERM',()=>server.stop());",
      "server.start().then(({url})=>console.log('READY '+url)).catch(error=>{console.error(error);process.exit(1);});"
    ].join('')], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, ONLY_CHAT_ISOLATED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const waitForReady = process => new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`server startup timed out: ${output.slice(-300)}`)), 10000);
      process.stdout.on('data', chunk => {
        output += chunk.toString();
        const ready = /READY (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (ready) { clearTimeout(timer); resolve(ready[1]); }
      });
      process.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited before ready (${code})`)); });
    });

    child = launch();
    const url = await waitForReady(child);
    const accepted = await fetch(`${url}/api/server/restart`, {
      method: 'POST', headers: { Origin: url, 'Sec-Fetch-Site': 'same-origin' }
    });
    assert.equal(accepted.status, 202);
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not hand off to the supervisor')), 5000);
      child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(exitCode, 75, 'requested restart uses the native supervisor handoff code');

    child = launch();
    const restartedUrl = await waitForReady(child);
    const status = await fetch(`${restartedUrl}/api/status`);
    assert.equal(status.status, 200, 'the relaunched server serves the Only Chat status route');
  } finally {
    if (child?.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    await new Promise(resolve => probe.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
