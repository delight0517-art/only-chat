'use strict';

const readline = require('node:readline');
const os = require('node:os');
const path = require('node:path');
const { GoogleConnector } = require('./GoogleConnector.js');

const MAX_EMAIL_TEXT = 64 * 1024;
const tokenFile = process.env.ONLY_CHAT_GOOGLE_TOKEN_FILE;
const connector = new GoogleConnector({
  dataDir: process.env.ONLY_CHAT_DATA_DIR || path.join(os.homedir(), '.my-codex'),
  ...(tokenFile ? { storageDir: path.dirname(path.resolve(tokenFile)), tokenFile: path.resolve(tokenFile) } : {})
});

const tools = [
  {
    name: 'drive_search',
    title: 'Search Google Drive',
    description: 'Search the connected Google Drive and return file names, IDs, types, and links. Use Google Drive q syntax.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Google Drive search query, for example name contains \'report\' or fullText contains \'budget\'.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'drive_read',
    title: 'Read a Google Drive text file',
    description: 'Read text content from a Google Doc, Sheet (CSV export), Slide deck, or supported text file. Binary files are not downloaded.',
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string', minLength: 1, maxLength: 512 } },
      required: ['file_id'],
      additionalProperties: false
    }
  },
  {
    name: 'gmail_search',
    title: 'Search Gmail',
    description: 'Search the connected Gmail account and return matching message IDs and thread IDs. Use Gmail search syntax.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query, for example from:person@example.com subject:report newer_than:7d.' },
        limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'gmail_read',
    title: 'Read a Gmail message',
    description: 'Read the text body and basic headers of one Gmail message. Attachments are not downloaded.',
    inputSchema: {
      type: 'object',
      properties: { message_id: { type: 'string', minLength: 1, maxLength: 512 } },
      required: ['message_id'],
      additionalProperties: false
    }
  }
].map(tool => ({ ...tool, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }));

function decodePart(data) {
  if (typeof data !== 'string' || !data) return '';
  try { return Buffer.from(data, 'base64url').toString('utf8'); }
  catch (_) { return ''; }
}

function messageText(message) {
  const headers = Object.fromEntries((message?.payload?.headers || []).map(header => [String(header.name || '').toLowerCase(), header.value || '']));
  const plain = [];
  const html = [];
  function visit(part) {
    if (!part || part.filename || part.body?.attachmentId) return;
    const text = decodePart(part.body?.data);
    if (text && part.mimeType === 'text/plain') plain.push(text);
    else if (text && part.mimeType === 'text/html') html.push(text);
    for (const child of part.parts || []) visit(child);
  }
  visit(message?.payload);
  const body = (plain.join('\n') || html.join('\n').replace(/<style\b[^>]*>[\s\S]*?<\/style>|<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&'))
    .replace(/\s+/g, ' ').trim().slice(0, MAX_EMAIL_TEXT);
  return {
    id: message?.id || '',
    threadId: message?.threadId || '',
    from: headers.from || '',
    to: headers.to || '',
    date: headers.date || '',
    subject: headers.subject || '',
    snippet: String(message?.snippet || '').slice(0, 1000),
    body
  };
}

function clampLimit(value, max, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.max(1, Math.min(max, number)) : fallback;
}

async function invoke(name, args = {}) {
  if (name === 'drive_search') {
    const result = await connector.driveListFiles({ q: typeof args.query === 'string' ? args.query : '', pageSize: clampLimit(args.limit, 50, 20) });
    if (result?.error) throw new Error(result.error.message || 'Google Drive search failed.');
    return result;
  }
  if (name === 'drive_read') {
    if (typeof args.file_id !== 'string' || !args.file_id.trim()) throw new Error('file_id is required.');
    return connector.driveReadFile(args.file_id);
  }
  if (name === 'gmail_search') {
    const result = await connector.gmailListMessages({ q: typeof args.query === 'string' ? args.query.slice(0, 1000) : '', maxResults: clampLimit(args.limit, 25, 10) });
    if (result?.error) throw new Error(result.error.message || 'Gmail search failed.');
    return result;
  }
  if (name === 'gmail_read') {
    if (typeof args.message_id !== 'string' || !args.message_id.trim()) throw new Error('message_id is required.');
    const result = await connector.gmailReadMessage(args.message_id);
    if (result?.error) throw new Error(result.error.message || 'Gmail message read failed.');
    return messageText(result);
  }
  throw new Error(`Unknown Google Workspace tool: ${String(name)}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  const id = message.id;
  const reply = (result, error) => send(error
    ? { jsonrpc: '2.0', id: id ?? null, error: { code: error.code || -32603, message: String(error.message || error) } }
    : { jsonrpc: '2.0', id, result });
  try {
    switch (message.method) {
      case 'initialize':
        return reply({
          protocolVersion: message.params?.protocolVersion || '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'onlychat-google-workspace', version: '1.0.0' }
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools });
      case 'tools/call': {
        const content = await invoke(message.params?.name, message.params?.arguments || {});
        return reply({ content: [{ type: 'text', text: JSON.stringify(content) }], isError: false });
      }
      default:
        if (id !== undefined) reply(null, Object.assign(new Error(`Unsupported method: ${String(message.method)}`), { code: -32601 }));
    }
  } catch (error) {
    if (message.method === 'tools/call') {
      reply({ content: [{ type: 'text', text: String(error.message || error) }], isError: true });
    } else {
      reply(null, error);
    }
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (Buffer.byteLength(line) > 2 * 1024 * 1024) return;
  try { void handle(JSON.parse(line)); }
  catch (error) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC message.' } }); }
});
