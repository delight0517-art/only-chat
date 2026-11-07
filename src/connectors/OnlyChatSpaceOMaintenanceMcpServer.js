'use strict';

const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { createInterface } = require('node:readline');

const tools = [
  { name: 'spaceo_status', description: 'Read SpaceO daemon and display safety status.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'spaceo_set_reconfiguration_mode', description: 'Set the SpaceO display stability mode only when the current user explicitly requests that change. The default is operatorOverride (stability gate off); automatic enables host-health and quiet-sample admission. This does not change ownership, mutation, identity, or display-creation limits.', inputSchema: {
    type: 'object', properties: { mode: { type: 'string', enum: ['automatic', 'operatorOverride'] } },
    required: ['mode'], additionalProperties: false
  } },
  { name: 'spaceo_restart', description: 'Restart only the SpaceO daemon after existing SpaceO sessions finish. Use only when the user requested a SpaceO restart.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
];

function defaultRunCommand(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout, stderr });
    });
  });
}

function createSpaceOMaintenanceServer({
  platform = process.platform,
  cliPath = join(homedir(), '.local/bin/spaceo'),
  runCommand = defaultRunCommand,
  readFileSync = fs.readFileSync
} = {}) {
  const installedDigest = () => createHash('sha256').update(readFileSync(cliPath)).digest('hex');

  async function run(action, mode) {
    if (platform !== 'darwin') throw new Error('SpaceO maintenance is available only on macOS.');
    if (action === 'status') {
      const { stdout: doctor } = await runCommand(cliPath, ['doctor', '--json'], { timeout: 10_000, maxBuffer: 128 * 1024 });
      const { stdout: mode } = await runCommand(cliPath, ['safety', 'reconfiguration-mode', '--json'], {
        timeout: 10_000, maxBuffer: 128 * 1024
      });
      return JSON.stringify({ doctor: JSON.parse(doctor), reconfigurationMode: JSON.parse(mode) });
    }
    if (action === 'set-mode') {
      if (!['automatic', 'operatorOverride'].includes(mode)) throw new Error('Choose automatic or operatorOverride.');
      const { stdout } = await runCommand(cliPath, ['safety', 'reconfiguration-mode', '--mode', mode, '--json'], {
        timeout: 10_000, maxBuffer: 128 * 1024
      });
      return stdout.trim();
    }
    await runCommand('/usr/bin/codesign', ['--verify', '--strict', cliPath], { timeout: 10_000, maxBuffer: 128 * 1024 });
    const expected = installedDigest();
    await runCommand(cliPath, ['daemon', 'restart', '--operator', '--timeout', '30', '--json'], {
      timeout: 50_000, maxBuffer: 128 * 1024
    });
    const { stdout } = await runCommand(cliPath, ['daemon', 'wait', '--timeout', '5', '--json'], {
      timeout: 10_000, maxBuffer: 128 * 1024
    });
    const reply = JSON.parse(stdout);
    const daemon = reply.daemon || {};
    if (!reply.ok || daemon.executableSHA256 !== expected) {
      throw new Error('Restart did not confirm the installed SpaceO binary.');
    }
    return JSON.stringify({ ok: true, pid: daemon.pid, executableSHA256: expected,
      displaySafety: daemon.displaySafety });
  }

  async function handle(message) {
    const { id, method, params } = message || {};
    if (id === undefined) return null;
    const reply = result => ({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') return reply({
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} }, serverInfo: { name: 'onlychat-spaceo-maintenance', version: '1.1.0' }
    });
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools });
    if (method !== 'tools/call') return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
    try {
      const action = params?.name === 'spaceo_status' ? 'status'
        : params?.name === 'spaceo_set_reconfiguration_mode' ? 'set-mode'
          : params?.name === 'spaceo_restart' ? 'restart' : null;
      const args = params?.arguments ?? {};
      if (!action || !args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('Only the allowlisted SpaceO maintenance tools are supported.');
      }
      if (action === 'set-mode') {
        if (Object.keys(args).length !== 1 || !['automatic', 'operatorOverride'].includes(args.mode)) {
          throw new Error('Set mode to automatic or operatorOverride, with no other arguments.');
        }
      } else if (Object.keys(args).length) {
        throw new Error('This SpaceO maintenance tool takes no arguments.');
      }
      return reply({ content: [{ type: 'text', text: await run(action, args.mode) }] });
    } catch (error) {
      return reply({ isError: true, content: [{ type: 'text', text: (error.stderr || error.message).trim() }] });
    }
  }

  return { handle, run };
}

if (require.main === module) {
  const server = createSpaceOMaintenanceServer();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending = Promise.resolve();
  input.on('line', line => {
    if (Buffer.byteLength(line) > 65536) return;
    pending = pending.then(async () => {
      let response;
      try { response = await server.handle(JSON.parse(line)); }
      catch { response = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid request' } }; }
      if (response) process.stdout.write(JSON.stringify(response) + '\n');
    });
  });
}

module.exports = { createSpaceOMaintenanceServer, tools };
