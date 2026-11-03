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
    this.canMutate = options.canMutate || (() => true);

    // Decoupled Organ Slots
    this.slots = {
      theme: { name: '디자인/테마 슬롯', organ: 'theme', version: 1, lastModified: Date.now() },
      font: { name: '타이포그래피/폰트 슬롯', organ: 'font', version: 1, lastModified: Date.now() },
      ui: { name: '컴포넌트/레이아웃 슬롯', organ: 'ui', version: 1, lastModified: Date.now() },
      features: { name: '에이전트 기능/도구 슬롯', organ: 'features', version: 1, lastModified: Date.now() }
    };

    // Single Source of Truth & Collision Shield Ledger
    this.collisionLedger = new Map(); // path -> { lockedBy, version, hash }
    this.activeSseClients = new Set();
    this.watchers = [];

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

  /**
   * Surgical Mutation: AI or user changes a specific organ without touching others
   */
  mutateOrgan(organKind, key, value, author = 'ai-developer', options = {}) {
    if (!this.canMutate()) throw new Error('Hot reload is blocked while a request or file write is in progress.');
    const targetConfigFile = this._organFile(organKind);
    if (!fs.existsSync(targetConfigFile)) {
      throw new Error(`Organ slot '${organKind}' not found.`);
    }

    const raw = fs.readFileSync(targetConfigFile, 'utf8');
    const currentHash = this._hash(raw);
    const contractVersion = 1;
    if (options.expectedHash != null && options.expectedHash !== currentHash) throw new Error('Organ changed since it was read; refresh and retry.');
    if (options.expectedSchemaVersion != null && options.expectedSchemaVersion !== contractVersion) throw new Error('Unsupported morph organ contract version.');
    const data = JSON.parse(raw);
    const oldValue = data[key];
    data[key] = value;
    data._lastAuthor = author;
    data._updatedAt = Date.now();

    const tempFile = `${targetConfigFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
      fs.renameSync(tempFile, targetConfigFile);
    } catch (error) {
      try { fs.unlinkSync(tempFile); } catch (_) {}
      throw error;
    }

    // Notify UI immediately
    this.broadcastMorph(organKind, { key, oldValue, newValue: value, data });
    return { ok: true, organ: organKind, key, value, contractVersion, hash: this._hash(fs.readFileSync(targetConfigFile)) };
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
    return {
      slots: this.slots,
      activeClientsCount: this.activeSseClients.size,
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

  startLiveWatchers() {
    this.stopWatchers();
    if (!this.watchEnabled) return;
    const dirs = [this.organsDir, this.desktopUiDir];

    for (const d of dirs) {
      if (!fs.existsSync(d)) continue;
      try {
        const watcher = fs.watch(d, { recursive: true }, (event, filename) => {
          if (!filename) return;
          // Debounce and classify
          if (filename.includes('theme') || filename.endsWith('.css')) {
            this.broadcastMorph('theme', { file: filename });
          } else if (filename.includes('font')) {
            this.broadcastMorph('font', { file: filename });
          } else if (filename.endsWith('.html') || filename.endsWith('.js')) {
            this.broadcastMorph('ui', { file: filename });
          } else {
            this.broadcastMorph('features', { file: filename });
          }
        });
        this.watchers.push(watcher);
      } catch (_) {}
    }
  }

  stopWatchers() {
    for (const w of this.watchers) {
      try { w.close(); } catch (_) {}
    }
    this.watchers = [];
  }
}

module.exports = { MetamorphicHub };
