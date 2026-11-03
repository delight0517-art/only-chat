'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

class InstalledAppCatalog {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.searchDirs = options.searchDirs || this._defaultSearchDirs();
  }

  _defaultSearchDirs() {
    if (this.platform === 'darwin') return [path.join(os.homedir(), 'Applications'), '/Applications'];
    if (this.platform === 'win32') return [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'), process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
    return [];
  }

  listCandidateApps() {
    const candidates = [];
    const add = appPath => {
      const framework = this.detectFramework(appPath);
      if (framework !== 'Unknown' && !candidates.some(app => app.path === appPath)) {
        candidates.push({ name: path.basename(appPath, this.platform === 'darwin' ? '.app' : ''), path: appPath, framework });
      }
    };

    for (const dir of this.searchDirs) {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const appPath = path.join(dir, entry.name);
          if (this.platform === 'darwin' && entry.isDirectory() && entry.name.endsWith('.app')) add(appPath);
          else if (this.platform === 'win32' && entry.isDirectory()) {
            if (this.detectFramework(appPath) !== 'Unknown') add(appPath);
            else {
              for (const child of fs.readdirSync(appPath, { withFileTypes: true })) {
                if (child.isFile() && child.name.toLowerCase().endsWith('.exe')) add(appPath);
              }
            }
          }
        }
      } catch (_) {}
    }
    return candidates.slice(0, 50);
  }

  detectFramework(appPath) {
    const resources = this.platform === 'win32'
      ? path.join(appPath, 'resources')
      : path.join(appPath, 'Contents', 'Resources');
    const frameworks = this.platform === 'win32'
      ? appPath
      : path.join(appPath, 'Contents', 'Frameworks');
    if (fs.existsSync(path.join(resources, 'app.asar')) ||
        fs.existsSync(path.join(frameworks, 'Electron Framework.framework')) ||
        fs.existsSync(path.join(frameworks, 'electron.exe'))) return 'Electron';
    if (fs.existsSync(path.join(frameworks, 'FlutterMacOS.framework')) ||
        fs.existsSync(path.join(appPath, 'flutter_windows.dll'))) return 'Flutter';
    if (fs.existsSync(path.join(resources, 'sidecar')) ||
        fs.existsSync(path.join(resources, 'frontend-embed'))) return 'Tauri';
    return 'Unknown';
  }
}

// Backward-compatible module path; REA analysis runs externally during development.
module.exports = { InstalledAppCatalog, ReaAppBridge: InstalledAppCatalog };
