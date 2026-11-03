'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { retainWindowsReleases } = require('../scripts/retain-windows-releases.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'only-chat-release-retention-'));
try {
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist);
  const names = [
    'OnlyChat_Windows_1.0.1_x64_2026-10-27',
    'OnlyChat_Windows_1.0.2_x64_2026-10-28',
    'OnlyChat_Windows_1.1.0_x64_2026-10-29',
    'OnlyChat_Windows_1.2.0_x64_2026-10-30'
  ];
  for (const name of names) {
    const directory = path.join(dist, name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'RELEASE-MANIFEST.json'), '{}\n');
  }
  const unrelated = path.join(dist, 'win-unpacked');
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, 'keep.txt'), 'do not touch');

  const preview = retainWindowsReleases({ distDir: dist });
  assert.equal(preview.releasesFound, 4);
  assert.equal(preview.retained.length, 3);
  assert.equal(preview.results[0].status, 'preview-only');
  assert.equal(fs.existsSync(path.join(dist, names[0])), true);

  const applied = retainWindowsReleases({ distDir: dist, apply: true });
  assert.equal(applied.results[0].status, 'removed');
  assert.equal(fs.existsSync(path.join(dist, names[0])), false);
  assert.equal(fs.existsSync(path.join(dist, names[3])), true);
  assert.equal(fs.existsSync(path.join(unrelated, 'keep.txt')), true);
  console.log('Windows release retention preview, latest-three policy, and scope guard passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
