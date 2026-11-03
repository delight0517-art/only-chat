'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { InstalledAppCatalog } = require('../src/morph/ReaAppBridge.js');

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-app-catalog-'));
  try {
    const macRoot = path.join(tmp, 'Applications');
    const macApp = path.join(macRoot, 'Sample.app');
    fs.mkdirSync(path.join(macApp, 'Contents', 'Resources'), { recursive: true });
    fs.writeFileSync(path.join(macApp, 'Contents', 'Resources', 'app.asar'), 'fixture');
    const macApps = new InstalledAppCatalog({ platform: 'darwin', searchDirs: [macRoot] }).listCandidateApps();
    assert.deepStrictEqual(macApps[0], { name: 'Sample', path: macApp, framework: 'Electron' });

    const windowsRoot = path.join(tmp, 'Program Files');
    const windowsApp = path.join(windowsRoot, 'Sample');
    fs.mkdirSync(path.join(windowsApp, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(windowsApp, 'resources', 'app.asar'), 'fixture');
    const windowsApps = new InstalledAppCatalog({ platform: 'win32', searchDirs: [windowsRoot] }).listCandidateApps();
    assert.deepStrictEqual(windowsApps[0], { name: 'Sample', path: windowsApp, framework: 'Electron' });
    const renderer = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
    assert.match(renderer, /<span style="color:var\(--text-dim\);">\$\{escapeHtml\(app\.framework\)\}<\/span>/,
      'framework labels from the local app catalog are HTML-escaped before insertion');
    console.log('installed app catalog platform checks passed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
