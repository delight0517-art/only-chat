/**
 * @project Only Chat (Codex Sovereign Edition)
 * @provenance:rogan-core
 * @license MIT
 * @description Native Bridge connecting Only Chat to Chrome and Firefox Sovereign Workspaces.
 */
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

class BrowserWorkspace {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.cliPath = options.enabled === false ? null : (options.cliPath || process.env.BROWSER_WORKSPACE_CLI || path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'browser-workspace.exe' : 'browser-workspace'));
    this.execFile = options.execFileSync || execFileSync;
    this.workspaceDir = options.workspaceDir || path.join(os.homedir(), '.gemini/config/plugins/browser-workspace/workspaces');
    if (this.enabled && !fs.existsSync(this.workspaceDir)) {
      fs.mkdirSync(this.workspaceDir, { recursive: true });
    }
  }

  listTabs(browser = 'chrome') {
    if (!this.enabled) return [];
    try {
      const out = this.execFile(this.cliPath, ['--json', 'tabs'], { encoding: 'utf8' });
      return JSON.parse(out);
    } catch (_) {
      return [];
    }
  }

  snapshot(name, browser = 'chrome') {
    if (!this.enabled) throw new Error('Browser workspace is disabled in isolated mode.');
    const out = this.execFile(this.cliPath, ['snapshot', name, browser], { encoding: 'utf8' });
    return { ok: true, output: out.trim() };
  }

  restore(name, browser = 'chrome') {
    if (!this.enabled) throw new Error('Browser workspace is disabled in isolated mode.');
    const out = this.execFile(this.cliPath, ['restore', name, browser], { encoding: 'utf8' });
    return { ok: true, output: out.trim() };
  }

  focusTab(query) {
    if (!this.enabled) throw new Error('Browser workspace is disabled in isolated mode.');
    const out = this.execFile(this.cliPath, ['focus', query], { encoding: 'utf8' });
    return { ok: true, output: out.trim() };
  }

  openTab(url, browser = 'chrome') {
    if (!this.enabled) throw new Error('Browser workspace is disabled in isolated mode.');
    const out = this.execFile(this.cliPath, ['open', url, browser], { encoding: 'utf8' });
    return { ok: true, output: out.trim() };
  }

  listWorkspaces() {
    if (!this.enabled) return [];
    try {
      const out = this.execFile(this.cliPath, ['--json', 'workspaces'], { encoding: 'utf8' });
      return JSON.parse(out);
    } catch (_) {
      return [];
    }
  }
}

module.exports = { BrowserWorkspace };
