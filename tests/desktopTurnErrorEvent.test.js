const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../src/ui/desktop/app.js'), 'utf8');
const start = source.indexOf('function setAssistantWorkStatus(card, text) {');
const end = source.indexOf('\nwindow.toggleAssistantMore =', start);
assert.ok(start >= 0 && end > start, 'assistant progress and handleStreamEvent remain extractable for their focused test');

function renderError(message) {
  const card = { content: { children: [], appendChild(node) { this.children.push(node); } } };
  const timeline = { scrollTop: 0, scrollHeight: 100 };
  const context = vm.createContext({
    card,
    timeline,
    event: { type: 'error', ...(typeof message === 'string' ? { message } : message) },
    refreshPriorityStatus: () => {},
    document: { createElement: () => ({ className: '', textContent: '', setAttribute() {}, addEventListener() {} }) }
  });
  vm.runInContext(`${source.slice(start, end)}\nhandleStreamEvent(event, card);`, context);
  return { card, timeline };
}

function renderSessionStarted(sessionId) {
  const context = vm.createContext({
    event: { type: 'session_started', clientSessionId: 'session_1000000000000', sessionId },
    card: {},
    timeline: { scrollTop: 0, scrollHeight: 0 },
    refreshModelSwitchSchedule: () => {}
  });
  return vm.runInContext(`let currentSessionId = 'session_1000000000000'; let currentCodexThreadId = 'old-thread'; ${source.slice(start, end)}; handleStreamEvent(event, card); [currentSessionId, currentCodexThreadId]`, context);
}

const { card, timeline } = renderError('raw token=unknown-secret@example.com');
assert.equal(card.content.children.length, 1);
assert.match(card.content.children[0].textContent, /AI 응답을 받지 못했습니다/);
assert.match(card.content.children[0].textContent, /안전한 오류 분류를 전달하지 않았습니다/);
assert.doesNotMatch(card.content.children[0].textContent, /unknown-secret@example\.com|token=/i);
assert.match(card.content.children[0].textContent, /완료된 것으로 간주하지 마세요/);
assert.equal(timeline.scrollTop, timeline.scrollHeight);

const categorized = renderError({
  category: 'authentication', model: 'GPT-6 Luna', rank: 2,
  message: 'raw stderr token=secret@example.com prompt=private tool-output=hidden'
});
const categorizedText = categorized.card.content.children[0].textContent;
assert.match(categorizedText, /실패 유형: 계정 인증 필요/);
assert.match(categorizedText, /시도한 모델: GPT-6 Luna/);
assert.match(categorizedText, /시도한 순위: 2순위/);
assert.match(categorizedText, /계정 인증이 풀렸습니다.*다시 로그인/s);
assert.doesNotMatch(categorizedText, /secret@example\.com|private|hidden|stderr|token=/i);

const fallback = renderError('');
assert.match(fallback.card.content.children[0].textContent, /서버에서 안전한 오류 분류를 전달하지 않았습니다/);
console.log('desktopTurnErrorEvent passed');

const rankOnly = renderError({ category: 'provider_failure', model: 'GPT-6 Luna', rank: 3 });
assert.match(rankOnly.card.content.children[0].textContent, /시도한 순위: 3순위/);
assert.match(rankOnly.card.content.children[0].textContent, /시도한 모델: GPT-6 Luna/);

const throttled = renderError({ category: 'quota_rate_limit', rank: 1 });
assert.match(throttled.card.content.children[0].textContent, /한도 상태를 확인한 뒤 다시 시도/);
const startedSessionState = renderSessionStarted('ses_0123456789abcdef');
assert.equal(startedSessionState[0], 'ses_0123456789abcdef');
assert.equal(startedSessionState[1], null, 'a new local session clears any prior Codex source binding');
const staleStartedSessionState = vm.runInNewContext(`let currentSessionId = 'ses_fedcba9876543210'; let currentCodexThreadId = null; const refreshModelSwitchSchedule = () => {}; ${source.slice(start, end)}; handleStreamEvent({ type: 'session_started', clientSessionId: 'session_1000000000000', sessionId: 'ses_0123456789abcdef' }, {}); currentSessionId`);
assert.equal(staleStartedSessionState, 'ses_fedcba9876543210', 'a late session-started event cannot replace a different selected chat');

if (process.env.ONLY_CHAT_FOCUSED_ERROR_CARD === '1') process.exit(0);

async function verifyAllProviderErrorsReachTheRenderer() {
  const { DesktopServer } = require('../src/ui/desktop/server.js');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'only-chat-turn-error-'));
  let app;
  try {
    app = new DesktopServer({
      port: 0,
      isolated: true,
      dataDir: profile,
      workspaceDir: path.join(profile, 'workspace'),
      enableQuotaRefresh: false,
      isTierReady: () => true,
      providerAdapter: async tier => {
        attemptedTiers.push(tier.id);
        throw new Error(`HTTP 429 quota exhausted token=raw-secret@example.com prompt=hidden-${tier.id} tool-output=private`);
      }
    });
    const attemptedTiers = [];
    app.engine.priorityChain.setTiers([1, 2, 3].map(tier => ({
      tier,
      id: `synthetic-${tier}`,
      name: `${tier}순위 합성 provider`,
      provider: 'synthetic',
      model: 'test-model',
      account: `synthetic-${tier}`,
      email: '',
      enabled: true
    })));
    const previousSession = app.engine.initSession({ title: 'Previously resumed session', workspaceDir: path.join(profile, 'previous-workspace') });
    app.engine.loadInternalSession(app.engine.sessions.resumeSession(previousSession.sessionId));

    // Reserve an ephemeral localhost port without changing the production server defaults.
    const net = require('node:net');
    const probe = net.createServer();
    await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    app.port = port;
    const { url } = await app.start();
    const invalidSessionResponse = await fetch(`${url}/api/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'ses_../../etc/passwd', prompt: 'must be rejected', reasoningEffort: 'low' })
    });
    assert.equal(invalidSessionResponse.status, 400);
    assert.equal(app.engine.currentSession.sessionId, previousSession.sessionId);

    const requestedNewSessionId = `session_${Date.now()}`;
    const requestedPrompt = 'synthetic exhausted-provider check';
    const response = await fetch(`${url}/api/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: requestedNewSessionId, prompt: requestedPrompt, reasoningEffort: 'low' })
    });
    const raw = await response.text();
    const events = raw.split(/\n\n/).flatMap(frame => frame.split('\n')
      .filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice(6))));

    assert.equal(response.status, 200);
    const startedSession = events.find(event => event.type === 'session_started');
    assert.match(startedSession?.sessionId || '', /^ses_[a-f0-9]{16}$/);
    assert.equal(startedSession.clientSessionId, requestedNewSessionId);
    assert.notEqual(startedSession.sessionId, previousSession.sessionId);
    assert.equal(app.engine.currentSession.workspaceDir, path.join(profile, 'workspace'), 'a new chat starts in the default workspace instead of inheriting the previously resumed chat workspace');
    assert.equal(app.engine.defaultWorkspaceDir, path.join(profile, 'workspace'), 'resuming a session does not mutate the launch default workspace');
    assert.equal(app.engine.currentSession.sessionId, startedSession.sessionId);
    assert.ok(app.engine.sessions.readSession(startedSession.sessionId).some(record => record.type === 'user_message' && record.content === requestedPrompt));
    assert.ok(!app.engine.sessions.readSession(previousSession.sessionId).some(record => record.type === 'user_message' && record.content === requestedPrompt), 'a new chat turn must not be appended to the previously resumed session');
    assert.deepEqual(attemptedTiers, ['synthetic-1', 'synthetic-2', 'synthetic-3']);
    const finalError = events.find(event => event.type === 'error');
    assert.ok(finalError);
    assert.equal(finalError.category, 'quota_rate_limit');
    assert.equal(finalError.model, 'test-model');
    assert.equal(finalError.rank, 3, 'final SSE error should identify the last attempted priority rank');
    assert.equal(finalError.message, 'The request could not be completed.');
    assert.doesNotMatch(JSON.stringify(finalError), /raw-secret@example\.com|hidden-|private|stderr|token=/i);
    const savedRecords = app.engine.sessions.readSession(app.engine.currentSession.sessionId);
    const savedFailure = savedRecords.findLast(record => record.type === 'turn_error');
    assert.deepEqual({ category: savedFailure.category, model: savedFailure.model, rank: savedFailure.rank }, {
      category: 'quota_rate_limit', model: 'test-model', rank: 3
    });
    assert.doesNotMatch(JSON.stringify(savedFailure), /raw-secret@example\.com|hidden-|private|stderr|token=/i);
    const resumed = app.engine.sessions.resumeSession(app.engine.currentSession.sessionId);
    assert.deepEqual(resumed.turns.at(-1), {
      role: 'assistant', outcome: 'error', error: { category: 'quota_rate_limit', model: 'test-model', rank: 3 }
    }, 'resumed session retains failure state without presenting it as a successful answer');
    assert.ok(!events.some(event => event.type === 'turn_complete'));
    const finalText = renderError(finalError).card.content.children[0].textContent;
    assert.match(finalText, /실패 유형: 사용 한도 또는 요청 속도 제한/);
    assert.match(finalText, /시도한 모델: test-model/);
    assert.match(finalText, /시도한 순위: 3순위/);
    assert.doesNotMatch(finalText, /raw-secret@example\.com|hidden-|private|stderr|token=/i);

    app.engine.executeTurn = async () => { throw new Error('unclassified token=unknown-secret@example.com prompt=private-output'); };
    const unknownResponse = await fetch(`${url}/api/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: requestedNewSessionId, prompt: 'synthetic unclassified failure check', reasoningEffort: 'low' })
    });
    const unknownRaw = await unknownResponse.text();
    const unknownEvents = unknownRaw.split(/\n\n/).flatMap(frame => frame.split('\n')
      .filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice(6))));
    const unknownError = unknownEvents.find(event => event.type === 'error');
    assert.ok(unknownError);
    const repeatedSessionStarted = unknownEvents.find(event => event.type === 'session_started');
    assert.equal(repeatedSessionStarted?.sessionId, startedSession.sessionId, 'a repeated temporary chat ID resolves to the existing local session');
    assert.equal(repeatedSessionStarted?.clientSessionId, requestedNewSessionId);
    assert.equal(app.engine.sessions.listSessions().length, 2, 'resolving the same temporary chat ID does not create a duplicate session');
    assert.equal(unknownError.message, 'The request could not be completed.');
    assert.doesNotMatch(JSON.stringify(unknownError), /unknown-secret@example\.com|private-output|token=/i);
    assert.match(renderError(unknownError).card.content.children[0].textContent, /안전한 오류 분류를 전달하지 않았습니다/);

    const continuationResponse = await fetch(`${url}/api/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: startedSession.sessionId, prompt: 'synthetic session continuation check', reasoningEffort: 'low' })
    });
    assert.equal(continuationResponse.status, 200);
    await continuationResponse.text();
    assert.equal(app.engine.currentSession.sessionId, startedSession.sessionId, 'a real local session ID continues on that same session');
    assert.equal(app.engine.sessions.listSessions().length, 2);
    console.log('desktopTurnErrorEvent API route passed: all synthetic 429s reach a visible, not-completed renderer error');
  } finally {
    app?.stop();
    fs.rmSync(profile, { recursive: true, force: true });
    assert.equal(fs.existsSync(profile), false, 'temporary isolated profile must be removed');
  }
}

verifyAllProviderErrorsReachTheRenderer().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
