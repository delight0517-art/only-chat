'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ToolRegistry } = require('../src/tools/ToolRegistry.js');

(async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'only-chat-edit-target-'));
  try {
    const registry = new ToolRegistry({ workspaceDir: workspace, browserEnabled: false, providerConnectionsEnabled: false });
    const repeatedPath = path.join(workspace, 'repeated.txt');
    fs.writeFileSync(repeatedPath, 'same same', 'utf8');
    await assert.rejects(registry.editFile('repeated.txt', 'same', 'changed'), /exactly once/);
    assert.equal(fs.readFileSync(repeatedPath, 'utf8'), 'same same', 'an ambiguous edit must leave every occurrence untouched');

    const uniquePath = path.join(workspace, 'unique.txt');
    fs.writeFileSync(uniquePath, 'value = 1\n', 'utf8');
    const result = await registry.editFile('unique.txt', 'value = 1', 'value = 2');
    assert.deepEqual(result, { path: uniquePath, modified: true });
    assert.equal(fs.readFileSync(uniquePath, 'utf8'), 'value = 2\n');
    console.log('toolRegistryExactEdit passed: ambiguous replacements are rejected; unique replacements succeed');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
