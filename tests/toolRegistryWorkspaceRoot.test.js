'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ToolRegistry } = require('../src/tools/ToolRegistry.js');

test('an explicitly selected workspace root confines file reads and search', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'only-chat-workspace-root-'));
  try {
    const workspace = path.join(temporary, '3f-browser');
    const outside = path.join(temporary, 'outside');
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(workspace, 'TODO.md'), '- [ ] exact 3F item\n', 'utf8');
    fs.writeFileSync(path.join(outside, 'private.txt'), 'outside the selected root', 'utf8');
    fs.symlinkSync(outside, path.join(workspace, 'escape'), 'dir');

    const registry = new ToolRegistry({ workspaceDir: process.cwd(), browserEnabled: false, providerConnectionsEnabled: false });
    registry.setWorkspace(workspace, { sandboxRoot: workspace });

    assert.equal(await registry.readFile('TODO.md'), '- [ ] exact 3F item\n');
    const results = await registry.searchFiles('exact 3F item');
    assert.equal(results.path, '.');
    assert.match(results.matches[0], /TODO\.md:1:- \[ \] exact 3F item/);
    await assert.rejects(registry.readFile('../outside/private.txt'), /outside the isolated profile/);
    await assert.rejects(registry.readFile('escape/private.txt'), /resolves outside the isolated profile/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
