/**
 * @project My-Codex
 * @provenance:rogan-core
 * @author Rogan Kim (GeunHu Kim) & AI Architect
 * @license MIT
 * @description Sovereign Codex Agent Engine running multi-turn execution loops with autonomous priority fallback.
 */
'use strict';

const { ToolRegistry } = require('../tools/ToolRegistry.js');
const { PriorityChainEngine } = require('../priority/PriorityChainEngine.js');
const { AuthManager } = require('../auth/AuthManager.js');
const { SessionStore } = require('./SessionStore.js');
const { SkillManager } = require('./SkillManager.js');
const { ParallelDispatcher } = require('./ParallelDispatcher.js');
const { OwnershipLock } = require('./OwnershipLock.js');
const { WorkspaceExecutionLease } = require('./WorkspaceExecutionLease.js');
const { TaskRegistryStore } = require('./TaskRegistryStore.js');
const { HandoffAdapter } = require('./HandoffAdapter.js');
const { parseReasoningEffort } = require('./ReasoningEffort.js');
const { AccountRouterModuleSlot } = require('../features/provider/AccountRouterModuleSlot.js');
const path = require('node:path');
const os = require('node:os');

const MUTATION_TOOL_NAMES = new Set([
  'exec_command', 'bash', 'write_file', 'edit_file', 'apply_patch',
  'google_drive_create', 'google_drive_update', 'gmail_send',
  'notion_create_page', 'notion_update_page', 'notion_append_blocks', 'notion_api_write',
  'notion_mcp_call_tool',
  'notion_rea_open', 'notion_rea_navigate', 'notion_rea_act',
  'browser_open', 'browser_navigate', 'browser_act', 'browser_recipe', 'browser_history',
  'vault_get_credential',
  'browser_workspace_snapshot', 'browser_workspace_restore', 'browser_workspace_focus', 'browser_workspace_open',
  'task_registry_create', 'task_registry_claim', 'task_registry_checkpoint', 'task_registry_send', 'task_registry_ack'
]);

function isMutationToolName(name) {
  return MUTATION_TOOL_NAMES.has(name);
}

function providerFailureCategory(error) {
  if (['approval_required', 'approval_denied'].includes(error?.category)) return error.category;
  const message = String(error?.message || error || '');
  if (/\b429\b|too many requests|quota|rate[\s_-]?limit|resource.?exhausted/i.test(message)) return 'quota_rate_limit';
  if (/unauthori[sz]ed|authentication required|not logged in|\b401\b|invalid credential/i.test(message)) return 'authentication';
  if (/model_not_found|model.{0,30}(?:unavailable|not found|not supported)|unsupported model/i.test(message)) return 'model_unavailable';
  if (/sandbox|permission denied|not permitted|access denied|샌드박스|권한 거부|권한 차단/i.test(message)) return 'sandbox_permission_blocked';
  if (/network|\b(?:econn|enotfound|ehostunreach|etimedout|eai_again)\b|fetch failed|connection refused/i.test(message)) return 'network_unavailable';
  return 'provider_failure';
}

function safeProviderModel(model) {
  if (typeof model !== 'string') return '';
  const safe = model.replace(/[^A-Za-z0-9._+:/ -]/g, '').trim().slice(0, 80);
  return safe;
}

function safeProviderTier(tier) {
  const tierName = typeof tier?.name === 'string' ? tier.name.replace(/[^A-Za-z0-9._+:/ -]/g, '').trim().slice(0, 40) : '';
  return tierName || 'unknown';
}

class AgentEngine {
  constructor(options = {}) {
    this.isolated = options.isolated === true;
    this.dataDir = path.resolve(options.dataDir || path.join(os.homedir(), '.my-codex'));
    if (this.isolated && !options.dataDir) throw new Error('An explicit temporary dataDir is required in isolated mode.');
    const insideDataDir = value => {
      const resolved = path.resolve(value);
      const relative = path.relative(this.dataDir, resolved);
      if (this.isolated && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) throw new Error('Isolated runtime paths must stay inside dataDir.');
      return resolved;
    };
    this.workspaceDir = insideDataDir(options.workspaceDir || (this.isolated ? path.join(this.dataDir, 'workspace') : process.cwd()));
    this.defaultWorkspaceDir = this.workspaceDir;
    this.tools = new ToolRegistry({
      workspaceDir: this.workspaceDir,
      sandboxRoot: this.isolated ? this.dataDir : null,
      commandRunner: options.commandRunner,
      approvalPolicy: options.approvalPolicy || 'on-request',
      browser: options.browser,
      notionReaBrowser: options.notionReaBrowser,
      browserEnabled: !this.isolated,
      providerConnectionsEnabled: !this.isolated,
      taskRegistryStore: this.isolated ? null : new TaskRegistryStore({ dataDir: this.dataDir }),
      connectorOptions: this.isolated ? { storageDir: path.join(this.dataDir, 'providers'), clientConfigFile: false, readEnvironment: false } : {},
      vaultOptions: this.isolated ? { vaultDir: path.join(this.dataDir, 'vault') } : {},
      browserWorkspaceOptions: this.isolated ? { enabled: false, workspaceDir: path.join(this.dataDir, 'browser-workspaces') } : {}
    });
    this.priorityChain = new PriorityChainEngine({ configDir: insideDataDir(options.configDir || (this.isolated ? path.join(this.dataDir, 'config') : this.dataDir)), seedDefaults: !this.isolated, notify: options.notify, isTierReady: options.isTierReady });
    this.auth = new AuthManager({ authFile: insideDataDir(options.authFile || (this.isolated ? path.join(this.dataDir, 'auth', 'auth.json') : path.join(this.dataDir, 'auth.json'))), seedDefaults: !this.isolated });
    this.sessions = new SessionStore({ storageDir: insideDataDir(options.storageDir || path.join(this.dataDir, 'sessions')) });
    
    // Core Rogan-requested systems
    this.skills = new SkillManager(this.isolated ? {
      workspaceDir: this.workspaceDir,
      globalSkillsDir: path.join(this.dataDir, 'skills'),
      sharedSkillsDir: false,
      pluginCacheDir: false,
      watchEnabled: false
    } : { workspaceDir: this.workspaceDir, watchEnabled: options.watchSkills !== false });
    // Dispatched tasks get their own session and run serially in this workspace.
    this.dispatcher = new ParallelDispatcher({
      autoStart: options.dispatcherAutoStart ?? !this.isolated,
      maxGlobalConcurrency: 1,
      executeTask: task => this._executeDispatchedTask(task)
    });
    this.ownership = new OwnershipLock({ workspaceDir: this.workspaceDir });
    this.workspaceExecutionLease = new WorkspaceExecutionLease({
      lockRoot: path.join(this.dataDir, 'workspace-leases')
    });
    this.handoff = options.handoffStorageDir
      ? new HandoffAdapter({ storageDir: insideDataDir(options.handoffStorageDir), gdriveHandoffDir: false })
      : new HandoffAdapter(this.isolated
      ? { storageDir: path.join(this.dataDir, 'handoff'), gdriveHandoffDir: false }
      : {});
    this.providerAdapter = options.providerAdapter || null;
    this.accountRouterModuleSlot = new AccountRouterModuleSlot({ projectRoot: path.resolve(__dirname, '../..') });

    this.currentSession = null;
    this.conversationHistory = [];
  }

  initSession(metadata = {}) {
    const activeTier = this.priorityChain.resolveActiveTier();
    if (!activeTier && !metadata.model) {
      throw new Error('사용 가능한 우선순위 계정이 없습니다. 계정 상태와 사용 한도를 확인해 주세요.');
    }
    this.currentSession = this.sessions.createSession({
      workspaceDir: metadata.workspaceDir || this.workspaceDir,
      model: metadata.model || activeTier?.model,
      provider: metadata.provider || activeTier?.provider,
      ...metadata
    });
    this.conversationHistory = metadata.initialHistory ? [...metadata.initialHistory] : [];
    return this.currentSession;
  }

  loadResumedSession(sessionData) {
    const sourceSessionId = sessionData.sessionId || sessionData.id;
    const isInternal = sessionData.source === 'internal';
    if (isInternal && (typeof sourceSessionId !== 'string' || !SessionStore.SESSION_ID.test(sourceSessionId))) {
      throw new Error('Invalid internal session.');
    }
    if (!isInternal && (!['codex', 'antigravity'].includes(sessionData.source) || typeof sessionData.id !== 'string')) {
      throw new Error('Invalid external session.');
    }

    const workspaceDir = sessionData.cwd || this.workspaceDir;
    let turns = (Array.isArray(sessionData.turns) ? sessionData.turns : []).filter(turn =>
      ['user', 'assistant'].includes(turn?.role) && typeof turn.content === 'string');
    let currentSession;
    if (isInternal) {
      currentSession = {
        sessionId: sourceSessionId,
        resumedFrom: sessionData.source,
        title: sessionData.title,
        workspaceDir,
        model: sessionData.model
      };
    } else {
      const existingImport = this.sessions.listSessions().find(session =>
        session.resumedFrom === sessionData.source && session.externalSessionId === sessionData.id);
      const existingSession = existingImport && this.sessions.resumeSession(existingImport.sessionId);
      if (existingSession) {
        currentSession = {
          sessionId: existingSession.sessionId,
          resumedFrom: sessionData.source,
          externalSessionId: sessionData.id,
          title: existingSession.title || sessionData.title,
          workspaceDir,
          model: existingSession.model || sessionData.model
        };
        turns = existingSession.turns;
      } else {
        const localSession = this.sessions.createSession({
          workspaceDir,
          model: sessionData.model,
          provider: sessionData.source === 'codex' ? 'codex' : 'antigravity-cli',
          title: sessionData.title,
          resumedFrom: sessionData.source,
          externalSessionId: sessionData.id
        });
        for (const turn of turns) {
          this.sessions.appendItem(localSession.sessionId, {
            type: turn.role === 'user' ? 'user_message' : 'assistant_message',
            content: turn.content
          });
        }
        currentSession = {
          ...localSession,
          resumedFrom: sessionData.source,
          externalSessionId: sessionData.id,
          title: sessionData.title,
          workspaceDir,
          model: sessionData.model
        };
      }
    }

    this.workspaceDir = workspaceDir;
    this.tools.setWorkspace(this.workspaceDir);
    this.ownership = new OwnershipLock({ workspaceDir: this.workspaceDir });
    this.currentSession = currentSession;
    // Keep the imported transcript in Only Chat's local session; the source stays read-only.
    this.conversationHistory = turns.map(t => ({
      role: t.role,
      content: t.content
    }));

    return this.currentSession;
  }

  loadInternalSession(sessionData) {
    if (!sessionData || sessionData.source !== 'internal' || typeof sessionData.sessionId !== 'string'
      || !/^ses_[a-f0-9]{16}$/.test(sessionData.sessionId)) {
      throw new Error('Invalid internal session.');
    }
    return this.loadResumedSession({ ...sessionData, id: sessionData.sessionId });
  }

  /**
   * Run one conversational agent turn with streaming callbacks and tool dispatching
   */
  async executeTurn(userPrompt, callbacks = {}) {
    return this.workspaceExecutionLease.run(
      this.workspaceDir,
      this.currentSession?.sessionId || 'router-provider-discovery',
      async () => {
        await this._ensureAccountRouterTier();
        if (!this.currentSession) this.initSession();
        return this._executeTurn(userPrompt, callbacks);
      }
    );
  }

  async _ensureAccountRouterTier() {
    if (this.isolated || this.priorityChain.chain.tiers.some(tier => tier.provider === 'account-router')) return false;
    if (Date.now() < (this.accountRouterDiscoveryRetryAt || 0)) return false;
    this.accountRouterDiscoveryRetryAt = Date.now() + 15_000;
    try {
      const accountRouterAdapter = await this._getAccountRouterAdapter();
      const chain = await accountRouterAdapter.getChain();
      const configured = chain.enabled && chain.accounts.some(account => account.enabled !== false &&
        account.provider && account.provider !== 'demo' && account.provider !== 'unconfigured' &&
        account.model && account.model !== 'unconfigured');
      if (!configured) return false;
      this.priorityChain.upsertTier({
        id: 'account-router-local',
        name: 'AI Account Router (Local)',
        provider: 'account-router',
        model: 'auto',
        account: 'account-router-local',
        enabled: true,
        description: 'Automatic local fallback; provider profiles remain managed by AI Account Router.'
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  _requiresToolApproval(call) {
    const notionMcpRead = this.tools.isNotionMcpReadOnlyCall(call);
    if (this.tools.approvalPolicy === 'read-only') return isMutationToolName(call?.name) && !notionMcpRead;
    if (this.tools.approvalPolicy === 'never') return false;
    return !notionMcpRead && !['read_file', 'list_files', 'search_files', 'gmail_list', 'gmail_read', 'google_drive_list', 'google_drive_read', 'notion_search', 'notion_query', 'notion_api_read', 'notion_mcp_list_tools', 'notion_rea_read', 'notion_rea_search', 'notion_rea_aria', 'notion_rea_status', 'browser_aria', 'browser_read', 'browser_status', 'spacekeeper_session_report', 'spacekeeper_capacity_status', 'task_registry_list', 'task_registry_read', 'task_registry_messages'].includes(call?.name);
  }

  async _getAccountRouterAdapter() {
    // Keep the injected adapter seam for isolated/synthetic callers; production
    // resolves the allowlisted module by its current source hash on each call.
    if (this.accountRouterAdapter) return this.accountRouterAdapter;
    return (await this.accountRouterModuleSlot.load()).adapter;
  }

  async _getDispatcherAllowedProviderIds() {
    // Native CLI agents execute tools inside their own subprocess and cannot
    // enforce this task's exact allowlist. Only the Account Router returns
    // tool calls for AgentEngine to validate before local execution.
    if (this.isolated) return null;
    const tiers = this.priorityChain.chain.tiers.filter(tier => tier.enabled !== false && tier.provider === 'account-router');
    if (!tiers.length) return [];
    try {
      const chain = await (await this._getAccountRouterAdapter()).getChain();
      const accounts = Array.isArray(chain?.accounts)
        ? chain.accounts.filter(account => account.enabled !== false && account.provider && !['demo', 'unconfigured'].includes(account.provider))
        : [];
      const isFreeModel = model => typeof model === 'string'
        && (model.toLowerCase() === 'openrouter/free' || model.toLowerCase().endsWith(':free'));
      if (chain?.enabled !== true || !accounts.length || accounts.some(account => !isFreeModel(account.model))) return [];
      return tiers.map(tier => tier.id);
    } catch (_) {
      return [];
    }
  }

  async _requestToolApproval(call, callbacks) {
    const sessionId = this.currentSession?.sessionId;
    const requestId = require('node:crypto').randomUUID();
    const approve = callbacks.requestToolApproval;
    if (typeof approve !== 'function') throw new Error(`Approval unavailable; blocked tool call '${call.name}'.`);
    const accepted = await approve({ requestId, sessionId, name: call.name, args: call.args || {} });
    if (this.currentSession?.sessionId !== sessionId || accepted !== true) throw new Error(`Tool call '${call.name}' was not approved for this session.`);
    return true;
  }

  async _executeDispatchedTask(task) {
    if (!task || typeof task.prompt !== 'string' || !task.prompt.trim()) {
      return { status: 'failed', error: '실행할 prompt가 비어 있습니다.' };
    }
    const dispatcherAllowedProviderIds = await this._getDispatcherAllowedProviderIds();
    if (Array.isArray(dispatcherAllowedProviderIds) && dispatcherAllowedProviderIds.length === 0) {
      return {
        status: 'blocked',
        reason: '현재 설정에서 도구 허용 목록을 강제할 수 있고 비용이 0원으로 확인된 dispatcher 제공자가 없습니다. Only Chat 입력창에서 직접 요청해 일반 승인 흐름을 사용해 주세요.',
        executionEvidence: null
      };
    }
    const taskKey = String(task.id || `task-${Date.now()}`).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
    const worker = new AgentEngine({
      isolated: this.isolated,
      dataDir: this.dataDir,
      workspaceDir: this.workspaceDir,
      storageDir: this.sessions.storageDir,
      configDir: this.priorityChain.configDir,
      authFile: this.auth.authFile,
      providerAdapter: this.providerAdapter,
      commandRunner: this.tools.commandRunner,
      isTierReady: tier => this.priorityChain.isTierReady(tier),
      approvalPolicy: this.tools.approvalPolicy,
      watchSkills: false,
      dispatcherAutoStart: false,
      handoffStorageDir: path.join(this.dataDir, 'dispatcher-handoff', taskKey)
    });
    worker.priorityChain = this.priorityChain;
    worker.dispatcherAllowedProviderIds = dispatcherAllowedProviderIds;
    const status = this.priorityChain.getStatus();
    const snapshot = {
      enabled: status.enabled,
      mode: status.mode,
      activeTierId: status.activeTier?.id || null,
      tiers: status.tiers.map(tier => {
        let connected = false;
        try { connected = Boolean(this.priorityChain.isTierReady(tier)); } catch (_) {}
        return {
          id: tier.id,
          tier: tier.tier,
          provider: tier.provider,
          model: tier.model,
          enabled: tier.enabled !== false,
          active: tier.id === status.activeTier?.id,
          connected,
          remainingPercent: Number.isFinite(tier.health?.totalRemainingPercent) ? tier.health.totalRemainingPercent : null,
          quotaState: tier.health?.quotaState || 'unknown'
        };
      })
    };
    const taskPrompt = `${task.prompt}\n\n[Only Chat trusted runtime priority snapshot]\n${JSON.stringify(snapshot)}`;
    const evidence = {
      toolNames: [],
      attemptedCount: 0,
      successfulCount: 0,
      failedCount: 0,
      approvalBlockedCount: 0,
      approvalUnavailableCount: 0,
      approvalDeniedCount: 0,
      approvalExpiredCount: 0,
      approvalInvalidCount: 0,
      allowedToolViolationCount: 0,
      disallowedToolNames: [],
      provider: null,
      model: null,
      tierId: null,
      tierName: null
    };
    const startedTools = new Map();
    const completedToolIds = new Set();
    const disallowedToolCallIds = new Set();
    const taskAllowedTools = new Set(Array.isArray(task.allowedTools) ? task.allowedTools : []);
    const safeToolName = name => /^[a-z][a-z0-9_]{0,63}$/i.test(String(name || '')) ? String(name) : 'unknown_tool';
    const recordToolAllowlistViolation = call => {
      const name = safeToolName(call?.name);
      if (taskAllowedTools.has(name)) return false;
      const key = String(call?.id || `${name}:${evidence.attemptedCount}`);
      if (!disallowedToolCallIds.has(key)) {
        disallowedToolCallIds.add(key);
        evidence.allowedToolViolationCount++;
        if (!evidence.disallowedToolNames.includes(name)) evidence.disallowedToolNames.push(name);
      }
      return true;
    };
    const callbacks = {
      onTierResolved: tier => {
        evidence.provider = String(tier?.provider || '').slice(0, 64) || null;
        evidence.model = String(tier?.model || '').slice(0, 128) || null;
        evidence.tierId = String(tier?.id || '').slice(0, 128) || null;
        evidence.tierName = String(tier?.name || '').slice(0, 128) || null;
      },
      onToolStart: call => {
        const name = safeToolName(call?.name);
        recordToolAllowlistViolation(call);
        evidence.attemptedCount++;
        if (!evidence.toolNames.includes(name)) evidence.toolNames.push(name);
        const key = String(call?.id || `${name}:${evidence.attemptedCount}`);
        startedTools.set(key, name);
      },
      onToolEnd: ({ call, result } = {}) => {
        const name = safeToolName(call?.name);
        const allowlistViolation = recordToolAllowlistViolation(call);
        const key = String(call?.id || '');
        const hadStart = startedTools.has(key);
        if (key && completedToolIds.has(key)) return;
        const approvalBlocked = /Approval unavailable|was not approved for this session|Approval request expired/i.test(String(result?.error || ''));
        if (key && !hadStart && !approvalBlocked) return;
        if (!key && !hadStart) {
          evidence.attemptedCount++;
          if (!evidence.toolNames.includes(name)) evidence.toolNames.push(name);
        }
        startedTools.delete(key);
        if (key) completedToolIds.add(key);
        if (/Approval unavailable/i.test(String(result?.error || ''))) {
          evidence.approvalBlockedCount++;
          evidence.approvalUnavailableCount++;
        } else if (/was not approved for this session/i.test(String(result?.error || ''))) {
          evidence.approvalBlockedCount++;
          evidence.approvalDeniedCount++;
        } else if (/Approval request expired/i.test(String(result?.error || ''))) {
          evidence.approvalBlockedCount++;
          if (/Approval request expired\./i.test(String(result?.error || ''))) evidence.approvalExpiredCount++;
          else evidence.approvalInvalidCount++;
        }
        const successful = !allowlistViolation
          && result?.ok !== false
          && !result?.error
          && result?.blocked !== true
          && (name === 'exec_command' || name === 'bash'
            ? result?.exitCode === 0
            : name === 'file_change' || hadStart);
        if (successful) evidence.successfulCount++;
        else evidence.failedCount++;
      }
    };
    try {
      const session = worker.initSession({ title: task.title, workspaceDir: this.workspaceDir });
      task.sessionId = session.sessionId;
      const manager = await import('../features/admin-manager/v1.mjs');
      const response = await worker.executeTurn(taskPrompt, {
        ...callbacks,
        executorMode: true,
        ...(this.dispatcherApprovalHandler
          ? { requestToolApproval: request => this.dispatcherApprovalHandler(task, request) }
          : {}),
        allowedTools: task.allowedTools,
        executorSystemMessage: manager.buildExecutorSystemMessage({ taskTitle: task.title, workspaceDir: this.workspaceDir })
      });
      worker.sessions.appendItem(session.sessionId, { type: 'session_metadata', metadata: { executionEvidence: evidence } });
      if (typeof response?.content !== 'string' || !response.content.trim()) {
        return { status: 'blocked', reason: 'AgentEngine이 빈 응답을 반환했습니다.', sessionId: session.sessionId, result: response?.content || '', executionEvidence: evidence };
      }
      if (task.requireToolExecution !== false
        && (evidence.successfulCount < 1 || evidence.failedCount > 0 || evidence.successfulCount !== evidence.attemptedCount)) {
        const reason = evidence.allowedToolViolationCount > 0
          ? '작업 허용 목록 밖의 제공자 도구 이벤트가 감지되어 완료를 차단했습니다. 네이티브 CLI에서는 이벤트가 실행 뒤 전달될 수 있어 실제 부작용 여부를 별도 확인해야 합니다.'
          : evidence.approvalUnavailableCount > 0
          ? '작업 대기열에 도구 승인 UI가 연결되지 않아 실행을 보류했습니다. Only Chat 대화에서 직접 요청해 승인 화면을 확인해 주세요.'
          : evidence.approvalExpiredCount > 0
            ? '도구 승인 대기 시간이 만료되어 작업을 차단했습니다. 도구는 실행하지 않았습니다.'
          : evidence.approvalInvalidCount > 0
            ? '승인 요청이 만료되었거나 작업/세션이 바뀌어 실행을 차단했습니다. 도구는 실행하지 않았습니다.'
          : evidence.approvalDeniedCount > 0
            ? '사용자가 도구 실행을 거절해 작업을 차단했습니다.'
          : '실패한 Codex 도구 실행이 남아 있거나 성공 증거가 부족합니다.';
        return { status: 'blocked', reason, result: response.content, sessionId: session.sessionId, executionEvidence: evidence };
      }
      return { status: 'completed', result: response.content, sessionId: session.sessionId, executionEvidence: evidence };
    } catch (error) {
      const message = error?.message || String(error);
      const blocked = /작업공간은 다른 Only Chat 작업이 사용 중|승인|차단/.test(message);
      const sessionId = worker.currentSession?.sessionId || null;
      if (sessionId) {
        try { worker.sessions.appendItem(sessionId, { type: 'session_metadata', metadata: { executionEvidence: evidence } }); } catch (_) {}
      }
      return blocked
        ? { status: 'blocked', reason: message, result: '', sessionId, executionEvidence: evidence }
        : { status: 'failed', error: message, result: '', sessionId, executionEvidence: evidence };
    } finally {
      worker.dispatcher.stop();
      worker.skills.stopWatching();
    }
  }

  async _executeTurn(userPrompt, callbacks = {}) {
    if (!this.currentSession) {
      this.initSession();
    }

    const managerMode = callbacks.managerMode === true;
    const managerSystemMessage = callbacks.managerSystemMessage;
    const executorMode = callbacks.executorMode === true;
    const executorSystemMessage = callbacks.executorSystemMessage;
    const allowedTools = Array.isArray(callbacks.allowedTools) ? new Set(callbacks.allowedTools) : null;
    const reasoningEffort = parseReasoningEffort(callbacks.reasoningEffort);
    if (!reasoningEffort) throw new Error('Unsupported reasoning effort.');
    const preferredModel = typeof callbacks.modelSelection === 'string' && callbacks.modelSelection !== 'auto'
      ? callbacks.modelSelection
      : null;
    if (managerMode && (!managerSystemMessage || managerSystemMessage.role !== 'system' || typeof managerSystemMessage.content !== 'string')) {
      throw new Error('Manager mode requires a system message built from the live capability registry.');
    }
    if (executorMode && (!executorSystemMessage || executorSystemMessage.role !== 'system' || typeof executorSystemMessage.content !== 'string')) {
      throw new Error('Executor mode requires a scoped system message.');
    }

    const {
      onTierResolved,
      onReasoningDelta,
      onMessageDelta,
      onToolStart,
      onToolOutput,
      onToolEnd,
      onTurnComplete
    } = callbacks;

    // 1. Dynamic Live Skill & Shortcut Resolution (No new chat required!)
    const { text: resolvedPrompt, injectedSkills } = this.skills.resolvePromptShortcuts(userPrompt);
    if (injectedSkills.length > 0 && onReasoningDelta) {
      onReasoningDelta(`[SkillManager] 실시간 핫리로드 스킬 주입: ${injectedSkills.map(s => '$' + s).join(', ')}`);
    }

    // 2. Save durable checkpoint for restart/resume & Windows sync
    this.handoff.saveCheckpoint({
      sessionId: this.currentSession.sessionId,
      lastPrompt: userPrompt,
      workspaceDir: this.workspaceDir,
      injectedSkills
    });

    // Record user prompt
    this.conversationHistory.push({ role: 'user', content: resolvedPrompt });
    this.sessions.appendItem(this.currentSession.sessionId, {
      type: 'user_message',
      content: userPrompt,
      resolvedContent: resolvedPrompt,
      injectedSkills,
      reasoningEffort
    });

    let turnSuccess = false;
    let attempts = 0;
    let lastProviderFailure = null;
    const maxAttempts = this.priorityChain.chain.tiers.length;

    while (!turnSuccess && attempts < maxAttempts) {
      const activeTier = this.priorityChain.resolveActiveTier(null, preferredModel,
        executorMode && Array.isArray(this.dispatcherAllowedProviderIds)
          ? { allowedProviderIds: this.dispatcherAllowedProviderIds }
          : undefined);
      if (!activeTier) break;
      attempts++;
      if (onTierResolved) onTierResolved(activeTier);

      try {
        // Run inference against active tier
        const inferenceHistory = managerMode
          ? [managerSystemMessage, ...this.conversationHistory]
          : executorMode
            ? [executorSystemMessage, ...this.conversationHistory]
          : this.conversationHistory;
        let response = await this._callProviderWithFallback(activeTier, inferenceHistory, {
          onReasoningDelta,
          onMessageDelta: managerMode ? null : onMessageDelta,
          onToolStart,
          onToolOutput,
          onToolEnd
        }, {
          reasoningEffort,
          approvalPolicy: this.tools.approvalPolicy,
          requestWorkspaceWriteApproval: request => this._requestToolApproval({
            name: 'codex_cli_workspace_write_scope',
            args: { directory: request.directory, reason: request.reason }
          }, callbacks)
        });
        const hasToolCalls = Array.isArray(response?.toolCalls) && response.toolCalls.length > 0;
        if (!hasToolCalls && (typeof response?.content !== 'string' || !response.content.trim())) {
          throw new Error('Provider returned no content or tool calls.');
        }
        this.priorityChain.reportTierSuccess(activeTier.id);

        // Manager requests never enter the application's tool execution loop. A
        // validated executor plan is the sole structured delegation handoff.
        let managerToolCallBlocked = false;
        let managerDelegation = null;
        if ((response.toolCalls && response.toolCalls.length > 0)
          || (managerMode && String(response.content || '').trim().startsWith('{'))) {
          if (managerMode) {
            const content = String(response.content || '').trim();
            const planCandidate = content.startsWith('{') ? content : '';
            if (planCandidate) {
              try {
                const manager = await import('../features/admin-manager/v1.mjs');
                const plan = manager.parseExecutorPlan(planCandidate, {
                  hasAvailableExecutor: () => !this.isolated && this.priorityChain.getStatus().tiers.some(tier =>
                    tier.enabled !== false && tier.provider !== 'demo' && tier.provider !== 'unconfigured'
                    && Boolean(tier.model && tier.model !== 'unconfigured') && this.priorityChain.isTierReady(tier))
                });
                const tasks = this.dispatcher.enqueueTasks(plan.tasks.map((task, index) => ({
                  id: `manager_${this.currentSession.sessionId}_${Date.now()}_${index + 1}`,
                  ...task,
                  requireToolExecution: true
                })));
                managerDelegation = { summary: plan.summary, tasks };
                response = { content: `관리자: ${plan.summary}\n실행자: ${tasks.length}개 작업을 별도 세션으로 접수했습니다. 상태와 결과는 작업 대기열에서 확인할 수 있습니다.`, toolCalls: [] };
                callbacks.onManagerDelegation?.({ summary: plan.summary, tasks: tasks.map(task => ({ id: task.id, title: task.title, status: task.status })) });
              } catch (error) {
                managerToolCallBlocked = true;
                response = { content: `${error.message || '관리자 작업 계획을 검증할 수 없습니다.'} 도구를 직접 실행하지 않았습니다.`, toolCalls: [] };
              }
            } else {
              managerToolCallBlocked = true;
              response = {
                content: '관리자 모드는 작업을 직접 실행하지 않습니다. 실행자에게 맡기려면 허용된 JSON 작업 계획을 작성해 주세요.',
                toolCalls: []
              };
            }
            if (onMessageDelta) onMessageDelta(response.content);
          } else {
            if (response.protocol === 'openai-compatible') {
              this.conversationHistory.push({
                role: 'assistant',
                content: response.content || null,
                tool_calls: response.toolCalls.map(call => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args || {}) }
                }))
              });
            }
            for (const call of response.toolCalls) {
              if (allowedTools && !allowedTools.has(call?.name)) {
                const blocked = { error: 'Tool call is not allowed by this queued task.', blocked: true };
                if (onToolStart) onToolStart(call);
                if (onToolEnd) onToolEnd({ call, result: blocked });
                this.conversationHistory.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(blocked) });
                this.sessions.appendItem(this.currentSession.sessionId, { type: 'tool_result', tool: call.name, result: blocked });
                continue;
              }
              if (this.tools.approvalPolicy === 'read-only' && isMutationToolName(call?.name) && !this.tools.isNotionMcpReadOnlyCall(call)) {
                const blocked = { error: `Tool call '${call.name}' is blocked under read-only policy.`, blocked: true };
                if (onToolEnd) onToolEnd({ call, result: blocked });
                this.conversationHistory.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(blocked) });
                this.sessions.appendItem(this.currentSession.sessionId, { type: 'tool_result', tool: call.name, result: blocked });
                continue;
              }
              if (this._requiresToolApproval(call)) {
                try {
                  await this._requestToolApproval(call, callbacks);
                } catch (approvalError) {
                  const blocked = { error: approvalError.message, blocked: true };
                  if (onToolEnd) onToolEnd({ call, result: blocked });
                  this.conversationHistory.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(blocked) });
                  this.sessions.appendItem(this.currentSession.sessionId, { type: 'tool_result', tool: call.name, result: blocked });
                  continue;
                }
              }
              if (onToolStart) onToolStart(call);

              let toolResult;
              try {
                toolResult = await this._executeToolCall(call, onToolOutput);
              } catch (toolErr) {
                toolResult = { error: toolErr.message };
              }

              if (onToolEnd) onToolEnd({ call, result: toolResult });

              // Append tool execution to history and session
              this.conversationHistory.push({
                role: 'tool',
                tool_call_id: call.id,
                content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)
              });
              this.sessions.appendItem(this.currentSession.sessionId, {
                type: 'tool_result',
                tool: call.name,
                result: toolResult
              });
            }

            // Follow-up recursive loop if more actions are required
            return this.executeTurn('', callbacks);
          }
        }

        // Complete turn
        if (managerMode && onMessageDelta && !managerToolCallBlocked && !managerDelegation) onMessageDelta(response.content);
        this.conversationHistory.push({ role: 'assistant', content: response.content });
        this.sessions.appendItem(this.currentSession.sessionId, {
          type: 'assistant_message',
          content: response.content
        });

        if (managerDelegation) {
          this.sessions.appendItem(this.currentSession.sessionId, {
            type: 'manager_delegation',
            summary: managerDelegation.summary,
            tasks: managerDelegation.tasks.map(task => ({ id: task.id, title: task.title, status: task.status }))
          });
        }

        if (onTurnComplete) onTurnComplete({ tier: activeTier, response });
        turnSuccess = true;
        return response;

      } catch (err) {
        const category = providerFailureCategory(err);
        const model = safeProviderModel(activeTier.model);
        console.warn(`[AgentEngine] Turn attempt failed: category=${category} model=${model || 'unknown'} tier=${safeProviderTier(activeTier)}`);
        const rank = Number.isFinite(activeTier.tier) ? activeTier.tier : null;
        lastProviderFailure = { category, model, rank };
        if (category === 'approval_required' || category === 'approval_denied') break;
        this.priorityChain.reportTierFailure(activeTier.id, err);
        // Continue loop to try next fallback tier
      }
    }

    if (!turnSuccess) {
      if (preferredModel && attempts === 0) {
        const failure = new Error('The selected model is not available on the active priority route.');
        failure.category = 'model_unavailable';
        failure.model = safeProviderModel(preferredModel);
        throw failure;
      }
      if (!this.priorityChain.chain.enabled) {
        throw new Error('수동 선택 계정을 사용할 수 없습니다. 해당 계정의 로그인과 한도를 확인하거나 자동 우선순위를 켜 주세요.');
      }
      const failure = new Error('All eligible provider tiers failed.');
      failure.category = lastProviderFailure?.category || 'provider_failure';
      if (lastProviderFailure?.model) failure.model = lastProviderFailure.model;
      if (Number.isFinite(lastProviderFailure?.rank)) failure.rank = lastProviderFailure.rank;
      throw failure;
    }
  }

  async _executeToolCall(call, onOutput) {
    const { name, args } = call;
    if (this.tools.approvalPolicy === 'read-only' && isMutationToolName(name) && !this.tools.isNotionMcpReadOnlyCall(call)) {
      throw new Error(`Tool call '${name}' is blocked under read-only policy.`);
    }
    const targetFile = args.path || args.file_path;

    // File Ownership Lock guard to prevent concurrent file corruption
    if (targetFile && (name === 'write_file' || name === 'edit_file')) {
      const lockRes = this.ownership.acquireLocks(this.currentSession?.sessionId || 'default', [targetFile]);
      if (!lockRes.acquired) {
        throw new Error(lockRes.reason);
      }
    }

    try {
      switch (name) {
        case 'exec_command':
        case 'bash':
          return await this.tools.execCommand(args.command || args.cmd, onOutput, {
            cwd: args.cwd,
            storagePeakGiB: args.storagePeakGiB,
            storageTask: `onlychat-${this.currentSession?.sessionId || 'command'}`
          });
        case 'read_file':
          return await this.tools.readFile(args.path || args.file_path, args.start_line, args.end_line);
        case 'write_file':
          return await this.tools.writeFile(args.path || args.file_path, args.content);
        case 'edit_file':
          return await this.tools.editFile(args.path || args.file_path, args.target, args.replacement);
        case 'apply_patch':
          return await this.tools.applyPatch(args.patch);

        // Google Workspace Tools (Drive & Gmail)
        case 'google_drive_list':
          return await this.tools.googleDriveList(args);
        case 'google_drive_read':
          return await this.tools.googleDriveRead(args.fileId);
        case 'google_drive_create':
          return await this.tools.googleDriveCreate(args.name, args.mimeType, args.content, args.parentId);
        case 'google_drive_update':
          return await this.tools.googleDriveUpdate(args.fileId, args.content, args.mimeType);
        case 'gmail_list':
          return await this.tools.gmailList(args);
        case 'gmail_read':
          return await this.tools.gmailRead(args.messageId);
        case 'gmail_send':
          return await this.tools.gmailSend(args.to, args.subject, args.body || args.bodyText);

        // Notion Database & Page Tools
        case 'notion_search':
          return await this.tools.notionSearch(args.query, args.filterKind);
        case 'notion_query':
          return await this.tools.notionQueryDatabase(args.databaseId, args.filter, args.sorts);
        case 'notion_create_page':
          return await this.tools.notionCreatePage(args.databaseId, args.title, args.properties, args.children);
        case 'notion_update_page':
          return await this.tools.notionUpdatePage(args.pageId, args.properties);
        case 'notion_append_blocks':
          return await this.tools.notionAppendBlocks(args.blockId, args.blocks);
        case 'notion_api_read':
          return await this.tools.notionApiRead(args.method, args.path, args.query, args.body);
        case 'notion_api_write':
          return await this.tools.notionApiWrite(args.method, args.path, args.body);
        case 'notion_mcp_list_tools':
          return await this.tools.notionMcpTools();
        case 'notion_mcp_call_tool':
          return await this.tools.notionMcpCallTool(args.tool_name, args.arguments || {});
        case 'notion_rea_open':
          return await this.tools.notionReaOpen(args.url);
        case 'notion_rea_navigate':
          return await this.tools.notionReaNavigate(args.url);
        case 'notion_rea_read':
          return await this.tools.notionReaRead();
        case 'notion_rea_search':
          return await this.tools.notionReaSearch(args.query);
        case 'notion_rea_aria':
          return await this.tools.notionReaAria();
        case 'notion_rea_act':
          return await this.tools.notionReaAct(args);
        case 'notion_rea_status':
          return await this.tools.notionReaStatus();

        // Space Keeper's task-keyed, read-only storage report.
        case 'spacekeeper_session_report':
          return await this.tools.spaceKeeperSessionReport(args.taskKey);
        case 'spacekeeper_capacity_status':
          return await this.tools.spaceKeeperCapacityStatus();
        case 'task_registry_list':
          return await this.tools.taskRegistryList(args);
        case 'task_registry_read':
          return await this.tools.taskRegistryRead(args.taskKey);
        case 'task_registry_create':
          return await this.tools.taskRegistryCreate({ ...args, idempotencyKey: args.idempotencyKey || call.id }, this.currentSession?.sessionId || 'unknown-session');
        case 'task_registry_claim':
          return await this.tools.taskRegistryClaim({ ...args, idempotencyKey: args.idempotencyKey || call.id }, this.currentSession?.sessionId || 'unknown-session');
        case 'task_registry_checkpoint':
          return await this.tools.taskRegistryCheckpoint({ ...args, idempotencyKey: args.idempotencyKey || call.id }, this.currentSession?.sessionId || 'unknown-session');
        case 'task_registry_messages':
          return await this.tools.taskRegistryMessages(args, this.currentSession?.sessionId || 'unknown-session');
        case 'task_registry_send':
          return await this.tools.taskRegistrySend({ ...args, idempotencyKey: args.idempotencyKey || call.id }, this.currentSession?.sessionId || 'unknown-session');
        case 'task_registry_ack':
          return await this.tools.taskRegistryAck({ ...args, idempotencyKey: args.idempotencyKey || call.id }, this.currentSession?.sessionId || 'unknown-session');

        // Built-in Aside / REA Browser Tools
        case 'browser_open':
          return await this.tools.browserOpen(args.url || 'https://google.com');
        case 'browser_navigate':
          return await this.tools.browserNavigate(args.url);
        case 'browser_aria':
          return await this.tools.browserAria(args.tabId);
        case 'browser_act':
          return await this.tools.browserAct(args.action);
        case 'browser_read':
          return await this.tools.browserRead();
        case 'browser_recipe':
          return await this.tools.browserRecipe(args.name || args.recipe, args.tabId);
        case 'browser_status':
          return await this.tools.browserStatus();

        // Passkey & Credential Vault Tool
        case 'vault_get_credential':
          return await this.tools.vaultRequestCredential(args.service || args.name);

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } finally {
      if (targetFile && (name === 'write_file' || name === 'edit_file')) {
        this.ownership.releaseLocks(this.currentSession?.sessionId || 'default');
      }
    }
  }

  /**
   * Autonomous provider dispatcher (Antigravity CLI / Google OAuth vs ChatGPT / Codex API)
   */
  async _callProviderWithFallback(tier, history, streamingHooks = {}, options = {}) {
    const reasoningEffort = parseReasoningEffort(options.reasoningEffort);
    if (!reasoningEffort) throw new Error('Unsupported reasoning effort.');
    if (tier?.provider === 'account-router') {
      if (this.isolated) throw new Error('AI Account Router is disabled in isolated mode.');
      const accountRouterAdapter = await this._getAccountRouterAdapter();
      return accountRouterAdapter.call(tier, history, streamingHooks, {
        sessionId: this.currentSession?.sessionId,
        workspaceDir: this.workspaceDir,
        reasoningEffort,
        approvalPolicy: this.tools.approvalPolicy
      });
    }
    if (this.isolated) {
      if (!this.providerAdapter) throw new Error('Provider calls require an injected synthetic adapter in isolated mode.');
      return this.providerAdapter(tier, history, streamingHooks, { reasoningEffort });
    }
    if (!this.providerAdapter) {
      throw new Error(`No live provider adapter is configured for '${tier.provider || tier.id}'. Refusing to return a simulated answer.`);
    }
    return this.providerAdapter(tier, history, streamingHooks, {
      sessionId: this.currentSession?.sessionId,
      workspaceDir: this.workspaceDir,
      reasoningEffort,
      approvalPolicy: options.approvalPolicy,
      requestWorkspaceWriteApproval: options.requestWorkspaceWriteApproval
    });
  }

  verifyMetamorphicProviderReload(context) {
    return this.accountRouterModuleSlot.verifyReload(context);
  }

  getMetamorphicProviderStatus() {
    return this.accountRouterModuleSlot.status();
  }
}

module.exports = { AgentEngine, providerFailureCategory };
