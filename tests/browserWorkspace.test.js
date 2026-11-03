/**
 * @project Only Chat (Codex Sovereign Edition)
 * @provenance:rogan-core
 * @license MIT
 * @description Browser Workspace Unit Tests (Chrome & Firefox Sovereign Workspaces)
 */
'use strict';

const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { BrowserWorkspace } = require('../src/workspace/BrowserWorkspace.js');

async function runTests() {
  console.log('\n🧪 [Test Suite] Chrome & Firefox Browser Workspace 종합 검증 시작...\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-browser-ws-'));
  const calls = [];
  try {
    const ws = new BrowserWorkspace({
      cliPath: '/tmp/fake browser-workspace',
      workspaceDir: tmpDir,
      execFileSync: (command, args) => {
        calls.push({ command, args });
        return args[0] === '--json' ? '[]' : 'ok\n';
      }
    });
    assert.deepStrictEqual(ws.listTabs('chrome'), []);
    assert.deepStrictEqual(ws.listWorkspaces(), []);
    ws.openTab('https://example.com/"; touch /tmp/should-not-run', 'chrome');
    assert.deepStrictEqual(calls[2].args, ['open', 'https://example.com/"; touch /tmp/should-not-run', 'chrome']);
    assert.ok(calls.every(call => call.command === '/tmp/fake browser-workspace'));
    console.log('  ✓ 브라우저 명령은 셸 없이 인수 배열로 전달됨');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('\n🎉 [성공] Browser Workspace 인수 전달 검증 완료\n');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exitCode = 1;
});
