'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const MODULE_PATH = 'src/features/provider/v1.mjs';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

class AccountRouterModuleSlot {
  constructor({ projectRoot = path.resolve(__dirname, '../../..') } = {}) {
    this.projectRoot = fs.realpathSync(path.resolve(projectRoot));
    this.moduleFile = path.join(this.projectRoot, MODULE_PATH);
    this.current = null;
  }

  async load() {
    const stat = fs.lstatSync(this.moduleFile);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Account Router module must be a regular allowlisted file.');
    const realFile = fs.realpathSync(this.moduleFile);
    const relative = path.relative(this.projectRoot, realFile).split(path.sep).join('/');
    if (relative !== MODULE_PATH) throw new Error('Account Router module resolved outside its allowlisted slot.');

    const source = fs.readFileSync(realFile);
    const hash = sha256(source);
    if (this.current?.hash === hash) return this.current;

    const url = pathToFileURL(realFile);
    url.searchParams.set('sha256', hash);
    const loaded = await import(url.href);
    if (sha256(fs.readFileSync(realFile)) !== hash) throw new Error('Account Router module changed during morph load.');
    if (typeof loaded.createAccountRouterAdapter !== 'function') throw new Error('Account Router module does not expose its v1 adapter contract.');

    const next = { hash, adapter: loaded.createAccountRouterAdapter(), modulePath: MODULE_PATH };
    this.current = next;
    return next;
  }

  async verifyReload({ files, signal } = {}) {
    if (!Array.isArray(files) || files.length !== 1 || files[0]?.path !== MODULE_PATH || !/^[a-f0-9]{64}$/.test(files[0]?.newHash || '')) {
      throw new Error('Only the Account Router provider v1 module can be morph-loaded.');
    }
    if (signal?.aborted) throw new Error('Metamorphic load cancelled.');
    const loaded = await this.load();
    if (signal?.aborted) throw new Error('Metamorphic load cancelled.');
    if (loaded.hash !== files[0].newHash) throw new Error('Loaded Account Router module hash does not match the approved source.');
    return { loadedHashes: { [MODULE_PATH]: loaded.hash } };
  }

  status() {
    return {
      modulePath: MODULE_PATH,
      loadedHash: this.current?.hash || null,
      reloadPolicy: 'load exact SHA-256 version for the next request; existing requests keep their captured adapter'
    };
  }
}

module.exports = { AccountRouterModuleSlot, ACCOUNT_ROUTER_MODULE_PATH: MODULE_PATH };
