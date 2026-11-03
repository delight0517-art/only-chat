/**
 * @project My-Codex
 * @provenance:rogan-core
 * @author Rogan Kim (GeunHu Kim) & AI Architect
 * @license MIT
 * @description Durable Handoff and State Persistence Engine for Mac/Windows cross-sync and restart recovery.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

class HandoffAdapter {
  constructor(options = {}) {
    this.storageDir = options.storageDir || options.dataDir || path.join(os.homedir(), '.my-codex');
    this.stateFile = path.join(this.storageDir, 'handoff_state.json');
    this.gdriveHandoffDir = options.gdriveHandoffDir === false ? null : (options.gdriveHandoffDir || process.env.ONLY_CHAT_HANDOFF_DIR || null);
    this._ensureDir(this.storageDir);
  }

  _ensureDir(dir) {
    try { fs.lstatSync(dir); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('handoff storage directory is unsafe');
    fs.chmodSync(dir, 0o700);
  }

  /**
   * Save active checkpoint so that app restart resumes seamlessly
   */
  saveCheckpoint(checkpointData) {
    const dirStat = fs.lstatSync(this.storageDir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('handoff storage directory is unsafe');
    const record = {
      savedAt: Date.now(),
      platform: process.platform,
      arch: process.arch,
      ...checkpointData
    };
    this._writePrivateFile(this.stateFile, JSON.stringify(record, null, 2));

    // Also mirror to Google Drive handoff folder if accessible
    if (this.gdriveHandoffDir && fs.existsSync(this.gdriveHandoffDir)) {
      try {
        const targetPath = path.join(this.gdriveHandoffDir, 'my-codex-latest-handoff.json');
        this._writePrivateFile(targetPath, JSON.stringify(record, null, 2));
      } catch (_) {}
    }

    return record;
  }

  /**
   * Read saved checkpoint to resume incomplete work
   */
  loadCheckpoint() {
    const dirStat = fs.lstatSync(this.storageDir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null;
    try {
      const fd = fs.openSync(this.stateFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        if (!fs.fstatSync(fd).isFile()) return null;
        return JSON.parse(fs.readFileSync(fd, 'utf8'));
      } finally { fs.closeSync(fd); }
    } catch (_) { return null; }
  }

  _writePrivateFile(filePath, contents) {
    const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${require('node:crypto').randomBytes(8).toString('hex')}.tmp`);
    let fd;
    try {
      try {
        const existing = fs.lstatSync(filePath);
        if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('handoff state must be a regular file');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      if (!fs.fstatSync(fd).isFile()) throw new Error('handoff state must be a regular file');
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, contents, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(tempPath, filePath);
      if (process.platform !== 'win32') {
        try {
          const dirFd = fs.openSync(path.dirname(filePath), 'r');
          try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
        } catch (_) { /* The replacement is already committed; unsupported directory fsync cannot undo it. */ }
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(tempPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  /**
   * Generate Windows portable bootstrap script so work can immediately run on Windows
   */
  exportWindowsBundle(targetDir) {
    this._ensureDir(targetDir);
    const ps1Script = `# My-Codex Windows Fast Bootstrap & Resume Script
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "  My-Codex Windows Resume Engine (by Rogan Kim)  " -ForegroundColor Yellow
Write-Host "=================================================" -ForegroundColor Cyan

$NodeVersion = node -v 2>$null
if (-not $NodeVersion) {
    Write-Error "Node.js가 설치되어 있지 않습니다. https://nodejs.org 에서 Node.js를 설치하세요."
    Exit 1
}

Write-Host "✓ Node.js 감지: $NodeVersion" -ForegroundColor Green
Write-Host "Mac에서 전달된 최신 세션 및 작업 상태를 복원합니다..." -ForegroundColor Cyan

npm install --production
node bin/codex.js status
node bin/codex.js app
`;
    fs.writeFileSync(path.join(targetDir, 'run-windows.ps1'), ps1Script, 'utf8');
    return path.join(targetDir, 'run-windows.ps1');
  }
}

module.exports = { HandoffAdapter };
