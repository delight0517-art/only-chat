'use strict';

const readline = require('node:readline');

function assignedDisplay(argv) {
  const values = {};
  for (let index = 0; index + 1 < argv.length; index += 2) {
    if (!argv[index].startsWith('--') || Object.hasOwn(values, argv[index])) throw new Error('invalid arguments');
    values[argv[index]] = argv[index + 1];
  }
  const agentID = values['--agent-id'];
  const cuaSession = values['--cua-session'];
  const displayID = Number(values['--display-id']);
  const frame = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Number(values[`--${key}`])]));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(agentID || '')
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(cuaSession || '')
      || !Number.isSafeInteger(displayID) || displayID < 1
      || Object.values(frame).some(value => !Number.isFinite(value))
      || frame.width <= 0 || frame.height <= 0
      || !Number.isFinite(frame.x + frame.width) || !Number.isFinite(frame.y + frame.height)) {
    throw new Error('invalid arguments');
  }
  return {
    agentID, displayID, frame, cuaSession,
    frameEnforced: false,
    note: 'The frame is advisory. This tool does not constrain window movement or create isolated keyboard/mouse devices.'
  };
}

function response(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function run(argv = process.argv.slice(2)) {
  let display;
  try { display = assignedDisplay(argv); }
  catch (_) {
    process.stderr.write('Invalid assigned display configuration.\n');
    process.exitCode = 2;
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', line => {
    let request;
    try { request = JSON.parse(line); } catch (_) { return; }
    if (!request || typeof request.method !== 'string' || request.method.startsWith('notifications/')) return;
    if (!Object.hasOwn(request, 'id')) return;
    if (request.method === 'initialize') {
      response(request.id, {
        protocolVersion: request.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'onlychat-assigned-display', version: '0.1.0' }
      });
      return;
    }
    if (request.method === 'ping') { response(request.id, {}); return; }
    if (request.method === 'tools/list') {
      response(request.id, { tools: [{
        name: 'get_assigned_display',
        description: 'Read this Only Chat conversation assigned display and CUA session label. Before computer actions, call CUA start_session with this exact label, enable its cursor with set_agent_cursor_enabled, and pass that session to supported CUA tools. Use exact assigned app windows and background input. The frame is advisory, and this route does not create physical keyboard or mouse devices.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      }] });
      return;
    }
    if (request.method === 'tools/call') {
      if (request.params?.name !== 'get_assigned_display') {
        response(request.id, { isError: true, content: [{ type: 'text', text: 'Unknown tool.' }] });
        return;
      }
      response(request.id, {
        content: [{ type: 'text', text: JSON.stringify(display) }],
        structuredContent: display,
        isError: false
      });
      return;
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found.' }})}\n`);
  });
}

if (require.main === module) run();

module.exports = { assignedDisplay, run };
