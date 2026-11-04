'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { AntigravityCliAdapter, formatHistory, embeddedThreefSettings, workspaceMcpSettings } = require('../src/providers/AntigravityCliAdapter.js');
const { withResponseGuidance } = require('../src/providers/responseGuidance.js');

function fakeSpawn(results, launches) {
  return (command, args, options) => {
    const fs = require('node:fs');
    const path = require('node:path');
    const mcpConfigPath = path.join(options.cwd, '.agents', 'mcp_config.json');
    const agentDir = path.join(options.cwd, '.agents', 'agents');
    const agentPath = fs.existsSync(agentDir)
      ? path.join(agentDir, fs.readdirSync(agentDir)[0], 'agent.md') : '';
    launches.push({ command, args, cwd: options.cwd, env: options.env,
      mcpConfig: fs.existsSync(mcpConfigPath) ? JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8')) : null,
      mcpConfigMode: fs.existsSync(mcpConfigPath) ? fs.statSync(mcpConfigPath).mode & 0o777 : null,
      agent: agentPath ? fs.readFileSync(agentPath, 'utf8') : '',
      workspaceMode: fs.statSync(options.cwd).mode & 0o777 });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    process.nextTick(() => {
      const result = results.shift();
      if (result.error) child.stderr.write(result.error);
      else {
        child.stdout.write(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'agy-conv-1', step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { parameters: { serverName: 'onlychat-3f', toolName: 'embedded_3f_status', arguments: {} } } } }) + '\n');
        child.stdout.write(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'agy-conv-1', step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { name: 'call_mcp_tool', parameters: { serverName: 'onlychat-3f', toolName: 'embedded_3f_status', arguments: {} }, output: '{"available":true}' } } }) + '\n');
        child.stdout.write(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Hello' } }) + '\n');
        child.stdout.write(JSON.stringify({ event: 'result', result: result.value }) + '\n');
      }
      child.stdout.end();
      child.stderr.end();
      child.emit('close', result.code || 0);
    });
    return child;
  };
}

async function main() {
  assert.equal(formatHistory([{ role: 'user', content: 'hi' }]), withResponseGuidance('USER\nhi'));
  assert.match(formatHistory([{ role: 'user', content: 'hi' }]), /USER\nhi$/);
  const stateFile = `/tmp/onlychat-provider-${process.pid}.json`;
  const fs = require('node:fs');
  const launches = [];
  const hooks = [];
  const tools = [];
  const results = [
    { value: { status: 'SUCCESS', response: 'Hello', conversation_id: 'agy-conv-1' } },
    { value: { status: 'SUCCESS', response: 'Follow up', conversation_id: 'agy-conv-1' } },
    { value: { status: 'SUCCESS', response: 'Effort matched', conversation_id: 'agy-conv-2' } },
    { value: { status: 'SUCCESS', response: 'MCP configured', conversation_id: 'agy-conv-3' } },
    { value: { status: 'SUCCESS', response: 'Workspace MCP configured', conversation_id: 'agy-conv-4' } },
    { value: { status: 'SUCCESS', response: 'Read-only workspace MCP configured', conversation_id: 'agy-conv-5' } },
    { value: { status: 'ERROR', response: '', error: 'authentication required' }, code: 1 }
  ];
  try {
    const adapter = new AntigravityCliAdapter({
      command: '/mock/agy', stateFile, timeoutMs: 2000,
      spawn: fakeSpawn(results, launches)
    });
    const tier = { provider: 'antigravity-cli', model: 'gemini-model' };
    const first = await adapter.call(tier, [{ role: 'user', content: 'hi' }], {
      onMessageDelta: value => hooks.push(value),
      onToolStart: call => tools.push(['start', call.name]),
      onToolOutput: value => tools.push(['output', value.text]),
      onToolEnd: value => tools.push(['end', value.call.name])
    }, { sessionId: 'session-a', workspaceDir: '/workspace/a', reasoningEffort: 'high' });
    assert.equal(first.content, 'Hello');
    assert.notEqual(launches[0].cwd, '/workspace/a');
    assert.equal(launches[0].workspaceMode, 0o700);
    assert.doesNotMatch(launches[0].agent, /call_mcp_tool/, 'do not allowlist a tool name Antigravity does not register');
    assert.match(launches[0].agent, /commandExecutionPolicy: off/);
    assert.equal(fs.existsSync(launches[0].cwd), false, 'per-turn agent workspace must be removed after completion');
    assert.ok(launches[0].args.includes('--model'));
    assert.deepEqual(launches[0].args.slice(launches[0].args.indexOf('--effort'), launches[0].args.indexOf('--effort') + 2), ['--effort', 'high']);
    assert.deepEqual(hooks, ['Hello']);
    assert.deepEqual(tools, [['start', 'call_mcp_tool'], ['output', '{"available":true}'], ['end', 'call_mcp_tool']]);

    const resumed = await adapter.call(tier, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'next' }
    ], {}, { sessionId: 'session-a', reasoningEffort: 'medium' });
    assert.equal(resumed.content, 'Follow up');
    assert.ok(launches[1].args.includes('--conversation'));
    assert.deepEqual(launches[1].args.slice(launches[1].args.indexOf('--effort'), launches[1].args.indexOf('--effort') + 2), ['--effort', 'medium']);
    const resumedPrompt = launches[1].args[launches[1].args.indexOf('--print') + 1];
    assert.match(resumedPrompt, /USER\nnext/);
    assert.doesNotMatch(resumedPrompt, /Hello/);
    assert.equal(new AntigravityCliAdapter({ stateFile }).conversations['session-a'].conversationId, 'agy-conv-1');

    const effortMatched = await adapter.call(
      { provider: 'antigravity-cli', model: 'gemini-3.8-flash-medium' },
      [{ role: 'user', content: 'check' }], {},
      { sessionId: 'session-b', workspaceDir: '/workspace/a', reasoningEffort: 'low' }
    );
    assert.equal(effortMatched.content, 'Effort matched');
    assert.equal(launches[2].args[launches[2].args.indexOf('--model') + 1], 'gemini-3.8-flash-low');
    assert.equal(launches[2].args.includes('--effort'), false,
      'models with an effort suffix must use the matching model variant without a conflicting --effort flag');
    const bridge = { url: 'http://127.0.0.1:8899/api/mcp/embedded-3f', token: 'turn-secret', serverPath: '/app/onlychat-embedded-3f-mcp.py' };
    const mcpTurn = await adapter.call(tier, [{ role: 'user', content: 'inspect 3F' }], {}, {
      sessionId: 'session-d', reasoningEffort: 'low', embeddedThreefMcp: bridge
    });
    assert.equal(mcpTurn.content, 'MCP configured');
    const settingsArg = launches[3].args[launches[3].args.indexOf('--settings') + 1];
    const cliSettings = JSON.parse(settingsArg);
    assert.deepEqual(cliSettings.permissions.allow, ['mcp(onlychat-3f/*)']);
    assert.deepEqual(cliSettings.permissions.deny, ['command(*)', 'read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)']);
    assert.equal(cliSettings.mcp, undefined, 'MCP configuration must not be placed in Antigravity settings');
    assert.equal(cliSettings.mcpServers, undefined);
    assert.equal(launches[3].mcpConfigMode, 0o600, 'the ephemeral MCP config must be owner-only');
    const mcpConfig = launches[3].mcpConfig;
    assert.equal(mcpConfig.mcpServers['onlychat-3f'].command, '/usr/bin/python3');
    assert.equal(mcpConfig.mcpServers['onlychat-3f'].args[0], bridge.serverPath);
    assert.deepEqual(mcpConfig.mcpServers['onlychat-3f'].enabledTools, [
      'read_file', 'edit_file', 'embedded_3f_status', 'embedded_3f_navigate', 'embedded_3f_read', 'embedded_3f_aria', 'embedded_3f_act', 'embedded_3f_history',
      'threef_browser_status', 'threef_browser_navigate', 'threef_browser_read', 'threef_browser_aria', 'threef_browser_act', 'threef_browser_history'
    ]);
    assert.match(launches[3].agent, /Use threef_browser_\* tools when the user means the standalone 3F Browser app/);
    assert.match(launches[3].agent, /never treat these two views as the same page/);
    assert.equal(mcpConfig.mcpServers['onlychat-3f'].includeTools, undefined);
    assert.equal(mcpConfig.mcpServers['onlychat-3f'].trust, undefined);
    assert.equal(mcpConfig.mcpServers['onlychat-3f'].env.ONLYCHAT_MCP_URL, bridge.url);
    assert.equal(mcpConfig.mcpServers['onlychat-3f'].env.ONLYCHAT_MCP_TOKEN, 'turn-secret');
    assert.doesNotMatch(settingsArg, /turn-secret/, 'the per-turn capability must not be placed on the process command line');
    assert.equal(JSON.stringify(launches[3].args).includes('turn-secret'), false, 'the per-turn capability must not be placed on the process command line');
    assert.equal(embeddedThreefSettings(null), null, 'turns without an active 3F panel must not receive embedded 3F tools');
    assert.equal(fs.existsSync(launches[3].cwd), false, 'ephemeral MCP configuration and token must be removed after completion');

    let writeApproval;
    const workspaceTurn = await adapter.call(tier, [{ role: 'user', content: 'inspect and improve a workspace TODO' }], {}, {
      sessionId: 'session-workspace-123', workspaceDir: '/workspace/a', reasoningEffort: 'low', approvalPolicy: 'on-request',
      requestWorkspaceWriteApproval: async request => { writeApproval = request; return true; }
    });
    assert.equal(workspaceTurn.content, 'Workspace MCP configured');
    assert.deepEqual(writeApproval, {
      directory: '/workspace/a',
      reason: 'Antigravity 작업 에이전트에 선택 작업공간의 파일 도구를 연결합니다. 편집 도구는 Only Chat 승인과 파일별 lease가 모두 있어야 동작합니다.'
    });
    const workspaceSettingsArg = launches[4].args[launches[4].args.indexOf('--settings') + 1];
    const workspaceSettings = JSON.parse(workspaceSettingsArg);
    assert.deepEqual(workspaceSettings.permissions.allow, ['mcp(onlychat-workspace/*)', 'mcp(onlychat-workspace-coordination/*)']);
    const workspaceMcp = launches[4].mcpConfig.mcpServers['onlychat-workspace'];
    assert.equal(workspaceMcp.args[0], path.join(__dirname, '../src/connectors/OnlyChatWorkspaceMcpServer.js'));
    assert.deepEqual(workspaceMcp.enabledTools, ['workspace_file_read', 'workspace_file_edit', 'workspace_file_create', 'workspace_check']);
    assert.deepEqual(workspaceMcp.env, {
      ONLY_CHAT_WORKSPACE_DIR: '/workspace/a', ONLY_CHAT_SESSION_ID: 'session-workspace-123', ONLY_CHAT_WRITE_APPROVED: '1'
    });
    assert.deepEqual(launches[4].mcpConfig.mcpServers['onlychat-workspace-coordination'].enabledTools,
      ['workspace_lease_status', 'workspace_lease_claim', 'workspace_lease_release']);
    assert.match(launches[4].agent, /claim the exact relative files/);
    assert.match(launches[4].agent, /false alone does not establish a repository-wide or feature lock/);
    assert.match(launches[4].agent, /lease kind, paths, task, and owner/);
    assert.match(launches[4].agent, /active writers, and app runtime state distinct/);
    assert.equal(fs.existsSync(launches[4].cwd), false, 'workspace MCP config is removed after the provider turn');

    const readOnlyTurn = await adapter.call(tier, [{ role: 'user', content: 'read a workspace source file' }], {}, {
      sessionId: 'session-workspace-readonly', workspaceDir: '/workspace/a', reasoningEffort: 'low', approvalPolicy: 'read-only'
    });
    assert.equal(readOnlyTurn.content, 'Read-only workspace MCP configured');
    assert.deepEqual(launches[5].mcpConfig.mcpServers['onlychat-workspace'].enabledTools, ['workspace_file_read']);
    assert.equal(launches[5].mcpConfig.mcpServers['onlychat-workspace-coordination'], undefined);
    assert.equal(workspaceMcpSettings({ workspaceDir: '/workspace/a', sessionId: 'short' }), null,
      'workspace MCP must fail closed when the Only Chat session identity is unavailable');
    assert.equal(fs.existsSync(launches[5].cwd), false);
    await assert.rejects(adapter.call(
      { provider: 'antigravity-cli', model: 'gpt-oss-120b-medium' },
      [{ role: 'user', content: 'unsupported' }], {},
      { sessionId: 'session-c', reasoningEffort: 'high' }
    ), /does not support the high reasoning level/);
    assert.equal(launches.length, 6, 'unsupported model/effort pairs must fail before launching the CLI');

    await assert.rejects(adapter.call(tier, [{ role: 'user', content: 'again' }]), /authentication required/);
    assert.equal(fs.existsSync(launches.at(-1).cwd), false, 'ephemeral configuration must be removed after provider failure');

    let killedSignal = null;
    const stalledChild = new EventEmitter();
    stalledChild.stdout = new PassThrough();
    stalledChild.stderr = new PassThrough();
    stalledChild.kill = value => { killedSignal = value; };
    const cancellableAdapter = new AntigravityCliAdapter({
      stateFile: path.join(__dirname, `.onlychat-cancel-${process.pid}.json`),
      spawn: () => stalledChild,
      timeoutMs: 10_000
    });
    const controller = new AbortController();
    const pending = cancellableAdapter._run([], '/workspace/a', {}, {}, controller.signal);
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(killedSignal, 'SIGTERM', 'client disconnect must stop the provider child');
  } finally {
    try { fs.unlinkSync(stateFile); } catch (_) {}
  }

  console.log('Antigravity CLI streaming, conversation resume, and failure handling passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
