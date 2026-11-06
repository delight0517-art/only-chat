'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { execFileSync } = require('node:child_process');

function processIdentity(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return `linux:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
    }
    if (process.platform === 'darwin') {
      const birth = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='],
        { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return birth ? `darwin:${birth}` : null;
    }
  } catch (_) {}
  return null; // Unsupported or unobservable identity never authorizes reclaim.
}

function aborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('작업공간 대기가 취소되었습니다.');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  throw error;
}

function waitForRetry(ms, signal) {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      try { aborted(signal); } catch (error) { reject(error); }
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

class WorkspaceExecutionLease {
  constructor(options = {}) {
    this.lockRoot = path.resolve(options.lockRoot || path.join(os.homedir(), '.my-codex', 'workspace-leases'));
    this.context = new AsyncLocalStorage();
    this.waitMs = Number.isSafeInteger(options.waitMs) && options.waitMs >= 0 ? Math.min(options.waitMs, 60_000) : 0;
    this.retryMs = Number.isSafeInteger(options.retryMs) ? Math.max(10, Math.min(options.retryMs, 1000)) : 100;
    this.processIdentity = options.processIdentity || processIdentity;
  }

  _workspaceKey(workspaceDir) {
    const resolved = path.resolve(workspaceDir);
    let canonical = resolved;
    try { canonical = fs.realpathSync(resolved); } catch (_) {}
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  _isStaleOwner(owner) {
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)
      || owner.host !== os.hostname()
      || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || typeof owner.startedAt !== 'string' || !Number.isFinite(Date.parse(owner.startedAt))) return false;
    try {
      process.kill(owner.pid, 0);
      const currentIdentity = owner.processIdentity ? this.processIdentity(owner.pid) : null;
      return Boolean(currentIdentity && currentIdentity !== owner.processIdentity);
    } catch (error) {
      return error.code === 'ESRCH';
    }
  }

  _ownerStatus(owner, state, sameHost) {
    return {
      state,
      sameHost,
      sourceChatId: typeof owner.sessionId === 'string' && owner.sessionId.trim() && owner.sessionId.length <= 256
        ? owner.sessionId : null,
      host: owner.host,
      pid: Number.isSafeInteger(owner.pid) && owner.pid > 0 ? owner.pid : null,
      startedAt: typeof owner.startedAt === 'string' && Number.isFinite(Date.parse(owner.startedAt))
        ? owner.startedAt : null,
      leaseExpiresAt: null,
      releaseCondition: sameHost === true
        ? 'operation_completion_or_verified_process_death'
        : 'owner_operation_completion_or_explicit_owner_release'
    };
  }

  getStatus(workspaceDir) {
    const unknown = reason => ({ state: 'unknown', sameHost: null, reason });
    try {
      const lockPath = path.join(this.lockRoot, `${this._workspaceKey(workspaceDir)}.lock`);
      let raw;
      try {
        raw = fs.readFileSync(lockPath, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return { state: 'free', sameHost: null };
        return unknown('lock_unreadable');
      }

      let owner;
      try { owner = JSON.parse(raw); } catch (_) { return unknown('lock_record_invalid_json'); }
      if (!owner || typeof owner !== 'object' || Array.isArray(owner) || typeof owner.host !== 'string' || !owner.host) {
        return unknown('owner_host_missing');
      }
      if (owner.host !== os.hostname()) return this._ownerStatus(owner, 'held', false);
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return unknown('owner_pid_unavailable');
      const startedAt = typeof owner.startedAt === 'string' && Number.isFinite(Date.parse(owner.startedAt))
        ? owner.startedAt : null;
      if (!startedAt) return unknown('owner_start_time_unavailable');

      try {
        process.kill(owner.pid, 0);
        if (this._isStaleOwner(owner)) return this._ownerStatus(owner, 'stale', true);
        return this._ownerStatus(owner, 'held', true);
      } catch (error) {
        if (error.code === 'EPERM') return this._ownerStatus(owner, 'held', true);
        if (error.code === 'ESRCH') return this._ownerStatus(owner, 'stale', true);
        return unknown('owner_process_status_unavailable');
      }
    } catch (_) {
      return unknown('workspace_lease_status_failed');
    }
  }

  getEvidence(workspaceDir) {
    return { ...this.getStatus(workspaceDir), scope: 'workspace_execution',
      resourceKey: this._workspaceKey(workspaceDir), repositoryWide: false,
      readAt: new Date().toISOString() };
  }

  async waitUntilAvailable(workspaceDir, { signal, waitMs = 30_000 } = {}) {
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60_000) throw new RangeError('lease waitMs must be 0–60000');
    const started = performance.now();
    for (;;) {
      aborted(signal);
      const evidence = this.getEvidence(workspaceDir);
      if (evidence.state === 'free' || (evidence.state === 'stale' && evidence.sameHost === true)) {
        return { ready: true, evidence };
      }
      if (evidence.state !== 'held' || evidence.sameHost !== true) return { ready: false, reason: 'owner_unverified', evidence };
      const remaining = waitMs - (performance.now() - started);
      if (remaining <= 0) return { ready: false, reason: 'owner_still_active', evidence };
      await waitForRetry(Math.min(this.retryMs, remaining), signal);
    }
  }

  _readOwner(lockPath) {
    try {
      return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      const failure = new Error('Only Chat 작업공간 잠금 정보를 읽을 수 없습니다. 파일을 임의로 지우지 말고 상태를 확인해 주세요.');
      failure.code = 'WORKSPACE_LEASE_UNREADABLE';
      throw failure;
    }
  }

  _tryAcquire(lockPath, owner) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(owner));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
  }

  _tryReclaimAndAcquire(lockPath, owner) {
    const reclaimPath = `${lockPath}.reclaim`;
    const reclaimToken = crypto.randomUUID();
    const reclaimOwner = { token: reclaimToken, pid: process.pid, host: os.hostname() };
    if (!this._tryAcquire(reclaimPath, reclaimOwner)) return false;
    try {
      const existing = this._readOwner(lockPath);
      if (!this._isStaleOwner(existing)) return false;
      try { fs.unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return this._tryAcquire(lockPath, owner);
    } finally {
      const currentReclaimer = this._readOwner(reclaimPath);
      if (currentReclaimer?.token === reclaimToken) {
        try { fs.unlinkSync(reclaimPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }

  async run(workspaceDir, sessionId, operation, options = {}) {
    aborted(options.signal);
    const key = this._workspaceKey(workspaceDir);
    const current = this.context.getStore();
    if (current?.key === key && current.active) return operation();

    fs.mkdirSync(this.lockRoot, { recursive: true, mode: 0o700 });
    const lockPath = path.join(this.lockRoot, `${key}.lock`);
    const token = crypto.randomUUID();
    const owner = {
      token,
      workspace: path.resolve(workspaceDir),
      sessionId: String(sessionId || 'unknown'),
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date().toISOString(),
      processIdentity: this.processIdentity(process.pid)
    };

    const waitMs = options.waitMs ?? this.waitMs;
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60_000) throw new RangeError('lease waitMs must be 0–60000');
    const started = performance.now();
    let notified = false;
    for (;;) {
      aborted(options.signal);
      let acquired = this._tryAcquire(lockPath, owner);
      if (!acquired) {
        try { acquired = this._tryReclaimAndAcquire(lockPath, owner); }
        catch (error) { if (error.code !== 'WORKSPACE_LEASE_UNREADABLE') throw error; }
      }
      if (acquired) break;
      const evidence = this.getEvidence(workspaceDir);
      const waitedMs = Math.round(performance.now() - started);
      if (waitedMs >= waitMs) {
        const reason = evidence.state === 'unknown'
          ? 'Only Chat 작업공간 잠금 정보를 읽을 수 없습니다.'
          : '이 작업공간은 다른 Only Chat 작업이 사용 중입니다.';
        const error = new Error(`${reason} 이 작업공간의 실행만 대기하며 다른 작업공간은 계속 사용할 수 있습니다.`);
        Object.assign(error, { code: 'WORKSPACE_BUSY', retryable: true,
          waitedMs, evidence, nextAction: 'retry_workspace_after_owner_release' });
        throw error;
      }
      if (!notified) {
        notified = true;
        // Observability must not interrupt ownership or the queued operation.
        try { options.onWait?.({ ...evidence, waitedMs, waitMs }); } catch (_) {}
      }
      await waitForRetry(Math.min(this.retryMs, waitMs - waitedMs), options.signal);
    }

    const context = { key, token, active: true };
    try {
      aborted(options.signal);
      return await this.context.run(context, operation);
    } finally {
      context.active = false;
      const currentOwner = this._readOwner(lockPath);
      if (currentOwner?.token === token) {
        try { fs.unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }
}

module.exports = { WorkspaceExecutionLease };
