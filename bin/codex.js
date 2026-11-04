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

function parseGoalDuration(value) {
  const match = /^(\d{1,3})(m|h)$/.exec(String(value || '').trim());
  if (!match) throw new Error('시간은 1m, 30m, 2h처럼 입력하세요. 최대 3h입니다.');
  const minutes = Number(match[1]) * (match[2] === 'h' ? 60 : 1);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) throw new Error('Goal 시간은 1분에서 3시간 사이여야 합니다.');
  return minutes * 60_000;
}

function redactToolMessage(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\b(bearer\s+)[\w.~+/=-]+/gi, '$1[redacted]')
    .replace(/\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)\b\s*[:=]\s*["']?[^\s,"'}]+/gi, '$1=[redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\s+/g, ' ').trim().slice(0, 240);
}

function safeToolError(value, depth = 0) {
  if (depth > 4 || value == null) return '';
  if (typeof value === 'string') {
    try { return safeToolError(JSON.parse(value), depth + 1); } catch (_) { return ''; }
  }
  if (typeof value !== 'string') {
    if (Array.isArray(value)) return value.map(item => safeToolError(item, depth + 1)).find(Boolean) || '';
    if (typeof value !== 'object') return '';
    if (value.isError === true) return safeMcpErrorContent(value.content, depth + 1) || 'MCP tool returned an error';
    if (value.blocked === true) return redactToolMessage(value.error) || 'blocked by policy';
    if (typeof value.error === 'string') return redactToolMessage(value.error);
    if (value.result !== undefined) return safeToolError(value.result, depth + 1);
    if (Array.isArray(value.content)) {
      for (const item of value.content) {
        if (item?.isError === true) return safeToolError(item, depth + 1);
        if (typeof item?.text === 'string') {
          try {
            const parsed = JSON.parse(item.text);
            const detail = safeToolError(parsed, depth + 1);
            if (detail) return detail;
          } catch (_) {}
        }
      }
    }
    return '';
  }
  return '';
}

function safeMcpErrorContent(value, depth = 0) {
  if (depth > 4 || value == null) return '';
  if (typeof value === 'string') {
    try { return safeMcpErrorContent(JSON.parse(value), depth + 1); } catch (_) { return redactToolMessage(value); }
  }
  if (Array.isArray(value)) return value.map(item => safeMcpErrorContent(item, depth + 1)).find(Boolean) || '';
  if (typeof value !== 'object') return '';
  if (typeof value.text === 'string') return redactToolMessage(value.text);
  return safeMcpErrorContent(value.content ?? value.result, depth + 1);
}

async function streamOnlyChatTurn({ baseUrl, sessionId, prompt, model, approveTools = [], fetchImpl = fetch, write = text => process.stdout.write(text), signal } = {}) {
  const response = await fetchImpl(`${baseUrl}/api/turn`, {
    method: 'POST', headers: { Host: new URL(baseUrl).host, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, prompt, reasoningEffort: 'low', modelSelection: model, managerMode: false, fullAccess: false, sandboxPolicy: 'workspace-write' }), signal
  });
  if (!response.ok) throw new Error(`Only Chat HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Only Chat did not return a readable event stream.');
  const decoder = new TextDecoder();
  let buffer = '', resolvedSessionId = null, responseText = '', error = null, completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === '[DONE]') continue;
        let event;
        try { event = JSON.parse(raw); } catch (_) { continue; }
        if (event.type === 'session_started') resolvedSessionId = event.sessionId || resolvedSessionId;
        if (event.type === 'tier_resolved') write(`\n[Only Chat: ${event.tier?.name || '모델 확인'} · ${event.tier?.model || model}]\n`);
        if (event.type === 'message_delta') {
          const delta = String(event.delta || ''); responseText += delta; write(delta);
        }
        if (event.type === 'tool_start') write(`\n[도구: ${event.call?.name || '알 수 없음'}]\n`);
        if (event.type === 'tool_end') {
          const call = event.result?.call || event.call;
          const tool = /^[a-z][a-z0-9_]{0,63}$/i.test(String(call?.name || '')) ? call.name : '알 수 없는 도구';
          const result = event.result?.result;
          const detail = safeToolError(result);
          const failed = result?.ok === false || result?.blocked === true || Boolean(detail);
          write(`[도구 ${failed ? '실패' : '완료'}: ${tool}${detail ? ` · ${detail}` : ''}]\n`);
        }
        if (event.type === 'tool_approval_required') {
          if (!approveTools.includes(event.name)) {
            error = { category: 'approval_required', name: event.name };
            await reader.cancel();
            break;
          }
          const approved = await fetchImpl(`${baseUrl}/api/tool-approval`, {
            method: 'POST', headers: { Host: new URL(baseUrl).host, 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId: event.requestId, sessionId: event.sessionId, decision: 'allow_tool' }), signal
          });
          if (!approved.ok) {
            error = { category: 'approval_required', name: event.name };
            await reader.cancel();
            break;
          }
          write(`[Only Chat 승인 범위: ${event.name}]\n`);
        }
        if (event.type === 'error') error = { category: event.category || 'provider_failure', model: event.model, rank: event.rank };
        if (event.type === 'turn_complete') completed = true;
      }
      if (error) break;
    }
  } finally {
    reader.releaseLock();
  }
  if (error) return { ok: false, ...error, sessionId: resolvedSessionId, response: responseText };
  return { ok: completed && Boolean(responseText.trim()), sessionId: resolvedSessionId, response: responseText };
}

async function runOnlyChatGoal({ baseUrl, prompt, durationMs, fixedDuration = false, model = 'gemini-3.8-flash-medium', approveTools = [], fetchImpl = fetch, write = text => process.stdout.write(text), now = Date.now, signal } = {}) {
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(baseUrl || '')) throw new Error('Only Chat은 이 Mac의 loopback 주소로만 연결할 수 있습니다.');
  const deadline = now() + durationMs;
  let sessionId = `session_${now()}`, iteration = 0;
  while (now() < deadline) {
    iteration++;
    const fixedDurationRules = fixedDuration
      ? ' 사용자가 지정한 전체 시간이 끝나기 전에는 GOAL_COMPLETE를 출력하거나 완료를 선언하지 마세요. 더 이상 안전하게 진행할 수 있는 새 작업이 없으면 정확히 GOAL_BLOCKED만 출력해 조기 종료하세요. 완료된 작업이나 이전 점검을 반복하지 마세요.'
      : '';
    const nextPrompt = iteration === 1
      ? `${prompt}${fixedDurationRules}`
      : `계속 같은 Goal을 진행하세요. 남은 시간은 약 ${Math.max(0, Math.ceil((deadline - now()) / 60_000))}분입니다. 직전 결과와 남은 작업을 확인하고, 이미 끝난 일을 반복하지 말고 다음의 가장 작은 안전한 단계를 실행하세요.${fixedDurationRules} 무료로 선택한 모델만 사용하고, 셸/브랜치/워크트리는 만들지 마세요. 진행이 막히면 원인과 필요한 조치를 보고하고 도구를 반복 재시도하지 마세요.`;
    write(`\n[Goal 반복 ${iteration} 시작 · ${sessionId}]\n`);
    const goalSignal = AbortSignal.timeout(Math.max(1, deadline - now()));
    const activeSignal = signal ? AbortSignal.any([signal, goalSignal]) : goalSignal;
    let result;
    try {
      result = await streamOnlyChatTurn({ baseUrl, sessionId, prompt: nextPrompt, model, approveTools, fetchImpl, write, signal: activeSignal });
    } catch (error) {
      if (now() >= deadline) break;
      throw error;
    }
    if (result.sessionId) sessionId = result.sessionId;
    if (!result.ok) {
      write(`\n[중단: ${result.category}${result.name ? ` · ${result.name}` : ''}]\n`);
      return { ...result, sessionId, iteration, deadline };
    }
    if (/^\s*GOAL_BLOCKED\s*$/m.test(result.response)) {
      write('\n[중단: 안전하게 진행할 수 있는 다음 단계가 없습니다. 응답의 차단 사유를 확인하세요.]\n');
      return { ok: false, category: 'goal_blocked', sessionId, iteration, deadline, response: result.response };
    }
    if (!fixedDuration && /^\s*GOAL_COMPLETE\s*$/m.test(result.response)) return { ok: true, sessionId, iteration, deadline, completedEarly: true };
  }
  write(`\n[정해진 시간이 끝났습니다 · 반복 ${iteration}회 · 세션 ${sessionId}]\n`);
  return { ok: true, sessionId, iteration, deadline, completedEarly: false };
}

function parseChatCommand(commandArgs) {
  const options = { model: 'gemini-3.8-flash-medium', approveTools: [] };
  const positional = [];
  for (let i = 0; i < commandArgs.length; i++) {
    const arg = commandArgs[i];
    if (arg === '--model') options.model = commandArgs[++i] || '';
    else if (arg === '--duration') options.durationMs = parseGoalDuration(commandArgs[++i]);
    else if (arg === '--fixed-duration') options.fixedDuration = true;
    else if (arg === '--approve-tool') options.approveTools.push(commandArgs[++i] || '');
    else positional.push(arg);
  }
  options.prompt = positional.join(' ').trim();
  if (!options.prompt) throw new Error('요청 내용을 입력하세요.');
  if (options.approveTools.some(name => !['edit_file', 'embedded_3f_navigate', 'embedded_3f_act', 'embedded_3f_history'].includes(name))) {
    throw new Error('승인 가능 도구는 파일 편집 또는 3F 브라우저 작업으로 제한됩니다.');
  }
  return options;
}

async function main() {
  switch (command) {
    case 'chat':
    case 'goal': {
      const options = parseChatCommand(args.slice(1));
      const baseUrl = process.env.ONLY_CHAT_URL || 'http://127.0.0.1:8899';
      if (command === 'goal') {
        if (!options.durationMs) throw new Error('사용법: my-codex goal --duration 3h [--approve-tool edit_file] "Goal"');
        const result = await runOnlyChatGoal({ ...options, baseUrl });
        if (!result.ok) process.exitCode = 1;
      } else {
        if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(baseUrl)) throw new Error('Only Chat은 이 Mac의 loopback 주소로만 연결할 수 있습니다.');
        const result = await streamOnlyChatTurn({ ...options, baseUrl, sessionId: `session_${Date.now()}` });
        if (!result.ok) { console.error(`\n요청 중단: ${result.category}${result.name ? ` · ${result.name}` : ''}`); process.exitCode = 1; }
        else console.log(`\n\n응답 완료 · 세션 ${result.sessionId || '확인 불가'}`);
      }
      break;
    }
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
  my-codex chat "<프롬프트>"   실행 중인 Only Chat에 요청하고 텍스트 응답 읽기
  my-codex goal --duration 3h [--fixed-duration] "<Goal>"  Only Chat에서 순차 반복 Goal 실행
    --approve-tool edit_file   이 세션에서 제한된 파일 편집 승인
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

module.exports = { main, createToolSummary, readableModelName, parseGoalDuration, parseChatCommand, safeToolError, streamOnlyChatTurn, runOnlyChatGoal };
