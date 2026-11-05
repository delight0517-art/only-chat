'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const { WorkspaceExecutionLease } = require('../src/core/WorkspaceExecutionLease');
const { AgentEngine } = require('../src/core/AgentEngine');

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-coordination-'));
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    const options = { lockRoot: path.join(root, 'locks'), waitMs: 1000, retryMs: 10 };
    const lease = new WorkspaceExecutionLease(options);
    await run({ root, workspace, lease, options,
      lock: path.join(options.lockRoot, `${lease._workspaceKey(workspace)}.lock`) });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false);
  }
}

test('contending turn waits, unrelated workspace runs, then queued turn resumes once', async () => fixture(async ({ root, workspace, lease, options }) => {
  let release;
  const holding = lease.run(workspace, 'first', () => new Promise(resolve => { release = resolve; }));
  const waiting = new WorkspaceExecutionLease(options);
  let entered = 0;
  let observation;
  const next = waiting.run(workspace, 'second', async () => { entered++; }, { onWait: value => { observation = value; } });
  assert.equal(entered, 0);
  assert.equal(observation.scope, 'workspace_execution');
  assert.equal(observation.repositoryWide, false);
  assert.equal(observation.resourceKey, lease._workspaceKey(workspace));
  assert.ok(Number.isFinite(Date.parse(observation.readAt)));
  let independent = false;
  await waiting.run(path.join(root, 'other-app'), 'independent', async () => { independent = true; });
  assert.equal(independent, true);
  release();
  await Promise.all([holding, next]);
  assert.equal(entered, 1);
}));

test('timeout and cancellation preserve a live holder and never run the queued mutation', async () => fixture(async ({ workspace, lease, options, lock }) => {
  let release;
  const holding = lease.run(workspace, 'holder', () => new Promise(resolve => { release = resolve; }));
  const before = fs.readFileSync(lock, 'utf8');
  const waiting = new WorkspaceExecutionLease(options);
  let ran = false;
  try {
    await assert.rejects(waiting.run(workspace, 'timed', () => { ran = true; }, { waitMs: 20 }), error =>
      error.code === 'WORKSPACE_BUSY' && error.retryable && error.evidence.state === 'held');
    const controller = new AbortController();
    const pending = waiting.run(workspace, 'cancelled', () => { ran = true; }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(fs.readFileSync(lock, 'utf8'), before);
  } finally { release(); await holding; }
  assert.equal(ran, false);
}));

test('foreign and unreadable ownership never authorize stale-lock removal', async () => fixture(async ({ workspace, lease, lock }) => {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (const raw of ['{bad json', JSON.stringify({ host: 'foreign-host', pid: 2147483647, startedAt: new Date().toISOString() })]) {
    fs.writeFileSync(lock, raw);
    await assert.rejects(lease.run(workspace, 'waiting', () => assert.fail('must not execute'), { waitMs: 20 }), { code: 'WORKSPACE_BUSY' });
    assert.equal(fs.readFileSync(lock, 'utf8'), raw);
  }
}));

test('actual child-process death is recovered without manual lock deletion', async () => fixture(async ({ root, workspace, lease, options, lock }) => {
  const marker = path.join(root, 'ready');
  const source = `const fs=require('node:fs');const {WorkspaceExecutionLease}=require(${JSON.stringify(path.resolve(__dirname, '../src/core/WorkspaceExecutionLease'))});new WorkspaceExecutionLease(${JSON.stringify(options)}).run(${JSON.stringify(workspace)},'child',async()=>{fs.writeFileSync(${JSON.stringify(marker)},'ready');await new Promise(r=>setTimeout(r,10000));});`;
  const child = spawn(process.execPath, ['-e', source], { stdio: 'ignore' });
  const exited = once(child, 'exit');
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(marker)) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error('child lease not acquired');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    child.kill('SIGKILL');
    await exited;
    assert.equal(fs.existsSync(lock), true, 'crash leaves the real lock behind');
    let recovered = false;
    await lease.run(workspace, 'recovered', async () => { recovered = true; });
    assert.equal(recovered, true);
    assert.equal(fs.existsSync(lock), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
}));

test('PID reuse with verified process birth mismatch is stale; unknown birth stays protected', async () => fixture(async ({ workspace, options, lock }) => {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const owner = { host: os.hostname(), pid: process.pid, startedAt: new Date().toISOString(), processIdentity: 'prior-incarnation' };
  fs.writeFileSync(lock, JSON.stringify(owner));
  const unknown = new WorkspaceExecutionLease({ ...options, processIdentity: () => null });
  assert.equal(unknown.getStatus(workspace).state, 'held');
  const verified = new WorkspaceExecutionLease({ ...options, processIdentity: () => 'current-incarnation' });
  assert.equal(verified.getStatus(workspace).state, 'stale');
  await verified.run(workspace, 'replacement', async () => {});
}));

test('an escaped old async context cannot bypass a subsequent live owner', async () => fixture(async ({ workspace, lease, options }) => {
  let invokeLate;
  const trigger = new Promise(resolve => { invokeLate = resolve; });
  let late;
  await lease.run(workspace, 'old', async () => {
    late = trigger.then(() => lease.run(workspace, 'late', () => assert.fail('old context bypassed lease'), { waitMs: 0 }));
  });
  let release;
  const holding = new WorkspaceExecutionLease(options).run(workspace, 'new', () => new Promise(resolve => { release = resolve; }));
  try {
    invokeLate();
    await assert.rejects(late, { code: 'WORKSPACE_BUSY' });
  } finally { release(); await holding; }
}));

test('AgentEngine passes abort and waiting evidence through the real execution lease', async () => fixture(async ({ workspace, lease, options }) => {
  let release;
  const holding = lease.run(workspace, 'holder', () => new Promise(resolve => { release = resolve; }));
  const controller = new AbortController();
  const observations = [];
  let executed = false;
  const engine = { workspaceDir: workspace, currentSession: { sessionId: 'queued-turn' },
    workspaceExecutionLease: new WorkspaceExecutionLease(options),
    emit: (name, value) => observations.push({ name, value }),
    _ensureAccountRouterTier: async () => {},
    _executeTurn: async () => { executed = true; } };
  try {
    const pending = AgentEngine.prototype.executeTurn.call(engine, 'task', { signal: controller.signal });
    assert.equal(observations[0].name, 'workspace_waiting');
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(executed, false);
  } finally { release(); await holding; }
}));
