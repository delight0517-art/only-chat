'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../src/ui/desktop/app.js'), 'utf8');
const evidenceStart = source.indexOf('function formatExecutionEvidence(evidence, required = true) {');
const evidenceEnd = source.indexOf('\nfunction originalTitle(', evidenceStart);
assert.ok(evidenceStart >= 0 && evidenceEnd > evidenceStart, 'dispatcher execution evidence formatter remains extractable');
const evidenceContext = vm.createContext({});
vm.runInContext(`${source.slice(evidenceStart, evidenceEnd)}\nglobalThis.formatExecutionEvidence = formatExecutionEvidence;`, evidenceContext);
assert.equal(
  evidenceContext.formatExecutionEvidence({ attemptedCount: 1, successfulCount: 0, failedCount: 1, provider: 'account-router', model: 'auto', tierId: 'account-router-local' }),
  '도구 1회 · 성공 0 · 실패 1 · account-router / auto / account-router-local',
  'dispatcher progress exposes failed execution counts and non-sensitive route metadata'
);
assert.equal(evidenceContext.formatExecutionEvidence(null), '도구 실행 증거 없음', 'missing evidence is visible for required tasks');
assert.equal(evidenceContext.formatExecutionEvidence(null, false), '', 'evidence is omitted for explicitly tool-free tasks');
assert.match(evidenceContext.formatExecutionEvidence({ attemptedCount: 2, successfulCount: 2, failedCount: 0, toolNames: ['read_file', 'read_file'] }), /사용 도구: read_file · 파일 열람만 확인됨 \(테스트\/설치 UI 검증 아님\)$/, 'file-reading evidence is not presented as test or installed UI proof');
assert.match(evidenceContext.formatExecutionEvidence({ attemptedCount: 1, successfulCount: 1, failedCount: 0, toolNames: ['exec_command'] }), /사용 도구: exec_command$/, 'command execution evidence is named without asserting that a test passed');
assert.doesNotMatch(evidenceContext.formatExecutionEvidence({ attemptedCount: 2, successfulCount: 2, failedCount: 0, toolNames: ['read_file', 'exec_command'] }), /파일 열람만 확인됨/, 'mixed evidence is not mislabeled as inspection only');
assert.match(source, /formatExecutionEvidence\(task\.executionEvidence, task\.requireToolExecution !== false\)/);

const watcherStart = source.indexOf('function watchDelegatedTasks(delegation, card) {');
const watcherEnd = source.indexOf('\nfunction formatExecutionEvidence(', watcherStart);
assert.ok(watcherStart >= 0 && watcherEnd > watcherStart, 'delegated task watcher remains independently testable');

class WatchElement {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.className = ''; this.textContent = ''; }
  setAttribute() {}
  append(...items) { this.children.push(...items); }
  appendChild(item) { this.children.push(item); return item; }
  replaceChildren(...items) { this.children = items; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
}

async function verifyWatcherStopsAfterTerminalState() {
  const intervals = [];
  const cleared = [];
  const root = new WatchElement('root');
  const card = { content: root };
  let fetchCalls = 0;
  let resolveFirst;
  let markFetch;
  const firstFetch = new Promise(resolve => { markFetch = resolve; });
  const context = vm.createContext({
    document: { createElement: tag => new WatchElement(tag) },
    card,
    fetch: () => {
      fetchCalls++;
      if (fetchCalls === 1) { markFetch(); return new Promise(resolve => { resolveFirst = resolve; }); }
      return Promise.resolve({ ok: true, json: async () => ({ queue: [], activeWorkers: [], completedTasks: [{ id: 'task-1', title: 'roadmap review', status: 'completed', result: 'done' }], terminalTasks: [] }) });
    },
    setInterval(callback, delay) { intervals.push({ callback, delay }); return intervals.length; },
    clearInterval(id) { cleared.push(id); }
  });
  vm.runInContext(`let setInterval = globalThis.setInterval; let clearInterval = globalThis.clearInterval; ${source.slice(watcherStart, watcherEnd)}\n${source.slice(evidenceStart, evidenceEnd)}\nglobalThis.watch = watchDelegatedTasks;`, context);
  context.watch({ tasks: [{ id: 'task-1', title: 'roadmap review', status: 'queued' }] }, card);
  await firstFetch;
  while (!intervals.length) await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetchCalls, 1, 'watcher immediately reads the current queue state once');
  assert.deepEqual(intervals.map(item => item.delay), [1500]);
  assert.equal(typeof resolveFirst, 'function', 'the first queue request remains in flight until this controlled response');
  await intervals[0].callback();
  assert.equal(fetchCalls, 1, 'a slow queue status read prevents overlapping dispatcher requests');
  resolveFirst({ ok: true, json: async () => ({ queue: [], activeWorkers: [], completedTasks: [{ id: 'task-1', title: 'roadmap review', status: 'completed', result: 'done' }], terminalTasks: [] }) });
  const terminalDeadline = Date.now() + 1000;
  while (!cleared.length && Date.now() < terminalDeadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(cleared, [1], 'terminal work stops the scheduled 1.5 second poll after its first response');
  assert.match(root.children[0].children[1].children[0].textContent, /completed/);
  assert.ok(root.children[0].children[1].children.some(node => /도구 실행 증거 없음/.test(node.textContent)), 'required tool evidence is visible on terminal queue rows');
}

verifyWatcherStopsAfterTerminalState().then(() => console.log('delegated queue watcher terminal lifecycle passed'));

async function verifyWatcherStopsAfterReadFailureBudget() {
  const intervals = [];
  const cleared = [];
  const root = new WatchElement('root');
  let fetchCalls = 0;
  let intervalsSeen = 0;
  const context = vm.createContext({
    document: { createElement: tag => new WatchElement(tag) },
    card: { content: root },
    fetch: async () => { fetchCalls++; throw new Error('offline'); },
    setInterval(callback, delay) { intervals.push({ callback, delay }); return intervals.length; },
    clearInterval(id) { cleared.push(id); },
    console
  });
  vm.runInContext(`let setInterval = globalThis.setInterval; let clearInterval = globalThis.clearInterval; ${source.slice(watcherStart, watcherEnd)}\n${source.slice(evidenceStart, evidenceEnd)}\nglobalThis.watch = watchDelegatedTasks;`, context);
  context.watch({ tasks: [{ id: 'task-fail', title: 'offline task', status: 'running' }] }, context.card);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetchCalls, 1);
  assert.match(root.children[0].children[1].textContent, /offline.*다시 확인/, 'transient error explains that status checks will continue');
  while (!intervals.length) await new Promise(resolve => setImmediate(resolve));
  for (let index = 1; index < 600; index++) { await intervals[0].callback(); await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(fetchCalls, 600, 'failed reads advance the bounded attempt counter');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(cleared, [1], 'repeated failure stops the queue watcher at the bounded 600-attempt limit');
  assert.ok(root.children[0].children[1].children.some(node => /600회 확인.*완료 상태.*자동 확인을 멈췄습니다/.test(node.textContent)), 'bounded-stop guidance states the accurate retry limit and remains visible inside the task list');
}

verifyWatcherStopsAfterReadFailureBudget().then(() => console.log('delegated queue watcher bounded failure lifecycle passed'));

const start = source.indexOf('function setAssistantWorkStatus(card, text) {');
const end = source.indexOf('\nwindow.toggleAssistantMore =', start);
assert.ok(start >= 0 && end > start, 'assistant work-progress renderer remains extractable');

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this.className = '';
    this.open = false;
    this._text = '';
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  insertBefore(child, before) {
    const index = this.children.indexOf(before);
    if (index < 0) this.children.unshift(child); else this.children.splice(index, 0, child);
    return child;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const found = [];
    const matches = node => selector.startsWith('.')
      ? node.className.split(/\s+/).includes(selector.slice(1))
      : selector === '[data-tool-call-id]' && Boolean(node.dataset.toolCallId);
    const visit = node => { for (const child of node.children) { if (matches(child)) found.push(child); visit(child); } };
    visit(this);
    return found;
  }
}

function runEvents(events) {
  const content = new Element('div');
  const card = {
    content,
    workStatusNode: new Element('div'),
    workDetails: null,
    workSummaryNode: null,
    workStepsNode: null,
    workStepCount: 0,
    currentWorkStep: null,
    workOutcome: 'complete'
  };
  const timeline = { scrollTop: 0, scrollHeight: 100 };
  const context = vm.createContext({
    card,
    timeline,
    document: { createElement: tagName => new Element(tagName) },
    escapeHtml: text => String(text),
    renderActiveModelSelection() {},
    refreshPriorityStatus: async () => {}
  });
  vm.runInContext(`${source.slice(start, end)}\n${events.map(event => `handleStreamEvent(${JSON.stringify(event)}, card);`).join('\n')}`, context);
  return { card, context };
}

const { card, context } = runEvents([
  { type: 'reasoning_delta', delta: 'private internal reasoning must not appear' },
  { type: 'tool_start', call: { id: 'call-1', name: 'exec_command', args: { command: 'pwd' } } },
  { type: 'tool_output', text: '/workspace/example' },
  { type: 'tool_end', result: { call: { id: 'call-1' }, result: { exitCode: 0 } } }
]);
assert.equal(card.workDetails.open, true, 'work details stay open while the turn is running');
assert.match(card.workSummaryNode.textContent, /1단계 · 진행 중/);
assert.match(card.workStepsNode.textContent, /명령 실행/);
assert.match(card.workStepsNode.textContent, /\/workspace\/example/);
assert.doesNotMatch(card.content.textContent, /private internal reasoning/);
vm.runInContext("finishAssistantWork(card, 'complete')", context);
assert.equal(card.workDetails.open, false, 'work details collapse after completion');
assert.match(card.workSummaryNode.textContent, /작업 과정 · 1단계 · 완료/);
assert.equal(card.workStatusNode.textContent, '응답 완료');

const missingExitCode = runEvents([
  { type: 'tool_start', call: { id: 'call-missing-exit', name: 'exec_command', args: { command: 'make build' } } },
  { type: 'tool_end', result: { call: { id: 'call-missing-exit', name: 'exec_command' }, result: { exitCode: null } } }
]);
assert.match(missingExitCode.card.workStepsNode.textContent, /결과 확인 불가/);
assert.equal(missingExitCode.card.workOutcome, 'error', 'a command without an exit code is not shown as successful');

const blockedTool = runEvents([
  { type: 'tool_start', call: { id: 'call-blocked', name: 'read_file', args: { path: 'fixture.txt' } } },
  { type: 'tool_end', result: { call: { id: 'call-blocked', name: 'read_file' }, result: { ok: false, blocked: true } } }
]);
assert.match(blockedTool.card.workStepsNode.textContent, /실패/);
assert.equal(blockedTool.card.workOutcome, 'error', 'blocked tools are not shown as successful');

const css = fs.readFileSync(require.resolve('../src/ui/desktop/app.css'), 'utf8');
assert.match(source, /assistant-turn-progress/);
assert.match(source, /assistant-work-summary-label/);
assert.match(source, /workDetails: bubble\.querySelector\('\.assistant-work-details'\)/);
assert.match(css, /\.assistant-work-details/);
assert.match(css, /\.assistant-turn-progress\s*>\s*\.assistant-work-summary/);
assert.match(css, /\.assistant-work-step-state\[data-state="error"\]/);

const timerStart = source.indexOf('function startAssistantTimer(card) {');
const timerEnd = source.indexOf('\nfunction finishAssistantMessage(card) {', timerStart);
assert.ok(timerStart >= 0 && timerEnd > timerStart, 'assistant elapsed-time display remains extractable');
let now = 100;
let tick;
let cleared = false;
const timerNode = new Element('span');
const timerContext = vm.createContext({
  card: { timerNode },
  performance: { now: () => now },
  window: {
    OnlyChatPresentation: null,
    setInterval(callback, delay) { assert.equal(delay, 1000); tick = callback; return 1; },
    clearInterval(id) { assert.equal(id, 1); cleared = true; }
  }
});
vm.runInContext(`${source.slice(timerStart, timerEnd)}\nglobalThis.startAssistantTimer = startAssistantTimer;`, timerContext);
const timer = timerContext.startAssistantTimer(timerContext.card);
assert.equal(timerNode.textContent, '작업 중 · 0초');
now += 1800;
tick();
assert.equal(timerNode.textContent, '작업 중 · 2초');
timer.finish();
assert.equal(timerNode.textContent, '작업 시간 · 2초');
assert.equal(timerNode.attributes['aria-label'], '응답 완료, 작업 시간 2초');
assert.equal(cleared, true, 'completed turns stop the one-second timer');
console.log('assistantWorkProgress passed: visible live tool steps, no reasoning leak, completed details collapse');
