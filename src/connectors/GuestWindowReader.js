'use strict';

const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { CodexCliAdapter } = require('../providers/CodexCliAdapter');

async function readGuestWindows(sessionId, { dataDir, signal } = {}) {
  const route = new CodexCliAdapter({ dataDir })._agentWorkspaceRoute(sessionId);
  if (route?.transport !== 'ssh') throw new Error('No SSH guest is assigned to this session.');
  const child = spawn(route.command, route.args, { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  const deadline = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
    : AbortSignal.timeout(15000);

  try {
    return await new Promise((resolve, reject) => {
      const abort = () => reject(new Error('Guest window lookup stopped or timed out.'));
      deadline.addEventListener('abort', abort, { once: true });
      if (deadline.aborted) return abort();
      child.once('error', reject);
      child.stdin.on('error', reject);
      child.once('exit', () => reject(new Error('Guest MCP closed before returning windows.')));
      const send = (method, params, id) => {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n');
      };
      lines.on('line', line => {
        let reply;
        try { reply = JSON.parse(line); } catch { return; }
        if (reply.id === 1 && reply.result?.protocolVersion) {
          send('notifications/initialized', {});
          send('tools/call', { name: 'list_windows', arguments: {} }, 2);
        } else if (reply.id === 2 && !reply.error && !reply.result?.isError
          && Array.isArray(reply.result?.structuredContent?.windows)) {
          resolve({ windows: reply.result.structuredContent.windows });
        } else if (reply.id === 1 || reply.id === 2) {
          reject(new Error('Guest MCP did not return a valid window list.'));
        }
      });
      send('initialize', {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'Only Chat guest window reader', version: '1' }
      }, 1);
    });
  } finally {
    lines.close();
    child.stdin.destroy();
    child.kill();
  }
}

module.exports = { readGuestWindows };
