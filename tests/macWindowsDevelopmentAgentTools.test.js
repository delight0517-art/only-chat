'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { AgentEngine } = require('../src/core/AgentEngine.js');
const { MacWindowsDevelopment } = require('../src/core/MacWindowsDevelopment.js');
const { ToolRegistry } = require('../src/tools/ToolRegistry.js');

function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }); }
function makeEngine(store, sessionId, approvalPolicy = 'never') {
  const engine = Object.create(AgentEngine.prototype);
  engine.currentSession = { sessionId };
  engine.tools = new ToolRegistry({ macWindowsDevelopment: store, approvalPolicy, providerConnectionsEnabled: false, browserEnabled: false });
  return engine;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-joint-agent-'));
  try {
    const repo = path.join(root, 'canonical'); fs.mkdirSync(repo);
    git(repo, 'init', '--quiet', '--initial-branch=main'); git(repo, 'config', 'user.email', 'joint@example.invalid'); git(repo, 'config', 'user.name', 'Joint');
    fs.writeFileSync(path.join(repo, 'README.md'), 'source\n'); git(repo, 'add', 'README.md'); git(repo, 'commit', '--quiet', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    const store = new MacWindowsDevelopment({ dataDir: path.join(root, 'data'), platform: 'darwin' });
    const contract = { taskKey: 'agent-plan-task', title: 'Shared app work', app: 'Sample', goal: 'Implement disjoint platform features', integrationBase: base,
      mac: { owner: 'Mac session', source: repo, baseCommit: base, paths: ['mac'] },
      windows: { owner: 'Windows session', source: 'C:/unknown/source', baseCommit: base, paths: ['windows'] } };
    const chat = makeEngine(store, 'session-agent-plan');
    const assessed = await chat._executeToolCall({ id: 'assess', name: 'joint_development_assess', args: contract });
    assert.equal(assessed.feasible, 'ready');
    assert.equal(assessed.localSource.baseCommit, base);
    assert.equal(store.list().length, 0, 'assessment must not create a task');
    const created = await chat._executeToolCall({ id: 'create', name: 'joint_development_create', args: contract });
    assert.equal(created.created, true);
    assert.equal((await makeEngine(store, 'session-reader')._executeToolCall({ id: 'list', name: 'joint_development_list', args: {} })).length, 1);
    assert.equal((await makeEngine(store, 'session-reader')._executeToolCall({ id: 'read', name: 'joint_development_read', args: { taskKey: contract.taskKey } })).taskKey, contract.taskKey);
    await assert.rejects(() => makeEngine(store, 'session-reader', 'read-only')._executeToolCall({ id: 'denied', name: 'joint_development_create', args: { ...contract, taskKey: 'blocked-by-policy' } }), /blocked under read-only policy/);
    const invalid = await chat._executeToolCall({ id: 'invalid-assess', name: 'joint_development_assess', args: { ...contract, taskKey: 'overlap', windows: { ...contract.windows, paths: ['MAC'] } } });
    assert.equal(invalid.feasible, 'blocked');

    const { toolDefinitions } = await import('../src/features/provider/v1.mjs');
    const all = toolDefinitions('on-request');
    assert.ok(all.some(tool => tool.function.name === 'joint_development_assess'));
    assert.ok(all.some(tool => tool.function.name === 'joint_development_create'));
    const readOnly = toolDefinitions('read-only').map(tool => tool.function.name);
    assert.ok(readOnly.includes('joint_development_assess'));
    assert.ok(!readOnly.includes('joint_development_create'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log('macWindowsDevelopmentAgentTools.test.js: passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
