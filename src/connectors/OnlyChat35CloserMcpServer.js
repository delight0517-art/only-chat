'use strict';

const readline = require('node:readline');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const DEFAULT_CLI = path.join(os.homedir(), 'appDev/devtool/35Closer_App/scripts/35closerctl');
const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
const HAS_TIMEZONE = /(Z|[+-]\d{2}:\d{2})$/i;

const tools = [
  {
    name: 'timer_status', title: 'Read 35Closer Timer status',
    description: 'Read the fresh 35Closer Timer state, idle policy, and Only Chat power-approval boundary. This does not change timer or power settings.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'sleep_request', title: 'Request sleep after idle through 35Closer',
    description: 'Submit a one-time sleep-after-idle intent to 35Closer Timer. This never sleeps the Mac by itself: the user must approve the request in the 35Closer app. Use when the user explicitly asks to sleep after work is idle.',
    inputSchema: { type: 'object', properties: { idle_minutes: { type: 'integer', minimum: 5, maximum: 1440, description: 'How long the Mac must remain idle before 35Closer applies the approved request.' } }, required: ['idle_minutes'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'sleep_requests', title: 'List Only Chat sleep requests',
    description: 'Read pending and recent Only Chat sleep intents from 35Closer Timer. Approval is only available in the 35Closer app UI.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'sleep_cancel', title: 'Cancel a pending Only Chat sleep request',
    description: 'Cancel an Only Chat sleep intent only while it is pending user approval. Does not alter the Mac power state.',
    inputSchema: { type: 'object', properties: { request_id: { type: 'string', minLength: 8, maxLength: 80, pattern: '^[A-Za-z0-9_-]+$' } }, required: ['request_id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'wake_request', title: 'Request a wake schedule through 35Closer',
    description: 'Submit a one-time Mac wake intent to 35Closer Timer. This never schedules or wakes the Mac by itself: the user must review and approve the request in the 35Closer app.',
    inputSchema: { type: 'object', properties: { at: { type: 'string', minLength: 20, maxLength: 40, description: 'ISO 8601 date and time with an explicit timezone, at least 2 minutes in the future.' }, start_if_off: { type: 'boolean', description: 'Whether to power on if the Mac is off; still requires approval in 35Closer.' } }, required: ['at', 'start_if_off'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'wake_requests', title: 'List Only Chat wake requests',
    description: 'Read pending and recent Only Chat wake intents from 35Closer Timer. Approval is only available in the 35Closer app UI.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'wake_cancel', title: 'Cancel a pending Only Chat wake request',
    description: 'Cancel an Only Chat wake intent only while it is pending user approval. Does not change the Mac power state.',
    inputSchema: { type: 'object', properties: { request_id: { type: 'string', minLength: 8, maxLength: 80, pattern: '^[A-Za-z0-9_-]+$' } }, required: ['request_id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
];

function envelope(stdout, command) {
  let value;
  try { value = JSON.parse(stdout); }
  catch (_) { throw new Error('35Closer CLI returned invalid JSON.'); }
  if (value?.error) throw new Error(`35Closer ${command} failed: ${String(value.error.code || 'unknown_error')}`);
  if (value?.client !== 'onlychat' || value?.command !== command || !value.result || typeof value.result !== 'object') {
    throw new Error('35Closer CLI response did not match the Only Chat request.');
  }
  return value.result;
}

function createServer(options = {}) {
  const cliPath = path.resolve(options.cliPath || process.env.ONLY_CHAT_35CLOSER_CLI || DEFAULT_CLI);
  const spawnImpl = options.spawnImpl || spawn;
  const timeoutMs = options.timeoutMs || 10_000;

  function run(command, extraArgs = []) {
    const args = ['agent', '--client', 'onlychat', command, ...extraArgs];
    return new Promise((resolve, reject) => {
      let child;
      try { child = spawnImpl(cliPath, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs }); }
      catch (_) { reject(new Error('35Closer Timer CLI could not be started.')); return; }
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill?.('SIGTERM');
        reject(new Error('35Closer Timer CLI timed out.'));
      }, timeoutMs);
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(result);
      };
      child.stdout?.on('data', chunk => {
        stdout += chunk.toString('utf8');
        if (Buffer.byteLength(stdout) > 1024 * 1024) {
          child.kill?.('SIGTERM');
          finish(new Error('35Closer Timer CLI response was too large.'));
        }
      });
      child.stderr?.on('data', chunk => { stderr += chunk.toString('utf8').slice(0, 2000); });
      child.once('error', () => finish(new Error('35Closer Timer CLI could not be started.')));
      child.once('close', code => {
        if (code !== 0) return finish(new Error(`35Closer ${command} failed${stderr ? `: ${stderr.trim().slice(0, 240)}` : ` (exit ${code})`}.`));
        try { finish(null, envelope(stdout.trim(), command)); }
        catch (error) { finish(error); }
      });
    });
  }

  async function invoke(name, args = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
    if (name === 'timer_status') {
      if (Object.keys(args).length) throw new Error('timer_status takes no arguments.');
      return run('status');
    }
    if (name === 'sleep_request') {
      const keys = Object.keys(args);
      const idleMinutes = args.idle_minutes;
      if (keys.length !== 1 || !Number.isInteger(idleMinutes) || idleMinutes < 5 || idleMinutes > 1440) throw new Error('idle_minutes must be an integer from 5 to 1440.');
      const requestId = crypto.randomUUID();
      return run('sleep-request', ['--id', requestId, '--idle-minutes', String(idleMinutes)]);
    }
    if (name === 'sleep_requests') {
      if (Object.keys(args).length) throw new Error('sleep_requests takes no arguments.');
      const result = await run('sleep-requests');
      result.requests = Array.isArray(result.requests) ? result.requests.filter(row => row?.client === 'onlychat') : [];
      return result;
    }
    if (name === 'sleep_cancel') {
      const requestId = args.request_id;
      if (Object.keys(args).length !== 1 || typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw new Error('request_id is invalid.');
      const result = await run('sleep-requests', ['--id', requestId]);
      const row = (Array.isArray(result.requests) ? result.requests : []).find(item => item?.requestId === requestId && item?.client === 'onlychat');
      if (!row) throw new Error('Only Chat sleep request was not found.');
      if (row.status !== 'pending_user_approval') throw new Error('Only pending 35Closer approval requests can be cancelled.');
      return run('sleep-cancel', ['--id', requestId]);
    }
    if (name === 'wake_request') {
      const { at, start_if_off: startIfOff } = args;
      if (Object.keys(args).length !== 2 || typeof at !== 'string' || at.length < 20 || at.length > 40 || !HAS_TIMEZONE.test(at) || !Number.isFinite(Date.parse(at)) || typeof startIfOff !== 'boolean') {
        throw new Error('at must be an ISO 8601 date-time with timezone, and start_if_off must be boolean.');
      }
      const when = Date.parse(at);
      if (when <= Date.now() + 2 * 60_000 || when > Date.now() + 366 * 24 * 60 * 60_000) throw new Error('at must be more than 2 minutes and no more than 366 days in the future.');
      const requestId = crypto.randomUUID();
      return run('wake-request', ['--id', requestId, '--at', at, ...(startIfOff ? ['--power-on'] : [])]);
    }
    if (name === 'wake_requests') {
      if (Object.keys(args).length) throw new Error('wake_requests takes no arguments.');
      const result = await run('wake-requests');
      result.requests = Array.isArray(result.requests) ? result.requests.filter(row => row?.client === 'onlychat') : [];
      return result;
    }
    if (name === 'wake_cancel') {
      const requestId = args.request_id;
      if (Object.keys(args).length !== 1 || typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw new Error('request_id is invalid.');
      const result = await run('wake-requests', ['--id', requestId]);
      const row = (Array.isArray(result.requests) ? result.requests : []).find(item => item?.requestId === requestId && item?.client === 'onlychat');
      if (!row) throw new Error('Only Chat wake request was not found.');
      if (row.status !== 'pending_user_approval') throw new Error('Only pending 35Closer approval requests can be cancelled.');
      return run('wake-cancel', ['--id', requestId]);
    }
    throw new Error(`Unknown 35Closer tool: ${String(name)}`);
  }

  async function handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
    const id = message.id;
    const reply = (result, error) => error
      ? { jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message: String(error.message || error) } }
      : { jsonrpc: '2.0', id, result };
    try {
      switch (message.method) {
        case 'initialize': return reply({ protocolVersion: message.params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'onlychat-35closer', version: '1.0.0' } });
        case 'notifications/initialized':
        case 'notifications/cancelled': return null;
        case 'ping': return reply({});
        case 'tools/list': return reply({ tools });
        case 'tools/call': {
          const result = await invoke(message.params?.name, message.params?.arguments || {});
          return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: false });
        }
        default: return id === undefined ? null : reply(null, Object.assign(new Error(`Unsupported method: ${String(message.method)}`), { code: -32601 }));
      }
    } catch (error) {
      if (message.method === 'tools/call') return reply({ content: [{ type: 'text', text: String(error.message || error) }], isError: true });
      return reply(null, error);
    }
  }
  return { tools, invoke, handle, run };
}

if (require.main === module) {
  const server = createServer();
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    if (Buffer.byteLength(line) > 1024 * 1024) return;
    try { void server.handle(JSON.parse(line)).then(result => { if (result) process.stdout.write(`${JSON.stringify(result)}\n`); }); }
    catch (_) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC message.' } })}\n`); }
  });
}

module.exports = { createServer, tools };
