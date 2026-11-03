'use strict';

const readline = require('node:readline');

const port = Number(process.env.ONLY_CHAT_MAC_SCREEN_PORT);
const token = process.env.ONLY_CHAT_MAC_SCREEN_TOKEN || '';
const endpoint = `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : 8899}/api/mac-screen/dispatch`;

const tools = [
  { name: 'screen_status', description: 'Check Only Chat Mac screen-control connection and macOS Screen Recording/Accessibility permissions.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'screen_capture', description: 'Capture the current primary Mac display and return it as an image. Screen content is shared with the current AI conversation.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'screen_click', description: 'Click the visible primary Mac display at pixel coordinates from the latest screenshot. Use left or right click.', inputSchema: { type: 'object', properties: { x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 }, button: { type: 'string', enum: ['left', 'right'], default: 'left' } }, required: ['x', 'y'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
  { name: 'screen_type', description: 'Type user-provided text into the currently focused Mac control (maximum 4,000 characters).', inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 4000 } }, required: ['text'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
  { name: 'screen_key', description: 'Press one supported key, optionally with command/control/option/shift modifiers.', inputSchema: { type: 'object', properties: { key: { type: 'string', enum: ['enter', 'tab', 'space', 'backspace', 'escape', 'left', 'right', 'up', 'down', 'home', 'end', 'pageup', 'pagedown'] }, modifiers: { type: 'array', items: { type: 'string', enum: ['command', 'control', 'option', 'shift'] }, maxItems: 3 } }, required: ['key'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
  { name: 'screen_scroll', description: 'Scroll the visible Mac screen by a bounded number of lines (-10 to 10).', inputSchema: { type: 'object', properties: { vertical: { type: 'integer', minimum: -10, maximum: 10 }, horizontal: { type: 'integer', minimum: -10, maximum: 10 } }, required: ['vertical', 'horizontal'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } }
];

async function invoke(name, args = {}) {
  if (!token) throw new Error('Only Chat Mac 화면 제어 연결을 사용할 수 없습니다.');
  const actions = { screen_status: 'status', screen_capture: 'capture', screen_click: 'click', screen_type: 'type', screen_key: 'key', screen_scroll: 'scroll' };
  const action = actions[name];
  if (!action) throw new Error(`Unknown Mac screen tool: ${String(name)}`);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, input: args })
  });
  let result;
  try { result = await response.json(); } catch (_) { throw new Error('Only Chat Mac 화면 응답을 읽지 못했습니다.'); }
  if (!response.ok || result.error) throw new Error(result.error || `Mac screen tool failed (${response.status}).`);
  if (action === 'capture') {
    if (typeof result.image !== 'string' || !['image/png', 'image/jpeg'].includes(result.mimeType)) throw new Error('Mac 화면 이미지 응답이 올바르지 않습니다.');
    return { content: [
      { type: 'text', text: `현재 기본 디스플레이 ${result.width}×${result.height} 화면입니다.` },
      { type: 'image', data: result.image, mimeType: result.mimeType }
    ] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }

async function handle(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  const reply = (result, error) => send(error
    ? { jsonrpc: '2.0', id: message.id ?? null, error: { code: error.code || -32603, message: String(error.message || error) } }
    : { jsonrpc: '2.0', id: message.id, result });
  try {
    switch (message.method) {
      case 'initialize': return reply({ protocolVersion: message.params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'onlychat-mac-screen', version: '1.0.0' } });
      case 'notifications/initialized':
      case 'notifications/cancelled': return;
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools });
      case 'tools/call': return reply(await invoke(message.params?.name, message.params?.arguments || {}));
      default: if (message.id !== undefined) reply(null, Object.assign(new Error(`Unsupported method: ${String(message.method)}`), { code: -32601 }));
    }
  } catch (error) {
    if (message.method === 'tools/call') reply({ content: [{ type: 'text', text: String(error.message || error) }], isError: true });
    else reply(null, error);
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (Buffer.byteLength(line) > 1024 * 1024) return;
  try { void handle(JSON.parse(line)); }
  catch (_) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC message.' } }); }
});
