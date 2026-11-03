'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-google-mcp-'));
  const serverPath = path.join(__dirname, '../src/connectors/GoogleWorkspaceMcpServer.js');
  let child;
  try {
    child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, ONLY_CHAT_DATA_DIR: dataDir },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('MCP server did not exit after stdin closed.')); }, 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    child.stdin.end([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gmail_search', arguments: { query: 'newer_than:1d', limit: 1 } } })
    ].join('\n') + '\n');
    const exit = await closed;
    assert.equal(exit.code, 0, stderr);
    const messages = stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(messages.length, 3, stderr);
    assert.equal(messages[0].result.serverInfo.name, 'onlychat-google-workspace');
    assert.deepEqual(messages[1].result.tools.map(tool => tool.name), ['drive_search', 'drive_read', 'gmail_search', 'gmail_read']);
    assert.equal(messages[2].result.isError, true);
    assert.match(messages[2].result.content[0].text, /Google 계정이 연결되어 있지 않습니다/);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('close', resolve));
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
