'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

class WorkspaceExecutionLease {
  constructor(options = {}) {
    this.lockRoot = path.resolve(options.lockRoot || path.join(os.homedir(), '.my-codex', 'workspace-leases'));
    this.context = new AsyncLocalStorage();
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
      return false;
    } catch (error) {
      return error.code === 'ESRCH';
    }
  }

  getStatus(workspaceDir) {
    const unknown = { state: 'unknown', sameHost: null };
    try {
      const lockPath = path.join(this.lockRoot, `${this._workspaceKey(workspaceDir)}.lock`);
      let raw;
      try {
        raw = fs.readFileSync(lockPath, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return { state: 'free', sameHost: null };
        return unknown;
      }

      let owner;
      try { owner = JSON.parse(raw); } catch (_) { return unknown; }
      if (!owner || typeof owner !== 'object' || Array.isArray(owner) || typeof owner.host !== 'string' || !owner.host) {
        return unknown;
      }
      if (owner.host !== os.hostname()) return { state: 'held', sameHost: false };
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return unknown;
      const startedAt = typeof owner.startedAt === 'string' && Number.isFinite(Date.parse(owner.startedAt))
        ? owner.startedAt : null;
      if (!startedAt) return unknown;

      try {
        process.kill(owner.pid, 0);
        return { state: 'held', sameHost: true, pid: owner.pid, startedAt };
      } catch (error) {
        if (error.code === 'EPERM') return { state: 'held', sameHost: true, pid: owner.pid, startedAt };
        if (error.code === 'ESRCH') return { state: 'stale', sameHost: true, pid: owner.pid, startedAt };
        return unknown;
      }
    } catch (_) {
      return unknown;
    }
  }

  _readOwner(lockPath) {
    try {
      return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('Only Chat 작업공간 잠금 정보를 읽을 수 없습니다. 파일을 임의로 지우지 말고 상태를 확인해 주세요.');
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

  async run(workspaceDir, sessionId, operation) {
    const key = this._workspaceKey(workspaceDir);
    const current = this.context.getStore();
    if (current?.key === key) return operation();

    fs.mkdirSync(this.lockRoot, { recursive: true, mode: 0o700 });
    const lockPath = path.join(this.lockRoot, `${key}.lock`);
    const token = crypto.randomUUID();
    const owner = {
      token,
      workspace: path.resolve(workspaceDir),
      sessionId: String(sessionId || 'unknown'),
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date().toISOString()
    };

    const acquired = this._tryAcquire(lockPath, owner) || this._tryReclaimAndAcquire(lockPath, owner);

    if (!acquired) {
      const existing = this._readOwner(lockPath);
      const holder = existing
        ? `PID ${existing.pid}, 세션 ${existing.sessionId}, 시작 ${existing.startedAt}`
        : '잠금 생성 중인 다른 프로세스';
      throw new Error(`이 작업공간은 다른 Only Chat 작업이 사용 중입니다 (${holder}). 작업이 끝난 뒤 다시 시도해 주세요.`);
    }

    try {
      return await this.context.run({ key, token }, operation);
    } finally {
      const currentOwner = this._readOwner(lockPath);
      if (currentOwner?.token === token) {
        try { fs.unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }
}

module.exports = { WorkspaceExecutionLease };
