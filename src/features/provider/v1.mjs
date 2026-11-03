const DEFAULT_BASE_URL = 'http://127.0.0.1:18880';
const TOOL_NAMES = Object.freeze([
  'exec_command', 'bash', 'read_file', 'write_file', 'edit_file', 'apply_patch',
  'google_drive_list', 'google_drive_read', 'google_drive_create', 'google_drive_update', 'gmail_list', 'gmail_read', 'gmail_send',
  'notion_search', 'notion_query', 'notion_create_page', 'notion_update_page', 'notion_append_blocks',
  'notion_api_read', 'notion_api_write',
  'notion_mcp_list_tools', 'notion_mcp_call_tool',
  'notion_rea_open', 'notion_rea_navigate', 'notion_rea_read', 'notion_rea_search', 'notion_rea_aria', 'notion_rea_act', 'notion_rea_status',
  'spacekeeper_session_report', 'spacekeeper_capacity_status', 'browser_open', 'browser_navigate',
  'browser_aria', 'browser_act', 'browser_read', 'browser_recipe', 'browser_status'
]);
const READ_ONLY_TOOL_NAMES = new Set([
  'read_file', 'google_drive_list', 'google_drive_read', 'gmail_list', 'gmail_read',
  'notion_search', 'notion_query', 'notion_api_read', 'spacekeeper_session_report', 'spacekeeper_capacity_status',
  'notion_mcp_list_tools', 'notion_mcp_call_tool',
  'notion_rea_read', 'notion_rea_search', 'notion_rea_aria', 'notion_rea_status',
  'browser_aria', 'browser_read', 'browser_status'
]);

function toolDefinitions(approvalPolicy = 'on-request') {
  const names = approvalPolicy === 'read-only' ? TOOL_NAMES.filter(name => READ_ONLY_TOOL_NAMES.has(name)) : TOOL_NAMES;
  return names.map(name => ({
    type: 'function',
    function: {
      name,
      description: name === 'notion_api_read'
        ? 'Direct REST API read for the legacy integration-token connection only. For a personal Notion login, use notion_mcp_list_tools then notion_mcp_call_tool instead; the OAuth token cannot be sent to REST.'
        : name === 'notion_api_write'
          ? 'Direct REST API write for the legacy integration-token connection only. For a personal Notion login, use the authorized tools from notion_mcp_list_tools with notion_mcp_call_tool; writes require Only Chat approval.'
          : name === 'notion_mcp_list_tools'
            ? 'List the Notion tools currently granted to this signed-in personal workspace, including their argument schemas and read-only hints.'
            : name === 'notion_mcp_call_tool'
              ? 'Call one Notion MCP tool returned by notion_mcp_list_tools, passing its exact name and arguments. Use only the tools and options Notion exposes to this account; when notion-get-tool-access is available, consult it for plan limits and quotas. Free-plan access is supported, but premium features or exhausted allowances can be restricted. Never claim unavailable tools worked. Only Chat asks approval for non-read-only calls.'
              : ['notion_search', 'notion_query', 'notion_create_page', 'notion_update_page', 'notion_append_blocks'].includes(name)
                ? `Legacy Notion REST helper (${name}) for integration-token connections. For personal OAuth login, use notion_mcp_list_tools and invoke the matching granted Notion MCP tool through notion_mcp_call_tool.`
          : name.startsWith('notion_rea_')
            ? `Use Aside/REA for the user's free-plan Notion workspace. Open or navigate only HTTPS notion.so, notion.com, or notion.site URLs; use notion_rea_search to search workspace pages/content for the user's query, inspect returned result links, click the matching result with notion_rea_act, and read it with notion_rea_read. Use notion_rea_aria for current actionable refs. Edits use notion_rea_act under Only Chat approval, then verify with notion_rea_read. The user signs into Notion directly in Aside; never request, read, or enter passwords, passkeys, MFA codes, or recovery secrets. ${name}`
            : `Use Only Chat's ${name} capability when the user requests it.`,
      parameters: name === 'notion_rea_open' || name === 'notion_rea_navigate'
        ? { type: 'object', properties: { url: { type: 'string', description: 'HTTPS Notion page URL. notion_rea_open defaults to the Notion home page.' } }, additionalProperties: false }
        : name === 'notion_rea_search'
          ? { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['query'], additionalProperties: false }
          : name === 'notion_rea_act'
            ? { type: 'object', properties: { ref: { type: 'string', description: 'Element ref number shown by notion_rea_aria or notion_rea_search.' }, label: { type: 'string', description: 'Accessible element label as an alternative to ref.' }, action: { type: 'string', enum: ['click', 'type'] }, text: { type: 'string', description: 'Text to type; omit for click.' } }, required: ['action'], additionalProperties: false }
        : name === 'notion_api_read'
        ? { type: 'object', properties: { method: { type: 'string', enum: ['GET', 'POST'] }, path: { type: 'string' }, query: { type: 'object', additionalProperties: true }, body: { type: 'object', additionalProperties: true } }, required: ['path'], additionalProperties: false }
        : name === 'notion_api_write'
          ? { type: 'object', properties: { method: { type: 'string', enum: ['POST', 'PATCH', 'DELETE'] }, path: { type: 'string' }, body: { type: 'object', additionalProperties: true } }, required: ['method', 'path'], additionalProperties: false }
          : name === 'notion_mcp_call_tool'
            ? { type: 'object', properties: { tool_name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['tool_name'], additionalProperties: false }
            : name === 'notion_mcp_list_tools'
              ? { type: 'object', properties: {}, additionalProperties: false }
          : { type: 'object', properties: {}, additionalProperties: true }
    }
  }));
}

function normalizeBaseUrl(value = DEFAULT_BASE_URL) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(host) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('Only Chat Account Router accepts loopback HTTP only.');
  }
  return url.toString().replace(/\/$/, '');
}

function parseToolCalls(items) {
  if (!Array.isArray(items)) return [];
  const seenIds = new Set();
  return items.map((item, index) => {
    const fn = item?.function || {};
    let args = fn.arguments ?? item?.args ?? {};
    if (typeof args === 'string') args = JSON.parse(args);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Router returned invalid tool arguments.');
    const name = fn.name || item?.name;
    if (typeof name !== 'string' || !name) throw new Error('Router returned a tool call without a name.');
    if (!TOOL_NAMES.includes(name)) throw new Error('Router requested a tool unavailable to the Account Router provider.');
    if (item.id !== undefined && (typeof item.id !== 'string' || !item.id.trim())) {
      throw new Error('Router returned an invalid tool call ID.');
    }
    const id = item.id || `router-${index}-${name}`;
    if (seenIds.has(id)) throw new Error('Router returned duplicate tool call IDs.');
    seenIds.add(id);
    return { id, name, args };
  });
}

function createAccountRouterAdapter(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetch || globalThis.fetch;
  const timeoutMs = options.timeoutMs || 120_000;
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');

  async function call(tier, history, hooks = {}, context = {}) {
    if (!Array.isArray(history) || !history.length) throw new Error('Router needs a non-empty conversation history.');
    const signal = context.signal || AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          model: tier?.model || 'auto',
          messages: history,
          tools: toolDefinitions(context.approvalPolicy),
          tool_choice: 'auto',
          stream: false
        }),
        signal
      });
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw new Error('AI Account Router request timed out or was cancelled.');
      throw new Error('AI Account Router is unavailable on 127.0.0.1:18880.');
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const code = body?.error?.code;
      const error = new Error(code === 'provider_unconfigured'
        ? 'AI Account Router has no configured provider account.'
        : `AI Account Router returned HTTP ${response.status}${code ? ` (${code})` : ''}.`);
      error.status = response.status;
      error.code = code || 'router_error';
      throw error;
    }
    const message = body?.choices?.[0]?.message;
    if (!message || (typeof message.content !== 'string' && !Array.isArray(message.tool_calls))) {
      throw new Error('AI Account Router returned an invalid chat completion.');
    }
    const toolCalls = parseToolCalls(message.tool_calls);
    const content = typeof message.content === 'string' ? message.content : '';
    if (content) hooks.onMessageDelta?.(content);
    return { content, toolCalls, usage: body.usage || null, protocol: 'openai-compatible' };
  }

  async function getChain() {
    const response = await fetchImpl(`${baseUrl}/api/v1/account-chain`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(1500)
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.apiVersion !== 1 || !Array.isArray(body.accounts)) throw new Error('AI Account Router account-chain metadata is unavailable.');
    return body;
  }

  return Object.freeze({ baseUrl, getChain, call });
}

export { DEFAULT_BASE_URL, createAccountRouterAdapter, normalizeBaseUrl, parseToolCalls, toolDefinitions };
