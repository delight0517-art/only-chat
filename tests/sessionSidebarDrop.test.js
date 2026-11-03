'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { SessionStore } = require('../src/core/SessionStore');
const dropMappingPath = path.join(__dirname, '../src/ui/desktop/sessionDropMapping.js');
const { createSessionMetadataGuard, hasInternalSessionDragType, mapSessionDropDestination } = require(dropMappingPath);

const browserContext = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(dropMappingPath, 'utf8'), browserContext);
assert.equal(typeof browserContext.window.sessionDropMapping.hasInternalSessionDragType, 'function');
assert.equal(hasInternalSessionDragType({ types: ['application/x-only-chat-session'], getData: () => '' }), true,
  'dragover can identify the custom data type without reading protected payload');
assert.equal(hasInternalSessionDragType({ types: ['text/plain'] }), false);
assert.equal(hasInternalSessionDragType(null), false);

const dropGuard = createSessionMetadataGuard();
assert.equal(dropGuard.begin('ses_aaaaaaaaaaaaaaaa'), true);
assert.equal(dropGuard.begin('ses_aaaaaaaaaaaaaaaa'), false, 'one session cannot start a second drop while its move is pending');
assert.equal(dropGuard.begin('ses_bbbbbbbbbbbbbbbb'), true, 'different sessions can move independently');
dropGuard.end('ses_aaaaaaaaaaaaaaaa');
assert.equal(dropGuard.begin('ses_aaaaaaaaaaaaaaaa'), true, 'a failed or completed move can be retried after releasing its guard');
dropGuard.end('ses_aaaaaaaaaaaaaaaa');
dropGuard.end('ses_bbbbbbbbbbbbbbbb');

assert.deepEqual(mapSessionDropDestination({ type: 'pinned' }), { action: 'pin', payload: { pinned: true } });
assert.deepEqual(mapSessionDropDestination({ type: 'recents' }), { action: 'move', payload: { section: 'recents', pinned: false } });
assert.deepEqual(mapSessionDropDestination({ type: 'section', section: '졸업 과제' }), { action: 'move', payload: { section: '졸업 과제', pinned: false } });
assert.equal(mapSessionDropDestination({ type: 'section', section: '  ' }), null);
assert.equal(mapSessionDropDestination({ type: 'section', section: 'x'.repeat(33) }), null);
assert.equal(mapSessionDropDestination({ type: 'unknown' }), null);

const temporaryStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'only-chat-sidebar-drop-'));
try {
  let store = new SessionStore({ storageDir: temporaryStorage });
  const { sessionId } = store.createSession({ title: 'synthetic internal session' });
  store.appendItem(sessionId, { type: 'user_message', content: 'synthetic body' });
  store.updateSessionMetadata(sessionId, 'pin', { pinned: true });
  store = new SessionStore({ storageDir: temporaryStorage });
  assert.equal(store.listSessions()[0].pinned, true, 'pin metadata survives store reopen');
  store.updateSessionMetadata(sessionId, 'move', { section: 'recents', pinned: false });
  store = new SessionStore({ storageDir: temporaryStorage });
  const reopened = store.listSessions()[0];
  assert.equal(reopened.section, 'recents');
  assert.equal(reopened.pinned, false, 'unpin metadata survives store reopen');
  assert.deepEqual(store.readSession(sessionId).filter(record => record.type === 'user_message').map(record => record.content), ['synthetic body'], 'atomic metadata rewrite preserves prior records');
  store.updateSessionMetadata(sessionId, 'archive', { archived: true });
  assert.throws(() => store.updateSessionMetadata(sessionId, 'move', { section: 'Pinned', pinned: false }), /Archived/);
  assert.throws(() => store.updateSessionMetadata('../codex-thread', 'move', { section: 'Recents' }), /Invalid session ID/);
  assert.throws(() => store.updateSessionMetadata('ses_0000000000000000', 'move', { section: 'Recents' }), /Internal session not found/);
  store.updateSessionMetadata(sessionId, 'archive', { archived: false });
  assert.throws(() => store.updateSessionMetadata(sessionId, 'move', { section: 'bad/section', pinned: false }), /Invalid session metadata action/);
  store.updateSessionMetadata(sessionId, 'archive', { archived: true });
  assert.throws(() => store.updateSessionMetadata('codex_external_thread', 'pin', { pinned: true }), /Invalid session ID/);
  assert.throws(() => store.updateSessionMetadata('agy_external_thread', 'move', { section: 'Recents' }), /Invalid session ID/);

  const app = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.css'), 'utf8');
  assert.match(app, /const \{[^}]*mapSessionDropDestination[^}]*\} = window\.sessionDropMapping/);
  assert.match(app, /setData\('application\/x-only-chat-session', sessionId\)/);
  assert.match(app, /getData\('application\/x-only-chat-session'\)/);
  assert.match(app, /hasInternalSessionDragType(?:Model)?\(event\.dataTransfer\)/);
  assert.match(app, /createSessionMetadataGuardModel\(\)/);
  assert.match(app, /sessionMetadataGuard\.begin\(sessionId\)/);
  assert.match(app, /finally\s*\{\s*sessionMetadataGuard\.end\(sessionId\);\s*\}/,
    'pending session moves are released after success and every early failure return');
  assert.match(app, /연결 실패로 세션을 이동하지 못했습니다\. 잠시 후 다시 시도해 주세요\./, 'network failures are announced after a drop request');
  const dragOver = app.match(/addEventListener\('dragover',[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.doesNotMatch(dragOver, /getData\(/, 'dragover never reads protected payload');
  assert.match(app, /ses\.source === 'internal' && !ses\.archived/);
  assert.match(app, /sessionContextMenu/);
  assert.match(html, /internalSessionGrouping\.js"><\/script>[\s\S]*sessionDropMapping\.js"><\/script>[\s\S]*app\.js"><\/script>/);
  assert.match(html, /aria-live="polite"/);
  assert.match(css, /\.session-drop-target\.drop-target-active/);
  assert.doesNotMatch(app, /require\s*\(/, 'the renderer remains compatible with contextIsolation/nodeIntegration=false');
} finally {
  fs.rmSync(temporaryStorage, { recursive: true, force: true });
}

async function verifyDropHandler() {
  const appSource = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
  const feedback = appSource.match(/function setDropTargetFeedback\(target, active\) \{[\s\S]*?\n\}/)?.[0];
  const handler = appSource.match(/function attachSessionDropTarget\(target, destination\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(feedback && handler, 'actual sidebar drop handler remains extractable');

  const attributes = {};
  const status = { textContent: '' };
  const document = { getElementById: id => id === 'sessionDropStatus' ? status : null };
  const sessions = ['a', 'b'].map(letter => ({
    sessionId: `ses_${letter.repeat(16)}`, source: 'internal', archived: false, title: `Session ${letter}`
  }));
  const cachedUnifiedData = { internal: sessions };
  const guard = createSessionMetadataGuard();
  const requests = [];
  const fetch = (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
  let refreshCount = 0;
  let throwOnRefresh = false;
  const loadSessions = async () => {
    refreshCount += 1;
    if (throwOnRefresh) throw new Error('synthetic refresh failure');
  };
  const setFeedback = (target, active) => {
    target.classList.toggle('drop-target-active', active);
    target.setAttribute('aria-dragover', String(active));
  };
  const attach = new Function(
    'sessionMetadataGuard', 'mapSessionDropDestinationModel', 'cachedUnifiedData', 'document', 'fetch',
    'loadSessions', 'hasInternalSessionDragTypeModel', 'setDropTargetFeedback',
    `${feedback}\n${handler}\nreturn attachSessionDropTarget;`
  )(guard, mapSessionDropDestination, cachedUnifiedData, document, fetch, loadSessions, hasInternalSessionDragType, setFeedback);
  const makeTarget = () => {
    const target = {
      dataset: {}, listeners: {}, tabIndex: -1,
      classList: { add() {}, toggle() {} },
      addEventListener(name, callback) { this.listeners[name] = callback; },
      setAttribute(name, value) { attributes[name] = String(value); },
      getAttribute(name) { return attributes[name] || null; },
      contains() { return false; }
    };
    return target;
  };
  const firstTarget = makeTarget();
  const secondTarget = makeTarget();
  attach(firstTarget, { type: 'section', section: 'First' });
  attach(secondTarget, { type: 'section', section: 'Second' });
  const drop = sessionId => ({
    preventDefault() {},
    dataTransfer: { types: ['application/x-only-chat-session'], getData: type => type === 'application/x-only-chat-session' ? sessionId : '' }
  });
  const wrongTypeDrop = firstTarget.listeners.drop({
    preventDefault() {},
    dataTransfer: { types: ['text/plain'], getData: () => sessions[0].sessionId }
  });
  await wrongTypeDrop;
  assert.equal(requests.length, 0, 'a valid internal session ID in a plain-text drop is ignored');

  let feedbackActive = false;
  firstTarget.classList.toggle = (name, active) => { if (name === 'drop-target-active') feedbackActive = active; };
  firstTarget.listeners.dragover({ dataTransfer: { types: ['application/x-only-chat-session'] }, preventDefault() {}, get defaultPrevented() { return true; } });
  assert.equal(feedbackActive, true, 'an internal session drag activates target feedback');
  firstTarget.listeners.dragover({ dataTransfer: { types: ['text/plain'] }, preventDefault() {} });
  assert.equal(feedbackActive, false, 'moving an unrelated drag over an active target clears stale feedback');

  const first = firstTarget.listeners.drop(drop(sessions[0].sessionId));
  assert.equal(requests.length, 1);
  await secondTarget.listeners.drop(drop(sessions[0].sessionId));
  assert.equal(requests.length, 1, 'a second target cannot send a concurrent request for the same session');
  assert.match(status.textContent, /다른 그룹으로 이동 중/);
  const independent = secondTarget.listeners.drop(drop(sessions[1].sessionId));
  assert.equal(requests.length, 2, 'a different session can start while the first is pending');
  requests[0].resolve({ ok: true });
  requests[1].resolve({ ok: true });
  await Promise.all([first, independent]);
  assert.equal(refreshCount, 2);

  const httpFailure = firstTarget.listeners.drop(drop(sessions[0].sessionId));
  requests[2].resolve({ ok: false });
  await httpFailure;
  assert.match(status.textContent, /이동하지 못했습니다/);
  const afterHttpFailure = secondTarget.listeners.drop(drop(sessions[0].sessionId));
  requests[3].resolve({ ok: true });
  await afterHttpFailure;

  const networkFailure = firstTarget.listeners.drop(drop(sessions[0].sessionId));
  requests[4].reject(new Error('synthetic network failure'));
  await networkFailure;
  assert.match(status.textContent, /연결 실패/);
  const afterNetworkFailure = secondTarget.listeners.drop(drop(sessions[0].sessionId));
  requests[5].resolve({ ok: true });
  await afterNetworkFailure;

  throwOnRefresh = true;
  const refreshFailure = firstTarget.listeners.drop(drop(sessions[0].sessionId));
  requests[6].resolve({ ok: true });
  await assert.rejects(refreshFailure, /synthetic refresh failure/);
  throwOnRefresh = false;
  const afterRefreshFailure = secondTarget.listeners.drop(drop(sessions[0].sessionId));
  requests[7].resolve({ ok: true });
  await afterRefreshFailure;
  assert.equal(requests.length, 8, 'the guard is released even when the post-move refresh throws');
}

verifyDropHandler().then(() => {
  console.log('session sidebar mapping, persistence, actual drop concurrency/errors, and renderer wiring: PASS');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
