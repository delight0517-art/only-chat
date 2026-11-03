'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { WorkspaceExecutionLease } = require('./WorkspaceExecutionLease.js');

const SCHEMA_VERSION = 1;
const MAX_STORE_BYTES = 16 * 1024 * 1024;
const MAX_TASKS = 10_000;
const MAX_IDEMPOTENCY_RECORDS = 50_000;
const MIN_LEASE_MS = 30_000;
const MAX_LEASE_MS = 15 * 60_000;
const DEFAULT_LEASE_MS = 2 * 60_000;
const TASK_KEY = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const TASK_STATUSES = new Set(['planned', 'claimed', 'executing', 'verifying', 'integrating', 'reviewing', 'blocked', 'completed', 'failed']);
const ACTIVE_STATUSES = new Set(['claimed', 'executing', 'verifying', 'integrating', 'reviewing']);
const STATUS_TRANSITIONS = new Map([
  ['planned', new Set(['claimed', 'blocked', 'failed'])],
  ['claimed', new Set(['executing', 'blocked', 'failed'])],
  ['executing', new Set(['verifying', 'blocked', 'failed'])],
  ['verifying', new Set(['integrating', 'reviewing', 'blocked', 'failed'])],
  ['integrating', new Set(['reviewing', 'blocked', 'failed'])],
  ['reviewing', new Set(['completed', 'blocked', 'failed'])],
  ['blocked', new Set(['claimed', 'failed'])],
  ['failed', new Set()],
  ['completed', new Set()]
]);

function printableString(value, name, maxLength, required = true) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`${name} must be ${required ? 'non-empty and ' : ''}at most ${maxLength} printable characters`);
  }
  return normalized;
}

function normalizeRepositoryPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError('repositoryPath must be an absolute path');
  let resolved;
  try { resolved = fs.realpathSync(path.resolve(value)); }
  catch (_) { throw new TypeError('repositoryPath must identify an existing directory'); }
  let stat;
  try { stat = fs.statSync(resolved); }
  catch (_) { throw new TypeError('repositoryPath must identify an existing directory'); }
  if (!stat.isDirectory()) throw new TypeError('repositoryPath must identify an existing directory');
  return resolved;
}

function pathKey(value) {
  return process.platform === 'darwin' || process.platform === 'win32'
    ? value.normalize('NFD').toLowerCase() : value;
}

function normalizePaths(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new TypeError('paths must contain 1–100 repository-relative paths');
  }
  const normalized = value.map(raw => {
    if (typeof raw !== 'string' || !raw.trim() || raw.includes('\\') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || raw.includes('\0')) {
      throw new TypeError('paths must use repository-relative POSIX paths');
    }
    const parts = raw.split('/').filter(part => part && part !== '.');
    if (parts.includes('..')) throw new TypeError('paths cannot escape the repository');
    return parts.length ? parts.join('/') : '.';
  });
  if (normalized.includes('.')) return ['.'];
  const unique = new Map(normalized.map(item => [pathKey(item), item]));
  const paths = [...unique.values()].sort((a, b) => pathKey(a).localeCompare(pathKey(b)));
  return paths.filter(candidate => !paths.some(other => candidate !== other && pathKey(candidate).startsWith(`${pathKey(other)}/`)));
}

function pathsOverlap(left, right) {
  return left.some(a => right.some(b => {
    if (a === '.' || b === '.') return true;
    const ak = pathKey(a), bk = pathKey(b);
    return ak === bk || ak.startsWith(`${bk}/`) || bk.startsWith(`${ak}/`);
  }));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function operationHash(operation, input) {
  return crypto.createHash('sha256').update(`${operation}\0${JSON.stringify(input)}`).digest('hex');
}

class TaskRegistryStore {
  constructor(options = {}) {
    if (!options.dataDir) throw new TypeError('dataDir is required');
    this.dataDir = path.resolve(options.dataDir);
    this.storeDir = path.join(this.dataDir, 'task-registry');
    this.filePath = path.join(this.storeDir, 'index.json');
    this.clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
    this.lease = options.lease || new WorkspaceExecutionLease({ lockRoot: path.join(this.dataDir, 'workspace-leases') });
    this.lockWaitMs = Number.isSafeInteger(options.lockWaitMs) ? Math.min(Math.max(options.lockWaitMs, 100), 10_000) : 3_000;
    this._ensureDirectories();
  }

  _ensureDirectories() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const rootStat = fs.lstatSync(this.dataDir);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('task registry data directory is unsafe');
    fs.mkdirSync(this.storeDir, { recursive: true, mode: 0o700 });
    const storeStat = fs.lstatSync(this.storeDir);
    if (storeStat.isSymbolicLink() || !storeStat.isDirectory()) throw new Error('task registry store directory is unsafe');
    fs.chmodSync(this.storeDir, 0o700);
  }

  _emptyState() {
    return { schemaVersion: SCHEMA_VERSION, tasks: [], idempotency: [] };
  }

  _loadState() {
    let document;
    let fd;
    try {
      const before = fs.lstatSync(this.filePath);
      if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_STORE_BYTES) {
        throw new Error('task registry file is unsafe or too large');
      }
      fd = fs.openSync(this.filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_STORE_BYTES) {
        throw new Error('task registry file changed while opening');
      }
      if (process.platform !== 'win32' && (opened.mode & 0o077) !== 0) throw new Error('task registry file permissions are unsafe');
      document = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return this._emptyState();
      throw new Error(`task registry is unreadable: ${error.message}`);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    if (!document || document.schemaVersion !== SCHEMA_VERSION || !Array.isArray(document.tasks)
      || !Array.isArray(document.idempotency) || document.tasks.length > MAX_TASKS
      || document.idempotency.length > MAX_IDEMPOTENCY_RECORDS) {
      throw new Error('unsupported or invalid task registry schema');
    }
    const taskKeys = new Set();
    for (const task of document.tasks) {
      if (!task || typeof task.taskKey !== 'string' || !TASK_KEY.test(task.taskKey)
        || taskKeys.has(task.taskKey) || !TASK_STATUSES.has(task.status)
        || !Number.isSafeInteger(task.revision) || task.revision < 1
        || !Array.isArray(task.paths) || typeof task.repositoryPath !== 'string') {
        throw new Error('invalid task registry record');
      }
      if (ACTIVE_STATUSES.has(task.status) && (typeof task.ownerChatId !== 'string'
        || !task.ownerChatId || typeof task.leaseExpiresAt !== 'string' || !Number.isFinite(Date.parse(task.leaseExpiresAt)))) {
        throw new Error('active task is missing a valid owner lease');
      }
      taskKeys.add(task.taskKey);
    }
    for (const record of document.idempotency) {
      if (!record || typeof record.key !== 'string' || typeof record.requestHash !== 'string' || !record.result) {
        throw new Error('invalid task registry idempotency record');
      }
    }
    return document;
  }

  _saveState(state) {
    const tempPath = path.join(this.storeDir, `.index.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    let fd;
    try {
      fd = fs.openSync(tempPath, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(state), 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tempPath, this.filePath);
      if (process.platform !== 'win32') {
        try {
          const dirFd = fs.openSync(this.storeDir, 'r');
          try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
        } catch (_) { /* The atomic replace is already committed; unsupported directory fsync cannot roll it back. */ }
      }
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(tempPath); } catch (_) {}
      throw error;
    }
  }

  async _withWriteLock(sessionId, operation) {
    const deadline = Date.now() + this.lockWaitMs;
    while (true) {
      let enteredOperation = false;
      try {
        return await this.lease.run(this.storeDir, sessionId, () => {
          enteredOperation = true;
          return operation();
        });
      }
      catch (error) {
        if (enteredOperation) throw error;
        const status = this.lease.getStatus(this.storeDir);
        if (Date.now() >= deadline) throw new Error('task registry lock wait timed out');
        if (status.state === 'unknown' || (status.state === 'held' && status.sameHost !== true)) {
          throw new Error(status.state === 'held' ? 'task registry is busy in another process' : error.message);
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  }

  _idempotencyReplay(state, operation, idempotencyKey, request) {
    const key = `${operation}:${idempotencyKey}`;
    const requestHash = operationHash(operation, request);
    const existing = state.idempotency.find(record => record.key === key);
    if (!existing) return { key, requestHash, result: null };
    if (existing.requestHash !== requestHash) throw new Error('idempotency key was reused with a different request');
    return { key, requestHash, result: clone(existing.result) };
  }

  _remember(state, replay, result) {
    if (state.idempotency.length >= MAX_IDEMPOTENCY_RECORDS) throw new Error('task registry idempotency capacity reached; preserve the store and review retention');
    state.idempotency.push({ key: replay.key, requestHash: replay.requestHash, result: clone(result), createdAt: new Date(this.clock()).toISOString() });
    return result;
  }

  async createTask(input = {}) {
    const normalized = {
      taskKey: printableString(input.taskKey, 'taskKey', 128),
      title: printableString(input.title, 'title', 120),
      creatorChatId: printableString(input.creatorChatId, 'creatorChatId', 256),
      repositoryPath: normalizeRepositoryPath(input.repositoryPath),
      baseSha: printableString(input.baseSha, 'baseSha', 64).toLowerCase(),
      paths: normalizePaths(input.paths),
      nextAction: printableString(input.nextAction || '', 'nextAction', 2000, false),
      idempotencyKey: printableString(input.idempotencyKey, 'idempotencyKey', 160)
    };
    if (!TASK_KEY.test(normalized.taskKey)) throw new TypeError('taskKey must be a stable alphanumeric key');
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(normalized.baseSha)) throw new TypeError('baseSha must be a 40- or 64-character Git object ID');
    const request = { ...normalized };
    delete request.idempotencyKey;
    return this._withWriteLock(`task-registry:create:${normalized.taskKey}`, async () => {
      const state = this._loadState();
      const replay = this._idempotencyReplay(state, 'create', normalized.idempotencyKey, request);
      if (replay.result) return replay.result;
      const existing = state.tasks.find(task => task.taskKey === normalized.taskKey);
      if (existing) {
        const same = existing.title === normalized.title && existing.creatorChatId === normalized.creatorChatId
          && existing.repositoryPath === normalized.repositoryPath && existing.baseSha === normalized.baseSha
          && JSON.stringify(existing.paths) === JSON.stringify(normalized.paths)
          && existing.checkpoint.nextAction === normalized.nextAction;
        if (!same) throw new Error('task key already exists with different source or scope');
        const result = { created: false, task: clone(existing) };
        this._remember(state, replay, result);
        this._saveState(state);
        return result;
      }
      if (state.tasks.length >= MAX_TASKS) throw new Error('task registry capacity reached; preserve the store and review retention');
      const now = new Date(this.clock()).toISOString();
      const task = {
        taskKey: normalized.taskKey,
        title: normalized.title,
        creatorChatId: normalized.creatorChatId,
        repositoryPath: normalized.repositoryPath,
        baseSha: normalized.baseSha,
        paths: normalized.paths,
        status: 'planned',
        ownerChatId: null,
        leaseExpiresAt: null,
        revision: 1,
        checkpoint: { nextAction: normalized.nextAction, blocker: '', evidenceRefs: [] },
        createdAt: now,
        updatedAt: now
      };
      state.tasks.push(task);
      const result = { created: true, task: clone(task) };
      this._remember(state, replay, result);
      this._saveState(state);
      return result;
    });
  }

  async claimTask(input = {}) {
    const normalized = {
      taskKey: printableString(input.taskKey, 'taskKey', 128),
      ownerChatId: printableString(input.ownerChatId, 'ownerChatId', 256),
      idempotencyKey: printableString(input.idempotencyKey, 'idempotencyKey', 160),
      leaseMs: input.leaseMs === undefined ? DEFAULT_LEASE_MS : input.leaseMs
    };
    if (!TASK_KEY.test(normalized.taskKey)) throw new TypeError('taskKey must be a stable alphanumeric key');
    if (!Number.isSafeInteger(normalized.leaseMs) || normalized.leaseMs < MIN_LEASE_MS || normalized.leaseMs > MAX_LEASE_MS) {
      throw new RangeError(`leaseMs must be ${MIN_LEASE_MS}–${MAX_LEASE_MS}`);
    }
    const request = { ...normalized };
    delete request.idempotencyKey;
    return this._withWriteLock(`task-registry:claim:${normalized.taskKey}`, async () => {
      const state = this._loadState();
      const replay = this._idempotencyReplay(state, 'claim', normalized.idempotencyKey, request);
      if (replay.result) return replay.result;
      const task = state.tasks.find(item => item.taskKey === normalized.taskKey);
      const nowMs = this.clock();
      if (!task) {
        const result = { accepted: false, reason: 'task_not_found', taskKey: normalized.taskKey };
        this._remember(state, replay, result);
        this._saveState(state);
        return result;
      }
      if (task.status === 'completed' || task.status === 'failed') {
        const result = { accepted: false, reason: `task_${task.status}`, taskKey: normalized.taskKey, revision: task.revision };
        this._remember(state, replay, result);
        this._saveState(state);
        return result;
      }
      if (task.ownerChatId && Date.parse(task.leaseExpiresAt) > nowMs && task.ownerChatId !== normalized.ownerChatId) {
        const result = { accepted: false, reason: 'owned_by_other_chat', taskKey: task.taskKey,
          ownerChatId: task.ownerChatId, leaseExpiresAt: task.leaseExpiresAt, status: task.status, revision: task.revision };
        this._remember(state, replay, result);
        this._saveState(state);
        return result;
      }
      const conflict = state.tasks.find(other => other.taskKey !== task.taskKey
        && other.repositoryPath === task.repositoryPath && other.ownerChatId
        && Date.parse(other.leaseExpiresAt) > nowMs && pathsOverlap(other.paths, task.paths));
      if (conflict) {
        const result = { accepted: false, reason: 'path_scope_conflict', taskKey: task.taskKey,
          blockingTaskKey: conflict.taskKey, ownerChatId: conflict.ownerChatId,
          leaseExpiresAt: conflict.leaseExpiresAt, paths: conflict.paths, revision: conflict.revision };
        this._remember(state, replay, result);
        this._saveState(state);
        return result;
      }
      const priorStatus = task.status;
      const leaseExpiresAt = new Date(nowMs + normalized.leaseMs).toISOString();
      task.ownerChatId = normalized.ownerChatId;
      task.leaseExpiresAt = leaseExpiresAt;
      if (task.status === 'planned' || task.status === 'blocked') task.status = 'claimed';
      task.revision += 1;
      task.updatedAt = new Date(nowMs).toISOString();
      const result = { accepted: true, reason: task.ownerChatId === normalized.ownerChatId && priorStatus === 'claimed' ? 'renewed' : 'claimed',
        taskKey: task.taskKey, ownerChatId: task.ownerChatId, leaseExpiresAt, status: task.status,
        previousStatus: priorStatus, revision: task.revision };
      this._remember(state, replay, result);
      this._saveState(state);
      return result;
    });
  }

  async updateCheckpoint(input = {}) {
    const normalized = {
      taskKey: printableString(input.taskKey, 'taskKey', 128),
      ownerChatId: printableString(input.ownerChatId, 'ownerChatId', 256),
      idempotencyKey: printableString(input.idempotencyKey, 'idempotencyKey', 160),
      status: input.status,
      nextAction: printableString(input.nextAction || '', 'nextAction', 2000, false),
      blocker: printableString(input.blocker || '', 'blocker', 2000, false),
      evidenceRefs: input.evidenceRefs === undefined ? [] : input.evidenceRefs
    };
    if (!TASK_KEY.test(normalized.taskKey)) throw new TypeError('taskKey must be a stable alphanumeric key');
    if (!TASK_STATUSES.has(normalized.status)) throw new TypeError('status is not supported');
    if (!Array.isArray(normalized.evidenceRefs) || normalized.evidenceRefs.length > 20
      || normalized.evidenceRefs.some(item => typeof item !== 'string' || !item.trim() || item.length > 2048 || /[\u0000-\u001f\u007f]/u.test(item))) {
      throw new TypeError('evidenceRefs must contain at most 20 concise printable locators');
    }
    normalized.evidenceRefs = [...new Set(normalized.evidenceRefs.map(item => item.trim()))];
    if (normalized.status === 'completed' && normalized.evidenceRefs.length === 0) throw new Error('completion requires at least one evidence reference');
    if (normalized.status === 'blocked' && !normalized.blocker) throw new Error('blocked status requires a blocker description');
    const request = { ...normalized };
    delete request.idempotencyKey;
    return this._withWriteLock(`task-registry:update:${normalized.taskKey}`, async () => {
      const state = this._loadState();
      const replay = this._idempotencyReplay(state, 'update', normalized.idempotencyKey, request);
      if (replay.result) return replay.result;
      const task = state.tasks.find(item => item.taskKey === normalized.taskKey);
      const nowMs = this.clock();
      if (!task) {
        const result = { updated: false, reason: 'task_not_found', taskKey: normalized.taskKey };
        this._remember(state, replay, result);
        this._saveState(state);
        return result;
      }
      if (task.ownerChatId !== normalized.ownerChatId || !task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) <= nowMs) {
        const result = { updated: false, reason: 'claim_not_held', taskKey: task.taskKey, status: task.status, revision: task.revision };
        this._remember(state, replay, result);
        this._saveState(state);
        return result;
      }
      const allowed = STATUS_TRANSITIONS.get(task.status);
      if (!allowed?.has(normalized.status)) throw new Error(`invalid task transition: ${task.status} -> ${normalized.status}`);
      task.status = normalized.status;
      task.checkpoint = { nextAction: normalized.nextAction, blocker: normalized.blocker, evidenceRefs: normalized.evidenceRefs };
      if (normalized.status === 'blocked' || normalized.status === 'completed' || normalized.status === 'failed') {
        task.ownerChatId = null;
        task.leaseExpiresAt = null;
      }
      task.revision += 1;
      task.updatedAt = new Date(nowMs).toISOString();
      const result = { updated: true, task: clone(task) };
      this._remember(state, replay, result);
      this._saveState(state);
      return result;
    });
  }

  getTask(taskKey) {
    if (typeof taskKey !== 'string' || !TASK_KEY.test(taskKey)) return null;
    const task = this._loadState().tasks.find(item => item.taskKey === taskKey);
    return task ? clone(task) : null;
  }

  listTasks(options = {}) {
    const limit = options.limit === undefined ? 100 : options.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new RangeError('limit must be 1–200');
    const tasks = this._loadState().tasks;
    const filtered = tasks.filter(task => (!options.status || task.status === options.status)
      && (!options.ownerChatId || task.ownerChatId === options.ownerChatId));
    return clone(filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit));
  }
}

module.exports = { TaskRegistryStore, normalizePaths, pathsOverlap };
