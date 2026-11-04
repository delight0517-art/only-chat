'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseReasoningEffort } = require('../core/ReasoningEffort.js');
const { withResponseGuidance } = require('./responseGuidance.js');

function formatHistory(history = []) {
  const transcript = history.map(item => {
    const role = item.role || 'message';
    const content = typeof item.content === 'string' ? item.content : JSON.stringify(item.content ?? '');
    return `${role.toUpperCase()}\n${content}`;
  }).join('\n\n');
  return withResponseGuidance(transcript);
}

function parseUsageForTier(usage, tier) {
  if (tier?.provider !== 'antigravity-cli') return null;
  const model = String(tier.model || '').toLowerCase();
  const groupPattern = /argon/.test(model) ? /gemini\s*4\s*argon/i
    : /gemini/.test(model) ? /^gemini models$/i
      : new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const group = usage?.command?.data?.groups?.find(item => groupPattern.test(String(item.name || '')));
  if (!group || !Array.isArray(group.buckets)) return null;
  const buckets = group.buckets.filter(bucket => bucket?.disabled !== true && Number.isFinite(bucket?.remaining_fraction));
  if (!buckets.length) return null;
  const ranked = buckets.map(bucket => ({ bucket, remaining: Math.max(0, Math.min(1, bucket.remaining_fraction)) * 100 }));
  const remainingPercent = Math.min(...ranked.map(item => item.remaining));
  const limiting = ranked.filter(item => item.remaining === remainingPercent);
  const resetTimes = limiting.map(item => item.bucket.reset_time).filter(value => typeof value === 'string' && Number.isFinite(Date.parse(value))).sort();
  const fiveHour = ranked.find(item => /^(?:5h|five[- ]?hour)$/i.test(String(item.bucket.window || '')));
  return {
    remainingPercent,
    fiveHourRemainingPercent: fiveHour?.remaining,
    nextResetAt: resetTimes[0] || null
  };
}

const MODEL_EFFORT_VARIANTS = new Map([
  ['gemini-3.8-flash', new Set(['low', 'medium', 'high'])],
  ['gemini-4-argon', new Set(['low', 'medium', 'high'])],
  ['claude-opus-5-5', new Set(['low', 'medium', 'high'])],
  ['claude-sonnet-5-5', new Set(['low', 'medium', 'high'])],
  ['gpt-oss-120b', new Set(['medium'])]
]);

function resolveModelEffort(model, effort) {
  const match = /^(.*)-(low|medium|high)$/.exec(String(model || ''));
  const variants = match && MODEL_EFFORT_VARIANTS.get(match[1]);
  if (!variants) return { model, passEffort: true };
  if (!variants.has(effort)) {
    const error = new Error(`The selected Antigravity model does not support the ${effort} reasoning level.`);
    error.category = 'model_unavailable';
    throw error;
  }
  return { model: `${match[1]}-${effort}`, passEffort: false };
}

class AntigravityCliAdapter {
  constructor(options = {}) {
    this.command = options.command || path.join(os.homedir(), '.local/bin/agy');
    this.spawn = options.spawn || spawn;
    this.stateFile = options.stateFile || path.join(options.dataDir || path.join(os.homedir(), '.my-codex'), 'provider-conversations.json');
    this.timeoutMs = options.timeoutMs || 10 * 60 * 1000;
    this.quotaTimeoutMs = options.quotaTimeoutMs || 30 * 1000;
    this.conversations = this._loadConversations();
  }

  async readQuota(tier) {
    const output = await this._runReadOnlyUsage();
    return parseUsageForTier(output, tier);
  }

  _runReadOnlyUsage() {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawn(this.command, ['--print', '/usage', '--output-format', 'json'], {
          cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        reject(error);
        return;
      }

      let stdout = '';
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(new Error('Antigravity 한도 조회 시간이 초과됐습니다.'));
      }, this.quotaTimeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.length > 256 * 1024) {
          child.kill('SIGTERM');
          finish(new Error('Antigravity 한도 응답 크기가 제한을 넘었습니다.'));
        }
      });
      child.on('error', () => finish(new Error('Antigravity 한도 조회 CLI를 실행할 수 없습니다.')));
      child.on('close', code => {
        if (code !== 0) {
          finish(new Error('Antigravity 한도 조회에 실패했습니다.'));
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.status !== 'SUCCESS' || parsed.command?.name !== 'usage') throw new Error();
          finish(null, parsed);
        } catch (_) {
          finish(new Error('Antigravity 한도 응답 형식을 확인할 수 없습니다.'));
        }
      });
    });
  }

  async call(tier, history, hooks = {}, context = {}) {
    const saved = context.sessionId ? this.conversations[context.sessionId] : null;
    const currentHistory = saved ? history.slice(-1) : history;
    const prompt = formatHistory(currentHistory);
    if (!prompt.trim()) throw new Error('Antigravity에 보낼 대화 내용이 없습니다.');

    const sessionId = context.sessionId;
    const args = [
      '--print', prompt,
      '--output-format', 'stream-json',
      '--print-timeout', `${Math.ceil(this.timeoutMs / 1000)}s`
    ];
    const reasoningEffort = parseReasoningEffort(context.reasoningEffort);
    if (!reasoningEffort) throw new Error('지원하지 않는 추론 강도입니다.');
    const resolvedModel = resolveModelEffort(tier?.model, reasoningEffort);
    if (resolvedModel.model) args.push('--model', resolvedModel.model);
    if (resolvedModel.passEffort) args.push('--effort', reasoningEffort);
    if (saved?.provider === 'antigravity-cli' && saved.model === (tier?.model || '')) {
      args.push('--conversation', saved.conversationId);
    }

    const result = await this._run(args, context.workspaceDir, hooks);
    if (result.conversationId && sessionId) {
      this.conversations[sessionId] = {
        provider: 'antigravity-cli',
        model: tier?.model || '',
        conversationId: result.conversationId
      };
      this._saveConversations();
    }
    return { content: result.response, toolCalls: [] };
  }

  _run(args, cwd, hooks) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawn(this.command, args, { cwd: cwd || process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        reject(error);
        return;
      }

      let stdoutBuffer = '';
      let stderr = '';
      let finalResult = null;
      let streamedText = '';
      const activeTools = new Map();
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          for (const call of activeTools.values()) hooks.onToolEnd?.({ call, result: { error: error.message } });
          activeTools.clear();
          reject(error);
        }
        else resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(new Error('Antigravity CLI 응답 시간이 초과됐습니다.'));
      }, this.timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdoutBuffer += chunk;
        let newline;
        while ((newline = stdoutBuffer.indexOf('\n')) !== -1) {
          const line = stdoutBuffer.slice(0, newline).trim();
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); } catch (_) { continue; }
          if (event.event === 'step_update' && event.step_update?.step_type === 'agent_response') {
            const delta = event.step_update.text_delta || '';
            streamedText += delta;
            if (delta) hooks.onMessageDelta?.(delta);
          } else if (event.event === 'step_update' && event.step_update?.step_type === 'tool') {
            const step = event.step_update;
            const info = step.tool_info || {};
            const call = {
              id: `${step.conversation_id || 'agy'}:${step.step_index}`,
              name: step.tool_name || info.name || 'tool',
              args: info.parameters || {}
            };
            const key = call.id;
            if (step.state === 'ACTIVE' && !activeTools.has(key)) {
              activeTools.set(key, call);
              hooks.onToolStart?.(call);
            } else if (step.state === 'DONE') {
              if (!activeTools.has(key)) hooks.onToolStart?.(call);
              const output = typeof info.output === 'string' ? info.output : '';
              if (output) hooks.onToolOutput?.({ type: 'stdout', text: output });
              const result = info.error ? { error: info.error.message || String(info.error) } : info;
              hooks.onToolEnd?.({ call, result });
              activeTools.delete(key);
            }
          } else if (event.event === 'result') {
            finalResult = event.result || null;
          }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
      child.on('error', error => finish(error));
      child.on('close', code => {
        if (stdoutBuffer.trim()) {
          try {
            const event = JSON.parse(stdoutBuffer);
            if (event.event === 'result') finalResult = event.result || null;
          } catch (_) {}
        }
        if (code !== 0 || finalResult?.status !== 'SUCCESS') {
          const message = finalResult?.error || stderr.trim() || `Antigravity CLI 종료 코드 ${code}`;
          finish(new Error(message));
          return;
        }
        const response = typeof finalResult.response === 'string' ? finalResult.response.trim() : '';
        if (response && !streamedText) hooks.onMessageDelta?.(response);
        finish(null, { response, conversationId: finalResult.conversation_id || null });
      });
    });
  }

  _loadConversations() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  _saveConversations() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(this.conversations), { mode: 0o600 });
      fs.renameSync(temporary, this.stateFile);
      fs.chmodSync(this.stateFile, 0o600);
    } finally {
      try { fs.unlinkSync(temporary); } catch (_) {}
    }
  }
}

module.exports = { AntigravityCliAdapter, formatHistory, parseUsageForTier, resolveModelEffort };
