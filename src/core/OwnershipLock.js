/**
 * @project My-Codex
 * @provenance:rogan-core
 * @author Rogan Kim (GeunHu Kim) & AI Architect
 * @license MIT
 * @description File Ownership Lock and Uncommitted Git Change Guard.
 * Prevents concurrent workers from creating divergent conflicting edits on shared files.
 */
'use strict';

const path = require('node:path');
const { execSync } = require('node:child_process');

class OwnershipLock {
  constructor(options = {}) {
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.leaseTtlMs = Number.isFinite(options.leaseTtlMs) && options.leaseTtlMs > 0 ? options.leaseTtlMs : 10 * 60_000;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.locks = new Map(); // normalizedFilePath -> { taskId, acquiredAt, expiresAt }
    this.registeredModules = new Map(); // moduleName -> { kind: 'ui'|'logic'|'font', path }
  }

  normalizePath(filePath) {
    if (path.isAbsolute(filePath)) {
      return path.normalize(filePath);
    }
    return path.normalize(path.resolve(this.workspaceDir, filePath));
  }

  /**
   * Remove expired file locks so aborted or timed-out workers never block future tasks forever.
   */
  pruneExpiredLocks() {
    const currentNow = this.now();
    const reclaimed = [];
    for (const [filePath, holder] of this.locks.entries()) {
      if (Number.isFinite(holder.expiresAt) && holder.expiresAt <= currentNow) {
        this.locks.delete(filePath);
        reclaimed.push({ file: filePath, taskId: holder.taskId, acquiredAt: holder.acquiredAt, expiresAt: holder.expiresAt });
      }
    }
    return reclaimed;
  }

  /** Acquire conflict-free paths; overlapping paths remain available to their current owner. */
  acquireLocks(taskId, filePaths = [], options = {}) {
    this.pruneExpiredLocks();
    const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : this.leaseTtlMs;
    const normalized = [...new Set(filePaths.map(f => this.normalizePath(f)))];
    const acquiredPaths = [];
    const blockedPaths = [];
    const blockers = [];

    for (const requested of normalized) {
      const conflicts = [...this.locks.entries()].filter(([locked, holder]) =>
        holder.taskId !== taskId && pathsOverlap(requested, locked));
      if (conflicts.length) {
        blockedPaths.push(requested);
        for (const [file, holder] of conflicts) {
          blockers.push({ requestedPath: requested, file, taskId: holder.taskId, expiresAt: holder.expiresAt });
        }
      } else {
        acquiredPaths.push(requested);
      }
    }

    // Keep independent files usable when another task owns only part of a batch.
    const currentNow = this.now();
    for (const f of acquiredPaths) {
      const existing = this.locks.get(f);
      this.locks.set(f, {
        taskId,
        acquiredAt: existing?.taskId === taskId ? existing.acquiredAt : currentNow,
        expiresAt: currentNow + ttlMs
      });
    }

    const firstBlocker = blockers[0];
    const firstRequested = firstBlocker?.requestedPath;
    const firstHolder = firstBlocker?.taskId;
    const reason = firstBlocker
      ? `파일 '${path.basename(firstRequested)}' 은 현재 작업 '${firstHolder}' 에 의해 수정 중입니다. 겹치는 경로만 대기하고 나머지 파일은 계속 처리할 수 있습니다.`
      : null;
    return {
      acquired: blockedPaths.length === 0,
      partial: acquiredPaths.length > 0 && blockedPaths.length > 0,
      // These fields describe only this request's paths; this lock has no repository-wide state.
      status: blockedPaths.length === 0 ? 'acquired' : acquiredPaths.length ? 'partial' : 'blocked',
      scope: 'requested_paths',
      repositoryWide: false,
      requestedPaths: normalized,
      acquiredPaths,
      blockedPaths,
      blockers,
      ...(firstBlocker ? {
        blockedByFile: firstBlocker.file,
        holderTaskId: firstHolder,
        reason
      } : {})
    };
  }

  /**
   * Release locks when a task completes or fails
   */
  releaseLocks(taskId, filePaths = null) {
    const releaseSet = filePaths ? new Set(filePaths.map(f => this.normalizePath(f))) : null;
    for (const [f, holder] of this.locks.entries()) {
      if (holder.taskId === taskId && (!releaseSet || releaseSet.has(f))) this.locks.delete(f);
    }
  }

  /**
   * Extend active locks held by `taskId`.
   */
  renewLocks(taskId, filePaths = null, ttlMs = this.leaseTtlMs) {
    this.pruneExpiredLocks();
    const renewSet = filePaths ? new Set(filePaths.map(f => this.normalizePath(f))) : null;
    const currentNow = this.now();
    let renewed = 0;
    for (const [f, holder] of this.locks.entries()) {
      if (holder.taskId === taskId && (!renewSet || renewSet.has(f))) {
        holder.expiresAt = currentNow + ttlMs;
        renewed += 1;
      }
    }
    return renewed;
  }

  /**
   * Hand off locks from `fromTaskId` to `toTaskId` when authorized.
   */
  transferLocks(fromTaskId, toTaskId, filePaths = null, ttlMs = this.leaseTtlMs) {
    this.pruneExpiredLocks();
    const transferSet = filePaths ? new Set(filePaths.map(f => this.normalizePath(f))) : null;
    const currentNow = this.now();
    const transferred = [];
    for (const [f, holder] of this.locks.entries()) {
      if (holder.taskId === fromTaskId && (!transferSet || transferSet.has(f))) {
        this.locks.set(f, { taskId: toTaskId, acquiredAt: currentNow, expiresAt: currentNow + ttlMs });
        transferred.push(f);
      }
    }
    return transferred;
  }

  /**
   * Scan git status for uncommitted modifications to prevent branch divergence
   */
  getUncommittedChanges() {
    return this.getGitStatus().uncommitted;
  }

  /**
   * Return a privacy-safe Git status result. `available` means the command
   * succeeded, including the clean-repository case with an empty array.
   */
  getGitStatus() {
    try {
      const output = execSync('git status --porcelain', {
        cwd: this.workspaceDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const lines = output.trim().split('\n').filter(Boolean);
      const uncommitted = lines.map(line => {
        const code = line.substring(0, 2).trim();
        const file = line.substring(3).trim();
        return { code, file, path: this.normalizePath(file) };
      });
      return { available: true, error: null, uncommitted };
    } catch (_) {
      // Do not expose stderr, command details, or workspace paths.
      return { available: false, error: 'git_status_unavailable', uncommitted: [] };
    }
  }

  /**
   * Register a decoupled module (e.g. UI, Font, Logic) in the Hub
   */
  registerModule(name, kind, relPath) {
    this.registeredModules.set(name, {
      name,
      kind, // 'ui', 'logic', 'design', 'font'
      path: this.normalizePath(relPath),
      registeredAt: Date.now()
    });
  }

  getModules() {
    return Array.from(this.registeredModules.values());
  }

  getActiveLocks() {
    this.pruneExpiredLocks();
    return Array.from(this.locks.entries()).map(([filePath, holder]) => ({
      file: filePath,
      fileName: path.basename(filePath),
      taskId: holder.taskId,
      acquiredAt: holder.acquiredAt,
      expiresAt: holder.expiresAt
    }));
  }
}

function pathsOverlap(left, right) {
  return isSameOrWithin(left, right) || isSameOrWithin(right, left);
}

function isSameOrWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

module.exports = { OwnershipLock };
