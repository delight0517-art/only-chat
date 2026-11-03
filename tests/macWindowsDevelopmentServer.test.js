'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { DesktopServer } = require('../src/ui/desktop/server.js');
const { MacWindowsDevelopment } = require('../src/core/MacWindowsDevelopment.js');

function request(port, pathname, method = 'GET', data = undefined) {
  const body = data === undefined ? '' : JSON.stringify(data);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method,
      headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', ...(body ? { 'Content-Type': 'application/json' } : {}) } }, res => {
      let content = ''; res.setEncoding('utf8'); res.on('data', part => content += part);
      res.on('end', () => resolve({ status: res.statusCode, body: content ? JSON.parse(content) : null }));
    });
    req.on('error', reject); req.end(body);
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-joint-dev-api-'));
  let server;
  try {
    const app = Object.create(DesktopServer.prototype);
    app.port = 0; app.isolated = false; app.macWindowsDevelopment = new MacWindowsDevelopment({ dataDir: path.join(root, 'data') });
    const driveFiles = new Map();
    app.engine = { tools: { google: {
      async driveCreateFile(name, mimeType, content) { const id = `file-${driveFiles.size + 1}`; driveFiles.set(id, { name, mimeType, content }); return { id }; },
      async driveReadFile(id) { const item = driveFiles.get(id); return item ? { content: item.content } : null; },
      async driveListFiles() { return { files: [...driveFiles].map(([id, item]) => ({ id, name: item.name, mimeType: item.mimeType })) }; }
    } } };
    server = http.createServer((req, res) => app._handleRequest(req, res));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); app.port = server.address().port;
    const base = 'a'.repeat(40);
    const contract = { taskKey: 'sample-app-task', title: 'sample', app: 'Sample', goal: 'coordinate', integrationBase: base,
      mac: { owner: 'mac', source: '/repo', baseCommit: base, paths: ['mac/file.swift'] },
      windows: { owner: 'windows', source: 'C:/repo', baseCommit: base, paths: ['windows/file.cs'] } };
    const created = await request(app.port, '/api/joint-development/tasks', 'POST', contract);
    assert.equal(created.status, 201);
    assert.equal((await request(app.port, '/api/joint-development/tasks')).body.tasks.length, 1);
    const published = await request(app.port, '/api/joint-development/tasks/sample-app-task/publish', 'POST', {});
    assert.equal(published.status, 200); assert.equal(published.body.drive.readback, 'verified');
    assert.equal((await request(app.port, '/api/joint-development/tasks/sample-app-task/publish', 'POST', {})).status, 409);
    const inbox = await request(app.port, '/api/joint-development/drive-inbox');
    assert.equal(inbox.body.files.length, 1);
    app.macWindowsDevelopment = new MacWindowsDevelopment({ dataDir: path.join(root, 'receiver') });
    const received = await request(app.port, '/api/joint-development/receive', 'POST', { fileId: inbox.body.files[0].id });
    assert.equal(received.status, 200); assert.equal(received.body.drive.receiverRead, 'verified');
    const overlap = await request(app.port, '/api/joint-development/tasks', 'POST', { ...contract, taskKey: 'overlap', windows: { ...contract.windows, paths: ['MAC'] } });
    assert.equal(overlap.status, 400);
    const badState = await request(app.port, '/api/joint-development/tasks/sample-app-task/windows', 'POST', { state: 'integrated' });
    assert.equal(badState.status, 400, 'stages cannot be skipped to falsely record integration');
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('macWindowsDevelopmentServer.test.js: passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
