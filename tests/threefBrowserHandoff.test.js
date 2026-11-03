'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { DesktopServer, buildThreefDeepLink, createMacThreefOpener } = require('../src/ui/desktop/server.js');

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function main() {
  assert.equal(buildThreefDeepLink('https://example.com/path?q=hello%20world'), 'threef://open?url=https%3A%2F%2Fexample.com%2Fpath%3Fq%3Dhello%2520world');
  assert.equal(buildThreefDeepLink('file:///etc/passwd'), null);
  assert.equal(buildThreefDeepLink('javascript:alert(1)'), null);
  assert.equal(buildThreefDeepLink('https://user:secret@example.com'), null);

  let launch;
  await createMacThreefOpener((command, args, callback) => {
    launch = { command, args };
    callback(null);
  })('threef://open?url=https%3A%2F%2Fexample.com');
  assert.deepEqual(launch, {
    command: '/usr/bin/open',
    args: ['-b', 'com.rogan.threef.browser', 'threef://open?url=https%3A%2F%2Fexample.com']
  });
  await assert.rejects(createMacThreefOpener((_command, _args, callback) => {
    callback(new Error('3F Browser is not registered'));
  })('threef://open?url=https%3A%2F%2Fexample.com'), /3F Browser is not registered/);

  const port = await freePort();
  let opened;
  const handler = Object.create(DesktopServer.prototype);
  handler.port = port;
  handler.isolated = false;
  handler.threefControlSettings = { get: () => ({ enabled: true }) };
  handler.openExternal = async value => { opened = value; };
  handler.focusFencePolicy = { check: async url => ({ allowed: url.startsWith('https://allowed.test'), url, reason: url.startsWith('https://allowed.test') ? 'allowed' : 'blocked', rule: 'test block' }) };
  handler.engine = { tools: {
    browserOpen: async () => ({ ok: true, stdout: 'opened' }),
    browserAria: async () => ({ ariaTree: 'tree' }),
    browserAct: async () => ({ ok: true }),
    browserRead: async () => ({ ok: true, stdout: '3F page text' }),
    browserHistory: async action => ({ ok: true, stdout: `3F Browser ${action} complete`, url: 'https://example.com' })
  } };
  const server = http.createServer((req, res) => handler._handleRequest(req, res));
  await new Promise((resolve, reject) => server.listen(port, '127.0.0.1', resolve).once('error', reject));
  try {
    const authorized = await fetch(`http://127.0.0.1:${port}/api/browser/authorize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://allowed.test' })
    });
    assert.equal(authorized.status, 200);
    assert.equal((await authorized.json()).allowed, true);
    const denied = await fetch(`http://127.0.0.1:${port}/api/browser/authorize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://blocked.test' })
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).allowed, false);

    const navigated = await fetch(`http://127.0.0.1:${port}/api/browser/nav`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' })
    });
    assert.equal(navigated.status, 200);

    handler.engine.tools.browserOpen = async () => ({ ok: false, blocked: true, stderr: 'Focus Fence 차단' });
    const focusFenceBlocked = await fetch(`http://127.0.0.1:${port}/api/browser/nav`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' })
    });
    assert.equal(focusFenceBlocked.status, 403);

    handler.engine.tools.browserOpen = async () => ({ ok: false, stderr: 'Aside 실행 실패' });
    const asideUnavailable = await fetch(`http://127.0.0.1:${port}/api/browser/nav`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' })
    });
    assert.equal(asideUnavailable.status, 502);
    handler.engine.tools.browserOpen = async () => { throw new Error('browser unavailable'); };
    const thrownAsideError = await fetch(`http://127.0.0.1:${port}/api/browser/nav`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' })
    });
    assert.equal(thrownAsideError.status, 502);

    handler.engine.tools.browserAria = async () => { throw new Error('aria unavailable'); };
    const ariaFailure = await fetch(`http://127.0.0.1:${port}/api/browser/aria`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
    });
    assert.equal(ariaFailure.status, 502);
    handler.engine.tools.browserAct = async () => { throw new Error('action unavailable'); };
    const actionFailure = await fetch(`http://127.0.0.1:${port}/api/browser/act`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'read' })
    });
    assert.equal(actionFailure.status, 502);

    const pageRead = await fetch(`http://127.0.0.1:${port}/api/browser/read`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
    });
    assert.equal(pageRead.status, 200);
    assert.equal((await pageRead.json()).stdout, '3F page text');
    const history = await fetch(`http://127.0.0.1:${port}/api/browser/history`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'back' })
    });
    assert.equal(history.status, 200);
    assert.match((await history.json()).stdout, /3F Browser back/);

    handler.engine.tools.browserOpen = async url => {
      opened = buildThreefDeepLink(url);
      return { ok: true, stdout: '3F Browser opened', url };
    };
    const accepted = await fetch(`http://127.0.0.1:${port}/api/browser/threef/open`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/login?next=%2Fhome' })
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).ok, true);
    assert.equal(new URL(opened).protocol, 'threef:');
    assert.equal(new URL(opened).searchParams.get('url'), 'https://example.com/login?next=%2Fhome');

    const rejected = await fetch(`http://127.0.0.1:${port}/api/browser/threef/open`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'file:///etc/passwd' })
    });
    assert.equal(rejected.status, 400);

    handler.engine.tools.browserOpen = async () => ({ ok: false, stderr: '3F Browser를 열지 못했습니다.' });
    const unavailable = await fetch(`http://127.0.0.1:${port}/api/browser/threef/open`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' })
    });
    assert.equal(unavailable.status, 502);
    assert.deepEqual(await unavailable.json(), { ok: false, stderr: '3F Browser를 열지 못했습니다.' });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  handler.isolated = true;
  handler.openExternal = null;
  const isolatedPort = await freePort();
  handler.port = isolatedPort;
  const isolatedServer = http.createServer((req, res) => handler._handleRequest(req, res));
  await new Promise((resolve, reject) => isolatedServer.listen(isolatedPort, '127.0.0.1', resolve).once('error', reject));
  try {
    for (const pathname of ['/api/browser/nav', '/api/browser/aria', '/api/browser/act', '/api/browser/read', '/api/browser/history', '/api/browser/authorize']) {
      const blocked = await fetch(`http://127.0.0.1:${isolatedPort}${pathname}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', action: 'read' })
      });
      assert.equal(blocked.status, 403, `${pathname} must be disabled in isolated mode`);
    }
    const blocked = await fetch(`http://127.0.0.1:${isolatedPort}/api/browser/threef/open`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' })
    });
    assert.equal(blocked.status, 403);
  } finally {
    await new Promise(resolve => isolatedServer.close(resolve));
  }

  console.log('3F Browser deep link validation, HTTP handoff, and isolated-mode rejection passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
