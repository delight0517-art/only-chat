'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { TaskRegistryStore, normalizePaths, pathsOverlap } = require('../src/core/TaskRegistryStore.js');

async function withFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-task-registry-'));
  try {
    const repo = path.join(root, 'repo');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(repo);
    const store = new TaskRegistryStore({ dataDir });
    await run({ root, repo, dataDir, store });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false, 'temporary test directory must be removed');
  }
}

function taskInput(repo, overrides = {}) {
  return {
    taskKey: 'slice-1', title: 'Task slice', creatorChatId: 'creator-chat',
    repositoryPath: repo, baseSha: 'a'.repeat(40), paths: ['src/core/example.js'],
    idempotencyKey: 'create-1', nextAction: 'Implement one slice', ...overrides
  };
}

async function createAndClaim(store, repo, taskKey = 'slice-1', ownerChatId = 'chat-a') {
  await store.createTask(taskInput(repo, { taskKey, idempotencyKey: `create-${taskKey}` }));
  return store.claimTask({ taskKey, ownerChatId, idempotencyKey: `claim-${taskKey}` });
}

test('creates durable tasks and replays idempotent create and claim requests', async () => {
  await withFixture(async ({ repo, dataDir, store }) => {
    const input = taskInput(repo);
    const first = await store.createTask(input);
    const replay = await store.createTask(input);
    assert.equal(first.created, true);
    assert.equal(replay.created, true);
    assert.deepEqual(replay, first);

    const claimInput = { taskKey: 'slice-1', ownerChatId: 'chat-a', idempotencyKey: 'claim-1' };
    const claim = await store.claimTask(claimInput);
    assert.equal(claim.accepted, true);
    assert.deepEqual(await store.claimTask(claimInput), claim);

    const reopened = new TaskRegistryStore({ dataDir });
    assert.equal(reopened.getTask('slice-1').ownerChatId, 'chat-a');
    assert.equal(fs.statSync(reopened.filePath).mode & 0o777, 0o600);
  });
});

test('allows only one concurrent owner and rejects overlapping active path scopes', async () => {
  await withFixture(async ({ repo, store }) => {
    await store.createTask(taskInput(repo, { idempotencyKey: 'create-race' }));
    const [left, right] = await Promise.all([
      store.claimTask({ taskKey: 'slice-1', ownerChatId: 'chat-a', idempotencyKey: 'claim-a' }),
      store.claimTask({ taskKey: 'slice-1', ownerChatId: 'chat-b', idempotencyKey: 'claim-b' })
    ]);
    assert.equal([left, right].filter(result => result.accepted).length, 1);
    assert.equal([left, right].filter(result => result.reason === 'owned_by_other_chat').length, 1);

    await store.createTask(taskInput(repo, { taskKey: 'slice-2', paths: ['src/core'], idempotencyKey: 'create-2' }));
    const conflict = await store.claimTask({ taskKey: 'slice-2', ownerChatId: 'chat-c', idempotencyKey: 'claim-2' });
    assert.equal(conflict.accepted, false);
    assert.equal(conflict.reason, 'path_scope_conflict');
  });
});

test('permits disjoint scopes and lets an expired lease be reclaimed without implying completion', async () => {
  await withFixture(async ({ repo, dataDir }) => {
    let now = Date.parse('2026-11-03T00:00:00.000Z');
    const store = new TaskRegistryStore({ dataDir, clock: () => now });
    await createAndClaim(store, repo, 'task-a', 'chat-a');
    await store.createTask(taskInput(repo, { taskKey: 'task-b', paths: ['tests'], idempotencyKey: 'create-task-b' }));
    assert.equal((await store.claimTask({ taskKey: 'task-b', ownerChatId: 'chat-b', idempotencyKey: 'claim-task-b' })).accepted, true);

    now += 3 * 60_000;
    const takeover = await store.claimTask({ taskKey: 'task-a', ownerChatId: 'chat-c', idempotencyKey: 'claim-takeover' });
    assert.equal(takeover.accepted, true);
    assert.equal(takeover.previousStatus, 'claimed');
    assert.equal(store.getTask('task-a').status, 'claimed');
    assert.equal(store.getTask('task-a').ownerChatId, 'chat-c');
  });
});

test('requires transition order, held ownership, and evidence before completion', async () => {
  await withFixture(async ({ repo, store }) => {
    await createAndClaim(store, repo);
    await assert.rejects(store.updateCheckpoint({ taskKey: 'slice-1', ownerChatId: 'chat-a', idempotencyKey: 'bad-complete', status: 'completed', evidenceRefs: ['log:test'] }), /invalid task transition/);
    await assert.rejects(store.updateCheckpoint({ taskKey: 'slice-1', ownerChatId: 'chat-a', idempotencyKey: 'bad-block', status: 'blocked' }), /blocker description/);

    const steps = [
      ['executing', 'step-1'], ['verifying', 'step-2'], ['reviewing', 'step-3']
    ];
    for (const [status, idempotencyKey] of steps) {
      const result = await store.updateCheckpoint({ taskKey: 'slice-1', ownerChatId: 'chat-a', idempotencyKey, status });
      assert.equal(result.updated, true);
    }
    await assert.rejects(store.updateCheckpoint({ taskKey: 'slice-1', ownerChatId: 'chat-a', idempotencyKey: 'complete-no-evidence', status: 'completed' }), /completion requires/);
    const completed = await store.updateCheckpoint({ taskKey: 'slice-1', ownerChatId: 'chat-a', idempotencyKey: 'complete-with-evidence', status: 'completed', evidenceRefs: ['tests/taskRegistryStore.test.js'] });
    assert.equal(completed.updated, true);
    assert.equal(completed.task.ownerChatId, null);
    assert.equal((await store.claimTask({ taskKey: 'slice-1', ownerChatId: 'chat-b', idempotencyKey: 'claim-completed' })).reason, 'task_completed');
  });
});

test('validates repository-relative paths and detects parent-child overlap', () => {
  assert.deepEqual(normalizePaths(['src/core/a.js', 'src/core']), ['src/core']);
  assert.equal(pathsOverlap(['src/core'], ['src/core/a.js']), true);
  assert.equal(pathsOverlap(['src/core/a.js'], ['tests/a.test.js']), false);
  assert.throws(() => normalizePaths(['../outside']), /cannot escape/);
  assert.throws(() => normalizePaths(['/absolute/path']), /repository-relative/);
  assert.throws(() => normalizePaths(['src\\core\\file.js']), /repository-relative/);
});

test('fails closed on a symlinked or malformed registry file', async () => {
  await withFixture(async ({ store, root }) => {
    fs.writeFileSync(path.join(root, 'outside.json'), JSON.stringify({ schemaVersion: 1, tasks: [], idempotency: [] }));
    fs.symlinkSync(path.join(root, 'outside.json'), store.filePath);
    assert.throws(() => store.getTask('slice-1'), /unreadable/);
    fs.unlinkSync(store.filePath);
    fs.writeFileSync(store.filePath, '{invalid json');
    assert.throws(() => store.getTask('slice-1'), /unreadable/);
  });
});

test('rejects attempts to mutate another chat task and terminal failed tasks', async () => {
  await withFixture(async ({ repo, store }) => {
    await createAndClaim(store, repo);
    const result = await store.updateCheckpoint({ taskKey: 'slice-1', ownerChatId: 'chat-b', idempotencyKey: 'foreign-update', status: 'executing' });
    assert.equal(result.updated, false);
    assert.equal(result.reason, 'claim_not_held');

    for (const [status, key] of [['executing', 'f1'], ['failed', 'f2']]) {
      assert.equal((await store.updateCheckpoint({ taskKey: 'slice-1', ownerChatId: 'chat-a', idempotencyKey: key, status })).updated, true);
    }
    assert.equal((await store.claimTask({ taskKey: 'slice-1', ownerChatId: 'chat-b', idempotencyKey: 'claim-failed' })).reason, 'task_failed');
  });
});
