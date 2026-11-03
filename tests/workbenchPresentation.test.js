'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
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
