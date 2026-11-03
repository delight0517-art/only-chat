'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SETTINGS = new Set(['theme', 'font', 'layout', 'providerPriority', 'modelPreferences']);
const TASK_TYPES = new Set(['reminder', 'qa-check', 'agent-task']);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
function validRrule(text) {
  if (typeof text !== 'string' || text.length > 512 || !text.startsWith('RRULE:')) return false;
  const seen = new Set(), allowed = new Set(['FREQ','INTERVAL','BYDAY','BYMONTHDAY','BYMONTH','BYSETPOS','BYSECOND','BYMINUTE','BYHOUR']);
  const ranges = { BYSECOND:[0,59], BYMINUTE:[0,59], BYHOUR:[0,23], BYMONTH:[1,12], BYMONTHDAY:[-31,31], BYSETPOS:[-366,366] };
  for (const part of text.slice(6).split(';')) {
    const [key, value, extra] = part.split('=');
    if (!key || !value || extra !== undefined || seen.has(key) || !allowed.has(key)) return false;
    seen.add(key);
    if (key === 'FREQ' && !['MINUTELY','HOURLY','DAILY','WEEKLY','MONTHLY','YEARLY'].includes(value)) return false;
    if (key === 'INTERVAL' && !/^[1-9]\d{0,6}$/.test(value)) return false;
    if (key === 'BYDAY' && !value.split(',').every(v => /^(?:[+-]?[1-5])?(?:MO|TU|WE|TH|FR|SA|SU)$/.test(v))) return false;
    if (ranges[key] && !value.split(',').every(v => {
      const n = Number(v);
      return /^[-+]?\d{1,3}$/.test(v) && n >= ranges[key][0] && n <= ranges[key][1] && !(key === 'BYMONTHDAY' && n === 0);
    })) return false;
  }
  return seen.has('FREQ') && !seen.has('COUNT') && !seen.has('UNTIL');
}
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` :
  value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}` : JSON.stringify(value);
const digest = value => crypto.createHash('sha256').update(stable(value)).digest('hex');

function safe(value, depth = 0) {
  if (depth > 8) throw new Error('Shared value is too deeply nested.');
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'string') {
    if (value.length > 4096 || /^(?:[a-z]+:)?[\\/]|^[a-z]:[\\/]|~[\\/]/i.test(value) || /\$\(|`|\b(?:powershell|cmd\.exe|bash|sh)\b|Bearer\s|sk-[a-z0-9]{12}/i.test(value)) throw new Error('Unsafe shared value.');
    return value;
  }
  if (Array.isArray(value) && value.length <= 100) return value.map(v => safe(v, depth + 1));
  if (value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length <= 50) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || /credential|token|secret|password|cookie|authorization|api.?key|command|script|exec|path|file/i.test(key)) throw new Error('Forbidden shared field.');
      out[key] = safe(item, depth + 1);
    }
    return out;
  }
  throw new Error('Shared value must be bounded JSON.');
}

function normalize(payload) {
  if (!payload || Object.getPrototypeOf(payload) !== Object.prototype || Object.keys(payload).some(k => !['settings', 'schedules'].includes(k))) throw new Error('Invalid shared payload.');
  const settings = safe(payload.settings || {});
  if (Object.keys(settings).some(k => !SETTINGS.has(k))) throw new Error('Unsupported shared setting.');
  const schedules = payload.schedules || [];
  if (!Array.isArray(schedules) || schedules.length > 100) throw new Error('Invalid shared schedules.');
  const ids = new Set();
  const normalizedSchedules = schedules.map(item => {
    if (!item || Object.getPrototypeOf(item) !== Object.prototype || Object.keys(item).some(k => !['id','timezone','rrule','taskType','enabled','metadata'].includes(k)) || !ID.test(item.id || '') || ids.has(item.id)) throw new Error('Invalid shared schedule identity.');
    ids.add(item.id);
    try { new Intl.DateTimeFormat('en', { timeZone: item.timezone }).format(); } catch { throw new Error('Invalid schedule timezone.'); }
    if (!validRrule(item.rrule) || !TASK_TYPES.has(item.taskType) || (item.enabled !== undefined && typeof item.enabled !== 'boolean')) throw new Error('Unsupported declarative schedule.');
    return safe({ id: item.id, timezone: item.timezone, rrule: item.rrule, taskType: item.taskType, enabled: item.enabled !== false, metadata: item.metadata || {} });
  }).sort((a, b) => a.id.localeCompare(b.id));
  const result = { settings, schedules: normalizedSchedules };
  if (Buffer.byteLength(stable(result)) > 65536) throw new Error('Shared payload is too large.');
  return result;
}

class SharedStateReplica {
  constructor({ relayDir, stateDir, deviceId, platform }) {
    if (!ID.test(deviceId || '') || !['win32', 'darwin'].includes(platform)) throw new Error('Invalid device identity.');
    this.relayDir = path.resolve(relayDir);
    this.stateDir = path.resolve(stateDir);
    this.deviceId = deviceId;
    this.platform = platform;
    this.stopped = false;
    this.inflight = null;
    this.controller = null;
  }
  _file(root, relative, create = false) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe shared-state path.');
    if (create) fs.mkdirSync(root, { recursive: true });
    if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error('Shared-state root symlink refused.');
    let current = root;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Shared-state symlink refused.');
    }
    if (create) fs.mkdirSync(path.dirname(current), { recursive: true });
    return current;
  }
  _records() {
    const dir = this._file(this.relayDir, 'shared-state/records');
    if (!fs.existsSync(dir)) return [];
    const records = fs.readdirSync(dir).filter(n => /^\d+-[a-f0-9]{64}\.json$/.test(n)).sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]));
    if (records.length > 10000) throw new Error('Shared-state history exceeds limit.');
    return records;
  }
  inspect() {
    const files = this._records();
    if (!files.length) return { schemaVersion: 1, revision: 0, parentHash: null, settings: {}, schedules: [], hash: digest({ schemaVersion: 1, revision: 0, parentHash: null, settings: {}, schedules: [] }) };
    let parentHash = null, latest;
    files.forEach((name, index) => {
      const file = this._file(this.relayDir, `shared-state/records/${name}`);
      if (fs.statSync(file).size > 65536) throw new Error('Shared-state record exceeds limit.');
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      const { hash, ...body } = record;
      if (record.schemaVersion !== 1 || record.revision !== index + 1 || record.parentHash !== parentHash || digest(body) !== hash || name !== `${record.revision}-${hash}.json`) throw new Error('Shared-state history is incomplete or conflicting.');
      normalize({ settings: record.settings, schedules: record.schedules });
      parentHash = hash; latest = record;
    });
    return latest;
  }
  publish(payload, expectedRevision) {
    if (this.stopped) throw new Error('Replica is stopped.');
    const current = this.inspect();
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new Error('Shared-state revision conflict.');
    const normalized = normalize(payload);
    const body = { schemaVersion: 1, revision: current.revision + 1, parentHash: current.revision ? current.hash : null, ...normalized };
    const hash = digest(body), record = { ...body, hash };
    const file = this._file(this.relayDir, `shared-state/records/${body.revision}-${hash}.json`, true);
    const lock = this._file(this.relayDir, 'shared-state/publish.lock', true);
    let fd, ownsLock = false;
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
      ownsLock = true;
      const temp = `${file}.${crypto.randomUUID()}.tmp`;
      try { fs.writeFileSync(temp, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
      finally { try { fs.unlinkSync(temp); } catch {} }
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('Shared-state publish lock exists; recover it explicitly.');
      throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); if (ownsLock) { try { fs.unlinkSync(lock); } catch {} } }
    return record;
  }
  status() {
    if (this.stopped) return { state: 'stopped', ack: null, crossPlatformApplied: false };
    try {
      const desired = this.inspect(), ackPath = this._file(this.stateDir, `shared-state/acks/${this.deviceId}.json`);
      const ack = fs.existsSync(ackPath) ? JSON.parse(fs.readFileSync(ackPath, 'utf8')) : null;
      const ackDir = this._file(this.relayDir, 'shared-state/acks');
      const peers = fs.existsSync(ackDir) ? fs.readdirSync(ackDir).filter(n => ID.test(n.replace(/\.json$/, '')) && n.endsWith('.json')).map(n => JSON.parse(fs.readFileSync(this._file(this.relayDir, `shared-state/acks/${n}`), 'utf8'))) : [];
      const otherPlatform = this.platform === 'darwin' ? 'win32' : 'darwin';
      return { state: ack?.hash === desired.hash ? 'applied' : 'pending', ack, crossPlatformApplied: ack?.hash === desired.hash && peers.some(peer => peer.deviceId !== this.deviceId && peer.platform === otherPlatform && peer.hash === desired.hash) };
    } catch (error) { return { state: 'pending', reason: error.message, ack: null, crossPlatformApplied: false }; }
  }
  async apply(adapter, { getBlockers = () => [] } = {}) {
    if (this.stopped) return { ok: false, state: 'stopped' };
    if (this.inflight) return this.inflight;
    this.inflight = this._apply(adapter, getBlockers).finally(() => { this.inflight = null; });
    return this.inflight;
  }
  async _apply(adapter, getBlockers) {
    const desired = this.inspect(), supported = adapter.capabilities || {};
    if (Object.keys(desired.settings).some(k => !supported.settings?.includes(k)) || desired.schedules.some(s => !supported.taskTypes?.includes(s.taskType))) return { ok: false, state: 'pending', reason: 'unsupported-capability' };
    const blockers = getBlockers();
    if (this.stopped || blockers.length) return { ok: false, state: this.stopped ? 'stopped' : 'pending', reason: blockers[0] || null };
    const controller = this.controller = new AbortController();
    try {
      await adapter.apply({ settings: desired.settings, schedules: desired.schedules }, { signal: controller.signal });
      if (this.stopped || getBlockers().length) return { ok: false, state: this.stopped ? 'stopped' : 'pending', reason: 'blocked-after-apply' };
      const actual = normalize(await adapter.read());
      if (digest(actual) !== digest({ settings: desired.settings, schedules: desired.schedules })) return { ok: false, state: 'pending', reason: 'readback-mismatch' };
      if (this.inspect().hash !== desired.hash) return { ok: false, state: 'pending', reason: 'desired-state-changed' };
      const ack = { deviceId: this.deviceId, platform: this.platform, revision: desired.revision, hash: desired.hash };
      const local = this._file(this.stateDir, `shared-state/acks/${this.deviceId}.json`, true);
      const relay = this._file(this.relayDir, `shared-state/acks/${this.deviceId}.json`, true);
      for (const file of [local, relay]) { const temp = `${file}.${crypto.randomUUID()}.tmp`; try { fs.writeFileSync(temp, JSON.stringify(ack), { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); } finally { try { fs.unlinkSync(temp); } catch {} } }
      return { ok: true, state: 'applied', ack };
    } catch (error) { return { ok: false, state: this.stopped ? 'stopped' : 'pending', reason: error.message }; }
    finally { if (this.controller === controller) this.controller = null; }
  }
  stop() { this.stopped = true; this.controller?.abort(); }
}

module.exports = { SharedStateReplica };
