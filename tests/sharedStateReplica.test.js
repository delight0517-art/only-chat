'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SharedStateReplica } = require('../src/morph/SharedStateReplica.js');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-replica-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const make = (deviceId, platform) => new SharedStateReplica({ relayDir: path.join(root, 'relay'), stateDir: path.join(root, deviceId), deviceId, platform });
  return { a: make('mac-a', 'darwin'), b: make('win-b', 'win32'), root };
}
const payload = () => ({ settings: { theme: { mode: 'dark' }, layout: { compact: true } }, schedules: [] });

test('two peers publish and acknowledge one exact desired-state hash', async t => {
  const { a, b } = setup(t);
  const desired = a.publish(payload());
  for (const replica of [a, b]) {
    let actual;
    assert.equal((await replica.apply({ capabilities: { settings: ['theme', 'layout'], taskTypes: [] }, async apply(value) { actual = value; }, async read() { return actual; } })).ok, true);
  }
  assert.equal(a.status().crossPlatformApplied, true);
});

test('stale writes and unsafe payloads fail without changing the chain', t => {
  const { a, b } = setup(t);
  const first = a.publish(payload(), 0);
  assert.throws(() => b.publish(payload(), 0), /conflict/);
  assert.throws(() => a.publish({ settings: { theme: { apiKey: 'private' } }, schedules: [] }));
  for (const rrule of ['RRULE:', 'RRULE:FREQ=DAILY;COMMAND=RUN', 'RRULE:FREQ=DAILY;BYHOUR=99', 'RRULE:FREQ=DAILY;COUNT=2']) {
    assert.throws(() => a.publish({ settings: {}, schedules: [{ id: 'bad', timezone: 'Asia/Seoul', rrule, taskType: 'reminder' }] }));
  }
  assert.equal(a.inspect().hash, first.hash);
});

test('unsupported capabilities and mismatched readback do not ACK', async t => {
  const { a } = setup(t);
  a.publish(payload());
  assert.equal((await a.apply({ capabilities: { settings: [], taskTypes: [] }, apply() { throw Error('must not run'); } })).state, 'pending');
  assert.equal(a.status().ack, null);
  assert.equal((await a.apply({ capabilities: { settings: ['theme', 'layout'], taskTypes: [] }, async apply() {}, async read() { return { settings: {}, schedules: [] }; } })).reason, 'readback-mismatch');
  assert.equal(a.status().ack, null);
});

test('damaged ancestry fails closed', t => {
  const { a, root } = setup(t);
  a.publish(payload());
  const records = path.join(root, 'relay/shared-state/records');
  fs.writeFileSync(path.join(records, fs.readdirSync(records)[0]), '{');
  assert.throws(() => a.inspect());
});
