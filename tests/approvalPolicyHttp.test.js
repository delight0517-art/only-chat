'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { DesktopServer } = require('../src/ui/desktop/server.js');

function request(port, body, overrides = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/tool-approval', method: 'POST',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
        ...overrides
      }
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function pendingCall(app, requestId, sessionId) {
  let resolveCount = 0;
  let resolveValue;
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  const resolve = value => {
    resolveCount += 1;
    resolveValue = value;
    resolvePromise(value);
  };
  const timer = setTimeout(() => {}, 60_000);
  app.pendingToolApprovals.set(requestId, { sessionId, engine: app.engine, resolve, timer });
  return {
    promise,
    get resolveCount() { return resolveCount; },
    get resolveValue() { return resolveValue; },
    timer
  };
}

async function main() {
  const app = Object.create(DesktopServer.prototype);
  app.port = 0;
  app.isolated = false;
  app.pendingToolApprovals = new Map();
  app.engine = { currentSession: { sessionId: 'synthetic-session-a' } };
  const server = http.createServer((req, res) => app._handleRequest(req, res));

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    app.port = server.address().port;

    const approved = pendingCall(app, 'synthetic-approve-1', 'synthetic-session-a');
    const approveResponse = await request(app.port, {
      requestId: 'synthetic-approve-1', sessionId: 'synthetic-session-a', decision: 'approve'
    });
    assert.equal(approveResponse.status, 200);
    assert.equal(await approved.promise, true);
    assert.equal(approved.resolveCount, 1, 'approval must resolve once');
    await request(app.port, {
      requestId: 'synthetic-approve-1', sessionId: 'synthetic-session-a', decision: 'approve'
    });
    assert.equal(approved.resolveCount, 1, 'replayed approval must not resolve again');
    clearTimeout(approved.timer);

    const rejected = pendingCall(app, 'synthetic-reject-1', 'synthetic-session-a');
    const rejectResponse = await request(app.port, {
      requestId: 'synthetic-reject-1', sessionId: 'synthetic-session-a', decision: 'reject'
    });
    assert.equal(rejectResponse.status, 200);
    assert.equal(await rejected.promise, false);
    assert.equal(rejected.resolveCount, 1);
    clearTimeout(rejected.timer);

    const stale = pendingCall(app, 'synthetic-stale-1', 'synthetic-session-a');
    const staleResponse = await request(app.port, {
      requestId: 'synthetic-unknown-id', sessionId: 'synthetic-session-a', decision: 'approve'
    });
    assert.equal(staleResponse.status, 409);
    assert.equal(stale.resolveCount, 0);
    app.pendingToolApprovals.delete('synthetic-stale-1');
    clearTimeout(stale.timer);

    const crossSession = pendingCall(app, 'synthetic-cross-session-1', 'synthetic-session-a');
    const crossSessionResponse = await request(app.port, {
      requestId: 'synthetic-cross-session-1', sessionId: 'synthetic-session-b', decision: 'approve'
    });
    assert.equal(crossSessionResponse.status, 409);
    assert.equal(crossSession.resolveCount, 0);
    app.pendingToolApprovals.delete('synthetic-cross-session-1');
    clearTimeout(crossSession.timer);

    const switched = pendingCall(app, 'synthetic-session-switch-1', 'synthetic-session-a');
    app.engine.currentSession = { sessionId: 'synthetic-session-b' };
    const switchedResponse = await request(app.port, {
      requestId: 'synthetic-session-switch-1', sessionId: 'synthetic-session-a', decision: 'approve'
    });
    assert.equal(switchedResponse.status, 409);
    assert.equal(switched.resolveCount, 0);
    app.pendingToolApprovals.delete('synthetic-session-switch-1');
    clearTimeout(switched.timer);

    const crossOrigin = await request(app.port, {
      requestId: 'synthetic-cross-origin-1', sessionId: 'synthetic-session-b', decision: 'approve'
    }, { Origin: 'https://attacker.example', 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(crossOrigin.status, 403);
    console.log('approvalPolicyHttp.test.js: PASS (approve once, reject, stale/cross-session/session-switched 409, cross-origin blocked)');
  } finally {
    for (const pending of app.pendingToolApprovals.values()) clearTimeout(pending.timer);
    app.pendingToolApprovals.clear();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
