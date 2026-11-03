'use strict';

const assert = require('node:assert');
const http = require('node:http');
const { DesktopServer } = require('../src/ui/desktop/server.js');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
const searchFailureSource = appSource.match(/function sessionSearchFailureMessage\(status\) \{[\s\S]*?\n\}/);
assert.ok(searchFailureSource, 'session search failures have a user-facing status mapper');
const sessionSearchFailureMessage = new Function(`${searchFailureSource[0]}; return sessionSearchFailureMessage;`)();
assert.match(sessionSearchFailureMessage(504), /시간 제한.*Only 필터/);
assert.doesNotMatch(sessionSearchFailureMessage(504), /20초/);
assert.doesNotMatch(sessionSearchFailureMessage(504), /검색어를 줄여/);
assert.match(sessionSearchFailureMessage(500), /세션 검색 요청이 실패했습니다/);
const searchNetworkFailureSource = appSource.match(/function sessionSearchNetworkFailureMessage\(error\) \{[\s\S]*?\n\}/);
assert.ok(searchNetworkFailureSource, 'search transport errors have a focused user-facing mapper');
const sessionSearchNetworkFailureMessage = new Function(`${searchNetworkFailureSource[0]}; return sessionSearchNetworkFailureMessage;`)();
assert.match(sessionSearchNetworkFailureMessage(new TypeError('fetch failed')), /서버에 연결할 수 없습니다.*다시 시도/);
assert.match(sessionSearchNetworkFailureMessage(new Error('unexpected')), /잠시 후 다시 시도/);
assert.equal(sessionSearchNetworkFailureMessage({ name: 'AbortError' }), '세션 검색이 취소되었습니다.');
const resultValidatorSource = appSource.match(/function isValidSessionSearchResults\(results\) \{[\s\S]*?\n\}/);
assert.ok(resultValidatorSource, 'search result schema validator is available before rendering');
const isValidSessionSearchResults = new Function(`${resultValidatorSource[0]}; return isValidSessionSearchResults;`)();
assert.equal(isValidSessionSearchResults([{ id: 'codex_thread', source: 'codex', title: 'Title', snippet: 'match', updatedAt: 1 }]), true);
assert.equal(isValidSessionSearchResults([{ id: 'agy_session', source: 'antigravity', title: 'Title', snippet: '', updatedAt: 2 }]), true);
for (const malformed of [null, {}, [{ id: 'codex_thread', source: 'codex', title: 'Title', snippet: 'match' }], [{ id: {}, source: 'codex', title: 'Title', snippet: 'match', updatedAt: 1 }], [{ id: 'codex_thread', source: 'other', title: 'Title', snippet: 'match', updatedAt: 1 }]]) {
  assert.equal(isValidSessionSearchResults(malformed), false, 'malformed search payloads are rejected as a whole');
}
assert.match(appSource, /if \(!isValidSessionSearchResults\(\[event\.item\]\)\)/, 'each streamed search record is rejected before list rendering');
assert.match(appSource, /fetch\('\/api\/sessions\/search\/stream'/, 'the UI consumes the progressive search route');
assert.match(appSource, /consumeSessionSearchStream\(response, handleEvent/, 'the UI incrementally consumes NDJSON events');
assert.match(appSource, /if \(terminal === 'complete'\) \{[\s\S]*?renderSessionSearchResults\(\);\s*if \(sessionSearchStatus\) sessionSearchStatus\.textContent = `전체 기록 검색 완료 · 결과 \$\{sessionSearchResults\.length\}개\.`;/, 'the final full-corpus result count replaces the streaming progress label');
assert.match(appSource, /event\.fileBytesScanned[\s\S]*?파일 \$\{Math\.round\(event\.fileBytesScanned \/ 1048576\)\}\/\$\{Math\.ceil\(event\.fileBytesTotal \/ 1048576\)\}MB/, 'large transcript progress includes bounded per-file byte counts');
const streamConsumerSource = appSource.match(/async function consumeSessionSearchStream\(response, onEvent, shouldContinue = \(\) => true\) \{[\s\S]*?\n\}/);
assert.ok(streamConsumerSource, 'the actual renderer stream consumer is independently testable');
const consumeSessionSearchStream = new Function(`${streamConsumerSource[0]}; return consumeSessionSearchStream;`)();
assert.match(appSource, /renderSessionSearchPartial\('시간 제한으로 전체 검색을 마치지 못했습니다\. 표시된 결과는 일부입니다\.'/, 'partial results are explicitly labeled and retryable');
assert.match(appSource, /sessionSearchFailureMessage\(response\.status\)/, 'HTTP failures are mapped to a readable message');
assert.match(appSource, /renderSessionSearchFailure\(message, \(\) => renderFilteredSessions\(\{ forceSearch: true \}\)\)/, 'retry bypasses an unchanged failed query cache');
assert.match(appSource, /if \(forceSearch \|\| normalizedQuery !== sessionSearchQuery\)/, 'forced retry starts a new request for the same query');
assert.match(appSource, /renderSessionSearchFailure\(sessionSearchNetworkFailureMessage\(error\), \(\) => renderFilteredSessions\(\{ forceSearch: true \}\)\)/, 'transport failures use the focused network error mapper and retry');
assert.match(appSource, /if \(requestId === sessionSearchRequestId && error\?\.name !== 'AbortError'\)/, 'stale and explicitly aborted requests cannot replace the current search state');
assert.match(appSource, /sessionSearchResults = filterInternalSessionTitles\(internal, normalizedQuery\)/, 'Only filter searches internal session titles locally');
assert.match(appSource, /currentFilter === 'internal' \? '일치하는 Only Chat 세션 제목이 없습니다\.' : '검색 결과가 없습니다\.'/, 'empty search state names the active search scope');
assert.match(appSource, /sessionSearchAbortController\?\.abort\(\);\s*sessionSearchAbortController = null;\s*sessionSearchResults = filterInternalSessionTitles/, 'local Only title search cancels any pending external transcript search');
assert.match(appSource, /if \(sessionTitleSearch\?\.value\.trim\(\)\) \{\s*sessionSearchQuery = '';\s*sessionSearchResults = null;/, 'changing filters invalidates cached results so the new scope is searched');
assert.match(appSource, /currentFilter = btn\.getAttribute\('data-filter'\);\s*updateSessionSearchScope\(\);/, 'changing the filter updates the search control scope');
const titleFilterSource = appSource.match(/function filterInternalSessionTitles\(sessions, query\) \{[\s\S]*?\n\}/);
assert.ok(titleFilterSource, 'local title filtering remains independently checkable');
const titleFilter = new Function(`${titleFilterSource[0]}; return filterInternalSessionTitles;`)();
assert.deepStrictEqual(titleFilter([
  { source: 'internal', title: '한국어 세션 제목' },
  { source: 'internal', title: 'Other task' },
  { source: 'codex', title: '한국어 외부 세션' }
], '제목 한국어').map(session => session.title), ['한국어 세션 제목']);
assert.deepStrictEqual(titleFilter([{ title: 'A' }], '  ').length, 0);
const scopeSource = appSource.match(/function updateSessionSearchScope\(\) \{[\s\S]*?\n\}/);
assert.ok(scopeSource, 'search scope announcement remains independently checkable');
function scopeFor(currentFilter) {
  const input = { placeholder: '', attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  new Function('currentFilter', 'sessionTitleSearch', `${scopeSource[0]}; updateSessionSearchScope();`)(currentFilter, input);
  return input;
}
assert.equal(scopeFor('internal').attributes['aria-label'], 'Only Chat 세션 제목 검색');
assert.equal(scopeFor('internal').placeholder, 'Only Chat 제목 검색');
assert.equal(scopeFor('all').attributes['aria-label'], '과거 Codex·Antigravity 세션 전문 검색');

function post(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/sessions/search',
      method: 'POST',
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let response = '';
      res.setEncoding('utf8');
      res.on('data', chunk => response += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(response) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function postStream(port, body, pathname = '/api/sessions/search/stream') {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', Accept: 'application/x-ndjson', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      const events = [];
      let pending = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line.trim()) events.push(JSON.parse(line));
        }
      });
      res.on('end', () => {
        if (pending.trim()) events.push(JSON.parse(pending));
        resolve({ status: res.statusCode, events });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function main() {
  const encoder = new TextEncoder();
  async function consumeChunks(chunks, shouldContinue = () => true) {
    const events = [];
    const byteChunks = chunks.map(chunk => encoder.encode(chunk));
    let index = 0;
    const terminal = await consumeSessionSearchStream({ body: { getReader: () => ({
      async read() { return index < byteChunks.length ? { done: false, value: byteChunks[index++] } : { done: true }; }
    }) } }, event => events.push(event), shouldContinue);
    return { events, terminal };
  }
  const streamedFixture = await consumeChunks([
    '{"type":"started"}\n{"type":"result","item":{"id":"codex_1","source":"codex","title":"한국',
    '어 fixture","snippet":"일치 문장","updatedAt":3}}\n{"type":"progress","source":"codex","scanned":2,',
    '"total":4,"fileBytesScanned":16777216,"fileBytesTotal":50331648}\n{"type":"complete","resultCount":1}'
  ]);
  assert.strictEqual(streamedFixture.terminal, 'complete');
  assert.deepStrictEqual(streamedFixture.events.map(event => event.type), ['started', 'result', 'progress', 'complete']);
  assert.strictEqual(streamedFixture.events[1].item.title, '한국어 fixture', 'UTF-8 and NDJSON records survive arbitrary chunk boundaries');
  assert.strictEqual(streamedFixture.events[2].fileBytesScanned, 16777216, 'file-level progress bytes survive arbitrary UTF-8/NDJSON chunk boundaries');
  const partialFixture = await consumeChunks(['{"type":"started"}\n{"type":"result","item":{"id":"agy_1",', '"source":"antigravity","title":"일부","snippet":"부분 결과","updatedAt":4}}\n{"type":"incomplete","reason":"timeout"}\n']);
  assert.strictEqual(partialFixture.terminal, 'incomplete');
  assert.strictEqual(partialFixture.events.filter(event => event.type === 'result').length, 1, 'partial results remain available before timeout');
  const disconnectedFixture = await consumeChunks(['{"type":"started"}\n{"type":"progress","scanned":1,"total":2}\n']);
  assert.strictEqual(disconnectedFixture.terminal, null, 'an unannounced disconnect remains distinguishable from successful completion');
  const app = Object.create(DesktopServer.prototype);
  app.port = 0;
  app.sessionSearchTimeoutMs = 35;
  app.sessionSearchStreamTimeoutMs = 35;
  let searched;
  let adapterSignal;
  let onSearchStart;
  let mode = 'success';
  app.nativeSessions = {
    searchSessions: (query, { signal, onResult, onProgress }) => {
      searched = query;
      adapterSignal = signal;
      if (mode === 'timeout') return new Promise(() => {});
      if (mode === 'disconnect') {
        onSearchStart?.(signal);
        return new Promise(() => {});
      }
      const result = { id: 'codex_thread-1', source: 'codex', title: 'Task', updatedAt: 1, snippet: 'matched text' };
      if (onResult) onResult(result);
      if (onProgress) onProgress({ scanned: 1, total: 1, source: 'codex' });
      return [result];
    }
  };
  const server = http.createServer((req, res) => app._handleRequest(req, res));
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    app.port = server.address().port;
    const found = await post(app.port, { query: '  search term  ' });
    assert.strictEqual(found.status, 200);
    assert.strictEqual(searched, 'search term');
    assert.strictEqual(found.body.results[0].snippet, 'matched text');
    const streamed = await postStream(app.port, { query: 'stream me' });
    assert.strictEqual(streamed.status, 200);
    assert.strictEqual(streamed.events[0].type, 'started');
    assert.deepStrictEqual(streamed.events.filter(event => event.type === 'result').map(event => event.item.id), ['codex_thread-1']);
    assert.ok(streamed.events.some(event => event.type === 'progress'));
    assert.deepStrictEqual(streamed.events.at(-1), { type: 'complete', resultCount: 1 });
    assert.strictEqual((await post(app.port, { query: '   ' })).status, 400);
    assert.strictEqual((await post(app.port, { query: 'x'.repeat(201) })).status, 400);
    mode = 'timeout';
    const timedOut = await post(app.port, { query: 'slow search' });
    assert.strictEqual(timedOut.status, 504);
    assert.deepStrictEqual(timedOut.body, { error: '세션 검색 시간이 초과되었습니다.' });
    assert.strictEqual(adapterSignal.aborted, true);

    const streamedTimeout = await postStream(app.port, { query: 'slow stream' });
    assert.strictEqual(streamedTimeout.status, 200);
    assert.deepStrictEqual(streamedTimeout.events.map(event => event.type), ['started', 'incomplete']);
    assert.strictEqual(streamedTimeout.events.at(-1).reason, 'timeout');
    assert.strictEqual(adapterSignal.aborted, true);

    mode = 'disconnect';
    const disconnected = new Promise((resolve, reject) => {
      const payload = JSON.stringify({ query: 'disconnect search' });
      const searchStarted = new Promise(resolveStarted => { onSearchStart = resolveStarted; });
      let abortObserved;
      const req = http.request({
        host: '127.0.0.1', port: app.port, path: '/api/sessions/search', method: 'POST',
        headers: {
          Origin: `http://127.0.0.1:${app.port}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, res => reject(new Error(`Unexpected response: ${res.statusCode}`)));
      req.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
      req.end(payload);
      searchStarted.then(signal => {
        adapterSignal = signal;
        abortObserved = new Promise((resolveAborted, rejectAborted) => {
          const timer = setTimeout(() => rejectAborted(new Error('Search abort signal was not observed after client disconnect.')), 1000);
          signal.addEventListener('abort', () => { clearTimeout(timer); resolveAborted(); }, { once: true });
        });
        req.destroy();
        abortObserved.then(resolve, reject);
      });
    });
    await disconnected;
    assert.strictEqual(adapterSignal.aborted, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log('desktop full-text session search route passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
