'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PLATFORMS = ['mac', 'windows'];
const SIDE_STATES = new Set(['planned', 'active', 'ready-to-share', 'drive-readback', 'receiver-read', 'applied', 'tested', 'integrated', 'blocked']);
const NEXT_SIDE_STATE = new Map([
  ['planned', 'active'], ['active', 'ready-to-share'], ['ready-to-share', 'drive-readback'],
  ['drive-readback', 'receiver-read'], ['receiver-read', 'applied'], ['applied', 'tested'], ['tested', 'integrated']
]);
const SAFE_KEY = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

function text(value, name, max = 240) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${name} is invalid`);
  return value.trim();
}

function paths(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new TypeError('each platform needs 1–100 owned paths');
  const result = [...new Set(value.map(item => {
    const clean = text(item, 'path', 500);
    if (clean.startsWith('/') || clean.includes('\\') || /^[a-z]:/i.test(clean) || clean.split('/').includes('..')) throw new TypeError('paths must be safe repository-relative paths');
    return clean.replace(/^\.\//, '');
  }))].sort();
  return result;
}

function overlaps(a, b) {
  const key = value => value.normalize('NFD').toLowerCase();
  return a.some(left => b.some(right => {
    const l = key(left), r = key(right);
    return l === r || l.startsWith(`${r}/`) || r.startsWith(`${l}/`);
  }));
}

function normalizeSide(side, name) {
  if (!side || typeof side !== 'object') throw new TypeError(`${name} assignment is required`);
  const baseCommit = text(side.baseCommit, `${name}.baseCommit`, 64).toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit)) throw new TypeError(`${name}.baseCommit must be a Git commit hash`);
  return { owner: text(side.owner, `${name}.owner`, 160), source: text(side.source, `${name}.source`, 1000), baseCommit, paths: paths(side.paths), state: 'planned', packet: null, evidence: [] };
}

class MacWindowsDevelopment {
  constructor(options = {}) {
    if (!options.dataDir) throw new TypeError('dataDir is required');
    this.dir = path.join(path.resolve(options.dataDir), 'mac-windows-development');
    this.file = path.join(this.dir, 'tasks.json');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  _read() {
    try {
      const info = fs.lstatSync(this.file);
      if (info.isSymbolicLink() || !info.isFile() || info.size > 8 * 1024 * 1024) throw new Error('joint development store is unsafe');
      const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.tasks)) throw new Error('joint development store schema is invalid');
      return state;
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, tasks: [] }; throw error; }
  }

  _write(state) {
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    let fd;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(tmp, this.file);
    } catch (error) { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(tmp); } catch (_) {} throw error; }
  }

  create(input = {}) {
    const taskKey = text(input.taskKey, 'taskKey', 80);
    if (!SAFE_KEY.test(taskKey)) throw new TypeError('taskKey is invalid');
    const mac = normalizeSide(input.mac, 'mac');
    const windows = normalizeSide(input.windows, 'windows');
    if (overlaps(mac.paths, windows.paths)) throw new Error('Mac and Windows file ownership overlaps; split the paths before parallel work');
    const task = {
      taskKey, title: text(input.title, 'title', 160), app: text(input.app, 'app', 120),
      goal: text(input.goal, 'goal', 2000), integrationBase: text(input.integrationBase, 'integrationBase', 64).toLowerCase(),
      policy: 'canonical-main-no-branches', mac, windows,
      drive: { state: 'not-published', fileId: null, sha256: null, readback: 'not-checked', direction: 'sent', receiverRead: 'not-checked' },
      integration: { state: 'not-started', commit: null, evidence: [] }, revision: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(task.integrationBase)) throw new TypeError('integrationBase must be a Git commit hash');
    const state = this._read();
    const existing = state.tasks.find(item => item.taskKey === taskKey);
    if (existing) {
      const signature = item => JSON.stringify({ title: item.title, app: item.app, goal: item.goal, integrationBase: item.integrationBase,
        mac: { owner: item.mac.owner, source: item.mac.source, baseCommit: item.mac.baseCommit, paths: item.mac.paths },
        windows: { owner: item.windows.owner, source: item.windows.source, baseCommit: item.windows.baseCommit, paths: item.windows.paths } });
      if (signature(existing) !== signature(task)) throw new Error('task key already exists with a different contract');
      return { created: false, task: existing };
    }
    state.tasks.unshift(task); this._write(state); return { created: true, task };
  }

  list(limit = 100) { return this._read().tasks.slice(0, Math.min(Math.max(Number(limit) || 100, 1), 200)); }

  get(taskKey) { return this._read().tasks.find(task => task.taskKey === taskKey) || null; }

  updateSide(taskKey, platform, update = {}) {
    if (!PLATFORMS.includes(platform)) throw new TypeError('platform must be mac or windows');
    const state = this._read(); const task = state.tasks.find(item => item.taskKey === taskKey);
    if (!task) return null;
    if (!SIDE_STATES.has(update.state)) throw new TypeError('invalid side state');
    const side = task[platform];
    if (update.baseCommit && update.baseCommit.toLowerCase() !== side.baseCommit) throw new Error('base commit changed; create a new task contract after reconciling the source');
    const priorState = side.state === 'blocked' ? side.blockedFrom : side.state;
    if (update.state !== 'blocked' && update.state !== side.state && update.state !== priorState && NEXT_SIDE_STATE.get(priorState) !== update.state) throw new Error('joint development stage must advance one verified step at a time');
    if (['ready-to-share', 'receiver-read', 'applied', 'tested'].includes(update.state) && !update.evidence) throw new Error(`${update.state} requires a specific evidence reference`);
    if (update.state === 'drive-readback' && task.drive.readback !== 'verified') throw new Error('Drive readback must be verified before recording the receiver stage');
    if (update.state === 'integrated') {
      if (task.mac.state !== 'tested' && task.mac.state !== 'integrated') throw new Error('Mac test evidence is required before integration');
      if (task.windows.state !== 'tested' && task.windows.state !== 'integrated') throw new Error('Windows test evidence is required before integration');
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(update.commit || '')) throw new Error('integrated state requires the canonical main commit hash');
      task.integration = { state: 'integrated', commit: update.commit.toLowerCase(), evidence: [text(update.evidence, 'integration evidence', 1000)] };
    }
    if (update.packet) {
      const packet = update.packet;
      if (!/^[a-f0-9]{64}$/i.test(packet.sha256 || '') || !/^[a-zA-Z0-9_-]{1,256}$/.test(packet.fileId || '')) throw new TypeError('packet metadata is invalid');
      side.packet = { fileId: packet.fileId, sha256: packet.sha256.toLowerCase(), readback: packet.readback === true ? 'verified' : 'not-checked' };
    }
    if (update.state === 'blocked' && side.state !== 'blocked') side.blockedFrom = side.state;
    if (side.state === 'blocked' && update.state !== 'blocked') side.blockedFrom = null;
    side.state = update.state;
    if (update.evidence) side.evidence.push({ text: text(update.evidence, 'evidence', 1000), at: new Date().toISOString() });
    task.revision += 1; task.updatedAt = new Date().toISOString(); this._write(state); return task;
  }

  recordPublished(taskKey, packet) {
    const state = this._read(); const task = state.tasks.find(item => item.taskKey === taskKey);
    if (!task) return null;
    if (!/^[a-f0-9]{64}$/i.test(packet.sha256 || '') || !/^[a-zA-Z0-9_-]{1,256}$/.test(packet.fileId || '')) throw new TypeError('Drive packet metadata is invalid');
    task.drive = { state: packet.readback ? 'readback-verified' : 'uploaded', fileId: packet.fileId, sha256: packet.sha256.toLowerCase(), readback: packet.readback ? 'verified' : (packet.readback === false ? 'mismatch' : 'not-checked') };
    task.revision += 1; task.updatedAt = new Date().toISOString(); this._write(state); return task;
  }

  importPacket(packet, fileId, sha256) {
    if (!packet || packet.schema !== 'only-chat-joint-development/v1') throw new TypeError('unsupported joint development packet');
    const result = this.create(packet);
    const task = this.recordPublished(packet.taskKey, { fileId, sha256, readback: true });
    task.drive.direction = 'received';
    task.drive.receiverRead = 'verified';
    const state = this._read(); const index = state.tasks.findIndex(item => item.taskKey === task.taskKey);
    state.tasks[index] = task; this._write(state);
    return task;
  }
}

module.exports = { MacWindowsDevelopment, overlaps };
