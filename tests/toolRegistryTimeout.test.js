'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ToolRegistry } = require('../src/tools/ToolRegistry.js');

async function main() {
  if (process.platform === 'win32') {
    console.log('toolRegistryTimeout.test.js: SKIP (POSIX process groups only)');
    return;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-command-timeout-'));
  const marker = path.join(tempDir, 'late-child-write.txt');
  try {
    const registry = new ToolRegistry({ workspaceDir: tempDir, browserEnabled: false });
    const command = `sh -c 'sleep 1; printf child > "${marker}"'`;
    const result = await registry.execCommand(command, null, { timeoutMs: 100 });
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, 124);
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(fs.existsSync(marker), false, 'a child process must not continue writing after its command timed out');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log('toolRegistryTimeout.test.js: PASS (timeout terminates shell process group; fixture removed)');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
