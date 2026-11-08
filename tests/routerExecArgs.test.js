'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isApprovedNewFileWrite, parseRouterExecArgs } = require('../src/cli/routerExecArgs.js');

test('pins a Router model and defaults it to read-only tools', () => {
  assert.deepEqual(parseRouterExecArgs(['--router-model', 'gpt-6-luna', 'Read Pomodoro TODO']), {
    routerModel: 'gpt-6-luna', toolProfile: 'file-read', workspaceRoot: null, approvedTools: [], approvedWritePaths: [], prompt: 'Read Pomodoro TODO'
  });
});

test('requires explicit file-edit profile for edit approval', () => {
  assert.deepEqual(parseRouterExecArgs([
    '--router-model', 'gpt-6-luna', '--tool-profile', 'file-edit', '--approve-tool', 'edit_file', 'Update TODO'
  ]), {
    routerModel: 'gpt-6-luna', toolProfile: 'file-edit', workspaceRoot: null, approvedTools: ['edit_file'], approvedWritePaths: [], prompt: 'Update TODO'
  });
  assert.deepEqual(parseRouterExecArgs([
    '--router-model', 'gpt-6-luna', '--tool-profile', 'file-write', '--approve-tool', 'write_file',
    '--approve-write-path', 'Tests/ThreeFBrowserTests/BrowserMediaCapabilityTests.swift', 'Add a new test file'
  ]), {
    routerModel: 'gpt-6-luna', toolProfile: 'file-write', workspaceRoot: null, approvedTools: ['write_file'],
    approvedWritePaths: ['Tests/ThreeFBrowserTests/BrowserMediaCapabilityTests.swift'], prompt: 'Add a new test file'
  });
  assert.throws(() => parseRouterExecArgs(['--approve-tool', 'edit_file', 'Update TODO']), /file-edit/);
  assert.throws(() => parseRouterExecArgs([
    '--tool-profile', 'file-write', '--approve-tool', 'write_file', 'Add a new file'
  ]), /정확한 --approve-write-path/);
  assert.throws(() => parseRouterExecArgs([
    '--tool-profile', 'file-write', '--approve-write-path', 'new.txt', 'Add a new file'
  ]), /--approve-tool write_file/);
  assert.throws(() => parseRouterExecArgs([
    '--tool-profile', 'file-write', '--approve-tool', 'write_file', '--approve-write-path', '../outside.txt', 'Add a new file'
  ]), /workspace 내부/);
  for (const profile of ['file-read', 'file-search']) {
    assert.throws(() => parseRouterExecArgs([
      '--tool-profile', profile, '--approve-tool', 'write_file', 'Update TODO'
    ]), /file-write/);
  }
});

test('accepts only an explicit existing absolute Router workspace root', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'only-chat-router-workspace-'));
  try {
    const realRoot = fs.realpathSync(temporary);
    const regularFile = path.join(temporary, 'not-a-directory');
    fs.writeFileSync(regularFile, 'content', 'utf8');
    assert.deepEqual(parseRouterExecArgs([
      '--router-model', 'gpt-6-luna', '--tool-profile', 'file-search', '--workspace-root', temporary, 'Inspect TODO'
    ]), {
      routerModel: 'gpt-6-luna', toolProfile: 'file-search', workspaceRoot: realRoot,
      approvedTools: [], approvedWritePaths: [], prompt: 'Inspect TODO'
    });
    assert.throws(() => parseRouterExecArgs(['--workspace-root', temporary, 'Inspect TODO']), /--router-model/);
    assert.throws(() => parseRouterExecArgs(['--router-model', 'gpt-6-luna', '--workspace-root', 'relative/path', 'Inspect TODO']), /절대 경로/);
    assert.throws(() => parseRouterExecArgs(['--router-model', 'gpt-6-luna', '--workspace-root', path.join(temporary, 'missing'), 'Inspect TODO']), /찾을 수 없습니다/);
    assert.throws(() => parseRouterExecArgs(['--router-model', 'gpt-6-luna', '--workspace-root', regularFile, 'Inspect TODO']), /디렉터리/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('rejects non-Router models, unapproved tool profiles, and tools', () => {
  assert.throws(() => parseRouterExecArgs(['--router-model', 'qwen2.5:3b', 'Read TODO']), /AI Account Router/);
  assert.throws(() => parseRouterExecArgs(['--tool-profile', 'browser', 'Read TODO']), /file-read, file-search, file-edit 또는 file-write/);
  for (const tool of ['exec_command', 'browser', 'qwen']) {
    assert.throws(() => parseRouterExecArgs(['--approve-tool', tool, 'Run command']), /edit_file 또는 write_file/);
  }
});

test('approves only the exact new workspace file path for an explicit write_file call', () => {
  const workspaceDir = '/workspace';
  const baseOptions = {
    workspaceDir,
    approvedWritePaths: ['Tests/ThreeFBrowserTests/BrowserMediaCapabilityTests.swift']
  };
  assert.equal(isApprovedNewFileWrite({
    name: 'write_file', args: { path: 'Tests/ThreeFBrowserTests/BrowserMediaCapabilityTests.swift' }
  }, {
    ...baseOptions,
    existsSync: value => value === '/workspace/Tests/ThreeFBrowserTests',
    realpathSync: value => value
  }), true);
  assert.equal(isApprovedNewFileWrite({
    name: 'write_file', args: { path: 'Sources/ThreeFBrowser/BrowserView.swift' }
  }, { ...baseOptions, existsSync: () => false, realpathSync: value => value }), false);
  assert.equal(isApprovedNewFileWrite({
    name: 'write_file', args: { path: 'Tests/ThreeFBrowserTests/BrowserMediaCapabilityTests.swift' }
  }, {
    ...baseOptions,
    existsSync: value => value === '/workspace/Tests/ThreeFBrowserTests' || value === '/workspace/Tests/ThreeFBrowserTests/BrowserMediaCapabilityTests.swift',
    realpathSync: value => value
  }), false);
  assert.equal(isApprovedNewFileWrite({
    name: 'write_file', args: { path: '../outside.swift' }
  }, { ...baseOptions, existsSync: () => false, realpathSync: value => value }), false);
  assert.equal(isApprovedNewFileWrite({
    name: 'edit_file', args: { path: 'Tests/ThreeFBrowserTests/BrowserMediaCapabilityTests.swift' }
  }, { ...baseOptions, existsSync: () => false, realpathSync: value => value }), false);
});
