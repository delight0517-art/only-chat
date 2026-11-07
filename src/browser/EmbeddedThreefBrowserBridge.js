'use strict';

const { normalizeHttpUrl } = require('./FocusFencePolicy.js');

class EmbeddedThreefBrowserBridge {
  constructor(options = {}) {
    this.policy = options.policy || null;
    this.dispatch = options.dispatch || (() => Promise.reject(new Error('3F Browser panel is not connected.')));
    this.lastUrl = 'about:blank';
    this.lastError = '';
  }

  async launch(value = 'https://www.google.com') { return this.navigate(value); }

  async navigate(value) {
    let url;
    try { url = normalizeHttpUrl(value); } catch (error) { return this._fail(error.message); }
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return this._fail('HTTP 또는 HTTPS 주소만 열 수 있습니다. URL 자격 증명은 허용되지 않습니다.');
    if (this.policy) {
      let decision;
      try { decision = await this.policy.check(url); } catch (_) {}
      if (!decision?.allowed) return this._fail(decision?.reason === 'blocked' ? `Focus Fence 차단: ${decision.rule}` : 'Focus Fence 정책을 확인할 수 없어 탐색을 중단했습니다.');
    }
    try {
      const result = await this.dispatch({ action: 'navigate', url });
      const status = await this.dispatch({ action: 'status' }).catch(() => null);
      if (status?.available && typeof status.url === 'string') this.lastUrl = status.url;
      const addressMatchesRequested = status?.available === true && status.url === url;
      if (!addressMatchesRequested) {
        const reason = status?.available === true
          ? `3F Browser가 요청한 주소로 이동했는지 확인되지 않았습니다. 요청: ${url} · 현재: ${this.lastUrl}`
          : '3F Browser가 탐색 명령을 받았지만 열린 페이지 주소를 확인할 수 없습니다.';
        this.lastError = reason;
        return {
          ok: false,
          requested: true,
          addressMatchesRequested: false,
          stdout: '',
          stderr: reason,
          requestedUrl: url,
          url: this.lastUrl,
          result
        };
      }
      this.lastError = '';
      return {
        ok: true,
        requested: true,
        addressMatchesRequested: true,
        stdout: `Only Chat 안의 3F Browser 주소를 확인했습니다: ${status.url}`,
        stderr: '',
        requestedUrl: url,
        url: this.lastUrl,
        result
      };
    } catch (error) { return this._fail(error.message || '3F Browser 탐색을 완료하지 못했습니다.', url); }
  }

  async _pageAction(action, args = {}) {
    let status;
    try { status = await this.dispatch({ action: 'status' }); } catch (_) {}
    if (!status?.available) return { error: 'Only Chat 안의 3F Browser 패널을 열어 주세요.' };
    this.lastUrl = status.url || this.lastUrl;
    if (!this.policy) return this._fail('Focus Fence 정책을 확인할 수 없어 브라우저 접근을 중단했습니다.');
    let decision;
    try { decision = await this.policy.check(this.lastUrl); } catch (_) {}
    if (!decision?.allowed) return this._fail(decision?.reason === 'blocked' ? `Focus Fence 차단: ${decision.rule}` : 'Focus Fence 정책을 확인할 수 없어 브라우저 접근을 중단했습니다.');
    try { return await this.dispatch({ action, ...args }); } catch (error) { return this._fail(error.message || '3F Browser 명령을 완료하지 못했습니다.'); }
  }

  async getStatus() {
    try {
      const status = await this.dispatch({ action: 'status' });
      this.lastUrl = status.url || this.lastUrl;
      const controlAvailable = status.available === true;
      let policyStatus = { decision: 'unknown', reasonCode: 'url_unavailable' };
      if (controlAvailable && /^https?:\/\//i.test(this.lastUrl) && typeof this.policy?.evaluate === 'function') {
        try { policyStatus = await this.policy.evaluate(this.lastUrl); } catch (_) {
          policyStatus = { decision: 'unknown', reasonCode: 'policy_unavailable' };
        }
        if (!['allowed', 'blocked', 'unknown'].includes(policyStatus?.decision)
          || !['rules_allow', 'rules_block', 'policy_unavailable', 'url_unavailable'].includes(policyStatus?.reasonCode)) {
          policyStatus = { decision: 'unknown', reasonCode: 'policy_unavailable' };
        } else {
          policyStatus = { decision: policyStatus.decision, reasonCode: policyStatus.reasonCode };
        }
      }
      const pageOpen = /^https?:\/\//i.test(this.lastUrl);
      const statusText = controlAvailable
        ? (pageOpen ? 'Only Chat 안의 3F Browser 연결됨' : '3F Browser 제어 연결됨 · 열린 페이지 없음')
        : '3F Browser 패널 연결 대기 중';
      return { available: true, isOpen: controlAvailable, activeUrl: this.lastUrl, title: status.title || '', controlAvailable, statusText: this.lastError || statusText, policyStatus };
    } catch (_) { return { available: true, isOpen: false, activeUrl: this.lastUrl, controlAvailable: false, statusText: 'Only Chat의 3F Browser 패널을 열면 연결됩니다.' }; }
  }

  async getAriaTree() {
    const result = await this._pageAction('aria');
    const error = result.error || result.stderr || '';
    return { ok: !error, blocked: String(error).startsWith('Focus Fence 차단:'), tabId: error ? null : 'only-chat-3f', url: this.lastUrl, ariaTree: result.text || error };
  }

  async readText() {
    const result = await this._pageAction('read');
    const error = result.error || result.stderr || '';
    const stdout = typeof result.text === 'string' ? result.text : '';
    if (error) return { ok: false, stdout: '', stderr: error };
    if (!stdout.trim()) return { ok: false, stdout: '', stderr: '3F Browser 페이지에서 읽을 수 있는 텍스트가 없어 페이지 읽기를 확인하지 못했습니다.' };
    return { ok: true, stdout, stderr: '' };
  }

  async act(action) {
    const result = await this._pageAction('act', { value: String(action || '') });
    return { ok: !result.error, stdout: result.text || '', stderr: result.error || '' };
  }

  async history(action) {
    if (!['back', 'forward', 'reload'].includes(action)) return this._fail('지원하지 않는 3F Browser 탐색 동작입니다.');
    const result = await this._pageAction(action);
    return { ok: !result.error, stdout: result.text || `3F Browser ${action} 완료`, stderr: result.error || '', url: result.url || this.lastUrl };
  }

  async recipePlay() { return this._fail('3F Browser 자동화 레시피 연결은 아직 제공되지 않습니다.'); }

  _fail(message, url = this.lastUrl) {
    this.lastError = message;
    return { ok: false, stderr: message, url, blocked: message.startsWith('Focus Fence 차단:') };
  }
}

module.exports = { EmbeddedThreefBrowserBridge };
