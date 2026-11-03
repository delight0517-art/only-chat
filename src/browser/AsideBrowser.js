/**
 * @project My-Codex
 * @provenance:rogan-core
 * @author Rogan Kim (GeunHu Kim) & AI Architect
 * @license MIT
 * @description Built-in Browser Engine powered by Aside & REA CDP (Chrome DevTools Protocol) Architecture.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, execSync } = require('node:child_process');

class AsideBrowser {
  constructor(options = {}) {
    this.asideBinary = options.asideBinary || this._findAsideBinary();
    this.policy = options.policy || null;
    this.activeUrl = 'about:blank';
    this.activeTabId = null;
    this.isOpen = false;
  }

  _findAsideBinary() {
    const defaultLocalPath = path.join(os.homedir(), '.local/bin/aside');
    if (fs.existsSync(defaultLocalPath)) {
      return defaultLocalPath;
    }
    try {
      const detected = execSync('which aside', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (detected) return detected;
    } catch (_) {}
    return defaultLocalPath;
  }

  isAvailable() {
    return fs.existsSync(this.asideBinary);
  }

  /**
   * Launch or attach to Aside browser window
   */
  async launch(url = 'https://google.com') {
    const checked = await this._checkNavigation(url);
    if (!checked.ok) return checked;
    const result = await this._runCommand(['launch', checked.url]);
    if (result.ok) {
      this.activeUrl = checked.url;
      this.isOpen = true;
    }
    return result;
  }

  /**
   * Navigate to a new web URL
   */
  async navigate(url) {
    const checked = await this._checkNavigation(url);
    if (!checked.ok) return checked;
    const result = await this._runCommand(['nav', checked.url]);
    if (result.ok) this.activeUrl = checked.url;
    return result;
  }

  async _checkNavigation(url) {
    if (!this.policy) return { ok: true, url };
    try {
      const result = await this.policy.check(url);
      return result.allowed
        ? { ok: true, url: result.url }
        : { ok: false, stdout: '', stderr: result.reason === 'blocked'
          ? `Focus Fence 차단: ${result.rule}`
          : 'Focus Fence 정책을 확인할 수 없어 탐색을 중단했습니다.', url: result.url, blocked: true };
    } catch (_) {
      return { ok: false, stdout: '', stderr: 'Focus Fence 정책을 확인할 수 없어 탐색을 중단했습니다.', blocked: true };
    }
  }

  /**
   * Extract 95% token-compressed ARIA accessibility tree (REA/Aside standard, ~150 tokens)
   * Avoids heavy DOM/HTML ingestion and 413 context explosion errors.
   */
  async getAriaTree(tabId = null) {
    const args = ['aria'];
    if (tabId || this.activeTabId) {
      args.push(tabId || this.activeTabId);
    }
    const result = await this._runCommand(args);
    return {
      tabId: tabId || this.activeTabId,
      url: this.activeUrl,
      ariaTree: result.stdout || result.stderr || ''
    };
  }

  /**
   * Perform action on element (@b1, @in1, click, type, scroll)
   */
  async act(action) {
    return this._runCommand(['act', action]);
  }

  /**
   * Extract pure text content from the active page (Zero screenshot tokens)
   */
  async readText() {
    return this._runCommand(['read']);
  }

  /**
   * Replay verified zero-token browser automation recipe
   */
  async recipePlay(recipeName, tabId = null) {
    const args = ['recipe', 'play', recipeName];
    if (tabId || this.activeTabId) args.push(tabId || this.activeTabId);
    return this._runCommand(args);
  }

  /**
   * Check Aside browser status and active tabs
   */
  async getStatus() {
    const available = this.isAvailable();
    let statusText = 'unknown';
    try {
      const res = await this._runCommand(['status'], 3000);
      statusText = res.stdout.trim();
    } catch (e) {
      statusText = e.message;
    }
    return {
      available,
      binaryPath: this.asideBinary,
      activeUrl: this.activeUrl,
      isOpen: this.isOpen,
      statusText
    };
  }

  _runCommand(args, timeoutMs = 25000) {
    return new Promise((resolve, reject) => {
      execFile(this.asideBinary, args, { timeout: timeoutMs, env: process.env }, (error, stdout, stderr) => {
        if (error && !stdout) {
          // If aside binary failed, fallback gracefully to returning command intent
          resolve({
            ok: false,
            exitCode: error.code || 1,
            stdout: stdout || '',
            stderr: stderr || error.message,
            fallback: true
          });
        } else {
          resolve({
            ok: true,
            exitCode: 0,
            stdout: stdout.trim(),
            stderr: stderr.trim()
          });
        }
      });
    });
  }
}

module.exports = { AsideBrowser };
