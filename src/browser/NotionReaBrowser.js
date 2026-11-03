'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createRequire } = require('node:module');
const { FocusFencePolicy } = require('./FocusFencePolicy.js');

const DEFAULT_SCRIPTS = path.join(os.homedir(), 'appDev/devtool/aside_bridge/scripts');
const NOTION_HOST = /(^|\.)notion\.(?:so|com)$|(^|\.)notion\.site$/i;
const WAIT = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalizeNotionUrl(value) {
  let url;
  try { url = new URL(value); } catch (_) { throw new Error('유효한 Notion URL을 입력하세요.'); }
  if (url.protocol !== 'https:' || !NOTION_HOST.test(url.hostname) || url.username || url.password) {
    throw new Error('REA Notion 도구는 HTTPS Notion 페이지에서만 동작합니다.');
  }
  return url.toString();
}

class NotionReaBrowser {
  constructor(options = {}) {
    this.scriptsDir = options.scriptsDir || DEFAULT_SCRIPTS;
    this.policy = options.policy || new FocusFencePolicy();
    this.runScript = options.runScript || ((script, ...args) => this._run(script, ...args));
    this.wait = options.wait || WAIT;
    this.agent = 'only-chat-notion';
    this.targetId = null;
    this.activeUrl = null;
    this.runtimeCheck = options.runtimeCheck || (() => this._checkRuntime());
  }

  async open(value = 'https://www.notion.so') {
    const url = normalizeNotionUrl(value);
    await this._checkPolicy(url);
    const readiness = await this.runtimeCheck();
    if (!readiness.ready) throw new Error(readiness.reason || 'Aside REA를 사용할 수 없습니다.');
    const result = await this.runScript('aside-nav.js', url, '--agent', this.agent, '--task', 'Only Chat Notion REA');
    const targetId = /^(\S+)/.exec(result.stdout.trim())?.[1];
    if (!result.ok || !targetId) throw new Error(result.stderr || 'Aside에서 Notion 탭을 열지 못했습니다.');
    this.targetId = targetId;
    this.activeUrl = url;
    return { ok: true, targetId, url, stdout: result.stdout };
  }

  async navigate(value) {
    const url = normalizeNotionUrl(value);
    await this._checkPolicy(url);
    // aside-nav creates an isolated task tab; leave any page with a possible draft untouched.
    return this.open(url);
  }

  async search(query) {
    this._requireTab();
    const text = String(query || '').trim();
    if (!text || text.length > 500) throw new Error('검색어를 1~500자 입력하세요.');
    let page = await this._map();
    let searchInput = this._find(page.ariaTree, /(?:textbox|searchbox|combobox).*?(?:search|검색)|(?:search|검색).*?(?:textbox|searchbox|combobox)/i);
    if (!searchInput) {
      const searchButton = this._find(page.ariaTree, /(?:button|link).*?(?:search|검색|빠른 찾기|quick find)|(?:search|검색|빠른 찾기|quick find).*?(?:button|link)/i);
      if (!searchButton) throw new Error('Notion 검색창을 찾지 못했습니다. Aside에서 로그인했는지 확인한 뒤 다시 시도하세요.');
      await this._actRef(searchButton.ref, 'click');
      await this.wait(250);
      page = await this._map();
      searchInput = this._find(page.ariaTree, /(?:textbox|searchbox|combobox).*?(?:search|검색)|(?:search|검색).*?(?:textbox|searchbox|combobox)/i);
    }
    if (!searchInput) throw new Error('Notion 검색창이 열리지 않았습니다. 검색 UI의 현재 상태를 확인하세요.');
    await this._actRef(searchInput.ref, 'type', text, searchInput.line);
    await this.wait(700);
    const results = await this._map();
    const content = await this._read(results);
    return { ok: true, query: text, url: results.url, results: results.ariaTree, text: content.text };
  }

  async read() { this._requireTab(); return this._read(); }
  async aria() { this._requireTab(); return this._map(); }

  async act(action) {
    this._requireTab();
    const input = typeof action === 'string' ? this._parseAction(action) : action;
    if (!input || !['click', 'type'].includes(input.action)) throw new Error('동작은 click 또는 type이어야 합니다.');
    const page = await this._map();
    let target = input.ref ? this._find(page.ariaTree, new RegExp(`\\[ref=${String(input.ref).replace(/^ref=/, '')}\\]`)) : null;
    if (!target && input.label) target = this._find(page.ariaTree, new RegExp(escapeRegExp(input.label), 'i'));
    if (!target) throw new Error('현재 Notion 화면에서 지정한 요소를 찾지 못했습니다. 최신 REA 요소 목록을 확인하세요.');
    const loginPath = /\/(?:login|log-in|sign-in|signin|auth)(?:\/|$)/i.test(new URL(page.url).pathname);
    if (input.action === 'type' && (loginPath || /password|passcode|one.?time|verification code|\be-?mail\b|sign.?in|authentication|인증번호|인증|로그인|비밀번호|패스키|recovery code|복구 코드/i.test(target.line))) {
      throw new Error('REA는 인증 정보 입력을 대신하지 않습니다. Notion 로그인은 Aside에서 직접 진행하세요.');
    }
    const typedText = input.text === undefined ? '' : String(input.text);
    if (input.action === 'type' && !typedText) throw new Error('입력할 텍스트가 없습니다.');
    const result = await this._actRef(target.ref, input.action, typedText, target.line);
    return { ...result, target: target.line, url: page.url };
  }

  async status() {
    const readiness = await this.runtimeCheck();
    return {
      available: readiness.ready,
      ready: readiness.ready,
      reason: readiness.reason || null,
      cdpConnected: readiness.cdpConnected,
      puppeteerAvailable: readiness.puppeteerAvailable,
      scriptsAvailable: readiness.scriptsAvailable,
      targetId: this.targetId,
      activeUrl: this.activeUrl
    };
  }

  async _checkRuntime() {
    const scripts = ['aside-nav.js', 'aside-map.js', 'aside-read.js', 'aside-act.js'];
    const scriptsAvailable = scripts.every(script => fs.existsSync(path.join(this.scriptsDir, script)));
    let puppeteerAvailable = false;
    try {
      const connectModule = path.join(this.scriptsDir, '..', 'lib', 'connect.js');
      createRequire(connectModule).resolve('puppeteer-core');
      puppeteerAvailable = true;
    } catch (_) {}
    let cdpConnected = false;
    try {
      const base = String(process.env.ASIDE_CDP_URL || 'http://127.0.0.1:9222').replace(/\/$/, '');
      const response = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(1000), cache: 'no-store' });
      cdpConnected = response.ok;
    } catch (_) {}
    const blockers = [];
    if (!scriptsAvailable) blockers.push('Aside REA 스크립트를 찾지 못했습니다.');
    if (!puppeteerAvailable) blockers.push('Aside REA 실행 의존성 puppeteer-core가 설치되지 않았습니다.');
    if (!cdpConnected) blockers.push('Aside CDP 연결이 꺼져 있습니다.');
    const reason = blockers.length ? blockers.join(' ') : null;
    return { ready: scriptsAvailable && puppeteerAvailable && cdpConnected, reason, scriptsAvailable, puppeteerAvailable, cdpConnected };
  }

  _parseAction(value) {
    const match = /^(?:ref=|@)?(\d+)\s+(click|type)(?:\s+([\s\S]*))?$/.exec(value.trim());
    return match ? { ref: match[1], action: match[2], text: match[3] } : null;
  }

  _find(tree, pattern) {
    const line = String(tree).split('\n').find(item => pattern.test(item) && /\[ref=\d+\]/.test(item));
    if (!line) return null;
    return { line: line.trim(), ref: /\[ref=(\d+)\]/.exec(line)[1] };
  }

  async _map() {
    this._requireTab();
    const result = await this.runScript('aside-map.js', this.targetId, '--max', '250', '--agent', this.agent);
    if (!result.ok) throw new Error(result.stderr || 'Aside에서 Notion 페이지 구조를 읽지 못했습니다.');
    const url = /^# url:\s*(\S+)/m.exec(result.stdout)?.[1];
    this.activeUrl = normalizeNotionUrl(url || '');
    return { targetId: this.targetId, url: this.activeUrl, ariaTree: result.stdout };
  }

  async _read(page = null) {
    page ||= await this._map();
    const result = await this.runScript('aside-read.js', this.targetId, '--agent', this.agent);
    if (!result.ok) throw new Error(result.stderr || 'Notion 페이지 본문을 읽지 못했습니다.');
    return { targetId: this.targetId, url: page.url, text: result.stdout.slice(0, 30000), truncated: result.stdout.length > 30000 };
  }

  async _actRef(ref, action, text = '', line = '') {
    const safeRef = String(ref).replace(/^ref=/, '');
    if (!/^\d+$/.test(safeRef)) throw new Error('REA 요소 참조가 유효하지 않습니다.');
    const args = ['aside-act.js', this.targetId, `ref=${safeRef}`, action];
    if (action === 'type') args.push(text);
    args.push('--agent', this.agent);
    const result = await this.runScript(...args);
    if (!result.ok) throw new Error(result.stderr || `Notion ${action} 작업이 실패했습니다.`);
    return { ...result, target: line };
  }

  async _checkPolicy(url) {
    if (!this.policy) throw new Error('Focus Fence 정책을 확인할 수 없어 Notion 탐색을 중단했습니다.');
    const decision = await this.policy.check(url);
    if (!decision.allowed) throw new Error(decision.reason === 'blocked' ? `Focus Fence 차단: ${decision.rule}` : 'Focus Fence 정책을 확인할 수 없어 Notion 탐색을 중단했습니다.');
  }

  _requireTab() {
    if (!this.targetId) throw new Error('먼저 notion_rea_open으로 별도 Aside Notion 탭을 여세요. Notion 로그인은 Aside에서 직접 진행하세요.');
  }

  _run(script, ...args) {
    const scriptPath = path.join(this.scriptsDir, script);
    return new Promise(resolve => execFile('/usr/bin/env', ['node', scriptPath, ...args], {
      timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: process.env
    }, (error, stdout, stderr) => resolve({
      ok: !error,
      exitCode: error?.code || (error ? 1 : 0),
      stdout: (stdout || '').trim(),
      stderr: (stderr || error?.message || '').trim()
    })));
  }
}

function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = { NotionReaBrowser, normalizeNotionUrl };
