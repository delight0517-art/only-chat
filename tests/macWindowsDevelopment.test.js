'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MacWindowsDevelopment } = require('../src/core/MacWindowsDevelopment.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-joint-dev-'));
try {
  const dataDir = path.join(root, 'data');
  const store = new MacWindowsDevelopment({ dataDir });
  const hashA = 'a'.repeat(40), hashB = 'b'.repeat(40);
  const contract = {
    taskKey: 'detox-time-sync', title: '합산 시청시간', app: 'Detox', goal: '광고 시간을 제외해 플랫폼 시간을 합산한다', integrationBase: hashA,
    mac: { owner: 'mac-session', source: '/repo/detox', baseCommit: hashA, paths: ['mac/Timer.swift'] },
    windows: { owner: 'windows-session', source: 'C:/repo/detox', baseCommit: hashB, paths: ['windows/Timer.cs'] }
  };
  const created = store.create(contract);
  assert.equal(created.created, true);
  assert.equal(created.task.policy, 'canonical-main-no-branches');
  assert.equal(new MacWindowsDevelopment({ dataDir }).get(contract.taskKey).windows.baseCommit, hashB);
  assert.equal(store.create(contract).created, false);
  assert.throws(() => store.create({ ...contract, taskKey: 'overlap', windows: { ...contract.windows, paths: ['mac'] } }), /ownership overlaps/);
  assert.throws(() => store.updateSide(contract.taskKey, 'mac', { state: 'active', baseCommit: hashB }), /base commit changed/);
  const updated = store.updateSide(contract.taskKey, 'mac', { state: 'active', evidence: 'Mac implementation started' });
  assert.equal(updated.mac.state, 'active');
  assert.equal(updated.mac.evidence.length, 1);
  assert.throws(() => store.updateSide(contract.taskKey, 'mac', { state: 'tested', evidence: 'out of order' }), /one verified step/);
  assert.throws(() => store.updateSide(contract.taskKey, 'mac', { state: 'ready-to-share' }), /requires a specific evidence/);
  store.updateSide(contract.taskKey, 'mac', { state: 'ready-to-share', evidence: 'diff reviewed' });
  assert.throws(() => store.updateSide(contract.taskKey, 'mac', { state: 'drive-readback' }), /Drive readback/);
  store.recordPublished(contract.taskKey, { fileId: 'drive-file-01', sha256: 'c'.repeat(64), readback: true });
  assert.equal(store.updateSide(contract.taskKey, 'mac', { state: 'drive-readback' }).mac.state, 'drive-readback');
  const remote = { schema: 'only-chat-joint-development/v1', ...contract };
  const imported = new MacWindowsDevelopment({ dataDir: path.join(root, 'receiver') }).importPacket(remote, 'drive-file-02', 'd'.repeat(64));
  assert.equal(imported.drive.receiverRead, 'verified');
  assert.equal(store.list().length, 1);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('macWindowsDevelopment.test.js: passed');
