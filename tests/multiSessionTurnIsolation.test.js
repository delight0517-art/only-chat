'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { test } = require('node:test');
const { DesktopServer } = require('../src/ui/desktop/server.js');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function readTurn(response) {
  const stream = await response.text();
  const events = [...stream.matchAll(/data:\s*(\{[^\n]*\})/g)].map(match => {
    try { return JSON.parse(match[1]); } catch (_) { return null; }
  }).filter(Boolean);
  return { stream, events };
}

async function waitFor(promise, message, timeoutMs = 3000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('concurrent turns remain isolated across sessions', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'only-chat-turn-isolation-'));
  let app;
  let responseA;
  let responseB;
  let releaseA;
  let releaseSameA;
  let signalAStarted;
  let signalBStarted;
  let signalSameAStarted;
  let signalSameBStarted;
  const startedA = new Promise(resolve => { signalAStarted = resolve; });
  const startedB = new Promise(resolve => { signalBStarted = resolve; });
  const startedSameA = new Promise(resolve => { signalSameAStarted = resolve; });
  const startedSameB = new Promise(resolve => { signalSameBStarted = resolve; });
  const blockedA = new Promise(resolve => { releaseA = resolve; });
  const blockedSameA = new Promise(resolve => { releaseSameA = resolve; });
  const providerPrompts = [];
  const fileReadGuidancePrompts = [];
  try {
    app = new DesktopServer({
      isolated: true, port: await freePort(), dataDir: path.join(profile, 'profile'),
      workspaceDir: path.join(profile, 'profile', 'workspace'), enableQuotaRefresh: false,
      enableSchedules: false, dispatcherAutoStart: false, isTierReady: () => true,
      providerAdapter: async (_tier, history) => {
        const latestUser = [...history].reverse().find(item => item.role === 'user');
        const completePrompt = latestUser?.content;
        if (completePrompt?.includes('[Only Chat file-read guidance]')) fileReadGuidancePrompts.push(completePrompt);
        const prompt = completePrompt?.split('\n\n[Only Chat file-read guidance]')[0];
        providerPrompts.push(prompt);
        if (prompt === 'CHAT_A') {
          signalAStarted();
          await blockedA;
          return { content: 'CHAT_A_REPLY', toolCalls: [] };
        }
        if (prompt === 'CHAT_B') {
          signalBStarted();
          return { content: 'CHAT_B_REPLY', toolCalls: [] };
        }
        if (prompt === 'SAME_A') {
          signalSameAStarted();
          await blockedSameA;
          return { content: 'SAME_A_REPLY', toolCalls: [] };
        }
        if (prompt === 'SAME_B') {
          signalSameBStarted();
          return { content: 'SAME_B_REPLY', toolCalls: [] };
        }
        if (prompt === 'ERROR_TURN') {
          const error = new Error('HTTP 429 Too Many Requests: raw-secret@example.com private output token=hidden');
          error.model = 'synthetic-isolation-model';
          error.rank = 1;
          throw error;
        }
        throw new Error(`Unexpected provider prompt: ${prompt}`);
      }
    });
    app.engine.priorityChain.setTiers([{
      tier: 1, id: 'synthetic-isolation', name: 'Synthetic isolation', provider: 'synthetic',
      model: 'synthetic-isolation-model', enabled: true
    }]);
    const { url } = await app.start();
    const releaseFirstSlot = await app._acquireTurnRequestSlot();
    let secondSlotAcquired = false;
    const secondSlot = app._acquireTurnRequestSlot().then(release => {
      secondSlotAcquired = true;
      return release;
    });
    await Promise.resolve();
    assert.equal(secondSlotAcquired, false, 'a second turn cannot acquire the queue slot while the first owns it');
    releaseFirstSlot();
    const releaseSecondSlot = await secondSlot;
    assert.equal(secondSlotAcquired, true);
    releaseSecondSlot();

    const sendTurn = (sessionId, prompt) => fetch(`${url}/api/turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, prompt, reasoningEffort: 'low', modelSelection: 'synthetic-isolation-model', toolProfile: 'file-read' })
    });
    const sessionA = 'session_1234567890';
    const sessionB = 'session_12345678901';
    assert.match(sessionA, /^session_\d{10,16}$/);
    assert.match(sessionB, /^session_\d{10,16}$/);
    responseA = await sendTurn(sessionA, 'CHAT_A');
    assert.equal(responseA.status, 200);
    const pendingA = readTurn(responseA);
    await startedA;
    const responseBPending = sendTurn(sessionB, 'CHAT_B');
    await waitFor(startedB, 'CHAT_B must reach the provider while CHAT_A is still running');
    responseB = await responseBPending;
    assert.equal(responseB.status, 200, 'CHAT_B starts before the active CHAT_A turn completes');
    const pendingB = readTurn(responseB);
    assert.deepEqual(providerPrompts, ['CHAT_A', 'CHAT_B'], 'separate read-only chats overlap at the provider in submission order');
    assert.equal(fileReadGuidancePrompts.length, 2, 'Only Chat adds grounded bounded-read instructions to each read-only request');
    assert.ok(fileReadGuidancePrompts.every(item => /start_line and end_line/.test(item)));
    releaseA();
    const [resultA, resultB] = await Promise.all([pendingA, pendingB]);
    assert.match(resultA.stream, /CHAT_A_REPLY/);
    assert.match(resultB.stream, /CHAT_B_REPLY/);
    assert.match(resultA.stream, /\[DONE\]/);
    assert.match(resultB.stream, /\[DONE\]/);
    const internalIds = [resultA, resultB].map(result => result.events.find(event => event.type === 'session_started')?.sessionId);
    assert.ok(internalIds.every(Boolean), 'each stream contains a session_started internal ID');
    assert.notEqual(internalIds[0], internalIds[1]);
    const savedA = JSON.stringify(app.engine.sessions.resumeSession(internalIds[0]));
    const savedB = JSON.stringify(app.engine.sessions.resumeSession(internalIds[1]));
    assert.match(savedA, /CHAT_A/);
    assert.match(savedA, /CHAT_A_REPLY/);
    assert.doesNotMatch(savedA, /CHAT_B/);
    assert.match(savedB, /CHAT_B/);
    assert.match(savedB, /CHAT_B_REPLY/);
    assert.doesNotMatch(savedB, /CHAT_A/);

    const sameSessionId = internalIds[0];
    const sameAResponse = await sendTurn(sameSessionId, 'SAME_A');
    const sameAPending = readTurn(sameAResponse);
    await startedSameA;
    const sameBResponsePending = sendTurn(sameSessionId, 'SAME_B');
    let sameBStartedEarly = false;
    const earlyStart = startedSameB.then(() => { sameBStartedEarly = true; });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(sameBStartedEarly, false, 'two turns in one conversation stay ordered');
    releaseSameA();
    const sameBResponse = await sameBResponsePending;
    const sameBPending = readTurn(sameBResponse);
    await waitFor(earlyStart, 'the second turn in one conversation starts after the first completes');
    const [sameAResult, sameBResult] = await Promise.all([sameAPending, sameBPending]);
    assert.match(sameAResult.stream, /SAME_A_REPLY/);
    assert.match(sameBResult.stream, /SAME_B_REPLY/);
    const savedSameSession = JSON.stringify(app.engine.sessions.resumeSession(sameSessionId));
    assert.ok(savedSameSession.indexOf('SAME_A') < savedSameSession.indexOf('SAME_B'));
    assert.match(savedSameSession, /SAME_A_REPLY[\s\S]*SAME_B[\s\S]*SAME_B_REPLY/);

    const errorResponse = await sendTurn('session_1234567890123', 'ERROR_TURN');
    const errorResult = await readTurn(errorResponse);
    const errorEvent = errorResult.events.find(event => event.type === 'error');
    assert.deepEqual({ category: errorEvent?.category, model: errorEvent?.model, rank: errorEvent?.rank }, {
      category: 'quota_rate_limit', model: 'synthetic-isolation-model', rank: 1
    });
    assert.doesNotMatch(JSON.stringify(errorEvent), /raw-secret@example\.com|private output|token=hidden/);
    const errorSessionId = errorResult.events.find(event => event.type === 'session_started')?.sessionId;
    const savedErrorSession = JSON.stringify(app.engine.sessions.resumeSession(errorSessionId));
    assert.match(savedErrorSession, /quota_rate_limit/);
    assert.doesNotMatch(savedErrorSession, /raw-secret@example\.com|private output|token=hidden/);
  } finally {
    releaseA?.();
    releaseSameA?.();
    try { if (responseA?.body) await responseA.body.cancel(); } catch (_) {}
    try { if (responseB?.body) await responseB.body.cancel(); } catch (_) {}
    await app?.stop();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
