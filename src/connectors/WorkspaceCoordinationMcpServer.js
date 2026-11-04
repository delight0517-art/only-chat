'use strict';

const readline = require('node:readline');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const DEFAULT_AGENT_COORD = path.join(os.homedir(), '.codex/bin/agent-coord');
const TASK_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const LEASE_ID = /^[a-f0-9-]{36}$/i;
const MAX_PATHS = 40;
const MAX_LEASE_MINUTES = 60;

const tools = [
  {
    name: 'workspace_lease_status',
    description: 'Read agent-coord edit/integration/deploy leases for Only Chat’s selected Git repository. Optionally pass the exact relative files you plan to edit to get path-level conflicts. Results apply only to this repository and this lease registry; they do not report other lock systems, active writers, or app runtime state. A lease on one path does not block unrelated paths. Lease status is advisory; never edit a path owned by another task.',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', minItems: 1, maxItems: MAX_PATHS, items: { type: 'string', minLength: 1, maxLength: 256 } } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'workspace_lease_claim',
    description: 'Claim an edit lease for explicit relative files in the selected Git workspace before changing them. Only regular files under the selected workspace are accepted; repository-wide and external paths are rejected. Leases expire within 60 minutes.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' },
        paths: { type: 'array', minItems: 1, maxItems: MAX_PATHS, items: { type: 'string', minLength: 1, maxLength: 256 } },
        lease_minutes: { type: 'integer', minimum: 1, maximum: MAX_LEASE_MINUTES }
      },
      required: ['task', 'paths'], additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'workspace_lease_release',
    description: 'Release only an active lease previously claimed by this Only Chat session.',
    inputSchema: {
      type: 'object', properties: { lease_id: { type: 'string', pattern: '^[a-fA-F0-9-]{36}$' } },
      required: ['lease_id'], additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
];

function parseJson(stdout, message) {
  try { return JSON.parse(String(stdout || '').trim()); }
  catch (_) { throw new Error(message); }
}

function createServer(options = {}) {
  const workspaceInput = options.workspaceDir || process.env.ONLY_CHAT_WORKSPACE_DIR || '';
  if (!workspaceInput) throw new Error('Only Chat workspace coordination is not configured.');
  const workspaceDir = fs.realpathSync(path.resolve(workspaceInput));
  const sessionId = String(options.sessionId || process.env.ONLY_CHAT_SESSION_ID || '');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) throw new Error('Only Chat session identity is unavailable.');
  const owner = `onlychat-${crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 20)}`;
  const cliPath = path.resolve(options.cliPath || process.env.ONLY_CHAT_AGENT_COORD_CLI || DEFAULT_AGENT_COORD);
  const execImpl = options.execFileSync || execFileSync;
  const runAgentCoord = options.runAgentCoord || ((args) => {
    try {
      return execImpl(cliPath, args, {
        cwd: workspaceDir, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      const detail = String(error?.stderr || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 240);
      throw new Error(detail || 'Workspace coordination command failed.');
    }
  });
  const readOwnedLeaseRows = options.readOwnedLeaseRows;
  const readRepoLeaseRows = options.readRepoLeaseRows || ((repo) => {
    const dbPath = path.join(os.homedir(), '.codex/agent-coordination/leases.sqlite3');
    const script = [
      'import json, sqlite3, sys, time',
      'db, repo = sys.argv[1:3]',
      'con = sqlite3.connect("file:" + db + "?mode=ro", uri=True, timeout=2)',
      'rows = con.execute("SELECT id, workspace, mode, task, paths, owner, expires_at FROM leases WHERE repo=? AND expires_at>? ORDER BY created_at", (repo, time.time())).fetchall()',
      'print(json.dumps([{"id": r[0], "workspace": r[1], "mode": r[2], "task": r[3], "paths": json.loads(r[4]), "owner": r[5], "expiresAt": r[6]} for r in rows]))',
      'con.close()'
    ].join('; ');
    const raw = execImpl('python3', ['-c', script, dbPath, repo], {
      cwd: workspaceDir, encoding: 'utf8', timeout: 3000, maxBuffer: 32 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const rows = parseJson(raw, 'Could not read the repository-scoped lease evidence.');
    if (!Array.isArray(rows)) throw new Error('Repository-scoped lease evidence is invalid.');
    return rows;
  });

  function repoIdentity() {
    const root = path.resolve(String(execImpl('git', ['-C', workspaceDir, 'rev-parse', '--show-toplevel'], {
      cwd: workspaceDir, encoding: 'utf8', timeout: 2000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore']
    })).trim());
    if (root !== workspaceDir) throw new Error('Lease operations require the selected workspace to be the Git repository root.');
    const commonDir = String(execImpl('git', ['-C', workspaceDir, 'rev-parse', '--git-common-dir'], {
      cwd: workspaceDir, encoding: 'utf8', timeout: 2000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore']
    })).trim();
    if (!commonDir) throw new Error('Git repository identity is unavailable.');
    return { root, repo: path.resolve(workspaceDir, commonDir) };
  }

  function validatePaths(values) {
    if (!Array.isArray(values) || values.length < 1 || values.length > MAX_PATHS) throw new Error(`paths must contain 1 to ${MAX_PATHS} files.`);
    const result = [...new Set(values.map(value => {
      if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\\') || value.includes('\0') || path.isAbsolute(value)) {
        throw new Error('Lease paths must be relative files inside the selected workspace.');
      }
      const parts = value.split('/');
      if (parts.some(part => !part || part === '.' || part === '..') || parts.includes('.git')) {
        throw new Error('Lease paths must be normalized relative file paths outside .git.');
      }
      let current = workspaceDir;
      for (let index = 0; index < parts.length; index += 1) {
        current = path.join(current, parts[index]);
        try {
          const stat = fs.lstatSync(current);
          if (stat.isSymbolicLink()) throw new Error('Lease paths cannot follow symbolic links.');
          if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('Lease parent paths must be directories.');
          if (index === parts.length - 1 && !stat.isFile()) throw new Error('Lease targets must be regular files or new file paths.');
        } catch (error) {
          if (error.code === 'ENOENT' && index === parts.length - 1) continue;
          if (error.code === 'ENOENT') throw new Error('Lease parent directory does not exist.');
          throw error;
        }
      }
      const relative = path.relative(workspaceDir, current);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Lease paths must identify a file inside the selected workspace.');
      return relative;
    }))];
    return result.sort();
  }

  function ownedLeaseRows(repo) {
    if (typeof readOwnedLeaseRows === 'function') return readOwnedLeaseRows({ workspaceDir, repo, owner });
    const dbPath = path.join(os.homedir(), '.codex/agent-coordination/leases.sqlite3');
    const script = [
      'import json, sqlite3, sys, time',
      'db, repo, owner = sys.argv[1:4]',
      'con = sqlite3.connect("file:" + db + "?mode=ro", uri=True, timeout=2)',
      'rows = con.execute("SELECT id, mode, task, paths, expires_at FROM leases WHERE repo=? AND owner=? AND expires_at>?", (repo, owner, time.time())).fetchall()',
      'print(json.dumps([{"id": r[0], "mode": r[1], "task": r[2], "paths": json.loads(r[3]), "expiresAt": r[4]} for r in rows]))',
      'con.close()'
    ].join('; ');
    const raw = execImpl('python3', ['-c', script, dbPath, repo, owner], {
      cwd: workspaceDir, encoding: 'utf8', timeout: 3000, maxBuffer: 32 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const rows = parseJson(raw, 'Could not read this session’s active lease IDs.');
    if (!Array.isArray(rows)) throw new Error('Workspace lease registry returned an invalid result.');
    return rows.filter(row => row && typeof row.id === 'string' && LEASE_ID.test(row.id));
  }

  async function invoke(name, args = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
    const identity = repoIdentity();
    const repo = identity.root;
    if (name === 'workspace_lease_status') {
      if (Object.keys(args).some(key => key !== 'paths')) throw new Error('Unsupported workspace lease status arguments.');
      const requestedPaths = args.paths === undefined ? [] : validatePaths(args.paths);
      runAgentCoord(['status', '--repo', repo]);
      const rows = readRepoLeaseRows(identity.repo);
      if (rows.some(row => !row || !['edit', 'integrate', 'deploy'].includes(row.mode) || !Array.isArray(row.paths))) {
        throw new Error('Repository-scoped lease evidence is incomplete.');
      }
      const requestedAbsolute = requestedPaths.map(item => path.resolve(workspaceDir, item));
      const overlaps = (left, right) => left.some(a => right.some(b => {
        const relative = path.relative(a, b);
        const reverse = path.relative(b, a);
        return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
          || reverse === '' || (!reverse.startsWith(`..${path.sep}`) && reverse !== '..' && !path.isAbsolute(reverse));
      }));
      const conflicts = requestedPaths.length ? rows.filter(row => {
        if (row.mode === 'deploy') return true;
        if (row.mode === 'integrate') return !row.paths.length || overlaps(requestedAbsolute, row.paths);
        return row.workspace === workspaceDir && overlaps(requestedAbsolute, row.paths);
      }) : [];
      return {
        repository: repo,
        workspace: workspaceDir,
        scope: 'Only this Git common repository and active agent-coord edit/integration/deploy leases',
        leaseKinds: ['edit', 'integrate', 'deploy'],
        checkedAt: new Date().toISOString(),
        evidenceComplete: true,
        activeLeaseCount: rows.length,
        leases: rows.map(row => ({ ...row, repositoryWide: row.paths.length === 0 })),
        requestedPaths,
        pathAssessment: requestedPaths.length ? {
          kind: 'edit-path lease conflict check only',
          status: conflicts.length ? 'conflict' : 'no-agent-coord-conflict',
          conflictingLeaseIds: conflicts.map(row => row.id)
        } : { kind: 'edit-path lease conflict check only', status: 'not-requested' },
        limitation: 'This result does not report workspace execution leases, other coordination registries, ordinary file writers, or application runtime locks. A no-agent-coord-conflict result applies only to the requested paths in this repository and cannot establish that the repository or product is globally unlocked.'
      };
    }
    if (name === 'workspace_lease_claim') {
      if (Object.keys(args).some(key => !['task', 'paths', 'lease_minutes'].includes(key))) throw new Error('Unsupported lease claim arguments.');
      if (typeof args.task !== 'string' || !TASK_KEY.test(args.task)) throw new Error('task is invalid.');
      const paths = validatePaths(args.paths);
      const leaseMinutes = args.lease_minutes === undefined ? 15 : args.lease_minutes;
      if (!Number.isInteger(leaseMinutes) || leaseMinutes < 1 || leaseMinutes > MAX_LEASE_MINUTES) throw new Error(`lease_minutes must be 1 to ${MAX_LEASE_MINUTES}.`);
      const raw = runAgentCoord(['claim', '--mode', 'edit', '--repo', repo, '--task', args.task, '--owner', owner,
        '--lease-minutes', String(leaseMinutes), '--paths', ...paths]);
      const result = parseJson(raw, 'Workspace lease claim returned invalid JSON.');
      if (!result?.lease_id || !LEASE_ID.test(result.lease_id) || !Array.isArray(result.paths)) throw new Error('Workspace lease claim did not return a valid lease.');
      return { ...result, owner };
    }
    if (name === 'workspace_lease_release') {
      if (Object.keys(args).length !== 1 || typeof args.lease_id !== 'string' || !LEASE_ID.test(args.lease_id)) throw new Error('lease_id is invalid.');
      const rows = ownedLeaseRows(identity.repo);
      const lease = rows.find(row => row.id === args.lease_id);
      if (!lease) throw new Error('Only an active lease owned by this Only Chat session can be released.');
      const result = String(runAgentCoord(['release', lease.id])).trim().slice(0, 240);
      return { released: true, task: lease.task, paths: lease.paths.map(item => path.relative(workspaceDir, item)), result };
    }
    throw new Error(`Unknown workspace coordination tool: ${String(name)}`);
  }

  async function handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
    const id = message.id;
    const reply = (result, error) => error
      ? { jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message: String(error.message || error) } }
      : { jsonrpc: '2.0', id, result };
    try {
      switch (message.method) {
        case 'initialize': return reply({ protocolVersion: message.params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'onlychat-workspace-coordination', version: '1.0.0' } });
        case 'notifications/initialized':
        case 'notifications/cancelled': return null;
        case 'ping': return reply({});
        case 'tools/list': return reply({ tools });
        case 'tools/call': {
          const result = await invoke(message.params?.name, message.params?.arguments || {});
          return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
        }
        default: return id === undefined ? null : reply(null, Object.assign(new Error(`Unsupported method: ${String(message.method)}`), { code: -32601 }));
      }
    } catch (error) {
      if (message.method === 'tools/call') return reply({ content: [{ type: 'text', text: String(error.message || error) }], isError: true });
      return reply(null, error);
    }
  }
  return { tools, invoke, handle };
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

module.exports = { createServer, tools };
