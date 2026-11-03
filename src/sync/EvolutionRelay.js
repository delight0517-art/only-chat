'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const COMMON = /^(?:src\/ui\/desktop\/modules\/(?:theme|font|layout|appearance)|src\/features\/(?:qa-routing|provider))\/v1\.mjs$/;
const HASH = /^[a-f0-9]{64}$/;
const DEVICE = /^[a-zA-Z0-9_-]{1,80}$/;
const MAX_BYTES = 2 * 1024 * 1024;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function relative(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || value.includes('\\') || value.startsWith('/') || value.split('/').some(s => !s || s === '.' || s === '..') || /[\x00-\x1f:]/.test(value)) throw new Error('invalid_relative_path');
  if (!(value === 'package.json' || /^(src|scripts)\/[a-zA-Z0-9_./-]+\.(?:js|mjs|cjs|json|ps1|cs|py)$/.test(value))) throw new Error('source_path_not_allowed');
  return value;
}
function text(value, max) {
  if (typeof value !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error('invalid_summary');
  return value.slice(0, max);
}
function platforms(value) {
  const list = value === undefined ? ['win32', 'darwin', 'linux'] : value;
  if (!Array.isArray(list) || !list.length || list.some(x => !['win32', 'darwin', 'linux'].includes(x)) || new Set(list).size !== list.length) throw new Error('invalid_platforms');
  return list;
}

class EvolutionRelay extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.canonicalRoot || !options.relayRoot || !DEVICE.test(options.deviceId || '')) throw new Error('relay_identity_required');
    this.root = path.resolve(options.canonicalRoot);
    this.relayRoot = path.resolve(options.relayRoot);
    if (this.root === this.relayRoot || this.relayRoot.startsWith(this.root + path.sep) || this.root.startsWith(this.relayRoot + path.sep)) throw new Error('relay_must_be_separate_from_source');
    this.deviceId = options.deviceId;
    this.platform = options.platform || process.platform;
    this.capabilities = options.capabilities || ['module-v1'];
    this.getBlockers = options.getBlockers || (() => []);
    this.verifyReload = options.verifyReload || null;
    this.verifyTimeoutMs = Math.max(10, Math.min(options.verifyTimeoutMs || 10000, 30000));
    this.enabled = false;
    this.epoch = 0;
    this.applying = null;
    this.tail = Promise.resolve();
    this.controllers = new Set();
    this.packetWatcher = null;
    this.packetIndex = new Map();
  }

  start() {
    this._ensureRoot(this.root, false);
    this._ensureRoot(this.relayRoot, true);
    for (const sub of ['packets', 'blobs', `receipts/${this.deviceId}`, `acks/${this.deviceId}`]) this._file(this.relayRoot, `${sub}/.placeholder`, true);
    this._refreshPacketIndex();
    const packetDirectory = path.dirname(this._file(this.relayRoot, 'packets/.placeholder'));
    this.packetWatcher = fs.watch(packetDirectory, { persistent: false }, (event, filename) => {
      const name = filename?.toString();
      if (name && /^[a-f0-9]{64}\.json$/.test(name)) this._indexPacket(name.slice(0, -5), true);
      else this._refreshPacketIndex(true);
    });
    this.packetWatcher.on('error', error => this.emit('watch_error', error));
    if (!this.enabled) { this.enabled = true; this.epoch++; }
    return { enabled: true, deviceId: this.deviceId };
  }

  async stop() {
    this.enabled = false;
    this.epoch++;
    this.packetWatcher?.close();
    this.packetWatcher = null;
    for (const controller of this.controllers) controller.abort();
    await this.tail.catch(() => {});
    return { enabled: false, deviceId: this.deviceId };
  }

  status() { return { enabled: this.enabled, deviceId: this.deviceId, applying: this.applying, pending: this.getPending() }; }

  publish(spec = {}) {
    this._active();
    if (!Array.isArray(spec.files) || !spec.files.length || spec.files.length > 32) throw new Error('invalid_file_set');
    const seen = new Set();
    const blobs = [];
    const files = spec.files.map(file => {
      const name = relative(file.path);
      if (seen.has(name)) throw new Error('duplicate_path');
      seen.add(name);
      if (file.baseHash !== null && !HASH.test(file.baseHash || '')) throw new Error('explicit_base_hash_required');
      const common = COMMON.test(name) && (!file.applyMode || file.applyMode === 'hot-reload');
      const local = this._file(this.root, name);
      const bytes = file.content === undefined ? fs.readFileSync(local) : Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content), 'utf8');
      if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('invalid_source_size');
      const newHash = digest(bytes);
      if (common) blobs.push([newHash, bytes]);
      return { path: name, baseHash: file.baseHash, newHash, platforms: platforms(file.platforms), applyMode: common ? 'hot-reload' : file.applyMode === 'restart' ? 'restart' : 'needs-agent' };
    });
    if (spec.parentPacketId != null && !HASH.test(spec.parentPacketId)) throw new Error('invalid_parent_packet');
    const packet = { schemaVersion: 1, projectId: 'only-chat', authorDeviceId: this.deviceId, createdAt: new Date().toISOString(), parentPacketId: spec.parentPacketId || null, requiredCapabilities: ['module-v1'], summary: text(spec.summary || '', 600), task: text(spec.task || '', 2000), files };
    const bytes = Buffer.from(JSON.stringify(packet));
    const packetId = digest(bytes);
    for (const [hash, data] of blobs) this._immutable(this._file(this.relayRoot, `blobs/${hash}.blob`, true), data);
    this._immutable(this._file(this.relayRoot, `packets/${packetId}.json`, true), bytes);
    return { packetId, packet };
  }

  getPending() {
    return [...this.packetIndex.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([packetId, entry]) => {
      if (entry.error) return [{ packetId, state: 'invalid', error: entry.error }];
      const packet = entry.packet;
      if (packet.authorDeviceId === this.deviceId) return [];
      try {
        const receipt = entry.receipt;
        if (receipt?.state === 'runtime-applied' && entry.ack) return [];
        const missingAck = receipt?.state === 'runtime-applied';
        return [{ packetId, summary: packet.summary, task: packet.task, authorDeviceId: packet.authorDeviceId, files: packet.files, state: missingAck ? 'pending' : receipt?.state || 'pending', error: missingAck ? 'runtime_ack_missing' : receipt?.error || null }];
      } catch (error) { return [{ packetId, state: 'invalid', error: String(error.message) }]; }
    });
  }

  _refreshPacketIndex(revalidate = false) {
    if (!fs.existsSync(this.relayRoot)) return;
    const directory = path.dirname(this._file(this.relayRoot, 'packets/.placeholder'));
    if (!fs.existsSync(directory)) return;
    for (const name of fs.readdirSync(directory).filter(x => /^[a-f0-9]{64}\.json$/.test(x)).sort()) this._indexPacket(name.slice(0, -5), revalidate);
  }

  _indexPacket(packetId, revalidate = false) {
    if (this.packetIndex.has(packetId) && !this.packetIndex.get(packetId).error && !revalidate) return;
    try {
      const packet = this._packet(packetId);
      const receipt = this._readReceipt(packetId);
      const ack = receipt?.state === 'runtime-applied' ? this._readAck(packetId, packet) : null;
      this.packetIndex.set(packetId, { packet, receipt, ack });
      this.emit('pending_changed', { packetId });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      this.packetIndex.set(packetId, { error: String(error.message) });
      this.emit('pending_changed', { packetId, invalid: true });
    }
  }

  apply(packetId) {
    this._active();
    const token = this.epoch;
    const run = this.tail.catch(() => {}).then(() => this._apply(packetId, token)).then(result => {
      this._indexPacket(packetId, true);
      return result;
    });
    this.tail = run;
    return run;
  }

  async _apply(packetId, token) {
    if (!this._current(token)) return { packetId, state: 'cancelled' };
    const packet = this._packet(packetId);
    if (packet.requiredCapabilities.some(x => !this.capabilities.includes(x))) return this._receipt(packetId, 'needs-agent', { error: 'unsupported_capability' });
    const selected = packet.files.filter(file => file.platforms.includes(this.platform));
    if (!selected.length) return this._receipt(packetId, 'wrong-platform');
    if (selected.some(file => file.applyMode !== 'hot-reload' || !COMMON.test(file.path))) return this._receipt(packetId, 'needs-agent', { task: packet.task || packet.summary });
    const blockers = this.getBlockers();
    if (blockers === false || (Array.isArray(blockers) ? blockers.length : Boolean(blockers))) return this._receipt(packetId, 'deferred', { error: 'host_busy' });
    const prior = this._readReceipt(packetId);
    const priorAck = this._readAck(packetId, packet);
    if (prior?.state === 'runtime-applied' && priorAck) return prior;
    const changes = [];
    for (const file of selected) {
      const target = this._file(this.root, file.path, true);
      const before = fs.existsSync(target) ? fs.readFileSync(target) : null;
      const currentHash = before === null ? null : digest(before);
      const resumed = ['source-applied', 'runtime-applied'].includes(prior?.state) && !priorAck && currentHash === file.newHash;
      if (currentHash !== file.baseHash && !resumed) return this._receipt(packetId, 'conflict', { path: file.path });
      const blob = this._file(this.relayRoot, `blobs/${file.newHash}.blob`);
      if (!fs.existsSync(blob)) return this._receipt(packetId, 'deferred', { error: 'blob_not_arrived' });
      const bytes = fs.readFileSync(blob);
      if (bytes.length > MAX_BYTES || digest(bytes) !== file.newHash) throw new Error('blob_hash_mismatch');
      changes.push({ ...file, target, before, bytes, resumed });
    }
    const written = [];
    const controller = new AbortController();
    this.controllers.add(controller);
    this.applying = packetId;
    try {
      for (const change of changes) {
        if (!this._current(token)) throw new Error('relay_stopped');
        if (!change.resumed) { this._atomic(change.target, change.bytes); written.push(change); }
      }
      if (!this.verifyReload) return this._receipt(packetId, 'source-applied', { loadedHashes: {} });
      let timer;
      let result;
      try {
        result = await Promise.race([
          Promise.resolve().then(() => this.verifyReload({ packet, files: selected, signal: controller.signal })),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('reload_verification_timeout')); }, this.verifyTimeoutMs); })
        ]);
      } finally { clearTimeout(timer); }
      if (!this._current(token) || controller.signal.aborted) throw new Error('relay_stopped');
      if (result?.state === 'source-applied') return this._receipt(packetId, 'source-applied', { loadedHashes: {} });
      if (!result?.loadedHashes || selected.some(file => result.loadedHashes[file.path] !== file.newHash)) throw new Error('loaded_hash_not_verified');
      for (const change of changes) if (digest(fs.readFileSync(this._file(this.root, change.path))) !== change.newHash) throw new Error('source_changed_during_reload');
      const receipt = this._receipt(packetId, 'runtime-applied', { loadedHashes: Object.fromEntries(selected.map(f => [f.path, f.newHash])) });
      this._atomic(this._file(this.relayRoot, `acks/${this.deviceId}/${packetId}.json`, true), Buffer.from(JSON.stringify(receipt)));
      return receipt;
    } catch (error) {
      let rollbackError = null;
      for (const change of written.reverse()) {
        try {
          const target = this._file(this.root, change.path);
          if (!fs.existsSync(target) || digest(fs.readFileSync(target)) !== change.newHash) throw new Error('rollback_concurrent_source_change');
          if (change.before === null) fs.unlinkSync(target); else this._atomic(target, change.before);
        } catch (failure) { rollbackError = String(failure.message); }
      }
      return this._receipt(packetId, rollbackError ? 'conflict' : !written.length && prior?.state === 'source-applied' ? 'source-applied' : this._current(token) ? 'rolled-back' : 'cancelled', { error: String(error.message), rollbackError });
    } finally {
      this.controllers.delete(controller);
      this.applying = null;
    }
  }

  _packet(id) {
    if (!HASH.test(id || '')) throw new Error('invalid_packet_id');
    const bytes = fs.readFileSync(this._file(this.relayRoot, `packets/${id}.json`));
    if (bytes.length > MAX_BYTES || digest(bytes) !== id) throw new Error('packet_hash_mismatch');
    const p = JSON.parse(bytes);
    if (p.schemaVersion !== 1 || p.projectId !== 'only-chat' || !DEVICE.test(p.authorDeviceId || '') || !Array.isArray(p.files) || !p.files.length || p.files.length > 32 || !Array.isArray(p.requiredCapabilities) || p.requiredCapabilities.some(x => typeof x !== 'string' || x.length > 80)) throw new Error('packet_contract_mismatch');
    text(p.summary, 600); text(p.task, 2000);
    const seen = new Set();
    for (const f of p.files) {
      relative(f.path); platforms(f.platforms);
      if (seen.has(f.path) || !HASH.test(f.newHash || '') || f.baseHash !== null && !HASH.test(f.baseHash || '') || !['hot-reload', 'restart', 'needs-agent'].includes(f.applyMode) || f.applyMode === 'hot-reload' && !COMMON.test(f.path)) throw new Error('packet_file_contract_mismatch');
      seen.add(f.path);
    }
    return p;
  }

  _receipt(id, state, extra = {}) {
    const value = { schemaVersion: 1, packetId: id, deviceId: this.deviceId, state, updatedAt: new Date().toISOString(), ...extra };
    this._atomic(this._file(this.relayRoot, `receipts/${this.deviceId}/${id}.json`, true), Buffer.from(JSON.stringify(value)));
    return value;
  }
  _readReceipt(id) {
    const file = this._file(this.relayRoot, `receipts/${this.deviceId}/${id}.json`);
    if (!fs.existsSync(file)) return null;
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (receipt.packetId !== id || receipt.deviceId !== this.deviceId) throw new Error('receipt_identity_mismatch');
    return receipt;
  }
  _readAck(id, packet) {
    const file = this._file(this.relayRoot, `acks/${this.deviceId}/${id}.json`);
    if (!fs.existsSync(file)) return null;
    const ack = JSON.parse(fs.readFileSync(file, 'utf8'));
    const selected = packet.files.filter(item => item.platforms.includes(this.platform));
    if (ack.packetId !== id || ack.deviceId !== this.deviceId || ack.state !== 'runtime-applied' ||
        !ack.loadedHashes || Object.keys(ack.loadedHashes).length !== selected.length ||
        selected.some(item => ack.loadedHashes[item.path] !== item.newHash)) throw new Error('runtime_ack_invalid');
    return ack;
  }
  _active() { if (!this.enabled) throw new Error('relay_stopped'); }
  _current(token) { return this.enabled && this.epoch === token; }
  _ensureRoot(root, create) {
    if (!fs.existsSync(root) && create) fs.mkdirSync(root, { recursive: true });
    if (!fs.statSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error('unsafe_root');
  }
  _file(root, relativePath, createParents = false) {
    if (!relativePath || relativePath.includes('\\') || relativePath.split('/').some(x => !x || x === '.' || x === '..') || path.isAbsolute(relativePath) || /[\x00-\x1f:]/.test(relativePath)) throw new Error('unsafe_path');
    if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error('symlink_rejected');
    const parts = relativePath.split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      if (fs.existsSync(current)) {
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error('symlink_rejected');
      } else if (i < parts.length - 1 && createParents) fs.mkdirSync(current);
    }
    return current;
  }
  _atomic(file, bytes) {
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  _immutable(file, bytes) {
    if (fs.existsSync(file)) { if (digest(fs.readFileSync(file)) !== digest(bytes)) throw new Error('immutable_content_conflict'); return; }
    this._atomic(file, bytes);
  }
}

module.exports = { EvolutionRelay, EVOLUTION_RELAY_VERSION: 1 };
