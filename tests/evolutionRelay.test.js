'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EvolutionRelay } = require('../src/sync/EvolutionRelay.js');
const MODULE = 'src/ui/desktop/modules/theme/v1.mjs';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const old = 'export const version="old";\n';
const next = 'export const version="new";\n';
const loaded = async ({ files }) => ({ loadedHashes: Object.fromEntries(files.map(f => [f.path, f.newHash])) });
async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('timed_out_waiting_for_relay_watch_event');
}

async function fixture(callback, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'OnlyChat-EvolutionRelay-'));
  const aRoot = path.join(root, 'a'), bRoot = path.join(root, 'b'), relayRoot = path.join(root, 'relay');
  for (const source of [aRoot, bRoot]) {
    fs.mkdirSync(path.dirname(path.join(source, MODULE)), { recursive: true });
    fs.writeFileSync(path.join(source, MODULE), old);
  }
  const a = new EvolutionRelay({ canonicalRoot: aRoot, relayRoot, deviceId: 'mac', platform: 'darwin' });
  const b = new EvolutionRelay({ canonicalRoot: bRoot, relayRoot, deviceId: 'windows', platform: 'win32', verifyReload: loaded, ...options });
  a.start(); b.start();
  const publish = (extra = {}, content = next) => a.publish({ summary: 'Theme update', files: [{ path: MODULE, baseHash: hash(old), content, ...extra }] });
  try { await callback({ root, aRoot, bRoot, relayRoot, a, b, publish, file: path.join(bRoot, MODULE) }); }
  finally { await a.stop(); await b.stop(); fs.rmSync(root, { recursive: true, force: true }); }
}

async function main() {
  const results = [];
  await fixture(async ({ a, b, relayRoot, publish, file }) => {
    const { packetId, packet } = publish();
    assert.equal((await waitFor(() => b.getPending()[0])).packetId, packetId);
    assert.equal(packet.files[0].baseHash, hash(old));
    const result = await b.apply(packetId);
    assert.equal(result.state, 'runtime-applied');
    assert.equal(fs.readFileSync(file, 'utf8'), next);
    assert.equal(JSON.parse(fs.readFileSync(path.join(relayRoot, 'acks/windows', `${packetId}.json`))).loadedHashes[MODULE], hash(next));
    assert.equal(b.getPending().length, 0);
    assert.equal(a.getPending().length, 0);
    results.push('two peers, immutable blob, verified runtime ACK');
  });
  await fixture(async ({ b, relayRoot, publish, file }) => {
    const { packetId } = publish(); b.verifyReload = null;
    assert.equal((await b.apply(packetId)).state, 'source-applied');
    assert.equal(fs.readFileSync(file, 'utf8'), next);
    assert.equal(fs.existsSync(path.join(relayRoot, 'acks/windows', `${packetId}.json`)), false);
    b.verifyReload = loaded;
    assert.equal((await b.apply(packetId)).state, 'runtime-applied');
    results.push('source-only receipt is not ACK; resume verifies already-applied bytes');
  });
  await fixture(async ({ b, publish, file, relayRoot }) => {
    const { packetId } = publish(); fs.writeFileSync(file, 'local unsent source edit');
    assert.equal((await b.apply(packetId)).state, 'conflict');
    assert.equal(fs.readFileSync(file, 'utf8'), 'local unsent source edit');
    assert.equal(fs.existsSync(path.join(relayRoot, 'acks/windows', `${packetId}.json`)), false);
    results.push('base-hash conflict leaves local edits unchanged');
  });
  await fixture(async ({ a, b, bRoot, file }) => {
    const other = 'src/features/provider/v1.mjs';
    fs.mkdirSync(path.dirname(path.join(bRoot, other)), { recursive: true });
    fs.writeFileSync(path.join(bRoot, other), 'local provider edit');
    const { packetId } = a.publish({ summary: 'atomic pair', files: [
      { path: MODULE, baseHash: hash(old), content: next },
      { path: other, baseHash: hash(old), content: next }
    ] });
    assert.equal((await b.apply(packetId)).state, 'conflict');
    assert.equal(fs.readFileSync(file, 'utf8'), old);
    assert.equal(fs.readFileSync(path.join(bRoot, other), 'utf8'), 'local provider edit');
    results.push('all file base hashes checked before first file write');
  });
  await fixture(async ({ a, b, bRoot }) => {
    const added = 'src/features/qa-routing/v1.mjs';
    const { packetId } = a.publish({ summary: 'new allowed file', files: [{ path: added, baseHash: null, content: next }] });
    assert.equal((await b.apply(packetId)).state, 'runtime-applied');
    assert.equal(fs.readFileSync(path.join(bRoot, added), 'utf8'), next);
    assert.throws(() => a.publish({ summary: 'missing base', files: [{ path: MODULE, content: next }] }), /explicit_base_hash_required/);
    results.push('explicit null base creates allowed new file; omitted base refused');
  });
  await fixture(async ({ b, publish, relayRoot, file }) => {
    const { packetId } = publish(); fs.writeFileSync(path.join(relayRoot, 'blobs', `${hash(next)}.blob`), 'tampered');
    await assert.rejects(b.apply(packetId), /blob_hash_mismatch/);
    assert.equal(fs.readFileSync(file, 'utf8'), old);
    fs.appendFileSync(path.join(relayRoot, 'packets', `${packetId}.json`), ' ');
    assert.equal((await waitFor(() => b.getPending()[0]?.state === 'invalid' && b.getPending()[0])).state, 'invalid');
    await assert.rejects(b.apply(packetId), /packet_hash_mismatch/);
    results.push('packet and blob tamper refused before source writes');
  });
  await fixture(async ({ b, publish, file }) => {
    const { packetId } = publish({ platforms: ['darwin'] });
    assert.equal((await b.apply(packetId)).state, 'wrong-platform');
    assert.equal(fs.readFileSync(file, 'utf8'), old);
    results.push('platform applicability prevents wrong-device apply');
  });
  await fixture(async ({ b, publish, file, relayRoot }) => {
    const { packetId } = publish();
    assert.equal((await b.apply(packetId)).state, 'rolled-back');
    assert.equal(fs.readFileSync(file, 'utf8'), old);
    assert.equal(fs.existsSync(path.join(relayRoot, 'acks/windows', `${packetId}.json`)), false);
    results.push('failed reload hook restores exact source preimage without ACK');
  }, { verifyReload: async () => { throw new Error('failed fixture reload'); } });
  await fixture(async ({ b, publish, file }) => {
    let release, entered;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    b.verifyReload = ({ files, signal }) => new Promise(resolve => { release = () => resolve({ loadedHashes: { [MODULE]: files[0].newHash } }); entered(signal); });
    const { packetId } = publish(); const applying = b.apply(packetId);
    const signal = await enteredPromise; const stopping = b.stop();
    assert.equal(signal.aborted, true); release();
    assert.equal((await applying).state, 'cancelled'); await stopping;
    assert.equal(fs.readFileSync(file, 'utf8'), old);
    assert.equal(b.enabled, false);
    assert.throws(() => b.apply(packetId), /relay_stopped/);
    results.push('stop aborts in-flight verification, rolls back, fences late apply');
  });
  await fixture(async ({ a, b, file }) => {
    let active = 0, maxActive = 0;
    b.verifyReload = async ({ files }) => { active++; maxActive = Math.max(maxActive, active); await new Promise(r => setTimeout(r, 20)); active--; return { loadedHashes: { [MODULE]: files[0].newHash } }; };
    const first = a.publish({ summary: 'first', files: [{ path: MODULE, baseHash: hash(old), content: next }] });
    const last = 'export const version="last";\n';
    const second = a.publish({ summary: 'second', parentPacketId: first.packetId, files: [{ path: MODULE, baseHash: hash(next), content: last }] });
    const both = await Promise.all([b.apply(first.packetId), b.apply(second.packetId)]);
    assert.deepEqual(both.map(x => x.state), ['runtime-applied', 'runtime-applied']);
    assert.equal(maxActive, 1); assert.equal(fs.readFileSync(file, 'utf8'), last);
    results.push('concurrent calls serialize with chained per-file base hashes');
  });
  await fixture(async ({ a, b, relayRoot, file }) => {
    const spec = { path: 'src/ui/desktop/server.js', baseHash: hash(old), content: 'DO_NOT_DISTRIBUTE_CORE_CONTENT', applyMode: 'restart' };
    const { packetId } = a.publish({ summary: 'Core route change', task: 'Apply this through the owning agent and preserve state before restart.', files: [spec] });
    assert.equal((await b.apply(packetId)).state, 'needs-agent');
    const packetText = fs.readFileSync(path.join(relayRoot, 'packets', `${packetId}.json`), 'utf8');
    assert.equal(packetText.includes(spec.content), false); assert.equal(packetText.includes(path.resolve(file)), false);
    assert.equal(fs.readdirSync(path.join(relayRoot, 'blobs')).length, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), old);
    assert.throws(() => a.publish({ summary: 'bad', files: [{ ...spec, path: '../escape.js' }] }), /invalid_relative_path/);
    assert.throws(() => a.publish({ summary: 'bad', files: [{ ...spec, path: 'C:/escape.js' }] }), /invalid_relative_path/);
    results.push('core restart task contains metadata only; traversal and absolute paths refused');
  });
  await fixture(async ({ b, publish, file }) => {
    const { packetId } = publish();
    assert.equal((await b.apply(packetId)).state, 'deferred');
    assert.equal(fs.readFileSync(file, 'utf8'), old);
    results.push('host busy guard defers before write');
  }, { getBlockers: () => ['active request'] });
  await fixture(async ({ b, publish, file }) => {
    const { packetId } = publish();
    assert.equal((await b.apply(packetId)).state, 'rolled-back');
    assert.equal(fs.readFileSync(file, 'utf8'), old);
    results.push('bounded verification timeout rolls back');
  }, { verifyTimeoutMs: 20, verifyReload: () => new Promise(() => {}) });
  await fixture(async ({ b, publish, file }) => {
    const { packetId } = publish();
    b.verifyReload = async ({ files }) => { fs.writeFileSync(file, 'newer local edit'); return { loadedHashes: { [MODULE]: files[0].newHash } }; };
    assert.equal((await b.apply(packetId)).state, 'conflict');
    assert.equal(fs.readFileSync(file, 'utf8'), 'newer local edit');
    results.push('concurrent local edit is not overwritten during failure rollback');
  });
  await fixture(async ({ bRoot, root, a, b }) => {
    const themeDir = path.dirname(path.join(bRoot, MODULE)), outside = path.join(root, 'outside');
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'v1.mjs'), old);
    fs.rmSync(themeDir, { recursive: true }); fs.symlinkSync(outside, themeDir, process.platform === 'win32' ? 'junction' : 'dir');
    const { packetId } = a.publish({ summary: 'blocked junction', files: [{ path: MODULE, baseHash: hash(old), content: next }] });
    await assert.rejects(b.apply(packetId), /symlink_rejected/);
    assert.equal(fs.readFileSync(path.join(outside, 'v1.mjs'), 'utf8'), old);
    results.push('source junction escape refused');
  });
  console.log(`evolutionRelay.test.js: passed (${results.length} cases)`);
  for (const result of results) console.log(`  ${result}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
