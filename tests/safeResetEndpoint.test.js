'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DesktopServer } = require('../src/ui/desktop/server.js');

test('POST /api/system/safe-reset clears active turns and stale locks', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-safe-reset-test-'));
  const app = new DesktopServer({
    port: 0,
    isolated: true,
    dataDir,
    workspaceDir: path.join(dataDir, 'workspace'),
    enableQuotaRefresh: false,
    enableSchedules: false
  });

  try {
    await app.start();
    const url = `http://127.0.0.1:${app.port}/api/system/safe-reset`;

    // 1. Rejected without origin or loopback auth header
    const rejected = await fetch(url, { method: 'POST' });
    assert.equal(rejected.status, 403);

    // 2. Accepted with same-origin headers
    const accepted = await fetch(url, {
      method: 'POST',
      headers: { Origin: `http://127.0.0.1:${app.port}`, 'Sec-Fetch-Site': 'same-origin' }
    });
    assert.equal(accepted.status, 200);
    const body = await accepted.json();
    assert.equal(body.ok, true);
    assert.equal(body.workspace, os.homedir());

    // 3. Accepted with x-onlychat-control header from loopback
    const loopback = await fetch(url, {
      method: 'POST',
      headers: { 'X-OnlyChat-Control': '1' }
    });
    assert.equal(loopback.status, 200);
    const loopbackBody = await loopback.json();
    assert.equal(loopbackBody.ok, true);
  } finally {
    app.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
