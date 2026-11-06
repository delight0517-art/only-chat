'use strict';

const { execFile } = require('node:child_process');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { createInterface } = require('node:readline');
const { promisify } = require('node:util');

const command = join(homedir(), 'Documents/Codex/2026-10-12/starnet-reconciled-01329',
  '.tasks/spaceo-body-mod/spaceo-maintenance.py');
const run = promisify(execFile);
const tools = [
  { name: 'spaceo_status', description: 'Read SpaceO daemon and display safety status.' },
  { name: 'spaceo_restart', description: 'Restart only the SpaceO daemon after existing SpaceO sessions finish. Use only when the user requested a SpaceO restart.' }
].map(tool => ({ ...tool, inputSchema: { type: 'object', properties: {}, additionalProperties: false } }));

async function handle({ id, method, params }) {
  if (id === undefined) return;
  const reply = result => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return reply({
    protocolVersion: params?.protocolVersion || '2024-11-05',
    capabilities: { tools: {} }, serverInfo: { name: 'onlychat-spaceo-maintenance', version: '1.0.0' }
  });
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools });
  if (method !== 'tools/call') return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  try {
    const action = params?.name === 'spaceo_status' ? 'status' : params?.name === 'spaceo_restart' ? 'restart' : null;
    const args = params?.arguments ?? {};
    if (!action || !args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) {
      throw new Error('Only SpaceO status or restart with no arguments is supported.');
    }
    const { stdout } = await run(command, [action], { timeout: 55_000, maxBuffer: 128 * 1024 });
    return reply({ content: [{ type: 'text', text: stdout.trim() }] });
  } catch (error) {
    return reply({ isError: true, content: [{ type: 'text', text: (error.stderr || error.message).trim() }] });
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async line => {
  if (Buffer.byteLength(line) > 65536) return;
  try {
    const response = await handle(JSON.parse(line));
    if (response) process.stdout.write(JSON.stringify(response) + '\n');
  } catch {
    process.stdout.write('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Invalid request"}}\n');
  }
});
