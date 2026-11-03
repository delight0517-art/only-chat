'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RELEASE_NAME = /^OnlyChat_Windows_(\d+)\.(\d+)\.(\d+)_x64_(\d{4}-\d{2}-\d{2})$/;
const KEEP = 3;

function compareRelease(a, b) {
  for (let i = 0; i < 3; i++) if (a.version[i] !== b.version[i]) return b.version[i] - a.version[i];
  return b.date.localeCompare(a.date);
}

function hasOpenFiles(directory) {
  if (process.platform !== 'darwin') return false;
  const result = spawnSync('/usr/sbin/lsof', ['+D', directory], { encoding: 'utf8', timeout: 10000 });
  if (result.error || result.status !== 1) return true;
  return Boolean(result.stdout.trim());
}

function retainWindowsReleases(options = {}) {
  const dist = path.resolve(options.distDir || path.join(__dirname, '..', 'dist'));
  const apply = options.apply === true;
  const entries = fs.readdirSync(dist, { withFileTypes: true });
  const releases = entries.flatMap(entry => {
    if (!entry.isDirectory()) return [];
    const match = entry.name.match(RELEASE_NAME);
    if (!match || !fs.existsSync(path.join(dist, entry.name, 'RELEASE-MANIFEST.json'))) return [];
    return [{ name: entry.name, path: path.join(dist, entry.name), version: match.slice(1, 4).map(Number), date: match[4] }];
  }).sort(compareRelease);
  const removals = releases.slice(KEEP);
  const results = removals.map(release => {
    if (hasOpenFiles(release.path)) return { path: release.path, status: 'skipped-open-or-unverifiable' };
    if (!apply) return { path: release.path, status: 'preview-only' };
    try {
      fs.rmSync(release.path, { recursive: true, force: false });
      return { path: release.path, status: 'removed' };
    } catch (error) {
      return { path: release.path, status: 'skipped-removal-failed', reason: String(error.message || error).slice(0, 180) };
    }
  });
  return { dist, keep: KEEP, releasesFound: releases.length, retained: releases.slice(0, KEEP).map(item => item.path), results };
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  const report = retainWindowsReleases({ apply });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.results.some(item => item.status === 'skipped-removal-failed')) process.exitCode = 1;
}

module.exports = { retainWindowsReleases, compareRelease, KEEP };
