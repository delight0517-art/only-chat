'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const journal = require('../src/sync/SharedProviderPreferenceJournal.js');

const DEVICE_A = '11111111-1111-4111-8111-111111111111';
const DEVICE_B = '22222222-2222-4222-8222-222222222222';
const OP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OP_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACK_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ACK_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TIME = '2026-11-03T00:00:00.000Z';
const profile = (overrides = {}) => ({
  id: 'openrouter-profile-1', provider: 'openrouter', model: 'openai/gpt-4.1', priority: 1, enabled: true, ...overrides
});

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-shared-provider-preferences-'));
}

function snapshot(deviceId, operationId, profiles, baseStateHash = null, platform = 'win32') {
  return journal.createSnapshot({ deviceId, operationId, platform, profiles, baseStateHash, createdAt: TIME });
}

test('exports only exact, non-secret routing metadata and accepts both apps\' provider IDs', () => {
  for (const provider of ['openai-compatible', 'antigravity-agent', 'antigravity-cli', 'codex-app-server', 'chatgpt-plan', 'openrouter', 'codex-cli', 'antigravity']) {
    const value = snapshot(DEVICE_A, OP_A, [profile({ provider })]);
    assert.equal(value.profiles[0].provider, provider);
  }
  for (const extra of [{ token: 'secret' }, { credentialRef: 'vault://x' }, { email: 'private@example.com' }, { account: 'name' }, { apiKey: 'secret' }]) {
    assert.throws(() => snapshot(DEVICE_A, OP_A, [{ ...profile(), ...extra }]), /unsupported fields/);
  }
  assert.throws(() => snapshot(DEVICE_A, OP_A, [profile({ id: 'private@example.com' })]), /invalid or duplicated/);
  assert.throws(() => snapshot(DEVICE_A, OP_A, [profile({ provider: 'unknown-provider' })]), /unsupported/);
});

test('Windows and Mac compatible snapshot hash is deterministic and tampering is rejected', () => {
  const input = [profile({ provider: 'chatgpt-plan', id: 'chatgpt-plan-default', model: 'gpt-6-luna' })];
  const a = snapshot(DEVICE_A, OP_A, input, null, 'win32');
  const b = snapshot(DEVICE_B, OP_B, input, null, 'darwin');
  assert.equal(a.stateHash, b.stateHash);
  assert.equal(journal.validateSnapshot(a).snapshotHash, a.snapshotHash);
  assert.throws(() => journal.validateSnapshot({ ...a, profiles: [profile({ model: 'different-model' })] }), /hash verification/);
});

test('writes immutable snapshots and exact-state acknowledgements under an explicit absolute folder', () => {
  const folder = tempDir();
  try {
    const item = snapshot(DEVICE_A, OP_A, [profile()]);
    assert.throws(() => journal.writeSnapshot('relative-path', item), /absolute shared directory/);
    const first = journal.writeSnapshot(folder, item);
    const repeat = journal.writeSnapshot(folder, item);
    assert.equal(first.idempotent, false);
    assert.equal(repeat.idempotent, true);
    assert.deepEqual(journal.readSnapshots(folder).map(x => x.snapshotHash), [item.snapshotHash]);

    const ack = journal.createAcknowledgement({ deviceId: DEVICE_B, platform: 'darwin', stateHash: item.stateHash, ackId: ACK_B, acknowledgedAt: TIME });
    journal.writeAcknowledgement(folder, ack);
    assert.deepEqual(journal.acknowledgementsForState(journal.readAcknowledgements(folder), item.stateHash).map(x => x.deviceId), [DEVICE_B]);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('same-base concurrent edits remain conflicts and have no automatic winner', () => {
  const common = snapshot(DEVICE_A, OP_A, [profile()]);
  const left = snapshot(DEVICE_A, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', [profile({ model: 'model-left' })], common.stateHash);
  const right = snapshot(DEVICE_B, OP_B, [profile({ model: 'model-right' })], common.stateHash, 'darwin');
  const result = journal.resolveSnapshots([common, left, right]);
  assert.equal(result.status, 'conflict');
  assert.equal(result.state.stateHash, common.stateHash);
  assert.equal(result.conflicts.length, 2);
});

test('accepts a sequential chain and marks missing-base records incomplete', () => {
  const root = snapshot(DEVICE_A, OP_A, [profile()]);
  const next = snapshot(DEVICE_B, OP_B, [profile({ model: 'next-model' })], root.stateHash, 'darwin');
  assert.equal(journal.resolveSnapshots([root, next]).status, 'ready');
  assert.equal(journal.resolveSnapshots([next]).status, 'incomplete');
});

test('rejects duplicate operation identities, unexpected files and unverified peer ACK hashes', () => {
  const first = snapshot(DEVICE_A, OP_A, [profile()]);
  const second = snapshot(DEVICE_A, OP_A, [profile({ model: 'other-model' })]);
  assert.throws(() => journal.resolveSnapshots([first, second]), /operation ID/);
  const folder = tempDir();
  try {
    fs.mkdirSync(path.join(folder, 'snapshots'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'snapshots', 'unexpected.json'), '{}');
    assert.throws(() => journal.readSnapshots(folder), /Unexpected shared record name/);
    const ack = journal.createAcknowledgement({ deviceId: DEVICE_B, platform: 'darwin', stateHash: first.stateHash, ackId: ACK_B, acknowledgedAt: TIME });
    assert.throws(() => journal.validateAcknowledgement({ ...ack, stateHash: '0'.repeat(64) }), /hash verification/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
