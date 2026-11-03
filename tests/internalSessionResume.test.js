'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionStore } = require('../src/core/SessionStore.js');
const { AgentEngine } = require('../src/core/AgentEngine.js');
const { DesktopServer } = require('../src/ui/desktop/server.js');
const { renderMarkdown } = require('../src/ui/desktop/chatPresentation.js');

async function resumeRoute(app, sessionId) {
  const response = {
    status: null,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body || ''; }
  };
  app.port = 8899;
  await app._handleRequest({
    method: 'POST', url: '/api/sessions/resume', headers: { host: '127.0.0.1:8899', origin: 'http://127.0.0.1:8899' },
    on(event, callback) { if (event === 'data') callback(Buffer.from(JSON.stringify({ sessionId }))); if (event === 'end') callback(); }
  }, response);
  return { status: response.status, body: JSON.parse(response.body) };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'only-chat-internal-resume-'));
  try {
    const store = new SessionStore({ storageDir: path.join(root, 'sessions') });
    const { sessionId } = store.createSession({ title: 'Synthetic title', workspaceDir: root, model: 'test-model' });
    store.appendItem(sessionId, { type: 'user_message', content: '<script>user</script>' });
    store.appendItem(sessionId, { type: 'tool_result', content: 'DO_NOT_EXPOSE_TOOL_LOG' });
    store.appendItem(sessionId, { type: 'assistant_message', content: '**assistant** <img src=x onerror=alert(1)>' });
    fs.writeFileSync(path.join(store.storageDir, 'not-a-session.jsonl'), JSON.stringify({ type: 'session_init', metadata: { title: 'Malformed filename' } }) + '\n');
    const linkedSessionId = 'ses_0000000000000001';
    const externalSessionFile = path.join(root, 'outside-session.jsonl');
    const externalSessionContent = JSON.stringify({ type: 'session_init', sessionId: linkedSessionId, metadata: { title: 'outside' } }) + '\n';
    fs.writeFileSync(externalSessionFile, externalSessionContent);
    fs.symlinkSync(externalSessionFile, path.join(store.storageDir, `${linkedSessionId}.jsonl`));
    assert.equal(store.readSession(linkedSessionId), null, 'internal session reads must reject symlink files');
    assert.equal(store.resumeSession(linkedSessionId), null, 'resume must not read a symlink target');
    assert.equal(store.listSessions().some(session => session.sessionId === linkedSessionId), false, 'listing must skip symlink session files');
    assert.throws(() => store.appendItem(linkedSessionId, { type: 'assistant_message', content: 'overwrite attempt' }), /Unsafe internal session file/);
    assert.throws(() => store.updateSessionMetadata(linkedSessionId, 'rename', { title: 'unsafe' }), /Internal session not found/);
    assert.throws(() => store.updateSessionMetadata(linkedSessionId, 'delete', { confirm: true }), /Internal session not found/);
    assert.equal(fs.readFileSync(externalSessionFile, 'utf8'), externalSessionContent, 'append must leave a symlink target unchanged');
    assert.equal(fs.lstatSync(path.join(store.storageDir, `${linkedSessionId}.jsonl`)).isSymbolicLink(), true, 'metadata operations must leave unsafe symlink entries untouched');
    const mismatchedSessionId = 'ses_0000000000000002';
    const mismatchedSessionFile = path.join(store.storageDir, `${mismatchedSessionId}.jsonl`);
    const mismatchedContent = JSON.stringify({ type: 'session_init', sessionId: linkedSessionId, metadata: { title: 'wrong ID' } }) + '\n';
    fs.writeFileSync(mismatchedSessionFile, mismatchedContent);
    assert.equal(store.readSession(mismatchedSessionId), null, 'session header ID must match the canonical filename');
    assert.equal(store.resumeSession(mismatchedSessionId), null, 'resume must reject a mismatched session header ID');
    assert.equal(store.listSessions().some(session => session.sessionId === mismatchedSessionId), false, 'listing must skip mismatched session headers');
    assert.throws(() => store.appendItem(mismatchedSessionId, { type: 'assistant_message', content: 'append attempt' }), /session header/i);
    assert.equal(fs.readFileSync(mismatchedSessionFile, 'utf8'), mismatchedContent, 'append must not modify a mismatched session file');
    const linkedDirectory = path.join(root, 'sessions-link');
    fs.symlinkSync(store.storageDir, linkedDirectory, 'dir');
    assert.throws(() => new SessionStore({ storageDir: linkedDirectory }), /regular directory/);
    assert.deepEqual(store.listSessions().map(session => session.sessionId), [sessionId], 'session listing includes only canonical internal IDs');

    const listed = store.listSessions()[0];
    assert.equal(listed.id, sessionId);
    assert.equal(listed.sessionId, sessionId);
    assert.equal(listed.source, 'internal');

    const resumed = store.resumeSession(sessionId);
    assert.deepEqual(resumed.turns, [
      { role: 'user', content: '<script>user</script>' },
      { role: 'assistant', content: '**assistant** <img src=x onerror=alert(1)>' }
    ]);
    assert.equal(JSON.stringify(resumed).includes('DO_NOT_EXPOSE_TOOL_LOG'), false);
    assert.equal(store.resumeSession('ses_../../etc/passwd'), null);
    assert.equal(store.readSession('ses_../../etc/passwd'), null);
    const traversalTarget = path.join(root, 'outside.jsonl');
    fs.writeFileSync(traversalTarget, 'keep this file unchanged\n');
    assert.throws(() => store.appendItem('../outside', { type: 'user_message', content: 'must not append' }), /Invalid session ID/);
    assert.equal(fs.readFileSync(traversalTarget, 'utf8'), 'keep this file unchanged\n');
    assert.match(renderMarkdown(resumed.turns[1].content), /<strong>assistant<\/strong>/);
    assert.match(renderMarkdown(resumed.turns[1].content), /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.equal(renderMarkdown(resumed.turns[0].content).includes('<script>'), false);

    const engine = Object.create(AgentEngine.prototype);
    engine.workspaceDir = root;
    engine.sessions = store;
    engine.tools = { setWorkspace(workspaceDir) { engine.workspaceDir = workspaceDir; } };
    const codexTurns = [
      { role: 'user', content: 'Codex request' },
      { role: 'assistant', content: 'Codex answer' }
    ];
    const codexData = { id: 'codex_thread-1', source: 'codex', title: 'External', cwd: root, model: 'gpt-6-luna', turns: codexTurns };
    const imported = engine.loadResumedSession(codexData);
    assert.match(imported.sessionId, /^ses_[a-f0-9]{16}$/);
    assert.notEqual(imported.sessionId, codexData.id, 'external Codex IDs must never be used as Only Chat persistence IDs');
    assert.equal(imported.resumedFrom, 'codex');
    assert.equal(imported.externalSessionId, codexData.id);
    assert.equal(codexData.id, 'codex_thread-1', 'import leaves the original Codex session identity unchanged');
    assert.deepEqual(store.resumeSession(imported.sessionId).turns, codexTurns, 'imported transcript is durably stored in a local Only Chat session');
    store.appendItem(imported.sessionId, { type: 'user_message', content: 'Only Chat follow-up' });
    assert.deepEqual(store.resumeSession(imported.sessionId).turns, [...codexTurns, { role: 'user', content: 'Only Chat follow-up' }]);
    const beforeRepeatedImport = store.listSessions().length;
    const repeatedImport = engine.loadResumedSession(codexData);
    assert.equal(repeatedImport.sessionId, imported.sessionId, 'reopening an imported Codex chat reuses its Only Chat continuation');
    assert.equal(store.listSessions().length, beforeRepeatedImport, 'reopening does not create duplicate imported sessions');
    assert.equal(engine.conversationHistory.at(-1).content, 'Only Chat follow-up', 'reopening preserves Only Chat follow-up context');
    const beforeInternalResume = store.listSessions().length;
    engine.loadInternalSession(resumed);
    assert.equal(engine.currentSession.sessionId, sessionId, 'internal resumes keep their existing local session ID');
    assert.equal(store.listSessions().length, beforeInternalResume, 'internal resume does not create a duplicate session');

    const app = Object.create(DesktopServer.prototype);
    app.engine = {
      sessions: store,
      loadInternalSession: data => { app.loadedInternal = data; return { sessionId: data.sessionId }; },
      loadResumedSession: data => { app.loadedExternal = data; return { sessionId: 'ses_aaaaaaaaaaaaaaaa' }; }
    };
    let externalId;
    app.nativeSessions = {
      resumeSession: id => { externalId = id; return { id, source: 'codex', title: 'External', turns: [{ role: 'user', content: 'external' }] }; }
    };
    const internalResponse = await resumeRoute(app, sessionId);
    assert.equal(internalResponse.status, 200);
    assert.equal(app.loadedInternal.sessionId, sessionId);
    assert.equal(externalId, undefined);
    const externalResponse = await resumeRoute(app, 'codex_thread-1');
    assert.equal(externalResponse.status, 200);
    assert.equal(externalId, 'codex_thread-1');
    assert.equal(app.loadedExternal.id, 'codex_thread-1');
    assert.equal(externalResponse.body.session.id, 'ses_aaaaaaaaaaaaaaaa');
    assert.equal(externalResponse.body.session.sessionId, 'ses_aaaaaaaaaaaaaaaa', 'resume API returns the local ID used for continuation');
    const invalidResponse = await resumeRoute(app, 'ses_../../etc/passwd');
    assert.equal(invalidResponse.status, 404);
    assert.equal(externalId, 'codex_thread-1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('internal session resume and external routing passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
