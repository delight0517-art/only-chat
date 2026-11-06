const DEFAULT_BASE_URL = 'http://127.0.0.1:18880';
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const TOOL_NAMES = Object.freeze([
  'exec_command', 'bash', 'read_file', 'write_file', 'edit_file', 'apply_patch',
  'google_drive_list', 'google_drive_read', 'google_drive_create', 'google_drive_update', 'gmail_list', 'gmail_read', 'gmail_send',
  'notion_search', 'notion_query', 'notion_create_page', 'notion_update_page', 'notion_append_blocks',
  'notion_api_read', 'notion_api_write',
  'notion_mcp_list_tools', 'notion_mcp_call_tool',
  'notion_rea_open', 'notion_rea_navigate', 'notion_rea_read', 'notion_rea_search', 'notion_rea_aria', 'notion_rea_act', 'notion_rea_status',
  'spacekeeper_session_report', 'spacekeeper_capacity_status', 'browser_open', 'browser_navigate',
  'browser_aria', 'browser_act', 'browser_read', 'browser_recipe', 'browser_status',
  'embedded_3f_status', 'embedded_3f_navigate', 'embedded_3f_read', 'embedded_3f_aria', 'embedded_3f_act', 'embedded_3f_history',
  'task_registry_list', 'task_registry_read', 'task_registry_create', 'task_registry_claim', 'task_registry_checkpoint',
  'task_registry_messages', 'task_registry_send', 'task_registry_ack', 'task_registry_check', 'task_registry_record_check',
  'joint_development_list', 'joint_development_read', 'joint_development_assess', 'joint_development_create'
]);
const READ_ONLY_TOOL_NAMES = new Set([
  'read_file', 'google_drive_list', 'google_drive_read', 'gmail_list', 'gmail_read',
  'notion_search', 'notion_query', 'notion_api_read', 'spacekeeper_session_report', 'spacekeeper_capacity_status',
  'notion_mcp_list_tools', 'notion_mcp_call_tool',
  'notion_rea_read', 'notion_rea_search', 'notion_rea_aria', 'notion_rea_status',
  'browser_aria', 'browser_read', 'browser_status', 'embedded_3f_status', 'embedded_3f_read', 'embedded_3f_aria', 'task_registry_list', 'task_registry_read', 'task_registry_messages', 'task_registry_check',
  'joint_development_list', 'joint_development_read', 'joint_development_assess'
]);

const JOINT_DEVELOPMENT_CONTRACT = {
  type: 'object',
  properties: {
    taskKey: { type: 'string', minLength: 1, maxLength: 80 }, title: { type: 'string', minLength: 1, maxLength: 160 },
    app: { type: 'string', minLength: 1, maxLength: 120 }, goal: { type: 'string', minLength: 1, maxLength: 2000 },
    integrationBase: { type: 'string', pattern: '^[a-fA-F0-9]{40}([a-fA-F0-9]{24})?$' },
    mac: { type: 'object', properties: { owner: { type: 'string' }, source: { type: 'string' }, baseCommit: { type: 'string' }, paths: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } } }, required: ['owner', 'source', 'baseCommit', 'paths'], additionalProperties: false },
    windows: { type: 'object', properties: { owner: { type: 'string' }, source: { type: 'string' }, baseCommit: { type: 'string' }, paths: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } } }, required: ['owner', 'source', 'baseCommit', 'paths'], additionalProperties: false }
  }, required: ['taskKey', 'title', 'app', 'goal', 'integrationBase', 'mac', 'windows'], additionalProperties: false
};

function toolDefinitions(approvalPolicy = 'on-request', toolProfile = null) {
  if (toolProfile === 'no-tools') return [];
  const profileNames = toolProfile === 'file-edit' ? new Set(['read_file', 'edit_file'])
    : toolProfile === 'file-read' ? new Set(['read_file'])
      : toolProfile === 'embedded-3f-status' ? new Set(['embedded_3f_status'])
        : toolProfile === 'threef-browser-status' ? new Set(['browser_status']) : null;
  const names = TOOL_NAMES.filter(name =>
    (approvalPolicy !== 'read-only' || READ_ONLY_TOOL_NAMES.has(name)) && (!profileNames || profileNames.has(name)));
  return names.map(name => ({
    type: 'function',
    function: {
      name,
      description: name === 'read_file'
        ? 'Read a file under the active Only Chat workspace. Pass path relative to the workspace root. For large files, set start_line and end_line to a small range (about 30 lines) and read more ranges only as needed; do not load a large document wholesale. For a root-level TODO_ROADMAP.md, pass exactly "TODO_ROADMAP.md"; never prepend the project name or use a filesystem-root path.'
        : name === 'edit_file'
          ? 'Edit a file under the active Only Chat workspace. Pass path relative to the workspace root; for a root-level file use only its filename, without a project-name prefix.'
        : name === 'task_registry_list'
        ? 'Read the shared local task registry so this chat can find work, owners, checkpoints and evidence before repeating investigation. Do not assume a listed task is complete.'
        : name === 'task_registry_read'
          ? 'Read one shared local task record by stable task key. Use this before repeating work on the same repository paths.'
          : name === 'task_registry_create'
            ? 'Create an idempotent task record for another Only Chat session. Include canonical repository path, observed base commit and exact relative paths; never include transcripts, credentials or user data.'
            : name === 'task_registry_claim'
              ? 'Atomically claim a task for the current Only Chat session. Respect conflicts and do not take over an unexpired claim held by another session.'
              : name === 'task_registry_checkpoint'
                ? 'Update the current session task status and concise checkpoint. Completion requires evidence; blocked status requires a concrete blocker.'
                : name === 'task_registry_messages'
                  ? 'Read messages and ACKs addressed to this current Only Chat session, its own messages, and messages shared with all task participants.'
                  : name === 'task_registry_send'
                    ? 'Send a concise task-scoped message to another Only Chat session. Never include credentials, transcripts, or unrelated user data.'
                    : name === 'task_registry_ack'
                      ? 'Explicitly acknowledge receipt of a task message by its message ID; do not claim receipt without a successful result.'
                      : name === 'task_registry_check'
                        ? 'Look up a completed verification by stable verification key, canonical repository, input SHA-256, command SHA-256 and environment SHA-256 before rerunning it. Reuse only an exact fresh hit; a miss with invalidated evidence means rerun this check only.'
                        : name === 'task_registry_record_check'
                          ? 'Record a successful verification with exact source-input, command and environment SHA-256 fingerprints and a concise evidence locator. Never cache failed, skipped or runtime checks as passing.'
        : name === 'joint_development_assess'
          ? 'Before creating a Mac-Windows joint-development task, validate the shared integration base, disjoint file ownership, local canonical main and base HEAD, local dirty-path conflicts, and any existing task overlap. Return unknown for the remote device; never infer that Windows is available or ready.'
          : name === 'joint_development_create'
            ? 'Create the coordinated Mac-Windows work contract only after the user explicitly asked to start the joint task and joint_development_assess reports ready. Both devices must share one base commit and own disjoint file paths. This records the task only; it does not publish to Drive or start a remote worker.'
            : name === 'joint_development_list'
              ? 'List current Mac-Windows task contracts and their separately reported stages. Drive receipt, patch application, tests and commits are distinct evidence.'
              : name === 'joint_development_read'
                ? 'Read one Mac-Windows task contract by stable task key. Treat device owners and progress as self-reported unless receiver evidence is attached.'
        : name === 'notion_api_read'
        ? 'Direct REST API read for the legacy integration-token connection only. For a personal Notion login, use notion_mcp_list_tools then notion_mcp_call_tool instead; the OAuth token cannot be sent to REST.'
        : name === 'notion_api_write'
          ? 'Direct REST API write for the legacy integration-token connection only. For a personal Notion login, use the authorized tools from notion_mcp_list_tools with notion_mcp_call_tool; writes require Only Chat approval.'
          : name === 'notion_mcp_list_tools'
            ? 'List the Notion tools currently granted to this signed-in personal workspace, including their argument schemas and read-only hints.'
            : name === 'notion_mcp_call_tool'
              ? 'Call one Notion MCP tool returned by notion_mcp_list_tools, passing its exact name and arguments. Use only the tools and options Notion exposes to this account; when notion-get-tool-access is available, consult it for plan limits and quotas. Free-plan access is supported, but premium features or exhausted allowances can be restricted. Never claim unavailable tools worked. Only Chat asks approval for non-read-only calls.'
              : ['notion_search', 'notion_query', 'notion_create_page', 'notion_update_page', 'notion_append_blocks'].includes(name)
                ? `Legacy Notion REST helper (${name}) for integration-token connections. For personal OAuth login, use notion_mcp_list_tools and invoke the matching granted Notion MCP tool through notion_mcp_call_tool.`
          : name.startsWith('embedded_3f_')
            ? 'Operate only the 3F Browser panel embedded in the current Only Chat window. Use embedded_3f_status first; use embedded_3f_aria/read for observation. For page actions, use the current ARIA refs, e.g. "click oc-agent-1" or "type oc-agent-2 search words". Navigation, history changes and page actions require Only Chat approval and still pass Focus Fence policy.'
          : name.startsWith('notion_rea_')
            ? `Use Aside/REA for the user's free-plan Notion workspace. Open or navigate only HTTPS notion.so, notion.com, or notion.site URLs; use notion_rea_search to search workspace pages/content for the user's query, inspect returned result links, click the matching result with notion_rea_act, and read it with notion_rea_read. Use notion_rea_aria for current actionable refs. Edits use notion_rea_act under Only Chat approval, then verify with notion_rea_read. The user signs into Notion directly in Aside; never request, read, or enter passwords, passkeys, MFA codes, or recovery secrets. ${name}`
            : `Use Only Chat's ${name} capability when the user requests it.`,
      parameters: name === 'joint_development_assess' || name === 'joint_development_create'
        ? JOINT_DEVELOPMENT_CONTRACT
        : name === 'read_file'
        ? { type: 'object', properties: {
            path: { type: 'string', minLength: 1, description: 'Workspace-root-relative path. Root-level files use only their filename, e.g. TODO_ROADMAP.md.' },
            start_line: { type: 'integer', minimum: 1, description: 'Inclusive 1-based first line. If end_line is supplied, end_line must be greater than or equal to start_line.' },
            end_line: { type: 'integer', minimum: 1, description: 'Inclusive 1-based last line, not a line count. For lines 151-152 use start_line=151 and end_line=152.' }
          }, required: ['path'], additionalProperties: false }
          : name === 'edit_file'
            ? { type: 'object', properties: {
              path: { type: 'string', minLength: 1, description: 'Workspace-root-relative path; no project-name prefix.' },
              target: { type: 'string', minLength: 1 }, replacement: { type: 'string' }
            }, required: ['path', 'target', 'replacement'], additionalProperties: false }
        : name === 'joint_development_list'
          ? { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false }
          : name === 'joint_development_read'
            ? { type: 'object', properties: { taskKey: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['taskKey'], additionalProperties: false }
        : name === 'task_registry_list'
        ? { type: 'object', properties: { status: { type: 'string', enum: ['planned', 'claimed', 'executing', 'verifying', 'integrating', 'reviewing', 'blocked', 'completed', 'failed'] }, limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Optional. Omit this field for the default of 100; if supplied, use an integer from 1 through 200.' } }, additionalProperties: false }
        : name === 'task_registry_read'
          ? { type: 'object', properties: { taskKey: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['taskKey'], additionalProperties: false }
          : name === 'task_registry_create'
            ? { type: 'object', properties: { taskKey: { type: 'string', minLength: 1, maxLength: 128 }, title: { type: 'string', minLength: 1, maxLength: 120 }, repositoryPath: { type: 'string' }, baseSha: { type: 'string', minLength: 40, maxLength: 64 }, paths: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } }, nextAction: { type: 'string', maxLength: 2000 }, idempotencyKey: { type: 'string', maxLength: 160 } }, required: ['taskKey', 'title', 'repositoryPath', 'baseSha', 'paths'], additionalProperties: false }
            : name === 'task_registry_claim'
              ? { type: 'object', properties: { taskKey: { type: 'string', minLength: 1, maxLength: 128 }, idempotencyKey: { type: 'string', maxLength: 160 }, leaseMs: { type: 'integer', minimum: 30000, maximum: 900000 } }, required: ['taskKey'], additionalProperties: false }
              : name === 'task_registry_checkpoint'
                ? { type: 'object', properties: { taskKey: { type: 'string', minLength: 1, maxLength: 128 }, status: { type: 'string', enum: ['claimed', 'executing', 'verifying', 'integrating', 'reviewing', 'blocked', 'completed', 'failed'] }, nextAction: { type: 'string', maxLength: 2000 }, blocker: { type: 'string', maxLength: 2000 }, evidenceRefs: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 2048 } }, idempotencyKey: { type: 'string', maxLength: 160 } }, required: ['taskKey', 'status'], additionalProperties: false }
        : name === 'task_registry_messages'
          ? { type: 'object', properties: { taskKey: { type: 'string', minLength: 1, maxLength: 128 }, afterMessageId: { type: 'string', maxLength: 64 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['taskKey'], additionalProperties: false }
          : name === 'task_registry_send'
            ? { type: 'object', properties: { taskKey: { type: 'string', minLength: 1, maxLength: 128 }, recipientChatId: { type: 'string', maxLength: 256 }, text: { type: 'string', minLength: 1, maxLength: 1200 }, idempotencyKey: { type: 'string', maxLength: 160 } }, required: ['taskKey', 'text'], additionalProperties: false }
              : name === 'task_registry_ack'
              ? { type: 'object', properties: { taskKey: { type: 'string', minLength: 1, maxLength: 128 }, messageId: { type: 'string', minLength: 1, maxLength: 64 }, text: { type: 'string', minLength: 1, maxLength: 1200 }, idempotencyKey: { type: 'string', maxLength: 160 } }, required: ['taskKey', 'messageId', 'text'], additionalProperties: false }
              : ['task_registry_check', 'task_registry_record_check'].includes(name)
                ? { type: 'object', properties: { verificationKey: { type: 'string', minLength: 1, maxLength: 128 }, repositoryPath: { type: 'string', minLength: 1 }, inputSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' }, commandSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' }, environmentSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' }, evidenceRef: { type: 'string', minLength: 1, maxLength: 2048 }, idempotencyKey: { type: 'string', maxLength: 160 } }, required: ['verificationKey', 'repositoryPath', 'inputSha256', 'commandSha256', 'environmentSha256', ...(name === 'task_registry_record_check' ? ['evidenceRef'] : [])], additionalProperties: false }
        : name === 'notion_rea_open' || name === 'notion_rea_navigate'
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
          : name === 'embedded_3f_navigate'
            ? { type: 'object', properties: { url: { type: 'string', minLength: 1, maxLength: 2048 } }, required: ['url'], additionalProperties: false }
            : name === 'embedded_3f_act'
              ? { type: 'object', properties: { action: { type: 'string', minLength: 1, maxLength: 1200 } }, required: ['action'], additionalProperties: false }
              : name === 'embedded_3f_history'
                ? { type: 'object', properties: { action: { type: 'string', enum: ['back', 'forward', 'reload'] } }, required: ['action'], additionalProperties: false }
                : ['embedded_3f_status', 'embedded_3f_read', 'embedded_3f_aria'].includes(name)
                  ? { type: 'object', properties: {}, additionalProperties: false }
                  : { type: 'object', properties: {}, additionalProperties: true }
    }
  }));
}

function explicitlyRequestsNoTools(history = []) {
  const latestUserMessage = [...history].reverse().find(message => message?.role === 'user')?.content;
  const text = typeof latestUserMessage === 'string' ? latestUserMessage : '';
  return /\b(?:do not|don't|never)\s+(?:use|call|invoke)\s+(?:any\s+)?tools?\b|\bwithout\s+(?:using|calling)\s+tools?\b|\bno\s+tools\b/i.test(text)
    || /도구(?:를)?\s*(?:전혀\s*)?(?:사용하지|호출하지|쓰지)\s*(?:말고|마|말|않)|도구\s*없이/.test(text);
}

function explicitlyRequestsEmbeddedThreefStatus(history = []) {
  const prompt = [...history].reverse().find(message => message?.role === 'user')?.content;
  if (typeof prompt !== 'string') return false;
  return /\bembedded_3f_status\b|(?:embedded|임베디드).{0,24}(?:3f|쓰리[ -]?에프).{0,32}(?:browser|브라우저)/i.test(prompt);
}

function explicitlyRequestsStandaloneThreefStatus(history = []) {
  const prompt = [...history].reverse().find(message => message?.role === 'user')?.content;
  if (typeof prompt !== 'string') return false;
  return !explicitlyRequestsEmbeddedThreefStatus(history)
    && (/\bthreef_browser_status\b|(?:standalone|독립|단독).{0,32}(?:3f|쓰리[ -]?에프).{0,32}(?:browser|브라우저).{0,32}(?:status|상태|연결|페이지)|(?:3f|쓰리[ -]?에프).{0,32}(?:browser|브라우저).{0,32}(?:standalone|독립|단독)|(?:3f|쓰리[ -]?에프)\s*(?:browser|브라우저).{0,48}(?:status|상태|연결|열린\s*페이지|열려\s*있는\s*페이지)/i.test(prompt));
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

function parseToolCalls(items, allowGuestWindowRead = false) {
  if (!Array.isArray(items)) return [];
  const seenIds = new Set();
  return items.map((item, index) => {
    const fn = item?.function || {};
    let args = fn.arguments ?? item?.args ?? {};
    if (typeof args === 'string') args = JSON.parse(args);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Router returned invalid tool arguments.');
    const name = fn.name || item?.name;
    if (typeof name !== 'string' || !name) throw new Error('Router returned a tool call without a name.');
    if (!TOOL_NAMES.includes(name) && !(allowGuestWindowRead && name === 'guest_list_windows')) throw new Error('Router requested a tool unavailable to the Account Router provider.');
    if (item.id !== undefined && (typeof item.id !== 'string' || !item.id.trim())) {
      throw new Error('Router returned an invalid tool call ID.');
    }
    const id = item.id || `router-${index}-${name}`;
    if (seenIds.has(id)) throw new Error('Router returned duplicate tool call IDs.');
    seenIds.add(id);
    return { id, name, args };
  });
}

function safeOllamaErrorDetail(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\/(?:Users|Volumes|private|tmp)\/[^:]+/g, '[local path]')
    .slice(0, 180);
}

function createAccountRouterAdapter(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const providerName = options.providerName || 'AI Account Router';
  const fetchImpl = options.fetch || globalThis.fetch;
  const timeoutMs = options.timeoutMs || 120_000;
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');

  async function call(tier, history, hooks = {}, context = {}) {
    if (!Array.isArray(history) || !history.length) throw new Error('Router needs a non-empty conversation history.');
    const toolProfile = context.toolProfile || (explicitlyRequestsNoTools(history) ? 'no-tools' : null);
    const requireInitialRead = toolProfile === 'file-read' && !history.some(message => message?.role === 'tool');
    const signal = context.signal || AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          model: tier?.model || 'auto',
          messages: history,
          tools: Array.isArray(context.allowedTools)
            ? [
                ...toolDefinitions(context.approvalPolicy, toolProfile).filter(tool => context.allowedTools.includes(tool.function.name)),
                ...(context.toolProfile !== 'no-tools' && context.allowedTools.includes('guest_list_windows')
                  ? [{ type: 'function', function: {
                      name: 'guest_list_windows',
                      description: 'List windows on this session’s assigned isolated SSH guest.',
                      parameters: { type: 'object', properties: {}, additionalProperties: false }
                    } }]
                  : [])
              ]
            : toolDefinitions(context.approvalPolicy, toolProfile),
          tool_choice: toolProfile === 'no-tools' ? 'none'
            : toolProfile === 'embedded-3f-status' && !history.some(message => message?.role === 'tool') ? { type: 'function', function: { name: 'embedded_3f_status' } }
              : toolProfile === 'threef-browser-status' && !history.some(message => message?.role === 'tool') ? { type: 'function', function: { name: 'browser_status' } }
              : requireInitialRead ? { type: 'function', function: { name: 'read_file' } } : 'auto',
          stream: false
        }),
        signal
      });
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw new Error(`${providerName} request timed out or was cancelled.`);
      throw new Error(`${providerName} is unavailable at ${baseUrl}.`);
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const code = body?.error?.code;
      const detail = providerName === 'Ollama' ? safeOllamaErrorDetail(body?.error) : '';
      const error = new Error(code === 'provider_unconfigured'
        ? `${providerName} has no configured provider account.`
        : `${providerName} returned HTTP ${response.status}${code ? ` (${code})` : ''}${detail ? `: ${detail}` : ''}.`);
      error.status = response.status;
      error.code = code || 'router_error';
      throw error;
    }
    const message = body?.choices?.[0]?.message;
    if (!message || (typeof message.content !== 'string' && !Array.isArray(message.tool_calls))) {
      throw new Error('AI Account Router returned an invalid chat completion.');
    }
    const toolCalls = parseToolCalls(message.tool_calls,
      context.toolProfile !== 'no-tools' && context.allowedTools?.includes('guest_list_windows'));
    if (toolProfile === 'no-tools' && toolCalls.length) {
      throw new Error(`${providerName} returned a tool call for a no-tools request.`);
    }
    const content = typeof message.content === 'string' ? message.content : '';
    if (content) hooks.onMessageDelta?.(content);
    const routing = body.router && typeof body.router.accountId === 'string'
      ? { accountId: body.router.accountId, rank: body.router.rank, model: body.router.model } : null;
    return { content, toolCalls, usage: body.usage || null, ...(routing ? { routing } : {}), protocol: 'openai-compatible' };
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

  async function updateChain(endpoint, input) {
    const response = await fetchImpl(`${baseUrl}${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl },
      body: JSON.stringify(input), signal: AbortSignal.timeout(5000)
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result?.error?.message || 'AI Account Router 설정을 저장하지 못했습니다.');
      error.status = response.status;
      throw error;
    }
    return result;
  }

  return Object.freeze({ baseUrl, getChain, call,
    reorderAccounts: input => updateChain('/api/v1/account-chain/reorder', input),
    setAccountModel: (id, model) => updateChain(`/api/accounts/${encodeURIComponent(id)}/model`, { model })
  });
}

function verifyTodoStatusAnswer(history, answer) {
  const prompts = history.filter(message => message?.role === 'user' && typeof message.content === 'string' && message.content.trim());
  const prompt = prompts.at(-1)?.content || '';
  if (!/(?:\bTODOs?\b|\bTODO[_-][A-Za-z0-9_-]+\b|투두|할\s*일|체크박스|checkbox)/i.test(prompt)) return answer;

  const readFileCallIds = new Set(history.flatMap(message => Array.isArray(message?.tool_calls) ? message.tool_calls : [])
    .filter(call => (call?.function?.name || call?.name) === 'read_file' && typeof call.id === 'string')
    .map(call => call.id));
  const readFileResults = history.filter(message => message?.role === 'tool' && readFileCallIds.has(message.tool_call_id));
  const evidence = readFileResults
    .map(message => typeof message.content === 'string' ? message.content : '')
    .join('\n');
  const readFileFailed = readFileResults.some(message => {
    try { return typeof JSON.parse(message.content)?.error === 'string'; }
    catch (_) { return false; }
  });
  const rows = [...evidence.matchAll(/^\s*-\s+\[([ xX])\]\s+\*\*(TODO-[A-Za-z0-9_-]+)\.\s*([^\n]*)/gm)];
  const requestedId = prompt.match(/\bTODO-[A-Za-z0-9_-]+\b/i)?.[0]?.toUpperCase();
  const promptIds = new Set([...prompt.matchAll(/\bTODO-[A-Za-z0-9_-]+\b/gi)].map(([id]) => id.toUpperCase()));
  const evidenceIds = new Set([...evidence.matchAll(/\bTODO-[A-Za-z0-9_-]+\b/gi)].map(([id]) => id.toUpperCase()));
  const asksTodoStatus = /\b(?:status|state|checked|complete|completed|done|open|unfinished)\b|(?:상태|체크|완료|미완료|열렸|열려\s*있)/i.test(prompt);
  const wantsTodoList = /\b(?:list|show|which|remaining|open|unfinished)\b|(?:목록|미완료|남은\s*(?:할\s*일|작업|투두)|나열|정리)/i.test(prompt);
  const answerRows = [...answer.matchAll(/^\s*-\s+\[([ xX])\]\s+(?:\*\*)?\[?(TODO-[A-Za-z0-9_-]+)\]?/gim)];
  const unsupportedAnswerRows = answerRows.filter(([, marker, id]) =>
    !rows.some(([, sourceMarker, sourceId]) => sourceMarker.toLowerCase() === marker.toLowerCase() && sourceId.toUpperCase() === id.toUpperCase()));
  if (unsupportedAnswerRows.length) return '읽은 원문에서 답변에 제시된 TODO 체크박스 항목을 확인할 수 없어 해당 목록을 검증하지 못했습니다.';
  const unsupportedAnswerIds = [...answer.matchAll(/\bTODO-[A-Za-z0-9_-]+\b/gi)]
    .map(([id]) => id.toUpperCase())
    .filter(id => !promptIds.has(id) && !evidenceIds.has(id));
  if (unsupportedAnswerIds.length) return '읽은 원문에서 답변에 제시된 TODO ID를 확인할 수 없어 답변을 검증하지 못했습니다.';
  if (!requestedId && wantsTodoList) {
    if (!readFileResults.length || readFileFailed) return 'TODO 원문을 읽지 못해 체크박스 목록을 확인할 수 없습니다.';
    const checklistRows = [...evidence.matchAll(/^\s*-\s+\[([ xX])\]\s+([^\n]+)/gm)]
      .map(([, marker, rawLabel]) => {
        const boldLabel = /^\*\*(.*?)\*\*/.exec(rawLabel.trim())?.[1];
        const label = (boldLabel || rawLabel.split(/:\s/)[0]).replace(/\s+/g, ' ').trim();
        return { marker, label: label.slice(0, 200) };
      })
      .filter(row => row.label);
    const uniqueRows = [...new Map(checklistRows.map(row => [`${row.marker}\0${row.label}`, row])).values()];
    const visibleRows = /\b(?:remaining|open|unfinished)\b|(?:미완료|남은\s*(?:할\s*일|작업|투두))/i.test(prompt)
      ? uniqueRows.filter(row => row.marker === ' ')
      : uniqueRows;
    const list = visibleRows.map(row => `- [${row.marker}] ${row.label}`).join('\n');
    return list
      ? `Only Chat read_file 반환 내용에서 확인한 체크박스입니다. 읽지 않은 범위의 상태는 포함하지 않았습니다.\n${list}`
      : 'Only Chat read_file 반환 내용에서 표시할 체크박스 항목을 찾지 못했습니다. 읽지 않은 범위에 항목이 더 있을 수 있습니다.';
  }
  const row = requestedId ? rows.find(match => match[2].toUpperCase() === requestedId) : rows.length === 1 ? rows[0] : null;
  if (!row) {
    if (requestedId && asksTodoStatus) {
      if (!readFileResults.length || readFileFailed) return `TODO 원문을 읽지 못해 ${requestedId} 상태를 확인할 수 없습니다.`;
      return `읽은 원문에서 ${requestedId} 항목을 찾지 못해 상태를 확인할 수 없습니다.`;
    }
    return answer;
  }

  const [, marker, todoId] = row;
  const unchecked = marker === ' ';
  const sourceDisclaimsProviderProof = /(?:do not|does not|doesn't) prove a provider call|provider call.{0,50}(?:not proven|unverified|not verified)|provider\s*(?:호출|요청).{0,40}(?:증명|입증|검증).{0,12}않/i.test(evidence);
  const answerStatesCompletion = /\b(?:checked|complete|completed|done|finished|passed|verified)\b|(?:체크|작업|할\s*일).{0,10}(?:완료|끝|검증|확인)/i.test(answer);
  const answerClaimsProviderProof = /\b(?:proves?|proved|confirms?|confirmed|demonstrates?)\b.{0,50}\bprovider call\b|\bprovider call\b.{0,50}\b(?:proven|verified|confirmed|successful)\b|(?:실제\s*)?(?:provider\s*)?(?:호출|요청).{0,35}(?:증명|입증|검증|확인|성공)/i.test(answer);
  const answerAcknowledgesProviderGap = /(?:does not|do not|doesn't|cannot|not)\s+(?:prove|confirm|establish)|not proven|not verified|unverified|미검증|증명하지|입증하지|검증되지/i.test(answer);
  const answerInventsDraftCausality = /(?:because|since|due to|때문에|이유로).{0,60}(?:draft|recording|초안|녹화).{0,60}(?:provider|호출|요청|검증|증명|확인)|(?:draft|recording|초안|녹화).{0,60}(?:때문에|이유로).{0,60}(?:provider|호출|요청|검증|증명|확인)|(?:provider|호출|요청|검증|증명|확인).{0,60}(?:because|since|due to).{0,60}(?:draft|recording|초안|녹화)/i.test(answer);
  const grounded = answer.includes(todoId)
    && answer.includes(`[${marker}]`)
    && !(unchecked && answerStatesCompletion)
    && !(sourceDisclaimsProviderProof && answerClaimsProviderProof && !answerAcknowledgesProviderGap)
    && !answerInventsDraftCausality
    && (!sourceDisclaimsProviderProof || answerAcknowledgesProviderGap);
  if (grounded) return answer;

  const status = unchecked ? '미완료' : '완료 표시';
  const gap = sourceDisclaimsProviderProof ? ' 원문은 현재 UI/status 값만으로 실제 provider 호출을 증명할 수 없다고 명시합니다.' : '';
  return `원문 검증 결과: ${todoId} [${marker}] (${status}).${gap}`;
}

function createOllamaAdapter(options = {}) {
  const adapter = createAccountRouterAdapter({
    ...options,
    baseUrl: options.baseUrl || DEFAULT_OLLAMA_BASE_URL,
    providerName: 'Ollama'
  });
  return Object.freeze({ call: async (...args) => {
    const history = Array.isArray(args[1]) ? args[1] : [];
    const hasSystemMessage = history.some(message => message?.role === 'system');
    const localAssistantGuide = {
      role: 'system',
      content: 'You are Only Chat\'s local assistant. Answer ordinary conversation and text-only requests directly without calling tools. Use a tool only when the user asks for a task that requires current workspace, device, or service data, or asks you to perform a concrete action. For large files, read only a small line range (about 30 lines); start_line and end_line are inclusive 1-based line numbers, and end_line must be greater than or equal to start_line. For source-code analysis, synthesize after reading instead of returning raw excerpts; state each finding with an exact function or identifier and a short exact quote from read_file output, distinguish absent evidence from unread evidence, and say the analysis is incomplete when requested evidence was not read. For qwen2.5:3b, make at most 4 read_file calls per source-analysis turn; if more evidence is needed, stop and name the next narrow range. For lines 151-152 send start_line=151 and end_line=152. Fetch more ranges only as needed. Follow each tool schema exactly; never invent filenames, paths, IDs, limits, or results. Treat tool output as the evidence boundary: preserve explicit checkboxes and negations, distinguish source or test evidence from live runtime evidence, and state when a requested fact is not established by the returned text. In Markdown, [ ] means unchecked/open/incomplete and [x] or [X] means checked/complete; when reporting status, copy the exact marker and never call [ ] checked. Never infer screenshots, provider calls, device behavior, or completion from a plan, status label, or test result. If a tool fails, report the failure plainly and do not claim the task is complete. Never show tool-call markup such as <tool_call> to the user.'
    };
    const requestHistory = hasSystemMessage ? history : [localAssistantGuide, ...history];
    const context = args[3] || {};
    const toolProfile = context.toolProfile || (explicitlyRequestsNoTools(history)
      ? 'no-tools'
      : explicitlyRequestsStandaloneThreefStatus(history) ? 'threef-browser-status'
        : explicitlyRequestsEmbeddedThreefStatus(history) ? 'embedded-3f-status' : 'file-edit');
    let response = await adapter.call(args[0], requestHistory, { ...args[2], onMessageDelta: undefined }, {
      ...context,
      toolProfile
    });
    if (toolProfile === 'no-tools' && response.toolCalls.length) {
      throw new Error('Ollama returned a tool call for a no-tools request.');
    }
    const allowedTools = toolProfile === 'file-read' ? ['read_file']
      : toolProfile === 'file-edit' ? ['read_file', 'edit_file']
        : toolProfile === 'embedded-3f-status' ? ['embedded_3f_status']
          : toolProfile === 'threef-browser-status' ? ['browser_status'] : null;
    if (allowedTools && response.toolCalls.some(call => !allowedTools.includes(call.name))) {
      throw new Error(`Ollama returned a tool outside the selected ${toolProfile} tool profile.`);
    }
    if (response.toolCalls.length === 0 && /<\/?tool_call>/i.test(response.content)) {
      const recoveryHistory = [
        ...requestHistory.filter(message => message?.role === 'system'),
        { role: 'system', content: 'Your previous reply contained invalid tool-call markup. Do not call tools. Use only the available conversation and tool results to answer the user plainly, without any tool-call markup.' },
        ...requestHistory.filter(message => message?.role !== 'system')
      ];
      response = await adapter.call(args[0], recoveryHistory, { ...args[2], onMessageDelta: undefined }, {
        ...context,
        toolProfile: 'no-tools'
      });
      if (response.toolCalls.length || /<\/?tool_call>/i.test(response.content)) {
        throw new Error('Ollama returned a leaked tool-call marker instead of a final answer.');
      }
    }
    if (response.toolCalls.length === 0) response.content = verifyTodoStatusAnswer(requestHistory, response.content);
    if (response.content) args[2]?.onMessageDelta?.(response.content);
    return response;
  } });
}

export { DEFAULT_BASE_URL, DEFAULT_OLLAMA_BASE_URL, createAccountRouterAdapter, createOllamaAdapter, normalizeBaseUrl, parseToolCalls, toolDefinitions };
