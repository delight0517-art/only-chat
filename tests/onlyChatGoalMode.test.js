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

test('app.js integrates /goal slash command and Goal Mode execution loop', () => {
  assert.match(app, /const goalMatch = prompt\.trim\(\)\.match/, 'app.js must parse /goal command');
  assert.match(app, /cancelActiveGoal/, 'app.js must support goal cancellation');
  assert.match(app, /finishActiveGoal/, 'app.js must support goal completion');
  assert.match(app, /startGoalMode/, 'app.js must support starting goal mode');
  assert.match(app, /runGoalIterationTurn/, 'app.js must execute autonomous goal loop iterations');
  assert.match(app, /Pursuing Goal · 목표 추구 중/, 'app.js must display pursuing goal state');
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
