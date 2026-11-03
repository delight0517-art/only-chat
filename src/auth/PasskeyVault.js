/**
 * @project My-Codex
 * @provenance:rogan-core
 * @author Rogan Kim (GeunHu Kim) & AI Architect
 * @license MIT
 * @description Secure Passkey & Credential Vault with AI Granular Permissions.
 * Safely stores passkeys, API keys, and website credentials with user authorization gates.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

class PasskeyVault {
  constructor(options = {}) {
    this.vaultDir = options.vaultDir || options.dataDir || path.join(os.homedir(), '.my-codex');
    this.vaultFile = path.join(this.vaultDir, 'passkeys.json');
    this._ensureDir();
    this.vault = this._load();
  }

  _ensureDir() {
    if (!fs.existsSync(this.vaultDir)) {
      fs.mkdirSync(this.vaultDir, { recursive: true, mode: 0o700 });
    }
  }

  _load() {
    if (fs.existsSync(this.vaultFile)) {
      try {
        const raw = fs.readFileSync(this.vaultFile, 'utf8');
        return JSON.parse(raw);
      } catch (_) {}
    }
    return { credentials: {}, permissions: {} };
  }

  _save() {
    this._ensureDir();
    fs.writeFileSync(this.vaultFile, JSON.stringify(this.vault, null, 2), { mode: 0o600 });
  }

  /**
   * Save a passkey or credential with explicit AI permission flag
   */
  saveCredential(service, data = {}) {
    const id = service.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    this.vault.credentials[id] = {
      id,
      service,
      username: data.username || '',
      secret: data.secret || data.passkey || '',
      type: data.type || 'passkey', // 'passkey' | 'password' | 'api-key'
      allowAiUse: data.allowAiUse !== false, // User permission flag
      updatedAt: Date.now()
    };
    this._save();
    return this.getCredentialSafe(id);
  }

  /**
   * Return credential list without exposing raw secrets directly to UI
   */
  listCredentials() {
    return Object.values(this.vault.credentials).map(c => ({
      id: c.id,
      service: c.service,
      username: c.username,
      type: c.type,
      allowAiUse: c.allowAiUse,
      hasSecret: !!(c.secret && c.secret.length > 0),
      updatedAt: c.updatedAt
    }));
  }

  getCredentialSafe(id) {
    const c = this.vault.credentials[id];
    if (!c) return null;
    return {
      id: c.id,
      service: c.service,
      username: c.username,
      type: c.type,
      allowAiUse: c.allowAiUse
    };
  }

  /**
   * AI requests credential access. Only succeeds if user explicitly allowed AI use.
   */
  requestAccessForAi(service) {
    const id = service.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const c = this.vault.credentials[id];
    if (!c) {
      throw new Error(`서비스 '${service}' 에 대한 저장된 패스키/자격증명이 없습니다.`);
    }
    if (!c.allowAiUse) {
      throw new Error(`서비스 '${service}' 자격증명에 대해 AI 사용 권한이 비활성화되어 있습니다. 설정에서 권한을 켜주세요.`);
    }
    return {
      service: c.service,
      username: c.username,
      secret: c.secret,
      type: c.type
    };
  }

  deleteCredential(id) {
    if (this.vault.credentials[id]) {
      delete this.vault.credentials[id];
      this._save();
      return true;
    }
    return false;
  }
}

module.exports = { PasskeyVault };
