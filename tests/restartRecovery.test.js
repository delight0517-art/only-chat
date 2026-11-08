'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HandoffAdapter } = require('../src/core/HandoffAdapter.js');
const { SessionStore } = require('../src/core/SessionStore.js');
const { recoverInterruptedTurn } = require('../src/core/RestartRecovery.js');
const { AgentEngine } = require('../src/core/AgentEngine.js');
const { DesktopServer } = require('../src/ui/desktop/server.js');

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-restart-recovery-'));
  try {
    const workspaceDir = path.join(root, 'workspace');
    fs.mkdirSync(workspaceDir);
    const handoff = new HandoffAdapter({ storageDir: path.join(root, 'handoff'), gdriveHandoffDir: false });
    const sessions = new SessionStore({ storageDir: path.join(root, 'sessions') });
    const current = sessions.createSession({ workspaceDir, model: 'qwen2.5:3b', provider: 'ollama' });
    const sessionId = current.sessionId;
    const prompt = 'Continue this bounded task.';
    sessions.appendItem(sessionId, { type: 'user_message', content: prompt, resolvedContent: prompt });
    handoff.saveCheckpoint({ version: 2, status: 'running', autoResume: true, resumeAttempts: 0,
      sessionId, lastPrompt: prompt, workspaceDir, reasoningEffort: 'low', route: { tierId: 'local', provider: 'ollama', model: 'qwen2.5:3b' } });
    const engine = {
      handoff, sessions, loaded: null, calls: [],
      loadInternalSession(session) { this.loaded = session; },
      async executeTurn(promptText, options) {
        this.calls.push({ promptText, options });
        handoff.updateCheckpoint(sessionId, { status: 'completed' });
      }
    };
    await run({ root, workspaceDir, handoff, sessions, sessionId, prompt, engine });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  {
    const server = Object.create(DesktopServer.prototype);
    let recoveryCalls = 0;
    server.port = 0;
    server._handleRequest = (_req, res) => res.end('ok');
    server._startQuotaRefresh = () => {};
    server.schedulesEnabled = false;
    server.resumeInterruptedTurn = () => {
      assert.equal(server.server.listening, true, 'recovery starts only after the listener is active');
      recoveryCalls += 1;
      return Promise.resolve({ status: 'not_idle' });
    };
    try {
      await server.start();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(recoveryCalls, 1, 'startup triggers interrupted-turn recovery once');
    } finally {
      if (server.server) await new Promise((resolve, reject) => server.server.close(error => error ? reject(error) : resolve()));
    }
  }

  await fixture(async ({ engine }) => {
    const server = Object.create(DesktopServer.prototype);
    server.isolated = false;
    server.activeTurns = 0;
    server.engine = engine;
    server.engine.dispatcher = { tick() {} };
    server.port = 0;
    server._handleRequest = (_req, res) => res.end('ok');
    server._startQuotaRefresh = () => {};
    server.schedulesEnabled = false;
    server.resumeInterruptedTurn = DesktopServer.prototype.resumeInterruptedTurn;
    try {
      await server.start();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(engine.calls.length, 1, 'server startup resumes the persisted running checkpoint once');
      assert.equal(engine.calls[0].options.restartRecovery, true);
      assert.equal(engine.handoff.loadCheckpoint().status, 'completed');
    } finally {
      if (server.server) await new Promise((resolve, reject) => server.server.close(error => error ? reject(error) : resolve()));
    }
  });

  await fixture(async ({ engine, sessionId }) => {
    const result = await recoverInterruptedTurn(engine);
    assert.equal(result.status, 'resumed');
    assert.equal(engine.calls.length, 1, 'a safe interrupted inference resumes once');
    assert.equal(engine.calls[0].promptText, '', 'resume continues the stored session without duplicating the user prompt');
    assert.equal(engine.calls[0].options.modelSelection, 'qwen2.5:3b');
    assert.equal(engine.loaded.sessionId, sessionId);
    assert.equal(engine.handoff.loadCheckpoint().status, 'completed');
  });

  await fixture(async ({ engine, sessions, sessionId }) => {
    sessions.appendItem(sessionId, { type: 'assistant_message', content: 'Already finished.' });
    const result = await recoverInterruptedTurn(engine);
    assert.equal(result.status, 'completed');
    assert.equal(engine.calls.length, 0, 'a persisted answer prevents duplicate inference');
  });

  await fixture(async ({ engine, sessions, sessionId }) => {
    sessions.appendItem(sessionId, { type: 'assistant_tool_calls', toolCalls: [{ id: 'call_1', name: 'write_file', arguments: { path: 'x', content: 'y' } }] });
    sessions.appendItem(sessionId, { type: 'tool_start', tool_call_id: 'call_1', tool: 'write_file' });
    const result = await recoverInterruptedTurn(engine);
    assert.equal(result.status, 'needs_review');
    assert.equal(engine.calls.length, 0, 'an uncertain side effect is never replayed automatically');
    assert.match(engine.handoff.loadCheckpoint().recoveryReason, /중복 실행을 막았습니다/);
  });

  await fixture(async ({ engine, sessions, sessionId }) => {
    sessions.appendItem(sessionId, { type: 'assistant_tool_calls', toolCalls: [{ id: 'call_2', name: 'read_file', arguments: { path: 'README.md' } }] });
    const result = await recoverInterruptedTurn(engine);
    assert.equal(result.status, 'resumed', 'a tool call not yet started can resume safely');
    const toolResult = sessions.readSession(sessionId).find(record => record.type === 'tool_result');
    assert.equal(toolResult.tool_call_id, 'call_2');
    assert.match(toolResult.result.error, /시작되지 않았습니다/);
    assert.ok(engine.loaded.conversationHistory.some(turn => turn.role === 'assistant' && turn.tool_calls?.[0]?.id === 'call_2'));
    assert.ok(engine.loaded.conversationHistory.some(turn => turn.role === 'tool' && turn.tool_call_id === 'call_2'));
  });

  await fixture(async ({ engine }) => {
    engine.handoff.updateCheckpoint(engine.handoff.loadCheckpoint().sessionId, { status: 'resuming', resumeAttempts: 1 });
    const result = await recoverInterruptedTurn(engine);
    assert.equal(result.status, 'needs_review');
    assert.equal(engine.calls.length, 0, 'a crash during auto-resume cannot create a retry loop');
  });

  await fixture(async ({ engine }) => {
    const checkpoint = engine.handoff.loadCheckpoint();
    assert.equal(engine.handoff.updateCheckpoint('ses_0000000000000000', { status: 'completed' }), false,
      'a stale task cannot overwrite another session checkpoint');
    assert.equal(engine.handoff.loadCheckpoint().sessionId, checkpoint.sessionId);
  });

  const crashRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-restart-engine-'));
  const workspaceDir = path.join(crashRoot, 'workspace');
  fs.mkdirSync(workspaceDir);
  fs.writeFileSync(path.join(workspaceDir, 'note.txt'), 'durable tool result');
  const tier = { tier: 1, id: 'local-fixture', name: 'Local fixture', provider: 'ollama', model: 'qwen2.5:3b', enabled: true };
  const crashSignal = new AbortController();
  const firstEngine = new AgentEngine({ isolated: true, dataDir: crashRoot, workspaceDir,
    isTierReady: () => true,
    providerAdapter: async (_tier, _history, _hooks, context) => {
      if (context?.restartRecovery) throw new Error('unexpected recovery route on original run');
      if (firstEngineCalls++ === 0) return { protocol: 'openai-compatible', content: null,
        toolCalls: [{ id: 'read-note-1', name: 'read_file', args: { path: 'note.txt' } }] };
      setImmediate(() => crashSignal.abort());
      return new Promise((resolve, reject) => crashSignal.signal.addEventListener('abort',
        () => reject(new Error('synthetic process interruption after completed tool')), { once: true }));
    } });
  let firstEngineCalls = 0;
  try {
    firstEngine.priorityChain.setTiers([tier]);
    const session = firstEngine.initSession();
    await assert.rejects(firstEngine.executeTurn('Read note.txt and summarize it.', { reasoningEffort: 'low', signal: crashSignal.signal }));
    assert.equal(firstEngine.sessions.readSession(session.sessionId).some(record => record.type === 'tool_start'), true);
    assert.equal(firstEngine.sessions.readSession(session.sessionId).some(record => record.type === 'tool_result' && record.tool_call_id === 'read-note-1'), true);

    let restoredHistory;
    const secondEngine = new AgentEngine({ isolated: true, dataDir: crashRoot, workspaceDir,
      isTierReady: () => true,
      providerAdapter: async (_tier, history) => {
        restoredHistory = history;
        return { protocol: 'openai-compatible', content: 'Recovered from the persisted read result.', toolCalls: [] };
      } });
    try {
      secondEngine.priorityChain.setTiers([tier]);
      const result = await recoverInterruptedTurn(secondEngine);
      assert.equal(result.status, 'resumed', result.reason || 'a newly constructed engine resumes from persistent session data');
      assert.ok(restoredHistory.some(item => item.role === 'assistant' && item.tool_calls?.[0]?.id === 'read-note-1'));
      assert.ok(restoredHistory.some(item => item.role === 'tool' && item.tool_call_id === 'read-note-1' && /durable tool result/.test(item.content)));
      assert.equal(secondEngine.sessions.readSession(session.sessionId).at(-1).content, 'Recovered from the persisted read result.');
    } finally { secondEngine.dispatcher.stop(); }
  } finally {
    firstEngine.dispatcher.stop();
    fs.rmSync(crashRoot, { recursive: true, force: true });
  }

  console.log('restartRecovery.test.js: one-shot automatic resume, process reconstruction, exact session/tool-result restoration, completion dedupe, unstarted-call recovery and uncertain side-effect protection passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
