'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { formatHistory } = require('./AntigravityCliAdapter.js');
const { withResponseGuidance } = require('./responseGuidance.js');
const { parseReasoningEffort } = require('../core/ReasoningEffort.js');

function tokenEmail(token) {
  if (typeof token !== 'string') return '';
  const parts = token.split('.');
  if (parts.length < 2) return '';
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return String(claims.email || claims['https://api.openai.com/auth']?.email || '').trim().toLowerCase();
  } catch (_) {
    return '';
  }
}

function profileEmail(profileHome) {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(profileHome, 'auth.json'), 'utf8'));
    const tokens = auth.tokens || auth;
    return [tokenEmail(tokens.id_token), tokenEmail(tokens.access_token)].find(Boolean) || '';
  } catch (_) {
    return '';
  }
}

function failureMessage(text, tier, exitCode) {
  if (/model_not_found|model is not supported/i.test(text)) {
    return `Codex 계정 ${tier.email}에서 ${tier.model} 모델을 사용할 수 없습니다.`;
  }
  if (/failed to create server socket|failed to bind[^\n]*(?:127\.0\.0\.1|localhost)|server socket[^\n]*(?:operation not permitted|permission denied)/i.test(text)) {
    return 'Codex 샌드박스가 Flutter 테스트용 로컬 서버(127.0.0.1) 열기를 차단했습니다. 테스트 코드 오류가 아니라 실행 환경 제한입니다.';
  }
  if (/\b(?:EPERM|EACCES)\b|operation not permitted|permission denied|access denied/i.test(text)) {
    return 'Codex CLI가 필요한 파일 접근을 권한 또는 작업공간 샌드박스에서 차단당했습니다. 허용된 작업공간이나 승인된 캐시 경로를 확인한 뒤 다시 실행해 주세요.';
  }
  if (/\b429\b|rate.?limit|quota|resource.?exhausted/i.test(text)) {
    return `Codex 계정 ${tier.email}의 사용 한도에 도달했습니다.`;
  }
  if (/unauthorized|not logged in|not authenticated|authentication required|login required|logged out|session expired|access token expired/i.test(text)) {
    return `Codex 계정 ${tier.email} 로그인이 필요합니다.`;
  }
  return `Codex ${tier.model || '요청'}이 실패했습니다 (종료 코드 ${exitCode}).`;
}

function flutterCacheFor(workspaceDir, prompt) {
  if (!/\bflutter\s+(?:test|analyze|build|run|pub|get|upgrade)\b/i.test(prompt)
      || !fs.existsSync(path.join(workspaceDir, 'pubspec.yaml'))) return null;
  for (const entry of String(process.env.PATH || '').split(path.delimiter)) {
    const binary = path.join(entry, process.platform === 'win32' ? 'flutter.bat' : 'flutter');
    try {
      if (!fs.statSync(binary).isFile()) continue;
      const sdkRoot = path.dirname(path.dirname(fs.realpathSync(binary)));
      const cache = fs.realpathSync(path.join(sdkRoot, 'bin', 'cache'));
      const relative = path.relative(workspaceDir, cache);
      if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) continue;
      if (fs.statSync(cache).isDirectory()) return cache;
    } catch (_) {}
  }
  return null;
}

class CodexCliAdapter {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir || path.join(os.homedir(), '.my-codex'));
    this.command = options.command || path.join(this.dataDir, 'runtime/codex-cli/node_modules/.bin/codex');
    this.defaultCodexHome = path.resolve(options.defaultCodexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    this.profilesDir = path.join(this.dataDir, 'codex-profiles');
    this.agentWorkspacesFile = path.join(this.dataDir, 'agent-workspaces.json');
    this.cuaDriverPath = path.join(os.homedir(), '.local/bin/cua-driver');
    this.projectRoot = path.resolve(options.projectRoot || path.join(__dirname, '../..'));
    this.googleTokenFile = options.googleTokenFile || null;
    this.powerCliPath = path.resolve(options.powerCliPath || process.env.ONLY_CHAT_35CLOSER_CLI || path.join(os.homedir(), 'appDev/devtool/35Closer_App/scripts/35closerctl'));
    this.macScreenBridge = null;
    this.spawn = options.spawn || spawn;
    this.timeoutMs = options.timeoutMs || 120_000;
    this.loginAttempts = new Map();
    this.authenticationFailures = new Map();
  }

  _accountProfile(tier) {
    const email = String(tier?.email || '').trim().toLowerCase();
    if (!email) return null;
    const id = String(tier?.id || '');
    const candidates = [];
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) candidates.push(path.join(this.profilesDir, id));
    candidates.push(this.defaultCodexHome);
    const seen = new Set();
    for (const home of candidates) {
      if (seen.has(home)) continue;
      seen.add(home);
      if (profileEmail(home) === email) return home;
    }
    return null;
  }

  getReadiness(tier) {
    const hasCli = fs.existsSync(this.command);
    const email = String(tier?.email || '').trim().toLowerCase();
    const profile = hasCli ? this._accountProfile(tier) : null;
    const authenticationFailure = this.authenticationFailures.get(String(tier?.id || ''));
    const connected = Boolean(profile) && !authenticationFailure;
    return {
      available: hasCli,
      connected,
      authenticationRequired: !connected,
      email,
      message: !hasCli ? 'Only Chat 전용 Codex CLI가 없습니다.'
        : authenticationFailure ? 'Codex 인증이 만료되었거나 거부되었습니다. 이 계정에 다시 로그인해 주세요.'
        : profile ? 'Codex 로그인 계정과 등록 이메일이 일치합니다.'
          : `별도 Codex 로그인 필요 · ${email || '계정 이메일 미등록'}`
    };
  }

  markAuthenticationFailure(tier, message = '인증이 필요합니다.') {
    const id = String(tier?.id || '');
    if (!id) return;
    this.authenticationFailures.set(id, String(message).slice(0, 500));
  }

  _agentWorkspaceRoute(sessionId) {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(sessionId)) return null;
    try {
      const configStat = fs.lstatSync(this.agentWorkspacesFile);
      if (!configStat.isFile() || configStat.size > 65_536 || (typeof process.getuid === 'function' && configStat.uid !== process.getuid()) || (configStat.mode & 0o077) !== 0) return null;
      const config = JSON.parse(fs.readFileSync(this.agentWorkspacesFile, 'utf8'));
      const assignments = config.onlyChatSessionAssignments?.version === 1
        ? config.onlyChatSessionAssignments.sessions : null;
      if (assignments && Object.hasOwn(assignments, sessionId) && assignments[sessionId]?.transport === 'spaceo') {
        return { transport: 'spaceo' };
      }
      let route = null;
      if (assignments && Object.hasOwn(assignments, sessionId)) route = assignments[sessionId];
      else if (config.onlyChatSessionAssignments?.version === 1) route = config.onlyChatSessionAssignments.default || null;
      else if (config.version === 1 && config.sessions && Object.hasOwn(config.sessions, sessionId)) route = config.sessions[sessionId];
      if (!route || typeof route !== 'object') return null;
      const socketPath = route.socketPath;
      const socketDir = path.resolve(this.dataDir, 'agent-workspaces');
      const socketDirStat = fs.lstatSync(socketDir);
      if (!socketDirStat.isDirectory() || (typeof process.getuid === 'function' && socketDirStat.uid !== process.getuid()) || (socketDirStat.mode & 0o077) !== 0) return null;
      const socketRoot = socketDir + path.sep;
      const resolvedSocket = path.resolve(String(socketPath || ''));
      if (!resolvedSocket.startsWith(socketRoot)) return null;
      const socketStat = fs.lstatSync(resolvedSocket);
      if (!socketStat.isSocket() || (typeof process.getuid === 'function' && socketStat.uid !== process.getuid())) return null;
      fs.accessSync(this.cuaDriverPath, fs.constants.X_OK);
      let virtualDisplay = null;
      if (route.virtualDisplay !== undefined) {
        const display = route.virtualDisplay;
        const frame = display?.frame;
        if (!Number.isInteger(display?.displayID) || display.displayID < 1
            || !frame || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(frame[key]))
            || frame.width <= 0 || frame.height <= 0
            || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(route.agentID || ''))) return null;
        virtualDisplay = { agentID: String(route.agentID), displayID: display.displayID,
          frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height } };
      }
      return { socketPath: resolvedSocket, virtualDisplay,
        cuaSession: virtualDisplay
          ? `${virtualDisplay.agentID}:${crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 24)}`
          : null };
    } catch (_) {
      return null;
    }
  }

  clearAuthenticationFailure(tier) {
    this.authenticationFailures.delete(String(tier?.id || ''));
  }

  getLoginStatus(tierId) {
    const attempt = this.loginAttempts.get(String(tierId || ''));
    if (!attempt) return { state: 'idle' };
    return {
      state: attempt.state,
      userCode: attempt.userCode || '',
      verificationUrl: attempt.verificationUrl || '',
      message: attempt.message || ''
    };
  }

  startReauthentication(tier) {
    const id = String(tier?.id || '');
    if (!id || tier?.provider !== 'codex') throw new Error('재인증할 Codex 계정을 찾을 수 없습니다.');
    const existing = this.loginAttempts.get(id);
    if (existing?.active) return this.getLoginStatus(id);
    if (!fs.existsSync(this.command)) throw new Error('Only Chat 전용 Codex CLI를 찾을 수 없습니다.');

    const email = String(tier.email || '').trim().toLowerCase();
    const matchingProfile = this._accountProfile(tier);
    const profile = matchingProfile || path.join(this.profilesDir, id);
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    const attempt = { state: 'starting', active: true, userCode: '', verificationUrl: '', message: 'Codex 기기 로그인 시작 중입니다.' };
    this.loginAttempts.set(id, attempt);

    let child;
    try {
      const env = { ...process.env, CODEX_HOME: profile };
      delete env.OPENAI_API_KEY;
      delete env.CODEX_ACCESS_TOKEN;
      delete env.OPENAI_FEDERATION_RULE_ID;
      delete env.OPENAI_IDENTITY_TOKEN_FILE;
      child = this.spawn(this.command, ['login', '--device-auth'], {
        cwd: this.projectRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (_) {
      attempt.active = false;
      attempt.state = 'failed';
      attempt.message = 'Codex 로그인 절차를 시작하지 못했습니다.';
      return this.getLoginStatus(id);
    }

    attempt.outputTail = '';
    const capture = chunk => {
      attempt.outputTail = (attempt.outputTail + String(chunk || '')).slice(-4000);
      const text = attempt.outputTail;
      const code = text.match(/(?:enter|device|user)?\s*code\s*(?:is|:)?\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i)?.[1]
        || text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/)?.[1];
      const urlText = text.match(/https:\/\/auth\.openai\.com\/[A-Za-z0-9/_?=&.-]+/i)?.[0] || '';
      if (code) attempt.userCode = code.toUpperCase();
      if (urlText) {
        try {
          const parsed = new URL(urlText.replace(/[),.;]+$/, ''));
          if (parsed.hostname === 'auth.openai.com') attempt.verificationUrl = parsed.toString();
        } catch (_) {}
      }
      if (attempt.userCode || attempt.verificationUrl) {
        attempt.state = 'waiting';
        attempt.message = '로그인 페이지에서 기기 코드를 입력해 인증을 완료해 주세요.';
      }
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    const timeout = setTimeout(() => {
      if (attempt.state === 'waiting' || attempt.state === 'starting') {
        attempt.state = 'expired';
        attempt.message = '로그인 시간이 초과되었습니다. 다시 시작해 주세요.';
        attempt.userCode = '';
        attempt.verificationUrl = '';
        child.kill?.('SIGTERM');
      }
    }, 10 * 60 * 1000);
    timeout.unref?.();
    child.once?.('error', () => {
      clearTimeout(timeout);
      attempt.active = false;
      attempt.state = 'failed';
      attempt.message = 'Codex 로그인 프로세스를 실행할 수 없습니다.';
    });
    child.once?.('close', code => {
      clearTimeout(timeout);
      attempt.active = false;
      attempt.outputTail = '';
      const actualEmail = profileEmail(profile);
      if (code === 0 && actualEmail && (!email || actualEmail === email)) {
        attempt.state = 'connected';
        attempt.message = `Codex 계정 ${actualEmail} 인증이 완료되었습니다.`;
        this.clearAuthenticationFailure(tier);
      } else if (code === 0 && actualEmail && email && actualEmail !== email) {
        attempt.state = 'wrong-account';
        attempt.message = `다른 계정(${actualEmail})으로 로그인했습니다. ${email} 계정을 선택해 다시 인증해 주세요.`;
      } else if (attempt.state !== 'expired') {
        attempt.state = code === 0 ? 'failed' : 'cancelled';
        attempt.message = code === 0 ? '로그인 계정을 확인하지 못했습니다.' : 'Codex 로그인이 완료되지 않았습니다.';
      }
      attempt.userCode = '';
      attempt.verificationUrl = '';
    });
    return this.getLoginStatus(id);
  }

  async call(tier, history, hooks = {}, context = {}) {
    const profile = this._accountProfile(tier);
    if (!profile) throw new Error(this.getReadiness(tier).message);
    const approvalPolicy = context.approvalPolicy || 'on-request';
    const developerInstructions = history.filter(item => item?.role === 'system')
      .map(item => typeof item.content === 'string' ? item.content : JSON.stringify(item.content ?? ''))
      .filter(Boolean).join('\n\n');
    const macPowerInstructions = process.platform === 'darwin' && approvalPolicy !== 'read-only'
      ? 'Mac 전원 안전 규칙: 사용자가 명시적으로 요청한 절전·깨우기 변경은 onlychat_35closer MCP 도구로 35Closer Timer에 승인 요청만 등록하세요. 35Closer 앱에서 사용자가 승인하기 전에는 전원 상태를 변경하지 마세요. 셸 명령, AppleScript 또는 다른 경로로 절전·깨우기를 직접 실행하지 마세요.'
      : '';
    const workspaceCoordinationInstructions = process.platform === 'darwin' && approvalPolicy !== 'read-only'
      ? 'Only Chat 작업공간 파일을 수정하기 전에 onlychat_workspace_coordination의 workspace_lease_status로 현재 작업공간 lease를 확인하고, 정확한 상대 경로만 workspace_lease_claim으로 claim하세요. 겹치는 다른 작업자의 lease가 있으면 편집하지 말고 다른 TODO를 고르세요. 테스트·커밋 확인을 마친 뒤 claim한 lease를 workspace_lease_release로 해제하세요. 이 도구는 조정용 advisory lease이며 파일 쓰기 승인을 대신하거나 범위를 넓히지 않습니다. 작업공간 밖 경로, 저장소 전체 lease, 새 branch/worktree는 사용하지 마세요. 잠금·소유권을 설명하기 전에는 확인한 각 상태를 저장소/체크아웃, 정확한 경로 또는 리소스, 잠금 종류, 소유자, 확인 시각이 포함된 짧은 근거표로 분리하세요. app-integration-guard의 leases_clear:false는 통합 준비가 끝나지 않았다는 표시이지 저장소 전체 파일 편집 잠금의 증거가 아닙니다. 출력에 적힌 정확한 저장소에서 agent-coord 상태와 lease의 종류·경로·task·owner를 확인하고, 현재 편집 경로와 충돌할 때만 해당 편집을 보류하세요. 조회할 수 없거나 결과가 불완전하면 잠금 상태는 unknown으로 두세요. 경로 edit lease, workspace execution lease, 저장소 integration/deploy lease, 실행 중 writer, 앱 runtime 상태를 서로 다른 측정으로 취급하고 하나를 다른 것으로 추론하지 마세요. 다른 저장소나 다른 작업에서 얻은 결과는 대상 저장소 판단에서 명시적으로 제외하세요. 사용자에게 특정 앱 기능의 잠금 해제나 실제 사용 차단을 보고받으면 저장소 편집 lease를 그 기능의 상태 증거로 사용하지 말고, 해당 앱의 기능 설정·실제 동작·화면/로그를 따로 확인하세요. source에 편집 lease가 없다는 사실은 runtime 기능이 정상이라는 뜻이 아니며, runtime 확인 기록이 없다는 사실도 소스 수정이 불필요하다는 뜻이 아닙니다. 사용자가 앞선 잠금 판단이 틀렸다고 지적하면 먼저 내가 섞거나 과장한 측정값과 잘못된 추론을 구체적으로 인정하고, 대상 리소스를 다시 확인해 결론을 정정하세요. 사용자가 “작업이 막힌다”고 하면 대상 작업과 실제 막힌 동작을 먼저 특정하고, 조회 실패·다른 저장소 결과·통합 준비 상태를 그 막힘의 원인으로 바꿔 말하지 마세요. 대상과 범위가 맞는 근거가 없으면 결론은 unknown/unverified로 남기고, 사용자의 관찰을 반박하지 마세요. hot reload 가능 여부와 source 소유권, 실제 runtime 반영 여부도 별도로 확인하세요.'
      : '';
    let trustedDeveloperInstructions = [withResponseGuidance(), developerInstructions, macPowerInstructions, workspaceCoordinationInstructions].filter(Boolean).join('\n\n');
    const promptHistory = history.filter(item => item?.role !== 'system');
    const prompt = formatHistory(promptHistory);
    if (!prompt.trim()) throw new Error('Codex에 보낼 대화 내용이 없습니다.');
    const effort = parseReasoningEffort(context.reasoningEffort);
    if (!effort) throw new Error('지원하지 않는 추론 강도입니다.');
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(String(tier.model || ''))) throw new Error('Codex 모델 ID가 올바르지 않습니다.');

    const workspaceDir = path.resolve(context.workspaceDir || process.cwd());
    if (!['on-request', 'never', 'read-only'].includes(approvalPolicy)) throw new Error('지원하지 않는 도구 승인 정책입니다.');
    const fullAccess = context.fullAccess === true;
    const exposeSpaceOMaintenance = process.platform === 'darwin' && approvalPolicy === 'on-request'
      && context.toolProfile !== 'no-tools';
    if (fullAccess && approvalPolicy === 'read-only') throw new Error('읽기 전용 승인 정책에서는 Full access를 사용할 수 없습니다.');
    const agentWorkspaceRoute = process.platform === 'darwin' && approvalPolicy !== 'read-only' && context.toolProfile !== 'no-tools'
      ? this._agentWorkspaceRoute(context.sessionId) : null;
    const usesSpaceO = agentWorkspaceRoute?.transport === 'spaceo';
    if (usesSpaceO) {
      trustedDeveloperInstructions += '\n\n이 대화의 Mac 앱 작업은 onlychat_agent_workspace의 SpaceO 전용 세션에서만 수행하세요. 빈 세션을 먼저 만들고 격리 상태와 대상 앱의 창 소유권을 확인하세요. 세션 생성이나 격리 검증이 실패하면 작업을 멈추고 다른 화면 제어 경로로 전환하지 마세요.';
    }
    const screenBridge = approvalPolicy === 'read-only' || context.toolProfile === 'no-tools' || agentWorkspaceRoute
      ? null : this.macScreenBridge?.();
    const agentWorkspaceSocket = agentWorkspaceRoute?.socketPath || null;
    if (fullAccess || approvalPolicy === 'on-request') {
      const approve = context.requestWorkspaceWriteApproval;
      if (typeof approve !== 'function') {
        const error = new Error(fullAccess ? 'Codex Full access 확인을 요청할 수 없습니다.' : 'Codex 작업공간 쓰기 승인을 요청할 수 없습니다.');
        error.category = 'approval_required';
        throw error;
      }
      let approved = false;
      try {
        let reason = fullAccess
          ? 'Full access: Codex CLI가 작업공간 밖의 파일과 시스템 경로에도 접근하고 셸 명령을 실행할 수 있습니다.'
          : 'Codex CLI는 이 요청 중 셸 명령을 실행하고 작업공간 파일을 수정할 수 있습니다.';
        if (process.platform === 'darwin') {
          reason += ' Only Chat의 35Closer 도구로 대기 중 전원 요청을 등록하거나 취소할 수 있으며, 실제 절전·깨우기는 35Closer 앱에서 별도 승인이 필요합니다.';
        }
        if (exposeSpaceOMaintenance) reason += ' 사용자가 요청한 SpaceO 데몬 재시작을 세션 종료 후 실행할 수 있습니다.';
        if (screenBridge?.enabled === true) reason += ' 사용자가 켠 Mac 화면 제어로 화면을 읽거나 조작할 수도 있습니다.';
        if (agentWorkspaceSocket) reason += ' 이 Only Chat 대화에 배정된 워크스테이션의 앱을 읽고 조작할 수 있습니다.';
        approved = await approve({
          directory: workspaceDir,
          reason
        });
      } catch (_) {}
      if (approved !== true) {
        const error = new Error(fullAccess ? 'Codex Full access가 승인되지 않았습니다.' : 'Codex 작업공간 쓰기 승인이 거부되었습니다.');
        error.category = 'approval_denied';
        throw error;
      }
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-codex-'));
    const outputFile = path.join(tempDir, 'answer.txt');
    try {
      const args = [
        'exec', '--ignore-user-config', '--model', tier.model,
        '--sandbox', fullAccess ? 'danger-full-access' : approvalPolicy === 'read-only' ? 'read-only' : 'workspace-write', '--ephemeral', '--json', '--skip-git-repo-check',
        '--cd', workspaceDir,
        '--output-last-message', outputFile,
        '-c', 'mcp_servers.onlychat_google.enabled=true',
        '-c', `mcp_servers.onlychat_google.command=${JSON.stringify(process.execPath)}`,
        '-c', `mcp_servers.onlychat_google.args=${JSON.stringify([path.join(this.projectRoot, 'src/connectors/GoogleWorkspaceMcpServer.js')])}`,
        // Codex CLI is non-interactive here. Only Chat owns approvals, so prevent
        // the child from silently escalating or waiting on an inaccessible prompt.
        '-c', 'approval_policy="never"',
        '-c', `model_reasoning_effort="${effort}"`, '-'
      ];
      if (trustedDeveloperInstructions) args.splice(args.length - 3, 0, '-c', `developer_instructions=${JSON.stringify(trustedDeveloperInstructions)}`);
      if (agentWorkspaceRoute) {
        args.splice(args.length - 3, 0, '-c', 'mcp_servers.onlychat_agent_workspace.required=true');
      }
      if (usesSpaceO) {
        const spaceO = path.join(os.homedir(), '.local', 'bin', 'spaceo');
        args.splice(args.length - 3, 0,
          '-c', 'mcp_servers.onlychat_agent_workspace.enabled=true',
          '-c', `mcp_servers.onlychat_agent_workspace.command=${JSON.stringify(spaceO)}`,
          '-c', 'mcp_servers.onlychat_agent_workspace.args=["mcp"]');
      }
      if (agentWorkspaceSocket) {
        args.splice(args.length - 3, 0,
          '-c', 'mcp_servers.onlychat_agent_workspace.enabled=true',
          '-c', `mcp_servers.onlychat_agent_workspace.command=${JSON.stringify(this.cuaDriverPath)}`,
          '-c', `mcp_servers.onlychat_agent_workspace.args=${JSON.stringify(['mcp', '--socket', agentWorkspaceSocket])}`);
      }
      if (agentWorkspaceRoute?.virtualDisplay) {
        const display = agentWorkspaceRoute.virtualDisplay;
        const serverPath = path.join(this.projectRoot, 'src/connectors/OnlyChatAgentDisplayInfoMcpServer.js');
        args.splice(args.length - 3, 0,
          '-c', 'mcp_servers.onlychat_assigned_display.enabled=true',
          '-c', `mcp_servers.onlychat_assigned_display.command=${JSON.stringify(process.execPath)}`,
          '-c', `mcp_servers.onlychat_assigned_display.args=${JSON.stringify([serverPath,
            '--agent-id', display.agentID, '--display-id', String(display.displayID),
            '--cua-session', agentWorkspaceRoute.cuaSession,
            '--x', String(display.frame.x), '--y', String(display.frame.y),
            '--width', String(display.frame.width), '--height', String(display.frame.height)])}`);
      }
      if (process.platform === 'darwin' && approvalPolicy !== 'read-only') {
        const coordinationServer = path.join(this.projectRoot, 'src/connectors/WorkspaceCoordinationMcpServer.js');
        args.splice(args.length - 3, 0,
          '-c', 'mcp_servers.onlychat_workspace_coordination.enabled=true',
          '-c', `mcp_servers.onlychat_workspace_coordination.command=${JSON.stringify(process.execPath)}`,
          '-c', `mcp_servers.onlychat_workspace_coordination.args=${JSON.stringify([coordinationServer])}`,
          '-c', `mcp_servers.onlychat_workspace_coordination.env.ONLY_CHAT_WORKSPACE_DIR=${JSON.stringify(workspaceDir)}`,
          '-c', `mcp_servers.onlychat_workspace_coordination.env.ONLY_CHAT_SESSION_ID=${JSON.stringify(String(context.sessionId || ''))}`);
        args.splice(args.length - 3, 0,
          '-c', 'mcp_servers.onlychat_35closer.enabled=true',
          '-c', `mcp_servers.onlychat_35closer.command=${JSON.stringify(process.execPath)}`,
          '-c', `mcp_servers.onlychat_35closer.args=${JSON.stringify([path.join(this.projectRoot, 'src/connectors/OnlyChat35CloserMcpServer.js')])}`);
      }
      if (exposeSpaceOMaintenance) {
        const maintenance = path.join(this.projectRoot, 'src/connectors/OnlyChatSpaceOMaintenanceMcpServer.js');
        args.splice(args.length - 3, 0,
          '-c', 'mcp_servers.onlychat_spaceo_maintenance.enabled=true',
          '-c', `mcp_servers.onlychat_spaceo_maintenance.command=${JSON.stringify(process.execPath)}`,
          '-c', `mcp_servers.onlychat_spaceo_maintenance.args=${JSON.stringify([maintenance])}`);
      }
      const flutterCache = fullAccess ? null : flutterCacheFor(workspaceDir, prompt);
      if (flutterCache) {
        if (context.approvalPolicy === 'read-only') {
          const error = new Error('읽기 전용 정책에서는 Flutter SDK 캐시 쓰기를 허용할 수 없습니다.');
          error.category = 'sandbox_permission_blocked';
          throw error;
        }
        const approve = context.requestWorkspaceWriteApproval;
        const approved = typeof approve === 'function' && await approve({
          directory: flutterCache,
          reason: 'Flutter 테스트·빌드는 SDK 캐시에 잠금 및 도구 파일을 쓸 수 있습니다.'
        });
        if (approved !== true) {
          const error = new Error(typeof approve === 'function'
            ? 'Flutter SDK 캐시 쓰기 승인이 거부되었습니다.'
            : 'Flutter SDK 캐시 쓰기 승인을 요청할 수 없습니다.');
          error.category = typeof approve === 'function' ? 'approval_denied' : 'approval_required';
          throw error;
        }
        args.splice(args.indexOf('--ephemeral'), 0, '--add-dir', flutterCache);
      }
      if (screenBridge?.enabled === true && Number.isInteger(screenBridge.port) && screenBridge.port > 0 && screenBridge.token) {
        const serverPath = path.join(this.projectRoot, 'src/connectors/MacScreenControlMcpServer.js');
        args.splice(args.length - 3, 0,
          '-c', 'mcp_servers.onlychat_mac_screen.enabled=true',
          '-c', `mcp_servers.onlychat_mac_screen.command=${JSON.stringify(process.execPath)}`,
          '-c', `mcp_servers.onlychat_mac_screen.args=${JSON.stringify([serverPath])}`);
      }
      const response = await this._run(args, prompt, profile, workspaceDir, tier, hooks, screenBridge, context.sessionId);
      if (!response.trim()) throw new Error(`Codex 계정 ${tier.email}에서 빈 응답을 받았습니다.`);
      hooks.onMessageDelta?.(response);
      return { content: response, toolCalls: [] };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  _run(args, prompt, profile, cwd, tier, hooks, screenBridge = null, sessionId = '') {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawn(this.command, args, {
          cwd,
          env: { ...process.env, CODEX_HOME: profile, ONLY_CHAT_DATA_DIR: this.dataDir, ONLY_CHAT_GOOGLE_TOKEN_FILE: this.googleTokenFile || '',
            ONLY_CHAT_35CLOSER_CLI: this.powerCliPath,
            ONLY_CHAT_WORKSPACE_DIR: cwd,
            ONLY_CHAT_SESSION_ID: String(sessionId || ''),
            ONLY_CHAT_MAC_SCREEN_PORT: screenBridge?.enabled === true ? String(screenBridge.port) : '',
            ONLY_CHAT_MAC_SCREEN_TOKEN: screenBridge?.enabled === true ? screenBridge.token : '' },
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (_) {
        reject(new Error('Only Chat 전용 Codex CLI를 시작할 수 없습니다.'));
        return;
      }
      let stdoutBuffer = '';
      let stdoutTail = '';
      let stderr = '';
      const activeTools = new Map();
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          for (const call of activeTools.values()) hooks.onToolEnd?.({ call, result: { error: error.message } });
          activeTools.clear();
          reject(error);
        } else resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(new Error(`Codex 계정 ${tier.email} 응답 시간이 초과됐습니다.`));
      }, this.timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdoutTail = (stdoutTail + chunk).slice(-12_000);
        stdoutBuffer += chunk;
        if (stdoutBuffer.length > 2 * 1024 * 1024) {
          child.kill('SIGTERM');
          finish(new Error('Codex 응답 크기가 제한을 넘었습니다.'));
          return;
        }
        let newline;
        while ((newline = stdoutBuffer.indexOf('\n')) !== -1) {
          const line = stdoutBuffer.slice(0, newline).trim();
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (line) this._handleEventLine(line, hooks, activeTools);
        }
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12_000); });
      child.on('error', () => finish(new Error('Only Chat 전용 Codex CLI를 실행할 수 없습니다.')));
      child.on('close', code => {
        if (settled) return;
        if (stdoutBuffer.trim()) this._handleEventLine(stdoutBuffer.trim(), hooks, activeTools);
        if (code !== 0) {
          finish(new Error(failureMessage(`${stdoutTail}\n${stderr}`, tier, code)));
          return;
        }
        try {
          const outputPath = args[args.indexOf('--output-last-message') + 1];
          const response = fs.readFileSync(outputPath, 'utf8').trim();
          finish(null, response);
        } catch (_) {
          finish(new Error('Codex 응답을 읽을 수 없습니다.'));
        }
      });
      child.stdin.end([
        'Only Chat의 GPT-6 Luna 코딩 에이전트입니다. 사용자의 요청을 이 작업공간에서 실제로 수행하고, 필요한 경우 Codex 도구로 코드를 읽고 수정하거나 명령을 실행하세요.',
        '작업공간 밖의 파일·서비스·계정에는 접근하지 마세요. 전체 권한 우회 옵션을 사용하지 말고, 빌드·설치·다운로드는 프로젝트 지침의 안전 가드를 따르세요.',
        '파일이나 코드를 바꿔 달라는 요청에서 대상 경로가 분명하지 않으면 먼저 경로를 물어보세요. 실제 도구 실행의 성공 결과가 확인된 경우에만 변경을 완료했다고 말하고, 확인되지 않았으면 완료 여부를 모른다고 설명하세요.',
        '답변은 사용자가 바로 이해할 수 있는 쉬운 한국어로 간단히 쓰고, 실제 작업 시간은 Only Chat이 표시하므로 답변에서 시간을 추측하지 마세요.',
        '',
        prompt
      ].join('\n'));
    });
  }

  _handleEventLine(line, hooks, activeTools) {
    let event;
    try { event = JSON.parse(line); } catch (_) { return; }
    const item = event.item;
    if (!item || !['item.started', 'item.completed'].includes(event.type)) return;

    if (item.type === 'command_execution') {
      const id = String(item.id || item.command || `command-${activeTools.size}`);
      let call = activeTools.get(id);
      if (event.type === 'item.started') {
        if (call) return;
        call = { id, name: 'exec_command', args: { command: item.command || '' } };
        activeTools.set(id, call);
        hooks.onToolStart?.(call);
        return;
      }
      call ||= { id, name: 'exec_command', args: { command: item.command || '' } };
      const stdout = typeof item.stdout === 'string' ? item.stdout : '';
      const stderr = typeof item.stderr === 'string' ? item.stderr : '';
      const aggregatedOutput = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
      const output = [stdout, stderr].filter(Boolean).join('\n') || aggregatedOutput;
      if (output) hooks.onToolOutput?.({ type: stderr ? 'stderr' : 'stdout', text: output.slice(-8000) });
      hooks.onToolEnd?.({ call, result: { exitCode: Number.isInteger(item.exit_code) ? item.exit_code : null, stdout, stderr } });
      activeTools.delete(id);
      return;
    }

    if (item.type === 'mcp_tool_call') {
      const id = String(item.id || `${item.server || 'mcp'}:${item.tool || 'tool'}`);
      let call = activeTools.get(id);
      if (event.type === 'item.started') {
        if (call) return;
        call = { id, name: `MCP · ${item.server || '도구'}/${item.tool || '호출'}`, args: {} };
        activeTools.set(id, call);
        hooks.onToolStart?.(call);
        return;
      }
      call ||= { id, name: `MCP · ${item.server || '도구'}/${item.tool || '호출'}`, args: {} };
      const failed = item.status === 'failed' || Boolean(item.error);
      hooks.onToolEnd?.({ call, result: failed ? { error: 'MCP tool call failed' } : { completed: true } });
      activeTools.delete(id);
      return;
    }

    if (item.type === 'file_change' && event.type === 'item.completed') {
      for (const change of Array.isArray(item.changes) ? item.changes : []) {
        const filePath = String(change?.path || '');
        if (!filePath) continue;
        const call = { id: `${item.id || 'file'}:${filePath}`, name: 'file_change', args: { path: filePath, change: change.kind?.type || 'updated' } };
        hooks.onToolStart?.(call);
        hooks.onToolEnd?.({ call, result: { path: filePath, change: change.kind?.type || 'updated' } });
      }
    }
  }
}

module.exports = { CodexCliAdapter, flutterCacheFor, profileEmail };
