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
      this.lastUrl = url; this.lastError = '';
      return { ok: true, stdout: `Only Chat 안의 3F Browser에서 열었습니다: ${url}`, stderr: '', url, result };
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
      const pageOpen = /^https?:\/\//i.test(this.lastUrl);
      const statusText = controlAvailable
        ? (pageOpen ? 'Only Chat 안의 3F Browser 연결됨' : '3F Browser 제어 연결됨 · 열린 페이지 없음')
        : '3F Browser 패널 연결 대기 중';
      return { available: true, isOpen: controlAvailable, activeUrl: this.lastUrl, title: status.title || '', controlAvailable, statusText: this.lastError || statusText };
    } catch (_) { return { available: true, isOpen: false, activeUrl: this.lastUrl, controlAvailable: false, statusText: 'Only Chat의 3F Browser 패널을 열면 연결됩니다.' }; }
  }

  async getAriaTree() {
    const result = await this._pageAction('aria');
    return { tabId: 'only-chat-3f', url: this.lastUrl, ariaTree: result.text || result.error || '' };
  }

  async readText() {
    const result = await this._pageAction('read');
    return { ok: !result.error, stdout: result.text || '', stderr: result.error || '' };
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
