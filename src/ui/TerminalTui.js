/**
 * @project My-Codex
 * @provenance:rogan-core
 * @author Rogan Kim (GeunHu Kim) & AI Architect
 * @license MIT
 * @description High-performance interactive Terminal TUI reproducing Codex CLI experience with live priority badge.
 */
'use strict';

const readline = require('node:readline');
const { AgentEngine } = require('../core/AgentEngine.js');

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  gray: '\x1b[90m'
};

class TerminalTui {
  constructor(options = {}) {
    this.engine = new AgentEngine(options);
    this.rl = null;
  }

  printBanner() {
    const status = this.engine.priorityChain.getStatus();
    const active = status.activeTier;
    console.log(`${COLORS.cyan}${COLORS.bold}`);
    console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                                 MY-CODEX CLI                                 ║');
    console.log('║                Sovereign Cleanroom Agent Harness by Rogan Kim                ║');
    console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
    console.log(`${COLORS.reset}`);
    console.log(`${COLORS.bold}🚀 활성 계정 / 우선순위:${COLORS.reset} ${active
      ? `${COLORS.green}${active.name}${COLORS.reset} [${COLORS.yellow}${active.model}${COLORS.reset}]`
      : `${COLORS.red}사용 가능한 계정 없음${COLORS.reset}`}`);
    if (active) console.log(`${COLORS.dim}   이메일: ${active.email || '기본'} | 프로바이더: ${active.provider}${COLORS.reset}`);
    console.log(`${COLORS.dim}   도움말: /status, /accounts, /switch <1|2|3>, /login, /exit${COLORS.reset}\n`);
  }

  start() {
    this.printBanner();
    this.engine.initSession();

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `${COLORS.cyan}my-codex❯ ${COLORS.reset}`
    });

    this.rl.prompt();

    this.rl.on('line', async line => {
      const input = line.trim();
      if (!input) {
        this.rl.prompt();
        return;
      }

      // Handle slash commands
      if (input.startsWith('/')) {
        await this.handleCommand(input);
        this.rl.prompt();
        return;
      }

      // Execute conversational turn
      try {
        console.log(`${COLORS.dim}⏳ 추론 및 실행 중...${COLORS.reset}`);
        await this.engine.executeTurn(input, {
          onTierResolved: tier => {
            process.stdout.write(`${COLORS.gray}[${tier.name}] ${COLORS.reset}\n`);
          },
          onReasoningDelta: delta => {
            process.stdout.write(`${COLORS.dim}${delta}${COLORS.reset}\n`);
          },
          onMessageDelta: delta => {
            process.stdout.write(`${COLORS.bold}${delta}${COLORS.reset}\n`);
          },
          onToolStart: call => {
            console.log(`${COLORS.yellow}⚙️  도구 실행: ${call.name} (${JSON.stringify(call.args)})${COLORS.reset}`);
          },
          onToolOutput: out => {
            process.stdout.write(`${COLORS.gray}${out.text}${COLORS.reset}`);
          },
          onToolEnd: ({ call, result }) => {
            console.log(`${COLORS.green}✓ 도구 완료 (${call.name})${COLORS.reset}`);
          }
        });
      } catch (err) {
        console.error(`${COLORS.red}❌ 오류 발생: ${err.message}${COLORS.reset}`);
      }

      console.log('');
      this.rl.prompt();
    });

    this.rl.on('close', () => {
      console.log(`\n${COLORS.cyan}My-Codex 세션을 안전하게 종료합니다. 안녕히 가십시오!${COLORS.reset}`);
      process.exit(0);
    });
  }

  async handleCommand(cmd) {
    const parts = cmd.split(' ');
    const action = parts[0].toLowerCase();

    switch (action) {
      case '/status': {
        const s = this.engine.priorityChain.getStatus();
        console.log(`\n${COLORS.bold}📊 우선순위 체인 상태:${COLORS.reset}`);
        console.log(`- 모드: ${s.mode} (활성화: ${s.enabled ? '예' : '아니오'})`);
        console.log(`- 현재 활성: ${s.activeTier ? `${COLORS.green}${s.activeTier.name}${COLORS.reset}` : `${COLORS.red}사용 가능한 계정 없음${COLORS.reset}`}`);
        console.log(`\n${COLORS.bold}📋 전체 티어 현황:${COLORS.reset}`);
        for (const t of s.tiers) {
          const isCurrent = t.id === s.activeTier?.id;
          const marker = isCurrent ? `${COLORS.green}▶${COLORS.reset}` : ' ';
          const throttled = t.health?.isThrottled ? `${COLORS.red}(제한됨: ${t.health.throttledReason})${COLORS.reset}` : `${COLORS.green}(정상 가용)${COLORS.reset}`;
          const remaining = Number.isFinite(t.health?.totalRemainingPercent) ? `${t.health.totalRemainingPercent}%` : '미확인';
          console.log(` ${marker} Tier ${t.tier}: ${t.name} [${t.model}] - 잔여한도: ${remaining} ${throttled}`);
        }
        console.log('');
        break;
      }

      case '/accounts': {
        const accounts = this.engine.auth.listAccounts();
        console.log(`\n${COLORS.bold}🔑 등록된 계정 목록:${COLORS.reset}`);
        for (const acc of accounts) {
          console.log(`- [${acc.id}] ${acc.name} (${acc.email}) - Provider: ${acc.provider}`);
        }
        console.log('');
        break;
      }

      case '/switch': {
        const target = parts[1];
        if (!target) {
          console.log(`${COLORS.yellow}사용법: /switch <tier-number (1, 2, 3) or tier-id>${COLORS.reset}`);
          return;
        }
        let targetId = target;
        if (target === '1') targetId = 'antigravity-flash-med';
        else if (target === '2') targetId = 'codex-secondary';
        else if (target === '3') targetId = 'codex-primary';

        const tier = this.engine.priorityChain.resolveActiveTier(targetId);
        console.log(`${COLORS.green}✓ ${tier.name} [${tier.model}] (으)로 전환되었습니다.${COLORS.reset}`);
        break;
      }

      case '/login': {
        const provider = parts[1];
        const email = parts[2];
        if (!provider || !email) {
          console.log(`${COLORS.yellow}사용법: /login <google|chatgpt> <email> [token]${COLORS.reset}`);
          return;
        }
        const token = parts[3] || 'saved-token';
        await this.engine.auth.loginProvider(provider, { email, token });
        console.log(`${COLORS.green}✓ [${provider}] ${email} 계정이 등록되었습니다.${COLORS.reset}`);
        break;
      }

      case '/sessions': {
        const list = this.engine.sessions.listSessions();
        console.log(`\n${COLORS.bold}📜 최근 세션 히스토리 (${list.length}개):${COLORS.reset}`);
        for (const ses of list.slice(0, 5)) {
          const dt = new Date(ses.createdAt).toLocaleString();
          console.log(`- ${ses.sessionId} | ${dt} | ${ses.provider} (${ses.model})`);
        }
        console.log('');
        break;
      }

      case '/exit':
      case '/quit':
        this.rl.close();
        break;

      default:
        console.log(`${COLORS.yellow}알 수 없는 명령어입니다: ${action}${COLORS.reset}`);
        break;
    }
  }
}

module.exports = { TerminalTui };
