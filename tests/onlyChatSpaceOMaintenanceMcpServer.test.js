'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSpaceOMaintenanceServer, tools } = require('../src/connectors/OnlyChatSpaceOMaintenanceMcpServer.js');

function makeServer({ platform = 'darwin', calls = [], stdout = '' } = {}) {
  return createSpaceOMaintenanceServer({
    platform,
    cliPath: '/home/test/.local/bin/spaceo',
    readFileSync: () => Buffer.from('signed binary fixture'),
    runCommand: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: typeof stdout === 'function' ? stdout(file, args) : stdout };
    }
  });
}

test('SpaceO maintenance connector advertises only bounded allowlisted tools', () => {
  assert.deepEqual(tools.map(item => item.name), [
    'spaceo_status', 'spaceo_set_reconfiguration_mode', 'spaceo_restart'
  ]);
  for (const item of tools) assert.equal(item.inputSchema.additionalProperties, false);
  assert.deepEqual(tools[1].inputSchema.properties.mode.enum, ['automatic', 'operatorOverride']);
  assert.deepEqual(tools[1].inputSchema.required, ['mode']);
});

test('status reads doctor and stability mode from the installed SpaceO CLI', async () => {
  const calls = [];
  const server = makeServer({ calls, stdout: (_file, args) => args[0] === 'doctor'
    ? '{"ok":true}\n' : '{"mode":"operatorOverride"}\n' });
  const result = await server.handle({ id: 1, method: 'tools/call', params: { name: 'spaceo_status', arguments: {} } });
  assert.deepEqual(JSON.parse(result.result.content[0].text), {
    doctor: { ok: true }, reconfigurationMode: { mode: 'operatorOverride' }
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['doctor', '--json']);
  assert.deepEqual(calls[1].args, ['safety', 'reconfiguration-mode', '--json']);
  assert.equal(calls[0].file, '/home/test/.local/bin/spaceo');
});

test('mode setter invokes only the supported SpaceO mode command', async () => {
  const calls = [];
  const server = makeServer({ calls, stdout: '{"mode":"automatic"}\n' });
  const result = await server.handle({ id: 1, method: 'tools/call', params: {
    name: 'spaceo_set_reconfiguration_mode', arguments: { mode: 'automatic' }
  } });
  assert.equal(result.result.content[0].text, '{"mode":"automatic"}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/home/test/.local/bin/spaceo');
  assert.deepEqual(calls[0].args, ['safety', 'reconfiguration-mode', '--mode', 'automatic', '--json']);
});

test('unknown tools and supplied arguments never execute a command', async () => {
  const calls = [];
  const server = makeServer({ calls });
  for (const params of [
    { name: 'shell.exec', arguments: {} },
    { name: 'spaceo_status', arguments: { path: '/tmp/x' } },
    { name: 'spaceo_restart', arguments: [] },
    { name: 'spaceo_set_reconfiguration_mode', arguments: { mode: 'unsafe' } },
    { name: 'spaceo_set_reconfiguration_mode', arguments: { mode: 'automatic', path: '/' } }
  ]) {
    const result = await server.handle({ id: 1, method: 'tools/call', params });
    assert.equal(result.result.isError, true);
  }
  assert.deepEqual(calls, []);
});

test('restart verifies the installed signature and exact daemon digest after restart', async () => {
  const calls = [];
  const server = makeServer({ calls, stdout: (_file, args) => args[0] === 'daemon' && args[1] === 'wait'
    ? JSON.stringify({ ok: true, daemon: { pid: 123, executableSHA256: require('node:crypto').createHash('sha256').update('signed binary fixture').digest('hex'), displaySafety: { state: 'ready' } } })
    : '' });
  const result = await server.handle({ id: 1, method: 'tools/call', params: { name: 'spaceo_restart', arguments: {} } });
  assert.deepEqual(calls.map(call => call.args), [
    ['--verify', '--strict', '/home/test/.local/bin/spaceo'],
    ['daemon', 'restart', '--operator', '--timeout', '30', '--json'],
    ['daemon', 'wait', '--timeout', '5', '--json']
  ]);
  assert.equal(JSON.parse(result.result.content[0].text).pid, 123);
});

test('restart reports a digest mismatch and non-macOS hosts refuse without execution', async () => {
  let calls = [];
  let server = makeServer({ calls, stdout: (_file, args) => args[0] === 'daemon' && args[1] === 'wait'
    ? JSON.stringify({ ok: true, daemon: { executableSHA256: 'different' } }) : '' });
  let result = await server.handle({ id: 1, method: 'tools/call', params: { name: 'spaceo_restart', arguments: {} } });
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /did not confirm/);
  calls = [];
  server = makeServer({ platform: 'linux', calls });
  result = await server.handle({ id: 1, method: 'tools/call', params: { name: 'spaceo_status', arguments: {} } });
  assert.equal(result.result.isError, true);
  assert.deepEqual(calls, []);
});

test('connector implements initialize, ping and unknown-method replies', async () => {
  const server = makeServer();
  assert.deepEqual(await server.handle({ id: 1, method: 'ping' }), { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal((await server.handle({ id: 1, method: 'initialize', params: {} })).result.serverInfo.name,
    'onlychat-spaceo-maintenance');
  assert.equal((await server.handle({ id: 1, method: 'resources/list' })).error.code, -32601);
});
