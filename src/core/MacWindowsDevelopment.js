'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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
    if (clean.startsWith('/') || clean.includes('\\') || /^[a-z]:/i.test(clean)) throw new TypeError('paths must be safe repository-relative paths');
    const parts = clean.split('/').filter(part => part && part !== '.');
    if (!parts.length || parts.includes('..')) throw new TypeError('paths must identify a repository-relative file or directory');
    const normalized = parts.join('/');
    if (/(^|\/)(?:\.env(?:\..*)?|secrets?(?:\.[^/]*)?|credentials?(?:\.[^/]*)?)(?:\/|$)/i.test(normalized) || /\.(?:pem|key|p12|pfx)$/i.test(normalized)) {
      throw new TypeError('credential and private-key paths cannot be shared');
    }
    return normalized;
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
    return { owner: text(side.owner, `${name}.owner`, 160), source: text(side.source, `${name}.source`, 1000), baseCommit, paths: paths(side.paths), state: 'planned', packet: null, patch: null, evidence: [] };
}

class MacWindowsDevelopment {
  constructor(options = {}) {
    if (!options.dataDir) throw new TypeError('dataDir is required');
    this.dir = path.join(path.resolve(options.dataDir), 'mac-windows-development');
    this.file = path.join(this.dir, 'tasks.json');
    this.platform = options.platform || process.platform;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  localPlatform() { return this.platform === 'win32' ? 'windows' : 'mac'; }

  _git(source, args, input) {
    return execFileSync('git', args, { cwd: source, encoding: 'utf8', input, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  createPatch(taskKey, platform = this.localPlatform()) {
    if (!PLATFORMS.includes(platform) || platform !== this.localPlatform()) throw new Error('Only this device may export its assigned source changes');
    const task = this.get(taskKey);
    if (!task) throw new Error('joint development task not found');
    const side = task[platform];
    if (side.state !== 'active') throw new Error('mark this platform active before exporting its source patch');
    const source = fs.realpathSync(side.source);
    const root = this._git(source, ['rev-parse', '--show-toplevel']).trim();
    if (fs.realpathSync(root) !== source) throw new Error('assigned source path must be the canonical Git repository root');
    if (this._git(source, ['branch', '--show-current']).trim() !== 'main') throw new Error('joint development exports are allowed only from canonical main');
    const head = this._git(source, ['rev-parse', 'HEAD']).trim().toLowerCase();
    if (head !== side.baseCommit) throw new Error('source HEAD differs from the recorded base commit; reconcile and create a new contract');
    const args = ['--', ...side.paths];
    const status = this._git(source, ['status', '--porcelain=v1', '-z', ...args]);
    const entries = status.split('\0').filter(Boolean);
    if (entries.some(entry => entry.startsWith('??'))) throw new Error('review and stage new owned files on canonical main before patch export');
    const filePaths = this._git(source, ['diff', '--name-only', '-z', '--no-renames', side.baseCommit, ...args]).split('\0').filter(Boolean);
    if (!filePaths.length) throw new Error('there are no owned source changes to export');
    const allowed = filePaths.every(file => side.paths.some(owned => file === owned || file.startsWith(`${owned}/`)));
    if (!allowed) throw new Error('Git reported a changed file outside the declared ownership paths');
    const patch = this._git(source, ['diff', '--binary', '--no-renames', side.baseCommit, ...args]);
    if (!patch || Buffer.byteLength(patch, 'utf8') > 400 * 1024) throw new Error('source patch is empty or exceeds the 400 KiB safety limit');
    const headAfter = this._git(source, ['rev-parse', 'HEAD']).trim().toLowerCase();
    const statusAfter = this._git(source, ['status', '--porcelain=v1', '-z', ...args]);
    if (headAfter !== head || statusAfter !== status) throw new Error('source changed while preparing the patch; retry after the current editor/build settles');
    const patchSha256 = crypto.createHash('sha256').update(patch).digest('hex');
    const readySide = { ...task[platform], state: 'ready-to-share', evidence: [...task[platform].evidence,
      { text: `Source patch prepared · SHA-256 ${patchSha256}`, at: new Date().toISOString() }] };
    const contract = { title: task.title, app: task.app, goal: task.goal, integrationBase: task.integrationBase, policy: task.policy,
      mac: platform === 'mac' ? readySide : task.mac, windows: platform === 'windows' ? readySide : task.windows };
    return { schema: 'only-chat-joint-development/patch-v1', taskKey, platform, baseCommit: head, filePaths, patch, patchSha256, contract, exportedAt: new Date().toISOString() };
  }

  receivePatch(packet, fileId, payloadSha256) {
    if (!packet || packet.schema !== 'only-chat-joint-development/patch-v1' || !PLATFORMS.includes(packet.platform)) throw new TypeError('unsupported source patch packet');
    if (packet.platform === this.localPlatform()) throw new Error('received patch must come from the other platform');
    const normalizedPaths = paths(packet.filePaths);
    if (JSON.stringify(normalizedPaths) !== JSON.stringify([...packet.filePaths].sort())) throw new Error('patch file list is not normalized');
    const patchHash = crypto.createHash('sha256').update(packet.patch || '').digest('hex');
    if (patchHash !== packet.patchSha256 || !/^[a-f0-9]{64}$/i.test(payloadSha256 || '')) throw new Error('source patch checksum validation failed');
    const contractPacket = { schema: 'only-chat-joint-development/v1', taskKey: packet.taskKey, ...packet.contract };
    const existing = this.get(packet.taskKey);
    if (!existing) this.importPacket(contractPacket, fileId, payloadSha256);
    const state = this._read(); const task = state.tasks.find(item => item.taskKey === packet.taskKey);
    const sender = task[packet.platform];
    if (packet.baseCommit !== sender.baseCommit || packet.filePaths.some(file => !sender.paths.some(owned => file === owned || file.startsWith(`${owned}/`)))) throw new Error('patch base or file list is outside the sender contract');
    if (JSON.stringify(contractPacket.mac.paths) !== JSON.stringify(task.mac.paths) || JSON.stringify(contractPacket.windows.paths) !== JSON.stringify(task.windows.paths)
      || contractPacket.integrationBase !== task.integrationBase) throw new Error('patch contract conflicts with the registered task');
    task.incomingPatches ||= [];
    if (!task.incomingPatches.some(item => item.fileId === fileId)) {
      task.incomingPatches.push({ fileId, sender: packet.platform, baseCommit: packet.baseCommit, filePaths: normalizedPaths,
        patch: packet.patch, patchSha256: packet.patchSha256, packetSha256: payloadSha256,
        state: 'receiver-read', receivedAt: new Date().toISOString() });
      const local = task[this.localPlatform()];
      if (local.state === 'planned') local.state = 'receiver-read';
      local.evidence.push({ text: `Received source patch file ${fileId} · SHA-256 ${packet.patchSha256}`, at: new Date().toISOString() });
      task.revision += 1; task.updatedAt = new Date().toISOString(); this._write(state);
    }
    return this.get(packet.taskKey);
  }

  recordPatch(taskKey, platform, metadata) {
    if (!PLATFORMS.includes(platform)) throw new TypeError('platform must be mac or windows');
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(metadata.fileId || '') || !/^[a-f0-9]{64}$/i.test(metadata.patchSha256 || '')
      || !/^[a-f0-9]{64}$/i.test(metadata.payloadSha256 || '') || !Array.isArray(metadata.filePaths)) throw new TypeError('source patch metadata is invalid');
    const state = this._read(); const task = state.tasks.find(item => item.taskKey === taskKey);
    if (!task) return null;
    const side = task[platform];
    if (side.patch?.fileId && side.patch.fileId !== metadata.fileId) throw new Error('this task already has an immutable source patch; create a new joint task for later changes');
    side.patch = { fileId: metadata.fileId, patchSha256: metadata.patchSha256.toLowerCase(), payloadSha256: metadata.payloadSha256.toLowerCase(),
      filePaths: paths(metadata.filePaths), readback: metadata.readback === true ? 'verified' : (metadata.readback === false ? 'mismatch' : 'not-checked') };
    if (metadata.readback === true && side.state === 'active') {
      side.state = 'ready-to-share';
      side.evidence.push({ text: `Drive patch readback verified · SHA-256 ${side.patch.patchSha256}`, at: new Date().toISOString() });
    }
    task.revision += 1; task.updatedAt = new Date().toISOString(); this._write(state); return task;
  }

  applyPatch(taskKey, fileId) {
    const task = this.get(taskKey);
    if (!task) throw new Error('joint development task not found');
    const patch = (task.incomingPatches || []).find(item => item.fileId === fileId);
    if (!patch) throw new Error('receiver has not read this patch packet');
    if (patch.state !== 'receiver-read') throw new Error(`patch cannot be applied from state ${patch.state}`);
    const source = fs.realpathSync(task[this.localPlatform()].source);
    if (fs.realpathSync(this._git(source, ['rev-parse', '--show-toplevel']).trim()) !== source) throw new Error('local source is not the canonical Git repository root');
    if (this._git(source, ['branch', '--show-current']).trim() !== 'main') throw new Error('patch application is allowed only on canonical main');
    if (this._git(source, ['rev-parse', 'HEAD']).trim().toLowerCase() !== patch.baseCommit) throw new Error('local source base differs from packet base; preserve changes and reconcile first');
    const conflictStatus = this._git(source, ['status', '--porcelain=v1', '-z', '--', ...patch.filePaths]);
    if (conflictStatus) throw new Error('local changes overlap the patch files; preserve them and resolve ownership before apply');
    const numstat = this._git(source, ['apply', '--numstat', '-z', '-'], patch.patch).split('\0').filter(Boolean);
    const appliedFiles = numstat.map(entry => entry.slice(entry.indexOf('\t', entry.indexOf('\t') + 1) + 1));
    if (JSON.stringify([...appliedFiles].sort()) !== JSON.stringify([...patch.filePaths].sort())) throw new Error('patch content paths differ from its allowlisted file list');
    this._git(source, ['apply', '--check', '--binary', '-'], patch.patch);
    this._git(source, ['apply', '--binary', '-'], patch.patch);
    const state = this._read(); const current = state.tasks.find(item => item.taskKey === taskKey);
    const saved = current.incomingPatches.find(item => item.fileId === fileId);
    saved.state = 'applied'; saved.appliedAt = new Date().toISOString();
    const local = current[this.localPlatform()];
    if (local.state === 'receiver-read') {
      local.state = 'applied';
      local.evidence.push({ text: `Applied scoped patch ${fileId} on canonical main; source changes remain uncommitted for review`, at: new Date().toISOString() });
    }
    current.revision += 1; current.updatedAt = new Date().toISOString(); this._write(state);
    return current;
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
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized, 'utf8') > 8 * 1024 * 1024) throw new Error('joint development store reached its 8 MiB safety limit');
    let fd;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
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
    if (mac.baseCommit !== task.integrationBase || windows.baseCommit !== task.integrationBase) throw new Error('both devices must start from the same canonical integration commit before parallel work');
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

  list(limit = 100) {
    return this._read().tasks.slice(0, Math.min(Math.max(Number(limit) || 100, 1), 200)).map(task => ({
      ...task, incomingPatches: (task.incomingPatches || []).map(({ patch, ...metadata }) => metadata)
    }));
  }

  get(taskKey) { return this._read().tasks.find(task => task.taskKey === taskKey) || null; }

  readIncomingPatch(taskKey, fileId) {
    const task = this.get(taskKey);
    return task?.incomingPatches?.find(item => item.fileId === fileId) || null;
  }

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
    if (update.state === 'drive-readback' && task.drive.readback !== 'verified' && side.patch?.readback !== 'verified') throw new Error('Drive readback must be verified before recording the receiver stage');
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
