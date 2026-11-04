'use strict';

const TOOLS = [
  { name: 'embedded_3f_status', description: 'Read the status of the 3F Browser panel embedded in this Only Chat window.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'embedded_3f_navigate', description: 'Navigate the embedded 3F Browser after Only Chat approval and Focus Fence policy checks.', inputSchema: { type: 'object', properties: { url: { type: 'string', minLength: 1, maxLength: 4096 } }, required: ['url'], additionalProperties: false } },
  { name: 'embedded_3f_read', description: 'Read visible page text from the embedded 3F Browser.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'embedded_3f_aria', description: 'Read the accessible element tree from the embedded 3F Browser.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'embedded_3f_act', description: 'Perform a page action on the embedded 3F Browser after Only Chat approval and Focus Fence policy checks.', inputSchema: { type: 'object', properties: { action: { type: 'string', minLength: 1, maxLength: 1000 } }, required: ['action'], additionalProperties: false } },
  { name: 'embedded_3f_history', description: 'Use back, forward, or reload in the embedded 3F Browser after Only Chat approval and Focus Fence policy checks.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['back', 'forward', 'reload'] } }, required: ['action'], additionalProperties: false } }
];

const MUTATING_TOOLS = new Set(['embedded_3f_navigate', 'embedded_3f_act', 'embedded_3f_history']);

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function dispatchEmbeddedThreefTool(server, context, name, args = {}) {
  if (!TOOLS.some(tool => tool.name === name)) throw new Error('Unknown embedded 3F tool.');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid embedded 3F tool arguments.');
  const allowedKeys = name === 'embedded_3f_navigate' ? ['url']
    : name === 'embedded_3f_act' ? ['action']
      : name === 'embedded_3f_history' ? ['action'] : [];
  if (Object.keys(args).some(key => !allowedKeys.includes(key))) throw new Error('Unexpected embedded 3F tool argument.');
  if (name === 'embedded_3f_navigate' && (typeof args.url !== 'string' || !args.url.trim() || args.url.length > 4096)) throw new Error('Invalid embedded 3F URL.');
  if (name === 'embedded_3f_act' && (typeof args.action !== 'string' || !args.action.trim() || args.action.length > 1000)) throw new Error('Invalid embedded 3F action.');
  if (name === 'embedded_3f_history' && !['back', 'forward', 'reload'].includes(args.action)) throw new Error('Invalid embedded 3F history action.');
  if (server.engine?.currentSession?.sessionId !== context.sessionId) throw new Error('Only Chat session changed; embedded 3F request expired.');
  if (MUTATING_TOOLS.has(name)) {
    if (server.engine.tools.approvalPolicy === 'read-only') throw new Error('3F page changes are blocked by Only Chat read-only policy.');
    if (server.engine.tools.approvalPolicy !== 'never') {
      const accepted = await context.requestToolApproval({
        requestId: require('node:crypto').randomUUID(), sessionId: context.sessionId,
        name, args, scopeRequiresExplicit: false
      });
      if (accepted !== true) throw new Error('Only Chat user denied or did not approve this 3F action.');
    }
  }
  switch (name) {
    case 'embedded_3f_status': return server.embeddedBrowserPanel.getStatus();
    case 'embedded_3f_navigate': return server.embeddedBrowserPanel.navigate(args.url);
    case 'embedded_3f_read': return server.embeddedBrowserPanel.readText();
    case 'embedded_3f_aria': return server.embeddedBrowserPanel.getAriaTree();
    case 'embedded_3f_act': return server.embeddedBrowserPanel.act(args.action);
    case 'embedded_3f_history': return server.embeddedBrowserPanel.history(args.action);
    default: throw new Error('Unknown embedded 3F tool.');
  }
}

async function handleEmbeddedThreefMcpMessage(server, context, message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return jsonRpcError(message?.id, -32600, 'Invalid JSON-RPC request.');
  if (!Object.prototype.hasOwnProperty.call(message, 'id') && message.method.startsWith('notifications/')) return null;
  if (message.method === 'initialize') {
    const requested = message.params?.protocolVersion;
    const supported = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
    context.protocolVersion = supported.has(requested) ? requested : '2024-11-05';
    return { jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: context.protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'onlychat-embedded-3f', version: '1.0.0' }
    } };
  }
  if (message.method === 'ping') return { jsonrpc: '2.0', id: message.id, result: {} };
  if (message.method === 'tools/list') return { jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } };
  if (message.method === 'tools/call') {
    const name = message.params?.name;
    try {
      const result = await dispatchEmbeddedThreefTool(server, context, name, message.params?.arguments || {});
      return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } };
    } catch (error) {
      return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: error.message || '3F Browser tool failed.' }], isError: true } };
    }
  }
  return jsonRpcError(message.id, -32601, 'Method not found.');
}

module.exports = { TOOLS, MUTATING_TOOLS, dispatchEmbeddedThreefTool, handleEmbeddedThreefMcpMessage };
