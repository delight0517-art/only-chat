'use strict';

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { WorkspaceExecutionLease } = require('./WorkspaceExecutionLease.js');

const SCHEMA_VERSION = 1;
const MAX_STORE_BYTES = 16 * 1024 * 1024;
const MAX_TASKS = 10_000;
const MAX_IDEMPOTENCY_RECORDS = 50_000;
const MAX_MESSAGES = 5_000;
const MAX_VERIFICATION_CACHE = 5_000;
const MAX_MESSAGE_LENGTH = 1_200;
const HOST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const MAX_EXECUTOR_RESULT_LENGTH = 8_000;
const MAX_EXECUTOR_TOOL_NAMES = 32;
const MAX_OWNERSHIP_FILES = 2_000;
const MAX_OWNERSHIP_BYTES = 64 * 1024 * 1024;
const MAX_OWNERSHIP_EVENTS = 50;
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

function scopeContains(scope, relativePath) {
  const scopeKey = pathKey(scope);
  const targetKey = pathKey(relativePath);
  return scope === '.' || targetKey === scopeKey || targetKey.startsWith(`${scopeKey}/`);
}

function snapshotScope(repositoryPath, scope) {
  const root = fs.realpathSync(repositoryPath);
  const absolute = path.resolve(root, ...scope.split('/').filter(Boolean));
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('ownership scope escapes its repository');
  let component = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    component = path.join(component, part);
    try { if (fs.lstatSync(component).isSymbolicLink()) throw new Error(`ownership scope contains a symbolic link: ${part}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  let files = 0;
  let bytes = 0;
  const entries = [];
  const walk = (filePath, relativePath) => {
    let stat;
    try { stat = fs.lstatSync(filePath); }
    catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`ownership scope contains a symbolic link: ${relativePath || '.'}`);
    if (stat.isDirectory()) {
      const names = fs.readdirSync(filePath).sort((a, b) => a.localeCompare(b));
      for (const name of names) walk(path.join(filePath, name), [relativePath, name].filter(Boolean).join('/'));
      return true;
    }
    if (!stat.isFile()) throw new Error(`ownership scope contains a non-file entry: ${relativePath || '.'}`);
    if (++files > MAX_OWNERSHIP_FILES || bytes + stat.size > MAX_OWNERSHIP_BYTES) {
      throw new Error('ownership scope snapshot exceeds the bounded file or byte limit; reserve narrower paths');
    }
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) {
        throw new Error(`ownership scope changed while being snapshotted: ${relativePath}`);
      }
      const digest = crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex');
      bytes += opened.size;
      entries.push({ path: relativePath, sha256: digest });
    } finally { fs.closeSync(fd); }
    return true;
  };

  const exists = walk(absolute, scope === '.' ? '' : scope);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return {
    exists,
    kind: exists ? (entries.length === 1 && entries[0].path === scope ? 'file' : 'tree') : 'missing',
    sha256: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    fileCount: files,
    byteCount: bytes
  };
}

function captureOwnershipScopes(repositoryPath, paths, sourceHostId, creatorChatId, capturedAt) {
  return {
    schemaVersion: 1,
    sourceHostId,
    creatorChatId,
    capturedAt,
    events: [],
    scopes: paths.map(scope => {
      const snapshot = snapshotScope(repositoryPath, scope);
      return { path: scope, initial: snapshot, expected: snapshot, lastWriterChatId: null, updatedAt: capturedAt };
    })
  };
}

function normalizeMutationPaths(repositoryPath, rawPaths) {
  if (!Array.isArray(rawPaths) || rawPaths.length < 1 || rawPaths.length > 100) throw new TypeError('filePaths must contain 1–100 exact paths');
  const root = fs.realpathSync(repositoryPath);
  const paths = rawPaths.map(raw => {
    if (typeof raw !== 'string' || !raw.trim() || raw.includes('\\') || raw.includes('\0')) throw new TypeError('file path is invalid');
    let absolute = path.resolve(root, raw);
    if (path.isAbsolute(raw)) {
      let existing = absolute;
      while (!fs.existsSync(existing) && existing !== path.dirname(existing)) existing = path.dirname(existing);
      const canonicalExisting = fs.realpathSync(existing);
      absolute = path.resolve(canonicalExisting, path.relative(existing, absolute));
    }
    const relative = path.relative(root, absolute);
    if (!relative || relative === '.' || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('file path must identify a file inside the repository');
    let current = root;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error('symbolic links are not valid owned file paths');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return relative.split(path.sep).join('/');
  });
  return normalizePaths(paths);
}

function equalSnapshot(left, right) {
  return Boolean(left && right && left.exists === right.exists && left.kind === right.kind
    && left.sha256 === right.sha256 && left.fileCount === right.fileCount && left.byteCount === right.byteCount);
}

function overlappingPathDetails(left, right) {
  const overlaps = [];
  for (const a of left) for (const b of right) {
    if (a === '.' || b === '.') overlaps.push('.');
    else {
      const ak = pathKey(a), bk = pathKey(b);
      if (ak === bk || ak.startsWith(`${bk}/`) || bk.startsWith(`${ak}/`)) overlaps.push(`${a} ↔ ${b}`);
    }
  }
  return [...new Set(overlaps)];
}

function blockingTaskDetails(task, paths) {
  return {
    taskKey: task.taskKey,
    title: task.title,
    sourceChatId: task.creatorChatId || '',
    sourceHostId: task.sourceHostId || '',
    lastUpdatedByChatId: task.lastUpdatedByChatId || '',
    lastUpdatedByHostId: task.lastUpdatedByHostId || '',
    lastUpdatedAt: task.lastUpdatedAt || task.updatedAt || '',
    ownerChatId: task.ownerChatId || '',
    leaseExpiresAt: task.leaseExpiresAt || '',
    paths
  };
}

function blockingTaskSummary(task) {
  return `작업 ${task.taskKey} (${task.title || '제목 미기록'}) · 요청 채팅 ${task.creatorChatId || '미기록'} · 요청 기기 ${task.sourceHostId || '미기록'} · 마지막 기록 채팅 ${task.lastUpdatedByChatId || '미기록'} · 마지막 기록 기기 ${task.lastUpdatedByHostId || '미기록'} · 마지막 기록 시각 ${task.lastUpdatedAt || task.updatedAt || '미기록'} · 담당 채팅 ${task.ownerChatId || '미기록'} · 임대 만료 ${task.leaseExpiresAt || '미기록'}`;
}

function normalizeLeasePaths(paths) {
  if (!Array.isArray(paths) || paths.length > 100) throw new TypeError('leasePaths must contain at most 100 repository-relative paths');
  return paths.length ? normalizePaths(paths) : [];
}

function taskLeasePaths(task) {
  if (['blocked', 'failed', 'completed'].includes(task.status)) return [];
  if (Array.isArray(task.executionProgress) && task.executionProgress.some(item => ['queued', 'running'].includes(item.status))) {
    const paths = task.executionProgress.flatMap((item, index) => ['queued', 'running'].includes(item.status)
      ? task.execution?.tasks[index]?.files || [] : []);
    return normalizeLeasePaths(paths);
  }
  return task.paths;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeExecutionPlan(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['kind', 'summary', 'tasks'].includes(key))
    || value.kind !== 'executor-plan' || !Array.isArray(value.tasks)
    || value.tasks.length < 1 || value.tasks.length > 5) {
    throw new TypeError('execution must be a validated executor plan');
  }
  const summary = printableString(value.summary, 'execution.summary', 1000);
  const ownedPaths = [];
  const tasks = value.tasks.map((task, index) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)
      || Object.keys(task).some(key => !['title', 'prompt', 'files', 'allowedTools'].includes(key))) {
      throw new TypeError(`execution.tasks[${index}] is invalid`);
    }
    const title = printableString(task.title, `execution.tasks[${index}].title`, 120);
    const prompt = printableString(task.prompt, `execution.tasks[${index}].prompt`, 4000);
    const paths = normalizePaths(task.files);
    const allowedTools = task.allowedTools;
    if (!Array.isArray(allowedTools) || allowedTools.length < 1 || allowedTools.length > 32
      || allowedTools.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/i.test(name))) {
      throw new TypeError(`execution.tasks[${index}].allowedTools is invalid`);
    }
    if (pathsOverlap(ownedPaths, paths)) throw new TypeError('execution task file scopes overlap');
    ownedPaths.push(...paths);
    return { title, prompt, files: paths, allowedTools: [...new Set(allowedTools)] };
  });
  return { kind: 'executor-plan', summary, tasks };
}

function normalizeExecutionEvidence(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('executionEvidence is invalid');
  const names = value.toolNames;
  if (!Array.isArray(names) || names.length > MAX_EXECUTOR_TOOL_NAMES
    || names.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/i.test(name))) {
    throw new TypeError('executionEvidence.toolNames is invalid');
  }
  const counts = ['attemptedCount', 'successfulCount', 'failedCount', 'allowedToolViolationCount',
    'approvalBlockedCount', 'approvalUnavailableCount', 'approvalDeniedCount', 'approvalExpiredCount', 'approvalInvalidCount'];
  for (const key of counts) {
    if (counts.indexOf(key) < 4 && !Number.isSafeInteger(value[key])) throw new TypeError(`executionEvidence.${key} is invalid`);
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 0)) throw new TypeError(`executionEvidence.${key} is invalid`);
  }
  const evidence = { ...Object.fromEntries(counts.filter(key => value[key] !== undefined).map(key => [key, value[key]])), toolNames: [...new Set(names)] };
  for (const key of ['provider', 'model', 'tierId', 'tierName']) {
    if (value[key] !== undefined && value[key] !== null) evidence[key] = printableString(value[key], `executionEvidence.${key}`, 128);
  }
  const disallowedToolNames = value.disallowedToolNames === undefined ? [] : value.disallowedToolNames;
  if (!Array.isArray(disallowedToolNames) || disallowedToolNames.length > MAX_EXECUTOR_TOOL_NAMES
    || disallowedToolNames.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/i.test(name))) {
    throw new TypeError('executionEvidence.disallowedToolNames is invalid');
  }
  evidence.disallowedToolNames = [...new Set(disallowedToolNames)];
  return evidence;
}

function verifyCompletionIntegration(task, evidenceRefs) {
  const commitRefs = evidenceRefs
    .map(ref => /^integration:commit:([a-f0-9]{7,40})$/iu.exec(ref)?.[1])
    .filter(Boolean);
  if (!commitRefs.length) throw new Error('completion requires an integration:commit:<sha> reference');
  if (!evidenceRefs.includes('review:accepted')) throw new Error('completion requires review:accepted evidence');
  if (!evidenceRefs.some(ref => /^check:/iu.test(ref))) throw new Error('completion requires a check: evidence reference');

  const runGit = args => {
    const result = spawnSync('git', ['--no-optional-locks', ...args], {
      cwd: task.repositoryPath,
      encoding: 'buffer',
      timeout: 5000,
      maxBuffer: 1024 * 1024
    });
    if (result.error) throw new Error(`completion Git verification failed: ${result.error.message}`);
    if (result.status !== 0) throw new Error('completion Git verification failed; preserve task state and inspect the repository');
    return result.stdout || Buffer.alloc(0);
  };
  const text = args => runGit(args).toString('utf8').trim();
  const topLevel = path.resolve(text(['rev-parse', '--show-toplevel']));
  const repositoryPath = path.resolve(task.repositoryPath);
  const prefix = text(['rev-parse', '--show-prefix']).replace(/\\/gu, '/').replace(/\/$/u, '');
  const rootPaths = task.paths.map(item => item === '.' ? (prefix || '.') : [prefix, item].filter(Boolean).join('/'));
  const base = text(['rev-parse', '--verify', `${task.baseSha}^{commit}`]);

  if (topLevel !== repositoryPath && !repositoryPath.startsWith(`${topLevel}${path.sep}`)) {
    throw new Error('completion repository path is outside its Git worktree');
  }
  const commits = [...new Set(commitRefs.map(ref => text(['rev-parse', '--verify', `${ref}^{commit}`])))];
  const changedPaths = [];
  for (const commit of commits) {
    const baseCheck = spawnSync('git', ['--no-optional-locks', 'merge-base', '--is-ancestor', base, commit], {
      cwd: repositoryPath, encoding: 'utf8', timeout: 5000
    });
    if (baseCheck.error || baseCheck.status !== 0) throw new Error('integration commit does not descend from the task base');
    const headCheck = spawnSync('git', ['--no-optional-locks', 'merge-base', '--is-ancestor', commit, 'HEAD'], {
      cwd: repositoryPath, encoding: 'utf8', timeout: 5000
    });
    if (headCheck.error || headCheck.status !== 0) throw new Error('integration commit is not present in the current branch history');
    changedPaths.push(...runGit(['show', '--pretty=format:', '--name-only', '-z', commit])
      .toString('utf8').split('\0').filter(Boolean));
  }
  if (!pathsOverlap(rootPaths, changedPaths)) throw new Error('integration commit does not include task-owned paths');
  const dirty = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...task.paths]);
  if (dirty.length) throw new Error('task-owned paths still have uncommitted changes');
}

function initialExecutionProgress(taskKey, execution, now) {
  if (!execution) return undefined;
  return execution.tasks.map((task, index) => ({
    id: `${taskKey}-${index + 1}`, title: task.title, status: 'queued', attempt: 0,
    sessionId: null, result: '', reason: '', error: '', executionEvidence: null, history: [], updatedAt: now
  }));
}

function operationHash(operation, input) {
  return crypto.createHash('sha256').update(`${operation}\0${JSON.stringify(input)}`).digest('hex');
}

function normalizeConversationTaskEnvelope(input) {
  const allowed = new Set(['schemaVersion', 'taskKey', 'title', 'creatorChatId', 'sourceHostId', 'createdAt']);
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !allowed.has(key)) || input.schemaVersion !== 1) {
    throw new TypeError('remote conversation task envelope is invalid');
  }
  const envelope = {
    schemaVersion: 1,
    taskKey: printableString(input.taskKey, 'taskKey', 128),
    title: printableString(input.title, 'title', 120),
    creatorChatId: printableString(input.creatorChatId, 'creatorChatId', 256),
    sourceHostId: printableString(input.sourceHostId, 'sourceHostId', 36),
    createdAt: printableString(input.createdAt, 'createdAt', 40)
  };
  if (!TASK_KEY.test(envelope.taskKey)) throw new TypeError('taskKey must be a stable alphanumeric key');
  if (!HOST_ID.test(envelope.sourceHostId)) throw new TypeError('sourceHostId must be a UUID v4 host identity');
  if (!Number.isFinite(Date.parse(envelope.createdAt))) throw new TypeError('createdAt must be a valid timestamp');
  return envelope;
}

function normalizeRemoteMessageEnvelope(input, localHostId) {
  const allowed = new Set(['messageId', 'taskKey', 'senderChatId', 'senderHostId', 'recipientChatId',
    'recipientHostId', 'type', 'text', 'inReplyToMessageId', 'createdAt']);
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !allowed.has(key))) {
    throw new TypeError('remote task message envelope is invalid');
  }
  const message = {
    messageId: printableString(input.messageId, 'messageId', 36),
    taskKey: printableString(input.taskKey, 'taskKey', 128),
    senderChatId: printableString(input.senderChatId, 'senderChatId', 256),
    senderHostId: printableString(input.senderHostId, 'senderHostId', 36),
    recipientChatId: input.recipientChatId == null ? null : printableString(input.recipientChatId, 'recipientChatId', 256),
    recipientHostId: printableString(input.recipientHostId, 'recipientHostId', 36),
    type: input.type,
    text: printableString(input.text, 'text', MAX_MESSAGE_LENGTH),
    inReplyToMessageId: input.inReplyToMessageId == null ? null : printableString(input.inReplyToMessageId, 'inReplyToMessageId', 36),
    createdAt: printableString(input.createdAt, 'createdAt', 40)
  };
  if (!HOST_ID.test(message.messageId) || !TASK_KEY.test(message.taskKey)
    || !HOST_ID.test(message.senderHostId) || !HOST_ID.test(message.recipientHostId)
    || message.senderHostId === localHostId || message.recipientHostId !== localHostId
    || !['message', 'ack'].includes(message.type)
    || !Number.isFinite(Date.parse(message.createdAt))) {
    throw new TypeError('remote task message is not addressed to this host');
  }
  if (message.type === 'message' && message.inReplyToMessageId !== null) {
    throw new TypeError('remote message cannot contain an ACK reference');
  }
  if (message.type === 'ack' && (!message.inReplyToMessageId || !HOST_ID.test(message.inReplyToMessageId)
    || !message.recipientChatId)) {
    throw new TypeError('remote ACK must reference a message and recipient chat');
  }
  return message;
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
    this.hostId = this._loadOrCreateHostId();
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

  _loadOrCreateHostId() {
    const filePath = path.join(this.storeDir, 'host-identity.json');
    const read = () => {
      const before = fs.lstatSync(filePath);
      if (before.isSymbolicLink() || !before.isFile() || before.size > 256) throw new Error('task registry host identity is unsafe or too large');
      const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > 256) {
          throw new Error('task registry host identity changed while opening');
        }
        if (process.platform !== 'win32' && (opened.mode & 0o077) !== 0) throw new Error('task registry host identity permissions are unsafe');
        const record = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (!record || record.schemaVersion !== 1 || !HOST_ID.test(record.hostId || '')) throw new Error('task registry host identity is invalid');
        return record.hostId;
      } finally { fs.closeSync(fd); }
    };

    try { return read(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }

    const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
      const hostId = crypto.randomUUID();
      fd = fs.openSync(tempPath, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ schemaVersion: 1, hostId }) + '\n', 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      try { fs.linkSync(tempPath, filePath); }
      catch (linkError) {
        if (linkError.code !== 'EEXIST') throw linkError;
      }
      return read();
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(tempPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  _emptyState() {
    return { schemaVersion: SCHEMA_VERSION, tasks: [], idempotency: [], messages: [], verificationCache: [] };
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
    if (document.messages === undefined) document.messages = [];
    if (!Array.isArray(document.messages) || document.messages.length > MAX_MESSAGES) throw new Error('invalid task registry messages');
    if (document.verificationCache === undefined) document.verificationCache = [];
    if (!Array.isArray(document.verificationCache) || document.verificationCache.length > MAX_VERIFICATION_CACHE
      || document.verificationCache.some(item => !item || !/^[a-f0-9]{64}$/.test(item.checkId)
        || typeof item.verificationKey !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(item.verificationKey)
        || typeof item.repositoryPath !== 'string' || !path.isAbsolute(item.repositoryPath)
        || !/^[a-f0-9]{64}$/.test(item.inputSha256) || !/^[a-f0-9]{64}$/.test(item.commandSha256)
        || !/^[a-f0-9]{64}$/.test(item.environmentSha256) || typeof item.evidenceRef !== 'string'
        || !item.evidenceRef.trim() || item.evidenceRef.length > 2048 || /[\u0000-\u001f\u007f]/u.test(item.evidenceRef)
        || item.status !== 'passed' || typeof item.stale !== 'boolean'
        || !Number.isFinite(Date.parse(item.recordedAt))
        || (item.stale && !Number.isFinite(Date.parse(item.staleAt))))) {
      throw new Error('invalid task registry verification cache');
    }
    const taskKeys = new Set();
    for (const task of document.tasks) {
      const conversationOnly = task?.conversationOnly === true;
      if (!task || typeof task.taskKey !== 'string' || !TASK_KEY.test(task.taskKey)
        || taskKeys.has(task.taskKey) || !TASK_STATUSES.has(task.status)
        || !Number.isSafeInteger(task.revision) || task.revision < 1
        || (task.sourceHostId !== undefined && !HOST_ID.test(task.sourceHostId))
        || (task.lastUpdatedByHostId !== undefined && !HOST_ID.test(task.lastUpdatedByHostId))
        || (task.lastUpdatedByChatId !== undefined && (typeof task.lastUpdatedByChatId !== 'string'
          || !task.lastUpdatedByChatId.trim() || task.lastUpdatedByChatId.length > 256))
        || (task.lastUpdatedAt !== undefined && !Number.isFinite(Date.parse(task.lastUpdatedAt)))
        || (task.leasePaths !== undefined && JSON.stringify(normalizeLeasePaths(task.leasePaths)) !== JSON.stringify(task.leasePaths))
        || !Array.isArray(task.paths)
        || (conversationOnly
          ? task.repositoryPath !== null || task.baseSha !== null || task.paths.length !== 0
            || !HOST_ID.test(task.sourceHostId || '') || task.execution !== undefined || task.executionProgress !== undefined
            || task.status !== 'planned' || task.ownerChatId !== null || task.leaseExpiresAt !== null
            || typeof task.title !== 'string' || !task.title.trim() || task.title.length > 120
            || typeof task.creatorChatId !== 'string' || !task.creatorChatId.trim() || task.creatorChatId.length > 256
            || !Number.isFinite(Date.parse(task.createdAt))
          : typeof task.repositoryPath !== 'string' || (task.conversationOnly !== undefined && task.conversationOnly !== false))) {
        throw new Error('invalid task registry record');
      }
      if (task.execution !== undefined) {
        try {
          if (JSON.stringify(normalizeExecutionPlan(task.execution)) !== JSON.stringify(task.execution)) {
            throw new Error('execution plan is not normalized');
          }
        } catch (_) {
          throw new Error('invalid task registry execution plan');
        }
      }
      if (task.ownership !== undefined) {
        const ownership = task.ownership;
        const validSnapshot = value => value && typeof value === 'object' && !Array.isArray(value)
          && typeof value.exists === 'boolean' && ['file', 'tree', 'missing'].includes(value.kind)
          && /^[a-f0-9]{64}$/u.test(value.sha256)
          && Number.isSafeInteger(value.fileCount) && value.fileCount >= 0 && value.fileCount <= MAX_OWNERSHIP_FILES
          && Number.isSafeInteger(value.byteCount) && value.byteCount >= 0 && value.byteCount <= MAX_OWNERSHIP_BYTES;
        if (!ownership || ownership.schemaVersion !== 1 || ownership.sourceHostId !== task.sourceHostId
          || ownership.creatorChatId !== task.creatorChatId || !Number.isFinite(Date.parse(ownership.capturedAt))
          || !Array.isArray(ownership.scopes) || ownership.scopes.length !== task.paths.length
          || ownership.scopes.some((scope, index) => !scope || scope.path !== task.paths[index]
            || !validSnapshot(scope.initial) || !validSnapshot(scope.expected)
            || (scope.lastWriterChatId !== null && (typeof scope.lastWriterChatId !== 'string' || !scope.lastWriterChatId.trim() || scope.lastWriterChatId.length > 256))
            || !Number.isFinite(Date.parse(scope.updatedAt)))
          || !Array.isArray(ownership.events) || ownership.events.length > MAX_OWNERSHIP_EVENTS
          || ownership.events.some(event => !event || typeof event.action !== 'string' || !['authorized_write', 'denied_write'].includes(event.action)
            || typeof event.chatId !== 'string' || !event.chatId.trim() || event.chatId.length > 256
            || !Array.isArray(event.paths) || event.paths.length > 100
            || event.paths.some(item => typeof item !== 'string' || !item.trim() || item.length > 1024)
            || !Number.isFinite(Date.parse(event.at)))) {
          throw new Error('invalid task registry ownership snapshot');
        }
      }
      if (task.executionProgress !== undefined) {
        if (!task.execution || !Array.isArray(task.executionProgress) || task.executionProgress.length !== task.execution.tasks.length
          || task.executionProgress.some((item, index) => !item || item.id !== `${task.taskKey}-${index + 1}`
            || item.title !== task.execution.tasks[index].title
            || !['queued', 'running', 'completed', 'blocked', 'failed'].includes(item.status)
            || !Number.isSafeInteger(item.attempt) || item.attempt < 0
            || typeof item.result !== 'string' || item.result.length > MAX_EXECUTOR_RESULT_LENGTH
            || typeof item.reason !== 'string' || item.reason.length > 2000
            || typeof item.error !== 'string' || item.error.length > 2000
            || (item.sessionId !== null && typeof item.sessionId !== 'string')
            || (item.history !== undefined && (!Array.isArray(item.history) || item.history.some(entry => !entry
              || !Number.isSafeInteger(entry.attempt) || entry.attempt < 0
              || !['queued', 'running', 'completed', 'blocked', 'failed', 'interrupted'].includes(entry.status)
              || typeof entry.result !== 'string' || entry.result.length > MAX_EXECUTOR_RESULT_LENGTH
              || typeof entry.reason !== 'string' || entry.reason.length > 2000
              || typeof entry.error !== 'string' || entry.error.length > 2000
              || (entry.sessionId !== null && typeof entry.sessionId !== 'string')
              || !Number.isFinite(Date.parse(entry.updatedAt)))))
            || !Number.isFinite(Date.parse(item.updatedAt)))) {
          throw new Error('invalid task registry executor progress');
        }
        for (const item of task.executionProgress) {
          if (JSON.stringify(normalizeExecutionEvidence(item.executionEvidence)) !== JSON.stringify(item.executionEvidence)) {
            throw new Error('executor evidence is not normalized');
          }
          for (const entry of item.history || []) {
            if (JSON.stringify(normalizeExecutionEvidence(entry.executionEvidence)) !== JSON.stringify(entry.executionEvidence)) {
              throw new Error('executor history evidence is not normalized');
            }
          }
        }
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
    const taskByKey = new Map(document.tasks.map(task => [task.taskKey, task]));
    const messagesById = new Map();
    for (const message of document.messages) {
      if (!message || typeof message.messageId !== 'string' || !/^[a-f0-9-]{36}$/i.test(message.messageId)
        || messagesById.has(message.messageId) || !taskByKey.has(message.taskKey)
        || !['message', 'ack'].includes(message.type)
        || typeof message.senderChatId !== 'string' || !message.senderChatId
        || (message.recipientChatId !== null && typeof message.recipientChatId !== 'string')
        || typeof message.text !== 'string' || !message.text.trim() || message.text.length > MAX_MESSAGE_LENGTH
        || !Number.isFinite(Date.parse(message.createdAt))) {
        throw new Error('invalid task registry message record');
      }
      if (message.type === 'ack') {
        const original = messagesById.get(message.inReplyToMessageId);
        if (!original || original.taskKey !== message.taskKey || original.type !== 'message') {
          throw new Error('task registry ACK has no matching message');
        }
      }
      messagesById.set(message.messageId, message);
    }
    return document;
  }

  _saveState(state) {
    const tempPath = path.join(this.storeDir, `.index.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_BYTES) throw new Error('task registry storage limit reached; preserve the current store and review retention');
    let fd;
    try {
      fd = fs.openSync(tempPath, 'wx', 0o600);
      fs.writeFileSync(fd, serialized, 'utf8');
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

  _normalizeVerificationInput(input, includeEvidence = false) {
    const verificationKey = printableString(input.verificationKey, 'verificationKey', 128);
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(verificationKey)) throw new TypeError('verificationKey is invalid');
    const normalized = {
      verificationKey,
      repositoryPath: normalizeRepositoryPath(input.repositoryPath),
      inputSha256: printableString(input.inputSha256, 'inputSha256', 64).toLowerCase(),
      commandSha256: printableString(input.commandSha256, 'commandSha256', 64).toLowerCase(),
      environmentSha256: printableString(input.environmentSha256, 'environmentSha256', 64).toLowerCase()
    };
    for (const key of ['inputSha256', 'commandSha256', 'environmentSha256']) {
      if (!/^[a-f0-9]{64}$/.test(normalized[key])) throw new TypeError(`${key} must be a SHA-256 hex digest`);
    }
    normalized.checkId = crypto.createHash('sha256').update([
      normalized.repositoryPath, normalized.verificationKey, normalized.commandSha256, normalized.environmentSha256
    ].join('\0')).digest('hex');
    if (includeEvidence) normalized.evidenceRef = printableString(input.evidenceRef, 'evidenceRef', 2048);
    return normalized;
  }

  lookupVerification(input = {}) {
    const normalized = this._normalizeVerificationInput(input);
    const matching = this._loadState().verificationCache.filter(item => item.checkId === normalized.checkId && !item.stale);
    const current = matching.at(-1);
    if (current && current.inputSha256 === normalized.inputSha256) return { hit: true, record: clone(current) };
    return { hit: false, invalidatedEvidenceRefs: current ? [current.evidenceRef] : [] };
  }

  async recordVerification(input = {}) {
    const normalized = this._normalizeVerificationInput(input, true);
    const idempotencyKey = printableString(input.idempotencyKey, 'idempotencyKey', 160);
    const request = { ...normalized };
    delete request.evidenceRef;
    return this._withWriteLock(`task-registry:verification:${normalized.checkId}`, async () => {
      const state = this._loadState();
      const replay = this._idempotencyReplay(state, 'verification-record', idempotencyKey, { ...request, evidenceRef: normalized.evidenceRef });
      if (replay.result) return { ...replay.result, replayed: true };
      const existing = state.verificationCache.find(item => item.checkId === normalized.checkId && !item.stale);
      if (existing && existing.inputSha256 === normalized.inputSha256) {
        const result = { recorded: false, reused: true, record: clone(existing) };
        this._remember(state, replay, result);
        this._saveState(state);
        return result;
      }
      if (state.verificationCache.length >= MAX_VERIFICATION_CACHE) throw new Error('verification cache capacity reached; review retention before adding more evidence');
      const now = new Date(this.clock()).toISOString();
      if (existing) { existing.stale = true; existing.staleAt = now; }
      const record = { checkId: normalized.checkId, verificationKey: normalized.verificationKey,
        repositoryPath: normalized.repositoryPath, inputSha256: normalized.inputSha256,
        commandSha256: normalized.commandSha256, environmentSha256: normalized.environmentSha256,
        evidenceRef: normalized.evidenceRef, status: 'passed', stale: false, recordedAt: now };
      state.verificationCache.push(record);
      const result = { recorded: true, reused: false, record: clone(record), invalidatedEvidenceRef: existing?.evidenceRef || null };
      this._remember(state, replay, result);
      this._saveState(state);
      return result;
    });
  }

  async createTask(input = {}) {
    const normalized = {
      taskKey: printableString(input.taskKey, 'taskKey', 128),
      title: printableString(input.title, 'title', 120),
      creatorChatId: printableString(input.creatorChatId, 'creatorChatId', 256),
      repositoryPath: normalizeRepositoryPath(input.repositoryPath),
      baseSha: printableString(input.baseSha, 'baseSha', 64).toLowerCase(),
      paths: normalizePaths(input.paths),
      execution: normalizeExecutionPlan(input.execution),
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
      if (replay.result) return { ...replay.result, created: false, replayed: true };
      const existing = state.tasks.find(task => task.taskKey === normalized.taskKey);
      if (existing) {
        const same = existing.title === normalized.title && existing.creatorChatId === normalized.creatorChatId
          && existing.repositoryPath === normalized.repositoryPath && existing.baseSha === normalized.baseSha
          && JSON.stringify(existing.paths) === JSON.stringify(normalized.paths)
          && JSON.stringify(existing.execution) === JSON.stringify(normalized.execution)
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
        sourceHostId: this.hostId,
        repositoryPath: normalized.repositoryPath,
        baseSha: normalized.baseSha,
        paths: normalized.paths,
        status: 'planned',
        ownerChatId: null,
        leaseExpiresAt: null,
        revision: 1,
        checkpoint: { nextAction: normalized.nextAction, blocker: '', evidenceRefs: [] },
        ownership: captureOwnershipScopes(normalized.repositoryPath, normalized.paths, this.hostId, normalized.creatorChatId, now),
        createdAt: now,
        updatedAt: now,
        lastUpdatedByChatId: normalized.creatorChatId,
        lastUpdatedByHostId: this.hostId,
        lastUpdatedAt: now
      };
      if (normalized.execution !== undefined) task.execution = normalized.execution;
      const executionProgress = initialExecutionProgress(normalized.taskKey, normalized.execution, now);
      if (executionProgress) task.executionProgress = executionProgress;
      state.tasks.push(task);
      const result = { created: true, task: clone(task) };
      this._remember(state, replay, result);
      this._saveState(state);
      return result;
    });
  }

  exportConversationTask(taskKey) {
    const task = this.getTask(taskKey);
    if (!task) throw new Error('task not found');
    return {
      schemaVersion: 1,
      taskKey: task.taskKey,
      title: task.title,
      creatorChatId: task.creatorChatId,
      sourceHostId: task.sourceHostId || this.hostId,
      createdAt: task.createdAt
    };
  }

  async importConversationTask(input = {}) {
    const envelope = normalizeConversationTaskEnvelope(input);
    if (envelope.sourceHostId === this.hostId) throw new Error('cannot import a conversation task from this host');
    return this._withWriteLock(`task-registry:conversation-task:${envelope.taskKey}`, async () => {
      const state = this._loadState();
      const existing = state.tasks.find(task => task.taskKey === envelope.taskKey);
      if (existing) {
        const same = existing.title === envelope.title && existing.creatorChatId === envelope.creatorChatId
          && (existing.sourceHostId || this.hostId) === envelope.sourceHostId
          && existing.createdAt === envelope.createdAt;
        if (!same) throw new Error('task key already exists with different conversation identity');
        if (existing.conversationOnly) return { imported: false, replayed: true, task: clone(existing) };
        return { imported: false, replayed: true, localTaskPreserved: true, task: clone(existing) };
      }
      if (state.tasks.length >= MAX_TASKS) throw new Error('task registry capacity reached; preserve the store and review retention');
      const now = new Date(this.clock()).toISOString();
      const task = {
        taskKey: envelope.taskKey,
        title: envelope.title,
        creatorChatId: envelope.creatorChatId,
        sourceHostId: envelope.sourceHostId,
        conversationOnly: true,
        repositoryPath: null,
        baseSha: null,
        paths: [],
        status: 'planned',
        ownerChatId: null,
        leaseExpiresAt: null,
        revision: 1,
        checkpoint: { nextAction: 'Shared conversation only; no local repository claim.', blocker: '', evidenceRefs: [] },
        createdAt: envelope.createdAt,
        updatedAt: now,
        lastUpdatedByHostId: this.hostId,
        lastUpdatedAt: now
      };
      state.tasks.push(task);
      this._saveState(state);
      return { imported: true, replayed: false, task: clone(task) };
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
      if (task.conversationOnly) {
        const result = { accepted: false, reason: 'conversation_only', taskKey: normalized.taskKey, revision: task.revision };
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
      if (!task.ownership) {
        const result = { accepted: false, reason: 'ownership_snapshot_missing', taskKey: task.taskKey, revision: task.revision };
        this._remember(state, replay, result);
        this._saveState(state);
        return result;
      }
      const changedScopes = task.ownership.scopes.filter(scope => !equalSnapshot(scope.expected,
        snapshotScope(task.repositoryPath, scope.path))).map(scope => scope.path);
      if (changedScopes.length) {
        const result = { accepted: false, reason: 'path_content_changed', taskKey: task.taskKey, changedPaths: changedScopes, revision: task.revision };
        this._remember(state, replay, result);
        this._saveState(state);
        return result;
      }
      if (task.ownerChatId && Date.parse(task.leaseExpiresAt) > nowMs && task.ownerChatId !== normalized.ownerChatId) {
        const result = { accepted: false, reason: 'owned_by_other_chat', taskKey: task.taskKey,
          ownerChatId: task.ownerChatId, leaseExpiresAt: task.leaseExpiresAt,
          blockingTask: blockingTaskDetails(task, task.leasePaths || task.paths), status: task.status, revision: task.revision };
        this._remember(state, replay, result);
        this._saveState(state);
        return result;
      }
      const candidatePaths = task.status === 'blocked' ? task.paths : taskLeasePaths(task);
      const conflict = state.tasks.find(other => other.taskKey !== task.taskKey
        && other.repositoryPath === task.repositoryPath && other.ownerChatId
        && Date.parse(other.leaseExpiresAt) > nowMs && pathsOverlap(other.leasePaths || other.paths, candidatePaths));
      if (conflict) {
        const conflictPaths = overlappingPathDetails(conflict.leasePaths || conflict.paths, candidatePaths);
        const result = { accepted: false, reason: 'path_scope_conflict', taskKey: task.taskKey,
          blockingTaskKey: conflict.taskKey, ownerChatId: conflict.ownerChatId,
          leaseExpiresAt: conflict.leaseExpiresAt, paths: conflictPaths,
          blockingTask: blockingTaskDetails(conflict, conflictPaths), revision: conflict.revision };
        this._remember(state, replay, result);
        this._saveState(state);
        return result;
      }
      const priorStatus = task.status;
      const leaseExpiresAt = new Date(nowMs + normalized.leaseMs).toISOString();
      task.ownerChatId = normalized.ownerChatId;
      task.leaseExpiresAt = leaseExpiresAt;
      task.leasePaths = candidatePaths;
      task.lastUpdatedByChatId = normalized.ownerChatId;
      task.lastUpdatedByHostId = this.hostId;
      task.lastUpdatedAt = new Date(nowMs).toISOString();
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

  async authorizeFileMutation(input = {}) {
    const taskKey = printableString(input.taskKey, 'taskKey', 128);
    const ownerChatId = printableString(input.ownerChatId, 'ownerChatId', 256);
    const originHostId = printableString(input.originHostId, 'originHostId', 36);
    const repositoryPath = normalizeRepositoryPath(input.repositoryPath);
    if (input.origin !== 'only-chat-internal' || originHostId !== this.hostId) return { authorized: false, reason: 'unverified_only_chat_origin' };
    const task = this.getTask(taskKey);
    if (!task) return { authorized: false, reason: 'task_not_found' };
    if (task.repositoryPath !== repositoryPath || task.sourceHostId !== this.hostId) return { authorized: false, reason: 'repository_or_source_mismatch' };
    if (task.ownerChatId !== ownerChatId || !task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) <= this.clock()
      || !['claimed', 'executing'].includes(task.status)) return { authorized: false, reason: 'active_owner_lease_required' };
    if (!task.ownership) return { authorized: false, reason: 'ownership_snapshot_missing' };
    const files = normalizeMutationPaths(repositoryPath, input.filePaths);
    const allowedPaths = normalizePaths(input.allowedPaths);
    const leasePaths = normalizeLeasePaths(task.leasePaths || task.paths);
    if (!files.length || files.some(file => !allowedPaths.some(scope => scopeContains(scope, file))
      || !leasePaths.some(scope => scopeContains(scope, file)))) return { authorized: false, reason: 'exact_path_not_leased' };
    const scopes = task.ownership.scopes.filter(scope => files.some(file => scopeContains(scope.path, file)));
    if (!scopes.length) return { authorized: false, reason: 'ownership_scope_missing' };
    for (const scope of scopes) {
      const current = snapshotScope(repositoryPath, scope.path);
      if (!equalSnapshot(scope.expected, current)) return { authorized: false, reason: 'path_content_changed', changedPath: scope.path };
    }
    return { authorized: true, snapshots: scopes.map(scope => ({ path: scope.path, expected: clone(scope.expected) })) };
  }

  async recordFileMutation(input = {}) {
    const taskKey = printableString(input.taskKey, 'taskKey', 128);
    const ownerChatId = printableString(input.ownerChatId, 'ownerChatId', 256);
    const originHostId = printableString(input.originHostId, 'originHostId', 36);
    const repositoryPath = normalizeRepositoryPath(input.repositoryPath);
    const files = normalizeMutationPaths(repositoryPath, input.filePaths);
    if (input.origin !== 'only-chat-internal' || originHostId !== this.hostId) return { updated: false, reason: 'unverified_only_chat_origin' };
    return this._withWriteLock(`task-registry:file-mutation:${taskKey}`, async () => {
      const state = this._loadState();
      const task = state.tasks.find(item => item.taskKey === taskKey);
      const nowMs = this.clock();
      if (!task || !task.ownership) return { updated: false, reason: task ? 'ownership_snapshot_missing' : 'task_not_found' };
      if (task.repositoryPath !== repositoryPath || task.sourceHostId !== this.hostId
        || task.ownerChatId !== ownerChatId || !task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) <= nowMs
        || !['claimed', 'executing'].includes(task.status)) return { updated: false, reason: 'active_owner_lease_required' };
      if (!Array.isArray(input.beforeSnapshots)) return { updated: false, reason: 'before_snapshot_required' };
      const allowedPaths = normalizePaths(input.allowedPaths);
      const leasePaths = normalizeLeasePaths(task.leasePaths || task.paths);
      if (!files.length || files.some(file => !allowedPaths.some(scope => scopeContains(scope, file))
        || !leasePaths.some(scope => scopeContains(scope, file)))) return { updated: false, reason: 'exact_path_not_leased' };
      const scopes = task.ownership.scopes.filter(scope => files.some(file => scopeContains(scope.path, file)));
      if (!files.length || !scopes.length || scopes.some(scope => {
        const before = input.beforeSnapshots.find(item => item?.path === scope.path)?.expected;
        return !equalSnapshot(scope.expected, before);
      })) return { updated: false, reason: 'ownership_snapshot_changed' };
      const now = new Date(nowMs).toISOString();
      for (const scope of scopes) {
        scope.expected = snapshotScope(repositoryPath, scope.path);
        scope.lastWriterChatId = ownerChatId;
        scope.updatedAt = now;
      }
      task.ownership.events.push({ action: 'authorized_write', chatId: ownerChatId, paths: files, at: now });
      task.ownership.events = task.ownership.events.slice(-MAX_OWNERSHIP_EVENTS);
      task.lastUpdatedByChatId = ownerChatId;
      task.lastUpdatedByHostId = this.hostId;
      task.lastUpdatedAt = now;
      task.revision += 1;
      task.updatedAt = now;
      this._saveState(state);
      return { updated: true, taskKey, paths: files, revision: task.revision };
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
    if (['integrating', 'reviewing', 'completed'].includes(normalized.status) && normalized.evidenceRefs.length === 0) {
      throw new Error(`${normalized.status === 'completed' ? 'completion' : normalized.status} requires at least one evidence reference`);
    }
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
      if (task.status !== normalized.status && !allowed?.has(normalized.status)) throw new Error(`invalid task transition: ${task.status} -> ${normalized.status}`);
      const evidenceRefs = [...new Set([...(task.checkpoint?.evidenceRefs || []), ...normalized.evidenceRefs])].slice(-20);
      if (normalized.status === 'completed') verifyCompletionIntegration(task, evidenceRefs);
      const updatedAt = new Date(nowMs).toISOString();
      task.status = normalized.status;
      task.checkpoint = {
        nextAction: normalized.nextAction,
        blocker: normalized.blocker,
        evidenceRefs
      };
      task.lastUpdatedByChatId = normalized.ownerChatId;
      task.lastUpdatedByHostId = this.hostId;
      task.lastUpdatedAt = updatedAt;
      if (normalized.status === 'blocked' || normalized.status === 'completed' || normalized.status === 'failed') {
        task.ownerChatId = null;
        task.leaseExpiresAt = null;
        task.leasePaths = [];
      }
      task.revision += 1;
      task.updatedAt = updatedAt;
      const result = { updated: true, task: clone(task) };
      this._remember(state, replay, result);
      this._saveState(state);
      return result;
    });
  }

  async recordExecutorProgress(input = {}) {
    const taskKey = printableString(input.taskKey, 'taskKey', 128);
    const ownerChatId = printableString(input.ownerChatId, 'ownerChatId', 256);
    const idempotencyKey = printableString(input.idempotencyKey, 'idempotencyKey', 160);
    const executorId = printableString(input.executorId, 'executorId', 160);
    const status = input.status;
    const sessionId = input.sessionId == null ? null : printableString(input.sessionId, 'sessionId', 256);
    const resultText = printableString(input.result || '', 'result', MAX_EXECUTOR_RESULT_LENGTH, false);
    const reason = printableString(input.reason || '', 'reason', 2000, false);
    const error = printableString(input.error || '', 'error', 2000, false);
    const executionEvidence = normalizeExecutionEvidence(input.executionEvidence);
    if (!TASK_KEY.test(taskKey)) throw new TypeError('taskKey must be a stable alphanumeric key');
    if (!['running', 'completed', 'blocked', 'failed'].includes(status)) throw new TypeError('executor status is not supported');
    const request = { taskKey, ownerChatId, executorId, status, sessionId, result: resultText, reason, error, executionEvidence };
    return this._withWriteLock(`task-registry:executor-progress:${taskKey}`, async () => {
      const state = this._loadState();
      const replay = this._idempotencyReplay(state, 'executor-progress', idempotencyKey, request);
      if (replay.result) return replay.result;
      const task = state.tasks.find(item => item.taskKey === taskKey);
      const nowMs = this.clock();
      if (!task || !task.execution) {
        const response = { updated: false, reason: task ? 'execution_plan_missing' : 'task_not_found', taskKey };
        this._remember(state, replay, response);
        this._saveState(state);
        return response;
      }
      if (task.ownerChatId !== ownerChatId || !task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) <= nowMs) {
        const response = { updated: false, reason: 'claim_not_held', taskKey, status: task.status, revision: task.revision };
        this._remember(state, replay, response);
        this._saveState(state);
        return response;
      }
      const index = Number(executorId.slice(`${taskKey}-`.length)) - 1;
      const progress = task.executionProgress || initialExecutionProgress(taskKey, task.execution, task.createdAt);
      const executor = progress?.[index];
      if (!executor || executor.id !== executorId) throw new Error('executor ID is outside the saved plan');
      const allowedProgress = {
        queued: new Set(['running']),
        running: new Set(['completed', 'blocked', 'failed']),
        completed: new Set(), blocked: new Set(), failed: new Set()
      };
      if (!allowedProgress[executor.status]?.has(status)) throw new Error(`invalid executor transition: ${executor.status} -> ${status}`);
      if (status === 'running') {
        executor.attempt += 1;
        executor.result = '';
        executor.reason = '';
        executor.error = '';
        executor.executionEvidence = null;
        executor.sessionId = sessionId || executor.sessionId;
      } else {
        executor.result = resultText;
        executor.reason = reason;
        executor.error = error;
        executor.executionEvidence = executionEvidence;
        executor.sessionId = sessionId || executor.sessionId;
      }
      executor.status = status;
      executor.updatedAt = new Date(nowMs).toISOString();
      task.executionProgress = progress;
      task.lastUpdatedByChatId = ownerChatId;
      task.lastUpdatedByHostId = this.hostId;
      task.lastUpdatedAt = executor.updatedAt;

      if (status === 'running' && task.status === 'claimed') {
        task.status = 'executing';
        task.checkpoint = { nextAction: '하위 작업을 실행 중입니다. 모든 결과를 기록한 뒤 검토 단계로 이동합니다.',
          blocker: task.checkpoint?.blocker || '', evidenceRefs: [] };
      }
      const allTerminal = progress.length > 0 && progress.every(item => ['completed', 'blocked', 'failed'].includes(item.status));
      if (allTerminal && task.status === 'executing') {
        const blocked = progress.filter(item => item.status === 'blocked');
        const failed = progress.filter(item => item.status === 'failed');
        if (blocked.length || failed.length) {
          task.status = 'blocked';
          task.ownerChatId = null;
          task.leaseExpiresAt = null;
          const detail = [...blocked.map(item => `${item.title}: ${item.reason || '차단됨'}`),
            ...failed.map(item => `${item.title}: ${item.error || '실패함'}`)].join(' · ').slice(0, 1900);
          task.checkpoint = { nextAction: '저장된 하위 작업 결과를 검토하고, 실패 원인을 해결한 뒤 명시적으로 재개합니다.', blocker: detail || '하위 작업이 완료되지 않았습니다.', evidenceRefs: [] };
        } else {
          task.status = 'verifying';
          task.checkpoint = {
            nextAction: '모든 하위 실행자 결과를 검토하고 통합 검증 증거를 기록합니다.', blocker: '',
            evidenceRefs: progress.map(item => `executor-result:${item.id}:attempt-${item.attempt}`)
          };
        }
      }
      task.leasePaths = taskLeasePaths(task);
      task.revision += 1;
      task.updatedAt = new Date(nowMs).toISOString();
      const response = { updated: true, task: clone(task) };
      this._remember(state, replay, response);
      this._saveState(state);
      return response;
    });
  }

  async resumeExecutorPlan(input = {}) {
    const taskKey = printableString(input.taskKey, 'taskKey', 128);
    const ownerChatId = printableString(input.ownerChatId, 'ownerChatId', 256);
    const idempotencyKey = printableString(input.idempotencyKey, 'idempotencyKey', 160);
    const leaseMs = input.leaseMs === undefined ? MAX_LEASE_MS : input.leaseMs;
    if (!TASK_KEY.test(taskKey)) throw new TypeError('taskKey must be a stable alphanumeric key');
    if (!Number.isSafeInteger(leaseMs) || leaseMs < MIN_LEASE_MS || leaseMs > MAX_LEASE_MS) throw new RangeError('leaseMs is invalid');
    const request = { taskKey, ownerChatId, leaseMs };
    return this._withWriteLock(`task-registry:executor-resume:${taskKey}`, async () => {
      const state = this._loadState();
      const replay = this._idempotencyReplay(state, 'executor-resume', idempotencyKey, request);
      if (replay.result) return { ...replay.result, replayed: true };
      const task = state.tasks.find(item => item.taskKey === taskKey);
      const nowMs = this.clock();
      const reject = (reason, extra = {}) => {
        const response = { accepted: false, reason, taskKey, ...extra };
        this._remember(state, replay, response);
        this._saveState(state);
        return response;
      };
      if (!task) return reject('task_not_found');
      if (!task.execution) return reject('execution_plan_missing');
      if (!['blocked', 'claimed', 'executing'].includes(task.status)) return reject(`task_${task.status}`, { status: task.status });
      if (task.ownerChatId && task.leaseExpiresAt && Date.parse(task.leaseExpiresAt) > nowMs) {
        return reject('task_still_leased', { status: task.status, ownerChatId: task.ownerChatId,
          leaseExpiresAt: task.leaseExpiresAt, blockingTask: blockingTaskDetails(task, task.leasePaths || task.paths) });
      }
      if (!task.ownership) return reject('ownership_snapshot_missing', { status: task.status });
      const changedPaths = task.ownership.scopes.filter(scope => !equalSnapshot(scope.expected,
        snapshotScope(task.repositoryPath, scope.path))).map(scope => scope.path);
      if (changedPaths.length) return reject('path_content_changed', { status: task.status, changedPaths });
      const progress = task.executionProgress || initialExecutionProgress(taskKey, task.execution, task.createdAt);
      const retryable = progress.filter(item => item.status !== 'completed');
      if (!retryable.length) return reject('no_incomplete_executors', { status: task.status });
      const now = new Date(nowMs).toISOString();
      const queuedItems = [];
      const blockedExecutors = [];
      for (const item of retryable) {
        const index = Number(item.id.slice(`${taskKey}-`.length)) - 1;
        const planned = task.execution.tasks[index];
        if (!planned) return reject('executor_plan_record_mismatch', { executorId: item.id });
        const conflicts = state.tasks.filter(other => other.taskKey !== task.taskKey
          && other.repositoryPath === task.repositoryPath && other.ownerChatId
          && Date.parse(other.leaseExpiresAt) > nowMs && pathsOverlap(other.leasePaths || other.paths, planned.files));
        if (conflicts.length) {
          const blockingTasks = conflicts.map(other => blockingTaskDetails(
            other, overlappingPathDetails(other.leasePaths || other.paths, planned.files)));
          const reason = blockingTasks.map(other =>
            `${blockingTaskSummary(conflicts.find(task => task.taskKey === other.taskKey))} · 충돌 경로 ${other.paths.join(', ') || '범위 확인 필요'}`
          ).join(' | ').slice(0, 2000);
          if (item.reason !== reason) {
            const hasAttemptData = item.attempt > 0 || item.status !== 'queued' || item.sessionId || item.result || item.reason || item.error || item.executionEvidence;
            if (hasAttemptData) {
              item.history ||= [];
              item.history.push({ attempt: item.attempt, status: item.status === 'running' ? 'interrupted' : item.status,
                sessionId: item.sessionId, result: item.result, reason: item.reason, error: item.error,
                executionEvidence: item.executionEvidence, updatedAt: item.updatedAt });
            }
          }
          item.status = 'blocked';
          item.reason = reason;
          item.error = '';
          item.result = '';
          item.executionEvidence = null;
          item.updatedAt = now;
          blockedExecutors.push({ id: item.id, title: planned.title, reason, blockingTasks });
          continue;
        }
        const hasAttemptData = item.attempt > 0 || item.status !== 'queued' || item.sessionId || item.result || item.reason || item.error || item.executionEvidence;
        if (hasAttemptData) {
          item.history ||= [];
          item.history.push({ attempt: item.attempt, status: item.status === 'running' ? 'interrupted' : item.status,
            sessionId: item.sessionId, result: item.result, reason: item.reason, error: item.error,
            executionEvidence: item.executionEvidence, updatedAt: item.updatedAt });
        }
        item.status = 'queued';
        item.sessionId = null;
        item.result = '';
        item.reason = '';
        item.error = '';
        item.executionEvidence = null;
        item.updatedAt = now;
        queuedItems.push(item);
      }
      task.executionProgress = progress;
      if (!queuedItems.length) {
        const firstBlocker = blockedExecutors[0]?.blockingTasks?.[0] || {};
        const blocker = blockedExecutors.map(item => `${item.title}: ${item.reason}`).join('\n').slice(0, 1900);
        task.status = 'blocked';
        task.ownerChatId = null;
        task.leaseExpiresAt = null;
        task.leasePaths = [];
        task.lastUpdatedByChatId = ownerChatId;
        task.lastUpdatedByHostId = this.hostId;
        task.lastUpdatedAt = now;
        task.checkpoint = {
          nextAction: '충돌 경로의 임대가 끝나면 저장된 미완료 하위 작업만 다시 재개합니다. 겹치지 않는 경로의 다른 작업은 계속할 수 있습니다.',
          blocker, evidenceRefs: []
        };
        task.revision += 1;
        task.updatedAt = now;
        const response = { accepted: false, reason: 'path_scope_conflict', taskKey, status: task.status,
          blockingTaskKey: firstBlocker.taskKey, ownerChatId: firstBlocker.ownerChatId,
          leaseExpiresAt: firstBlocker.leaseExpiresAt, paths: firstBlocker.paths || [], blockedExecutors };
        this._remember(state, replay, response);
        this._saveState(state);
        return response;
      }
      task.status = 'claimed';
      task.ownerChatId = ownerChatId;
      task.leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();
      task.leasePaths = normalizeLeasePaths(queuedItems.flatMap(item => {
        const index = Number(item.id.slice(`${taskKey}-`.length)) - 1;
        return task.execution.tasks[index].files;
      }));
      task.lastUpdatedByChatId = ownerChatId;
      task.lastUpdatedByHostId = this.hostId;
      task.lastUpdatedAt = now;
      task.checkpoint = {
        nextAction: `잠금 없는 미완료 하위 작업 ${queuedItems.length}개를 대기열에 넣습니다.`,
        blocker: blockedExecutors.map(item => `${item.title}: ${item.reason}`).join('\n').slice(0, 1900),
        evidenceRefs: []
      };
      task.revision += 1;
      task.updatedAt = now;
      const tasks = queuedItems.map(item => {
        const index = Number(item.id.slice(`${taskKey}-`.length)) - 1;
        const planned = task.execution.tasks[index];
        return { id: item.id, title: planned.title, prompt: planned.prompt, files: planned.files, allowedTools: planned.allowedTools };
      });
      const response = { accepted: true, taskKey, ownerChatId, leaseExpiresAt: task.leaseExpiresAt,
        status: task.status, revision: task.revision, queuedCount: tasks.length, blockedExecutors, tasks };
      this._remember(state, replay, response);
      this._saveState(state);
      return response;
    });
  }

  async sendMessage(input = {}) {
    const type = input.type === undefined ? 'message' : input.type;
    const normalized = {
      taskKey: printableString(input.taskKey, 'taskKey', 128),
      senderChatId: printableString(input.senderChatId, 'senderChatId', 256),
      recipientChatId: input.recipientChatId ? printableString(input.recipientChatId, 'recipientChatId', 256) : null,
      senderHostId: this.hostId,
      recipientHostId: input.recipientHostId === undefined || input.recipientHostId === null
        ? this.hostId
        : printableString(input.recipientHostId, 'recipientHostId', 36),
      type,
      text: printableString(input.text, 'text', MAX_MESSAGE_LENGTH),
      inReplyToMessageId: input.inReplyToMessageId ? printableString(input.inReplyToMessageId, 'inReplyToMessageId', 64) : null,
      idempotencyKey: printableString(input.idempotencyKey, 'idempotencyKey', 160)
    };
    if (!TASK_KEY.test(normalized.taskKey)) throw new TypeError('taskKey must be a stable alphanumeric key');
    if (!HOST_ID.test(normalized.recipientHostId)) throw new TypeError('recipientHostId must be a UUID v4 host identity');
    if (!['message', 'ack'].includes(normalized.type)) throw new TypeError('message type must be message or ack');
    if (normalized.type === 'ack' && !normalized.inReplyToMessageId) throw new TypeError('ACK must reference a message');
    const request = { ...normalized };
    delete request.idempotencyKey;
    return this._withWriteLock(`task-registry:message:${normalized.taskKey}`, async () => {
      const state = this._loadState();
      const replay = this._idempotencyReplay(state, 'message', normalized.idempotencyKey, request);
      if (replay.result) {
        if (!replay.result.messageId) return replay.result;
        const prior = state.messages.find(message => message.messageId === replay.result.messageId);
        if (!prior) throw new Error('idempotent task message record is missing');
        return { sent: true, replayed: true, message: clone(prior) };
      }
      const task = state.tasks.find(item => item.taskKey === normalized.taskKey);
      if (!task) {
        const result = { sent: false, reason: 'task_not_found', taskKey: normalized.taskKey };
        this._remember(state, replay, result);
        this._saveState(state);
        return result;
      }
      if (state.messages.length >= MAX_MESSAGES) throw new Error('task registry message capacity reached; preserve messages and review retention');
      if (normalized.type === 'ack') {
        const original = state.messages.find(message => message.messageId === normalized.inReplyToMessageId);
        if (!original || original.taskKey !== normalized.taskKey || original.type !== 'message') throw new Error('ACK must reference a message in this task');
        const originalRecipientHostId = original.recipientHostId || this.hostId;
        if (originalRecipientHostId !== this.hostId) throw new Error('only the message recipient host may acknowledge it');
        if (original.recipientChatId && original.recipientChatId !== normalized.senderChatId) throw new Error('only the message recipient may acknowledge it');
        if (normalized.recipientChatId && normalized.recipientChatId !== original.senderChatId) throw new Error('ACK recipient must be the original sender');
        normalized.recipientChatId = original.senderChatId;
        normalized.recipientHostId = original.senderHostId || this.hostId;
      }
      const message = {
        messageId: crypto.randomUUID(), taskKey: normalized.taskKey, senderChatId: normalized.senderChatId,
        senderHostId: normalized.senderHostId, recipientChatId: normalized.recipientChatId,
        recipientHostId: normalized.recipientHostId, type: normalized.type, text: normalized.text,
        inReplyToMessageId: normalized.inReplyToMessageId, createdAt: new Date(this.clock()).toISOString()
      };
      state.messages.push(message);
      this._remember(state, replay, { sent: true, messageId: message.messageId });
      this._saveState(state);
      return { sent: true, replayed: false, message: clone(message) };
    });
  }

  async importRemoteMessage(input = {}) {
    const message = normalizeRemoteMessageEnvelope(input, this.hostId);
    return this._withWriteLock(`task-registry:import-message:${message.taskKey}`, async () => {
      const state = this._loadState();
      const existing = state.messages.find(item => item.messageId === message.messageId);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(message)) throw new Error('remote message ID was reused with different content');
        return { imported: false, replayed: true, message: clone(existing) };
      }
      if (!state.tasks.some(task => task.taskKey === message.taskKey)) {
        return { imported: false, reason: 'task_not_found', taskKey: message.taskKey };
      }
      if (state.messages.length >= MAX_MESSAGES) throw new Error('task registry message capacity reached; preserve messages and review retention');
      if (message.type === 'ack') {
        const original = state.messages.find(item => item.messageId === message.inReplyToMessageId);
        if (!original || original.taskKey !== message.taskKey || original.type !== 'message'
          || (original.senderHostId || this.hostId) !== this.hostId
          || (original.recipientHostId || this.hostId) !== message.senderHostId
          || (original.recipientChatId && original.recipientChatId !== message.senderChatId)
          || message.recipientChatId !== original.senderChatId) {
          throw new Error('remote ACK does not match the locally sent message and recipient');
        }
      }
      state.messages.push(message);
      this._saveState(state);
      return { imported: true, replayed: false, message: clone(message) };
    });
  }

  listMessages(input = {}) {
    const taskKey = printableString(input.taskKey, 'taskKey', 128);
    const viewerChatId = printableString(input.viewerChatId, 'viewerChatId', 256);
    const limit = input.limit === undefined ? 50 : input.limit;
    if (!TASK_KEY.test(taskKey)) throw new TypeError('taskKey must be a stable alphanumeric key');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('message limit must be 1–100');
    const state = this._loadState();
    if (!state.tasks.some(task => task.taskKey === taskKey)) throw new Error('task not found');
    const visible = state.messages.filter(message => {
      if (message.taskKey !== taskKey) return false;
      const senderHostId = message.senderHostId || this.hostId;
      const recipientHostId = message.recipientHostId || this.hostId;
      const isSender = senderHostId === this.hostId && message.senderChatId === viewerChatId;
      const isRecipient = recipientHostId === this.hostId
        && (message.recipientChatId === null || message.recipientChatId === viewerChatId);
      return isSender || isRecipient;
    });
    let start = 0;
    if (input.afterMessageId !== undefined && input.afterMessageId !== null) {
      const cursor = visible.findIndex(message => message.messageId === input.afterMessageId);
      if (cursor < 0) throw new Error('message cursor is not visible in this task');
      start = cursor + 1;
    }
    return clone(visible.slice(start, start + limit));
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
