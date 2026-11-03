'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionStore } = require('../src/core/SessionStore.js');
const { DesktopServer } = require('../src/ui/desktop/server.js');

async function request(app, body) {
  const response = { status: null, body: '', writeHead(status) { this.status = status; }, end(value) { this.body = value || ''; } };
  app._readBody = async () => body;
  await app._handleRequest({ method: 'POST', url: '/api/sessions/metadata', headers: { host: '127.0.0.1:8899', origin: 'http://127.0.0.1:8899' } }, response);
  return { status: response.status, body: JSON.parse(response.body) };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'only-chat-session-metadata-'));
  try {
    const store = new SessionStore({ storageDir: path.join(root, 'sessions') });
    const { sessionId, sessionFile } = store.createSession({ title: 'Fixture session', workspaceDir: root });
    const app = Object.create(DesktopServer.prototype);
    app.engine = { sessions: store };
    app.port = 8899; app.isolated = false; app.syncEnabled = false;
    assert.equal((await request(app, { sessionId, action: 'rename', payload: { title: 'Renamed' } })).status, 200);
    assert.equal((await request(app, { sessionId, action: 'rename', payload: { title: 'Bad\nTitle' } })).status, 400);
    assert.equal(store.listSessions()[0].title, 'Renamed', 'rejected control characters do not replace the session title');
    assert.equal((await request(app, { sessionId, action: 'pin', payload: { pinned: true } })).status, 200);
    assert.equal((await request(app, { sessionId, action: 'move', payload: { section: 'Research' } })).status, 200);
    const moved = store.listSessions()[0];
    assert.equal(moved.title, 'Renamed'); assert.equal(moved.pinned, true); assert.equal(moved.section, 'Research');
    assert.equal((await request(app, { sessionId, action: 'archive', payload: { archived: true } })).status, 200);
    assert.equal(store.listSessions().find(s => s.sessionId === sessionId).archived, true);
    assert.equal(store.resumeSession(sessionId).title, 'Renamed');
    const lines = fs.readFileSync(sessionFile, 'utf8').trim().split('\n');
    assert.equal(lines.filter(line => JSON.parse(line).type === 'session_metadata').length, 4);
    assert.equal((await request(app, { sessionId: 'ses_../../etc/passwd', action: 'archive', payload: { archived: false } })).status, 400);
    assert.equal((await request(app, { sessionId: 'codex_external', action: 'rename', payload: { title: 'Nope' } })).status, 400);
    assert.equal((await request(app, { sessionId, action: 'delete', payload: { confirm: false } })).status, 400);
    assert.equal(fs.existsSync(sessionFile), true);
    assert.equal((await request(app, { sessionId, action: 'delete', payload: { confirm: true } })).status, 200);
    assert.equal(fs.existsSync(sessionFile), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('internal session metadata persistence, validation, archive, and confirmed delete passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
