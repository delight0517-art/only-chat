'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ModelSwitchScheduleStore } = require('../src/core/ModelSwitchScheduleStore.js');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-model-switch-'));
let now = 1_800_000_000_000;
try {
  const store = new ModelSwitchScheduleStore({ dataDir, clock: () => now });
  const sessionId = 'session_1793700000000';
  const input = {
    sessionId, requestId: 'request-1', currentModel: 'gpt-6-sol', currentEffort: 'xhigh',
    targetModel: 'gpt-6-luna', targetEffort: 'low', durationMinutes: 5
  };
  const created = store.schedule(input);
  assert.equal(created.state, 'scheduled');
  assert.equal(created.dueAt, now + 300_000);
  assert.equal(store.schedule(input).id, created.id, 'retrying the same request is idempotent');

  const restored = new ModelSwitchScheduleStore({ dataDir, clock: () => now });
  assert.equal(restored.get(sessionId).id, created.id, 'schedule survives process reconstruction');
  assert.deepEqual(restored.resolveForRequest(sessionId, { model: input.currentModel, effort: input.currentEffort, targetAvailable: () => true }).apply, undefined,
    'the source model stays selected before the deadline');

  now = created.dueAt;
  const applied = restored.resolveForRequest(sessionId, { model: input.currentModel, effort: input.currentEffort, targetAvailable: model => model === 'gpt-6-luna' });
  assert.deepEqual(applied.apply, { model: 'gpt-6-luna', effort: 'low' }, 'deadline applies only on the next request');
  assert.equal(applied.schedule.state, 'applied');
  assert.deepEqual(restored.resolveForRequest(sessionId, { model: input.targetModel, effort: input.targetEffort, targetAvailable: () => false }).apply,
    { model: 'gpt-6-luna', effort: 'low' }, 'applied settings stay in force for later requests');

  const changedEffortSession = 'ses_0123456789abcdf0';
  const changedEffortSchedule = restored.schedule({ ...input, sessionId: changedEffortSession, requestId: 'request-effort' });
  now = changedEffortSchedule.dueAt;
  restored.resolveForRequest(changedEffortSession, { model: input.currentModel, effort: input.currentEffort, targetAvailable: () => true });
  const changedEffort = restored.resolveForRequest(changedEffortSession, { model: input.targetModel, effort: 'medium', targetAvailable: () => true });
  assert.equal(changedEffort.schedule.state, 'cancelled', 'changing only effort cancels the persistent applied schedule');

  const manualSession = 'ses_0123456789abcdef';
  const manual = restored.schedule({ ...input, sessionId: manualSession, requestId: 'request-2' });
  const changed = restored.resolveForRequest(manualSession, { model: 'gpt-6-sol', effort: 'medium', targetAvailable: () => true });
  assert.equal(changed.schedule.state, 'cancelled', 'a manual setting change cancels the pending schedule');
  assert.equal(changed.schedule.reason, 'manual-change');

  const aliasSession = 'session_1793700000002';
  const internalSession = 'ses_0123456789abcdf1';
  restored.schedule({ ...input, sessionId: aliasSession, requestId: 'request-alias' });
  assert.equal(restored.moveSession(aliasSession, internalSession).sessionId, internalSession, 'new-chat alias migrates to persisted internal session');
  assert.equal(restored.get(aliasSession), null);

  const unavailableSession = 'session_1793700000001';
  const unavailable = restored.schedule({ ...input, sessionId: unavailableSession, requestId: 'request-3' });
  now = unavailable.dueAt;
  const blocked = restored.resolveForRequest(unavailableSession, { model: input.currentModel, effort: input.currentEffort, targetAvailable: () => false });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.schedule.state, 'blocked', 'an unavailable target cannot fall back to the prior model');
  assert.throws(() => restored.schedule({ ...input, durationMinutes: 1441, requestId: 'bad' }), /invalid/i);
  assert.throws(() => restored.schedule({ ...input, targetModel: 'auto', requestId: 'bad-auto' }), /invalid/i);

  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'model-switch-schedules.json'), 'utf8'));
  assert.equal(saved.schedules[sessionId].state, 'applied');
  console.log('modelSwitchScheduleStore passed: persistence, deadline, idempotency, manual cancellation, and fail-closed target handling');
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
  assert.equal(fs.existsSync(dataDir), false, 'temporary test profile is removed');
}
