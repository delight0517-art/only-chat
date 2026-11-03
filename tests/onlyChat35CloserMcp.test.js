'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createServer } = require('../src/connectors/OnlyChat35CloserMcpServer.js');

function fakeSpawn(results, calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    const next = results.shift();
    setImmediate(() => {
      if (next instanceof Error) {
        child.stderr.end(next.message);
        child.emit('close', 1);
      } else {
        child.stdout.end(JSON.stringify({ schema: 1, client: 'onlychat', command: args[3], result: next }));
        child.emit('close', 0);
      }
    });
    return child;
  };
}

async function main() {
  const calls = [];
  const server = createServer({ cliPath: '/fake/35closerctl', spawnImpl: fakeSpawn([
    { requestId: 'generated-by-server', status: 'pending_user_approval', client: 'onlychat', idleMinutes: 20 },
    { requests: [
      { requestId: 'pending-001', client: 'onlychat', status: 'pending_user_approval' },
      { requestId: 'other-001', client: 'codex', status: 'pending_user_approval' }
    ] },
    { requests: [{ requestId: 'pending-001', client: 'onlychat', status: 'pending_user_approval' }] },
    { requestId: 'pending-001', client: 'onlychat', status: 'cancelled' },
    { requestId: 'wake-generated', status: 'pending_user_approval', client: 'onlychat', at: '2030-01-01T10:00:00.000Z' },
    { requests: [
      { requestId: 'wake-pending', client: 'onlychat', status: 'pending_user_approval' },
      { requestId: 'wake-other', client: 'codex', status: 'pending_user_approval' }
    ] },
    { requests: [{ requestId: 'wake-pending', client: 'onlychat', status: 'pending_user_approval' }] },
    { requestId: 'wake-pending', client: 'onlychat', status: 'cancelled' },
    { available: true, fresh: true, ageSeconds: 0.2, policy: { owner: '35Closer', remotePowerChangesAllowed: false } }
  ], calls) });

  const submitted = await server.invoke('sleep_request', { idle_minutes: 20 });
  assert.equal(submitted.status, 'pending_user_approval');
  assert.equal(calls[0].command, '/fake/35closerctl');
  assert.deepEqual(calls[0].args.slice(0, 4), ['agent', '--client', 'onlychat', 'sleep-request']);
  assert.match(calls[0].args[calls[0].args.indexOf('--id') + 1], /^[0-9a-f-]{36}$/i);
  assert.deepEqual(calls[0].args.slice(-2), ['--idle-minutes', '20']);
  assert.equal(calls[0].options.shell, false);

  const listed = await server.invoke('sleep_requests', {});
  assert.deepEqual(listed.requests.map(row => row.requestId), ['pending-001']);
  const cancelled = await server.invoke('sleep_cancel', { request_id: 'pending-001' });
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(calls[3].args.slice(0, 4), ['agent', '--client', 'onlychat', 'sleep-cancel']);

  await assert.rejects(server.invoke('sleep_request', { idle_minutes: 4 }), /5 to 1440/);
  await assert.rejects(server.invoke('sleep_request', { idle_minutes: 30, request_id: 'caller-controlled' }), /5 to 1440/);
  await assert.rejects(server.invoke('unknown', {}), /Unknown 35Closer tool/);

  const wakeAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const wake = await server.invoke('wake_request', { at: wakeAt, start_if_off: false });
  assert.equal(wake.status, 'pending_user_approval');
  assert.deepEqual(calls[4].args.slice(0, 4), ['agent', '--client', 'onlychat', 'wake-request']);
  assert.equal(calls[4].args.includes('--power-on'), false);
  assert.equal(calls[4].args[calls[4].args.indexOf('--at') + 1], wakeAt);
  assert.match(calls[4].args[calls[4].args.indexOf('--id') + 1], /^[0-9a-f-]{36}$/i);
  const wakeList = await server.invoke('wake_requests', {});
  assert.deepEqual(wakeList.requests.map(row => row.requestId), ['wake-pending']);
  const wakeCancelled = await server.invoke('wake_cancel', { request_id: 'wake-pending' });
  assert.equal(wakeCancelled.status, 'cancelled');
  assert.deepEqual(calls[7].args.slice(0, 4), ['agent', '--client', 'onlychat', 'wake-cancel']);
  await assert.rejects(server.invoke('wake_request', { at: '2030-01-01T10:00:00', start_if_off: false }), /ISO 8601/);
  await assert.rejects(server.invoke('wake_request', { at: wakeAt, start_if_off: 'false' }), /ISO 8601/);
  await assert.rejects(server.invoke('wake_request', { at: new Date(Date.now() - 60_000).toISOString(), start_if_off: false }), /2 minutes/);
  await assert.rejects(server.invoke('wake_request', { at: wakeAt, start_if_off: false, request_id: 'caller-controlled' }), /ISO 8601/);

  const status = await server.invoke('timer_status', {});
  assert.equal(status.fresh, true);
  assert.equal(status.policy.owner, '35Closer');
  assert.deepEqual(calls[8].args.slice(0, 4), ['agent', '--client', 'onlychat', 'status']);
  await assert.rejects(server.invoke('timer_status', { include_private_details: true }), /takes no arguments/);

  const protocol = await server.handle({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
  assert.equal(protocol.result.tools.length, 7);
  assert.equal(protocol.result.tools.find(tool => tool.name === 'timer_status').annotations.readOnlyHint, true);
  assert.equal(protocol.result.tools.find(tool => tool.name === 'sleep_request').annotations.destructiveHint, true);
  assert.equal(protocol.result.tools.find(tool => tool.name === 'wake_request').annotations.destructiveHint, true);
  console.log('onlyChat35CloserMcp.test.js: PASS (sleep/wake intent request, Only Chat filtering, pending-only cancel, validation, MCP listing)');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
