'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
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

async function raceProcessClaims({ root, repo, dataDir, store, claims, name }) {
  const barrierPath = path.join(root, `claim-barrier-${name}`);
  const modulePath = path.resolve(__dirname, '../src/core/TaskRegistryStore.js');
  const workerSource = `
    const fs = require('node:fs');
    const { TaskRegistryStore } = require(${JSON.stringify(modulePath)});
    const [dataDir, repo, taskKey, ownerChatId, barrierPath, idempotencyKey] = process.argv.slice(1);
    const store = new TaskRegistryStore({ dataDir, lockWaitMs: 5000 });
    process.stdout.write('READY\\n');
    const deadline = Date.now() + 5000;
    const waitForBarrier = async () => {
      while (!fs.existsSync(barrierPath)) {
        if (Date.now() >= deadline) throw new Error('claim barrier timed out');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    };
    waitForBarrier()
      .then(() => store.claimTask({ taskKey, ownerChatId, idempotencyKey }))
      .then(result => process.stdout.write(JSON.stringify(result) + '\\n'))
      .catch(error => { process.stderr.write((error.stack || error.message) + '\\n'); process.exitCode = 1; });
  `;
  const workers = claims.map(({ taskKey, ownerChatId, idempotencyKey }) => {
    const child = spawn(process.execPath, ['-e', workerSource, dataDir, repo, taskKey, ownerChatId, barrierPath, idempotencyKey], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let ready = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.split(/\r?\n/u).includes('READY')) ready = true;
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const result = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => {
        if (code !== 0) return reject(new Error(stderr || `claim worker exited ${code}`));
        const line = stdout.split(/\r?\n/u).filter(Boolean).at(-1);
        try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
      });
    });
    return { child, result, isReady: () => ready };
  });

  try {
    const deadline = Date.now() + 5000;
    while (workers.some(worker => !worker.isReady())) {
      if (Date.now() >= deadline) throw new Error('claim workers did not reach the barrier');
      if (workers.some(worker => worker.child.exitCode !== null)) throw new Error('claim worker exited before the barrier');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    fs.writeFileSync(barrierPath, 'start', { mode: 0o600 });
    return await Promise.all(workers.map(worker => worker.result));
  } finally {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGTERM');
    }
    await Promise.all(workers.map(worker => worker.result.catch(() => undefined)));
  }
}

test('creates durable tasks and replays idempotent create and claim requests', async () => {
  await withFixture(async ({ repo, dataDir, store }) => {
    const input = taskInput(repo);
    const first = await store.createTask(input);
    const replay = await store.createTask(input);
    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.task, first.task);

    const claimInput = { taskKey: 'slice-1', ownerChatId: 'chat-a', idempotencyKey: 'claim-1' };
    const claim = await store.claimTask(claimInput);
    assert.equal(claim.accepted, true);
    assert.deepEqual(await store.claimTask(claimInput), claim);

    const reopened = new TaskRegistryStore({ dataDir });
    assert.equal(reopened.getTask('slice-1').ownerChatId, 'chat-a');
    assert.equal(fs.statSync(reopened.filePath).mode & 0o777, 0o600);
  });
});

test('persists a private stable host identity and refuses corrupted identity records', async () => {
  await withFixture(async ({ root, dataDir }) => {
    const first = new TaskRegistryStore({ dataDir });
    const reopened = new TaskRegistryStore({ dataDir });
    const otherHost = new TaskRegistryStore({ dataDir: path.join(root, 'other-host') });
    assert.match(first.hostId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu);
    assert.equal(reopened.hostId, first.hostId);
    assert.notEqual(otherHost.hostId, first.hostId);
    const identityPath = path.join(dataDir, 'task-registry', 'host-identity.json');
    if (process.platform !== 'win32') assert.equal(fs.statSync(identityPath).mode & 0o777, 0o600);
    fs.writeFileSync(identityPath, '{"schemaVersion":1,"hostId":"invalid"}\n', { mode: 0o600 });
    assert.throws(() => new TaskRegistryStore({ dataDir }), /host identity is invalid/);

    if (process.platform !== 'win32') {
      const linkedDataDir = path.join(root, 'linked-host');
      fs.mkdirSync(path.join(linkedDataDir, 'task-registry'), { recursive: true, mode: 0o700 });
      fs.symlinkSync(identityPath, path.join(linkedDataDir, 'task-registry', 'host-identity.json'));
      assert.throws(() => new TaskRegistryStore({ dataDir: linkedDataDir }), /host identity is unsafe/);
    }
  });
});

test('independent processes converge on one host identity in a shared data directory', async () => {
  await withFixture(async ({ dataDir }) => {
    const modulePath = path.resolve(__dirname, '../src/core/TaskRegistryStore.js');
    const workerSource = `
      const { TaskRegistryStore } = require(${JSON.stringify(modulePath)});
      process.stdout.write(new TaskRegistryStore({ dataDir: process.argv[1] }).hostId + '\\n');
    `;
    const workers = Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', workerSource, dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `host identity worker exited ${code}`)));
    }));
    const hostIds = await Promise.all(workers);
    assert.equal(new Set(hostIds).size, 1);
    assert.match(hostIds[0], /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu);
  });
});

test('persists validated executor plans and rejects overlapping plan scopes', async () => {
  await withFixture(async ({ repo, dataDir }) => {
    const store = new TaskRegistryStore({ dataDir });
    const execution = {
      kind: 'executor-plan',
      summary: 'Split the feature safely',
      tasks: [
        { title: 'Inspect core', prompt: 'Read the core module and report its boundaries.', files: ['src/core'], allowedTools: ['read_file'] },
        { title: 'Inspect UI', prompt: 'Read the UI module and report its boundaries.', files: ['src/ui'], allowedTools: ['read_file'] }
      ]
    };
    const input = taskInput(repo, { taskKey: 'manager-plan', execution, idempotencyKey: 'create-plan' });
    const created = await store.createTask(input);
    const replay = await store.createTask(input);
    assert.equal(created.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.task, created.task);
    assert.deepEqual(new TaskRegistryStore({ dataDir }).getTask('manager-plan').execution, execution);

    await assert.rejects(store.createTask(taskInput(repo, {
      taskKey: 'manager-overlap', idempotencyKey: 'create-overlap',
      execution: { ...execution, tasks: [execution.tasks[0], { ...execution.tasks[1], files: ['src/core/AgentEngine.js'] }] }
    })), /overlap/);
  });
});

test('persists each executor outcome and advances the parent only after every worker is terminal', async () => {
  await withFixture(async ({ repo, dataDir }) => {
    const store = new TaskRegistryStore({ dataDir });
    const execution = {
      kind: 'executor-plan', summary: 'Split work', tasks: [
        { title: 'Core slice', prompt: 'Implement core slice.', files: ['src/core'], allowedTools: ['read_file'] },
        { title: 'UI slice', prompt: 'Implement UI slice.', files: ['src/ui'], allowedTools: ['read_file'] }
      ]
    };
    await store.createTask(taskInput(repo, { taskKey: 'manager-results', paths: ['src/core', 'src/ui'], execution, idempotencyKey: 'create-manager-results' }));
    await store.claimTask({ taskKey: 'manager-results', ownerChatId: 'chat-a', idempotencyKey: 'claim-manager-results' });

    const firstStart = { taskKey: 'manager-results', ownerChatId: 'chat-a', executorId: 'manager-results-1', status: 'running', idempotencyKey: 'worker-1-start' };
    assert.equal((await store.recordExecutorProgress(firstStart)).task.status, 'executing');
    assert.deepEqual(await store.recordExecutorProgress(firstStart), await store.recordExecutorProgress(firstStart));
    await store.recordExecutorProgress({ ...firstStart, status: 'completed', idempotencyKey: 'worker-1-done', sessionId: 'worker-session-1', result: 'Core implementation result.' });
    assert.equal(store.getTask('manager-results').status, 'executing', 'one result cannot advance a multi-worker parent');

    await store.recordExecutorProgress({ ...firstStart, executorId: 'manager-results-2', status: 'running', idempotencyKey: 'worker-2-start' });
    const final = await store.recordExecutorProgress({ ...firstStart, executorId: 'manager-results-2', status: 'completed', idempotencyKey: 'worker-2-done', sessionId: 'worker-session-2', result: 'UI implementation result.' });
    assert.equal(final.task.status, 'verifying');
    assert.deepEqual(final.task.executionProgress.map(item => [item.status, item.sessionId, item.result]), [
      ['completed', 'worker-session-1', 'Core implementation result.'],
      ['completed', 'worker-session-2', 'UI implementation result.']
    ]);
    assert.deepEqual(final.task.checkpoint.evidenceRefs, [
      'executor-result:manager-results-1:attempt-1', 'executor-result:manager-results-2:attempt-1'
    ]);
    const reopened = new TaskRegistryStore({ dataDir });
    assert.deepEqual(reopened.getTask('manager-results').executionProgress, final.task.executionProgress);
  });
});

test('keeps incomplete executor plans blocked with worker result and recovery action', async () => {
  await withFixture(async ({ repo, store }) => {
    const execution = { kind: 'executor-plan', summary: 'One slice', tasks: [
      { title: 'Read source', prompt: 'Inspect and report.', files: ['src'], allowedTools: ['read_file'] }
    ] };
    await store.createTask(taskInput(repo, { taskKey: 'manager-blocked', paths: ['src'], execution, idempotencyKey: 'create-manager-blocked' }));
    await store.claimTask({ taskKey: 'manager-blocked', ownerChatId: 'chat-a', idempotencyKey: 'claim-manager-blocked' });
    await store.recordExecutorProgress({ taskKey: 'manager-blocked', ownerChatId: 'chat-a', executorId: 'manager-blocked-1', status: 'running', idempotencyKey: 'blocked-start' });
    const blocked = await store.recordExecutorProgress({ taskKey: 'manager-blocked', ownerChatId: 'chat-a', executorId: 'manager-blocked-1', status: 'blocked', idempotencyKey: 'blocked-end', reason: 'Required tool approval was unavailable.' });
    assert.equal(blocked.task.status, 'blocked');
    assert.match(blocked.task.checkpoint.nextAction, /명시적으로 재개/);
    assert.equal(blocked.task.executionProgress[0].reason, 'Required tool approval was unavailable.');
    assert.equal(blocked.task.ownerChatId, null);
  });
});

test('resumes only incomplete executors, preserves attempt history, and recovers expired running work', async () => {
  await withFixture(async ({ repo, dataDir }) => {
    let now = Date.parse('2026-11-03T04:00:00.000Z');
    const store = new TaskRegistryStore({ dataDir, clock: () => now });
    const execution = { kind: 'executor-plan', summary: 'Recover slices', tasks: [
      { title: 'Core', prompt: 'Core slice.', files: ['src/core'], allowedTools: ['read_file'] },
      { title: 'UI', prompt: 'UI slice.', files: ['src/ui'], allowedTools: ['read_file'] },
      { title: 'Tests', prompt: 'Test slice.', files: ['tests'], allowedTools: ['read_file'] }
    ] };
    await store.createTask(taskInput(repo, { taskKey: 'resume-plan', creatorChatId: 'creator', paths: ['src/core', 'src/ui', 'tests'], execution, idempotencyKey: 'create-resume-plan' }));
    await store.claimTask({ taskKey: 'resume-plan', ownerChatId: 'creator', idempotencyKey: 'claim-resume-plan' });
    for (const [index, status] of [[1, 'completed'], [2, 'blocked'], [3, 'completed']]) {
      const executorId = `resume-plan-${index}`;
      await store.recordExecutorProgress({ taskKey: 'resume-plan', ownerChatId: 'creator', executorId, status: 'running', idempotencyKey: `resume-initial-start-${index}` });
      await store.recordExecutorProgress({ taskKey: 'resume-plan', ownerChatId: 'creator', executorId, status,
        idempotencyKey: `resume-initial-end-${index}`, sessionId: `session-${index}`,
        result: index === 2 ? 'Partial UI notes to retain.' : `Finished ${index}.`, reason: index === 2 ? 'Approval unavailable.' : '' });
    }
    assert.equal(store.getTask('resume-plan').status, 'blocked');
    const wrongOwner = await store.resumeExecutorPlan({ taskKey: 'resume-plan', ownerChatId: 'other', idempotencyKey: 'resume-wrong-owner' });
    assert.equal(wrongOwner.reason, 'creator_chat_mismatch');

    const resumed = await store.resumeExecutorPlan({ taskKey: 'resume-plan', ownerChatId: 'creator', idempotencyKey: 'resume-blocked-plan' });
    assert.equal(resumed.accepted, true);
    assert.deepEqual(resumed.tasks.map(item => item.id), ['resume-plan-2']);
    const afterResume = store.getTask('resume-plan');
    assert.equal(afterResume.executionProgress[0].status, 'completed');
    assert.equal(afterResume.executionProgress[2].status, 'completed');
    assert.equal(afterResume.executionProgress[1].status, 'queued');
    assert.equal(afterResume.executionProgress[1].history[0].result, 'Partial UI notes to retain.');
    assert.equal(afterResume.executionProgress[1].history[0].reason, 'Approval unavailable.');
    const duplicate = await store.resumeExecutorPlan({ taskKey: 'resume-plan', ownerChatId: 'creator', idempotencyKey: 'resume-blocked-plan' });
    assert.equal(duplicate.replayed, true);
    assert.equal((await store.resumeExecutorPlan({ taskKey: 'resume-plan', ownerChatId: 'creator', idempotencyKey: 'resume-while-live' })).reason, 'task_still_leased');

    await store.recordExecutorProgress({ taskKey: 'resume-plan', ownerChatId: 'creator', executorId: 'resume-plan-2', status: 'running', idempotencyKey: 'resume-second-start', sessionId: 'session-retry' });
    now += 16 * 60_000;
    const lateResult = await store.recordExecutorProgress({ taskKey: 'resume-plan', ownerChatId: 'creator', executorId: 'resume-plan-2', status: 'completed', idempotencyKey: 'resume-second-late-result', result: 'Late result' });
    assert.equal(lateResult.reason, 'claim_not_held');
    const recovered = await store.resumeExecutorPlan({ taskKey: 'resume-plan', ownerChatId: 'creator', idempotencyKey: 'resume-expired-running' });
    assert.equal(recovered.accepted, true);
    assert.deepEqual(recovered.tasks.map(item => item.id), ['resume-plan-2']);
    const recoveredRecord = new TaskRegistryStore({ dataDir, clock: () => now }).getTask('resume-plan');
    assert.deepEqual(recoveredRecord.executionProgress[1].history.map(entry => entry.status), ['blocked', 'interrupted']);
    assert.equal(recoveredRecord.executionProgress[1].history[0].result, 'Partial UI notes to retain.');
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

test('allows exactly one task owner when separate processes claim the same task at once', async () => {
  await withFixture(async ({ root, repo, dataDir, store }) => {
    await store.createTask(taskInput(repo, { idempotencyKey: 'create-process-race' }));
    const sameTaskResults = await raceProcessClaims({ root, repo, dataDir, store, name: 'same-task', claims: [
      { taskKey: 'slice-1', ownerChatId: 'chat-process-a', idempotencyKey: 'claim-process-a' },
      { taskKey: 'slice-1', ownerChatId: 'chat-process-b', idempotencyKey: 'claim-process-b' }
    ] });
    assert.equal(sameTaskResults.filter(result => result.accepted).length, 1);
    assert.equal(sameTaskResults.filter(result => result.reason === 'owned_by_other_chat').length, 1);
    assert.equal(store.getTask('slice-1').ownerChatId, sameTaskResults.find(result => result.accepted).ownerChatId);

    await store.createTask(taskInput(repo, { taskKey: 'overlap-a', paths: ['src/shared.js'], idempotencyKey: 'create-overlap-a' }));
    await store.createTask(taskInput(repo, { taskKey: 'overlap-b', paths: ['src/shared.js'], idempotencyKey: 'create-overlap-b' }));
    const overlapResults = await raceProcessClaims({ root, repo, dataDir, store, name: 'overlapping-paths', claims: [
      { taskKey: 'overlap-a', ownerChatId: 'chat-path-a', idempotencyKey: 'claim-path-a' },
      { taskKey: 'overlap-b', ownerChatId: 'chat-path-b', idempotencyKey: 'claim-path-b' }
    ] });
    const accepted = overlapResults.find(result => result.accepted);
    const rejected = overlapResults.find(result => !result.accepted);
    assert.ok(accepted);
    assert.equal(rejected.reason, 'path_scope_conflict');
    assert.equal(rejected.blockingTaskKey, accepted.taskKey);
    assert.equal([store.getTask('overlap-a'), store.getTask('overlap-b')].filter(task => task.ownerChatId).length, 1);
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

test('requires stage evidence before integration, review and completion, retaining the audit trail', async () => {
  await withFixture(async ({ repo, store }) => {
    const sourcePath = path.join(repo, 'src/core/example.js');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, 'module.exports = "base";\n');
    execFileSync('git', ['init', '--quiet', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Only Chat Test']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'only-chat-test@example.invalid']);
    execFileSync('git', ['-C', repo, 'add', 'src/core/example.js']);
    execFileSync('git', ['-C', repo, 'commit', '--quiet', '-m', 'task base']);
    const baseSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await store.createTask(taskInput(repo, { baseSha, paths: ['src/core'] }));
    await store.claimTask({ taskKey: 'slice-1', ownerChatId: 'chat-a', idempotencyKey: 'claim-slice-1' });
    await assert.rejects(store.updateCheckpoint({ taskKey: 'slice-1', ownerChatId: 'chat-a', idempotencyKey: 'bad-complete', status: 'completed', evidenceRefs: ['log:test'] }), /invalid task transition/);
    await assert.rejects(store.updateCheckpoint({ taskKey: 'slice-1', ownerChatId: 'chat-a', idempotencyKey: 'bad-block', status: 'blocked' }), /blocker description/);

    fs.writeFileSync(sourcePath, 'module.exports = "integrated";\n');
    execFileSync('git', ['-C', repo, 'add', 'src/core/example.js']);
    execFileSync('git', ['-C', repo, 'commit', '--quiet', '-m', 'integrate owned slice']);
    const integrationSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const steps = [
      ['executing', 'step-1', []], ['verifying', 'step-2', ['source:sha256:abc']],
      ['integrating', 'step-3', ['check:focused-tests:pass']], ['reviewing', 'step-4', [`integration:commit:${integrationSha}`]]
    ];
    for (const [status, idempotencyKey, evidenceRefs] of steps) {
      if (['integrating', 'reviewing'].includes(status)) {
        await assert.rejects(store.updateCheckpoint({ taskKey: 'slice-1', ownerChatId: 'chat-a', idempotencyKey: `${idempotencyKey}-without-evidence`, status }), new RegExp(`${status} requires`));
      }
      const result = await store.updateCheckpoint({ taskKey: 'slice-1', ownerChatId: 'chat-a', idempotencyKey, status, evidenceRefs });
      assert.equal(result.updated, true);
    }
    await assert.rejects(store.updateCheckpoint({ taskKey: 'slice-1', ownerChatId: 'chat-a', idempotencyKey: 'complete-no-evidence', status: 'completed' }), /completion requires/);
    fs.writeFileSync(sourcePath, 'module.exports = "uncommitted";\n');
    await assert.rejects(store.updateCheckpoint({ taskKey: 'slice-1', ownerChatId: 'chat-a', idempotencyKey: 'complete-with-evidence', status: 'completed', evidenceRefs: ['review:accepted'] }), /task-owned paths still have uncommitted changes/);
    assert.equal(store.getTask('slice-1').status, 'reviewing');
    assert.equal(store.getTask('slice-1').ownerChatId, 'chat-a');
    fs.writeFileSync(sourcePath, 'module.exports = "integrated";\n');
    const untrackedPath = path.join(repo, 'src/core/new.js');
    fs.writeFileSync(untrackedPath, 'module.exports = true;\n');
    await assert.rejects(store.updateCheckpoint({ taskKey: 'slice-1', ownerChatId: 'chat-a', idempotencyKey: 'complete-with-untracked', status: 'completed', evidenceRefs: ['review:accepted'] }), /task-owned paths still have uncommitted changes/);
    fs.rmSync(untrackedPath);
    const completed = await store.updateCheckpoint({ taskKey: 'slice-1', ownerChatId: 'chat-a', idempotencyKey: 'complete-with-evidence', status: 'completed', evidenceRefs: ['review:accepted'] });
    assert.equal(completed.updated, true);
    assert.deepEqual(completed.task.checkpoint.evidenceRefs, ['source:sha256:abc', 'check:focused-tests:pass', `integration:commit:${integrationSha}`, 'review:accepted']);
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

test('task mailbox is durable, idempotent, recipient-scoped, and supports explicit ACK readback', async () => {
  await withFixture(async ({ repo, dataDir, store }) => {
    await createAndClaim(store, repo, 'mail-task', 'session-a');
    const input = { taskKey: 'mail-task', senderChatId: 'session-a', recipientChatId: 'session-b',
      text: 'I found the canonical source and exact owned files.', idempotencyKey: 'message-1' };
    const sent = await store.sendMessage(input);
    assert.equal(sent.sent, true);
    assert.equal(sent.message.type, 'message');
    assert.equal(sent.message.senderHostId, store.hostId);
    assert.equal(sent.message.recipientHostId, store.hostId);
    const replay = await store.sendMessage(input);
    assert.equal(replay.replayed, true);
    assert.equal(replay.message.messageId, sent.message.messageId);

    assert.equal(store.listMessages({ taskKey: 'mail-task', viewerChatId: 'session-a' }).length, 1);
    assert.equal(store.listMessages({ taskKey: 'mail-task', viewerChatId: 'session-b' })[0].text, input.text);
    assert.equal(store.listMessages({ taskKey: 'mail-task', viewerChatId: 'session-c' }).length, 0);

    await assert.rejects(store.sendMessage({ taskKey: 'mail-task', senderChatId: 'session-c', type: 'ack',
      inReplyToMessageId: sent.message.messageId, text: 'Received', idempotencyKey: 'ack-forged' }), /only the message recipient/);
    const ack = await store.sendMessage({ taskKey: 'mail-task', senderChatId: 'session-b', type: 'ack',
      inReplyToMessageId: sent.message.messageId, text: 'Received and understood.', idempotencyKey: 'ack-1' });
    assert.equal(ack.message.type, 'ack');
    assert.equal(ack.message.senderHostId, store.hostId);
    assert.equal(ack.message.recipientHostId, store.hostId);
    assert.equal(ack.message.recipientChatId, 'session-a');
    assert.equal(store.listMessages({ taskKey: 'mail-task', viewerChatId: 'session-a' }).length, 2);
    assert.equal(store.listMessages({ taskKey: 'mail-task', viewerChatId: 'session-b', afterMessageId: sent.message.messageId })[0].messageId, ack.message.messageId);

    const reopened = new TaskRegistryStore({ dataDir });
    assert.equal(reopened.listMessages({ taskKey: 'mail-task', viewerChatId: 'session-a' }).length, 2);
  });
});

test('host-qualified mailbox visibility and ACK reject a reused chat ID from another host', async () => {
  await withFixture(async ({ root, repo, dataDir, store }) => {
    await createAndClaim(store, repo, 'hosted-mail-task', 'same-chat-id');
    const remoteHost = new TaskRegistryStore({ dataDir: path.join(root, 'remote-host') });
    const sent = await store.sendMessage({ taskKey: 'hosted-mail-task', senderChatId: 'same-chat-id',
      recipientChatId: 'same-chat-id', recipientHostId: remoteHost.hostId,
      text: 'Scoped to the remote host.', idempotencyKey: 'hosted-message' });
    assert.equal(store.listMessages({ taskKey: 'hosted-mail-task', viewerChatId: 'same-chat-id' })[0].messageId, sent.message.messageId);

    fs.writeFileSync(remoteHost.filePath, JSON.stringify({ schemaVersion: 1, tasks: [store.getTask('hosted-mail-task')],
      idempotency: [], messages: [sent.message], verificationCache: [] }), { mode: 0o600 });
    assert.equal(remoteHost.listMessages({ taskKey: 'hosted-mail-task', viewerChatId: 'same-chat-id' })[0].messageId, sent.message.messageId);
    assert.equal(store.listMessages({ taskKey: 'hosted-mail-task', viewerChatId: 'unrelated-chat' }).length, 0);

    await assert.rejects(store.sendMessage({ taskKey: 'hosted-mail-task', senderChatId: 'same-chat-id', type: 'ack',
      inReplyToMessageId: sent.message.messageId, text: 'Forged remote ACK', idempotencyKey: 'wrong-host-ack' }), /only the message recipient host/);
    const acknowledged = await remoteHost.sendMessage({ taskKey: 'hosted-mail-task', senderChatId: 'same-chat-id', type: 'ack',
      inReplyToMessageId: sent.message.messageId, text: 'Received on the addressed host.', idempotencyKey: 'remote-ack' });
    assert.equal(acknowledged.sent, true);
    assert.equal(acknowledged.message.senderHostId, remoteHost.hostId);
    assert.equal(acknowledged.message.recipientHostId, store.hostId);

    const unrelated = new TaskRegistryStore({ dataDir: path.join(root, 'unrelated-host') });
    fs.writeFileSync(unrelated.filePath, JSON.stringify({ schemaVersion: 1, tasks: [store.getTask('hosted-mail-task')],
      idempotency: [], messages: [sent.message], verificationCache: [] }), { mode: 0o600 });
    assert.equal(unrelated.listMessages({ taskKey: 'hosted-mail-task', viewerChatId: 'same-chat-id' }).length, 0);
  });
});

test('exports repository-free conversation tasks and imports a remote shell idempotently', async () => {
  await withFixture(async ({ root, repo, dataDir, store }) => {
    await store.createTask(taskInput(repo, { taskKey: 'shared-conversation', idempotencyKey: 'create-shared-conversation' }));
    const envelope = store.exportConversationTask('shared-conversation');
    assert.deepEqual(Object.keys(envelope).sort(), ['createdAt', 'creatorChatId', 'schemaVersion', 'sourceHostId', 'taskKey', 'title']);
    assert.doesNotMatch(JSON.stringify(envelope), /repositoryPath|baseSha|paths/);

    const remote = new TaskRegistryStore({ dataDir: path.join(root, 'remote-conversation') });
    const imported = await remote.importConversationTask(envelope);
    assert.equal(imported.imported, true);
    assert.equal(imported.task.conversationOnly, true);
    assert.equal(imported.task.repositoryPath, null);
    assert.equal(imported.task.baseSha, null);
    assert.deepEqual(imported.task.paths, []);
    assert.equal((await remote.importConversationTask(envelope)).replayed, true);

    const claim = await remote.claimTask({ taskKey: envelope.taskKey, ownerChatId: 'remote-chat', idempotencyKey: 'claim-remote-conversation' });
    assert.equal(claim.accepted, false);
    assert.equal(claim.reason, 'conversation_only');
    const reopened = new TaskRegistryStore({ dataDir: remote.dataDir });
    assert.equal(reopened.getTask(envelope.taskKey).repositoryPath, null);
    assert.equal(store.exportConversationTask(envelope.taskKey).sourceHostId, store.hostId);
  });
});

test('imports remote messages by recipient host, deduplicates, and verifies durable ACK round trips', async () => {
  await withFixture(async ({ root, repo, dataDir, store }) => {
    await store.createTask(taskInput(repo, { taskKey: 'remote-mailbox', idempotencyKey: 'create-remote-mailbox' }));
    const envelope = store.exportConversationTask('remote-mailbox');
    const receiverDataDir = path.join(root, 'receiver');
    const receiver = new TaskRegistryStore({ dataDir: receiverDataDir });
    await receiver.importConversationTask(envelope);
    const sent = await store.sendMessage({ taskKey: envelope.taskKey, senderChatId: 'mac-chat', recipientChatId: 'windows-chat',
      recipientHostId: receiver.hostId, text: 'Task-scoped Mac message.', idempotencyKey: 'mac-message-1' });

    assert.equal((await receiver.importRemoteMessage(sent.message)).imported, true);
    assert.equal((await receiver.importRemoteMessage(sent.message)).replayed, true);
    await assert.rejects(() => receiver.importRemoteMessage({ ...sent.message, text: 'Changed content under same ID.' }), /ID was reused/);
    const unrelated = new TaskRegistryStore({ dataDir: path.join(root, 'unrelated') });
    await unrelated.importConversationTask(envelope);
    await assert.rejects(() => unrelated.importRemoteMessage(sent.message), /not addressed to this host/);

    const ack = await receiver.sendMessage({ taskKey: envelope.taskKey, senderChatId: 'windows-chat', type: 'ack',
      inReplyToMessageId: sent.message.messageId, text: 'Received on Windows.', idempotencyKey: 'windows-ack-1' });
    assert.equal((await store.importRemoteMessage(ack.message)).imported, true);
    assert.equal((await store.importRemoteMessage(ack.message)).replayed, true);
    await assert.rejects(() => store.importRemoteMessage({ ...ack.message, messageId: crypto.randomUUID(), senderHostId: unrelated.hostId }), /does not match/);

    const reopenedSender = new TaskRegistryStore({ dataDir });
    const reopenedReceiver = new TaskRegistryStore({ dataDir: receiverDataDir });
    assert.equal(reopenedSender.listMessages({ taskKey: envelope.taskKey, viewerChatId: 'mac-chat' }).length, 2);
    assert.equal(reopenedReceiver.listMessages({ taskKey: envelope.taskKey, viewerChatId: 'windows-chat' }).length, 2);
    assert.equal(reopenedSender.listMessages({ taskKey: envelope.taskKey, viewerChatId: 'other-chat' }).length, 0);
  });
});

test('reuses exact completed verification inputs and invalidates only the changed check input', async () => {
  await withFixture(async ({ repo, dataDir, store }) => {
    const base = { verificationKey: 'onlychat-source-tests', repositoryPath: repo,
      inputSha256: 'a'.repeat(64), commandSha256: 'b'.repeat(64), environmentSha256: 'c'.repeat(64) };
    assert.deepEqual(store.lookupVerification(base), { hit: false, invalidatedEvidenceRefs: [] });
    const saved = await store.recordVerification({ ...base, evidenceRef: 'receipt:source-tests:run-1', idempotencyKey: 'verify-1' });
    assert.equal(saved.recorded, true);
    const reopened = new TaskRegistryStore({ dataDir });
    assert.equal(reopened.lookupVerification(base).hit, true);
    assert.equal(reopened.lookupVerification(base).record.evidenceRef, 'receipt:source-tests:run-1');

    const changed = { ...base, inputSha256: 'd'.repeat(64) };
    assert.deepEqual(reopened.lookupVerification(changed), { hit: false, invalidatedEvidenceRefs: ['receipt:source-tests:run-1'] });
    const replacement = await reopened.recordVerification({ ...changed, evidenceRef: 'receipt:source-tests:run-2', idempotencyKey: 'verify-2' });
    assert.equal(replacement.invalidatedEvidenceRef, 'receipt:source-tests:run-1');
    assert.equal(reopened.lookupVerification(base).hit, false);
    assert.equal(reopened.lookupVerification(changed).record.evidenceRef, 'receipt:source-tests:run-2');
    assert.throws(() => reopened.lookupVerification({ ...base, commandSha256: 'secret' }), /SHA-256/);
  });
});

test('accepts a legacy task registry file without mailbox array and fails closed on invalid message cursors', async () => {
  await withFixture(async ({ repo, store }) => {
    await store.createTask(taskInput(repo));
    const state = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
    delete state.messages;
    fs.writeFileSync(store.filePath, JSON.stringify(state), { mode: 0o600 });
    assert.deepEqual(store.listMessages({ taskKey: 'slice-1', viewerChatId: 'chat-a' }), []);
    await assert.rejects(store.sendMessage({ taskKey: 'slice-1', senderChatId: 'chat-a', type: 'ack',
      inReplyToMessageId: 'no-such-message', text: 'Not valid', idempotencyKey: 'bad-ack' }), /ACK must reference a message/);
    assert.throws(() => store.listMessages({ taskKey: 'slice-1', viewerChatId: 'chat-a', afterMessageId: 'missing' }), /message cursor/);
  });
});
