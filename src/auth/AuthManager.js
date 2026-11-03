/**
 * @project My-Codex
 * @provenance:rogan-core
 * @author Rogan Kim (GeunHu Kim) & AI Architect
 * @license MIT
 * @description Multi-account authentication manager supporting ChatGPT (OpenAI) and Antigravity (Google OAuth).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_AUTH_DIR = path.join(os.homedir(), '.my-codex');
const DEFAULT_AUTH_FILE = path.join(DEFAULT_AUTH_DIR, 'auth.json');

class AuthManager {
  constructor(options = {}) {
    this.authFile = options.authFile || DEFAULT_AUTH_FILE;
    this.seedDefaults = options.seedDefaults !== false;
    this.authDir = path.dirname(this.authFile);
    this._ensureDir();
    this.accounts = this._load();
  }

  _ensureDir() {
    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true, mode: 0o700 });
    }
  }

  _load() {
    if (!fs.existsSync(this.authFile)) {
      if (!this.seedDefaults) return { activeAccountId: null, accounts: {} };
      // Default initial accounts seeded with Rogan's setup
      const defaultData = {
        activeAccountId: 'antigravity-flash-med',
        accounts: {
          'antigravity-flash-med': {
            id: 'antigravity-flash-med',
            provider: 'antigravity-cli',
            type: 'google-oauth',
            email: 'rogan2534@gmail.com',
            name: 'Rogan Google Antigravity',
            model: 'gemini-3.8-flash-medium',
            status: 'active',
            token: process.env.ANTIGRAVITY_TOKEN || 'local-daemon-token',
            createdAt: Date.now()
          },
          'codex-secondary': {
            id: 'codex-secondary',
            provider: 'chatgpt-codex',
            type: 'openai-oauth',
            email: 'f123123ff@gmail.com',
            accountUid: 'b10000024d37',
            name: 'Codex Secondary Account',
            model: 'gpt-6-luna',
            status: 'active',
            token: process.env.OPENAI_SECONDARY_TOKEN || 'session-token-secondary',
            createdAt: Date.now()
          },
          'codex-primary': {
            id: 'codex-primary',
            provider: 'chatgpt-codex',
            type: 'openai-oauth',
            email: 'rogan2534@gmail.com',
            name: 'Codex Primary Subscription',
            model: 'gpt-6-luna',
            status: 'active',
            token: process.env.OPENAI_API_KEY || 'session-token-primary',
            createdAt: Date.now()
          }
        }
      };
      this._save(defaultData);
      return defaultData;
    }
    try {
      const content = fs.readFileSync(this.authFile, 'utf8');
      return JSON.parse(content);
    } catch (e) {
      console.warn('[AuthManager] Failed to read auth file, initializing empty:', e.message);
      return { activeAccountId: null, accounts: {} };
    }
  }

  _save(data = this.accounts) {
    this._ensureDir();
    fs.writeFileSync(this.authFile, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  listAccounts() {
    return Object.values(this.accounts.accounts || {});
  }

  getAccount(id) {
    return this.accounts.accounts?.[id] || null;
  }

  getActiveAccount() {
    const id = this.accounts.activeAccountId;
    return id ? this.getAccount(id) : null;
  }

  setActiveAccount(id) {
    if (!this.accounts.accounts?.[id]) {
      throw new Error(`Account ID '${id}' not found.`);
    }
    this.accounts.activeAccountId = id;
    this._save();
    return this.getAccount(id);
  }

  registerAccount(accountData) {
    if (!accountData.id || !accountData.provider) {
      throw new Error('Account must have an id and provider.');
    }
    this.accounts.accounts[accountData.id] = {
      ...accountData,
      updatedAt: Date.now()
    };
    if (!this.accounts.activeAccountId) {
      this.accounts.activeAccountId = accountData.id;
    }
    this._save();
    return this.accounts.accounts[accountData.id];
  }

  removeAccount(id) {
    if (this.accounts.accounts[id]) {
      delete this.accounts.accounts[id];
      if (this.accounts.activeAccountId === id) {
        const remaining = Object.keys(this.accounts.accounts);
        this.accounts.activeAccountId = remaining.length > 0 ? remaining[0] : null;
      }
      this._save();
      return true;
    }
    return false;
  }

  /**
   * Interactive Login / Token Registration helper
   */
  async loginProvider(provider, credentials = {}) {
    if (provider === 'chatgpt' || provider === 'openai') {
      const id = credentials.id || `chatgpt-${credentials.email || Date.now()}`;
      return this.registerAccount({
        id,
        provider: 'chatgpt-codex',
        type: 'openai-oauth',
        email: credentials.email || 'user@chatgpt.com',
        token: credentials.token,
        model: credentials.model || 'gpt-6-luna'
      });
    } else if (provider === 'google' || provider === 'antigravity') {
      const id = credentials.id || `antigravity-${credentials.email || 'google'}`;
      return this.registerAccount({
        id,
        provider: 'antigravity-cli',
        type: 'google-oauth',
        email: credentials.email || 'rogan2534@gmail.com',
        token: credentials.token || 'google-oauth-token',
        model: credentials.model || 'gemini-3.8-flash-medium'
      });
    } else {
      throw new Error(`Unsupported provider: ${provider}`);
    }
  }
}

module.exports = { AuthManager, DEFAULT_AUTH_FILE };
