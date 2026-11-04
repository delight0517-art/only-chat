'use strict';

const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const SECRET_NAME = /(?:^|\/)(?:\.env(?:\.[^/]*)?|[^/]*(?:auth|credential|secret|token|cookie)[^/]*\.(?:json|ya?ml|txt)|[^/]+\.(?:pem|key|p12|pfx))$/i;

const readTool = {
  name: 'workspace_file_read',
  description: 'Read a UTF-8 regular file by relative path under Only Chat’s selected workspace. Secret-like files and symlinks are rejected.',
  inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 256 }, start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 } }, required: ['path'], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
};
const editTool = {
  name: 'workspace_file_edit',
  description: 'Edit one exact, unique text occurrence in a regular file under the approved Only Chat workspace. Requires per-turn workspace write approval and a file-scoped lease.',
  inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 256 }, target: { type: 'string', minLength: 1, maxLength: 100000 }, replacement: { type: 'string', maxLength: 100000 } }, required: ['path', 'target', 'replacement'], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
};
const createTool = {
  name: 'workspace_file_create',
  description: 'Create a new UTF-8 file under the approved Only Chat workspace without overwriting an existing file. Requires per-turn workspace write approval and a file-scoped lease.',
  inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 256 }, content: { type: 'string', maxLength: 100000 } }, required: ['path', 'content'], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
};
const checkTool = {
  name: 'workspace_check',
  description: 'Run one bounded Node syntax check, one named tests/*.test.js file, or git diff --check in the selected workspace. No shell is used.',
  inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['syntax', 'test', 'diff'] }, path: { type: 'string', maxLength: 256 } }, required: ['kind'], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
};

function createServer(options = {}) {
  const workspaceInput = options.workspaceDir || process.env.ONLY_CHAT_WORKSPACE_DIR || '';
  if (!workspaceInput) throw new Error('Only Chat workspace tools are not configured.');
  const workspaceDir = fs.realpathSync(path.resolve(workspaceInput));
  const sessionId = String(options.sessionId || process.env.ONLY_CHAT_SESSION_ID || '');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) throw new Error('Only Chat session identity is unavailable.');
  const writeApproved = options.writeApproved === true || process.env.ONLY_CHAT_WRITE_APPROVED === '1';
  const nodePath = options.nodePath || process.execPath;
  const run = options.run || runProcess;
  const tools = writeApproved ? [readTool, editTool, createTool, checkTool] : [readTool];
  const repo = String((options.repo || (() => {
    try {
      const commonDir = execFileSync('git', ['-C', workspaceDir, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', timeout: 2000 }).trim();
      return path.resolve(workspaceDir, commonDir);
    }
    catch (_) { return workspaceDir; }
  })()));
  const owner = `onlychat-${crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 20)}`;
  const readOwnedLeaseRows = options.readOwnedLeaseRows || (() => {
    const database = path.join(os.homedir(), '.codex/agent-coordination/leases.sqlite3');
    const script = [
      'import json, sqlite3, sys, time',
      'db, repo, owner = sys.argv[1:4]',
      'con = sqlite3.connect("file:" + db + "?mode=ro", uri=True, timeout=2)',
      'rows = con.execute("SELECT paths FROM leases WHERE repo=? AND owner=? AND expires_at>?", (repo, owner, time.time())).fetchall()',
      'print(json.dumps([json.loads(row[0]) for row in rows]))',
      'con.close()'
    ].join('; ');
    const output = execFileSync('python3', ['-c', script, database, repo, owner], { cwd: workspaceDir, encoding: 'utf8', timeout: 3000, maxBuffer: 32 * 1024 });
    return JSON.parse(output);
  });

  function assertLease(relative) {
    const paths = readOwnedLeaseRows();
    if (!Array.isArray(paths) || !paths.some(group => Array.isArray(group) && group.some(item => path.resolve(String(item)) === path.join(workspaceDir, relative)))) {
      throw new Error('Claim an active file-scoped workspace lease for this path before editing.');
    }
  }

  function resolveFile(value, allowMissing = false) {
    if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\\') || value.includes('\0') || path.isAbsolute(value)) {
      throw new Error('Workspace paths must be normalized relative file paths.');
    }
    const parts = value.split('/');
    if (parts.some(part => !part || part === '.' || part === '..') || parts.includes('.git')) throw new Error('Workspace paths cannot traverse directories or address .git.');
    const relative = parts.join('/');
    if (SECRET_NAME.test(relative)) throw new Error('Secret-like files are not available through Only Chat workspace tools.');
    let current = workspaceDir;
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index]);
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) throw new Error('Workspace tools do not follow symbolic links.');
        if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('Workspace path parent is not a directory.');
        if (index === parts.length - 1 && !stat.isFile()) throw new Error('Workspace target must be a regular file.');
        if (index === parts.length - 1 && stat.nlink > 1) throw new Error('Workspace tools reject hard-linked files.');
      } catch (error) {
        if (error.code === 'ENOENT' && allowMissing && index === parts.length - 1) continue;
        if (error.code === 'ENOENT') throw new Error('Workspace file or parent directory does not exist.');
        throw error;
      }
    }
    const parent = fs.realpathSync(path.dirname(current));
    const parentRelative = path.relative(workspaceDir, parent);
    if (parentRelative === '..' || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) throw new Error('Workspace path resolves outside the selected workspace.');
    return { fullPath: current, relative };
  }

  function assertWrite(name) {
    if (!writeApproved) throw new Error(`${name} requires Only Chat approval for this workspace.`);
  }

  async function invoke(name, args = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
    if (name === 'workspace_file_read') {
      if (Object.keys(args).some(key => !['path', 'start_line', 'end_line'].includes(key))) throw new Error('Unsupported workspace_file_read arguments.');
      const { fullPath, relative } = resolveFile(args.path);
      const stat = fs.statSync(fullPath);
      if (stat.size > MAX_FILE_BYTES) throw new Error('Workspace file is too large; request a smaller source file.');
      const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
      const start = args.start_line ?? 1;
      const end = args.end_line ?? Math.min(lines.length, start + 399);
      if (!Number.isInteger(start) || !Number.isInteger(end) || end < start || end - start > 399) throw new Error('Read ranges are limited to 400 lines.');
      return { path: relative, startLine: start, endLine: Math.min(end, lines.length), totalLines: lines.length, content: lines.slice(start - 1, end).join('\n') };
    }
    if (name === 'workspace_file_edit') {
      assertWrite(name);
      if (Object.keys(args).length !== 3 || typeof args.target !== 'string' || !args.target || typeof args.replacement !== 'string') throw new Error('path, target, and replacement are required.');
      const { fullPath, relative } = resolveFile(args.path);
      assertLease(relative);
      const stat = fs.statSync(fullPath);
      if (stat.size > MAX_FILE_BYTES) throw new Error('Workspace file is too large to edit.');
      const previous = fs.readFileSync(fullPath, 'utf8');
      const first = previous.indexOf(args.target);
      if (first < 0 || previous.indexOf(args.target, first + args.target.length) >= 0) throw new Error('Edit target must match exactly once.');
      const updated = previous.slice(0, first) + args.replacement + previous.slice(first + args.target.length);
      const temporary = path.join(path.dirname(fullPath), `.onlychat-${crypto.randomBytes(8).toString('hex')}.tmp`);
      try {
        fs.writeFileSync(temporary, updated, { encoding: 'utf8', mode: stat.mode & 0o777, flag: 'wx' });
        fs.renameSync(temporary, fullPath);
      } finally { try { fs.unlinkSync(temporary); } catch (_) {} }
      return { path: relative, modified: true, bytes: Buffer.byteLength(updated) };
    }
    if (name === 'workspace_file_create') {
      assertWrite(name);
      if (Object.keys(args).length !== 2 || typeof args.content !== 'string') throw new Error('path and content are required.');
      const { fullPath, relative } = resolveFile(args.path, true);
      assertLease(relative);
      if (Buffer.byteLength(args.content) > 100_000) throw new Error('New files are limited to 100 KB.');
      fs.writeFileSync(fullPath, args.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return { path: relative, created: true, bytes: Buffer.byteLength(args.content) };
    }
    if (name === 'workspace_check') {
      if (Object.keys(args).some(key => !['kind', 'path'].includes(key))) throw new Error('Unsupported workspace_check arguments.');
      let argv;
      if (args.kind === 'diff' && args.path === undefined) argv = ['-C', workspaceDir, 'diff', '--check'];
      else {
        const { fullPath, relative } = resolveFile(args.path);
        if (args.kind === 'syntax' && relative.endsWith('.js')) argv = ['--check', fullPath];
        else if (args.kind === 'test' && /^tests\/[A-Za-z0-9._/-]+\.test\.js$/.test(relative)) argv = ['--test', fullPath];
        else throw new Error('Checks are limited to Node syntax, one tests/*.test.js file, or git diff --check.');
        return run(nodePath, argv, workspaceDir, 120_000);
      }
      return run('/usr/bin/git', argv, workspaceDir, 10_000);
    }
    throw new Error(`Unknown Only Chat workspace tool: ${String(name)}`);
  }

  async function handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
    const id = message.id;
    const reply = (result, error) => error
      ? { jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message: String(error.message || error) } }
      : { jsonrpc: '2.0', id, result };
    try {
      switch (message.method) {
        case 'initialize': return reply({ protocolVersion: message.params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'onlychat-workspace', version: '1.0.0' } });
        case 'notifications/initialized':
        case 'notifications/cancelled': return null;
        case 'ping': return reply({});
        case 'tools/list': return reply({ tools });
        case 'tools/call': {
          const result = await invoke(message.params?.name, message.params?.arguments || {});
          return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
        }
        default: return id === undefined ? null : reply(null, new Error(`Unsupported method: ${String(message.method)}`));
      }
    } catch (error) {
      if (message.method === 'tools/call') return reply({ content: [{ type: 'text', text: String(error.message || error) }], isError: true });
      return reply(null, error);
    }
  }
  return { tools, invoke, handle, workspaceDir, sessionId, writeApproved };
}

function runProcess(command, args, cwd, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') child.kill('SIGTERM');
      else {
        try { process.kill(-child.pid, 'SIGTERM'); }
        catch (error) { if (error.code !== 'ESRCH') child.kill('SIGTERM'); }
      }
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-MAX_OUTPUT_BYTES); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-MAX_OUTPUT_BYTES); });
    child.on('error', error => { clearTimeout(timer); resolve({ exitCode: 127, error: error.message }); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? 124 : (code ?? 1), timedOut, stdout, stderr, command: [path.basename(command), ...args.map(arg => path.relative(cwd, arg) || arg)] });
    });
  });
}

if (require.main === module) {
  const server = createServer();
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    if (Buffer.byteLength(line) > 1024 * 1024) return;
    try { void server.handle(JSON.parse(line)).then(result => { if (result) process.stdout.write(`${JSON.stringify(result)}\n`); }); }
    catch (_) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC message.' } })}\n`); }
  });
}

module.exports = { createServer, runProcess, readTool, editTool, createTool, checkTool };
