'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Writable } = require('node:stream');
const vm = require('node:vm');
const { DesktopServer } = require('../src/ui/desktop/server.js');
const { groupInternalSessions } = require('../src/ui/desktop/internalSessionGrouping.js');
const helperSource = fs.readFileSync(require.resolve('../src/ui/desktop/internalSessionGrouping.js'), 'utf8');
const browserContext = vm.createContext({ window: {} });
vm.runInContext(helperSource, browserContext);
assert.equal(typeof browserContext.window.internalSessionGrouping.groupInternalSessions, 'function');
assert.deepEqual(
  JSON.parse(JSON.stringify(browserContext.window.internalSessionGrouping.groupInternalSessions(
    [{ sessionId: 'browser-pinned', pinned: true, section: 'recents' }], 'internal'
  ))),
  { pinned: [{ sessionId: 'browser-pinned', pinned: true, section: 'recents' }], recents: [], customSections: [] }
);
const html = fs.readFileSync(require.resolve('../src/ui/desktop/index.html'), 'utf8');
const groupingScriptIndex = html.indexOf('<script src="internalSessionGrouping.js"></script>');
const appScriptIndex = html.indexOf('<script src="app.js"></script>');
assert.notEqual(groupingScriptIndex, -1, 'index.html loads the grouping helper');
assert.ok(groupingScriptIndex < appScriptIndex, 'index.html loads grouping helper before app.js');

async function verifyHelperRoutes() {
  const app = Object.create(DesktopServer.prototype);
  app.port = 8899;
  app.isolated = false;
  app.syncEnabled = false;
  app.staticDir = require('node:path').join(__dirname, '../src/ui/desktop');
  async function request(pathname) {
    const headers = {};
    let body = Buffer.alloc(0);
    let statusCode;
    const res = new Writable({ write(chunk, _encoding, callback) { body = Buffer.concat([body, chunk]); callback(); } });
    res.writeHead = function (status, responseHeaders = {}) { statusCode = status; Object.assign(headers, responseHeaders); return this; };
    await app._handleRequest({
      url: pathname,
      method: 'GET',
      headers: { host: '127.0.0.1:8899' }
    }, res);
    if (!res.writableEnded) await new Promise((resolve, reject) => res.once('finish', resolve).once('error', reject));
    return { status: statusCode, headers, body };
  }
  for (const [asset, globalName, methodName] of [
    ['internalSessionGrouping.js', 'internalSessionGrouping', 'groupInternalSessions'],
    ['sessionDropMapping.js', 'sessionDropMapping', 'mapSessionDropDestination'],
    ['workspaceOwnershipPresentation.js', 'workspaceOwnershipPresentation', 'presentWorkspaceOwnership']
  ]) {
    const response = await request(`/${asset}`);
    assert.equal(response.status, 200, `${asset} is served`);
    assert.match(response.headers['Content-Type'] || '', /^application\/javascript(?:;|$)/);
    const browserContext = vm.createContext({ window: {} });
    vm.runInContext(response.body.toString('utf8'), browserContext);
    assert.equal(typeof browserContext.window[globalName], 'object', `${asset} installs ${globalName} on window`);
    assert.equal(typeof browserContext.window[globalName]?.[methodName], 'function', `${asset} exposes its browser global`);
  }
  const notionOauthRes = await request('/notion-oauth.js');
  assert.equal(notionOauthRes.status, 200, 'notion-oauth.js is served');
  assert.match(notionOauthRes.headers['Content-Type'] || '', /^application\/javascript(?:;|$)/);
  for (const unlistedPath of ['/unlisted.js', '/..%2FinternalSessionGrouping.js', '/%2e%2e%2FinternalSessionGrouping.js']) {
    const response = await request(unlistedPath);
    assert.equal(response.status, 404, `${unlistedPath} remains unserved`);
  }
}

const sessions = [
  { sessionId: 'pinned-recent', source: 'internal', section: 'recents', pinned: true },
  { sessionId: 'pinned-custom', source: 'internal', section: 'Research', pinned: true },
  { sessionId: 'recent', source: 'internal', section: 'recents', pinned: false },
  { sessionId: 'custom', source: 'internal', section: 'Research', pinned: false },
  { sessionId: 'archived-pinned', source: 'internal', section: 'recents', pinned: true, archived: true },
  { sessionId: 'archived-custom', source: 'internal', section: 'Research', archived: true }
];

function groupIds(groups) {
  return [
    ...groups.pinned.map(session => session.sessionId),
    ...groups.recents.map(session => session.sessionId),
    ...groups.customSections.flatMap(group => group.sessions.map(session => session.sessionId))
  ];
}

for (const filter of ['all', 'internal']) {
  const groups = groupInternalSessions(sessions, filter);
  assert.deepEqual(groups.pinned.map(session => session.sessionId), ['pinned-recent', 'pinned-custom']);
  assert.deepEqual(groups.recents.map(session => session.sessionId), ['recent']);
  assert.deepEqual(groups.customSections, [{ section: 'Research', sessions: [sessions[3]] }]);
  const ids = groupIds(groups);
  assert.equal(new Set(ids).size, ids.length, `${filter}: internal session appears in at most one active group`);
  assert.deepEqual([...ids].sort(), ['custom', 'pinned-custom', 'pinned-recent', 'recent'].sort());
}

for (const filter of ['codex', 'antigravity']) {
  const groups = groupInternalSessions(sessions, filter);
  assert.deepEqual(groups, { pinned: [], recents: [], customSections: [] });
  assert.equal(groupIds(groups).length, 0);
}

verifyHelperRoutes().then(() => {
  console.log('desktop internal session grouping and helper HTTP routes: PASS (no duplicates, pinned/unpinned, archived, safe static allowlist)');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
