'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { presentWorkspaceOwnership, presentWorkbenchTasks } = require('../src/ui/desktop/workspaceOwnershipPresentation.js');

const now = Date.parse('2026-11-03T04:00:00Z');
const task = (taskKey, extra = {}) => ({ taskKey, title: taskKey, repositoryPath: '/apps/OnlyChat',
  status: 'executing', ownerChatId: 'chat-a', leaseExpiresAt: '2026-11-03T04:05:00Z',
  checkpoint: { nextAction: '확인', evidenceRefs: [] }, ...extra });

test('uses the ownership HTTP contract and never calls a missing change list clean', () => {
  assert.match(presentWorkspaceOwnership({ gitStatus: { available: true }, uncommitted: ['a', 'b'] }).gitText, /2개/);
  assert.match(presentWorkspaceOwnership({ gitStatus: { available: true } }).gitText, /확인할 수 없습니다/);
  assert.match(presentWorkspaceOwnership({ gitStatus: { available: true }, uncommitted: [] }).gitText, /없습니다/);
});

test('expired, missing and foreign-shaped owner leases do not inflate active work', () => {
  const snapshot = presentWorkbenchTasks([
    task('live'), task('expired', { leaseExpiresAt: '2026-11-03T03:59:59Z' }),
    task('no-owner', { ownerChatId: null }), task('bad-date', { leaseExpiresAt: 'unknown' })
  ], now);
  assert.equal(snapshot.active, 1);
  assert.equal(snapshot.attention, 3);
  assert.equal(snapshot.rows.at(-1).key, 'live');
  assert.equal(snapshot.rows[0].label, '담당 확인 필요');
});

test('counts distinct source roots and deduplicates tasks without changing source data', () => {
  const input = [task('a'), task('a'), task('b', { repositoryPath: 'C:\\apps\\RiseSync' }),
    task('c', { repositoryPath: '/Users/rogan/.gemini/antigravity/scratch/my-codex' })];
  const before = JSON.stringify(input);
  const snapshot = presentWorkbenchTasks(input, now);
  assert.equal(snapshot.apps, 3);
  assert.equal(snapshot.rows.length, 3);
  assert.equal(snapshot.rows[1].app, 'RiseSync');
  assert.equal(snapshot.rows[2].app, 'Only Chat');
  assert.equal(JSON.stringify(input), before);
});

test('completion without evidence needs attention and unknown status never counts as progress', () => {
  const snapshot = presentWorkbenchTasks([task('done', { status: 'completed', checkpoint: { evidenceRefs: ['report.md'] } }),
    task('unsupported', { status: 'unknown' }), task('no-evidence', { status: 'completed' })], now);
  assert.equal(snapshot.active, 0);
  assert.equal(snapshot.attention, 2);
  assert.equal(snapshot.rows.find(row => row.key === 'done').label, '완료 기록');
  assert.equal(snapshot.rows.find(row => row.key === 'no-evidence').label, '완료 근거 확인 필요');
  assert.throws(() => presentWorkbenchTasks(null), /array/);
  assert.equal(presentWorkbenchTasks([], now).apps, 0);
});

test('workbench preserves bounded executor outcomes for durable review', () => {
  const progress = [{ id: 'task-1', title: 'Core slice', status: 'blocked', attempt: 1,
    reason: '승인 대기', error: '', result: '<script>not markup</script>', updatedAt: '2026-11-03T03:00:00Z' }];
  const row = presentWorkbenchTasks([task('manager', { executionProgress: progress })], now).rows[0];
  assert.deepEqual(row.executionProgress, [{ title: 'Core slice', status: 'blocked', attempt: 1,
    result: '<script>not markup</script>', reason: '승인 대기', error: '' }]);
  assert.equal(JSON.stringify(row).includes('task-1'), false);
});

test('phase highlights only the recorded state and withholds stale or unsupported progress', () => {
  for (const [status, phase] of Object.entries({ planned: 0, claimed: 0, executing: 1, verifying: 2, reviewing: 2, integrating: 3, completed: 3 })) {
    const row = presentWorkbenchTasks([task(status, { status, checkpoint: { evidenceRefs: ['receipt.md'] } })], now).rows[0];
    assert.equal(row.phase, phase, status);
  }
  for (const extra of [{ status: 'blocked' }, { status: 'failed' }, { status: 'new-status' },
    { leaseExpiresAt: '2026-11-03T03:59:59Z' }, { status: 'completed' }]) {
    assert.equal(presentWorkbenchTasks([task('attention', extra)], now).rows[0].phase, null);
  }
});

test('collapsed work cards expose next action and blocker safely and preserve disclosure on refresh', () => {
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.textContent = ''; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(key, value) { this.attributes[key] = value; }
    querySelectorAll(selector) {
      assert.equal(selector, 'details[open]');
      return this.children.filter(child => child.tagName === 'details' && child.open);
    }
  }
  const ids = Object.fromEntries(['workbenchTasks', 'workbenchAppCount', 'workbenchActiveCount', 'workbenchAttentionCount', 'workbenchReadStatus']
    .map(id => [id, new Element('div')]));
  const app = fs.readFileSync(require.resolve('../src/ui/desktop/app.js'), 'utf8');
  const helper = app.slice(app.indexOf('function workbenchText('), app.indexOf('\nfunction initWorkbench('));
  const renderer = app.slice(app.indexOf('function renderWorkbenchTasks('), app.indexOf('\nfunction renderWorkbenchModules('));
  const unsafeText = '<img src=x onerror=alert(1)>';
  const context = vm.createContext({
    document: { getElementById: id => ids[id], createElement: tag => new Element(tag) },
    workbenchSnapshot: presentWorkbenchTasks([task('card', { status: 'blocked', checkpoint: { nextAction: unsafeText, blocker: '수신 확인 대기', evidenceRefs: ['receipt.md'] }, executionProgress: [
      { id: 'card-1', title: 'UI 수정', status: 'blocked', attempt: 2, reason: '승인 필요', error: '', result: unsafeText, updatedAt: '2026-11-03T03:00:00Z' }
    ] })], now),
    workbenchFilter: 'open', workbenchReadAt: now
  });
  vm.runInContext(`${helper}\n${renderer}\nrenderWorkbenchTasks();`, context);
  const card = ids.workbenchTasks.children[0];
  assert.equal(card.open, false);
  const summary = card.children[0];
  const text = summary.children.map(node => node.textContent).join('\n');
  assert.match(text, /다음 · <img src=x onerror=alert\(1\)>/);
  assert.match(text, /막힘 · 수신 확인 대기/);
  assert.match(text, /검토 근거 1개/);
  const workerDetail = card.children[1].children.find(node => node.className === 'workbench-executor-result');
  assert.equal(workerDetail.children[0].textContent, 'UI 수정 · blocked · 시도 2회');
  assert.equal(workerDetail.children[1].textContent, '차단 사유 · 승인 필요');
  assert.equal(workerDetail.children[2].textContent, unsafeText);
  assert.equal(workerDetail.children[2].tagName, 'pre');
  const flow = summary.children.find(node => node.className === 'workbench-flow');
  assert.equal(flow.attributes.role, 'list');
  assert.equal(flow.children.filter(node => node.attributes['aria-current']).length, 0);
  assert.equal(summary.children.some(node => node.tagName === 'img'), false);
  card.open = true;
  context.workbenchSnapshot = presentWorkbenchTasks([task('card', { status: 'verifying' })], now);
  vm.runInContext('renderWorkbenchTasks();', context);
  assert.equal(ids.workbenchTasks.children[0].open, true);
  const refreshed = ids.workbenchTasks.children[0].children[0].children.find(node => node.className === 'workbench-flow');
  assert.equal(refreshed.children[2].attributes['aria-current'], 'step');
  assert.equal(refreshed.children.filter(node => node.attributes['aria-current']).length, 1);
  context.workbenchSnapshot = null;
  vm.runInContext('renderWorkbenchTasks();', context);
  assert.equal(ids.workbenchAppCount.textContent, '—');
});
