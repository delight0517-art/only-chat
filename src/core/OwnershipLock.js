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
    this.locks = new Map(); // normalizedFilePath -> { taskId, acquiredAt }
    this.registeredModules = new Map(); // moduleName -> { kind: 'ui'|'logic'|'font', path }
  }

  normalizePath(filePath) {
    if (path.isAbsolute(filePath)) {
      return path.normalize(filePath);
    }
    return path.normalize(path.resolve(this.workspaceDir, filePath));
  }

  /**
   * Acquire exclusive lock for a set of files for a specific task
   */
  acquireLocks(taskId, filePaths = []) {
    const normalized = filePaths.map(f => this.normalizePath(f));

    // Check if any file is already locked by a different task
    for (const f of normalized) {
      if (this.locks.has(f)) {
        const holder = this.locks.get(f);
        if (holder.taskId !== taskId) {
          return {
            acquired: false,
            blockedByFile: f,
            holderTaskId: holder.taskId,
            reason: `파일 '${path.basename(f)}' 은 현재 작업 '${holder.taskId}' 에 의해 수정 중입니다. 병렬 충돌 방지를 위해 직렬화 대기합니다.`
          };
        }
      }
    }

    // Grant locks
    for (const f of normalized) {
      this.locks.set(f, { taskId, acquiredAt: Date.now() });
    }

    return { acquired: true };
  }

  /**
   * Release locks when a task completes or fails
   */
  releaseLocks(taskId) {
    for (const [f, holder] of this.locks.entries()) {
      if (holder.taskId === taskId) {
        this.locks.delete(f);
      }
    }
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
    return Array.from(this.locks.entries()).map(([filePath, holder]) => ({
      file: filePath,
      fileName: path.basename(filePath),
      taskId: holder.taskId,
      acquiredAt: holder.acquiredAt
    }));
  }
}

module.exports = { OwnershipLock };
