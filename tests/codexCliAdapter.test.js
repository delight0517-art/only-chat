'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { CodexCliAdapter } = require('../src/providers/CodexCliAdapter.js');
const { assignedDisplay } = require('../src/connectors/OnlyChatAgentDisplayInfoMcpServer.js');
const { providerFailureCategory } = require('../src/core/AgentEngine.js');
const { createToolSummary } = require('../bin/codex.js');

test('CLI summary counts tools and marks command failure as task failure', () => {
  const summary = createToolSummary();
  const originalLog = console.log;
  console.log = () => {};
  try {
    summary.onToolStart({ id: 'failed-command', name: 'exec_command' });
    summary.onToolEnd({ call: { id: 'failed-command', name: 'exec_command' }, result: { exitCode: 1 } });
    summary.onToolStart({ id: 'successful-read', name: 'read_file' });
    summary.onToolEnd({ call: { id: 'successful-read', name: 'read_file' }, result: { ok: true } });
    assert.deepEqual(summary.counts(), { total: 2, failed: 1, successful: 1 });
  } finally {
    console.log = originalLog;
  }
});

function makeToken(email) {
  return `header.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.signature`;
}

function createProfile(profilePath, email) {
  fs.mkdirSync(profilePath, { recursive: true });
  fs.writeFileSync(path.join(profilePath, 'auth.json'), JSON.stringify({ tokens: { id_token: makeToken(email) } }));
}

test('Codex runs coding tools inside the selected workspace and reports tool events', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-codex-adapter-test-'));
  try {
    const dataDir = path.join(root, 'data');
    const workspaceDir = path.join(root, 'workspace');
    const profileDir = path.join(dataDir, 'codex-profiles', 'codex-primary');
    fs.mkdirSync(workspaceDir, { recursive: true });
    createProfile(profileDir, 'primary@example.com');

    let spawnArgs;
    let spawnEnv;
    let agentPrompt = '';
    let workspaceApproval;
    const fakeSpawn = (_command, args, options) => {
      spawnArgs = args;
      spawnEnv = options.env;
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdin.on('data', chunk => { agentPrompt += chunk.toString('utf8'); });
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      const outputPath = args[args.indexOf('--output-last-message') + 1];
      const events = [
        { type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: "printf 'OK'" } },
        { type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', command: "printf 'OK'", exit_code: 0, stdout: 'OK', stderr: '' } },
        { type: 'item.started', item: { id: 'cmd-2', type: 'command_execution', command: "printf 'FLUTTER'" } },
        { type: 'item.completed', item: { id: 'cmd-2', type: 'command_execution', command: "printf 'FLUTTER'", exit_code: 0, aggregated_output: 'FLUTTER' } },
        { type: 'item.completed', item: { id: 'edit-1', type: 'file_change', changes: [{ path: path.join(workspaceDir, 'result.txt'), kind: { type: 'add' } }] } }
      ];
      child.stdin.resume();
      child.stdout.end(events.map(event => JSON.stringify(event)).join('\n') + '\n', () => {
        fs.writeFileSync(outputPath, '작업 완료');
        child.emit('close', 0);
      });
      return child;
    };

    const adapter = new CodexCliAdapter({ dataDir, defaultCodexHome: path.join(root, 'empty-home'), command: '/fake/codex', spawn: fakeSpawn });
    const toolStarts = [];
    const toolEnds = [];
    const toolOutput = [];
    const messages = [];
    const executorInstructions = 'Codex CLI tool policy: use exec_command; do not request Only Chat-only tools.';
    const response = await adapter.call(
      { id: 'codex-primary', model: 'gpt-6-luna', email: 'primary@example.com' },
      [{ role: 'system', content: executorInstructions }, { role: 'user', content: '이 폴더의 파일을 수정해줘.' }],
      {
        onToolStart: call => toolStarts.push(call),
        onToolEnd: result => toolEnds.push(result),
        onToolOutput: output => toolOutput.push(output.text),
        onMessageDelta: text => messages.push(text)
      },
      {
        workspaceDir, reasoningEffort: 'low', approvalPolicy: 'on-request',
        requestWorkspaceWriteApproval: async request => { workspaceApproval = request; return true; }
      }
    );

    assert.equal(response.content, '작업 완료');
    assert.deepEqual(response.toolCalls, []);
    assert.equal(spawnArgs[spawnArgs.indexOf('--sandbox') + 1], 'workspace-write');
    assert.ok(spawnArgs.includes('approval_policy="never"'), 'the non-interactive child cannot independently approve sandbox escalations');
    assert.equal(workspaceApproval.directory, workspaceDir);
    assert.match(workspaceApproval.reason, /Codex CLI는 이 요청 중 셸 명령을 실행하고 작업공간 파일을 수정할 수 있습니다/);
    if (process.platform === 'darwin') assert.match(workspaceApproval.reason, /35Closer 도구.*별도 승인이 필요합니다/);
    const trustedInstructions = spawnArgs.find(arg => String(arg).startsWith('developer_instructions='));
    assert.ok(trustedInstructions, 'the child receives trusted developer instructions');
    assert.ok(trustedInstructions.includes(executorInstructions));
    if (process.platform === 'darwin') {
      assert.match(trustedInstructions, /Mac 전원 안전 규칙/);
      assert.match(trustedInstructions, /직접 실행하지 마세요/);
      assert.ok(spawnArgs.includes('mcp_servers.onlychat_35closer.enabled=true'));
      assert.ok(spawnArgs.includes(`mcp_servers.onlychat_35closer.args=${JSON.stringify([path.join(__dirname, '../src/connectors/OnlyChat35CloserMcpServer.js')])}`));
      assert.equal(spawnEnv.ONLY_CHAT_35CLOSER_CLI, path.join(os.homedir(), 'appDev/devtool/35Closer_App/scripts/35closerctl'));
      assert.doesNotMatch(agentPrompt, /Mac 전원 안전 규칙/);
    }
    assert.equal(spawnArgs[spawnArgs.indexOf('--cd') + 1], workspaceDir);
    assert.equal(spawnArgs.some(arg => String(arg).includes('onlychat_mac_screen')), false);
    assert.equal(spawnEnv.CODEX_HOME, profileDir);
    assert.match(agentPrompt, /대상 경로가 분명하지 않으면 먼저 경로를 물어보세요/);
    assert.match(agentPrompt, /도구 실행의 성공 결과가 확인된 경우에만 변경을 완료했다고 말하고/);
    assert.match(agentPrompt, /쉬운 한국어로 간단히 쓰고/);
    assert.doesNotMatch(agentPrompt, /SYSTEM\n/);
    assert.match(agentPrompt, /USER\n이 폴더의 파일을 수정해줘/);
    assert.equal(toolStarts.length, 3);
    assert.equal(toolStarts[0].name, 'exec_command');
    assert.equal(toolStarts[1].name, 'exec_command');
    assert.equal(toolStarts[2].name, 'file_change');
    assert.equal(toolEnds.length, 3);
    assert.deepEqual(toolOutput, ['OK', 'FLUTTER']);
    assert.deepEqual(messages, ['작업 완료']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex on-request policy fails closed without explicit workspace approval', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-codex-workspace-approval-'));
  try {
    const dataDir = path.join(root, 'data');
    const workspaceDir = path.join(root, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    createProfile(path.join(dataDir, 'codex-profiles', 'codex-primary'), 'primary@example.com');
    let spawnCount = 0;
    const adapter = new CodexCliAdapter({
      dataDir, defaultCodexHome: path.join(root, 'empty-home'), command: '/fake/codex',
      spawn: () => { spawnCount++; throw new Error('must not spawn'); }
    });
    const tier = { id: 'codex-primary', model: 'gpt-6-luna', email: 'primary@example.com' };
    const history = [{ role: 'user', content: '파일을 수정해줘.' }];
    await assert.rejects(adapter.call(tier, history, {}, { workspaceDir, reasoningEffort: 'low' }), error => error.category === 'approval_required');
    await assert.rejects(adapter.call(tier, history, {}, {
      workspaceDir, reasoningEffort: 'low', approvalPolicy: 'on-request',
      requestWorkspaceWriteApproval: async request => {
        assert.equal(request.directory, workspaceDir);
        return false;
      }
    }), error => error.category === 'approval_denied');
    assert.equal(spawnCount, 0, 'the Codex CLI must not start before write-scope approval');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex read-only policy removes write, screen, and power-request capabilities', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-codex-read-only-'));
  try {
    const dataDir = path.join(root, 'data');
    const workspaceDir = path.join(root, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    createProfile(path.join(dataDir, 'codex-profiles', 'codex-primary'), 'primary@example.com');
    let spawnArgs;
    let spawnEnv;
    const adapter = new CodexCliAdapter({
      dataDir, defaultCodexHome: path.join(root, 'empty-home'), command: '/fake/codex',
      spawn: (_command, args, options) => {
        spawnArgs = args;
        spawnEnv = options.env;
        const child = new EventEmitter();
        child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
        const outputPath = args[args.indexOf('--output-last-message') + 1];
        setImmediate(() => { fs.writeFileSync(outputPath, '읽기 완료'); child.emit('close', 0); });
        return child;
      }
    });
    adapter.macScreenBridge = () => ({ enabled: true, port: 8899, token: 'test-token' });
    const response = await adapter.call(
      { id: 'codex-primary', model: 'gpt-6-luna', email: 'primary@example.com' },
      [{ role: 'user', content: '파일을 읽어줘.' }], {},
      { workspaceDir, reasoningEffort: 'low', approvalPolicy: 'read-only', requestWorkspaceWriteApproval: () => assert.fail('read-only does not request write approval') }
    );
    assert.equal(response.content, '읽기 완료');
    assert.equal(spawnArgs[spawnArgs.indexOf('--sandbox') + 1], 'read-only');
    assert.ok(spawnArgs.includes('approval_policy="never"'));
    assert.ok(spawnArgs.includes('mcp_servers.onlychat_google.enabled=true'), 'read-only Google tools remain available');
    assert.ok(!spawnArgs.some(arg => String(arg).includes('onlychat_35closer')));
    assert.ok(!spawnArgs.some(arg => String(arg).includes('onlychat_mac_screen')));
    assert.equal(spawnEnv.ONLY_CHAT_MAC_SCREEN_PORT, '');
    assert.equal(spawnEnv.ONLY_CHAT_MAC_SCREEN_TOKEN, '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex exposes Only Chat Mac screen tools only when the local opt-in is enabled', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-codex-mac-screen-test-'));
  try {
    const dataDir = path.join(root, 'data');
    const workspaceDir = path.join(root, 'workspace');
    const profileDir = path.join(dataDir, 'codex-profiles', 'codex-primary');
    fs.mkdirSync(workspaceDir, { recursive: true });
    createProfile(profileDir, 'primary@example.com');
    let spawnArgs;
    let spawnEnv;
    const fakeSpawn = (_command, args, options) => {
      spawnArgs = args;
      spawnEnv = options.env;
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
      const outputPath = args[args.indexOf('--output-last-message') + 1];
      child.stdout.end('', () => { fs.writeFileSync(outputPath, '완료'); child.emit('close', 0); });
      return child;
    };
    const adapter = new CodexCliAdapter({ dataDir, defaultCodexHome: path.join(root, 'empty-home'), command: '/fake/codex', spawn: fakeSpawn });
    adapter.macScreenBridge = () => ({ enabled: true, port: 8899, token: 'ephemeral-test-token' });
    let approvalReason = '';
    await adapter.call({ id: 'codex-primary', model: 'gpt-6-luna', email: 'primary@example.com' },
      [{ role: 'user', content: '현재 화면을 확인해줘.' }], {}, {
        workspaceDir, reasoningEffort: 'low', approvalPolicy: 'on-request',
        requestWorkspaceWriteApproval: async request => { approvalReason = request.reason; return true; }
      });
    assert.ok(spawnArgs.includes('mcp_servers.onlychat_mac_screen.enabled=true'));
    assert.ok(spawnArgs.some(arg => String(arg).includes('MacScreenControlMcpServer.js')));
    assert.equal(spawnEnv.ONLY_CHAT_MAC_SCREEN_PORT, '8899');
    assert.equal(spawnEnv.ONLY_CHAT_MAC_SCREEN_TOKEN, 'ephemeral-test-token');
    assert.match(approvalReason, /사용자가 켠 Mac 화면 제어로 화면을 읽거나 조작/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Codex routes only the assigned Only Chat session to its private Cua Driver socket', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-'));
  let socketServer;
  try {
    const dataDir = path.join(root, 'd');
    const workspaceDir = path.join(root, 'w');
    const socketDir = path.join(dataDir, 'agent-workspaces');
    const socketPath = path.join(socketDir, 'a.sock');
    const cuaDriverPath = path.join(root, 'cua-driver');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    createProfile(path.join(dataDir, 'codex-profiles', 'codex-primary'), 'primary@example.com');
    fs.writeFileSync(cuaDriverPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    fs.chmodSync(cuaDriverPath, 0o700);
    await new Promise((resolve, reject) => {
      socketServer = net.createServer();
      socketServer.once('error', reject);
      socketServer.listen(socketPath, resolve);
    });
    const assignmentPath = path.join(dataDir, 'agent-workspaces.json');
    fs.writeFileSync(assignmentPath, JSON.stringify({
      mcpServers: {},
      onlyChatSessionAssignments: { version: 1, sessions: {
        'session-1': {
          agentID: 'only-chat', socketPath, displayInfoServer: 'agent-display-101',
          virtualDisplay: { displayID: 101, frame: { x: -1280, y: 0, width: 1280, height: 800 } }
        }
      } }
    }), { mode: 0o600 });
    let spawnArgs;
    const fakeSpawn = (_command, args) => {
      spawnArgs = args;
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
      const outputPath = args[args.indexOf('--output-last-message') + 1];
      child.stdout.end('', () => { fs.writeFileSync(outputPath, '완료'); child.emit('close', 0); });
      return child;
    };
    const adapter = new CodexCliAdapter({ dataDir, defaultCodexHome: path.join(root, 'empty-home'), command: '/fake/codex', spawn: fakeSpawn });
    adapter.cuaDriverPath = cuaDriverPath;
    const tier = { id: 'codex-primary', model: 'gpt-6-luna', email: 'primary@example.com' };
    let approvalReason = '';
    const common = {
      workspaceDir, reasoningEffort: 'low', approvalPolicy: 'on-request',
      requestWorkspaceWriteApproval: async request => { approvalReason = request.reason; return true; }
    };
    await adapter.call(tier, [{ role: 'user', content: '작업을 해줘.' }], {}, { ...common, sessionId: 'session-1' });
    assert.ok(spawnArgs.includes('mcp_servers.onlychat_agent_workspace.enabled=true'));
    assert.ok(spawnArgs.includes(`mcp_servers.onlychat_agent_workspace.args=${JSON.stringify(['mcp', '--socket', socketPath])}`));
    assert.ok(spawnArgs.includes('mcp_servers.onlychat_assigned_display.enabled=true'));
    const displayArgsConfig = spawnArgs.find(arg => String(arg).startsWith('mcp_servers.onlychat_assigned_display.args='));
    const displayArgs = JSON.parse(displayArgsConfig.slice(displayArgsConfig.indexOf('=') + 1));
    assert.deepEqual(displayArgs.slice(1, 5), ['--agent-id', 'only-chat', '--display-id', '101']);
    assert.equal(displayArgs[5], '--cua-session');
    assert.match(displayArgs[6], /^only-chat:[a-f0-9]{24}$/);
    assert.deepEqual(displayArgs.slice(7), ['--x', '-1280', '--y', '0', '--width', '1280', '--height', '800']);
    assert.match(approvalReason, /이 Only Chat 대화에 배정된 워크스테이션/);
    await adapter.call(tier, [{ role: 'user', content: '도구를 사용하지 말고 답해줘.' }], {}, { ...common, sessionId: 'session-1', toolProfile: 'no-tools' });
    assert.ok(!spawnArgs.some(arg => String(arg).includes('onlychat_agent_workspace')), 'explicit no-tools mode cannot attach the desktop bridge');
    assert.ok(!spawnArgs.some(arg => String(arg).includes('onlychat_assigned_display')), 'explicit no-tools mode cannot attach display context');
    await adapter.call(tier, [{ role: 'user', content: '작업을 해줘.' }], {}, { ...common, sessionId: 'session-2' });
    assert.ok(!spawnArgs.some(arg => String(arg).includes('onlychat_agent_workspace')));
    fs.writeFileSync(assignmentPath, JSON.stringify({ version: 1, sessions: { 'session-1': { socketPath } } }), { mode: 0o600 });
    await adapter.call(tier, [{ role: 'user', content: '작업을 해줘.' }], {}, { ...common, sessionId: 'session-1' });
    assert.ok(spawnArgs.includes('mcp_servers.onlychat_agent_workspace.enabled=true'), 'legacy CUA-only assignment remains supported');
    assert.ok(!spawnArgs.some(arg => String(arg).includes('onlychat_assigned_display')), 'legacy assignment does not invent a virtual display');
    fs.chmodSync(assignmentPath, 0o644);
    await adapter.call(tier, [{ role: 'user', content: '작업을 해줘.' }], {}, { ...common, sessionId: 'session-1' });
    assert.ok(!spawnArgs.some(arg => String(arg).includes('onlychat_agent_workspace')), 'shared or group-readable route configuration fails closed');
    assert.ok(!spawnArgs.some(arg => String(arg).includes('onlychat_assigned_display')), 'shared or group-readable config cannot attach display context');
  } finally {
    if (socketServer) await new Promise(resolve => socketServer.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assigned display context validates its CUA session and reports advisory bounds', () => {
  const display = assignedDisplay(['--agent-id', 'only-chat', '--display-id', '101', '--cua-session', 'only-chat:session-1', '--x', '-1280', '--y', '0', '--width', '1280', '--height', '800']);
  assert.equal(display.displayID, 101);
  assert.equal(display.cuaSession, 'only-chat:session-1');
  assert.equal(display.frameEnforced, false);
  assert.throws(() => assignedDisplay(['--agent-id', 'only-chat', '--display-id', '0', '--cua-session', 'only-chat:session-1', '--x', '0', '--y', '0', '--width', '1280', '--height', '800']));
});

test('Codex account profiles are not reused across email identities', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-codex-profile-test-'));
  try {
    const dataDir = path.join(root, 'data');
    createProfile(path.join(dataDir, 'codex-profiles', 'codex-primary'), 'primary@example.com');
    const adapter = new CodexCliAdapter({ dataDir, defaultCodexHome: path.join(root, 'empty-home'), command: '/fake/codex', spawn: () => { throw new Error('must not spawn'); } });
    assert.equal(adapter.getReadiness({ id: 'codex-secondary', email: 'secondary@example.com' }).connected, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex CLI permission failures are surfaced as recoverable sandbox errors', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-codex-permission-test-'));
  try {
    const dataDir = path.join(root, 'data');
    const workspaceDir = path.join(root, 'workspace');
    const profileDir = path.join(dataDir, 'codex-profiles', 'codex-primary');
    fs.mkdirSync(workspaceDir, { recursive: true });
    createProfile(profileDir, 'primary@example.com');
    const fakeSpawn = () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
      setImmediate(() => {
        child.stderr.write('flutter/bin/cache/lockfile: Operation not permitted (EPERM)');
        child.emit('close', 1);
      });
      return child;
    };
    const adapter = new CodexCliAdapter({ dataDir, defaultCodexHome: path.join(root, 'empty-home'), command: '/fake/codex', spawn: fakeSpawn });
    let failure;
    try {
      await adapter.call({ id: 'codex-primary', model: 'gpt-6-luna', email: 'primary@example.com' },
        [{ role: 'user', content: 'Flutter 테스트를 실행해줘.' }], {}, { workspaceDir, reasoningEffort: 'low', approvalPolicy: 'never' });
    } catch (error) { failure = error; }
    assert.match(failure?.message || '', /파일 접근을 권한 또는 작업공간 샌드박스에서 차단/);
    assert.equal(providerFailureCategory(failure), 'sandbox_permission_blocked');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Flutter loopback test-server denial is distinguished from a source test failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-codex-loopback-test-'));
  try {
    const dataDir = path.join(root, 'data');
    const workspaceDir = path.join(root, 'workspace');
    const profileDir = path.join(dataDir, 'codex-profiles', 'codex-primary');
    fs.mkdirSync(workspaceDir, { recursive: true });
    createProfile(profileDir, 'primary@example.com');
    const fakeSpawn = () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
      setImmediate(() => {
        child.stdout.end(`${JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'flutter-test',
            type: 'command_execution',
            command: 'flutter test --no-pub test/feedback_app_version_payload_test.dart',
            exit_code: 1,
            aggregated_output: 'Failed to create server socket (OS Error: Operation not permitted, errno = 1), address = 127.0.0.1, port = 0'
          }
        })}\n`, () => child.emit('close', 1));
      });
      return child;
    };
    const adapter = new CodexCliAdapter({ dataDir, defaultCodexHome: path.join(root, 'empty-home'), command: '/fake/codex', spawn: fakeSpawn });
    let failure;
    try {
      await adapter.call({ id: 'codex-primary', model: 'gpt-6-luna', email: 'primary@example.com' },
        [{ role: 'user', content: 'Flutter 테스트를 실행해줘.' }], {}, { workspaceDir, reasoningEffort: 'low', approvalPolicy: 'never' });
    } catch (error) { failure = error; }
    assert.match(failure?.message || '', /테스트용 로컬 서버\(127\.0\.0\.1\) 열기를 차단/);
    assert.match(failure?.message || '', /테스트 코드 오류가 아니라 실행 환경 제한/);
    assert.equal(providerFailureCategory(failure), 'sandbox_permission_blocked');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Flutter CLI cache is added to the sandbox only after exact-path approval', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-codex-flutter-approval-'));
  const originalPath = process.env.PATH;
  try {
    const dataDir = path.join(root, 'data');
    const workspaceDir = path.join(root, 'workspace');
    const profileDir = path.join(dataDir, 'codex-profiles', 'codex-primary');
    const sdkBin = path.join(root, 'flutter-sdk', 'bin');
    const cacheDir = path.join(sdkBin, 'cache');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'pubspec.yaml'), 'name: fixture\n');
    fs.writeFileSync(path.join(sdkBin, 'flutter'), '#!/bin/sh\n');
    fs.chmodSync(path.join(sdkBin, 'flutter'), 0o755);
    createProfile(profileDir, 'primary@example.com');
    process.env.PATH = `${sdkBin}${path.delimiter}${originalPath || ''}`;

    let spawnArgs;
    const fakeSpawn = (_command, args) => {
      spawnArgs = args;
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
      const outputPath = args[args.indexOf('--output-last-message') + 1];
      setImmediate(() => { fs.writeFileSync(outputPath, '테스트 완료'); child.emit('close', 0); });
      return child;
    };
    const adapter = new CodexCliAdapter({ dataDir, defaultCodexHome: path.join(root, 'empty-home'), command: '/fake/codex', spawn: fakeSpawn });
    let approvalRequest;
    const response = await adapter.call(
      { id: 'codex-primary', model: 'gpt-6-luna', email: 'primary@example.com' },
      [{ role: 'user', content: 'Run flutter test test/example_test.dart' }], {},
      { workspaceDir, reasoningEffort: 'low', approvalPolicy: 'never', requestWorkspaceWriteApproval: async request => { approvalRequest = request; return true; } }
    );

    assert.equal(response.content, '테스트 완료');
    assert.deepEqual(approvalRequest, {
      directory: await fs.promises.realpath(cacheDir),
      reason: 'Flutter 테스트·빌드는 SDK 캐시에 잠금 및 도구 파일을 쓸 수 있습니다.'
    });
    assert.deepEqual(spawnArgs.slice(spawnArgs.indexOf('--add-dir'), spawnArgs.indexOf('--add-dir') + 2), ['--add-dir', await fs.promises.realpath(cacheDir)]);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Flutter cache write scope is never added when approval is rejected or policy is read-only', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-codex-flutter-reject-'));
  const originalPath = process.env.PATH;
  try {
    const dataDir = path.join(root, 'data');
    const workspaceDir = path.join(root, 'workspace');
    const profileDir = path.join(dataDir, 'codex-profiles', 'codex-primary');
    const sdkBin = path.join(root, 'flutter-sdk', 'bin');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(path.join(sdkBin, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'pubspec.yaml'), 'name: fixture\n');
    fs.writeFileSync(path.join(sdkBin, 'flutter'), '#!/bin/sh\n');
    fs.chmodSync(path.join(sdkBin, 'flutter'), 0o755);
    createProfile(profileDir, 'primary@example.com');
    process.env.PATH = `${sdkBin}${path.delimiter}${originalPath || ''}`;
    let spawnCount = 0;
    const adapter = new CodexCliAdapter({ dataDir, defaultCodexHome: path.join(root, 'empty-home'), command: '/fake/codex', spawn: () => { spawnCount++; throw new Error('must not spawn'); } });
    const tier = { id: 'codex-primary', model: 'gpt-6-luna', email: 'primary@example.com' };
    const history = [{ role: 'user', content: 'Run flutter test test/example_test.dart' }];

    await assert.rejects(adapter.call(tier, history, {}, {
      workspaceDir, reasoningEffort: 'low', approvalPolicy: 'never', requestWorkspaceWriteApproval: async () => false
    }), error => error.category === 'approval_denied' && /승인이 거부되었습니다/.test(error.message));
    await assert.rejects(adapter.call(tier, history, {}, {
      workspaceDir, reasoningEffort: 'low', approvalPolicy: 'read-only', requestWorkspaceWriteApproval: async () => { assert.fail('read-only must not request approval'); }
    }), error => error.category === 'sandbox_permission_blocked' && /읽기 전용 정책/.test(error.message));
    assert.equal(spawnCount, 0);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
