'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createServer } = require('../src/connectors/OnlyChatWorkspaceMcpServer.js');

test('Only Chat workspace MCP confines reads and requires this session file lease for edits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-workspace-mcp-'));
  try {
    const workspaceDir = fs.realpathSync(root);
    const source = path.join(workspaceDir, 'sample.js');
    fs.writeFileSync(source, 'const value = 1;\nconsole.log(value);\n');
    fs.mkdirSync(path.join(root, 'tests'));
    fs.writeFileSync(path.join(root, 'tests/sample.test.js'), '');
    let leases = [];
    const server = createServer({
      workspaceDir, sessionId: 'session_workspace_001', writeApproved: true,
      repo: path.join(workspaceDir, '.git'), readOwnedLeaseRows: () => leases,
      run: async (command, args, cwd) => ({ command, args, cwd, exitCode: 0, stdout: 'ok', stderr: '' })
    });

    assert.deepEqual(server.tools.map(tool => tool.name), ['workspace_file_read', 'workspace_file_edit', 'workspace_file_create', 'workspace_check']);
    assert.match(server.tools.find(tool => tool.name === 'workspace_file_read').description, /start_line.*end_line/);
    assert.match(server.tools.find(tool => tool.name === 'workspace_check').description, /"kind":"syntax".*"path"/);
    assert.match(server.tools.find(tool => tool.name === 'workspace_check').description, /omit path/);
    assert.equal((await server.invoke('workspace_file_read', { path: 'sample.js' })).content, 'const value = 1;\nconsole.log(value);\n');
    await assert.rejects(server.invoke('workspace_file_edit', { path: 'sample.js', target: 'value = 1', replacement: 'value = 2' }), /lease/);
    leases = [[source]];
    assert.deepEqual(await server.invoke('workspace_file_edit', { path: 'sample.js', target: 'value = 1', replacement: 'value = 2' }), {
      path: 'sample.js', modified: true, bytes: Buffer.byteLength('const value = 2;\nconsole.log(value);\n')
    });
    await assert.rejects(server.invoke('workspace_file_edit', { path: 'sample.js', target: 'value', replacement: 'item' }), /exactly once/);
    assert.deepEqual(await server.invoke('workspace_check', { kind: 'test', path: 'tests/sample.test.js' }), {
      command: process.execPath, args: ['--test', path.join(workspaceDir, 'tests/sample.test.js')], cwd: workspaceDir, exitCode: 0, stdout: 'ok', stderr: ''
    });
    leases = [[source, path.join(workspaceDir, 'new.txt')]];
    assert.deepEqual(await server.invoke('workspace_file_create', { path: 'new.txt', content: 'new' }), { path: 'new.txt', created: true, bytes: 3 });
    await assert.rejects(server.invoke('workspace_file_create', { path: 'sample.js', content: 'overwrite' }), /EEXIST/);
    await assert.rejects(server.invoke('workspace_file_read', { path: '../outside' }), /cannot traverse/);
    await assert.rejects(server.invoke('workspace_file_read', { path: '.env.local' }), /Secret-like/);

    const listed = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(listed.result.tools.length, 4);
    const called = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'workspace_file_read', arguments: { path: 'sample.js' } } });
    assert.equal(called.result.structuredContent.content, 'const value = 2;\nconsole.log(value);\n');

    const readOnly = createServer({ workspaceDir, sessionId: 'session_workspace_002', writeApproved: false, repo: path.join(workspaceDir, '.git'), readOwnedLeaseRows: () => [] });
    assert.deepEqual(readOnly.tools.map(tool => tool.name), ['workspace_file_read']);
    await assert.rejects(readOnly.invoke('workspace_file_edit', { path: 'sample.js', target: '2', replacement: '3' }), /requires Only Chat approval/);
    await assert.rejects(server.invoke('workspace_check', { kind: 'shell', path: 'sample.js' }), /limited to Node syntax/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
