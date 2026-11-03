#!/usr/bin/env node
/**
 * @project My-Codex
 * @provenance:rogan-core
 * @author Rogan Kim (GeunHu Kim) & AI Architect
 * @license MIT
 * @description Sovereign Cleanroom CLI Entry Point for My-Codex.
 */
'use strict';

const { TerminalTui } = require('../src/ui/TerminalTui.js');
const { AppServerBridge } = require('../src/ui/AppServerBridge.js');
const { DesktopServer } = require('../src/ui/desktop/server.js');
const { PriorityChainEngine } = require('../src/priority/PriorityChainEngine.js');
const { AuthManager } = require('../src/auth/AuthManager.js');
const { AntigravityCliAdapter } = require('../src/providers/AntigravityCliAdapter.js');
const { CodexCliAdapter } = require('../src/providers/CodexCliAdapter.js');
const { execFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
const command = args[0] || '';

function readableModelName(modelId) {
  const names = {
    'gpt-6-luna': 'GPT-6 Luna',
    'gpt-6-sol': 'GPT-6 Sol',
    'gpt-6-astra': 'GPT-6 Astra',
    'gpt-6.1-sol': 'GPT-6.1 Sol',
    'gpt-6.1-terra': 'GPT-6.1 Terra',
    'gpt-5.6-sol': 'GPT-5.6 Sol',
    'gpt-5.6-terra': 'GPT-5.6 Terra',
    'gpt-5.6-luna': 'GPT-5.6 Luna',
    'gemini-3.8-flash-medium': 'Gemini 3.8 Flash Medium'
  };
  const id = String(modelId || '모델 미지정');
  return names[id.toLowerCase()] || id;
}

function createToolSummary() {
  const results = new Map();
  let count = 0;
  return {
    onToolStart(call) {
      const tool = /^[a-z][a-z0-9_]{0,63}$/i.test(String(call?.name || '')) ? call.name : '알 수 없는 도구';
      const key = String(call?.id || `${tool}:${count + 1}`);
      results.set(key, false);
      count++;
      console.log(`\n[도구 시작: ${tool}]`);
    },
    onToolEnd({ call, result } = {}) {
      const tool = /^[a-z][a-z0-9_]{0,63}$/i.test(String(call?.name || '')) ? call.name : '알 수 없는 도구';
      const exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : (result?.error || result?.ok === false ? 1 : 0);
      const successful = result?.ok !== false && !result?.error && result?.blocked !== true &&
        ((tool === 'exec_command' || tool === 'bash') ? exitCode === 0 : true);
      const key = String(call?.id || `${tool}:${count}`);
      if (!results.has(key)) { results.set(key, false); count++; }
      results.set(key, successful);
      console.log(`[도구 ${successful ? '완료' : '실패'}: ${tool}, 종료 코드 ${exitCode}]`);
    },
    counts() {
      const failed = [...results.values()].filter(successful => !successful).length;
      return { total: count, failed, successful: count - failed };
    }
  };
}

async function main() {
  switch (command) {
    case 'status': {
      const engine = new PriorityChainEngine();
      const status = engine.getStatus();
      console.log('\n=== [ My-Codex ] 우선순위 체인 & 계정 현황 ===');
      console.log(`활성 계정: ${status.activeTier.name} (${status.activeTier.model})`);
      console.log(`이메일: ${status.activeTier.email}`);
      console.log('\n[전체 티어 구성]:');
      for (const t of status.tiers) {
        const marker = t.id === status.activeTier.id ? '▶' : ' ';
        console.log(` ${marker} Tier ${t.tier}: ${t.name} - 잔여한도: ${t.health?.totalRemainingPercent ?? 100}%`);
      }
      console.log('');
      break;
    }

    case 'accounts':
    case 'login': {
      const auth = new AuthManager();
      if (args[1] === 'add') {
        const provider = args[2];
        const email = args[3];
        const token = args[4] || 'token';
        if (!provider || !email) {
          console.log('사용법: my-codex login add <google|chatgpt> <email> [token]');
          process.exit(1);
        }
        await auth.loginProvider(provider, { email, token });
        console.log(`✓ [${provider}] 계정 (${email}) 이 성공적으로 등록되었습니다.`);
      } else {
        console.log('\n=== [ My-Codex ] 등록된 멀티 계정 ===');
        for (const a of auth.listAccounts()) {
          console.log(`- ${a.name} [${a.provider}] - ${a.email} (${a.model})`);
        }
        console.log('\n계정 추가: my-codex login add <google|chatgpt> <email> [token]\n');
      }
      break;
    }

    case 'app':
    case 'ui': {
      const server = new DesktopServer({ port: Number(process.env.PORT) || 8899 });
      const { url } = await server.start();
      console.log(`\n======================================================`);
      console.log(`  🚀 My-Codex Mac App 실행 중: ${url}`);
      console.log(`  - 1순위: Antigravity Google (Gemini 3.8 Flash Med)`);
      console.log(`  - 2순위: Codex Secondary (f123123ff@gmail.com)`);
      console.log(`  - 3순위: Codex Primary (rogan2534@gmail.com)`);
      console.log(`======================================================\n`);
      
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'xdg-open';
      const openerArgs = process.platform === 'win32' ? ['/d', '/c', 'start', '', url] : [url];
      execFile(opener, openerArgs, err => { if (err) console.warn(`열린 브라우저에서 ${url}을(를) 직접 여세요: ${err.message}`); });
      break;
    }

    case 'app-server': {
      const bridge = new AppServerBridge();
      bridge.startStdio();
      break;
    }

    case 'exec':
    case 'e': {
      const prompt = args.slice(1).join(' ');
      if (!prompt) {
        console.log('사용법: my-codex exec "<프롬프트>"');
        process.exit(1);
      }
      const { AgentEngine } = require('../src/core/AgentEngine.js');
      const dataDir = path.join(os.homedir(), '.my-codex');
      const antigravity = process.platform === 'darwin' ? new AntigravityCliAdapter({ dataDir }) : null;
      const codex = new CodexCliAdapter({ dataDir });
      const agent = new AgentEngine({
        dataDir,
        watchSkills: false,
        dispatcherAutoStart: false,
        isTierReady: tier => tier.provider !== 'codex' || codex.getReadiness(tier).connected,
        providerAdapter: (tier, history, hooks, context) => {
          if (tier.provider === 'antigravity-cli' && antigravity) return antigravity.call(tier, history, hooks, context);
          if (tier.provider === 'codex') return codex.call(tier, history, hooks, context);
          throw new Error(`No local provider adapter is configured for '${tier.provider || tier.id}'.`);
        }
      });
      agent.initSession();
      console.log('⏳ 응답 생성 중...\n');
      const startedAt = Date.now();
      const toolSummary = createToolSummary();
      const res = await agent.executeTurn(prompt, {
        reasoningEffort: 'low',
        onTierResolved: tier => {
          const rank = Number.isInteger(tier?.tier) ? tier.tier : (Number.isInteger(tier?.priority) ? tier.priority : '?');
          const account = tier?.email || tier?.account || tier?.name || '알 수 없음';
          const model = readableModelName(tier?.model);
          console.log(`[선택 티어 ${rank}] 계정: ${account} | 모델: ${model}`);
        },
        onMessageDelta: delta => process.stdout.write(delta),
        onToolStart: toolSummary.onToolStart,
        onToolEnd: toolSummary.onToolEnd
      });
      const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const { total: toolCount, failed: failedToolCount, successful: successfulToolCount } = toolSummary.counts();
      const state = failedToolCount > 0
        ? '작업 실패 (도구 실행 실패 포함)'
        : typeof res?.content === 'string' && res.content.trim()
        ? '응답 완료'
        : '응답 없음 또는 상태 미확인';
      console.log(`\n\n${state}. 도구 성공 ${successfulToolCount}개 / 실패 ${failedToolCount}개 (전체 ${toolCount}개). 소요 시간: ${elapsedSeconds}초`);
      await new Promise(resolve => process.stdout.write('', resolve));
      process.exit(failedToolCount > 0 ? 1 : 0);
    }

    case '--help':
    case '-h':
    case 'help': {
      console.log(`
My-Codex CLI (Cleanroom Sovereign Edition)
Author: Rogan Kim (GeunHu Kim)

사용법:
  my-codex app                 My-Codex Mac 전용 데스크톱 앱 창 실행
  my-codex                     대화형 TUI 터미널 모드 실행
  my-codex status              우선순위 체인 및 계정 잔여 한도 확인
  my-codex accounts            등록된 Google/ChatGPT 계정 목록 확인
  my-codex login add <...>     새로운 Google / ChatGPT 계정 등록
  my-codex exec "<프롬프트>"   비대화형 1회성 명령/에이전트 실행
  my-codex app-server          Codex 호환 JSON-RPC 2.0 stdio 서버 실행
      `);
      break;
    }

    default: {
      // Interactive TUI mode
      const tui = new TerminalTui();
      tui.start();
      break;
    }
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

module.exports = { createToolSummary, readableModelName };
