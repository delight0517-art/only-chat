'use strict';

const fs = require('node:fs');
const path = require('node:path');

class MacScreenControlSettings {
  constructor(filePath) {
    this.filePath = filePath;
    this.enabled = false;
    this._load();
  }

  _load() {
    let stat;
    try { stat = fs.lstatSync(this.filePath); }
    catch (error) { if (error.code === 'ENOENT') return; this.enabled = false; return; }
    if (!stat.isFile() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      || (stat.mode & 0o077) !== 0 || stat.size > 1024) return;
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.enabled = typeof value.enabled === 'boolean' && Object.keys(value).length === 1 ? value.enabled : false;
    } catch (_) { this.enabled = false; }
  }

  get() { return { enabled: this.enabled }; }

  set(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ enabled })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
      this.enabled = enabled;
      return this.get();
    } finally { try { fs.unlinkSync(temporary); } catch (_) {} }
  }
}

module.exports = { MacScreenControlSettings };
