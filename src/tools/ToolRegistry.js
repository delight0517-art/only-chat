/**
 * @project My-Codex
 * @provenance:rogan-core
 * @author Rogan Kim (GeunHu Kim) & AI Architect
 * @license MIT
 * @description Native Tool Registry executing local commands, file manipulation, and diffs with sandbox checks.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, exec } = require('node:child_process');
const { GoogleConnector } = require('../connectors/GoogleConnector.js');
const { NotionConnector } = require('../connectors/NotionConnector.js');
const { NotionMcpConnector } = require('../connectors/NotionMcpConnector.js');
const { AsideBrowser } = require('../browser/AsideBrowser.js');
const { NotionReaBrowser } = require('../browser/NotionReaBrowser.js');
const { PasskeyVault } = require('../auth/PasskeyVault.js');
const { BrowserWorkspace } = require('../workspace/BrowserWorkspace.js');
const { SpaceKeeperConnector } = require('../connectors/SpaceKeeperConnector.js');
const STORAGE_GUARD = '/Users/rogan/bin/storage-guard';
const READ_ONLY_MUTATION_METHODS = new Set([
  'googleDriveCreate', 'googleDriveUpdate', 'gmailSend',
  'notionCreatePage', 'notionUpdatePage', 'notionAppendBlocks',
  'browserOpen', 'browserNavigate', 'browserAct', 'browserHistory', 'browserRecipe',
  'notionReaOpen', 'notionReaNavigate', 'notionReaAct',
  'browserWorkspaceSnapshot', 'browserWorkspaceRestore', 'browserWorkspaceFocus', 'browserWorkspaceOpen',
  'vaultRequestCredential'
]);

function storageBudgetForCommand(command, explicitBudget) {
  if (explicitBudget !== undefined) {
    const value = Number(explicitBudget);
    if (!Number.isFinite(value) || value <= 0 || value > 10000) throw new Error('storagePeakGiB must be between 0 and 10000.');
    return value;
  }
  const value = String(command || '');
  if (/\b(xcodebuild|cargo\s+build|flutter\s+build|electron-builder|npm\s+(?:run\s+)?build|pnpm\s+(?:run\s+)?build|yarn\s+(?:run\s+)?build)\b/i.test(value)) return 8;
  if (/\b(npm\s+(?:ci|install)|pnpm\s+install|yarn\s+install|cargo\s+(?:fetch|check)|flutter\s+pub\s+get)\b/i.test(value)) return 4;
  if (/\b(zip|ditto|tar|7z|asar)\b|\b(curl|wget)\b[^\n]*(?:\s-o\s|\s-O\s|--output(?:=|\s))/i.test(value)) return 2;
  return null;
}

function shellInvocation(command, platform = process.platform, env = process.env) {
  return platform === 'win32'
    ? { executable: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
    : { executable: '/bin/zsh', args: ['-c', command] };
}

function maskQuotedSeparators(value) {
  let quote = null;
  let escaped = false;
  let output = '';
  for (const char of value) {
    if (escaped) {
      output += /[;&|\n]/.test(char) ? ' ' : char;
      escaped = false;
      continue;
    }
    if ((quote === '"' || !quote) && char === '\\') {
      output += char;
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      output += quote && /[;&|\n]/.test(char) ? ' ' : char;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    output += char;
  }
  return output;
}

// shortcut: regex matching covers known direct and nested shell forms, not arbitrary syntax; use an OS-enforced power boundary for broader guarantees.
function isDirectPowerAction(command, depth = 0, inheritedPowerVariables = new Set()) {
  const value = String(command || '');
  const detectionValue = maskQuotedSeparators(value).replace(/\\(?=[A-Za-z])/g, ' ');
  const commandPrefix = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=(?:[^\s;&|]+|"[^"]*"|'[^']*')|sudo(?:\s+[-\w=]+)*|env(?:\s+(?:[-\w=]+|[A-Z_][A-Z0-9_]*=[^\s]+))*|command|exec|eval|nohup|setsid|nice(?:\s+-n\s+\d+)?|timeout(?:\s+\d+(?:\.\d+)?[smhd]?))\s+`;
  const commandPath = String.raw`(?:(?:/|\.{1,2}/)?(?:[^/\s;&|]+/)*)`;
  const commandName = name => `(?:${commandPath}(?:${name})|"${commandPath}(?:${name})"|'${commandPath}(?:${name})')`;
  const powerCommand = name => `(?:^\\s*|[;&|\\n]\\s*)(?:${commandPrefix})*${commandName(name)}(?=\\s|$)`;
  const shellWord = `(?:[^\\s;&|]+|"[^\"]*"|'[^']*')`;
  const pmsetCommand = new RegExp(`(?:^\\s*|[;&|\\n]\\s*)(?:${commandPrefix})*${commandName('pmset')}(?:\\s+((?:[^\\s;&|]+|\"[^\"]*\"|'[^']*')))?`, 'gim');
  const pmsetCalls = [...detectionValue.matchAll(pmsetCommand)].map(match => {
    const start = match.index + match[0].indexOf(match[0].trimStart());
    const original = value.slice(start, start + match[0].trimStart().length);
    const quotedCommand = /(?:\"pmset\"|'pmset')\s+([\"'][^\"']+[\"'])/i.exec(original);
    const firstArg = quotedCommand ? quotedCommand[1] : match[1];
    const readOnlyQuotedArg = firstArg && /^([\"'])-g\1$/.test(firstArg) ? '-g' : firstArg;
    return [match[0], readOnlyQuotedArg];
  });
  const systemPowerCommand = new RegExp(`(?:^\\s*|[;&|\\n]\\s*)(?:${commandPrefix})*${commandName('systemctl|loginctl')}\\s+(?:suspend|hibernate|poweroff|reboot|hybrid-sleep|suspend-then-hibernate)\\b`, 'im').test(detectionValue);
  const osascriptCommand = new RegExp(`(?:^\\s*|[;&|\\n]\\s*)(?:${commandPrefix})*${commandName('osascript')}(?=\\s|$)`, 'im').test(detectionValue);
  const envSplitPower = /(?:^|[;&|]\s*)(?:(?:sudo(?:\s+[-\w=]+)*|nohup|setsid|nice(?:\s+-n\s+\d+)?|timeout(?:\s+\d+(?:\.\d+)?[smhd]?)?)\s+)*(?:\/[^\s;&|]+\/)?env\s+-S\s+(?:"[^"]*\b(?:pmset|shutdown|reboot|poweroff|halt|systemsetup)\b[^"]*"|'[^']*\b(?:pmset|shutdown|reboot|poweroff|halt|systemsetup)\b[^']*')/im;
  const powerAliasMatch = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:["']?)(?:\/[^\s;&|"'`]+\/)?(?:pmset|shutdown|reboot|poweroff|halt|systemsetup)\b[^;&|"'`]*["']?\s*;\s*["']?\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))["']?(?:\s|$)/i.exec(value);
  const powerAlias = Boolean(powerAliasMatch && powerAliasMatch[1] === (powerAliasMatch[2] || powerAliasMatch[3]));
  const assignedCommandMatch = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*?);([\s\S]*)$/i.exec(value);
  const assignedPowerExecutable = Boolean(assignedCommandMatch
    && /(?:^|[\/\s("'`])(?:pmset|shutdown|reboot|poweroff|halt|systemsetup|systemctl|loginctl|osascript)(?=$|[\/\s)"'`])/i.test(assignedCommandMatch[2]));
  const powerVariables = new Set(inheritedPowerVariables);
  if (assignedPowerExecutable) powerVariables.add(assignedCommandMatch[1]);
  const dynamicPowerAlias = (() => {
    if (!assignedPowerExecutable) return false;
    const [, variable, , remainingCommand] = assignedCommandMatch;
    const escapedVariable = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const invokedAtCommandPosition = new RegExp(
      `(?:^|[;&|\\n]\\s*)(?:${commandPrefix})*["']?\\$(?:\\{${escapedVariable}\\}|${escapedVariable})["']?(?=\\s|$)`,
      'm'
    ).test(`;${remainingCommand}`);
    return invokedAtCommandPosition;
  })();
  const indirectPowerVariable = [...powerVariables].some(variable => {
    const escapedVariable = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
      `(?:^|[;&|\\n]\\s*)(?:${commandPrefix})*["']?\\$(?:\\{${escapedVariable}\\}|${escapedVariable})["']?(?=\\s|$)`,
      'm'
    ).test(detectionValue);
  });
  const nestedShellCommand = new RegExp(`(?:^\\s*|[;&|\\n]\\s*)(?:${commandPrefix})*${commandName('sh|bash|zsh|dash')}\\s+-[a-z]*c[a-z]*\\s+(["'])([\\s\\S]*?)\\1`, 'dgim');
  const nestedEvalCommand = new RegExp(`(?:^\\s*|[;&|\\n]\\s*)(?:${commandPrefix})*${commandName('eval')}\\s+(["'])([\\s\\S]*?)\\1`, 'dgim');
  for (const nestedCommand of [nestedShellCommand, nestedEvalCommand]) {
    for (const match of detectionValue.matchAll(nestedCommand)) {
      const script = value.slice(match.indices[2][0], match.indices[2][1]);
      if (depth >= 8 || isDirectPowerAction(script, depth + 1, powerVariables)) return true;
    }
  }
  const unquoteShellWord = word => typeof word === 'string' && /^(\"|')([\\s\\S]*)\\1$/.test(word) ? word.slice(1, -1) : word;
  return powerAlias
    || dynamicPowerAlias
    || indirectPowerVariable
    || pmsetCalls.some(([, firstArg]) => { const normalizedArg = unquoteShellWord(firstArg); return normalizedArg !== '-g'; })
    || envSplitPower.test(detectionValue)
    || new RegExp(powerCommand('shutdown|reboot|poweroff|halt'), 'im').test(detectionValue)
    || new RegExp(powerCommand('systemsetup') + `\\s+-set[a-z-]+\\b`, 'im').test(detectionValue)
    || systemPowerCommand
    || (osascriptCommand && /\bosascript\b[\s\S]*?\btell\s+application\s+["'](?:System Events|Finder)["'][\s\S]*?\b(?:sleep|shut down|restart|log out)\b/i.test(value));
}

class ToolRegistry {
  constructor(options = {}) {
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.sandboxRoot = options.sandboxRoot ? path.resolve(options.sandboxRoot) : null;
    this.commandRunner = options.commandRunner || null;
    this.providerConnectionsEnabled = options.providerConnectionsEnabled !== false;
    this.approvalPolicy = options.approvalPolicy || 'on-request'; // 'never', 'on-request', 'read-only'
    this.activeProcesses = new Map();

    // Google Workspace & Notion Connectors
    this.google = options.googleConnector || new GoogleConnector(options.connectorOptions || {});
    this.notion = options.notionConnector || new NotionConnector(options.connectorOptions || {});
    this.notionMcp = options.notionMcpConnector || new NotionMcpConnector(options.notionMcpOptions || {});
    this.spaceKeeper = options.spaceKeeperConnector || new SpaceKeeperConnector(options.spaceKeeperOptions || {});
    this.taskRegistryStore = options.taskRegistryStore || null;
    this.macWindowsDevelopment = options.macWindowsDevelopment || null;

    // Desktop hosts may inject their own embedded browser; CLI keeps Aside.
    this.browser = options.browserEnabled === false ? null : (options.browser || new AsideBrowser());
    this.notionRea = options.browserEnabled === false ? null : (options.notionReaBrowser || new NotionReaBrowser());

    // Secure Passkey & Credential Vault
    this.vault = options.vault || new PasskeyVault(options.vaultOptions || {});

    // Sovereign Chrome & Firefox Browser Workspace
    this.browserWorkspace = options.browserWorkspace || new BrowserWorkspace(options.browserWorkspaceOptions || {});
  }

  setWorkspace(dir) {
    this.workspaceDir = path.resolve(dir);
  }

  _assertMutationAllowed(method) {
    if (this.approvalPolicy === 'read-only') throw new Error(`${method} is blocked under read-only policy.`);
  }

  resolvePath(relOrAbsPath) {
    const resolved = path.resolve(path.isAbsolute(relOrAbsPath) ? relOrAbsPath : path.resolve(this.workspaceDir, relOrAbsPath));
    if (this.sandboxRoot) {
      const relative = path.relative(this.sandboxRoot, resolved);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path is outside the isolated profile.');
      const realSandboxRoot = fs.realpathSync(this.sandboxRoot);
      let existing = resolved;
      while (!fs.existsSync(existing) && existing !== path.dirname(existing)) existing = path.dirname(existing);
      const realExisting = fs.realpathSync(existing);
      const realTarget = fs.existsSync(resolved)
        ? fs.realpathSync(resolved)
        : path.resolve(realExisting, path.relative(existing, resolved));
      const realRelative = path.relative(realSandboxRoot, realTarget);
      if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error('Path resolves outside the isolated profile.');
    }
    return resolved;
  }

  /**
   * Execute bash/zsh shell command with streaming output
   */
  async execCommand(command, onChunk = null, options = {}) {
    if (this.approvalPolicy === 'read-only') {
      throw new Error('Shell commands are blocked under read-only policy.');
    }
    if (isDirectPowerAction(command)) {
      throw new Error('Direct power actions are blocked. Submit an approval request through the Only Chat 35Closer Timer tools.');
    }
    if (this.sandboxRoot) {
      if (!this.commandRunner) throw new Error('Shell commands are disabled in isolated mode.');
      return this.commandRunner(command, onChunk, options);
    }
    const cwd = options.cwd ? this.resolvePath(options.cwd) : this.workspaceDir;
    const storagePeakGiB = process.platform === 'darwin'
      ? storageBudgetForCommand(command, options.storagePeakGiB)
      : null;
    const timeoutMs = options.timeoutMs || (storagePeakGiB ? 30 * 60 * 1000 : 120000);
    const task = String(options.storageTask || 'only-chat-command').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128);

    return new Promise((resolve, reject) => {
      const shell = shellInvocation(command);
      const executable = storagePeakGiB ? STORAGE_GUARD : shell.executable;
      const args = storagePeakGiB
        ? ['run', '--task', task, '--peak-gib', String(storagePeakGiB), '--target', '/System/Volumes/Data', '--', shell.executable, ...shell.args]
        : shell.args;
      const child = spawn(executable, args, {
        cwd,
        env: { ...process.env, PATH: process.env.PATH },
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32'
      });
      if (options.input !== undefined) child.stdin.end(options.input);

      const pid = child.pid;
      this.activeProcesses.set(pid, child);

      let stdout = '';
      let stderr = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        if (process.platform === 'win32') child.kill('SIGTERM');
        else {
          try { process.kill(-pid, 'SIGTERM'); }
          catch (error) { if (error.code !== 'ESRCH') child.kill('SIGTERM'); }
        }
      }, timeoutMs);

      child.stdout.on('data', chunk => {
        const text = chunk.toString();
        stdout += text;
        if (onChunk) onChunk({ type: 'stdout', text });
      });

      child.stderr.on('data', chunk => {
        const text = chunk.toString();
        stderr += text;
        if (onChunk) onChunk({ type: 'stderr', text });
      });

      child.on('close', code => {
        clearTimeout(timer);
        this.activeProcesses.delete(pid);
        resolve({
          exitCode: killed ? 124 : (code ?? 0),
          stdout,
          stderr,
          timedOut: killed,
          ...(storagePeakGiB ? { storageGuard: { task, peakGiB: storagePeakGiB } } : {})
        });
      });

      child.on('error', err => {
        clearTimeout(timer);
        this.activeProcesses.delete(pid);
        reject(err);
      });
    });
  }

  /**
   * Read file content
   */
  async readFile(filePath, startLine = 1, endLine = null) {
    const fullPath = this.resolvePath(filePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split('\n');
    
    if (startLine > 1 || endLine !== null) {
      const s = Math.max(1, startLine) - 1;
      const e = endLine !== null ? Math.min(lines.length, endLine) : lines.length;
      return lines.slice(s, e).join('\n');
    }
    return content;
  }

  /**
   * Write or overwrite file
   */
  async writeFile(filePath, content) {
    if (this.approvalPolicy === 'read-only') throw new Error('write_file is blocked under read-only policy.');
    const fullPath = this.resolvePath(filePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content, 'utf8');
    return { path: fullPath, bytes: Buffer.byteLength(content) };
  }

  /**
   * Edit file via targeted replacement
   */
  async editFile(filePath, target, replacement) {
    if (this.approvalPolicy === 'read-only') throw new Error('edit_file is blocked under read-only policy.');
    const fullPath = this.resolvePath(filePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Cannot edit missing file: ${filePath}`);
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    if (!content.includes(target)) {
      throw new Error(`Target string not found in ${filePath}`);
    }
    const updated = content.replaceAll(target, replacement);
    fs.writeFileSync(fullPath, updated, 'utf8');
    return { path: fullPath, modified: true };
  }

  /**
   * Apply patch / git diff
   */
  async applyPatch(patchString) {
    if (this.approvalPolicy === 'read-only') throw new Error('apply_patch is blocked under read-only policy.');
    return this.execCommand('git apply -', null, { input: patchString });
  }

  // =========================================================================
  // Google Workspace (Drive & Gmail Edit Tools)
  // =========================================================================

  async googleDriveList(options = {}) {
    if (!this.providerConnectionsEnabled) throw new Error('Google Drive is disabled in isolated mode.');
    return this.google.driveListFiles(options);
  }

  async googleDriveRead(fileId) {
    if (!this.providerConnectionsEnabled) throw new Error('Google Drive is disabled in isolated mode.');
    return this.google.driveReadFile(fileId);
  }

  async googleDriveCreate(name, mimeType, content, parentId) {
    this._assertMutationAllowed('google_drive_create');
    if (!this.providerConnectionsEnabled) throw new Error('Google Drive is disabled in isolated mode.');
    return this.google.driveCreateFile(name, mimeType, content, parentId);
  }

  async googleDriveUpdate(fileId, content, mimeType) {
    this._assertMutationAllowed('google_drive_update');
    if (!this.providerConnectionsEnabled) throw new Error('Google Drive is disabled in isolated mode.');
    return this.google.driveUpdateFile(fileId, content, mimeType);
  }

  async gmailList(options = {}) {
    if (!this.providerConnectionsEnabled) throw new Error('Gmail is disabled in isolated mode.');
    return this.google.gmailListMessages(options);
  }

  async gmailRead(messageId) {
    if (!this.providerConnectionsEnabled) throw new Error('Gmail is disabled in isolated mode.');
    return this.google.gmailReadMessage(messageId);
  }

  async gmailSend(to, subject, bodyText) {
    this._assertMutationAllowed('gmail_send');
    if (!this.providerConnectionsEnabled) throw new Error('Gmail is disabled in isolated mode.');
    return this.google.gmailSendMessage(to, subject, bodyText);
  }

  // =========================================================================
  // Notion Database & Page Tools
  // =========================================================================

  async notionSearch(query = '', filterKind = null) {
    if (!this.providerConnectionsEnabled) throw new Error('Notion is disabled in isolated mode.');
    return this.notion.search(query, filterKind);
  }

  async notionQueryDatabase(databaseId, filter = null, sorts = null) {
    if (!this.providerConnectionsEnabled) throw new Error('Notion is disabled in isolated mode.');
    return this.notion.queryDatabase(databaseId, filter, sorts);
  }

  async notionCreatePage(databaseId, title, properties = {}, children = []) {
    this._assertMutationAllowed('notion_create_page');
    if (!this.providerConnectionsEnabled) throw new Error('Notion is disabled in isolated mode.');
    return this.notion.createPage(databaseId, title, properties, children);
  }

  async notionUpdatePage(pageId, properties = {}) {
    this._assertMutationAllowed('notion_update_page');
    if (!this.providerConnectionsEnabled) throw new Error('Notion is disabled in isolated mode.');
    return this.notion.updatePage(pageId, properties);
  }

  async notionAppendBlocks(blockId, blocks = []) {
    this._assertMutationAllowed('notion_append_blocks');
    if (!this.providerConnectionsEnabled) throw new Error('Notion is disabled in isolated mode.');
    return this.notion.appendBlocks(blockId, blocks);
  }

  async notionApiRead(method, endpoint, query = {}, body = null) {
    if (!this.providerConnectionsEnabled) throw new Error('Notion is disabled in isolated mode.');
    return this.notion.apiRead(method, endpoint, query, body);
  }

  async notionApiWrite(method, endpoint, body) {
    this._assertMutationAllowed('notion_api_write');
    if (!this.providerConnectionsEnabled) throw new Error('Notion is disabled in isolated mode.');
    return this.notion.apiWrite(method, endpoint, body);
  }

  async notionMcpTools() {
    if (!this.providerConnectionsEnabled) throw new Error('Notion is disabled in isolated mode.');
    return this.notionMcp.listTools();
  }

  async notionMcpCallTool(name, args = {}) {
    if (!this.providerConnectionsEnabled) throw new Error('Notion is disabled in isolated mode.');
    return this.notionMcp.callTool(name, args);
  }

  async notionReaOpen(url) {
    this._assertMutationAllowed('notion_rea_open');
    if (!this.notionRea) throw new Error('Notion REA is unavailable in isolated mode.');
    return this.notionRea.open(url);
  }

  async notionReaNavigate(url) {
    this._assertMutationAllowed('notion_rea_navigate');
    if (!this.notionRea) throw new Error('Notion REA is unavailable in isolated mode.');
    return this.notionRea.navigate(url);
  }

  async notionReaRead() {
    if (!this.notionRea) throw new Error('Notion REA is unavailable in isolated mode.');
    return this.notionRea.read();
  }

  async notionReaSearch(query) {
    if (!this.notionRea) throw new Error('Notion REA is unavailable in isolated mode.');
    return this.notionRea.search(query);
  }

  async notionReaAria() {
    if (!this.notionRea) throw new Error('Notion REA is unavailable in isolated mode.');
    return this.notionRea.aria();
  }

  async notionReaAct(action) {
    this._assertMutationAllowed('notion_rea_act');
    if (!this.notionRea) throw new Error('Notion REA is unavailable in isolated mode.');
    return this.notionRea.act(action);
  }

  async notionReaStatus() {
    if (!this.notionRea) throw new Error('Notion REA is unavailable in isolated mode.');
    return this.notionRea.status();
  }

  isNotionMcpReadOnlyCall(call) {
    return call?.name === 'notion_mcp_call_tool' && this.notionMcp.isReadOnlyTool(call.args?.tool_name);
  }

  async spaceKeeperSessionReport(taskKey) {
    return this.spaceKeeper.sessionReport(taskKey);
  }

  async spaceKeeperCapacityStatus() {
    return this.spaceKeeper.capacityStatus();
  }

  taskRegistryList(options = {}) {
    if (!this.taskRegistryStore) throw new Error('Shared task registry is unavailable in this runtime.');
    return this.taskRegistryStore.listTasks({ status: options.status, limit: options.limit });
  }

  taskRegistryRead(taskKey) {
    if (!this.taskRegistryStore) throw new Error('Shared task registry is unavailable in this runtime.');
    return this.taskRegistryStore.getTask(taskKey);
  }

  taskRegistryCreate(input, creatorChatId) {
    if (!this.taskRegistryStore) throw new Error('Shared task registry is unavailable in this runtime.');
    return this.taskRegistryStore.createTask({ ...input, creatorChatId });
  }

  taskRegistryClaim(input, ownerChatId) {
    if (!this.taskRegistryStore) throw new Error('Shared task registry is unavailable in this runtime.');
    return this.taskRegistryStore.claimTask({ ...input, ownerChatId });
  }

  taskRegistryCheckpoint(input, ownerChatId) {
    if (!this.taskRegistryStore) throw new Error('Shared task registry is unavailable in this runtime.');
    return this.taskRegistryStore.updateCheckpoint({ ...input, ownerChatId });
  }

  taskRegistryMessages(input, viewerChatId) {
    if (!this.taskRegistryStore) throw new Error('Shared task registry is unavailable in this runtime.');
    return this.taskRegistryStore.listMessages({ ...input, viewerChatId });
  }

  taskRegistrySend(input, senderChatId) {
    if (!this.taskRegistryStore) throw new Error('Shared task registry is unavailable in this runtime.');
    return this.taskRegistryStore.sendMessage({ ...input, senderChatId, type: 'message' });
  }

  taskRegistryAck(input, senderChatId) {
    if (!this.taskRegistryStore) throw new Error('Shared task registry is unavailable in this runtime.');
    return this.taskRegistryStore.sendMessage({
      taskKey: input.taskKey,
      senderChatId,
      type: 'ack',
      inReplyToMessageId: input.messageId,
      text: input.text,
      idempotencyKey: input.idempotencyKey
    });
  }

  taskRegistryCheck(input) {
    if (!this.taskRegistryStore) throw new Error('Shared task registry is unavailable in this runtime.');
    return this.taskRegistryStore.lookupVerification(input);
  }

  taskRegistryRecordCheck(input, idempotencyKey) {
    if (!this.taskRegistryStore) throw new Error('Shared task registry is unavailable in this runtime.');
    return this.taskRegistryStore.recordVerification({ ...input, idempotencyKey });
  }

  jointDevelopmentList(input = {}) {
    if (!this.macWindowsDevelopment) throw new Error('Mac-Windows joint development is unavailable in this runtime.');
    return this.macWindowsDevelopment.list(input.limit);
  }

  jointDevelopmentRead(taskKey) {
    if (!this.macWindowsDevelopment) throw new Error('Mac-Windows joint development is unavailable in this runtime.');
    return this.macWindowsDevelopment.get(taskKey);
  }

  jointDevelopmentAssess(input) {
    if (!this.macWindowsDevelopment) throw new Error('Mac-Windows joint development is unavailable in this runtime.');
    return this.macWindowsDevelopment.assess(input);
  }

  jointDevelopmentCreate(input, ownerChatId) {
    if (!this.macWindowsDevelopment) throw new Error('Mac-Windows joint development is unavailable in this runtime.');
    return this.macWindowsDevelopment.createAfterAssessment(input, `joint-development-create:${ownerChatId || 'unknown-session'}`);
  }

  // =========================================================================
  // Built-in Aside / REA Browser Tools
  // =========================================================================

  async browserOpen(url) {
    this._assertMutationAllowed('browser_open');
    if (!this.browser) throw new Error('Browser is disabled in isolated mode.');
    return this.browser.launch(url);
  }

  async browserNavigate(url) {
    this._assertMutationAllowed('browser_navigate');
    if (!this.browser) throw new Error('Browser is disabled in isolated mode.');
    return this.browser.navigate(url);
  }

  async browserAria(tabId = null) {
    if (!this.browser) throw new Error('Browser is disabled in isolated mode.');
    return this.browser.getAriaTree(tabId);
  }

  async browserAct(action) {
    this._assertMutationAllowed('browser_act');
    if (!this.browser) throw new Error('Browser is disabled in isolated mode.');
    return this.browser.act(action);
  }

  async browserRead() {
    if (!this.browser) throw new Error('Browser is disabled in isolated mode.');
    return this.browser.readText();
  }

  async browserHistory(action) {
    this._assertMutationAllowed('browser_history');
    if (!this.browser) throw new Error('Browser is disabled in isolated mode.');
    if (typeof this.browser.history !== 'function') return { ok: false, stderr: '브라우저 뒤로/앞으로/새로고침 제어를 사용할 수 없습니다.' };
    return this.browser.history(action);
  }

  async browserRecipe(recipeName, tabId = null) {
    this._assertMutationAllowed('browser_recipe');
    if (!this.browser) throw new Error('Browser is disabled in isolated mode.');
    return this.browser.recipePlay(recipeName, tabId);
  }

  async browserStatus() {
    if (!this.browser) return { enabled: false };
    return this.browser.getStatus();
  }

  // =========================================================================
  // Passkey & Credential Vault Access
  // =========================================================================

  async vaultRequestCredential(service) {
    this._assertMutationAllowed('vault_get_credential');
    return this.vault.requestAccessForAi(service);
  }

  // =========================================================================
  // Chrome & Firefox Browser Workspace Tools
  // =========================================================================

  async browserWorkspaceList(browser = 'chrome') {
    return this.browserWorkspace.listTabs(browser);
  }

  async browserWorkspaceSnapshot(name, browser = 'chrome') {
    this._assertMutationAllowed('browser_workspace_snapshot');
    return this.browserWorkspace.snapshot(name, browser);
  }

  async browserWorkspaceRestore(name, browser = 'chrome') {
    this._assertMutationAllowed('browser_workspace_restore');
    return this.browserWorkspace.restore(name, browser);
  }

  async browserWorkspaceFocus(query) {
    this._assertMutationAllowed('browser_workspace_focus');
    return this.browserWorkspace.focusTab(query);
  }

  async browserWorkspaceOpen(url, browser = 'chrome') {
    this._assertMutationAllowed('browser_workspace_open');
    return this.browserWorkspace.openTab(url, browser);
  }

  async browserWorkspaceListSaved() {
    return this.browserWorkspace.listWorkspaces();
  }
}

module.exports = { ToolRegistry, shellInvocation, storageBudgetForCommand };
