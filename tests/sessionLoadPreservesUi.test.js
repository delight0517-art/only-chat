'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
const start = source.indexOf('async function loadSession(sessionId, title, source = null) {');
const end = source.indexOf('\n// ============', start);
assert.ok(start >= 0 && end > start, 'loadSession must remain extractable');

function makeHarness(fetch, initialDraft = '') {
  const status = { textContent: '' };
  const oldRow = { id: 'old-row' };
  const timeline = {
    rows: [oldRow],
    clearCount: 0,
    replaceChildren() { this.rows = []; this.clearCount++; },
    appendChild(row) { this.rows.push(row); },
    get scrollHeight() { return this.rows.length; }
  };
  const titlebarThreadTitle = { textContent: 'Existing conversation' };
  const emptyState = { style: { display: 'none' } };
  const composerInput = { value: initialDraft, readOnly: false };
  const btnMicrophone = { disabled: false };
  const context = {
    fetch,
    console: { warn() {} },
    document: { getElementById: id => id === 'sessionListStatus' ? status : null, createElement: () => ({ appendChild() {} }) },
    window: {},
    timeline,
    titlebarThreadTitle,
    emptyState,
    composerInput,
    btnMicrophone,
    appendUserMessage() {},
    createAssistantContainer() { return { content: { appendChild() {} }, row: {} }; },
    goalCancelReasons: [],
    async loadSessions() { context.sessionListLoads++; },
    sessionListLoads: 0,
    async refreshPriorityStatus() { context.priorityStatusRefreshes++; },
    priorityStatusRefreshes: 0
  };
  vm.runInNewContext(`let currentSessionId = 'existing'; let currentCodexThreadId = null; let activeGoal = null; let sessionLoadRequestId = 0; let sessionResumeQueue = Promise.resolve(); let sessionResumePendingCount = 0; let sessionResumeOriginalComposerReadOnly = false; let sessionResumeOriginalMicrophoneDisabled = false; let currentAbortController = null; let isGenerating = false; let isRecording = false; function cancelActiveGoal(reason) { if (!activeGoal) return; activeGoal = null; globalThis.goalCancelReasons.push(reason); } ${source.slice(start, end)}; globalThis.openSession = loadSession; globalThis.currentId = () => currentSessionId; globalThis.currentCodexId = () => currentCodexThreadId; globalThis.setActiveGoal = goal => { activeGoal = goal; }; globalThis.getActiveGoal = () => activeGoal; globalThis.setActivity = values => { if ('isGenerating' in values) isGenerating = values.isGenerating; if ('isRecording' in values) isRecording = values.isRecording; if ('hasAbortController' in values) currentAbortController = values.hasAbortController ? {} : null; };`, context);
  return { context, status, timeline, titlebarThreadTitle, emptyState, composerInput, btnMicrophone };
}

async function run() {
  const draftBlocked = makeHarness(async () => { assert.fail('a dirty composer must not switch sessions'); });
  draftBlocked.composerInput.value = 'unsent draft';
  const protectedGoal = { sessionId: 'existing', iteration: 2 };
  draftBlocked.context.setActiveGoal(protectedGoal);
  assert.equal(await draftBlocked.context.openSession('ses_1111111111111111', 'New session', 'internal'), false);
  assert.equal(draftBlocked.context.currentId(), 'existing');
  assert.equal(draftBlocked.timeline.clearCount, 0);
  assert.equal(draftBlocked.composerInput.value, 'unsent draft');
  assert.equal(draftBlocked.context.getActiveGoal(), protectedGoal, 'a rejected session switch must preserve the active Goal');
  assert.deepEqual(draftBlocked.context.goalCancelReasons, [], 'do not cancel a Goal before the draft guard rejects the switch');
  assert.match(draftBlocked.status.textContent, /초안·음성 입력·진행 중인 응답/);

  const protectedWork = makeHarness(async () => { assert.fail('active work must not switch sessions'); });
  protectedWork.context.setActivity({ isRecording: true });
  assert.equal(await protectedWork.context.openSession('ses_1111111111111111', 'New session', 'internal'), false);
  assert.equal(protectedWork.context.currentId(), 'existing');
  assert.equal(protectedWork.timeline.clearCount, 0);

  const failed = makeHarness(async () => ({ ok: false, status: 503, async json() { return {}; } }));
  assert.equal(await failed.context.openSession('ses_1111111111111111', 'New session', 'internal'), false);
  assert.equal(failed.context.currentId(), 'existing');
  assert.equal(failed.timeline.clearCount, 0);
  assert.deepEqual(failed.timeline.rows, [{ id: 'old-row' }]);
  assert.equal(failed.titlebarThreadTitle.textContent, 'Existing conversation');
  assert.equal(failed.composerInput.value, '');
  assert.match(failed.status.textContent, /현재 대화는 유지됩니다/);
  assert.equal(failed.context.priorityStatusRefreshes, 0, 'failed resume does not refresh active workspace status');

  const malformed = makeHarness(async () => ({
    ok: true,
    status: 200,
    async json() { return { ok: true, session: { source: 'internal', title: 'Broken', turns: 'not-an-array' } }; }
  }));
  await malformed.context.openSession('ses_3333333333333333', 'Broken', 'internal');
  assert.equal(malformed.context.currentId(), 'existing');
  assert.equal(malformed.timeline.clearCount, 0);
  assert.deepEqual(malformed.timeline.rows, [{ id: 'old-row' }]);
  assert.equal(malformed.composerInput.value, '');
  assert.match(malformed.status.textContent, /현재 대화는 유지됩니다/);
  assert.equal(malformed.context.priorityStatusRefreshes, 0, 'invalid resume does not refresh active workspace status');

  const resolvers = [];
  const requestedIds = [];
  const race = makeHarness((_url, options) => {
    requestedIds.push(JSON.parse(options.body).sessionId);
    return new Promise(resolve => { resolvers.push(resolve); });
  });
  const first = race.context.openSession('ses_1111111111111111', 'First', 'internal');
  const second = race.context.openSession('ses_2222222222222222', 'Second', 'internal');
  const resume = title => ({ ok: true, status: 200, async json() { return { ok: true, session: { source: 'internal', title, turns: [] } }; } });
  // Resume requests are serialized because each one also changes the server's active session.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolvers.length, 1);
  assert.equal(race.composerInput.readOnly, true, 'composer remains locked while the active session is being changed');
  assert.equal(race.btnMicrophone.disabled, true, 'microphone cannot begin during a session transition');
  resolvers[0](resume('First loaded'));
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolvers.length, 2);
  assert.equal(race.composerInput.readOnly, true, 'a queued session transition keeps the composer locked');
  assert.equal(race.btnMicrophone.disabled, true, 'a queued session transition keeps the microphone disabled');
  assert.deepEqual(requestedIds, ['ses_1111111111111111', 'ses_2222222222222222']);
  resolvers[1](resume('Second loaded'));
  await second;
  assert.equal(race.context.currentId(), 'ses_2222222222222222');
  assert.equal(race.titlebarThreadTitle.textContent, 'Second loaded');
  assert.equal(race.timeline.clearCount, 1);
  assert.equal(race.context.sessionListLoads, 1);
  assert.equal(race.context.priorityStatusRefreshes, 1, 'only the latest resumed session refreshes the active workspace status');
  assert.equal(race.composerInput.readOnly, false, 'the composer returns to its original state when all resumes finish');
  assert.equal(race.btnMicrophone.disabled, false, 'the microphone returns to its original state when all resumes finish');

  const external = makeHarness(async () => ({
    ok: true,
    status: 200,
    async json() { return { ok: true, session: { id: 'ses_4444444444444444', sessionId: 'ses_4444444444444444', source: 'codex', title: 'Imported Codex', turns: [] } }; }
  }));
  external.context.setActiveGoal({ sessionId: 'existing', iteration: 1 });
  assert.equal(await external.context.openSession('codex_external-thread', 'External', 'codex'), true);
  assert.equal(external.context.getActiveGoal(), null, 'a successful session switch still stops the previous Goal');
  assert.equal(external.context.goalCancelReasons.length, 1);
  assert.equal(external.context.currentId(), 'ses_4444444444444444', 'the UI continues against the imported local session ID');
  assert.equal(external.context.currentCodexId(), 'external-thread', 'the original Codex thread ID remains available to match its queued work');
  assert.equal(external.titlebarThreadTitle.textContent, 'Imported Codex (Codex 재개됨)');
  assert.equal(external.context.priorityStatusRefreshes, 1, 'resuming an external session refreshes the local continuation workspace status');
  await external.context.openSession('ses_5555555555555555', 'Internal', 'internal');
  assert.equal(external.context.currentCodexId(), null, 'opening an unrelated internal session clears the Codex source binding');
  assert.equal(external.context.priorityStatusRefreshes, 2, 'each successfully selected session refreshes the workspace status');
  assert.equal(race.context.currentId(), 'ses_2222222222222222');
  assert.equal(race.timeline.clearCount, 1);
  assert.equal(race.context.sessionListLoads, 1);

  let resolveAfterFailure;
  const recoveryIds = [];
  const recovery = makeHarness((_url, options) => {
    recoveryIds.push(JSON.parse(options.body).sessionId);
    if (recoveryIds.length === 1) return Promise.reject(new Error('offline'));
    return new Promise(resolve => { resolveAfterFailure = resolve; });
  });
  const failedRequest = recovery.context.openSession('ses_3333333333333333', 'Failed', 'internal');
  const queuedRequest = recovery.context.openSession('ses_4444444444444444', 'After failure', 'internal');
  await new Promise(resolve => setImmediate(resolve));
  await failedRequest;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(recoveryIds, ['ses_3333333333333333', 'ses_4444444444444444'], 'a rejected resume releases the queue for the newest selection');
  resolveAfterFailure(resume('After failure loaded'));
  await queuedRequest;
  assert.equal(recovery.context.currentId(), 'ses_4444444444444444');
  assert.equal(recovery.titlebarThreadTitle.textContent, 'After failure loaded');
  console.log('sessionLoadPreservesUi passed: failures preserve current conversation and stale responses cannot replace latest selection');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
