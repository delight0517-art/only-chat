'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionStore } = require('../src/core/SessionStore.js');
const { DesktopServer } = require('../src/ui/desktop/server.js');

async function getReportRoute(app, days = 7) {
  const response = {
    status: null,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body || ''; }
  };
  app.port = 8899;
  await app._handleRequest({
    method: 'GET', url: `/api/sessions/storage-report?days=${days}`,
    headers: { host: '127.0.0.1:8899' }
  }, response);
  return { status: response.status, headers: response.headers, body: JSON.parse(response.body) };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'only-chat-storage-report-'));
  try {
    const store = new SessionStore({ storageDir: path.join(root, 'sessions') });
    const { sessionId } = store.createSession({ title: 'Growth test', workspaceDir: root });
    store.appendItem(sessionId, { type: 'user_message', content: 'small prompt' });
    store.appendItem(sessionId, { type: 'tool_result', result: 'x'.repeat(1200) });
    store.appendItem(sessionId, { type: 'assistant_message', content: 'recent answer' });
    const expectedBytes = fs.statSync(path.join(store.storageDir, `${sessionId}.jsonl`)).size;
    const report = await store.storageReport({ days: 7 });
    assert.equal(report.scope.startsWith('Only Chat internal JSONL'), true);
    assert.equal(report.totalBytes, expectedBytes);
    assert.equal(report.totalRecords, 4);
    assert.equal(report.recentBytes, expectedBytes);
    assert.equal(report.largestSessions[0].title, 'Growth test');
    assert.ok(report.byRecordType.find(item => item.type === 'tool_result').bytes > 1200);
    assert.equal(Object.prototype.hasOwnProperty.call(report, 'content'), false);

    const app = Object.create(DesktopServer.prototype);
    app.engine = { sessions: store };
    const route = await getReportRoute(app, 7);
    assert.equal(route.status, 200);
    assert.equal(route.headers['Cache-Control'], 'no-store');
    assert.equal(route.body.totalBytes, expectedBytes);
    assert.equal(route.body.largestSessions[0].sessionId, sessionId);

    const oversized = store.createSession({ title: 'Large record', workspaceDir: root });
    store.appendItem(oversized.sessionId, { type: 'tool_result', result: 'z'.repeat(4 * 1024 * 1024 + 100) });
    const oversizedPath = path.join(store.storageDir, `${oversized.sessionId}.jsonl`);
    const oversizedBytes = fs.statSync(oversizedPath).size;
    const boundedReport = await store.storageReport({ days: 7 });
    assert.equal(boundedReport.totalBytes, expectedBytes + oversizedBytes);
    assert.equal(boundedReport.incomplete, true);
    assert.ok(boundedReport.oversizedBytes > 4 * 1024 * 1024);
    assert.ok(boundedReport.byRecordType.find(item => item.type === 'oversized_record').bytes > 4 * 1024 * 1024);

    const outsideContent = JSON.stringify({ type: 'tool_result', result: 'outside session storage' }) + '\n';
    const outsidePath = path.join(root, 'outside-session.jsonl');
    const linkedId = 'ses_0000000000000001';
    fs.writeFileSync(outsidePath, outsideContent);
    fs.symlinkSync(outsidePath, path.join(store.storageDir, `${linkedId}.jsonl`));
    const afterSymlink = await store.storageReport({ days: 7 });
    assert.equal(afterSymlink.totalBytes, boundedReport.totalBytes, 'storage report must exclude symlink targets');
    assert.equal(afterSymlink.incomplete, true, 'unsafe session entries make the report explicitly incomplete');
    assert.equal(afterSymlink.byRecordType.some(item => item.type === 'tool_result' && item.bytes === Buffer.byteLength(outsideContent)), false);
    assert.equal(fs.readFileSync(outsidePath, 'utf8'), outsideContent, 'report leaves external symlink target untouched');
    console.log('Only Chat session storage report and read-only API passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
