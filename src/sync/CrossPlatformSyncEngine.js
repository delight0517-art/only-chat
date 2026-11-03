/**
 * @project Only Chat (Codex Sovereign Edition) / NCHI Sim
 * @provenance:rogan-core
 * @author Rogan Kim (GeunHu Kim) & AI Architect
 * @license MIT
 * @description Bidirectional Mac <-> Windows Live Synchronizer and Relay Engine.
 * Enables simultaneous updates, instant code/data handoff, and unified execution across platforms.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

class CrossPlatformSyncEngine {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.appDir = options.appDir || path.resolve(__dirname, '../..');
    this.appName = options.appName || 'Only Chat (NCHI Sim)';
    
    // Shared Relay Directories (Google Drive cloud anchor + local storage)
    this.gdriveRelayDir = options.gdriveRelayDir === false ? null : (options.gdriveRelayDir || process.env.ONLY_CHAT_SYNC_RELAY_DIR || null);
    this.localStateDir = options.localStateDir || path.join(
      os.homedir(), '.only-chat-sync',
      crypto.createHash('sha256').update(path.resolve(this.appDir)).digest('hex').slice(0, 12)
    );
    this.baselineFile = path.join(this.localStateDir, 'baseline.json');
    this.manifestFile = this.gdriveRelayDir && path.join(this.gdriveRelayDir, 'sync_manifest.json');
    this.sourceSyncDir = this.gdriveRelayDir && path.join(this.gdriveRelayDir, 'app_source');

    this.isWatching = false;
    this.watchers = [];
    if (this.enabled) this._ensureDirs();
  }

  _ensureDirs() {
    if (this.enabled && !this.gdriveRelayDir) throw new Error('An explicit Drive relay directory is required when sync is enabled.');
    [this.localStateDir, this.gdriveRelayDir, this.sourceSyncDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        try {
          fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
        } catch (_) {}
      }
    });
  }

  /**
   * Calculate SHA-256 hash of a file for change tracking
   */
  hashFile(filePath) {
    try {
      const content = fs.readFileSync(filePath);
      return crypto.createHash('sha256').update(content).digest('hex');
    } catch (_) {
      return null;
    }
  }

  _safePath(root, relPath) {
    if (typeof relPath !== 'string' || !relPath || path.isAbsolute(relPath) || /^[a-z]:/i.test(relPath) || relPath.split(/[\\/]/).includes('..')) return null;
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, relPath);
    return resolved.startsWith(resolvedRoot + path.sep) ? resolved : null;
  }

  _readManifest() {
    if (!fs.existsSync(this.manifestFile)) return null;
    const manifest = JSON.parse(fs.readFileSync(this.manifestFile, 'utf8'));
    if (!manifest || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
      throw new Error('Invalid sync manifest');
    }
    for (const [relPath, file] of Object.entries(manifest.files)) {
      if (!this._safePath(this.appDir, relPath) || !file || !/^[a-f0-9]{64}$/i.test(file.hash || '')) {
        throw new Error(`Invalid sync manifest entry: ${relPath}`);
      }
    }
    return manifest;
  }

  _readBaseline() {
    try {
      const value = JSON.parse(fs.readFileSync(this.baselineFile, 'utf8'));
      return value && value.files && typeof value.files === 'object' ? value.files : {};
    } catch (_) { return {}; }
  }

  _writeBaseline(files) {
    const tmp = `${this.baselineFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, files }, null, 2));
    fs.renameSync(tmp, this.baselineFile);
  }

  _collectFiles() {
    const ignoredDirs = new Set(['node_modules', '.git', '.DS_Store', 'dist']);
    const files = {};
    const visit = (dir, prefix = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ignoredDirs.has(entry.name) || entry.name.startsWith('.tmp_')) continue;
        const abs = path.join(dir, entry.name);
        const rel = path.join(prefix, entry.name).split(path.sep).join('/');
        if (entry.isDirectory()) visit(abs, rel);
        else if (entry.isFile()) {
          const stat = fs.statSync(abs);
          files[rel] = { size: stat.size, mtime: stat.mtimeMs, hash: this.hashFile(abs) };
        }
      }
    };
    visit(this.appDir);
    return files;
  }

  _relayFile(relPath) { return this._safePath(this.sourceSyncDir, relPath); }

  _copyToRelay(relPath) {
    const src = this._safePath(this.appDir, relPath);
    const dest = this._relayFile(relPath);
    if (!src || !dest) throw new Error(`Unsafe sync path: ${relPath}`);
    if (src === dest) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  _writeManifest(manifest) {
    const tmp = `${this.manifestFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8');
    fs.renameSync(tmp, this.manifestFile);
  }

  /**
   * Export all code, web design, organs, and runtime configuration to the shared relay folder
   */
  pushToRelay(sourcePlatform = process.platform) {
    if (!this.enabled) return { success: false, reason: 'Drive sync is disabled.' };
    this._ensureDirs();
    const pulled = this.pullFromRelay();
    if (!pulled.success && !pulled.conflicts?.length) return pulled;
    const existing = this._readManifest();
    const baseline = this._readBaseline();
    const files = this._collectFiles();
    const merged = { ...(existing?.files || {}) };
    const conflicts = [...(pulled.conflicts || [])];
    const updates = [];

    for (const [relPath, info] of Object.entries(files)) {
      const baseHash = baseline[relPath];
      const remoteHash = existing?.files?.[relPath]?.hash;
      const localChanged = baseHash === undefined ? remoteHash !== info.hash : info.hash !== baseHash;
      const remoteChanged = baseHash !== undefined && remoteHash !== baseHash;
      if (baseHash === undefined && remoteHash && remoteHash !== info.hash) conflicts.push(relPath);
      else if (localChanged && remoteChanged && remoteHash !== info.hash) conflicts.push(relPath);
      else if (!remoteHash || localChanged) {
        updates.push(relPath);
        merged[relPath] = info;
      }
    }
    for (const relPath of updates) this._copyToRelay(relPath);
    const manifest = {
      appName: this.appName,
      version: '1.0.0',
      pushedAt: new Date().toISOString(),
      timestamp: Date.now(),
      sourcePlatform,
      files: merged
    };

    // The relay may be the Windows app's own working tree; never copy it onto itself.
    this._generateWindowsScripts();
    this._writeManifest(manifest);
    this._writeBaseline(Object.fromEntries(Object.entries(merged).map(([file, value]) => [file, value.hash])));

    return {
      success: conflicts.length === 0,
      conflicts,
      reason: conflicts.length ? 'Concurrent edits were preserved; resolve these files before syncing.' : undefined,
      filesCount: Object.keys(manifest.files).length,
      manifestPath: this.manifestFile,
      targetDir: this.gdriveRelayDir
    };
  }

  /**
   * Pull updates from the shared relay folder into local directory if remote is newer
   */
  pullFromRelay() {
    if (!this.enabled) return { success: false, reason: 'Drive sync is disabled.' };
    if (!fs.existsSync(this.manifestFile)) {
      return { success: true, updated: false, reason: 'Manifest not found on relay' };
    }

    try {
      const manifest = this._readManifest();
      const baseline = this._readBaseline();
      const nextBaseline = { ...baseline };
      const conflicts = [];
      const copies = [];
      for (const [relPath, fileInfo] of Object.entries(manifest.files)) {
        const localPath = this._safePath(this.appDir, relPath);
        const remotePath = this._relayFile(relPath);
        if (!localPath || !remotePath || !fs.existsSync(remotePath) || this.hashFile(remotePath) !== fileInfo.hash) continue;
        const localHash = fs.existsSync(localPath) ? this.hashFile(localPath) : null;
        const baseHash = baseline[relPath];
        if (localHash === fileInfo.hash) { nextBaseline[relPath] = fileInfo.hash; continue; }
        if (baseHash === undefined && localHash !== null) { conflicts.push(relPath); continue; }
        const localChanged = localHash !== baseHash;
        const remoteChanged = fileInfo.hash !== baseHash;
        if (localChanged && remoteChanged) { conflicts.push(relPath); continue; }
        if (remoteChanged) copies.push({ relPath, localPath, remotePath, hash: fileInfo.hash });
        else nextBaseline[relPath] = baseHash;
      }

      for (const file of copies) {
        fs.mkdirSync(path.dirname(file.localPath), { recursive: true });
        if (file.localPath !== file.remotePath) fs.copyFileSync(file.remotePath, file.localPath);
        nextBaseline[file.relPath] = file.hash;
      }
      this._writeBaseline(nextBaseline);
      return { success: conflicts.length === 0, updated: copies.length > 0, updatedCount: copies.length, conflicts, remotePlatform: manifest.sourcePlatform };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Start live bidirectional file watcher.
   * Whenever local code or web design is modified, automatically push to relay!
   */
  startLiveSync(debounceMs = 1200) {
    if (!this.enabled) return { enabled: false, isWatching: false };
    if (this.isWatching) return;
    this.isWatching = true;

    let timer = null;
    let pullTimer = null;
    const triggerPush = (filename) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          const res = this.pushToRelay(process.platform);
          if (res.success) console.log(`[CrossPlatformSync] 변경 감지(${filename}): ${res.filesCount}개 파일 동기화.`);
          else console.warn('[CrossPlatformSync] Push not applied:', res.reason || res.conflicts?.join(', '));
        } catch (err) {
          console.warn('[CrossPlatformSync] Push error:', err.message);
        }
      }, debounceMs);
    };

    const watcher = fs.watch(this.appDir, { recursive: true }, (event, filename) => {
      if (!filename || filename.includes('.DS_Store') || filename.split(/[\\/]/).some(part => ['node_modules', '.git', 'dist'].includes(part) || part.startsWith('.tmp_'))) return;
      triggerPush(filename);
    });
    this.watchers.push(watcher);

    const relayWatcher = fs.watch(this.gdriveRelayDir, (event, filename) => {
      if (!filename || filename.toString() !== path.basename(this.manifestFile)) return;
      clearTimeout(pullTimer);
      pullTimer = setTimeout(() => {
        try {
          const result = this.pullFromRelay();
          if (result.conflicts?.length) console.warn('[CrossPlatformSync] Conflicts preserved:', result.conflicts.join(', '));
          else if (result.updated) console.log(`[CrossPlatformSync] Pulled ${result.updatedCount} shared file update(s).`);
        } catch (err) { console.warn('[CrossPlatformSync] Pull error:', err.message); }
      }, debounceMs);
    });
    this.watchers.push(relayWatcher);
    const initial = this.pullFromRelay();
    if (initial.conflicts?.length) console.warn('[CrossPlatformSync] Initial conflicts preserved:', initial.conflicts.join(', '));

    console.log('[CrossPlatformSync] 📡 실시간 Mac <-> Windows 양방향 동기화 감시가 시작되었습니다.');
  }

  stopLiveSync() {
    for (const w of this.watchers) {
      try { w.close(); } catch (_) {}
    }
    this.watchers = [];
    this.isWatching = false;
  }

  _generateWindowsScripts() {
    // 1. One-click PowerShell Bootstrap Runner
    const runPs1 = `# ==============================================================================
# Only Chat / NCHI Sim - Windows Native Fast Launch & Auto-Sync
# @provenance:rogan-core (Rogan Kim)
# ==============================================================================
$Host.UI.RawUI.WindowTitle = "Only Chat (NCHI Sim) - Sovereign Edition"
Clear-Host
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Only Chat · NCHI Sim Windows Sovereign Launch Engine    " -ForegroundColor Yellow
Write-Host "  [동시 업데이트 & Mac <-> Windows 양방향 실시간 동기화]     " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan

$CurrentDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$AppSourceDir = Join-Path $CurrentDir "app_source"
$env:ONLY_CHAT_SYNC_RELAY_DIR = $CurrentDir

if (-not (Test-Path $AppSourceDir)) {
    Write-Error "앱 소스 폴더(app_source)를 찾을 수 없습니다."
    Exit 1
}

Set-Location $AppSourceDir

# Node.js Check
$NodeVer = node -v 2>$null
if (-not $NodeVer) {
    Write-Host "Node.js가 감지되지 않았습니다. https://nodejs.org 에서 Node.js를 설치하세요." -ForegroundColor Red
    Exit 1
}
Write-Host "✓ Node.js 감지: $NodeVer" -ForegroundColor Green

# Install dependencies if node_modules is missing
if (-not (Test-Path "node_modules")) {
    Write-Host "필수 패키지를 설치합니다 (최초 1회)..." -ForegroundColor Yellow
    npm install --production
}

Write-Host "Only Chat 데스크톱 UI 서버를 포트 8899에서 시작합니다..." -ForegroundColor Cyan
Write-Host "브라우저에서 http://127.0.0.1:8899 로 접속하실 수 있습니다." -ForegroundColor Green

# Start App Server
node bin/codex.js app
`;

    // 2. Windows Batch Runner for double-click convenience
    const runBat = `@echo off
chcp 65001 > nul
title Only Chat (NCHI Sim) Launcher
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-windows.ps1"
pause
`;

    // 3. Windows Auto-Sync Watcher Script (Follow updates from Mac)
    const watchPs1 = `# ==============================================================================
# Windows Auto-Sync Watcher (Follows Mac updates automatically)
# ==============================================================================
$CurrentDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ManifestFile = Join-Path $CurrentDir "sync_manifest.json"
$AppSourceDir = Join-Path $CurrentDir "app_source"

Write-Host "📡 공유 동기화 매니페스트 감시 중입니다... (앱 서버가 변경 파일을 적용합니다)" -ForegroundColor Green

$LastHash = ""
while ($true) {
    if (Test-Path $ManifestFile) {
        $CurrentContent = Get-Content $ManifestFile -Raw
        $CurrentHash = [System.BitConverter]::ToString(([System.Security.Cryptography.SHA256]::Create()).ComputeHash([System.Text.Encoding]::UTF8.GetBytes($CurrentContent)))
        if ($LastHash -ne "" -and $LastHash -ne $CurrentHash) {
            try {
                $response = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8899/api/sync/pull" -TimeoutSec 3
                if ($response.conflicts.Count -gt 0) { Write-Warning "충돌 파일: $($response.conflicts -join ', ')" }
                elseif ($response.updated) { Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $($response.updatedCount)개 파일 반영" -ForegroundColor Yellow }
            } catch { Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 앱 서버가 동기화를 처리 중입니다." -ForegroundColor DarkGray }
        }
        $LastHash = $CurrentHash
    }
    Start-Sleep -Seconds 2
}
`;

    fs.writeFileSync(path.join(this.gdriveRelayDir, 'run-windows.ps1'), runPs1, 'utf8');
    fs.writeFileSync(path.join(this.gdriveRelayDir, 'run-windows.bat'), runBat, 'utf8');
    fs.writeFileSync(path.join(this.gdriveRelayDir, 'watch-sync-windows.ps1'), watchPs1, 'utf8');
  }
}

module.exports = { CrossPlatformSyncEngine };
