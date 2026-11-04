'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { AntigravityCliAdapter, formatHistory, embeddedThreefSettings } = require('../src/providers/AntigravityCliAdapter.js');
const { withResponseGuidance } = require('../src/providers/responseGuidance.js');

function fakeSpawn(results, launches) {
  return (command, args, options) => {
    launches.push({ command, args, cwd: options.cwd, env: options.env });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    process.nextTick(() => {
      const result = results.shift();
      if (result.error) child.stderr.write(result.error);
      else {
        child.stdout.write(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'agy-conv-1', step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'pwd' } } } }) + '\n');
        child.stdout.write(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'agy-conv-1', step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'pwd' }, output: '/workspace/a' } } }) + '\n');
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
    assert.equal(launches[0].cwd, '/workspace/a');
    assert.ok(launches[0].args.includes('--model'));
    assert.deepEqual(launches[0].args.slice(launches[0].args.indexOf('--effort'), launches[0].args.indexOf('--effort') + 2), ['--effort', 'high']);
    assert.deepEqual(hooks, ['Hello']);
    assert.deepEqual(tools, [['start', 'run_command'], ['output', '/workspace/a'], ['end', 'run_command']]);

    const resumed = await adapter.call(tier, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'next' }
    ], {}, { sessionId: 'session-a', reasoningEffort: 'medium' });
    assert.equal(resumed.content, 'Follow up');
    assert.ok(launches[1].args.includes('--conversation'));
    assert.deepEqual(launches[1].args.slice(launches[1].args.indexOf('--effort'), launches[1].args.indexOf('--effort') + 2), ['--effort', 'medium']);
    assert.match(launches[1].args[1], /USER\nnext/);
    assert.doesNotMatch(launches[1].args[1], /Hello/);
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
    const mcpSettings = JSON.parse(settingsArg);
    assert.equal(mcpSettings.mcpServers['onlychat-3f'].httpUrl, undefined);
    assert.equal(mcpSettings.mcpServers['onlychat-3f'].command, '/usr/bin/python3');
    assert.equal(mcpSettings.mcpServers['onlychat-3f'].args[0], bridge.serverPath);
    assert.deepEqual(mcpSettings.mcpServers['onlychat-3f'].includeTools, [
      'embedded_3f_status', 'embedded_3f_navigate', 'embedded_3f_read', 'embedded_3f_aria', 'embedded_3f_act', 'embedded_3f_history'
    ]);
    assert.equal(mcpSettings.mcpServers['onlychat-3f'].trust, true,
      'the app MCP is trusted only because mutation approval is enforced by the authenticated Only Chat endpoint');
    assert.doesNotMatch(settingsArg, /turn-secret/, 'the per-turn capability must not be placed on the process command line');
    assert.equal(launches[3].env.ONLYCHAT_MCP_TOKEN, 'turn-secret');
    assert.equal(launches[3].env.ONLYCHAT_MCP_URL, bridge.url);
    assert.equal(embeddedThreefSettings(null), null, 'turns without an active 3F panel must not receive embedded 3F tools');
    await assert.rejects(adapter.call(
      { provider: 'antigravity-cli', model: 'gpt-oss-120b-medium' },
      [{ role: 'user', content: 'unsupported' }], {},
      { sessionId: 'session-c', reasoningEffort: 'high' }
    ), /does not support the high reasoning level/);
    assert.equal(launches.length, 4, 'unsupported model/effort pairs must fail before launching the CLI');

    await assert.rejects(adapter.call(tier, [{ role: 'user', content: 'again' }]), /authentication required/);
  } finally {
    try { fs.unlinkSync(stateFile); } catch (_) {}
  }

  console.log('Antigravity CLI streaming, conversation resume, and failure handling passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
