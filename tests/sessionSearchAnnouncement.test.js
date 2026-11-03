'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/index.html'), 'utf8');
assert.match(htmlSource, /id="sessionSearchStatus"[^>]*role="status"[^>]*aria-live="polite"/);
assert.match(appSource, /sessionSearchStatus\.textContent = '세션 검색 중입니다\.'/);
assert.match(appSource, /sessionSearchStatus\.textContent = message/);
assert.match(appSource, /if \(!isValidSessionSearchResults\(\[event\.item\]\)\) \{\s*throw new Error\('invalid search result'\);\s*\}/, 'malformed streamed results are rejected before rendering');
assert.match(appSource, /renderSessionSearchFailure\(sessionSearchNetworkFailureMessage\(error\), \(\) => renderFilteredSessions\(\{ forceSearch: true \}\)\)/, 'malformed first results use the visible retry state');

const failureStart = appSource.indexOf('function renderSessionSearchFailure(message, onRetry = null) {');
const failureEnd = appSource.indexOf('\nfunction filterInternalSessionTitles(', failureStart);
assert.ok(failureStart >= 0 && failureEnd > failureStart, 'search failure renderer remains independently testable');
const recents = { children: [], replaceChildren(...children) { this.children = children; } };
const input = { focused: false, focus() { this.focused = true; } };
const failureStatus = { textContent: '' };
let rerenderCount = 0;
const failureContext = {
  document: { getElementById: id => id === 'sessionList' ? recents : null, createElement: () => ({ addEventListener(name, handler) { this[name] = handler; } }) },
  sessionSearchStatus: failureStatus,
  sessionSearchQuery: 'query',
  sessionSearchResults: null,
  sessionTitleSearch: input,
  renderFilteredSessions() { rerenderCount++; }
};
vm.runInNewContext(`${appSource.slice(failureStart, failureEnd)}\nglobalThis.renderFailure = renderSessionSearchFailure;`, failureContext);
let retryCount = 0;
failureContext.renderFailure('검색 오류', () => retryCount++);
assert.equal(failureStatus.textContent, '검색 오류');
assert.equal(recents.children[0].textContent, '검색 오류');
assert.equal(recents.children[1].textContent, '다시 시도');
recents.children[1].click();
assert.equal(failureContext.sessionSearchQuery, '');
assert.equal(failureContext.sessionSearchResults, null);
assert.equal(input.focused, true);
assert.equal(rerenderCount, 0, 'explicit retry callback starts a new search instead of relying on cached rendering');
assert.equal(retryCount, 1, 'the retry button invokes its explicit retry callback');

const start = appSource.indexOf('function renderSessionSearchResults() {');
const end = appSource.indexOf('\nfunction renderSessionItems(', start);
assert.ok(start >= 0 && end > start, 'search result renderer must remain extractable');
const status = { textContent: '' };
const list = { textContent: '', replaceChildren() {} };
const document = { getElementById: id => id === 'sessionSearchStatus' ? status : list };
const context = {
  document,
  sessionSearchStatus: status,
  currentFilter: 'all',
  sessionSearchResults: [{ source: 'codex' }, { source: 'antigravity' }],
  renderSessionItems() {}
};
vm.runInNewContext(`${appSource.slice(start, end)}\nglobalThis.render = renderSessionSearchResults;`, context);
context.render();
assert.equal(status.textContent, '검색 결과 2개.');
context.currentFilter = 'codex';
context.render();
assert.equal(status.textContent, '검색 결과 1개.');
context.currentFilter = 'internal';
context.render();
assert.equal(status.textContent, '일치하는 Only Chat 세션 제목이 없습니다.');
assert.equal(list.textContent, status.textContent, 'the visible empty state and polite announcement use the current search scope');
console.log('sessionSearchAnnouncement passed: polite loading/error/count announcements follow the current filter');

async function testRetryForcesFreshRequest() {
  const startFiltered = appSource.indexOf('function renderFilteredSessions({ forceSearch = false } = {}) {');
  const endFiltered = appSource.indexOf('\nfunction sessionSearchNetworkFailureMessage(', startFiltered);
  const failureEnd = appSource.indexOf('\nfunction filterInternalSessionTitles(', appSource.indexOf('function renderSessionSearchFailure(message, onRetry = null) {'));
  assert.ok(startFiltered >= 0 && endFiltered > startFiltered, 'search controller remains independently testable');
  assert.ok(failureEnd > 0, 'failure renderer remains independently testable');
  const failureMessageStart = appSource.indexOf('function sessionSearchFailureMessage(status) {');
  const failureMessageEnd = appSource.indexOf('\nfunction isValidSessionSearchResults(', failureMessageStart);
  const source = `${appSource.slice(startFiltered, endFiltered)}\n${appSource.slice(failureMessageStart, failureMessageEnd)}\n${appSource.slice(appSource.indexOf('function renderSessionSearchFailure(message, onRetry = null) {'), failureEnd)}`;
  const input = { value: '한국어 오류 검색', focused: false, focus() { this.focused = true; } };
  const list = { textContent: '', replaceChildren(...nodes) { this.nodes = nodes; } };
  const status = { textContent: '' };
  let fetchCount = 0;
  const context = {
    document: { getElementById: id => id === 'sessionList' ? list : status, createElement: () => ({ addEventListener(name, fn) { this[name] = fn; } }) },
    sessionTitleSearch: input,

    sessionSearchNetworkFailureMessage() { return 'network'; },
    isValidSessionSearchResults() { return true; },
    renderSessionSearchResults() {},
    sessionSearchStatus: status,
    currentFilter: 'all',
    sessionSearchQuery: '',
    sessionSearchResults: null,
    sessionSearchRequestId: 1,
    sessionSearchTimer: null,
    sessionSearchAbortController: null,
    cachedUnifiedData: { internal: [], unified: { sections: [], projects: [], pinned: [] } },
    pinnedSessionGroup: null,
    codexProjectGroup: null,
    fetch: async () => { fetchCount++; return { ok: false, status: 504 }; },
    AbortController,
    setTimeout(fn) { context.pendingSearch = fn; return 1; },
    clearTimeout() {},
    renderSessionItems() {},
    renderProjectGroups() {},
    groupInternalSessionsModel() { return { pinned: [], recents: [], customSections: [] }; },
    console
  };
  vm.runInNewContext(`${source}\nglobalThis.renderSearch = renderFilteredSessions; globalThis.renderFailure = renderSessionSearchFailure; `, context);
  context.renderSearch();
  assert.equal(fetchCount, 0, 'initial full-text search remains debounced');
  await context.pendingSearch();
  assert.equal(fetchCount, 1);
  assert.match(list.nodes[0].textContent, /시간 제한/);
  list.nodes[1].click();
  assert.equal(input.focused, true);
  assert.equal(fetchCount, 1, 'retry remains debounced before a new HTTP request');
  await context.pendingSearch();
  assert.equal(fetchCount, 2, 'retry bypasses the failed same-query cache and sends a fresh request');
  assert.match(list.nodes[0].textContent, /시간 제한/);
}

testRetryForcesFreshRequest().then(() => console.log('session search retry starts a fresh debounced HTTP request after a timeout'));

