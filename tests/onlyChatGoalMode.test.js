'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.css'), 'utf8');

test('Only Chat Desktop UI markup and styles support Goal Mode (Pursuing Goal)', () => {
  assert.match(html, /id="goalModeBanner"/, 'index.html must provide a visible Goal Mode active banner');
  assert.match(html, /id="goalModeText"/, 'index.html must provide text indicating pursuing goal status');
  assert.match(html, /id="btnGoalToggle"/, 'index.html must provide a Goal Mode toggle button');
  assert.match(html, /id="btnCancelGoal"/, 'index.html must provide a goal cancel button');

  assert.match(css, /\.goal-pill/, 'app.css must style the Goal Mode pill');
  assert.match(css, /\.goal-mode-banner/, 'app.css must style the active goal banner');
  assert.match(css, /goalPulse/, 'app.css must include an active pulse animation for pursuing goal');
});

test('parseClientGoalDuration correctly parses duration formats', () => {
  const start = app.indexOf('function parseClientGoalDuration(val) {');
  const end = app.indexOf('\nfunction cancelActiveGoal(', start);
  assert.ok(start >= 0 && end > start, 'parseClientGoalDuration must be extractable');

  const context = {};
  vm.runInNewContext(`${app.slice(start, end)}\nglobalThis.parse = parseClientGoalDuration;`, context);

  assert.equal(context.parse('10m'), 10 * 60_000);
  assert.equal(context.parse('30m'), 30 * 60_000);
  assert.equal(context.parse('1h'), 60 * 60_000);
  assert.equal(context.parse('2h'), 120 * 60_000);
  assert.equal(context.parse('3h'), 180 * 60_000);
  assert.equal(context.parse(''), 30 * 60_000, 'defaults to 30 minutes when omitted');
  assert.equal(context.parse('unknown'), 30 * 60_000, 'defaults to 30 minutes on invalid format');
});

test('Goal circuit breaker fingerprints roots, retries once, resets only on progress, and expires at 60 minutes', () => {
  const start = app.indexOf('const GOAL_STALL_LIMIT_MS =');
  const end = app.indexOf('\nfunction parseClientGoalDuration', start);
  assert.ok(start >= 0 && end > start, 'Goal circuit breaker helpers must be extractable');
  const context = {};
  vm.runInNewContext(`${app.slice(start, end)}\nglobalThis.goalCircuit = { goalBlockerFingerprint, recordGoalBlocker, recordGoalProgress, goalStallExpired, goalStallCheckpoint };`, context);
  const circuit = context.goalCircuit;
  const goal = { blockerProgress: Object.create(null), substantiveProgress: 0, stalledSince: null, blockerFingerprint: '' };

  const first = circuit.recordGoalBlocker(goal, 'Google Drive eviction failed for /Users/test/File 12.4 GiB', 10_000);
  assert.equal(first.repeated, false);
  assert.equal(goal.stalledSince, 10_000);
  const sameCause = circuit.recordGoalBlocker(goal, 'Google Drive eviction failed for /Users/other/File 9.7 GiB', 20_000);
  assert.equal(sameCause.repeated, true, 'dynamic paths and sizes do not disguise the same root cause');
  assert.equal(circuit.goalStallExpired(goal, 10_000 + 60 * 60_000 - 1), false);
  assert.equal(circuit.goalStallExpired(goal, 10_000 + 60 * 60_000), true);

  circuit.recordGoalProgress(goal, 30_000);
  assert.equal(goal.stalledSince, null);
  assert.equal(circuit.recordGoalBlocker(goal, 'Google Drive eviction failed for /Users/other/File 9.7 GiB', 40_000).repeated, false,
    'a verified source/state change permits a fresh one-time retry');
  const checkpoint = circuit.goalStallCheckpoint(goal, 'Use another evidence-backed route.');
  assert.equal(checkpoint.blockerFirstSeenAt, new Date(40_000).toISOString());
  assert.equal(checkpoint.lastSubstantiveProgressAt, new Date(40_000).toISOString(), 'a new blocker diagnosis is new evidence');
  assert.match(checkpoint.nextAction, /evidence-backed/);
});

test('app.js integrates /goal slash command and Goal Mode execution loop', () => {
  assert.match(app, /const goalMatch = prompt\.trim\(\)\.match/, 'app.js must parse /goal command');
  assert.match(app, /cancelActiveGoal/, 'app.js must support goal cancellation');
  assert.match(app, /finishActiveGoal/, 'app.js must support goal completion');
  assert.match(app, /startGoalMode/, 'app.js must support starting goal mode');
  assert.match(app, /runGoalIterationTurn/, 'app.js must execute autonomous goal loop iterations');
  assert.match(app, /Pursuing Goal · 목표 추구 중/, 'app.js must display pursuing goal state');
  assert.match(app, /GOAL_STEP_BLOCKED/, 'app Goal Mode must route blocked substeps through its circuit breaker');
  assert.match(app, /Goal 미완료/, 'deadline and circuit-breaker stops must be visibly incomplete');
});

test('CLI only-chat goal works with active desktop server and streams turns', async () => {
  const { runOnlyChatGoal } = require('../bin/codex.js');
  let now = 1_000;
  const turns = [];
  const goal = await runOnlyChatGoal({
    baseUrl: 'http://127.0.0.1:8899',
    prompt: '테스트 목표',
    durationMs: 2_000,
    now: () => now,
    write: () => {},
    fetchImpl: async (url, options) => {
      turns.push(options.body);
      now += 1_500;
      return {
        ok: true,
        body: {
          getReader() {
            let done = false;
            return {
              async read() {
                if (done) return { done: true };
                done = true;
                const chunk = turns.length === 1
                  ? 'data: {"type":"message_delta","delta":"1단계 작업 완료"}\n\ndata: {"type":"turn_complete"}\n\n'
                  : 'data: {"type":"message_delta","delta":"GOAL_COMPLETE"}\n\ndata: {"type":"turn_complete"}\n\n';
                return { done: false, value: Buffer.from(chunk) };
              },
              releaseLock() {}
            };
          }
        }
      };
    }
  });

  assert.equal(goal.ok, true);
  assert.equal(goal.iteration, 2, 'Goal autonomously pursues sequential turns until completion');
  assert.equal(turns.length, 2);
  assert.match(turns[0], /테스트 목표/);
  assert.match(turns[1], /계속 같은 Goal을 진행하세요/);
});

test('Goal loop safely aborts on consecutive errors and cleans up timers', () => {
  assert.match(app, /event\.type === 'turn_error'/, 'executeTurnCore must recognize SSE turn_error event');
  assert.match(app, /activeGoal\.consecutiveErrors\s*>=\s*2/, 'runGoalIterationTurn must stop after one changed-input retry fails');
  assert.match(app, /같은 명령이나 경로를 그대로 반복하지 말고/, 'the retry changes its diagnostic/action instruction');
  assert.match(app, /reportIncompleteActiveGoal\(/, 'automatic stop must be labeled incomplete, not successful');
  assert.match(app, /const goalObj = activeGoal;\s*activeGoal = null;/, 'cancelActiveGoal and finishActiveGoal must null activeGoal immediately');
  assert.match(app, /beforeunload/, 'window beforeunload must cancel active goal');
});
