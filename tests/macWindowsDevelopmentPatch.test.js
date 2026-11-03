'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { MacWindowsDevelopment } = require('../src/core/MacWindowsDevelopment.js');

function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }); }
function initRepo(repo, fileContent = 'base\n') {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '--quiet', '--initial-branch=main');
  git(repo, 'config', 'user.email', 'joint-dev-test@example.invalid');
  git(repo, 'config', 'user.name', 'Joint Dev Test');
  fs.writeFileSync(path.join(repo, 'shared.txt'), fileContent);
  git(repo, 'add', 'shared.txt'); git(repo, 'commit', '--quiet', '-m', 'base');
  return git(repo, 'rev-parse', 'HEAD').trim();
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-joint-patch-'));
try {
  const macRepo = path.join(root, 'mac-repo');
  const windowsRepo = path.join(root, 'windows-repo');
  const conflictRepo = path.join(root, 'windows-conflict-repo');
  const base = initRepo(macRepo);
  git(root, 'clone', '--quiet', '--no-local', macRepo, windowsRepo);
  git(root, 'clone', '--quiet', '--no-local', macRepo, conflictRepo);
  for (const repo of [windowsRepo, conflictRepo]) { git(repo, 'config', 'user.email', 'joint-dev-test@example.invalid'); git(repo, 'config', 'user.name', 'Joint Dev Test'); }
  fs.writeFileSync(path.join(macRepo, 'shared.txt'), 'Mac change\n');
  const macStore = new MacWindowsDevelopment({ dataDir: path.join(root, 'mac-data'), platform: 'darwin' });
  const contract = { taskKey: 'shared-patch', contractVersion: 2, title: 'patch', app: 'Sample', goal: 'transfer scoped source change',
    sharedContract: 'Mac and Windows implement the same persisted behavior.', acceptanceCriteria: ['Both sides use the shared API contract.'], integrationBase: base,
    mac: { owner: 'Mac', source: macRepo, baseCommit: base, paths: ['shared.txt'] },
    windows: { owner: 'Windows', source: windowsRepo, baseCommit: base, paths: ['windows-only/'] } };
  macStore.create(contract);
  macStore.updateSide('shared-patch', 'mac', { state: 'active' });
  const packet = macStore.createPatch('shared-patch');
  assert.deepEqual(packet.filePaths, ['shared.txt']);
  assert.equal(packet.contract.contractVersion, 2);
  assert.equal(packet.contract.sharedContract, contract.sharedContract);
  assert.deepEqual(packet.contract.acceptanceCriteria, contract.acceptanceCriteria);
  macStore.recordPatch('shared-patch', 'mac', { fileId: 'drive-patch-1', patchSha256: packet.patchSha256,
    payloadSha256: crypto.createHash('sha256').update(JSON.stringify(packet)).digest('hex'), filePaths: packet.filePaths, readback: true });

  const receiver = new MacWindowsDevelopment({ dataDir: path.join(root, 'windows-data'), platform: 'win32' });
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify(packet)).digest('hex');
  receiver.receivePatch(packet, 'drive-patch-1', payloadHash);
  assert.equal(receiver.list()[0].incomingPatches[0].patch, undefined, 'ordinary task list does not stream source diffs');
  assert.match(receiver.readIncomingPatch('shared-patch', 'drive-patch-1').patch, /Mac change/);
  const applied = receiver.applyPatch('shared-patch', 'drive-patch-1');
  assert.equal(applied.incomingPatches[0].state, 'applied');
  assert.equal(fs.readFileSync(path.join(windowsRepo, 'shared.txt'), 'utf8'), 'Mac change\n');

  const mismatchContract = { ...contract, taskKey: 'shared-patch-contract-mismatch' };
  macStore.create(mismatchContract);
  macStore.updateSide(mismatchContract.taskKey, 'mac', { state: 'active' });
  const mismatchPacket = macStore.createPatch(mismatchContract.taskKey);
  const mismatchedReceiver = new MacWindowsDevelopment({ dataDir: path.join(root, 'windows-mismatch-data'), platform: 'win32' });
  mismatchedReceiver.create({ ...mismatchContract, sharedContract: 'Receiver silently changed the agreed API.' });
  const alteredPacket = { ...mismatchPacket, contract: { ...mismatchPacket.contract, sharedContract: 'Tampered API contract.' } };
  const alteredPayloadHash = crypto.createHash('sha256').update(JSON.stringify(alteredPacket)).digest('hex');
  assert.throws(() => mismatchedReceiver.receivePatch(alteredPacket, 'drive-patch-tampered', alteredPayloadHash), /patch contract conflicts with the registered task/);
  const receipt = receiver.createAppliedReceipt('shared-patch', 'drive-patch-1');
  const receiptHash = crypto.createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
  const sender = macStore.recordRemoteReceipt(receipt, 'drive-ack-1', receiptHash);
  assert.equal(sender.remoteReceipts[0].state, 'applied');

  const conflictContract = { ...contract, taskKey: 'shared-patch-conflict', windows: { ...contract.windows, source: conflictRepo } };
  macStore.create(conflictContract);
  macStore.updateSide('shared-patch-conflict', 'mac', { state: 'active' });
  const conflictPacket = macStore.createPatch('shared-patch-conflict');
  const conflictReceiver = new MacWindowsDevelopment({ dataDir: path.join(root, 'windows-conflict-data'), platform: 'win32' });
  const conflictHash = crypto.createHash('sha256').update(JSON.stringify(conflictPacket)).digest('hex');
  conflictReceiver.receivePatch(conflictPacket, 'drive-patch-2', conflictHash);
  fs.writeFileSync(path.join(conflictRepo, 'shared.txt'), 'Windows local change\n');
  assert.throws(() => conflictReceiver.applyPatch('shared-patch-conflict', 'drive-patch-2'), /local changes overlap/);
  assert.equal(fs.readFileSync(path.join(conflictRepo, 'shared.txt'), 'utf8'), 'Windows local change\n');
  assert.throws(() => macStore.create({ ...contract, taskKey: 'private-path', mac: { ...contract.mac, paths: ['.env'] } }), /cannot be shared/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('macWindowsDevelopmentPatch.test.js: passed');
