'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EvolutionRelay } = require('./EvolutionRelay.js');

class EvolutionInbox {
  constructor({ canonicalRoot, dataDir, platform = process.platform, getBlockers, verifyReload } = {}) {
    if (!canonicalRoot || !dataDir) throw new Error('evolution_inbox_paths_required');
    this.root = path.resolve(canonicalRoot);
    this.localDir = path.join(path.resolve(dataDir), 'evolution-inbox');
    this.configFile = path.join(this.localDir, 'config.json');
    this.deviceFile = path.join(this.localDir, 'device.json');
    this.platform = platform;
    this.getBlockers = typeof getBlockers === 'function' ? getBlockers : () => [];
    this.verifyReload = typeof verifyReload === 'function' ? verifyReload : null;
    this.relay = null;
    fs.mkdirSync(this.localDir, { recursive: true, mode: 0o700 });
    this.deviceId = this._deviceId();
  }

  _deviceId() {
    try {
      if (fs.lstatSync(this.deviceFile).isSymbolicLink()) throw new Error('device_identity_symlink');
      const value = JSON.parse(fs.readFileSync(this.deviceFile, 'utf8'));
      if (/^[a-zA-Z0-9_-]{1,80}$/.test(value.deviceId)) return value.deviceId;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const deviceId = `${this.platform}-${crypto.randomUUID()}`;
    this._atomic(this.deviceFile, { schemaVersion: 1, deviceId });
    return deviceId;
  }

  _config() {
    try {
      if (fs.lstatSync(this.configFile).isSymbolicLink()) throw new Error('inbox_config_symlink');
      const value = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
      return value?.schemaVersion === 1 && typeof value.relayRoot === 'string' ? value : null;
    } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  }

  startConfigured() {
    const config = this._config();
    if (!config?.enabled) return this.status();
    try { this._start(config.relayRoot); }
    catch (error) { this.lastError = String(error.message || error); }
    return this.status();
  }

  configure({ relayRoot } = {}) {
    if (typeof relayRoot !== 'string' || !path.isAbsolute(relayRoot)) throw new Error('absolute_relay_folder_required');
    const resolved = path.resolve(relayRoot);
    if (!fs.existsSync(resolved) || fs.lstatSync(resolved).isSymbolicLink() || !fs.statSync(resolved).isDirectory()) throw new Error('relay_folder_must_exist_and_not_be_symlink');
    const realRelay = fs.realpathSync(resolved);
    const realSource = fs.realpathSync(this.root);
    const sourceToRelay = path.relative(realSource, realRelay);
    const relayToSource = path.relative(realRelay, realSource);
    const inside = value => value === '' || (value !== '..' && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value));
    if (inside(sourceToRelay) || inside(relayToSource)) throw new Error('relay_must_be_outside_source');
    this._atomic(this.configFile, { schemaVersion: 1, enabled: true, relayRoot: realRelay });
    this._start(resolved);
    return this.status();
  }

  _start(relayRoot) {
    this.relay?.stop();
    this.relay = new EvolutionRelay({
      canonicalRoot: this.root,
      relayRoot,
      deviceId: this.deviceId,
      platform: this.platform,
      getBlockers: this.getBlockers,
      verifyReload: this.verifyReload
    });
    try { this.relay.start(); }
    catch (error) { this.relay = null; throw error; }
    return this.status();
  }

  status() {
    const config = this._config();
    return {
      configured: Boolean(config), enabled: Boolean(this.relay?.enabled), deviceId: this.deviceId,
      relayFolder: config?.relayRoot || null, transport: config ? 'local-drive-folder-cloud-receipt-unverified' : 'unconfigured',
      pending: this.relay?.getPending() || [], error: this.lastError || null
    };
  }

  stop() {
    const relay = this.relay; this.relay = null;
    if (relay) void relay.stop();
    return this.status();
  }

  disable() {
    const config = this._config();
    if (config) this._atomic(this.configFile, { ...config, enabled: false });
    return this.stop();
  }

  _atomic(file, value) {
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
}

module.exports = { EvolutionInbox };
