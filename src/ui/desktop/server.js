/**
 * @project My-Codex
 * @provenance:rogan-core
 * @author Rogan Kim (GeunHu Kim) & AI Architect
 * @license MIT
 * @description Zero-dependency HTTP & SSE Server powering the My-Codex Mac App UI.
 */
'use strict';
const { manageRouterAccount } = require('./accountManagement.js');

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const packageMetadata = require('../../../package.json');
const { pathToFileURL } = require('node:url');
const { AgentEngine } = require('../../core/AgentEngine.js');
const { MetamorphicHub } = require('../../morph/Hub.js');
const { InstalledAppCatalog } = require('../../morph/ReaAppBridge.js');
const { NativeSessionBridge } = require('../../core/NativeSessionBridge.js');
const { ThreefBrowserBridge } = require('../../browser/ThreefBrowserBridge.js');
const { EmbeddedThreefBrowserBridge } = require('../../browser/EmbeddedThreefBrowserBridge.js');
const { TOOLS: EMBEDDED_THREEF_MCP_TOOLS, handleEmbeddedThreefMcpMessage } = require('../../features/provider/embeddedThreefMcp.js');
const { ThreefBrowserControlSettings } = require('../../browser/ThreefBrowserControlSettings.js');
const { MacScreenControlSettings } = require('../../browser/MacScreenControlSettings.js');
const { FocusFencePolicy } = require('../../browser/FocusFencePolicy.js');
const { NotionReaBrowser } = require('../../browser/NotionReaBrowser.js');
const { AntigravityCliAdapter } = require('../../providers/AntigravityCliAdapter.js');
const { CodexCliAdapter } = require('../../providers/CodexCliAdapter.js');
const { parseReasoningEffort } = require('../../core/ReasoningEffort.js');
const { ModelSwitchScheduleStore } = require('../../core/ModelSwitchScheduleStore.js');
const { EvolutionInbox } = require('../../sync/EvolutionInbox.js');
const { RecurringScheduleStore } = require('../../scheduler/RecurringScheduleStore.js');
const { RecurringScheduleService } = require('../../scheduler/RecurringScheduleService.js');
const { TaskRegistryStore } = require('../../core/TaskRegistryStore.js');
const { TaskMailboxDriveAdapter } = require('../../core/TaskMailboxDriveAdapter.js');
const { MacWindowsDevelopment } = require('../../core/MacWindowsDevelopment.js');
const { ForAiFeedbackInbox } = require('../../connectors/ForAiFeedbackInbox.js');
const { recoverInterruptedTurn } = require('../../core/RestartRecovery.js');

const QUOTA_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const SESSION_SEARCH_TIMEOUT_MS = 20000;
const APPROVAL_POLICIES = new Set(['on-request', 'never', 'read-only']);

function readApprovalPolicy(filePath) {
  try {
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return saved?.version === 1 && APPROVAL_POLICIES.has(saved.policy) ? saved.policy : null;
  } catch (_) {
    return null;
  }
}

function writeApprovalPolicy(filePath, policy) {
  if (!APPROVAL_POLICIES.has(policy)) throw new Error('지원하지 않는 도구 승인 정책입니다.');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify({ version: 1, policy }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tempPath, filePath);
  } finally {
    try { fs.unlinkSync(tempPath); } catch (_) {}
  }
}

class DesktopServer {
  constructor(options = {}) {
    this.port = Number.isInteger(options.port) ? options.port : Number(process.env.PORT) || 8899;
    this.staticDir = path.join(__dirname);
    this.projectRoot = path.resolve(__dirname, '../../..');
    this.isolated = options.isolated === true;
    this.openExternal = this.isolated ? null : typeof options.openExternal === 'function'
      ? options.openExternal
      : process.platform === 'darwin' ? createMacThreefOpener() : null;
    const profileDir = options.dataDir || options.profileDir || process.env.ONLY_CHAT_ISOLATED_PROFILE;
    if (this.isolated && !profileDir) throw new Error('Isolated runtime requires an explicit temporary profile directory.');
    this.dataDir = path.resolve(profileDir || path.join(os.homedir(), '.my-codex'));
    if (this.isolated) {
      const tempRoot = path.resolve(os.tmpdir());
      const relative = path.relative(tempRoot, this.dataDir);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Isolated profile must be a dedicated directory inside the system temporary folder.');
      let ancestor = this.dataDir;
      while (!fs.existsSync(ancestor) && ancestor !== path.dirname(ancestor)) ancestor = path.dirname(ancestor);
      const realAncestorRelative = path.relative(fs.realpathSync(tempRoot), fs.realpathSync(ancestor));
      if (realAncestorRelative === '..' || realAncestorRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realAncestorRelative)) throw new Error('Isolated profile resolves outside the system temporary folder.');
      fs.mkdirSync(this.dataDir, { recursive: true });
      const realRelative = path.relative(fs.realpathSync(tempRoot), fs.realpathSync(this.dataDir));
      if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error('Isolated profile resolves outside the system temporary folder.');
    }
    const requestedWorkspaceDir = options.workspaceDir;
    const legacyChatWorkspaceDir = path.join(os.homedir(), 'Documents', 'Only Chat');
    const defaultWorkspaceDir = !this.isolated && requestedWorkspaceDir
      && path.resolve(requestedWorkspaceDir) === legacyChatWorkspaceDir
      ? os.homedir()
      : requestedWorkspaceDir || (this.isolated ? path.join(this.dataDir, 'workspace') : os.homedir());
    this.workspaceDir = path.resolve(defaultWorkspaceDir);
    if (this.isolated) {
      const relative = path.relative(this.dataDir, this.workspaceDir);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Isolated workspace must stay inside the temporary profile.');
      fs.mkdirSync(this.workspaceDir, { recursive: true });
    }
    this.threefControlSettings = options.threefControlSettings || new ThreefBrowserControlSettings(path.join(this.dataDir, 'threef-browser-control.json'));
    this.macScreenControlSettings = options.macScreenControlSettings || new MacScreenControlSettings(path.join(this.dataDir, 'mac-screen-control.json'));
    this.macScreenNativeBridgeAvailable = options.macScreenNativeBridgeAvailable ?? process.env.ONLY_CHAT_NATIVE_MAC_SCREEN_CONTROL === '1';
    this.macScreenToken = crypto.randomBytes(32).toString('hex');
    this.macScreenCommands = [];
    this.macScreenCommandWaiters = [];
    this.macScreenCommandSequence = 0;
    this.macScreenPanelWaiter = null;
    this.macScreenLastCaptureAt = 0;
    this.approvalPolicyFile = path.join(this.dataDir, 'approval-policy.json');
    this.approvalPolicy = APPROVAL_POLICIES.has(options.approvalPolicy)
      ? options.approvalPolicy
      : readApprovalPolicy(this.approvalPolicyFile) || 'never';
    const engineOptions = { ...options, approvalPolicy: this.approvalPolicy };
    delete engineOptions.openExternal;
    this.focusFencePolicy = new FocusFencePolicy();
    // Keep free-plan Notion's Aside/REA session separate from the general 3F browser.
    engineOptions.notionReaBrowser = this.isolated ? null : new NotionReaBrowser({ policy: this.focusFencePolicy });
    this.threefBridge = options.threefBridge || new ThreefBrowserBridge({ openExternal: this.openExternal, policy: this.focusFencePolicy, isEnabled: () => this.isThreefControlEnabled() });
    this.antigravityAdapter = !this.isolated && process.platform === 'darwin'
      ? new AntigravityCliAdapter({ dataDir: this.dataDir }) : null;
    this.codexAdapter = !this.isolated && process.platform === 'darwin'
      ? new CodexCliAdapter({ dataDir: this.dataDir }) : null;
    if (!engineOptions.providerAdapter && !this.isolated && process.platform === 'darwin') {
      const antigravity = this.antigravityAdapter;
      const codex = this.codexAdapter;
      let ollamaAdapterPromise = null;
      engineOptions.providerAdapter = async (tier, history, hooks, context) => {
        if (tier.provider === 'antigravity-cli') return antigravity.call(tier, history, hooks, context);
        if (tier.provider === 'ollama') {
          ollamaAdapterPromise ||= import('../../features/provider/v1.mjs')
            .then(({ createOllamaAdapter }) => createOllamaAdapter());
          return (await ollamaAdapterPromise).call(tier, history, hooks, context);
        }
        if (tier.provider === 'codex') return codex.call(tier, history, hooks, context).then(result => {
          codex.clearAuthenticationFailure(tier);
          return result;
        }, error => {
          if (error?.category === 'authentication' || /unauthorized|not logged in|not authenticated|authentication required|login required|logged out|session expired|access token expired|\b401\b|invalid credential|로그인이 필요|인증이 만료|다시 로그인/i.test(String(error?.message || ''))) {
            error.category = 'authentication';
            codex.markAuthenticationFailure(tier, error.message);
          }
          throw error;
        });
        throw new Error(`No local provider adapter is configured for '${tier.provider}'.`);
      };
    }
    const configuredTierReadiness = engineOptions.isTierReady;
    engineOptions.isTierReady = tier => (configuredTierReadiness ? configuredTierReadiness(tier) : true)
      && (tier.provider !== 'codex' || Boolean(this.codexAdapter?.getReadiness(tier).connected));
    this.browserCommands = [];
    this.browserCommandWaiters = [];
    this.browserCommandSequence = 0;
    this.embeddedThreefMcpSessions = new Map();
    // AI browser tools always target the standalone 3F Browser control API.
    // The embedded panel transport remains separate and must not masquerade as 3F app control.
    engineOptions.browser = this.isolated ? null : this.threefBridge;
    if (!this.isolated && process.platform === 'darwin') {
      this.embeddedBrowserPanel = new EmbeddedThreefBrowserBridge({
        policy: this.focusFencePolicy,
        dispatch: command => this._dispatchEmbeddedBrowserCommand(command)
      });
    }
    Object.assign(engineOptions, {
      isolated: this.isolated,
      dataDir: this.dataDir,
      workspaceDir: this.workspaceDir,
      browser: this.isolated ? null : engineOptions.browser,
      embeddedBrowserPanel: this.isolated ? null : this.embeddedBrowserPanel
    });
    this.macWindowsDevelopment = this.isolated ? null : new MacWindowsDevelopment({ dataDir: this.dataDir });
    engineOptions.macWindowsDevelopment = this.macWindowsDevelopment;
    this.engine = new AgentEngine(engineOptions);
    this.turnEngineOptions = { ...engineOptions, dispatcherAutoStart: false, watchSkills: false };
    this.forAiInbox = this.isolated ? null : new ForAiFeedbackInbox({ dataDir: this.dataDir, dispatcher: this.engine.dispatcher });
    this.engine.forAiTaskGuard = task => this.forAiInbox?.isTaskAuthorized(task) === true;
    this.taskRegistryStore = this.isolated ? null : new TaskRegistryStore({ dataDir: this.dataDir });
    this.taskMailboxConfigFile = path.join(this.dataDir, 'task-mailbox.json');
    this.scheduleStore = options.scheduleStore || new RecurringScheduleStore({ dataDir: this.dataDir });
    this.modelSwitchScheduleStore = options.modelSwitchScheduleStore || new ModelSwitchScheduleStore({ dataDir: this.dataDir, clock: options.modelSwitchClock });
    this.scheduleService = options.scheduleService || new RecurringScheduleService({
      store: this.scheduleStore,
      dispatcher: this.engine.dispatcher,
      clock: options.scheduleClock
    });
    this.schedulesEnabled = options.enableSchedules ?? !this.isolated;
    if (this.codexAdapter) this.codexAdapter.googleTokenFile = this.engine.tools.google.tokenFile;
    if (this.codexAdapter) this.codexAdapter.macScreenBridge = () => ({ enabled: this.isMacScreenControlEnabled(), port: this.port, token: this.macScreenToken });
    this.activeTurns = 0;
    this.turnRequestTail = Promise.resolve();
    this.activeTurnControllers = new Set();
    this.activeTurnEngines = new Map();
    this.sessionTurnTails = new Map();
    this.restartRequested = false;
    this.requestServerRestart = options.requestServerRestart || (() => {
      setTimeout(() => {
        const httpServer = this.server;
        this.stop();
        httpServer?.closeAllConnections?.();
        process.exitCode = 75;
      }, 100).unref();
    });
    this.pendingToolApprovals = new Map();
    this.sessionToolApprovals = new Map();
    this.newChatSessionAliases = new Map();
    this.pendingDispatcherToolApprovals = new Map();
    this.engine.dispatcherApprovalHandler = (task, request) => this._requestDispatcherToolApproval(task, request);
    this.engine.dispatcher.canStartTask = () => this.activeTurns === 0;
    this.dispatchedTurns = new Set();
    const startDispatchedTurn = ({ task }) => {
      if (this.dispatchedTurns.has(task.id)) return;
      this.dispatchedTurns.add(task.id);
      this.activeTurns += 1;
    };
    this.engine.dispatcher.on('worker_started', startDispatchedTurn);
    this.engine.dispatcher.on('worker_resumed', startDispatchedTurn);
    const finishDispatchedTurn = ({ task }) => {
      if (this.dispatchedTurns.delete(task.id)) this._decrementActiveTurns();
      void this.engine.dispatcher.tick();
    };
    this.engine.dispatcher.on('worker_completed', finishDispatchedTurn);
    this.engine.dispatcher.on('worker_blocked', finishDispatchedTurn);
    this.engine.dispatcher.on('worker_failed', finishDispatchedTurn);
    this.engine.dispatcher.on('worker_waiting', finishDispatchedTurn);
    this.hub = new MetamorphicHub({
      workspaceDir: this.engine.workspaceDir,
      dataDir: this.dataDir,
      desktopUiDir: this.staticDir,
      watchEnabled: !this.isolated,
      canMutate: () => this.activeTurns === 0
    });
    this.localApps = new InstalledAppCatalog(this.isolated ? { searchDirs: [] } : {});
    this.nativeSessions = this.isolated
      ? new NativeSessionBridge({ codexStateDb: path.join(this.dataDir, 'disabled-codex.sqlite'), antigravityBrainDir: path.join(this.dataDir, 'disabled-antigravity') })
      : new NativeSessionBridge();
    this.syncEnabled = false;
    this.evolutionInbox = this.isolated ? null : new EvolutionInbox({
      canonicalRoot: this.projectRoot,
      dataDir: this.dataDir,
      getBlockers: () => this.activeTurns > 0 ? ['active_turn'] : [],
      verifyReload: context => {
        const files = context?.files || [];
        if (!files.some(file => file.path === 'src/features/provider/v1.mjs')) return { state: 'source-applied' };
        if (typeof this.engine.verifyMetamorphicProviderReload !== 'function') throw new Error('account_router_runtime_verifier_unavailable');
        return this.engine.verifyMetamorphicProviderReload(context);
      }
    });
    this.evolutionInbox?.startConfigured();
    this.evolutionInboxClients = new Set();
    this._bindEvolutionInbox();
    this.server = null;
    this.quotaRefreshIntervalMs = options.quotaRefreshIntervalMs || QUOTA_REFRESH_INTERVAL_MS;
    this.quotaRefreshReader = options.quotaRefreshReader || this.antigravityAdapter?.readQuota.bind(this.antigravityAdapter) || null;
    this.quotaRefreshEnabled = options.enableQuotaRefresh ?? (!this.isolated && process.platform === 'darwin');
    this.quotaRefreshTimer = null;
    this.quotaRefreshInFlight = null;
    this.sessionSearchTimeoutMs = options.sessionSearchTimeoutMs ?? SESSION_SEARCH_TIMEOUT_MS;
    this.priorityEventClients = new Set();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handleRequest(req, res));
      this.server.listen(this.port, '127.0.0.1', () => {
        this.port = this.server.address().port;
        const url = `http://127.0.0.1:${this.port}`;
        this._startQuotaRefresh();
        if (this.schedulesEnabled) this.scheduleService.start();
        Promise.resolve().then(() => this.resumeInterruptedTurn()).catch(error => {
          console.error('[DesktopServer] Interrupted-turn recovery failed:', error);
        });
        resolve({ port: this.port, url });
      });
      this.server.on('error', err => reject(err));
    });
  }

  _acquireTurnRequestSlot() {
    const previous = this.turnRequestTail || Promise.resolve();
    let releaseNext;
    this.turnRequestTail = new Promise(resolve => { releaseNext = resolve; });
    return previous.then(() => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseNext();
      };
    });
  }

  _acquireSessionTurnSlot(sessionId) {
    if (!this.sessionTurnTails) this.sessionTurnTails = new Map();
    const key = String(sessionId || '');
    const previous = this.sessionTurnTails.get(key) || Promise.resolve();
    let releaseNext;
    const current = new Promise(resolve => { releaseNext = resolve; });
    this.sessionTurnTails.set(key, current);
    return previous.then(() => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (this.sessionTurnTails.get(key) === current) this.sessionTurnTails.delete(key);
        releaseNext();
      };
    });
  }

  _createTurnEngine(sessionId, toolProfile, fullAccess) {
    const session = this.engine.sessions.resumeSession(sessionId);
    if (!session || session.source !== 'internal') throw new Error('Only Chat 대화 세션을 다시 읽을 수 없습니다.');
    const workspaceDir = path.resolve(session.cwd || this.engine.defaultWorkspaceDir || this.engine.workspaceDir);
    const turnEngine = new AgentEngine({
      ...this.turnEngineOptions,
      accountRouterReadiness: this.engine.accountRouterReadiness,
      workspaceDir,
      handoffStorageDir: path.join(this.dataDir, 'turn-handoffs', String(sessionId))
    });
    turnEngine.sessions = this.engine.sessions;
    turnEngine.priorityChain.chain = structuredClone(this.engine.priorityChain.chain);
    turnEngine.loadInternalSession(session);
    // The file-read profile cannot mutate the workspace, so read-only sessions
    // can share provider time without taking the workspace-wide execution lease.
    if (toolProfile === 'file-read' && fullAccess !== true) {
      turnEngine.workspaceExecutionLease = {
        run: (_workspaceDir, _owner, execute) => execute()
      };
    }
    if (typeof this.engine._executeToolCall === 'function') {
      turnEngine._executeToolCall = this.engine._executeToolCall;
    }
    if (typeof this.engine.executeTurn === 'function' && this.engine.executeTurn !== AgentEngine.prototype.executeTurn) {
      turnEngine.executeTurn = this.engine.executeTurn;
    }
    return turnEngine;
  }

  _decrementActiveTurns() {
    this.activeTurns = Math.max(0, this.activeTurns - 1);
    if (this.activeTurns === 0) {
      try { this.hub?.flushPendingMutations?.(); } catch (_) {}
    }
  }

  async resumeInterruptedTurn() {
    if (this.isolated) return { status: 'not_idle' };
    const releaseTurnSlot = await this._acquireTurnRequestSlot();
    if (this.activeTurns > 0) {
      releaseTurnSlot();
      return { status: 'not_idle' };
    }
    this.activeTurns += 1;
    try { return await recoverInterruptedTurn(this.engine); }
    finally {
      this._decrementActiveTurns();
      void this.engine.dispatcher.tick();
      releaseTurnSlot();
    }
  }

  stop() {
    for (const engine of new Set([this.engine, ...(this.activeTurnEngines?.values() || [])])) {
      if (!engine) continue;
      try {
        const checkpoint = engine.handoff?.loadCheckpoint?.();
        if (checkpoint?.status === 'running') engine.handoff.updateCheckpoint(checkpoint.sessionId, {
          status: 'restart_pending', restartRequestedAt: Date.now()
        });
      } catch (_) {}
    }
    for (const controller of this.activeTurnControllers || []) {
      if (!controller.signal?.aborted) controller.abort(new Error('Only Chat 서버가 재시작됩니다.'));
    }
    this.scheduleService?.stop();
    if (this.quotaRefreshTimer) clearInterval(this.quotaRefreshTimer);
    this.quotaRefreshTimer = null;
    this.hub?.stopWatchers?.();
    this.engine?.skills?.stopWatching?.();
    this.engine?.dispatcher?.stop?.();
    for (const [requestId, pending] of this.pendingDispatcherToolApprovals) {
      clearTimeout(pending.timer);
      this.pendingDispatcherToolApprovals.delete(requestId);
      pending.resolve(false);
    }
    if (this.browserPanelWaiter) {
      clearTimeout(this.browserPanelWaiter.timeout);
      this.browserPanelWaiter.res.destroy();
      this.browserPanelWaiter = null;
    }
    for (const waiter of this.browserCommandWaiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error('Only Chat 서버가 종료되었습니다.'));
    }
    this.browserCommands = [];
    for (const client of this.priorityEventClients) client.end();
    this.priorityEventClients.clear();
    for (const client of this.evolutionInboxClients) client.end();
    this.evolutionInboxClients.clear();
    this.evolutionInbox?.stop();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (this.macScreenPanelWaiter) {
      clearTimeout(this.macScreenPanelWaiter.timeout);
      this.macScreenPanelWaiter.res.destroy();
      this.macScreenPanelWaiter = null;
    }
    for (const waiter of this.macScreenCommandWaiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.resolve({ error: 'Only Chat 서버가 종료되었습니다.' });
    }
    this.macScreenCommands = [];
  }

  _startQuotaRefresh() {
    if (!this.quotaRefreshEnabled || !this.quotaRefreshReader || this.quotaRefreshTimer) return;
    void this.refreshProviderQuotas();
    this.quotaRefreshTimer = setInterval(() => { void this.refreshProviderQuotas(); }, this.quotaRefreshIntervalMs);
    this.quotaRefreshTimer.unref?.();
  }

  _broadcastPriorityStatus() {
    const event = `data: ${JSON.stringify({ type: 'priority_status', status: this.getPriorityStatus() })}\n\n`;
    for (const client of this.priorityEventClients) {
      try { client.write(event); } catch (_) { this.priorityEventClients.delete(client); }
    }
  }

  _bindEvolutionInbox() {
    this.evolutionInbox?.relay?.on('pending_changed', () => this._broadcastEvolutionInbox());
  }

  _broadcastEvolutionInbox() {
    const event = `data: ${JSON.stringify({ type: 'windows_changes', status: this.evolutionInbox?.status() || { configured: false, pending: [] } })}\n\n`;
    for (const client of this.evolutionInboxClients) {
      try { client.write(event); } catch (_) { this.evolutionInboxClients.delete(client); }
    }
  }

  _getTaskMailboxAdapter() {
    if (!this.taskRegistryStore) return null;
    try {
      const config = JSON.parse(fs.readFileSync(this.taskMailboxConfigFile, 'utf8'));
      if (config?.schemaVersion !== 1) return null;
      return new TaskMailboxDriveAdapter({
        connector: this.engine.tools.google,
        store: this.taskRegistryStore,
        folderId: config.folderId,
        expectedAccountIdentityHash: config.expectedAccountIdentityHash,
        peerHostId: config.peerHostId
      });
    } catch (_) { return null; }
  }

  _saveTaskMailboxConfig(config) {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const tempPath = `${this.taskMailboxConfigFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify({ schemaVersion: 1, ...config }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(tempPath, this.taskMailboxConfigFile);
    } finally {
      try { fs.unlinkSync(tempPath); } catch (_) {}
    }
  }

  getPriorityStatus() {
    const status = this.engine.priorityChain.getStatus();
    status.tiers = status.tiers.map(tier => ({
      ...tier,
      providerReady: tier.provider === 'codex'
        ? this.codexAdapter?.getReadiness(tier) || { available: false, connected: false, message: 'Codex 연결 어댑터를 사용할 수 없습니다.' }
        : tier.provider === 'account-router'
          ? { ...(this.engine.accountRouterReadiness || { available: null, connected: false, verified: false, state: 'unverified', message: 'AI Account Router 실제 요청은 아직 확인되지 않았습니다.' }) }
          : { available: true, connected: true, message: '실행 경로 연결됨' }
    }));
    status.activeTier = status.tiers.find(tier => tier.id === status.activeTier?.id) || null;
    return status;
  }

  refreshProviderQuotas() {
    if (this.quotaRefreshInFlight) return this.quotaRefreshInFlight;
    this.quotaRefreshInFlight = (async () => {
      const tiers = this.engine.priorityChain.chain.tiers.filter(tier => tier.enabled && tier.provider === 'antigravity-cli');
      for (const tier of tiers) {
        this.engine.priorityChain.markQuotaRefreshAttempt(tier.id);
        try {
          const quota = await this.quotaRefreshReader(tier);
          if (!quota || !Number.isFinite(quota.remainingPercent)) {
            this.engine.priorityChain.markQuotaRefreshFailure(tier.id, 'no-usable-quota-data');
            continue;
          }
          this.engine.priorityChain.updateTierQuota(tier.id, quota.remainingPercent, {
            fiveHourRemainingPercent: quota.fiveHourRemainingPercent,
            nextResetAt: quota.nextResetAt
          });
        } catch (error) {
          this.engine.priorityChain.markQuotaRefreshFailure(tier.id, 'read-failed');
          console.warn(`[QuotaRefresh] ${tier.id}: ${error.message}`);
        }
      }
      this._broadcastPriorityStatus();
    })().finally(() => { this.quotaRefreshInFlight = null; });
    return this.quotaRefreshInFlight;
  }

  async _handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    if (this.isolated && (pathname.startsWith('/api/connectors/') || pathname.startsWith('/api/sync/') || pathname.startsWith('/api/task-registry/') || pathname.startsWith('/api/joint-development/'))) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'External providers, Drive sync, and shared task coordination are disabled in isolated mode.' }));
      return;
    }
    if (pathname.startsWith('/api/sync/') && !this.syncEnabled) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Legacy whole-workspace sync is retired. Use the allowlisted evolution protocol.' }));
      return;
    }

    if (this.isolated && pathname.startsWith('/api/evolution/')) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Isolated mode disables shared Windows change inbox.' }));
      return;
    }

    const allowedHosts = new Set([`127.0.0.1:${this.port}`, `localhost:${this.port}`]);
    const oauthCallback = ['/api/connectors/google/callback', '/api/connectors/notion/callback'].includes(pathname) && req.method === 'GET';
    const origin = req.headers.origin;
    const allowedOrigins = new Set([`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`]);
    if (!allowedHosts.has((req.headers.host || '').toLowerCase()) ||
        (origin && !allowedOrigins.has(origin) && !oauthCallback) ||
        (req.headers['sec-fetch-site'] === 'cross-site' && !oauthCallback)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Only Chat 로컬 요청만 허용됩니다.' }));
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/api/server/restart' && req.method === 'POST') {
      if (!origin || !allowedOrigins.has(origin) || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
        res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Only Chat 화면의 same-origin 요청만 서버 재시작을 요청할 수 있습니다.' }));
        return;
      }
      res.writeHead(202, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, status: this.restartRequested ? 'already_requested' : 'restart_pending' }));
      if (!this.restartRequested) {
        this.restartRequested = true;
        this.requestServerRestart();
      }
      return;
    }

    if (pathname === '/api/mcp/embedded-3f' && req.method === 'POST') {
      const authorization = String(req.headers.authorization || '');
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      const context = this.embeddedThreefMcpSessions?.get(token);
      const turnEngine = this.activeTurnEngines?.get(context?.sessionId)
        || (this.engine?.currentSession?.sessionId === context?.sessionId ? this.engine : null);
      if (!context || context.expiresAt < Date.now()
        || turnEngine?.currentSession?.sessionId !== context.sessionId) {
        return this._respondJson(res, { error: 'embedded_3f_mcp_session_expired' }, 401);
      }
      if (context.mcpSessionId && req.headers['mcp-session-id'] !== context.mcpSessionId) {
        return this._respondJson(res, { error: 'invalid_mcp_session' }, 404);
      }
      const message = await this._readLimitedBody(req, 1024 * 1024);
      if (!message || typeof message !== 'object' || Array.isArray(message)) return this._respondJson(res, { error: 'invalid_mcp_request' }, 400);
      if (message.method?.startsWith('notifications/')) {
        res.writeHead(202, { 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      const response = await handleEmbeddedThreefMcpMessage(this, context, message);
      if (!response) {
        res.writeHead(202, { 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
      if (message.method === 'initialize') {
        context.mcpSessionId = crypto.randomUUID();
        headers['Mcp-Session-Id'] = context.mcpSessionId;
        headers['Mcp-Protocol-Version'] = context.protocolVersion;
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify(response));
      return;
    }

    if (pathname === '/api/task-registry/mailbox' && req.method === 'GET') {
      let config = null;
      try { config = JSON.parse(fs.readFileSync(this.taskMailboxConfigFile, 'utf8')); } catch (_) {}
      const google = this.engine.tools.google;
      return this._respondJson(res, {
        configured: Boolean(config?.schemaVersion === 1 && config.folderId && config.peerHostId && config.expectedAccountIdentityHash),
        connected: typeof google?.isConnected === 'function' && google.isConnected(),
        localHostId: this.taskRegistryStore?.hostId || null,
        peerHostId: config?.peerHostId || null,
        folderId: config?.folderId || null
      });
    }

    if (pathname === '/api/task-registry/mailbox/config' && req.method === 'POST') {
      if (!this.taskRegistryStore) return this._respondJson(res, { error: 'task_registry_unavailable' }, 503);
      const body = await this._readLimitedBody(req, 4096);
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || typeof body.folderId !== 'string' || typeof body.peerHostId !== 'string'
        || !body.peerHostId.trim() || body.peerHostId.trim().length > 256
        || body.peerHostId.trim() === this.taskRegistryStore.hostId) {
        return this._respondJson(res, { error: 'task_mailbox_config_invalid' }, 400);
      }
      try {
        const google = this.engine.tools.google;
        const expectedAccountIdentityHash = await google.driveGetAccountIdentityHash();
        const folder = await google.driveVerifyMailboxFolder(body.folderId.trim());
        if (folder.folderId !== body.folderId.trim() || folder.canListChildren !== true || folder.canAddChildren !== true) {
          throw new Error('Google Drive mailbox folder is not verified for read and write');
        }
        const config = {
          folderId: folder.folderId,
          expectedAccountIdentityHash,
          peerHostId: body.peerHostId.trim()
        };
        new TaskMailboxDriveAdapter({ connector: google, store: this.taskRegistryStore, ...config });
        this._saveTaskMailboxConfig(config);
        return this._respondJson(res, { configured: true, folderId: config.folderId, peerHostId: config.peerHostId });
      } catch (error) { return this._respondJson(res, { error: error.message || 'task_mailbox_config_failed' }, 400); }
    }

    if (pathname === '/api/task-registry/mailbox/sync' && req.method === 'POST') {
      const adapter = this._getTaskMailboxAdapter();
      if (!adapter) return this._respondJson(res, { error: 'task_mailbox_not_configured' }, 409);
      try { return this._respondJson(res, { sync: await adapter.syncIncoming() }); }
      catch (error) { return this._respondJson(res, { error: error.message || 'task_mailbox_sync_failed' }, 502); }
    }

    const mailboxPublishMatch = /^\/api\/task-registry\/tasks\/([^/]+)\/mailbox-publish$/.exec(pathname);
    if (mailboxPublishMatch && req.method === 'POST') {
      if (!this.taskRegistryStore) return this._respondJson(res, { error: 'task_registry_unavailable' }, 503);
      const adapter = this._getTaskMailboxAdapter();
      if (!adapter) return this._respondJson(res, { error: 'task_mailbox_not_configured' }, 409);
      let taskKey;
      try { taskKey = decodeURIComponent(mailboxPublishMatch[1]); }
      catch (_) { return this._respondJson(res, { error: 'task_key_invalid' }, 400); }
      const body = await this._readLimitedBody(req, 4096);
      if (!body || typeof body.viewerChatId !== 'string' || !body.viewerChatId.trim()) {
        return this._respondJson(res, { error: 'task_mailbox_viewer_chat_required' }, 400);
      }
      try {
        const task = this.taskRegistryStore.getTask(taskKey);
        if (!task) return this._respondJson(res, { error: 'task_not_found' }, 404);
        const taskReceipt = (task.sourceHostId || this.taskRegistryStore.hostId) === this.taskRegistryStore.hostId
          ? await adapter.publishTask(taskKey)
          : { created: false, replayed: true, importedFromPeer: true };
        const messages = this.taskRegistryStore.listMessages({ taskKey, viewerChatId: body.viewerChatId.trim(),
          afterMessageId: body.afterMessageId || undefined, limit: body.limit === undefined ? 100 : body.limit });
        const messageReceipts = [];
        for (const message of messages) {
          if ((message.senderHostId || this.taskRegistryStore.hostId) !== this.taskRegistryStore.hostId
            || message.recipientHostId !== adapter.peerHostId) continue;
          messageReceipts.push({ messageId: message.messageId, ...(await adapter.publishMessage(message)) });
        }
        return this._respondJson(res, { task: taskReceipt, messages: messageReceipts, nextAfterMessageId: messages.at(-1)?.messageId || body.afterMessageId || null });
      } catch (error) { return this._respondJson(res, { error: error.message || 'task_mailbox_publish_failed' }, 502); }
    }

    if (pathname === '/api/task-registry/tasks' && req.method === 'GET') {
      if (!this.taskRegistryStore) return this._respondJson(res, { error: 'task_registry_unavailable' }, 503);
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? undefined : Number(rawLimit);
      try {
        return this._respondJson(res, { tasks: this.taskRegistryStore.listTasks({
          status: url.searchParams.get('status') || undefined,
          ownerChatId: url.searchParams.get('ownerChatId') || undefined,
          limit
        }) });
      } catch (error) { return this._respondJson(res, { error: error.message || 'task_registry_query_invalid' }, 400); }
    }

    if (pathname === '/api/joint-development/tasks' && req.method === 'GET') {
      if (!this.macWindowsDevelopment) return this._respondJson(res, { error: 'joint_development_unavailable' }, 503);
      return this._respondJson(res, { tasks: this.macWindowsDevelopment.list(url.searchParams.get('limit')), localPlatform: this.macWindowsDevelopment.localPlatform() });
    }

    if (pathname === '/api/joint-development/tasks' && req.method === 'POST') {
      if (!this.macWindowsDevelopment) return this._respondJson(res, { error: 'joint_development_unavailable' }, 503);
      const body = await this._readLimitedBody(req, 64 * 1024);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return this._respondJson(res, { error: 'joint_development_body_invalid' }, 400);
      try {
        const result = await this.macWindowsDevelopment.createAfterAssessment(body, 'joint-development-http-create');
        return this._respondJson(res, result, result.created ? 201 : 200);
      } catch (error) { return this._respondJson(res, { error: error.message || 'joint_development_contract_invalid' }, 400); }
    }

    if (pathname === '/api/joint-development/drive-inbox' && req.method === 'GET') {
      try {
        const result = await this.engine.tools.google.driveListFiles({ q: "name contains 'OnlyChat-JointDev-' and trashed = false", pageSize: 50 });
        return this._respondJson(res, { files: (result?.files || []).filter(file => file.mimeType === 'application/json').map(file => ({ id: file.id, name: file.name, modifiedTime: file.modifiedTime })) });
      } catch (error) { return this._respondJson(res, { error: error.message || 'joint_development_drive_list_failed' }, 502); }
    }

    if (pathname === '/api/joint-development/receive' && req.method === 'POST') {
      const body = await this._readLimitedBody(req, 4096);
      if (!body || typeof body.fileId !== 'string' || !body.fileId.trim() || body.fileId.length > 256) return this._respondJson(res, { error: 'joint_development_drive_file_id_invalid' }, 400);
      try {
        return await this.macWindowsDevelopment.withLock(`joint-development-receive:${body.fileId.trim()}`, async () => {
        const read = await this.engine.tools.google.driveReadFile(body.fileId.trim());
        if (typeof read?.content !== 'string' || Buffer.byteLength(read.content, 'utf8') > 1024 * 1024) throw new Error('joint development packet is missing or exceeds 1 MiB');
        const packet = JSON.parse(read.content);
        const sha256 = crypto.createHash('sha256').update(read.content).digest('hex');
        if (packet.schema === 'only-chat-joint-development/ack-v1') {
          const task = this.macWindowsDevelopment.recordRemoteReceipt(packet, body.fileId.trim(), sha256);
          return this._respondJson(res, { task, receipt: { fileId: body.fileId.trim(), state: packet.state, readback: 'verified' } }, 200);
        }
        if (packet.schema === 'only-chat-joint-development/patch-v1') {
          const task = this.macWindowsDevelopment.receivePatch(packet, body.fileId.trim(), sha256);
          return this._respondJson(res, { task, drive: { fileId: body.fileId.trim(), sha256, readback: 'verified', receiverRead: 'verified', apply: 'pending-user-action' } }, 200);
        }
        const task = this.macWindowsDevelopment.importPacket(packet, body.fileId.trim(), sha256);
        return this._respondJson(res, { task, drive: { fileId: body.fileId.trim(), sha256, readback: 'verified', receiverRead: 'verified', apply: 'not-applicable-contract-only' } }, 200);
        });
      } catch (error) { return this._respondJson(res, { error: error.message || 'joint_development_packet_receive_failed' }, 400); }
    }

    const jointPatchMatch = /^\/api\/joint-development\/tasks\/([a-z0-9._-]+)\/patches\/([a-z0-9_-]+)$/i.exec(pathname);
    if (jointPatchMatch && req.method === 'GET') {
      const patch = this.macWindowsDevelopment?.readIncomingPatch(jointPatchMatch[1], jointPatchMatch[2]);
      if (!patch) return this._respondJson(res, { error: 'joint_development_patch_not_found' }, 404);
      return this._respondJson(res, { fileId: patch.fileId, sender: patch.sender, filePaths: patch.filePaths, patchSha256: patch.patchSha256, state: patch.state, patch: patch.patch });
    }

    const jointTaskMatch = /^\/api\/joint-development\/tasks\/([a-z0-9._-]+)(?:\/(mac|windows|publish|export|apply|ack))?$/i.exec(pathname);
    if (jointTaskMatch && req.method === 'POST') {
      if (!this.macWindowsDevelopment) return this._respondJson(res, { error: 'joint_development_unavailable' }, 503);
      const body = await this._readLimitedBody(req, 16 * 1024);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return this._respondJson(res, { error: 'joint_development_body_invalid' }, 400);
      const [, taskKey, action] = jointTaskMatch;
      const task = this.macWindowsDevelopment.get(taskKey);
      if (!task) return this._respondJson(res, { error: 'joint_development_task_not_found' }, 404);
      if (action === 'export') {
        try {
          if (this.activeTurns > 0) return this._respondJson(res, { error: 'joint_development_active_ai_turn' }, 409);
          if (!this.taskRegistryStore) return this._respondJson(res, { error: 'joint_development_workspace_lease_unavailable' }, 503);
          const source = task[this.macWindowsDevelopment.localPlatform()].source;
          return await this.taskRegistryStore.lease.run(source, `joint-development-export:${taskKey}`, () => this.macWindowsDevelopment.withLock(`joint-development-export:${taskKey}`, async () => {
          const current = this.macWindowsDevelopment.get(taskKey);
          if (current[this.macWindowsDevelopment.localPlatform()].patch?.fileId) return this._respondJson(res, { error: 'joint_development_source_patch_already_published' }, 409);
          const packet = this.macWindowsDevelopment.createPatch(taskKey);
          const content = JSON.stringify(packet);
          const payloadSha256 = crypto.createHash('sha256').update(content).digest('hex');
          const created = await this.engine.tools.google.driveCreateFile(`OnlyChat-JointDev-${taskKey}-${packet.platform}-${Date.now()}-patch.json`, 'application/json', content);
          const fileId = String(created?.id || '');
          if (!fileId) throw new Error('Drive created a source patch without returning a file ID');
          this.macWindowsDevelopment.recordPatch(taskKey, packet.platform, { fileId, patchSha256: packet.patchSha256, payloadSha256, filePaths: packet.filePaths, readback: null });
          const readback = await this.engine.tools.google.driveReadFile(fileId);
          const verified = readback?.content === content && crypto.createHash('sha256').update(readback.content).digest('hex') === payloadSha256;
          const updated = this.macWindowsDevelopment.recordPatch(taskKey, packet.platform, { fileId, patchSha256: packet.patchSha256, payloadSha256, filePaths: packet.filePaths, readback: verified });
          return this._respondJson(res, { task: updated, packet: { fileId, platform: packet.platform, filePaths: packet.filePaths, patchSha256: packet.patchSha256, payloadSha256, readback: verified ? 'verified' : 'mismatch' } }, verified ? 200 : 502);
          }));
        } catch (error) { return this._respondJson(res, { error: error.message || 'joint_development_patch_export_failed' }, 409); }
      }
      if (action === 'apply') {
        if (!this.taskRegistryStore) return this._respondJson(res, { error: 'joint_development_workspace_lease_unavailable' }, 503);
        try {
          const fileId = String(body.fileId || '');
          const incoming = (task.incomingPatches || []).find(item => item.fileId === fileId);
          if (!incoming) return this._respondJson(res, { error: 'joint_development_patch_not_received' }, 404);
          if (this.activeTurns > 0) return this._respondJson(res, { error: 'joint_development_active_ai_turn' }, 409);
          const source = task[this.macWindowsDevelopment.localPlatform()].source;
          const applied = await this.taskRegistryStore.lease.run(source, `joint-development-apply:${taskKey}`, () => this.macWindowsDevelopment.withLock(`joint-development-apply:${taskKey}`, () => this.macWindowsDevelopment.applyPatch(taskKey, fileId)));
          return this._respondJson(res, { task: applied, apply: 'applied-on-canonical-main', commit: 'not-created' });
        } catch (error) { return this._respondJson(res, { error: error.message || 'joint_development_patch_apply_failed' }, 409); }
      }
      if (action === 'ack') {
        try {
          return await this.macWindowsDevelopment.withLock(`joint-development-ack:${taskKey}`, async () => {
            const current = this.macWindowsDevelopment.get(taskKey);
            const patchFileId = String(body.fileId || '');
            const receipt = this.macWindowsDevelopment.createAppliedReceipt(taskKey, patchFileId);
            const existing = (current.publishedReceipts || []).find(item => item.patchFileId === patchFileId);
            if (existing?.fileId) return this._respondJson(res, { error: 'joint_development_ack_already_published', receipt: existing }, 409);
            const content = JSON.stringify(receipt);
            const sha256 = crypto.createHash('sha256').update(content).digest('hex');
            const created = await this.engine.tools.google.driveCreateFile(`OnlyChat-JointDev-${taskKey}-${receipt.fromPlatform}-${Date.now()}-ack.json`, 'application/json', content);
            const ackFileId = String(created?.id || '');
            if (!ackFileId) throw new Error('Drive created an ACK without returning a file ID');
            this.macWindowsDevelopment.recordPublishedReceipt(taskKey, receipt, ackFileId, sha256, false);
            const readback = await this.engine.tools.google.driveReadFile(ackFileId);
            const verified = readback?.content === content && crypto.createHash('sha256').update(readback.content).digest('hex') === sha256;
            const updated = this.macWindowsDevelopment.recordPublishedReceipt(taskKey, receipt, ackFileId, sha256, verified);
            return this._respondJson(res, { task: updated, receipt: { fileId: ackFileId, sha256, state: receipt.state, readback: verified ? 'verified' : 'mismatch' } }, verified ? 200 : 502);
          });
        } catch (error) { return this._respondJson(res, { error: error.message || 'joint_development_ack_publish_failed' }, 409); }
      }
      if (action === 'publish') {
        try {
          return await this.macWindowsDevelopment.withLock(`joint-development-publish:${taskKey}`, async () => {
            const current = this.macWindowsDevelopment.get(taskKey);
            if (current.drive.fileId) return this._respondJson(res, { error: 'joint_development_packet_already_uploaded', drive: current.drive }, 409);
            const packet = { schema: 'only-chat-joint-development/v1', taskKey: current.taskKey, title: current.title, app: current.app,
              goal: current.goal, integrationBase: current.integrationBase, policy: current.policy,
              mac: current.mac, windows: current.windows, publishedAt: new Date().toISOString() };
            const content = JSON.stringify(packet);
            const sha256 = crypto.createHash('sha256').update(content).digest('hex');
            const created = await this.engine.tools.google.driveCreateFile(`OnlyChat-JointDev-${current.taskKey}-${Date.now()}.json`, 'application/json', content);
            const fileId = String(created?.id || '');
            if (!fileId) throw new Error('Drive created a packet without returning a file ID');
            this.macWindowsDevelopment.recordPublished(taskKey, { fileId, sha256, readback: null });
            const readback = await this.engine.tools.google.driveReadFile(fileId);
            const verified = readback?.content === content && crypto.createHash('sha256').update(readback.content).digest('hex') === sha256;
            const updated = this.macWindowsDevelopment.recordPublished(taskKey, { fileId, sha256, readback: verified });
            return this._respondJson(res, { task: updated, drive: { state: 'uploaded', fileId, sha256, readback: verified ? 'verified' : 'mismatch' } }, verified ? 200 : 502);
          });
        } catch (error) { return this._respondJson(res, { error: error.message || 'joint_development_drive_publish_failed', drive: this.macWindowsDevelopment.get(taskKey)?.drive || null }, 502); }
      }
      try {
        const updated = await this.macWindowsDevelopment.withLock(`joint-development-update:${taskKey}:${action}`, () => this.macWindowsDevelopment.updateSide(taskKey, action, body));
        return this._respondJson(res, { task: updated });
      } catch (error) { return this._respondJson(res, { error: error.message || 'joint_development_update_invalid' }, 400); }
    }

    if (pathname === '/api/task-registry/tasks' && req.method === 'POST') {
      if (!this.taskRegistryStore) return this._respondJson(res, { error: 'task_registry_unavailable' }, 503);
      const body = await this._readLimitedBody(req, 64 * 1024);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return this._respondJson(res, { error: 'task_registry_body_invalid' }, 400);
      try {
        const result = await this.taskRegistryStore.createTask({
          taskKey: body.taskKey, title: body.title, creatorChatId: body.creatorChatId,
          repositoryPath: body.repositoryPath, baseSha: body.baseSha, paths: body.paths,
          nextAction: body.nextAction, idempotencyKey: body.idempotencyKey
        });
        return this._respondJson(res, result, result.created ? 201 : 200);
      } catch (error) {
        const conflict = /already exists|idempotency key was reused/.test(error.message || '');
        return this._respondJson(res, { error: error.message || 'task_registry_create_failed' }, conflict ? 409 : 400);
      }
    }

    const taskRegistryMatch = /^\/api\/task-registry\/tasks\/([^/]+)(?:\/(claim|checkpoint|messages|ack|resume))?$/.exec(pathname);
    if (taskRegistryMatch) {
      if (!this.taskRegistryStore) return this._respondJson(res, { error: 'task_registry_unavailable' }, 503);
      let taskKey;
      try { taskKey = decodeURIComponent(taskRegistryMatch[1]); }
      catch (_) { return this._respondJson(res, { error: 'task_key_invalid' }, 400); }
      const operation = taskRegistryMatch[2];
      if (!operation && req.method === 'GET') {
        const task = this.taskRegistryStore.getTask(taskKey);
        return task ? this._respondJson(res, { task }) : this._respondJson(res, { error: 'task_not_found' }, 404);
      }
      if (operation === 'messages' && req.method === 'GET') {
        try {
          return this._respondJson(res, { messages: this.taskRegistryStore.listMessages({ taskKey,
            viewerChatId: url.searchParams.get('viewerChatId'), afterMessageId: url.searchParams.get('afterMessageId') || undefined,
            limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined }) });
        } catch (error) { return this._respondJson(res, { error: error.message || 'task_message_query_invalid' }, /not found/i.test(error.message || '') ? 404 : 400); }
      }
      if ((operation === 'messages' || operation === 'ack') && req.method === 'POST') {
        const body = await this._readLimitedBody(req, 64 * 1024);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return this._respondJson(res, { error: 'task_registry_body_invalid' }, 400);
        try {
          const result = operation === 'messages'
            ? await this.taskRegistryStore.sendMessage({ taskKey, senderChatId: body.senderChatId, recipientChatId: body.recipientChatId,
              recipientHostId: body.recipientHostId, text: body.text, idempotencyKey: body.idempotencyKey })
            : await this.taskRegistryStore.sendMessage({ taskKey, senderChatId: body.senderChatId, type: 'ack',
              inReplyToMessageId: body.messageId, text: body.text, idempotencyKey: body.idempotencyKey });
          return this._respondJson(res, result, result.sent ? 200 : 404);
        } catch (error) {
          const conflict = /ACK|recipient|acknowledge/i.test(error.message || '');
          return this._respondJson(res, { error: error.message || 'task_message_send_failed' }, conflict ? 409 : 400);
        }
      }
      if (operation === 'resume' && req.method === 'POST') {
        const body = await this._readLimitedBody(req, 64 * 1024);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return this._respondJson(res, { error: 'task_registry_body_invalid' }, 400);
        if (!this.engine || typeof this.engine.resumeManagerPlan !== 'function') return this._respondJson(res, { error: 'manager_resume_unavailable' }, 503);
        try {
          const result = await this.engine.resumeManagerPlan({ taskKey, ownerChatId: body.ownerChatId, idempotencyKey: body.idempotencyKey });
          const missing = result.reason === 'task_not_found';
          const conflict = !result.accepted && !missing;
          return this._respondJson(res, result, result.accepted ? 200 : missing ? 404 : conflict ? 409 : 400);
        } catch (error) {
          const conflict = /claim|lease|conflict|already_running|transition/i.test(error.message || '');
          return this._respondJson(res, { error: error.message || 'task_resume_failed' }, conflict ? 409 : 400);
        }
      }
      if ((operation === 'claim' || operation === 'checkpoint') && req.method === 'POST') {
        const body = await this._readLimitedBody(req, 64 * 1024);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return this._respondJson(res, { error: 'task_registry_body_invalid' }, 400);
        try {
          const result = operation === 'claim'
            ? await this.taskRegistryStore.claimTask({ taskKey, ownerChatId: body.ownerChatId, idempotencyKey: body.idempotencyKey, leaseMs: body.leaseMs })
            : await this.taskRegistryStore.updateCheckpoint({ taskKey, ownerChatId: body.ownerChatId, idempotencyKey: body.idempotencyKey,
              status: body.status, nextAction: body.nextAction, blocker: body.blocker, evidenceRefs: body.evidenceRefs });
          const accepted = operation === 'claim' ? result.accepted : result.updated;
          const missing = result.reason === 'task_not_found';
          return this._respondJson(res, result, accepted ? 200 : missing ? 404 : 409);
        } catch (error) {
          const conflict = /invalid task transition|completion requires|blocked status requires|claim/.test(error.message || '');
          return this._respondJson(res, { error: error.message || 'task_registry_update_failed' }, conflict ? 409 : 400);
        }
      }
    }

    if (pathname === '/api/model-switch-schedule' && req.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId');
      try { return this._respondJson(res, { schedule: this.modelSwitchScheduleStore.get(sessionId) }); }
      catch (error) { return this._respondJson(res, { error: error.message }, 400); }
    }
    if (pathname === '/api/model-switch-schedule' && req.method === 'POST') {
      const body = await this._readLimitedBody(req, 16 * 1024);
      if (!body) return this._respondJson(res, { error: '예약 입력을 읽지 못했습니다.' }, 400);
      const models = this.engine.priorityChain.chain.tiers
        .filter(tier => tier.enabled !== false && typeof tier.model === 'string' && tier.model.trim() && tier.model.trim().toLowerCase() !== 'auto')
        .map(tier => tier.model.trim().toLowerCase());
      if (!models.includes(String(body.targetModel || '').trim().toLowerCase())) {
        return this._respondJson(res, { error: '목표 모델이 현재 계정 라우터에 설정되어 있지 않습니다.' }, 409);
      }
      try { return this._respondJson(res, { ok: true, schedule: this.modelSwitchScheduleStore.schedule(body) }, 201); }
      catch (error) { return this._respondJson(res, { error: error.message || '모델 전환을 예약하지 못했습니다.' }, 400); }
    }
    if (pathname === '/api/model-switch-schedule' && req.method === 'DELETE') {
      const body = await this._readLimitedBody(req, 8 * 1024);
      try { return this._respondJson(res, { ok: true, schedule: this.modelSwitchScheduleStore.cancel(body?.sessionId, 'user-cancelled') }); }
      catch (error) { return this._respondJson(res, { error: error.message }, 400); }
    }

    if (pathname === '/api/schedules' && req.method === 'GET') {
      return this._respondJson(res, { schedules: this.scheduleStore.listSummaries() });
    }
    if (pathname === '/api/schedules' && req.method === 'POST') {
      const body = await this._readLimitedBody(req, 256 * 1024);
      if (!body) return this._respondJson(res, { error: '일정 입력을 읽지 못했습니다.' }, 400);
      try { return this._respondJson(res, { ok: true, schedule: this.scheduleStore.create(this._scheduleInput(body)) }, 201); }
      catch (error) { return this._respondJson(res, { error: error.message || '일정을 저장하지 못했습니다.' }, 400); }
    }
    const scheduleMatch = /^\/api\/schedules\/([^/]+)(?:\/(run))?$/.exec(pathname);
    if (scheduleMatch) {
      let scheduleId;
      try { scheduleId = decodeURIComponent(scheduleMatch[1]); }
      catch (_) { return this._respondJson(res, { error: '일정 ID가 올바르지 않습니다.' }, 400); }
      if (scheduleMatch[2] === 'run' && req.method === 'POST') {
        try {
          const result = this.scheduleService.runNow(scheduleId);
          return this._respondJson(res, result, result.accepted ? 202 : 409);
        } catch (error) { return this._respondJson(res, { error: error.message || '일정을 실행하지 못했습니다.' }, 404); }
      }
      if (!scheduleMatch[2] && req.method === 'GET') {
        const schedule = this.scheduleStore.get(scheduleId);
        return schedule ? this._respondJson(res, { schedule }) : this._respondJson(res, { error: '일정을 찾을 수 없습니다.' }, 404);
      }
      if (!scheduleMatch[2] && req.method === 'PUT') {
        const body = await this._readLimitedBody(req, 256 * 1024);
        if (!body) return this._respondJson(res, { error: '일정 입력을 읽지 못했습니다.' }, 400);
        try { return this._respondJson(res, { ok: true, schedule: this.scheduleStore.update(scheduleId, this._scheduleInput(body)) }); }
        catch (error) { return this._respondJson(res, { error: error.message || '일정을 저장하지 못했습니다.' }, /not found/.test(error.message) ? 404 : 400); }
      }
      if (!scheduleMatch[2] && req.method === 'DELETE') {
        try { return this._respondJson(res, { ok: this.scheduleStore.delete(scheduleId) }); }
        catch (error) { return this._respondJson(res, { error: error.message || '일정을 삭제하지 못했습니다.' }, 400); }
      }
    }

    if (pathname === '/api/mac-screen/settings' && req.method === 'GET') {
      this._respondJson(res, { ...this.macScreenControlSettings.get(), nativeAvailable: this.isNativeMacScreenControlAvailable() });
      return;
    }
    if (pathname === '/api/mac-screen/settings' && req.method === 'POST') {
      const body = await this._readBody(req);
      if (!this.isNativeMacScreenControlAvailable() && body.enabled === true) return this._respondJson(res, { ok: false, error: 'Mac 화면 제어는 Only Chat 네이티브 macOS 앱에서만 사용할 수 있습니다.' }, 403);
      try {
        const settings = this.macScreenControlSettings.set(body.enabled);
        if (!settings.enabled) {
          this.macScreenLastCaptureAt = 0;
          this.macScreenCommands.length = 0;
          for (const waiter of this.macScreenCommandWaiters.splice(0)) { clearTimeout(waiter.timeout); waiter.resolve({ error: 'Mac 화면 제어가 꺼졌습니다.' }); }
        }
        return this._respondJson(res, { ok: true, ...settings });
      } catch (error) { return this._respondJson(res, { ok: false, error: error.message || 'Mac 화면 제어 설정을 저장하지 못했습니다.' }, 400); }
    }
    if (pathname === '/api/mac-screen/panel/next' && req.method === 'GET') {
      if (!this.isMacScreenControlEnabled()) return this._respondJson(res, { error: 'Mac 화면 제어가 꺼져 있습니다.' }, 403);
      const command = this.macScreenCommands.shift();
      if (command) return this._respondJson(res, command);
      res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return;
    }
    if (pathname === '/api/mac-screen/panel/complete' && req.method === 'POST') {
      if (!this.isMacScreenControlEnabled()) return this._respondJson(res, { error: 'Mac 화면 제어가 꺼져 있습니다.' }, 403);
      const body = await this._readLimitedBody(req, 10 * 1024 * 1024);
      if (!body || typeof body.id !== 'string') return this._respondJson(res, { error: 'Mac 화면 결과가 올바르지 않습니다.' }, 400);
      const index = this.macScreenCommandWaiters.findIndex(waiter => waiter.id === body.id);
      if (index < 0) return this._respondJson(res, { error: 'Mac 화면 명령 대기 항목이 없습니다.' }, 404);
      const [waiter] = this.macScreenCommandWaiters.splice(index, 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(body.result && typeof body.result === 'object' ? body.result : { error: 'Mac 화면 결과가 올바르지 않습니다.' });
      return this._respondJson(res, { ok: true });
    }
    if (pathname === '/api/mac-screen/dispatch' && req.method === 'POST') {
      const supplied = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
      const expected = Buffer.from(this.macScreenToken);
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return this._respondJson(res, { error: 'Only Chat Mac 화면 도구 인증 실패' }, 401);
      if (!this.isMacScreenControlEnabled()) return this._respondJson(res, { error: 'Only Chat 설정에서 Mac 화면 제어를 먼저 켜 주세요.' }, 403);
      const body = await this._readBody(req);
      try {
        if (['click', 'type', 'key', 'scroll'].includes(body.action)
          && (!this.macScreenLastCaptureAt || Date.now() - this.macScreenLastCaptureAt > 60_000)) {
          return this._respondJson(res, { error: '화면 조작 전 screen_capture로 현재 화면을 먼저 확인해 주세요.' }, 409);
        }
        const result = await this._dispatchMacScreenCommand(body.action, body.input || {});
        if (body.action === 'capture' && typeof result.image === 'string') this.macScreenLastCaptureAt = Date.now();
        else if (['click', 'type', 'key', 'scroll'].includes(body.action)) this.macScreenLastCaptureAt = 0;
        if (body.action === 'capture') {
          const { image, mimeType, width, height, ...metadata } = result;
          return this._respondJson(res, { ...metadata, image, mimeType: mimeType || 'image/jpeg', width, height });
        }
        return this._respondJson(res, result);
      } catch (error) { return this._respondJson(res, { error: error.message || 'Mac 화면 작업을 완료하지 못했습니다.' }, 502); }
    }

    if (pathname === '/api/browser/panel/next' && req.method === 'GET') {
      if (!this.isThreefControlEnabled()) return this._respondThreefDisabled(res);
      const command = this.browserCommands.shift();
      if (command) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(command));
      } else {
        if (this.browserPanelWaiter) {
          this.browserPanelWaiter.res.writeHead(204, { 'Cache-Control': 'no-store' });
          this.browserPanelWaiter.res.end();
          clearTimeout(this.browserPanelWaiter.timeout);
        }
        const timeout = setTimeout(() => {
          if (this.browserPanelWaiter?.res === res) {
            this.browserPanelWaiter = null;
            res.writeHead(204, { 'Cache-Control': 'no-store' });
            res.end();
          }
        }, 15000);
        this.browserPanelWaiter = { res, timeout };
        req.on('close', () => {
          if (this.browserPanelWaiter?.res === res) {
            clearTimeout(timeout);
            this.browserPanelWaiter = null;
          }
        });
      }
      return;
    }

    if (pathname === '/api/browser/panel/complete' && req.method === 'POST') {
      if (!this.isThreefControlEnabled()) return this._respondThreefDisabled(res);
      const body = await this._readBody(req);
      const waiterIndex = this.browserCommandWaiters.findIndex(waiter => waiter.id === body.id);
      if (waiterIndex < 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '브라우저 명령 대기 항목을 찾을 수 없습니다.' }));
        return;
      }
      const [waiter] = this.browserCommandWaiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(body.result && typeof body.result === 'object' ? body.result : { error: '브라우저 결과가 올바르지 않습니다.' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // 핫리로드 _ 신체 변형 시스템 (Metamorphic Hot-Reload Routes)
    if (pathname === '/api/morph/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write(`data: ${JSON.stringify({ type: 'morph_connected', status: this.hub.getHubStatus() })}\n\n`);
      this.hub.registerSseClient(res);
      return;
    }

    if (pathname === '/api/priority/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      this.priorityEventClients.add(res);
      res.on('close', () => this.priorityEventClients.delete(res));
      res.write(`data: ${JSON.stringify({ type: 'priority_status', status: this.getPriorityStatus() })}\n\n`);
      return;
    }

    if (pathname === '/api/evolution/inbox/stream' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      this.evolutionInboxClients.add(res);
      res.on('close', () => this.evolutionInboxClients.delete(res));
      res.write(`data: ${JSON.stringify({ type: 'windows_changes', status: this.evolutionInbox?.status() || { configured: false, pending: [] } })}\n\n`);
      return;
    }

    if (pathname === '/api/morph/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.hub.getHubStatus()));
      return;
    }

    if (pathname === '/api/admin-manager/status' && req.method === 'GET') {
      try {
        const manager = await this._loadAdminManager();
        const dispatcherAllowedProviderIds = typeof this.engine._getDispatcherAllowedProviderIds === 'function'
          ? await this.engine._getDispatcherAllowedProviderIds()
          : [];
        const snapshot = this._adminManagerSnapshot(manager.ADMIN_MANAGER_MODULE_VERSION, dispatcherAllowedProviderIds);
        manager.buildAdminManagerSystemMessage(snapshot);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ apiVersion: manager.ADMIN_MANAGER_API_VERSION, moduleVersion: manager.ADMIN_MANAGER_MODULE_VERSION, ...snapshot }));
      } catch (err) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '관리자 capability 목록을 불러오지 못했습니다.' }));
      }
      return;
    }

    if (pathname === '/api/morph/mutate' && req.method === 'POST') {
      const body = await this._readBody(req);
      try {
        const result = this.hub.mutateOrgan(body.organ, body.key, body.value, body.author || 'ai-developer', {
          expectedHash: body.expectedHash,
          expectedSchemaVersion: body.expectedSchemaVersion,
          deferIfBusy: body.deferIfBusy ?? (body.expectedHash == null),
          lockOwner: body.lockOwner,
          lockTtlMs: body.lockTtlMs
        });
        res.writeHead(result.queued ? 202 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname === '/api/morph/flush' && req.method === 'POST') {
      try {
        const result = this.hub.flushPendingMutations();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Static Assets
    if (pathname === '/' || pathname === '/index.html') {
      this._serveFile(res, path.join(this.staticDir, 'index.html'), 'text/html; charset=utf-8');
      return;
    }
    if (pathname === '/app.css') {
      this._serveFile(res, path.join(this.staticDir, 'app.css'), 'text/css; charset=utf-8');
      return;
    }
    if (pathname === '/app.js') {
      this._serveFile(res, path.join(this.staticDir, 'app.js'), 'application/javascript; charset=utf-8');
      return;
    }

    if (pathname === '/internalSessionGrouping.js') {
      this._serveFile(res, path.join(this.staticDir, 'internalSessionGrouping.js'), 'application/javascript; charset=utf-8');
      return;
    }

    if (pathname === '/sessionDropMapping.js') {
      this._serveFile(res, path.join(this.staticDir, 'sessionDropMapping.js'), 'application/javascript; charset=utf-8');
      return;
    }

    if (pathname === '/workspaceOwnershipPresentation.js') {
      this._serveFile(res, path.join(this.staticDir, 'workspaceOwnershipPresentation.js'), 'application/javascript; charset=utf-8');
      return;
    }

    if (pathname === '/chatPresentation.js') {
      this._serveFile(res, path.join(this.staticDir, 'chatPresentation.js'), 'application/javascript; charset=utf-8');
      return;
    }

    if (pathname === '/browser-address.js') {
      this._serveFile(res, path.join(this.staticDir, 'browser-address.js'), 'application/javascript; charset=utf-8');
      return;
    }

    if (pathname === '/notion-oauth.js') {
      this._serveFile(res, path.join(this.staticDir, 'notion-oauth.js'), 'application/javascript; charset=utf-8');
      return;
    }

    // API Routes
    if (pathname === '/api/status' && req.method === 'GET') {
      let routerChain = null;
      if (!this.isolated) {
        try {
          // Link AI Account Router during the normal app status refresh, not
          // only after the first chat turn. This is local metadata discovery;
          // credentials are still verified only by a real provider request.
          await this.engine._ensureAccountRouterTier();
          routerChain = await (await this.engine._getAccountRouterAdapter()).getChain();
        } catch (_) {}
      }
      if (routerChain && !this.engine.accountRouterReadiness?.verified) {
        const configured = routerChain.enabled === true && routerChain.accounts.some(account => account.enabled !== false
          && account.provider && !['demo', 'unconfigured'].includes(account.provider)
          && typeof account.model === 'string' && account.model.trim() && account.model.trim().toLowerCase() !== 'unconfigured');
        const unverified = routerChain.providerState === 'unverified'
          || routerChain.accounts.some(account => account.availability === 'unverified');
        Object.assign(this.engine.accountRouterReadiness, {
          available: configured ? (unverified ? null : true) : false,
          connected: configured && !unverified,
          verified: false,
          state: !configured ? 'unconfigured' : unverified ? 'unverified' : 'configured',
          message: !configured
            ? 'AI Account Router에 사용 가능한 계정이 없습니다.'
            : unverified
              ? 'AI Account Router 계정 자격 증명이 아직 검증되지 않았습니다.'
              : 'AI Account Router 연결됨'
        });
      }
      const status = this.getPriorityStatus();
      status.accountRouter = routerChain;
      status.routerIntegrationRevision = '2026-11-05-v1';
      status.routerModels = routerChain?.enabled === true && Array.isArray(routerChain.accounts)
        ? [...new Set(routerChain.accounts
          .filter(account => account.enabled !== false && account.provider && !['demo', 'unconfigured'].includes(account.provider))
          .flatMap(account => [account.model, ...(Array.isArray(account.models)
            ? account.models.map(model => model?.id || model?.model || model?.name) : [])])
          .filter(model => typeof model === 'string' && model.trim() && model.trim().toLowerCase() !== 'auto')
          .map(model => model.trim().toLowerCase()))]
        : [];
      status.accountRouterReadiness = { ...(this.engine.accountRouterReadiness || {}) };
      status.defaultWorkspaceDir = this.engine.defaultWorkspaceDir || this.engine.workspaceDir;
      status.sessionWorkspaceDir = this.engine.currentSession?.workspaceDir || null;
      status.workspaceDir = status.sessionWorkspaceDir || status.defaultWorkspaceDir;
      status.windowsChangesPending = this.evolutionInbox?.status().pending.length || 0;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(status));
      return;
    }

    if (pathname === '/api/settings/approval-policy' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ policy: this.engine.tools.approvalPolicy }));
      return;
    }

    if (pathname === '/api/audio/transcribe' && req.method === 'POST') {
      const mimeType = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
      const extension = ({ 'audio/webm': '.webm', 'audio/mp4': '.mp4', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg' })[mimeType];
      if (!extension) {
        return this._respondJson(res, { error: '지원하지 않는 오디오 형식입니다.' }, 400);
      }
      const audioBytes = await this._readLimitedBuffer(req, 20 * 1024 * 1024);
      if (!audioBytes) return this._respondJson(res, { error: '녹음 파일이 너무 크거나 요청 형식이 올바르지 않습니다.' }, 413);
      if (audioBytes.length < 128) {
        return this._respondJson(res, { error: '녹음 파일이 비어 있거나 너무 짧습니다. 다시 녹음해 주세요.' }, 400);
      }
      if (audioBytes.length > 20 * 1024 * 1024) {
        return this._respondJson(res, { error: '오디오 파일은 20 MB 이하이어야 합니다.' }, 413);
      }
      const whisper = [...(process.env.PATH || '').split(path.delimiter).map(directory => path.join(directory, 'whisper')),
        '/opt/homebrew/bin/whisper', '/usr/local/bin/whisper'].find(candidate => {
          try { return fs.statSync(candidate).isFile(); } catch (_) { return false; }
        });
      if (!whisper) return this._respondJson(res, { error: '이 Mac에서 로컬 Whisper AI를 찾지 못했습니다.' }, 503);
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-voice-'));
      const audioPath = path.join(tempDir, `voice-memo${extension}`);
      try {
        fs.writeFileSync(audioPath, audioBytes, { mode: 0o600, flag: 'wx' });
        await new Promise((resolve, reject) => {
          execFile(whisper, [audioPath, '--model', 'base', '--device', process.platform === 'darwin' && process.arch === 'arm64' ? 'mps' : 'cpu', '--output_dir', tempDir, '--output_format', 'json', '--verbose', 'False'], {
            cwd: tempDir, timeout: 600000, maxBuffer: 2 * 1024 * 1024
          }, error => error ? reject(error) : resolve());
        });
        const result = JSON.parse(fs.readFileSync(path.join(tempDir, 'voice-memo.json'), 'utf8'));
        return this._respondJson(res, { transcript: String(result.text || '').trim(), language: String(result.language || '자동 감지') });
      } catch (error) {
        const timedOut = error?.killed || error?.signal === 'SIGTERM';
        return this._respondJson(res, { error: timedOut ? '10분 안에 전사를 끝내지 못했습니다. 짧은 녹음으로 나누어 주세요.' : '로컬 Whisper 전사에 실패했습니다. Whisper 모델 또는 오디오 형식을 확인해 주세요.' }, 503);
      } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      }
    }

    if (pathname === '/api/feedback/developer-email' && req.method === 'POST') {
      if (!this.openExternal) return this._respondJson(res, { error: '메일 앱 연결을 사용할 수 없습니다.' }, 503);
      const body = await this._readLimitedBody(req, 4096);
      if (!body || typeof body.source !== 'string' || typeof body.error !== 'string') {
        return this._respondJson(res, { error: '오류 피드백 형식이 올바르지 않습니다.' }, 400);
      }
      const email = String(packageMetadata.author || '').match(/<([^<>]+)>/)?.[1];
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return this._respondJson(res, { error: '앱에 개발자 연락처가 설정되어 있지 않습니다.' }, 503);
      }
      const safeText = value => String(value)
        .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, '[인증 정보 숨김]')
        .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, '[토큰 숨김]')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[이메일 숨김]')
        .replace(/(?:\/Users\/|[A-Z]:\\Users\\)[^/\\\s]+/g, '~')
        .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500);
      const subject = `Only Chat 오류 피드백 · ${safeText(body.source).slice(0, 60)}`;
      const message = [
        'Only Chat 오류 피드백',
        `발생 위치: ${safeText(body.source).slice(0, 60)}`,
        `발생 시각: ${new Date().toISOString()}`,
        `오류 내용: ${safeText(body.error)}`,
        '',
        '이 메일 초안에는 대화 내용, 첨부 파일, 음성 녹음이 포함되지 않습니다. 내용을 확인한 뒤 직접 보내 주세요.'
      ].join('\n');
      try {
        await this.openExternal(`mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`);
        return this._respondJson(res, { ok: true });
      } catch (_) {
        return this._respondJson(res, { error: '기본 메일 앱을 열지 못했습니다.' }, 503);
      }
    }

    if (pathname === '/api/settings/approval-policy' && req.method === 'POST') {
      const body = await this._readBody(req);
      if (!APPROVAL_POLICIES.has(body.policy)) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: '승인 정책은 on-request, never, read-only 중 하나여야 합니다.' }));
        return;
      }
      if (this.activeTurns > 0) {
        res.writeHead(409, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: '실행 중인 작업이 끝난 뒤 승인 정책을 변경해 주세요.' }));
        return;
      }
      try {
        writeApprovalPolicy(this.approvalPolicyFile, body.policy);
        this.approvalPolicy = body.policy;
        this.engine.tools.approvalPolicy = body.policy;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, policy: body.policy }));
      } catch (_) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: '승인 정책을 저장하지 못했습니다. 기존 설정을 유지합니다.' }));
      }
      return;
    }

    if (pathname === '/api/evolution/inbox' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(this.evolutionInbox?.status() || { configured: false, enabled: false, pending: [], error: 'isolated_mode' }));
      return;
    }

    if (pathname === '/api/evolution/configure' && req.method === 'POST') {
      const body = await this._readBody(req);
      try {
        const status = this.evolutionInbox.configure({ relayRoot: body.relayRoot });
        this._bindEvolutionInbox();
        this._broadcastEvolutionInbox();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, status }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: String(error.message || error) }));
      }
      return;
    }

    if (pathname === '/api/evolution/disable' && req.method === 'POST') {
      const status = this.evolutionInbox.disable();
      this._broadcastEvolutionInbox();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, status }));
      return;
    }

    if (pathname === '/api/spacekeeper/session-report' && req.method === 'POST') {
      const body = await this._readBody(req);
      if (typeof body.taskKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(body.taskKey)) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: '유효한 Space Keeper task key가 필요합니다.' }));
        return;
      }
      try {
        const report = await this.engine.tools.spaceKeeperSessionReport(body.taskKey);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(report));
      } catch (_) {
        res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Space Keeper 보고서를 불러오지 못했습니다.' }));
      }
      return;
    }

    if (pathname === '/api/spacekeeper/capacity' && req.method === 'GET') {
      try {
        const status = await this.engine.tools.spaceKeeperCapacityStatus();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(status));
      } catch (_) {
        res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Space Keeper 용량 상태를 불러오지 못했습니다.' }));
      }
      return;
    }

    if (pathname === '/api/sessions' && req.method === 'GET') {
      const internal = this.engine.sessions.listSessions();
      let unified = this.nativeSessions.listUnifiedSessions();
      if (this.isolated && (!unified || (!unified.sections?.length && !unified.projects?.length))) {
        try {
          const fallbackBridge = new NativeSessionBridge();
          unified = fallbackBridge.listUnifiedSessions();
        } catch (_) {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        internal,
        unified,
        isolated: this.isolated
      }));
      return;
    }

    if (pathname === '/api/codex-queue' && req.method === 'GET') {
      const inbox = this.nativeSessions.loadCodexQueuedItems();
      if (inbox.available) {
        const metadataByThread = new Map(this.nativeSessions.loadCodexThreadMetadata().map(session => [session.rawId, session]));
        inbox.items = inbox.items.map(item => {
          const source = metadataByThread.get(item.threadId);
          return {
            ...item,
            threadTitle: source?.title || 'Codex 대화',
            threadArchived: source?.isArchived === true,
            threadVerified: Boolean(source)
          };
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ...inbox, readOnly: true }));
      return;
    }

    if (pathname === '/api/sessions/storage-report' && req.method === 'GET') {
      const requestedDays = Number(url.searchParams.get('days'));
      const days = Number.isInteger(requestedDays) && requestedDays >= 1 && requestedDays <= 90 ? requestedDays : 7;
      try {
        const report = await this.engine.sessions.storageReport({ days });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(report));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: `Only Chat 세션 저장량을 읽지 못했습니다: ${String(error.message || error).slice(0, 200)}` }));
      }
      return;
    }

    if (pathname === '/api/sessions/metadata' && req.method === 'POST') {
      const body = await this._readBody(req);
      const sessionId = body.sessionId;
      const action = body.action;
      if (typeof sessionId !== 'string' || !/^ses_[a-f0-9]{16}$/.test(sessionId)
        || !['rename', 'pin', 'move', 'archive', 'delete'].includes(action)
        || !body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '잘못된 세션 변경 요청입니다.' }));
        return;
      }
      try {
        const result = this.engine.sessions.updateSessionMetadata(sessionId, action, body.payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '내부 세션 또는 변경 내용이 올바르지 않습니다.' }));
      }
      return;
    }

    if ((pathname === '/api/sessions/search' || pathname === '/api/sessions/search/stream') && req.method === 'POST') {
      const streamResults = pathname === '/api/sessions/search/stream';
      const body = await this._readBody(req);
      const query = typeof body.query === 'string' ? body.query.trim() : '';
      if (!query || query.length > 200) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '검색어는 1~200자여야 합니다.' }));
        return;
      }
      const controller = new AbortController();
      let timedOut = false;
      let settled = false;
      const timeoutMs = streamResults
        ? Math.max(this.sessionSearchStreamTimeoutMs || 120000, this.sessionSearchTimeoutMs)
        : this.sessionSearchTimeoutMs;
      const sendStreamEvent = event => {
        if (!streamResults || res.destroyed || res.writableEnded) return;
        res.write(`${JSON.stringify(event)}\n`);
      };
      let streamedResultCount = 0;
      const timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        controller.abort();
        cleanup();
        if (res.destroyed) return;
        if (streamResults) {
          sendStreamEvent({ type: 'incomplete', reason: 'timeout' });
          res.end();
          return;
        }
        res.writeHead(504, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: '세션 검색 시간이 초과되었습니다.' }));
      }, timeoutMs);
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        res.removeListener('close', onClose);
      };
      const onClose = () => {
        if (!res.writableEnded) {
          cleanup();
          controller.abort();
        }
      };
      res.once('close', onClose);
      if (streamResults) {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
        sendStreamEvent({ type: 'started' });
      }
      Promise.resolve().then(() => this.nativeSessions.searchSessions(query, streamResults ? {
        signal: controller.signal,
        onResult: item => { streamedResultCount++; sendStreamEvent({ type: 'result', item }); },
        onProgress: progress => { if (!progress?.complete) sendStreamEvent({ type: 'progress', ...progress }); }
      } : { signal: controller.signal })).then(results => {
        if (timedOut) return;
        cleanup();
        if (res.destroyed) return;
        if (streamResults) {
          // Keep test doubles and older bridge implementations compatible with the stream contract.
          if (streamedResultCount === 0) {
            for (const item of results || []) sendStreamEvent({ type: 'result', item });
          }
          sendStreamEvent({ type: 'complete', resultCount: Array.isArray(results) ? results.length : 0 });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results }));
      }).catch(() => {
        if (timedOut) return;
        cleanup();
        if (res.destroyed) return;
        if (streamResults) {
          sendStreamEvent({ type: 'error' });
          res.end();
          return;
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '세션 검색을 완료하지 못했습니다.' }));
      });
      return;
    }

    if (pathname === '/api/sessions/resume' && req.method === 'POST') {
      const body = await this._readBody(req);
      const sessionId = body.sessionId;
      const isInternal = typeof sessionId === 'string' && /^ses_[a-f0-9]{16}$/.test(sessionId);
      const isInternalCandidate = typeof sessionId === 'string' && sessionId.startsWith('ses_');
      const resumed = isInternal
        ? this.engine.sessions.resumeSession(sessionId)
        : isInternalCandidate ? null : this.nativeSessions.resumeSession(sessionId);
      if (resumed) {
        // Load into AgentEngine so subsequent turns continue right here in Only Chat!
        const activeSession = resumed.source === 'internal'
          ? this.engine.loadInternalSession(resumed)
          : this.engine.loadResumedSession(resumed);
        const session = {
          ...resumed,
          id: activeSession.sessionId,
          sessionId: activeSession.sessionId
        };
        delete session.conversationHistory;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, session }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '세션을 찾을 수 없습니다.' }));
      }
      return;
    }

    if (pathname === '/api/priority/switch' && req.method === 'POST') {
      const body = await this._readBody(req);
      const tierId = body.tierId;
      const ok = this.engine.priorityChain.setManualTier(tierId);
      const status = this.getPriorityStatus();
      const tier = ok ? status.activeTier : null;
      const selected = this.engine.priorityChain.chain.tiers.find(item => item.id === tierId);
      const readiness = selected?.provider === 'codex' ? this.codexAdapter?.getReadiness(selected) : null;
      const health = selected ? this.engine.priorityChain.tierHealth.get(selected.id) : null;
      const error = !selected ? '계정을 찾을 수 없습니다.'
        : readiness && !readiness.connected ? readiness.message
          : health?.isThrottled || (Number.isFinite(health?.totalRemainingPercent) && health.totalRemainingPercent <= this.engine.priorityChain.thresholdPercent)
            ? '한도 소진 또는 10% 이하인 계정은 수동 선택할 수 없습니다.'
              : '사용 가능한 계정을 선택하지 못했습니다.';
      res.writeHead(ok ? 200 : 409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, tier, status, error: ok ? undefined : error }));
      return;
    }

    if (pathname === '/api/priority/mode' && req.method === 'POST') {
      const body = await this._readBody(req);
      const ok = this.engine.priorityChain.setAutomaticPriority(body.enabled);
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, status: this.getPriorityStatus(), error: ok ? undefined : '자동 우선순위 값이 올바르지 않습니다.' }));
      return;
    }

    if (pathname === '/api/account-router/account' && req.method === 'POST') {
      if (this.isolated) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '격리 테스트에서는 실제 계정을 변경하지 않습니다.' }));
        return;
      }
      try {
        const body = await this._readBody(req);
        const adapter = await this.engine._getAccountRouterAdapter();
        const result = await manageRouterAccount(adapter, body);
        this.engine.accountRouterDiscoveryRetryAt = 0;
        await this.engine._ensureAccountRouterTier();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead([400, 403, 404, 409].includes(error.status) ? error.status : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
      return;
    }

    if (['/api/account-router/reorder', '/api/account-router/model'].includes(pathname) && req.method === 'POST') {
      try {
        const body = await this._readBody(req);
        const adapter = await this.engine._getAccountRouterAdapter();
        if (pathname.endsWith('/reorder')) await adapter.reorderAccounts({ accountIds: body.accountIds, expectedRevision: body.expectedRevision });
        else {
          if (typeof body.accountId !== 'string' || typeof body.model !== 'string') throw Object.assign(new Error('계정과 모델이 필요합니다.'), { status: 400 });
          await adapter.setAccountModel(body.accountId, body.model);
        }
        this.engine.accountRouterDiscoveryRetryAt = 0;
        await this.engine._ensureAccountRouterTier();
        const accountRouter = await adapter.getChain();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, accountRouter }));
      } catch (error) {
        res.writeHead([400, 403, 409].includes(error.status) ? error.status : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
      return;
    }

    if (pathname === '/api/priority/set-rank' && req.method === 'POST') {
      const body = await this._readBody(req);
      const { tierId, rank } = body;
      const ok = this.engine.priorityChain.setTierRank(tierId, rank);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, status: this.getPriorityStatus() }));
      return;
    }

    if (pathname === '/api/priority/configure-main' && req.method === 'POST') {
      const body = await this._readBody(req);
      const result = this.engine.priorityChain.configureMainTier(body.mainTierId, {
        enableTierIds: body.enableTierIds || [],
        disableTierIds: body.disableTierIds || []
      });
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ...result, status: this.getPriorityStatus() }));
      return;
    }

    if (pathname === '/api/priority/disconnect' && req.method === 'POST') {
      const body = await this._readBody(req);
      if (typeof body.tierId !== 'string' || !body.tierId || body.providerId !== undefined) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '삭제할 계정 하나를 선택해 주세요.' }));
        return;
      }
      const ok = this.engine.priorityChain.removeTier(body.tierId);
      if (ok && this.engine.auth) this.engine.auth.removeAccount(body.tierId);
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, status: this.getPriorityStatus() }));
      return;
    }

    if (pathname === '/api/priority/connect' && req.method === 'POST') {
      try {
        if (this.isolated) throw Object.assign(new Error('격리 테스트에서는 실제 계정을 연결하지 않습니다.'), { status: 503 });
        const body = await this._readBody(req);
        const action = body.provider === 'chatgpt' ? 'add-chatgpt'
          : body.provider === 'google' ? 'refresh-antigravity' : null;
        if (!action || body.apiKey) throw Object.assign(new Error('이 연결 창에서는 ChatGPT 로그인과 현재 Antigravity 로그인 연결을 지원합니다. API 계정은 AI Account Router에서 등록해 주세요.'), { status: 400 });
        const adapter = await this.engine._getAccountRouterAdapter();
        const result = await manageRouterAccount(adapter, { action, name: body.name });
        this.engine.accountRouterDiscoveryRetryAt = 0;
        await this.engine._ensureAccountRouterTier();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead([400, 403, 409].includes(error.status) ? error.status : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
      return;
    }

    // =========================================================================
    // Google Workspace & Notion Connectors Endpoints
    // =========================================================================
    if (pathname === '/api/connectors/status' && req.method === 'GET') {
      const googleConnected = this.engine.tools.google.isConnected();
      const notionConnected = this.engine.tools.notion.isConnected();
      const notionMcp = await this.engine.tools.notionMcp.status().catch(error => ({
        connected: false, workspaceName: null, auth: 'Notion MCP OAuth + PKCE', error: error.message
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        google: {
          connected: googleConnected,
          scopes: ['Google Drive (Full Edit)', 'Gmail (Read, Compose, Modify & Send)', 'User Profile']
        },
        notion: {
          connected: notionConnected || notionMcp.connected,
          personalLogin: notionMcp.connected,
          workspaceName: notionMcp.workspaceName,
          auth: notionMcp.auth,
          connectionError: notionMcp.error || null,
          apiVersion: '2026-03-11',
          capabilities: ['Notion hosted MCP tools granted by user-selected pages', 'OAuth refresh with macOS Keychain credential storage', 'Approval-gated Notion changes']
        }
      }));
      return;
    }

    if (pathname === '/api/connectors/google/auth-url' && req.method === 'GET') {
      try {
        const url = this.engine.tools.google.getAuthUrl();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname === '/api/connectors/notion/auth-url' && req.method === 'GET') {
      try {
        const redirectUri = `http://localhost:${this.port}/api/connectors/notion/callback`;
        const url = await this.engine.tools.notionMcp.getAuthUrl(redirectUri);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ url }));
      } catch (err) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname === '/api/connectors/notion/auth-status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(this.engine.tools.notionMcp.authStatus()));
      return;
    }

    if (pathname === '/api/connectors/notion/callback' && req.method === 'GET') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const issuer = url.searchParams.get('iss');
      const providerError = url.searchParams.get('error');
      try {
        if (providerError) {
          this.engine.tools.notionMcp.cancelPendingAuth();
          throw new Error(providerError === 'access_denied' ? 'Notion 접근을 허용하지 않았습니다.' : `Notion 로그인 실패 (${providerError}).`);
        }
        const connected = await this.engine.tools.notionMcp.exchangeOAuthCallback(code, state, issuer);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        res.end(`<html lang="ko"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Notion 연결 완료</title><body style="font:16px system-ui;background:#f6f7f8;color:#242424;padding:48px"><h2>Notion 연결 완료</h2><p>${connected.workspaceName ? '워크스페이스 ' + String(connected.workspaceName).replace(/[&<>"']/g, '') + '에 연결했습니다.' : 'Only Chat에서 Notion을 사용할 수 있습니다.'}</p><p>이 창을 닫고 Only Chat으로 돌아가세요.</p></body></html>`);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        res.end(`<html lang="ko"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Notion 연결 실패</title><body style="font:16px system-ui;background:#f6f7f8;color:#242424;padding:48px"><h2>Notion 연결 실패</h2><p>${String(err.message || 'Notion 연결을 완료하지 못했습니다.').replace(/[&<>"']/g, '')}</p><p>Only Chat 설정에서 다시 연결해 주세요.</p></body></html>`);
      }
      return;
    }

    if (pathname === '/api/connectors/notion/disconnect' && req.method === 'POST') {
      try {
        await this.engine.tools.notionMcp.disconnect();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname === '/api/connectors/google/callback' && req.method === 'GET') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (code) {
        try {
          await this.engine.tools.google.exchangeCode(code, state);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<html><body style="font-family: sans-serif; background:#131416; color:#00d2ff; text-align:center; padding:50px;">
            <h2>✓ Google Workspace (Drive & Gmail) 연동 성공!</h2>
            <p style="color:#aaa;">AI가 구글 드라이브 및 이메일 편집 권한을 획득했습니다. 이 창을 닫으셔도 좋습니다.</p>
            <script>setTimeout(() => window.close(), 2500);</script>
          </body></html>`);
          return;
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Google OAuth Exchange Failed: ' + e.message);
          return;
        }
      }
    }

    if (pathname === '/api/connectors/notion/token' && req.method === 'POST') {
      const body = await this._readBody(req);
      const token = body.token || '';
      try {
        await this.engine.tools.notion.verifyToken(token);
        this.engine.tools.notion.saveToken(token);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, connected: this.engine.tools.notion.isConnected() }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // =========================================================================
    // Built-in Aside / REA Browser Endpoints
    // =========================================================================
    if (pathname === '/api/browser/threef/settings' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ enabled: this.isThreefControlEnabled() }));
      return;
    }
    if (pathname === '/api/browser/threef/settings' && req.method === 'POST') {
      if (this.isolated) {
        res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: '분리 실행 모드에서는 3F Browser 제어를 사용할 수 없습니다.' }));
        return;
      }
      const body = await this._readBody(req);
      try {
        this.threefControlSettings.set(body.enabled);
        if (!body.enabled) {
          for (const waiter of this.browserCommandWaiters.splice(0)) { clearTimeout(waiter.timeout); waiter.resolve({ error: '3F Browser 제어가 꺼져 있습니다.' }); }
          this.browserCommands.length = 0;
          if (this.browserPanelWaiter) {
            const panelWaiter = this.browserPanelWaiter;
            this.browserPanelWaiter = null;
            clearTimeout(panelWaiter.timeout);
            panelWaiter.res.writeHead(204, { 'Cache-Control': 'no-store' });
            panelWaiter.res.end();
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ok: true, enabled: this.isThreefControlEnabled() }));
      } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
      return;
    }
    if (pathname === '/api/browser/status' && req.method === 'GET') {
      if (!this.isThreefControlEnabled()) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ enabled: false, available: false, isOpen: false, controlAvailable: false, activeUrl: '', statusText: '3F Browser 제어가 꺼져 있습니다.' }));
        return;
      }
      const status = await this.engine.tools.browserStatus();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(status));
      return;
    }
    if (pathname.startsWith('/api/browser/') && !this.isThreefControlEnabled()) return this._respondThreefDisabled(res);

    if (pathname === '/api/browser/authorize' && req.method === 'POST') {
      if (this.isolated) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ allowed: false, reason: 'isolated' }));
        return;
      }
      try {
        const body = await this._readBody(req);
        const decision = await this.focusFencePolicy.check(body.url);
        const status = decision.allowed ? 200 : decision.reason === 'blocked' ? 403 : 503;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(decision));
      } catch (_) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ allowed: false, reason: 'focus_fence_unavailable' }));
      }
      return;
    }

    if (pathname === '/api/browser/nav' && req.method === 'POST') {
      if (this.isolated) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '분리 실행 모드에서는 브라우저를 열 수 없습니다.' }));
        return;
      }
      const body = await this._readBody(req);
      const urlToOpen = body.url || 'https://google.com';
      try {
        const result = await this.engine.tools.browserOpen(urlToOpen);
        const status = result?.blocked ? 403 : result?.ok === false ? 502 : 200;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (_) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '3F Browser를 실행하지 못했습니다.' }));
      }
      return;
    }

    if (pathname === '/api/browser/threef/open' && req.method === 'POST') {
      const body = await this._readBody(req);
      const deepLink = buildThreefDeepLink(body.url);
      if (!deepLink) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '유효한 HTTP 또는 HTTPS 주소가 필요합니다.' }));
        return;
      }
      try {
        const result = await this.engine.tools.browserOpen(body.url);
        if (result?.blocked || result?.ok === false) {
          res.writeHead(result?.blocked ? 403 : 502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (_) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '3F Browser를 열지 못했습니다.' }));
      }
      return;
    }

    if (pathname === '/api/browser/aria' && req.method === 'POST') {
      if (this.isolated) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '분리 실행 모드에서는 브라우저를 사용할 수 없습니다.' }));
        return;
      }
      const body = await this._readBody(req);
      try {
        const result = await this.engine.tools.browserAria(body.tabId);
        res.writeHead(result?.blocked ? 403 : result?.ok === false ? 502 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (_) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '3F Browser 정보를 읽지 못했습니다.' }));
      }
      return;
    }

    if (pathname === '/api/browser/read' && req.method === 'POST') {
      if (this.isolated) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '분리 실행 모드에서는 브라우저를 사용할 수 없습니다.' }));
        return;
      }
      try {
        const result = await this.engine.tools.browserRead();
        res.writeHead(result?.blocked ? 403 : result?.ok === false ? 502 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (_) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '3F Browser 페이지 텍스트를 읽지 못했습니다.' }));
      }
      return;
    }

    if (pathname === '/api/browser/history' && req.method === 'POST') {
      if (this.isolated) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '분리 실행 모드에서는 브라우저를 사용할 수 없습니다.' }));
        return;
      }
      const body = await this._readBody(req);
      try {
        const result = await this.engine.tools.browserHistory(body.action);
        res.writeHead(result?.blocked ? 403 : result?.ok === false ? 502 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (_) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '3F Browser 탐색 동작을 실행하지 못했습니다.' }));
      }
      return;
    }

    if (pathname === '/api/browser/act' && req.method === 'POST') {
      if (this.isolated) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '분리 실행 모드에서는 브라우저를 사용할 수 없습니다.' }));
        return;
      }
      const body = await this._readBody(req);
      try {
        const result = await this.engine.tools.browserAct(body.action);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (_) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '3F Browser 작업을 실행하지 못했습니다.' }));
      }
      return;
    }

    // =========================================================================
    // Local app catalog (REA is used during development, not embedded here)
    // =========================================================================
    if (pathname === '/api/rea/apps' && req.method === 'GET') {
      const apps = this.localApps.listCandidateApps();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(apps));
      return;
    }

    // =========================================================================
    // Passkey & Credential Vault Endpoints
    // =========================================================================
    if (pathname === '/api/vault/list' && req.method === 'GET') {
      const list = this.engine.tools.vault.listCredentials();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));
      return;
    }

    if (pathname === '/api/vault/save' && req.method === 'POST') {
      const body = await this._readBody(req);
      try {
        const saved = this.engine.tools.vault.saveCredential(body.service, {
          username: body.username,
          secret: body.secret,
          type: body.type || 'passkey',
          allowAiUse: body.allowAiUse !== false
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, credential: saved }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname === '/api/vault/delete' && req.method === 'POST') {
      const body = await this._readBody(req);
      const ok = this.engine.tools.vault.deleteCredential(body.id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok }));
      return;
    }

    if (pathname === '/api/skills' && req.method === 'GET') {
      const skills = this.engine.skills.listSkills();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(skills));
      return;
    }

    if (pathname === '/api/dispatcher' && req.method === 'GET') {
      const snapshot = this.engine.dispatcher.getSnapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot));
      return;
    }

    if (pathname === '/api/integrations/for-ai/feedback' && req.method === 'POST') {
      if (Number(req.headers['content-length']) > 64 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'payload_too_large' }));
        return;
      }
      const body = await this._readLimitedBody(req, 64 * 1024);
      try {
        if (!body || !this.forAiInbox) throw Object.assign(new Error('for_ai_unavailable'), { statusCode: 503 });
        const receipt = this.forAiInbox.submit(req, body);
        res.writeHead(receipt.duplicate ? 200 : 202, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, ...receipt }));
      } catch (error) {
        const status = error.statusCode || 400;
        const code = ['for_ai_not_authorized', 'for_ai_connection_unavailable'].includes(error.message)
          ? 'unauthorized'
          : ['origin_not_allowed', 'project_not_allowed'].includes(error.message) ? 'forbidden'
            : error.message === 'id_conflict' ? 'id_conflict'
              : status === 503 ? 'temporarily_unavailable' : 'invalid_request';
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: code }));
      }
      return;
    }

    const forAiStatusMatch = /^\/api\/integrations\/for-ai\/feedback\/([0-9a-f-]{36})$/.exec(pathname);
    if (forAiStatusMatch && req.method === 'GET') {
      try {
        if (!this.forAiInbox) throw Object.assign(new Error('for_ai_unavailable'), { statusCode: 503 });
        const receipt = this.forAiInbox.status(req, forAiStatusMatch[1]);
        res.writeHead(receipt ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(receipt ? { ok: true, ...receipt } : { ok: false, error: 'not_found' }));
      } catch (error) {
        const status = error.statusCode || 401;
        const code = error.message === 'origin_not_allowed' ? 'forbidden' : status === 503 ? 'temporarily_unavailable' : 'unauthorized';
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: code }));
      }
      return;
    }

    if (pathname === '/api/dispatcher/enqueue' && req.method === 'POST') {
      const body = await this._readBody(req);
      const requestedTasks = Array.isArray(body.tasks) ? body.tasks : [body];
      if (requestedTasks.length === 0 || requestedTasks.some(task => !Array.isArray(task?.allowedTools)
        || task.allowedTools.length < 1 || task.allowedTools.length > 32
        || task.allowedTools.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/i.test(name)))) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: '각 작업에는 유효한 비어 있지 않은 허용 도구 목록이 필요합니다.' }));
        return;
      }
      const tasks = requestedTasks
        .map(task => ({ ...task, requireToolExecution: true }));
      const enqueued = this.engine.dispatcher.enqueueTasks(tasks);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, enqueued, snapshot: this.engine.dispatcher.getSnapshot() }));
      return;
    }

    if (pathname === '/api/dispatcher/approval' && req.method === 'POST') {
      const body = await this._readBody(req);
      const pending = this.pendingDispatcherToolApprovals.get(body.requestId);
      const active = pending && this.engine.dispatcher.activeWorkers.get(pending.taskId);
      if (!pending || pending.taskId !== body.taskId || pending.sessionId !== body.sessionId
        || !active || active.task.pendingApproval?.requestId !== body.requestId
        || !['approve', 'reject'].includes(body.decision)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '승인 요청이 만료되었거나 다른 작업/세션의 요청입니다.' }));
        return;
      }
      clearTimeout(pending.timer);
      this.pendingDispatcherToolApprovals.delete(body.requestId);
      active.task.pendingApproval = null;
      pending.resolve(body.decision === 'approve');
      this.engine.dispatcher.emit('queue_updated', { queueLength: this.engine.dispatcher.queue.length });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === '/api/ownership' && req.method === 'GET') {
      const locks = this.engine.ownership.getActiveLocks();
      const gitStatus = this.engine.ownership.getGitStatus();
      const workspaceLease = this.engine.workspaceExecutionLease.getStatus(this.engine.workspaceDir);
      const pathLocks = {
        available: true,
        scope: 'active_in_process_paths',
        repositoryWide: false,
        readAt: new Date().toISOString(),
        locks
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ locks, pathLocks, uncommitted: gitStatus.uncommitted, gitStatus: {
        available: gitStatus.available,
        error: gitStatus.error
      }, workspaceLease: {
        ...workspaceLease,
        scope: 'workspace_execution',
        workspaceWide: true,
        repositoryWide: false,
        readAt: new Date().toISOString()
      } }));
      return;
    }

    if (pathname === '/api/accounts/login' && req.method === 'POST') {
      const body = await this._readBody(req);
      const account = await this.engine.auth.loginProvider(body.provider, {
        email: body.email,
        token: body.token
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, account }));
      return;
    }

    if (pathname === '/api/codex/reauth' && req.method === 'POST') {
      const body = await this._readBody(req);
      if (typeof body.tierId !== 'string' || body.tierId.length > 128) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '재인증할 계정 ID가 올바르지 않습니다.' }));
        return;
      }
      const tier = this.engine.priorityChain.chain.tiers.find(item => item.id === body.tierId && item.provider === 'codex');
      if (!tier) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '해당 Codex 계정을 찾을 수 없습니다.' }));
        return;
      }
      try {
        const status = this.codexAdapter?.startReauthentication(tier);
        if (!status) throw new Error('Codex 재인증을 사용할 수 없습니다.');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status }));
      } catch (error) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message || 'Codex 재인증을 시작하지 못했습니다.' }));
      }
      return;
    }

    if (pathname === '/api/codex/reauth/status' && req.method === 'GET') {
      const tierId = url.searchParams.get('tierId') || '';
      const tier = this.engine.priorityChain.chain.tiers.find(item => item.id === tierId && item.provider === 'codex');
      if (!tier) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '해당 Codex 계정을 찾을 수 없습니다.' }));
        return;
      }
      const status = this.codexAdapter?.getLoginStatus(tier.id) || { state: 'unavailable' };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(status));
      return;
    }

    // SSE Turn Execution Endpoint
    if (pathname === '/api/turn' && req.method === 'POST') {
      const body = await this._readBody(req);
      const prompt = body.prompt || '';
      let requestedWorkspaceDir = null;
      if (body.workspaceDir !== undefined || body.workspaceWriteApproval !== undefined) {
        if (this.isolated || body.workspaceWriteApproval !== true || typeof body.workspaceDir !== 'string' || !path.isAbsolute(body.workspaceDir)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '새 세션 작업공간은 명시 승인된 절대 경로로만 선택할 수 있습니다.' }));
          return;
        }
        try {
          requestedWorkspaceDir = fs.realpathSync(path.resolve(body.workspaceDir));
          if (!fs.statSync(requestedWorkspaceDir).isDirectory()) throw new Error('not_directory');
        } catch (_) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '선택한 Only Chat 작업공간을 확인할 수 없습니다.' }));
          return;
        }
      }
      const requestedSessionId = body.sessionId;
      const isNewChatSession = typeof requestedSessionId === 'string' && /^session_\d{10,16}$/.test(requestedSessionId);
      const isInternalSession = typeof requestedSessionId === 'string' && /^ses_[a-f0-9]{16}$/.test(requestedSessionId);
      if (requestedSessionId !== undefined && !isNewChatSession && !isInternalSession) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '대화 세션 식별자가 올바르지 않습니다.' }));
        return;
      }
      const reasoningEffort = parseReasoningEffort(body.reasoningEffort);
      if (!reasoningEffort) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'reasoningEffort는 low, medium, high, xhigh 또는 max여야 합니다.' }));
        return;
      }
      if (body.modelSelection !== undefined && (typeof body.modelSelection !== 'string' || body.modelSelection.length > 128)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '모델 선택 값이 올바르지 않습니다.' }));
        return;
      }
      if (body.toolProfile !== undefined && !['file-edit', 'file-read', 'embedded-3f-status', 'threef-browser-status'].includes(body.toolProfile)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '도구 프로필이 올바르지 않습니다.' }));
        return;
      }
      const modelSelection = typeof body.modelSelection === 'string' ? body.modelSelection : 'auto';
      const normalizedModelSelection = modelSelection.trim().toLowerCase();
      const managerMode = body.managerMode === true;
      const isFreeRouterModel = /^(?:openrouter\/free|[a-z0-9_.-]+\/[a-z0-9_.-]+:free)$/i.test(normalizedModelSelection);
      let freeRouterModelAllowed = false;
      const accountRouterPrefix = 'account-router:';
      const selectedAccountRouterModel = normalizedModelSelection.startsWith(accountRouterPrefix)
        ? normalizedModelSelection.slice(accountRouterPrefix.length) : '';
      let accountRouterModelAllowed = false;
      if (selectedAccountRouterModel) {
        try {
          const routerChain = await (await this.engine._getAccountRouterAdapter()).getChain();
          accountRouterModelAllowed = routerChain?.enabled === true && Array.isArray(routerChain.accounts)
            && routerChain.accounts.some(account => account.enabled !== false && account.provider
              && !['demo', 'unconfigured'].includes(account.provider)
              && [account.model, ...(Array.isArray(account.models) ? account.models.map(model => model?.id || model?.model || model?.name) : [])]
                .some(model => String(model || '').trim().toLowerCase() === selectedAccountRouterModel));
        } catch (_) {
          accountRouterModelAllowed = false;
        }
      } else if (normalizedModelSelection === 'auto') {
        try {
          const routerChain = await (await this.engine._getAccountRouterAdapter()).getChain();
          accountRouterModelAllowed = routerChain?.enabled === true && Array.isArray(routerChain.accounts)
            && routerChain.accounts.some(account => account.enabled !== false && account.provider
              && !['demo', 'unconfigured'].includes(account.provider));
        } catch (_) {
          accountRouterModelAllowed = false;
        }
      }
      if (isFreeRouterModel && body.managerMode !== true && body.fullAccess !== true) {
        try {
          const routerChain = await (await this.engine._getAccountRouterAdapter()).getChain();
          freeRouterModelAllowed = routerChain?.enabled === true && Array.isArray(routerChain.accounts)
            && routerChain.accounts.some(account => account.enabled !== false && String(account.model || '').trim().toLowerCase() === normalizedModelSelection
              && /^(?:openrouter\/free|[a-z0-9_.-]+\/[a-z0-9_.-]+:free)$/i.test(String(account.model || '').trim().toLowerCase()));
        } catch (_) {
          freeRouterModelAllowed = false;
        }
      }
      if (body.fullAccess !== undefined && typeof body.fullAccess !== 'boolean') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Full access 상태가 올바르지 않습니다.' }));
        return;
      }
      const isTurbo = this.approvalPolicy === 'never';
      const effectiveFullAccess = body.fullAccess === true || (isTurbo && body.fullAccess !== false);
      if (effectiveFullAccess) {
        const chain = this.engine.priorityChain;
        const selectedTier = !chain.chain.enabled && typeof body.overrideTierId === 'string'
          ? chain.chain.tiers.find(tier => tier.id === body.overrideTierId)
          : normalizedModelSelection === 'auto'
            ? chain.resolveActiveTier()
            : chain.chain.tiers.filter(tier => tier.enabled !== false
              && String(tier.model || '').trim().toLowerCase() === normalizedModelSelection
              && (tier.provider !== 'codex' || this.codexAdapter?.getReadiness(tier).connected === true)
              && tier.health?.isThrottled !== true)
              .sort((a, b) => (Number(a.tier) || Number.MAX_SAFE_INTEGER) - (Number(b.tier) || Number.MAX_SAFE_INTEGER))[0];
        const codexConnected = selectedTier?.provider === 'codex' && this.codexAdapter?.getReadiness(selectedTier).connected === true;
        const routerConnected = (selectedTier?.provider === 'account-router' || normalizedModelSelection === 'auto' || Boolean(selectedAccountRouterModel)) && accountRouterModelAllowed;
        const fallbackCodexAvailable = normalizedModelSelection === 'auto' && chain.chain.tiers.some(tier =>
          tier.enabled !== false && tier.provider === 'codex' && this.codexAdapter?.getReadiness(tier).connected === true);
        if (this.approvalPolicy === 'read-only' || (!codexConnected && !accountRouterModelAllowed && !routerConnected && !fallbackCodexAvailable)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: this.approvalPolicy === 'read-only'
            ? '읽기 전용 정책에서는 Full access를 사용할 수 없습니다.'
            : 'Full access는 연결된 Codex 계정 또는 설정된 Account Router 모델로 요청할 수 있습니다.' }));
          return;
        }
      }
      const configuredModels = this.engine.priorityChain.chain.tiers
        .filter(tier => tier.enabled !== false && typeof tier.model === 'string' && tier.model.trim() && tier.model !== 'auto')
        .map(tier => tier.model.trim().toLowerCase());
      if (normalizedModelSelection !== 'auto' && !configuredModels.includes(normalizedModelSelection) && !freeRouterModelAllowed && !accountRouterModelAllowed) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '선택한 모델이 현재 우선순위 계정에 설정되어 있지 않습니다.' }));
        return;
      }
      if (normalizedModelSelection !== 'auto' && !freeRouterModelAllowed && !accountRouterModelAllowed && !this.engine.priorityChain.chain.enabled) {
        const manualTier = this.engine.priorityChain.chain.tiers.find(tier => tier.id === this.engine.priorityChain.chain.manualTierId);
        if (!manualTier || String(manualTier.model || '').trim().toLowerCase() !== normalizedModelSelection) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '현재 수동 계정에서 선택한 모델을 사용할 수 없습니다.' }));
          return;
        }
      }
        const overrideTierId = !this.engine.priorityChain.chain.enabled && body.overrideTierId || null;
      let managerSystemMessage = null;
      let managerExecutionAllowed = false;
      if (managerMode) {
        try {
          const manager = await this._loadAdminManager();
          const dispatcherAllowedProviderIds = await this.engine._getDispatcherAllowedProviderIds();
          managerExecutionAllowed = !this.isolated && Array.isArray(dispatcherAllowedProviderIds) && dispatcherAllowedProviderIds.length > 0;
          managerSystemMessage = manager.buildAdminManagerSystemMessage(this._adminManagerSnapshot(manager.ADMIN_MANAGER_MODULE_VERSION, dispatcherAllowedProviderIds));
        } catch (_) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '관리자 capability 목록을 검증할 수 없습니다.' }));
          return;
        }
      }

      if (this.dispatchedTurns?.size > 0) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Only Chat에서 다른 작업을 실행 중입니다. 현재 작업이 끝난 뒤 다시 요청해 주세요.' }));
        return;
      }

      let releaseTurnSlot = null;
      let disconnectedWhileQueued = false;
      const releaseIfQueuedClientClosed = () => {
        disconnectedWhileQueued = true;
        releaseTurnSlot?.();
      };
      res.once('close', releaseIfQueuedClientClosed);
      releaseTurnSlot = await this._acquireTurnRequestSlot();
      if (disconnectedWhileQueued || res.destroyed) {
        releaseTurnSlot();
        return;
      }
      res.once('finish', releaseTurnSlot);

      let announcedSessionId = null;
      try {
        const defaultWorkspaceDir = this.engine.defaultWorkspaceDir || this.engine.workspaceDir;
        if (isNewChatSession) {
          let sessionId = this.newChatSessionAliases.get(requestedSessionId);
          if (sessionId && !this.engine.sessions.resumeSession(sessionId)) {
            this.newChatSessionAliases.delete(requestedSessionId);
            sessionId = null;
          }
          if (!sessionId) {
            const created = this.engine.initSession({ workspaceDir: requestedWorkspaceDir || defaultWorkspaceDir });
            sessionId = created.sessionId;
            const resumed = this.engine.sessions.resumeSession(sessionId);
            if (!resumed) throw new Error('New chat session disappeared before its turn started.');
            this.engine.loadInternalSession(resumed);
          }
          const aliasedSession = this.engine.sessions.resumeSession(sessionId);
          if (requestedWorkspaceDir && path.resolve(aliasedSession?.cwd || defaultWorkspaceDir) !== requestedWorkspaceDir) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '이 Only Chat 세션은 이미 다른 작업공간에 연결되어 있습니다.' }));
            return;
          }
          this.newChatSessionAliases.set(requestedSessionId, sessionId);
          this.modelSwitchScheduleStore.moveSession(requestedSessionId, sessionId);
          while (this.newChatSessionAliases.size > 128) {
            this.newChatSessionAliases.delete(this.newChatSessionAliases.keys().next().value);
          }
          if (this.engine.currentSession?.sessionId !== sessionId) {
            const resumed = this.engine.sessions.resumeSession(sessionId);
            if (!resumed) throw new Error('New chat session disappeared before its turn started.');
            this.engine.loadInternalSession(resumed);
          }
          announcedSessionId = sessionId;
        } else if (isInternalSession && this.engine.currentSession?.sessionId !== requestedSessionId) {
          const resumed = this.engine.sessions.resumeSession(requestedSessionId);
          if (!resumed) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '요청한 대화 세션을 찾을 수 없습니다.' }));
            return;
          }
          this.engine.loadInternalSession(resumed);
        } else if (!this.engine.currentSession) {
          this.engine.initSession();
        }
      } catch (_) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Only Chat에서 대화 세션을 준비하지 못했습니다.' }));
        return;
      }

      const turnSessionId = this.engine.currentSession?.sessionId;
      let releaseSessionTurnSlot = null;
      if (!managerMode) {
        // Session selection above is serialized; once its ID is stable, unrelated
        // chats may prepare and execute independently.
        releaseTurnSlot();
        releaseSessionTurnSlot = await this._acquireSessionTurnSlot(turnSessionId);
        if (res.destroyed) {
          releaseSessionTurnSlot();
          return;
        }
      }
      const modelSwitchResolution = this.modelSwitchScheduleStore.resolveForRequest(turnSessionId, {
        model: normalizedModelSelection,
        effort: reasoningEffort,
        targetAvailable: targetModel => {
          const chain = this.engine.priorityChain;
          const candidates = chain.chain.tiers.filter(tier => tier.enabled !== false
            && String(tier.model || '').trim().toLowerCase() === targetModel);
          if (!chain.chain.enabled) {
            const manualTier = chain.chain.tiers.find(tier => tier.id === chain.chain.manualTierId);
            if (!manualTier || String(manualTier.model || '').trim().toLowerCase() !== targetModel) return false;
          }
          try { return candidates.some(tier => chain.isTierReady(tier)); }
          catch (_) { return false; }
        }
      });
      if (modelSwitchResolution.blocked) {
        releaseSessionTurnSlot?.();
        return this._respondJson(res, { error: '예약한 모델이 현재 준비되지 않아 요청을 실행하지 않았습니다. 로그인 또는 모델 설정을 확인한 뒤 예약을 다시 설정해 주세요.', schedule: modelSwitchResolution.schedule }, 409);
      }
      const effectiveModelSelection = modelSwitchResolution.apply?.model || normalizedModelSelection;
      const effectiveReasoningEffort = modelSwitchResolution.apply?.effort || reasoningEffort;
      let turnEngine;
      try {
        turnEngine = managerMode ? this.engine : this._createTurnEngine(turnSessionId, body.toolProfile || null, effectiveFullAccess);
      } catch (_) {
        releaseSessionTurnSlot?.();
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Only Chat에서 독립 실행 세션을 준비하지 못했습니다.' }));
        return;
      }

      this.activeTurns += 1;
      this.activeTurnEngines.set(turnSessionId, turnEngine);
      const turnController = new AbortController();
      this.activeTurnControllers.add(turnController);
      res.once('close', () => {
        if (!res.writableEnded) turnController.abort(new Error('Only Chat client disconnected.'));
      });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      const sendSse = data => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      if (announcedSessionId) sendSse({ type: 'session_started', clientSessionId: requestedSessionId, sessionId: announcedSessionId });
      if (modelSwitchResolution.apply) sendSse({ type: 'model_switch_schedule_applied', schedule: modelSwitchResolution.schedule });

      const requestToolApproval = request => new Promise(resolve => {
        const currentSessionId = turnEngine.currentSession?.sessionId;
        if (!currentSessionId || currentSessionId !== request.sessionId || res.destroyed) return resolve(false);
        const grants = this.sessionToolApprovals.get(currentSessionId);
        if (request.scopeRequiresExplicit !== true && (grants?.has('*') || grants?.has(request.name))) return resolve(true);
        const timer = setTimeout(() => {
          this.pendingToolApprovals.delete(request.requestId);
          resolve(false);
        }, 120000);
        this.pendingToolApprovals.set(request.requestId, {
          sessionId: currentSessionId, engine: turnEngine, name: request.name, scopeRequiresExplicit: request.scopeRequiresExplicit === true, resolve, timer
        });
        sendSse({ type: 'tool_approval_required', requestId: request.requestId, sessionId: currentSessionId, name: request.name, args: request.args, scopeRequiresExplicit: request.scopeRequiresExplicit === true });
        res.once('close', () => {
          const pending = this.pendingToolApprovals.get(request.requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pendingToolApprovals.delete(request.requestId);
          pending.resolve(false);
        });
      });

      const embeddedThreefMcpToken = this.embeddedBrowserPanel && this.isThreefControlEnabled()
        ? crypto.randomBytes(32).toString('hex') : '';
      const embeddedThreefMcp = embeddedThreefMcpToken ? {
        url: `http://127.0.0.1:${this.port}/api/mcp/embedded-3f`,
        token: embeddedThreefMcpToken,
        serverPath: process.resourcesPath
          ? path.join(process.resourcesPath, 'onlychat-embedded-3f-mcp.py')
          : path.resolve(__dirname, '../../../bin/onlychat-embedded-3f-mcp.py'),
        pythonPath: '/usr/bin/python3'
      } : null;
      if (embeddedThreefMcpToken) this.embeddedThreefMcpSessions.set(embeddedThreefMcpToken, {
        sessionId: turnSessionId,
        requestToolApproval,
        expiresAt: Date.now() + 10 * 60 * 1000
      });

      try {
        if (overrideTierId) {
          turnEngine.priorityChain.resolveActiveTier(overrideTierId);
        }

        const executionPrompt = body.toolProfile === 'file-read'
          ? `${prompt}\n\n[Only Chat file-read guidance]\nUse only read_file. If the result says middle lines were omitted, or the requested section is not present, call read_file again with exact start_line and end_line values. Do not infer content outside returned ranges. Base conclusions on the returned text and include one verbatim 12-160 character quote from it. A bounded result is not proof that omitted lines contain no match.`
          : prompt;
        await turnEngine.executeTurn(executionPrompt, {
          signal: turnController.signal,
          reasoningEffort: effectiveReasoningEffort,
          toolProfile: body.toolProfile || null,
          fullAccess: effectiveFullAccess,
          routerModelSelection: accountRouterModelAllowed && selectedAccountRouterModel ? selectedAccountRouterModel
            : freeRouterModelAllowed && effectiveModelSelection === normalizedModelSelection ? normalizedModelSelection : null,
          accountRouterModelSelection: accountRouterModelAllowed && selectedAccountRouterModel ? selectedAccountRouterModel : null,
          modelSelection: accountRouterModelAllowed && selectedAccountRouterModel ? 'auto' : effectiveModelSelection,
          managerMode,
          managerSystemMessage,
          managerExecutionAllowed,
          requestToolApproval,
          embeddedThreefMcp,
          onTierResolved: tier => sendSse({ type: 'tier_resolved', tier }),
          onReasoningDelta: delta => sendSse({ type: 'reasoning_delta', delta }),
          onMessageDelta: delta => sendSse({ type: 'message_delta', delta }),
          onToolStart: call => sendSse({ type: 'tool_start', call }),
          onToolOutput: out => sendSse({ type: 'tool_output', text: out.text }),
          onToolEnd: result => sendSse({ type: 'tool_end', result }),
          onManagerDelegation: delegation => sendSse({ type: 'manager_delegated', delegation }),
          onTurnComplete: summary => sendSse({ type: 'turn_complete', summary })
        });

        res.write('data: [DONE]\n\n');
        res.end();
      } catch (err) {
        if (turnController.signal.aborted) return;
        const allowedFailureCategories = new Set([
          'quota_rate_limit', 'authentication', 'model_unavailable',
          'sandbox_permission_blocked', 'approval_required', 'approval_denied', 'network_unavailable', 'provider_failure'
        ]);
        const event = { type: 'error', message: 'The request could not be completed.' };
        if (allowedFailureCategories.has(err.category)) {
          event.category = err.category;
          if (typeof err.model === 'string' && err.model) event.model = err.model.slice(0, 80);
          if (Number.isSafeInteger(err.rank) && err.rank > 0) event.rank = err.rank;
        }
        if (turnSessionId && turnEngine.currentSession?.sessionId === turnSessionId) {
          try {
            turnEngine.sessions.appendItem(turnSessionId, {
              type: 'turn_error',
              category: event.category,
              ...(event.model ? { model: event.model } : {}),
              ...(event.rank ? { rank: event.rank } : {})
            });
          } catch (persistError) {
            console.warn('[DesktopServer] Failed to persist sanitized turn error:', persistError.message);
          }
        }
        sendSse(event);
        res.end();
      } finally {
        this.activeTurnControllers.delete(turnController);
        if (this.activeTurnEngines.get(turnSessionId) === turnEngine) this.activeTurnEngines.delete(turnSessionId);
        releaseSessionTurnSlot?.();
        if (embeddedThreefMcpToken) this.embeddedThreefMcpSessions.delete(embeddedThreefMcpToken);
        this._decrementActiveTurns();
        void this.engine.dispatcher.tick();
        if (turnEngine !== this.engine) {
          turnEngine.dispatcher.stop();
          turnEngine.skills.stopWatching();
        }
      }
      return;
    }

    if (pathname === '/api/tool-approval' && req.method === 'POST') {
      const body = await this._readBody(req);
      const pending = this.pendingToolApprovals.get(body.requestId);
      if (!pending || pending.sessionId !== body.sessionId || pending.engine?.currentSession?.sessionId !== pending.sessionId
        || !['approve', 'reject', 'allow_tool', 'turbo'].includes(body.decision)
        || (pending.scopeRequiresExplicit && !['approve', 'reject'].includes(body.decision))) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '승인 요청이 만료되었거나 다른 세션의 요청입니다.' }));
        return;
      }
      clearTimeout(pending.timer);
      this.pendingToolApprovals.delete(body.requestId);
      if (body.decision === 'allow_tool' || body.decision === 'turbo') {
        const grants = this.sessionToolApprovals.get(pending.sessionId) || new Set();
        grants.add(body.decision === 'turbo' ? '*' : pending.name);
        this.sessionToolApprovals.set(pending.sessionId, grants);
      }
      pending.resolve(body.decision !== 'reject');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // 404 Not Found
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  _serveFile(res, filePath, contentType) {
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
    }
  }

  _requestDispatcherToolApproval(task, request) {
    const active = this.engine.dispatcher.activeWorkers.get(task.id);
    if (!active || active.task !== task || task.status !== 'running' || task.sessionId !== request.sessionId) {
      return Promise.reject(new Error('Approval request expired or belongs to another task or session.'));
    }
    const grants = this.sessionToolApprovals.get(request.sessionId);
    if (grants?.has('*') || grants?.has(request.name)) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      const pending = { taskId: task.id, sessionId: request.sessionId, resolve, reject, timer: null };
      pending.timer = setTimeout(() => {
        this.pendingDispatcherToolApprovals.delete(request.requestId);
        task.pendingApproval = null;
        reject(new Error('Approval request expired.'));
        this.engine.dispatcher.emit('queue_updated', { queueLength: this.engine.dispatcher.queue.length });
      }, 120000);
      task.pendingApproval = {
        requestId: request.requestId,
        sessionId: request.sessionId,
        name: request.name,
        args: request.args || {}
      };
      this.pendingDispatcherToolApprovals.set(request.requestId, pending);
      this.engine.dispatcher.emit('queue_updated', { queueLength: this.engine.dispatcher.queue.length });
    });
  }

  async _loadAdminManager() {
    const modulePath = path.join(this.projectRoot, 'src/features/admin-manager/v1.mjs');
    return import(`${pathToFileURL(modulePath).href}?reload=${Date.now()}`);
  }

  _adminManagerSnapshot(adminManagerVersion, dispatcherAllowedProviderIds = []) {
    const packageVersion = JSON.parse(fs.readFileSync(path.join(this.projectRoot, 'package.json'), 'utf8')).version;
    const processStartedAt = Date.now() - process.uptime() * 1000;
    const dispatcherReady = Array.isArray(dispatcherAllowedProviderIds) && dispatcherAllowedProviderIds.length > 0;
    const dispatcherBlockedReason = this.isolated ? 'isolated_runtime' : dispatcherReady ? null : 'no_verified_dispatch_provider';
    const moduleFiles = {
      'admin-manager': ['src/features/admin-manager/v1.mjs', true, true, adminManagerVersion],
      'agent-engine': ['src/core/AgentEngine.js', Boolean(this.engine.executeTurn), false, packageVersion],
      'tool-registry': ['src/tools/ToolRegistry.js', Boolean(this.engine.tools.execCommand), false, packageVersion],
      'session-store': ['src/core/SessionStore.js', Boolean(this.engine.sessions.appendItem), false, packageVersion],
      'native-session-bridge': ['src/core/NativeSessionBridge.js', Boolean(this.nativeSessions.listUnifiedSessions), false, packageVersion],
      'metamorphic-hub': ['src/morph/Hub.js', Boolean(this.hub.mutateOrgan), false, packageVersion],
      'installed-app-catalog': ['src/morph/ReaAppBridge.js', Boolean(this.localApps.listCandidateApps), false, packageVersion],
      'parallel-dispatcher': ['src/core/ParallelDispatcher.js', Boolean(this.engine.dispatcher.enqueueTasks), false, packageVersion],
      'evolution-relay': ['src/sync/EvolutionRelay.js', false, false, packageVersion],
      'external-qa': ['src/features/qa/v1.mjs', false, false, 'unavailable']
    };
    const modules = Object.entries(moduleFiles).map(([id, [relativePath, loaded, dynamic, version]]) => {
      const file = path.join(this.projectRoot, relativePath);
      if (!fs.existsSync(file)) return { id, version, state: 'unavailable', sourceHash: null };
      const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (!loaded) return { id, version, state: 'unavailable', sourceHash };
      const changedAfterProcessStart = !dynamic && fs.statSync(file).mtimeMs > processStartedAt;
      return { id, version, state: changedAfterProcessStart ? 'stale' : 'loaded', sourceHash: changedAfterProcessStart ? null : sourceHash };
    });
    const moduleStates = new Map(modules.map(module => [module.id, module.state]));
    const available = (moduleId, check) => moduleStates.get(moduleId) === 'loaded' && Boolean(check);
    const capabilities = [
      { id: 'chat.respond', name: '채팅 응답', moduleId: 'agent-engine', state: available('agent-engine', this.engine.executeTurn) ? 'executable' : 'unavailable' },
      { id: 'workspace.command', name: '워크스페이스 명령 실행', moduleId: 'tool-registry', state: available('tool-registry', this.engine.tools.execCommand) ? 'executable' : 'unavailable' },
      { id: 'workspace.file-read', name: '워크스페이스 파일 읽기', moduleId: 'tool-registry', state: available('tool-registry', this.engine.tools.readFile) ? 'executable' : 'unavailable' },
      { id: 'workspace.file-write', name: '워크스페이스 파일 수정', moduleId: 'tool-registry', state: available('tool-registry', this.engine.tools.writeFile && this.engine.tools.editFile) ? 'executable' : 'unavailable' },
      { id: 'sessions.read', name: '로컬 Codex 세션 읽기', moduleId: 'native-session-bridge', state: available('native-session-bridge', this.nativeSessions.listUnifiedSessions) ? 'executable' : 'unavailable' },
      { id: 'sessions.resume', name: '로컬 세션 이어가기', moduleId: 'native-session-bridge', state: available('native-session-bridge', this.nativeSessions.resumeSession) ? 'executable' : 'unavailable' },
      { id: 'apps.inventory', name: '설치 앱 후보 조회', moduleId: 'installed-app-catalog', state: available('installed-app-catalog', this.localApps.listCandidateApps) ? 'executable' : 'unavailable' },
      { id: 'work.priority', name: '작업 우선순위 조정', moduleId: 'parallel-dispatcher', state: available('parallel-dispatcher', this.engine.dispatcher.enqueueTasks) ? 'settings-only' : 'unavailable' },
      { id: 'work.delegate', name: '격리 실행자에게 작업 위임', moduleId: 'parallel-dispatcher', state: available('parallel-dispatcher', this.engine.dispatcher.enqueueTasks) && !dispatcherBlockedReason ? 'executable' : 'unavailable' },
      { id: 'hotreload.settings', name: '테마·레이아웃 설정 변경', moduleId: 'metamorphic-hub', state: available('metamorphic-hub', this.hub.mutateOrgan) ? 'settings-only' : 'unavailable' },
      { id: 'drive.sync', name: '기기 간 변경 동기화', moduleId: 'evolution-relay', state: this.syncEnabled ? 'executable' : 'unavailable' },
      { id: 'external.qa', name: '외부 앱 QA 실행', moduleId: 'external-qa', state: 'unavailable' },
      { id: 'self-improvement', name: 'Only Chat 코드 자체 개선', moduleId: 'admin-manager', state: 'proposal-only' }
    ];
    return {
      modules,
      capabilities,
      dispatcher: { ready: dispatcherReady && !this.isolated, blockedReason: dispatcherBlockedReason }
    };
  }

  _readBody(req) {
    return new Promise(resolve => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => {
        try {
          resolve(JSON.parse(data || '{}'));
        } catch (_) {
          resolve({});
        }
      });
    });
  }

  _readLimitedBody(req, maxBytes) {
    return new Promise(resolve => {
      const chunks = [];
      let size = 0;
      let exceeded = false;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { exceeded = true; chunks.length = 0; return; }
        if (!exceeded) chunks.push(chunk);
      });
      req.on('end', () => {
        if (exceeded) return resolve(null);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
        catch (_) { resolve(null); }
      });
      req.on('error', () => resolve(null));
    });
  }

  _readLimitedBuffer(req, maxBytes) {
    return new Promise(resolve => {
      const chunks = [];
      let size = 0;
      let exceeded = false;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { exceeded = true; chunks.length = 0; return; }
        if (!exceeded) chunks.push(chunk);
      });
      req.on('end', () => resolve(exceeded ? null : Buffer.concat(chunks, size)));
      req.on('error', () => resolve(null));
      req.on('aborted', () => resolve(null));
    });
  }

  _scheduleInput(body) {
    if (!Array.isArray(body.attachments)) return body;
    if (body.attachments.length > 5) throw new RangeError('첨부 파일은 최대 5개까지 등록할 수 있습니다.');
    const attachments = body.attachments.map(item => {
      if (item && typeof item.id === 'string' && item.contentBase64 === undefined) return { id: item.id };
      if (typeof item?.name !== 'string' || typeof item.contentBase64 !== 'string' || item.contentBase64.length > 88_000) {
        throw new TypeError('첨부 파일 내용이 올바르지 않습니다.');
      }
      const bytes = Buffer.from(item.contentBase64, 'base64');
      if (bytes.toString('base64') !== item.contentBase64) throw new TypeError('첨부 파일 인코딩이 올바르지 않습니다.');
      return { name: item.name, content: bytes };
    });
    return { ...body, attachments };
  }

  _respondJson(res, value, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }

  isThreefControlEnabled() {
    return !this.isolated && this.threefControlSettings.get().enabled === true;
  }

  isMacScreenControlEnabled() {
    return this.isNativeMacScreenControlAvailable() && this.macScreenControlSettings.get().enabled === true;
  }

  isNativeMacScreenControlAvailable() {
    return !this.isolated && process.platform === 'darwin' && this.macScreenNativeBridgeAvailable === true;
  }

  _dispatchMacScreenCommand(action, input) {
    if (!this.isMacScreenControlEnabled()) return Promise.reject(new Error('Mac 화면 제어가 꺼져 있습니다.'));
    const allowed = new Set(['status', 'permissions', 'capture', 'click', 'type', 'key', 'scroll']);
    if (!allowed.has(action)) return Promise.reject(new Error('지원하지 않는 Mac 화면 도구입니다.'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) return Promise.reject(new Error('입력 인수가 올바르지 않습니다.'));
    if (action === 'type' && (typeof input.text !== 'string' || input.text.length > 4000)) return Promise.reject(new Error('텍스트 입력은 최대 4,000자입니다.'));
    if (action === 'click' && (!Number.isFinite(input.x) || !Number.isFinite(input.y))) return Promise.reject(new Error('클릭 좌표가 올바르지 않습니다.'));
    if (action === 'scroll' && (!Number.isInteger(input.vertical) || !Number.isInteger(input.horizontal)
      || Math.abs(input.vertical) > 10 || Math.abs(input.horizontal) > 10)) return Promise.reject(new Error('스크롤은 -10~10 범위여야 합니다.'));
    if (this.macScreenCommandWaiters.length >= 8) return Promise.reject(new Error('Mac 화면 명령 대기열이 가득 찼습니다.'));
    const id = `mac-screen-${++this.macScreenCommandSequence}-${crypto.randomBytes(4).toString('hex')}`;
    return new Promise((resolve, reject) => {
      const waiter = { id, resolve, timeout: null };
      waiter.timeout = setTimeout(() => {
        const index = this.macScreenCommandWaiters.indexOf(waiter);
        if (index >= 0) this.macScreenCommandWaiters.splice(index, 1);
        const queued = this.macScreenCommands.findIndex(command => command.id === id);
        if (queued >= 0) this.macScreenCommands.splice(queued, 1);
        reject(new Error('Only Chat의 Mac 화면 제어 브리지가 응답하지 않습니다. Only Chat 네이티브 앱을 열어 주세요.'));
      }, 30000);
      this.macScreenCommandWaiters.push(waiter);
      this.macScreenCommands.push({ id, action, input });
    });
  }

  _dispatchEmbeddedBrowserCommand(command) {
    if (!this.isThreefControlEnabled()) return Promise.reject(new Error('3F Browser 제어가 꺼져 있습니다.'));
    if (this.browserCommandWaiters.length >= 16) return Promise.reject(new Error('3F Browser 명령 대기열이 가득 찼습니다.'));
    const id = `threef-${++this.browserCommandSequence}`;
    return new Promise((resolve, reject) => {
      const waiter = { id, resolve, reject, timeout: null };
      waiter.timeout = setTimeout(() => {
        const index = this.browserCommandWaiters.findIndex(waiter => waiter.id === id);
        if (index >= 0) this.browserCommandWaiters.splice(index, 1);
        const queuedIndex = this.browserCommands.findIndex(command => command.id === id);
        if (queuedIndex >= 0) this.browserCommands.splice(queuedIndex, 1);
        reject(new Error('Only Chat 안의 3F Browser가 명령에 응답하지 않습니다. 브라우저 패널을 열어 주세요.'));
      }, 30000);
      this.browserCommandWaiters.push(waiter);
      const entry = { id, ...command };
      const panelWaiter = this.browserPanelWaiter;
      if (panelWaiter) {
        this.browserPanelWaiter = null;
        clearTimeout(panelWaiter.timeout);
        panelWaiter.res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        panelWaiter.res.end(JSON.stringify(entry));
      } else {
        this.browserCommands.push(entry);
      }
    });
  }

  _respondThreefDisabled(res) {
    res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, enabled: false, error: '3F Browser 제어가 꺼져 있습니다.', stderr: '3F Browser 제어가 꺼져 있습니다.' }));
  }
}

function buildThreefDeepLink(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  let destination;
  try { destination = new URL(value); } catch (_) { return null; }
  if (!['http:', 'https:'].includes(destination.protocol) || !destination.hostname || destination.username || destination.password) return null;
  const deepLink = new URL('threef://open');
  deepLink.searchParams.set('url', destination.href);
  return deepLink.toString();
}

function createMacThreefOpener(execFileImpl = execFile) {
  return deepLink => new Promise((resolve, reject) => {
    execFileImpl('/usr/bin/open', ['-b', 'com.rogan.threef.browser', deepLink], error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

module.exports = { DesktopServer, buildThreefDeepLink, createMacThreefOpener, QUOTA_REFRESH_INTERVAL_MS };
