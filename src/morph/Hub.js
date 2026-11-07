/**
 * @project My-Codex
 * @provenance:rogan-core
 * @author Rogan Kim (GeunHu Kim) & AI Architect
 * @license MIT
 * @description Central Metamorphic Hub ("핫리로드 _ 신체 변형 시스템").
 * Disassembles the application into decoupled, hot-swappable organs (UI, Design, Font, Features)
 * with instant zero-downtime hot-reloading and collision protection.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

class MetamorphicHub extends EventEmitter {
  constructor(options = {}) {
    super();
    this.workspaceDir = options.workspaceDir || path.resolve(__dirname, '../..');
    this.dataDir = path.resolve(options.dataDir || this.workspaceDir);
    this.templateDir = options.templateDir || path.join(__dirname, 'organs');
    this.organsDir = path.resolve(options.organsDir || path.join(this.dataDir, 'morph/organs'));
    const organsRelative = path.relative(this.dataDir, this.organsDir);
    if (organsRelative === '..' || organsRelative.startsWith(`..${path.sep}`) || path.isAbsolute(organsRelative)) throw new Error('Morph organs must stay inside dataDir.');
    this.desktopUiDir = options.desktopUiDir || path.join(__dirname, '../ui/desktop');
    this.stateFile = path.join(this.dataDir, '.morph_state.json');
    this.watchEnabled = options.watchEnabled !== false;
    this.watchDebounceMs = Number.isFinite(options.watchDebounceMs) && options.watchDebounceMs >= 0 ? options.watchDebounceMs : 40;
    this.organLockTtlMs = Number.isFinite(options.organLockTtlMs) && options.organLockTtlMs > 0 ? options.organLockTtlMs : 5 * 60_000;
    this.canMutate = options.canMutate || (() => true);

    // Decoupled Organ Slots
    this.slots = {
      theme: { name: '디자인/테마 슬롯', organ: 'theme', version: 1, lastModified: Date.now() },
      font: { name: '타이포그래피/폰트 슬롯', organ: 'font', version: 1, lastModified: Date.now() },
      ui: { name: '컴포넌트/레이아웃 슬롯', organ: 'ui', version: 1, lastModified: Date.now() },
      features: { name: '에이전트 기능/도구 슬롯', organ: 'features', version: 1, lastModified: Date.now() }
    };

    // Single Source of Truth & Collision Shield Ledger
    this.collisionLedger = new Map(); // organKind -> { lockedBy, acquiredAt, expiresAt }
    this.pendingMutations = [];
    this.activeSseClients = new Set();
    this.watchers = [];
    this._watchTimers = new Map();
    this._recentSelfWriteUntil = new Map();

    this._ensureOrgansStructure();
    if (this.watchEnabled) this.startLiveWatchers();
  }

  _ensureOrgansStructure() {
    // 1. Theme organ default configuration
    const themeConfigFile = path.join(this.organsDir, 'theme/theme.json');
    if (!fs.existsSync(themeConfigFile)) {
      const defaultTheme = {
        name: 'Cyberpunk Oceanic Glass',
        accentCyan: '#00d2ff',
        accentGreen: '#10b981',
        accentYellow: '#f59e0b',
        accentRed: '#ef4444',
        bgBase: '#131416',
        bgSurface: '#1e2024',
        glassBlur: '12px',
        borderRadius: '10px'
      };
      this._initializeOrgan('theme', 'theme.json', defaultTheme);
    }

    // 2. Font organ default configuration
    const fontConfigFile = path.join(this.organsDir, 'font/font.json');
    if (!fs.existsSync(fontConfigFile)) {
      const defaultFont = {
        name: 'Apple SF Pro + SF Mono',
        fontSans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", sans-serif',
        fontMono: '"SF Mono", Menlo, Monaco, Consolas, monospace',
        baseSize: '13px',
        lineHeight: '1.6'
      };
      this._initializeOrgan('font', 'font.json', defaultFont);
    }

    // 3. UI Organ default metadata
    const uiConfigFile = path.join(this.organsDir, 'ui/layout.json');
    if (!fs.existsSync(uiConfigFile)) {
      const defaultLayout = {
        sidebarWidth: '270px',
        compactMode: false,
        trafficLightsStyle: 'macos-native',
        timelineStyle: 'bubble-clean'
      };
      this._initializeOrgan('ui', 'layout.json', defaultLayout);
    }

    const featuresConfigFile = path.join(this.organsDir, 'features/features.json');
    if (!fs.existsSync(featuresConfigFile)) this._initializeOrgan('features', 'features.json', { enabled: {} });
  }

  _initializeOrgan(name, filename, fallback) {
    const target = this._organFile(name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    this._organFile(name);
    const template = path.join(this.templateDir, name, filename);
    if (fs.existsSync(template)) fs.copyFileSync(template, target);
    else fs.writeFileSync(target, JSON.stringify(fallback, null, 2), 'utf8');
  }

  _organFile(organ) {
    const names = { theme: 'theme.json', font: 'font.json', ui: 'layout.json', features: 'features.json' };
    if (!names[organ]) throw new Error(`Unsupported organ slot '${organ}'.`);
    const target = path.join(this.organsDir, organ, names[organ]);
    let existing = target;
    while (!fs.existsSync(existing) && existing !== path.dirname(existing)) existing = path.dirname(existing);
    const realRelative = path.relative(fs.realpathSync(this.dataDir), fs.realpathSync(existing));
    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error('Morph organ resolves outside dataDir.');
    return target;
  }

  _hash(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Register active SSE client connection from Desktop UI
   */
  registerSseClient(res) {
    this.activeSseClients.add(res);
    res.on('close', () => this.activeSseClients.delete(res));
  }

  /**
   * Broadcast real-time hot-morphing event to all connected UI instances
   */
  broadcastMorph(organKind, payload = {}) {
    const slot = this.slots[organKind];
    if (slot) {
      slot.version += 1;
      slot.lastModified = Date.now();
    }

    const eventData = {
      type: 'system_morph',
      organ: organKind,
      timestamp: Date.now(),
      slot: slot || null,
      payload
    };

    const message = `data: ${JSON.stringify(eventData)}\n\n`;
    for (const client of this.activeSseClients) {
      try {
        client.write(message);
      } catch (_) {
        this.activeSseClients.delete(client);
      }
    }

    this.emit('morph_applied', eventData);
    console.log(`[MetamorphicHub] ⚡️ 신체 변형(핫리로드) 전송 완료: [${organKind}] (v${slot?.version || 1})`);
  }

  pruneExpiredOrganLocks() {
    const now = Date.now();
    for (const [organKind, entry] of this.collisionLedger.entries()) {
      if (Number.isFinite(entry.expiresAt) && entry.expiresAt <= now) {
        this.collisionLedger.delete(organKind);
      }
    }
  }

  acquireOrganLock(organKind, ownerId, ttlMs = this.organLockTtlMs) {
    this._organFile(organKind);
    this.pruneExpiredOrganLocks();
    const existing = this.collisionLedger.get(organKind);
    if (existing && existing.lockedBy !== ownerId) {
      return { acquired: false, holder: existing.lockedBy, expiresAt: existing.expiresAt };
    }
    const now = Date.now();
    const entry = {
      lockedBy: ownerId,
      acquiredAt: existing?.lockedBy === ownerId ? existing.acquiredAt : now,
      expiresAt: now + ttlMs
    };
    this.collisionLedger.set(organKind, entry);
    return { acquired: true, holder: ownerId, expiresAt: entry.expiresAt };
  }

  releaseOrganLock(organKind, ownerId = null) {
    const existing = this.collisionLedger.get(organKind);
    if (!existing) return false;
    if (ownerId && existing.lockedBy !== ownerId) return false;
    this.collisionLedger.delete(organKind);
    return true;
  }

  /**
   * Surgical Mutation: AI or user changes a specific organ without touching others
   */
  mutateOrgan(organKind, key, value, author = 'ai-developer', options = {}) {
    const targetConfigFile = this._organFile(organKind);
    if (!fs.existsSync(targetConfigFile)) {
      throw new Error(`Organ slot '${organKind}' not found.`);
    }
    const contractVersion = 1;
    if (options.expectedSchemaVersion != null && options.expectedSchemaVersion !== contractVersion) {
      throw new Error('Unsupported morph organ contract version.');
    }
    if (options.lockOwner) {
      const lockCheck = this.acquireOrganLock(organKind, options.lockOwner, options.lockTtlMs);
      if (!lockCheck.acquired) {
        throw new Error(`Organ '${organKind}' is currently locked by '${lockCheck.holder}'.`);
      }
    }

    if (!this.canMutate()) {
      if (options.deferIfBusy === true) {
        const rawNow = fs.readFileSync(targetConfigFile, 'utf8');
        const currentHash = this._hash(rawNow);
        if (options.expectedHash != null && options.expectedHash !== currentHash) {
          throw new Error('Organ changed since it was read; refresh and retry.');
        }
        if (options.expectedHash == null) {
          this.pendingMutations = this.pendingMutations.filter(item =>
            !(item.organKind === organKind && item.key === key && item.options?.expectedHash == null));
        }
        this.pendingMutations.push({
          organKind,
          key,
          value,
          author,
          options: { ...options, deferIfBusy: false }
        });
        return { ok: true, queued: true, organ: organKind, key, value, contractVersion, pendingCount: this.pendingMutations.length };
      }
      throw new Error('Hot reload is blocked while a request or file write is in progress.');
    }

    const raw = fs.readFileSync(targetConfigFile, 'utf8');
    const currentHash = this._hash(raw);
    if (options.expectedHash != null && options.expectedHash !== currentHash) throw new Error('Organ changed since it was read; refresh and retry.');
    const data = JSON.parse(raw);
    const oldValue = data[key];
    data[key] = value;
    data._lastAuthor = author;
    data._updatedAt = Date.now();

    const tempFile = `${targetConfigFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    this._recentSelfWriteUntil.set(path.resolve(targetConfigFile), Date.now() + Math.max(150, this.watchDebounceMs * 4));
    try {
      fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
      fs.renameSync(tempFile, targetConfigFile);
    } catch (error) {
      this._recentSelfWriteUntil.delete(path.resolve(targetConfigFile));
      try { fs.unlinkSync(tempFile); } catch (_) {}
      throw error;
    }

    // Notify UI immediately
    this.broadcastMorph(organKind, { key, oldValue, newValue: value, data });
    return { ok: true, queued: false, organ: organKind, key, value, contractVersion, hash: this._hash(fs.readFileSync(targetConfigFile)) };
  }

  flushPendingMutations() {
    if (!this.canMutate() || this.pendingMutations.length === 0) {
      return { flushed: 0, results: [], errors: [], remaining: this.pendingMutations.length };
    }
    const batch = this.pendingMutations.splice(0, this.pendingMutations.length);
    const results = [];
    const errors = [];
    for (const item of batch) {
      if (!this.canMutate()) {
        this.pendingMutations.unshift(item);
        break;
      }
      try {
        results.push(this.mutateOrgan(item.organKind, item.key, item.value, item.author, item.options));
      } catch (error) {
        errors.push({ organ: item.organKind, key: item.key, error: error.message });
      }
    }
    return { flushed: results.length, results, errors, remaining: this.pendingMutations.length };
  }

  getOrganData(organKind) {
    let targetConfigFile;
    try { targetConfigFile = this._organFile(organKind); } catch (_) { return null; }
    if (fs.existsSync(targetConfigFile)) {
      try {
        return JSON.parse(fs.readFileSync(targetConfigFile, 'utf8'));
      } catch (_) {}
    }
    return null;
  }

  getHubStatus() {
    this.pruneExpiredOrganLocks();
    return {
      slots: this.slots,
      activeClientsCount: this.activeSseClients.size,
      pendingMutationsCount: this.pendingMutations.length,
      hotReload: {
        organData: 'live configuration update',
        rendererCss: 'live stylesheet update',
        rendererMarkupOrScript: 'renderer reload after pending request, attachments, draft and conversation are safe',
        mainProcessModules: 'restart Only Chat',
        nativeOrElectronChanges: 'rebuild and restart Only Chat',
        watcherEnabled: this.watchEnabled
      },
      organs: {
        theme: this.getOrganData('theme'),
        font: this.getOrganData('font'),
        ui: this.getOrganData('ui')
      }
    };
  }

  _isIgnoredWatchPath(filename) {
    if (!filename || typeof filename !== 'string') return true;
    const normalized = filename.replace(/\\/g, '/');
    const base = path.posix.basename(normalized);
    if (!base) return true;
    if (base.endsWith('.tmp') || base.endsWith('.swp') || base.endsWith('.swo') || base.endsWith('~') || base.startsWith('.#') || base === '.DS_Store') {
      return true;
    }
    if (normalized === '.git' || normalized.startsWith('.git/') || normalized.includes('/.git/')) {
      return true;
    }
    return false;
  }

  _classifyWatchOrgan(filename) {
    if (filename.includes('theme') || filename.endsWith('.css')) return 'theme';
    if (filename.includes('font')) return 'font';
    if (filename.endsWith('.html') || filename.endsWith('.js')) return 'ui';
    return 'features';
  }

  startLiveWatchers() {
    this.stopWatchers();
    if (!this.watchEnabled) return;
    const dirs = [this.organsDir, this.desktopUiDir];

    for (const d of dirs) {
      if (!fs.existsSync(d)) continue;
      try {
        const watcher = fs.watch(d, { recursive: true }, (event, filename) => {
          if (this._isIgnoredWatchPath(filename)) return;
          const resolvedFile = path.resolve(d, filename);
          const suppressUntil = this._recentSelfWriteUntil.get(resolvedFile);
          if (suppressUntil && Date.now() <= suppressUntil) return;
          if (suppressUntil) this._recentSelfWriteUntil.delete(resolvedFile);

          const organ = this._classifyWatchOrgan(filename);
          const timerKey = `${organ}:${resolvedFile}`;
          const prevTimer = this._watchTimers.get(timerKey);
          if (prevTimer) clearTimeout(prevTimer);
          const timer = setTimeout(() => {
            this._watchTimers.delete(timerKey);
            this.broadcastMorph(organ, { file: filename });
          }, this.watchDebounceMs);
          if (typeof timer.unref === 'function') timer.unref();
          this._watchTimers.set(timerKey, timer);
        });
        this.watchers.push(watcher);
      } catch (_) {}
    }
  }

  stopWatchers() {
    for (const timer of this._watchTimers.values()) {
      clearTimeout(timer);
    }
    this._watchTimers.clear();
    for (const w of this.watchers) {
      try { w.close(); } catch (_) {}
    }
    this.watchers = [];
  }
}

module.exports = { MetamorphicHub };
