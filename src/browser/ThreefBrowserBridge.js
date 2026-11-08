'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function safeWebUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch (_) { return null; }
}

class ThreefBrowserBridge {
  constructor(options = {}) {
    this.openExternal = options.openExternal || null;
    this.policy = options.policy || null;
    this.isEnabled = options.isEnabled || (() => true);
    this.qaTarget = options.qaTarget || null;
    this.descriptorPath = options.descriptorPath || (this.qaTarget
      ? path.join(os.tmpdir(), 'onlychat-3f-qa-target.json')
      : path.join(os.homedir(), 'Library', 'Application Support', '3F Browser', 'only-chat-control.json'));
    this.readDescriptor = options.readDescriptor || (() => {
      const before = fs.lstatSync(this.descriptorPath);
      const validFile = stat => stat.isFile()
        && (typeof process.getuid !== 'function' || stat.uid === process.getuid())
        && (stat.mode & 0o077) === 0
        && stat.size <= 2_048;
      if (!validFile(before)) {
        throw new Error('unsafe 3F Browser control descriptor');
      }
      let fd;
      try {
        fd = fs.openSync(this.descriptorPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const opened = fs.fstatSync(fd);
        if (!validFile(opened) || opened.dev !== before.dev || opened.ino !== before.ino) {
          throw new Error('unsafe 3F Browser control descriptor');
        }
        return JSON.parse(fs.readFileSync(fd, 'utf8'));
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    });
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.startupProbeTimeoutMs = Number.isFinite(options.startupProbeTimeoutMs)
      ? Math.max(0, options.startupProbeTimeoutMs) : 5_000;
    this.startupProbeIntervalMs = Number.isFinite(options.startupProbeIntervalMs)
      ? Math.max(0, options.startupProbeIntervalMs) : 150;
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.lastUrl = 'about:blank';
    this.lastError = '';
  }

  _disabled() { return this.isEnabled() !== true; }
  isAvailable() { return !this._disabled() && (typeof this.openExternal === 'function' || Boolean(this._descriptor())); }
  async launch(value = 'https://www.google.com') { return this.navigate(value); }

  _descriptor() {
    try {
      const descriptor = this.readDescriptor();
      if (descriptor?.schemaVersion !== 1 || descriptor.host !== '127.0.0.1'
        || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535
        || typeof descriptor.token !== 'string' || !/^[a-f0-9]{96}$/i.test(descriptor.token)) return null;
      if (this.qaTarget && (descriptor.bundleIdentifier !== this.qaTarget.bundleIdentifier
        || descriptor.executablePath !== this.qaTarget.executablePath
        || !Number.isInteger(descriptor.processIdentifier) || descriptor.processIdentifier <= 0)) return null;
      return descriptor;
    } catch (_) { return null; }
  }

  async _request(method, pathname, body) {
    if (this._disabled()) return { disabled: true, unavailable: true };
    const descriptor = this._descriptor();
    if (!descriptor || typeof this.fetchImpl !== 'function') return { unavailable: true };
    try {
      const response = await this.fetchImpl(`http://${descriptor.host}:${descriptor.port}${pathname}`, {
        method,
        headers: {
          Authorization: `Bearer ${descriptor.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(2500)
      });
      const data = await response.json();
      return { unavailable: false, status: response.status, data };
    } catch (_) { return { unavailable: true }; }
  }

  async verifyTarget() {
    if (!this.qaTarget) return { ok: true, mode: 'production-default' };
    const descriptor = this._descriptor();
    if (!descriptor) return { ok: false, error: 'QA 3F descriptor identity mismatch or unavailable' };
    const response = await this._request('GET', '/v1/status');
    if (response.unavailable || response.status !== 200
      || response.data?.bundleIdentifier !== this.qaTarget.bundleIdentifier
      || response.data?.executablePath !== this.qaTarget.executablePath
      || response.data?.processIdentifier !== descriptor.processIdentifier) {
      return { ok: false, error: 'QA 3F runtime identity mismatch' };
    }
    return { ok: true, mode: 'qa', bundleIdentifier: descriptor.bundleIdentifier,
      executablePath: descriptor.executablePath, processIdentifier: descriptor.processIdentifier };
  }

  async _waitForRequestedPage(url) {
    const deadline = Date.now() + this.startupProbeTimeoutMs;
    do {
      const status = await this._request('GET', '/v1/status');
      if (!status.unavailable && status.status >= 200 && status.status < 300
        && safeWebUrl(status.data?.url) === url) return status.data;
      if (Date.now() >= deadline) break;
      await this.sleep(Math.min(this.startupProbeIntervalMs, deadline - Date.now()));
    } while (Date.now() <= deadline);
    return null;
  }

  async _checkCurrentPage() {
    if (this._disabled()) return { ok: false, stderr: '3F Browser 제어가 꺼져 있습니다.' };
    if (!this.policy || typeof this.policy.check !== 'function') return { ok: false, stderr: 'Focus Fence 정책을 확인할 수 없어 페이지 접근을 중단했습니다.' };
    const status = await this._request('GET', '/v1/status');
    if (status.unavailable || status.status < 200 || status.status >= 300) {
      return { ok: false, stderr: status.data?.error || '3F Browser 제어 서비스에 연결할 수 없습니다.' };
    }
    const url = safeWebUrl(status.data.url);
    if (!url) return { ok: false, stderr: '3F Browser에 안전하게 읽거나 조작할 웹 페이지가 열려 있지 않습니다.' };
    let decision;
    try { decision = await this.policy.check(url); } catch (_) {}
    if (!decision?.allowed) {
      const stderr = decision?.reason === 'blocked'
        ? `Focus Fence 차단: ${decision.rule}`
        : 'Focus Fence 정책을 확인할 수 없어 페이지 접근을 중단했습니다.';
      this.lastError = stderr;
      return { ok: false, stderr, blocked: decision?.reason === 'blocked', url };
    }
    this.lastUrl = url;
    return { ok: true, url };
  }

  async _verifyReturnedPage(data) {
    const url = safeWebUrl(data?.url);
    if (!url) return { ok: false, stderr: '3F Browser 응답의 페이지 주소를 확인할 수 없어 내용을 반환하지 않았습니다.' };
    let decision;
    try { decision = await this.policy?.check?.(url); } catch (_) {}
    if (!decision?.allowed) {
      const blocked = decision?.reason === 'blocked';
      const stderr = blocked
        ? `Focus Fence 차단: ${decision.rule}`
        : 'Focus Fence 정책을 확인할 수 없어 페이지 내용을 반환하지 않았습니다.';
      this.lastError = stderr;
      return { ok: false, blocked, stderr, url };
    }
    this.lastUrl = url;
    this.lastError = '';
    return { ok: true, url };
  }

  async navigate(value) {
    if (this._disabled()) return { ok: false, stderr: '3F Browser 제어가 꺼져 있습니다.' };
    const safeUrl = safeWebUrl(value);
    if (!safeUrl) {
      return { ok: false, stderr: 'HTTP 또는 HTTPS 주소만 열 수 있습니다.' };
    }
    if (!this.isAvailable()) return { ok: false, stderr: '3F Browser 열기 연결을 사용할 수 없습니다.' };
    if (!this.policy || typeof this.policy.check !== 'function') {
      return { ok: false, stderr: 'Focus Fence 정책을 확인할 수 없어 탐색을 중단했습니다.' };
    }
    {
      let decision;
      try { decision = await this.policy.check(safeUrl); } catch (_) {}
      if (!decision?.allowed) {
        const stderr = decision?.reason === 'blocked'
          ? `Focus Fence 차단: ${decision.rule}`
          : 'Focus Fence 정책을 확인할 수 없어 탐색을 중단했습니다.';
        this.lastError = stderr;
        return { ok: false, stderr, url: safeUrl, blocked: decision?.reason === 'blocked' };
      }
    }
    let controlResult = await this._request('POST', '/v1/navigate', { url: safeUrl });
    if (controlResult.disabled) return { ok: false, stderr: '3F Browser 제어가 꺼져 있습니다.' };
    if (!controlResult.unavailable && controlResult.status === 503 && controlResult.data?.error === 'browser view not ready') {
      controlResult = { unavailable: true };
    }
    if (!controlResult.unavailable) {
      if (controlResult.status < 200 || controlResult.status >= 300 || controlResult.data?.ok === false) {
        const stderr = controlResult.data?.error || '3F Browser 탐색을 완료하지 못했습니다.';
        this.lastError = stderr;
        return { ok: false, stderr, url: safeUrl, blocked: controlResult.status === 403 };
      }
      const verifiedPage = await this._verifyReturnedPage(controlResult.data);
      if (!verifiedPage.ok) return { ok: false, stderr: verifiedPage.stderr, url: verifiedPage.url || '', blocked: verifiedPage.blocked === true };
      if (verifiedPage.url !== safeUrl) {
        const stderr = '요청한 주소와 실제 열린 3F Browser 주소가 다릅니다.';
        this.lastError = stderr;
        return { ok: false, stderr, url: verifiedPage.url };
      }
      return { ok: true, stdout: `3F Browser에서 페이지를 열었습니다: ${verifiedPage.url}`, stderr: '', url: verifiedPage.url };
    }
    if (typeof this.openExternal !== 'function') return { ok: false, stderr: '3F Browser 제어 서비스에 연결할 수 없습니다.', url: safeUrl };

    const deepLink = new URL('threef://open');
    deepLink.searchParams.set('url', safeUrl);
    try {
      await this.openExternal(deepLink.toString());
      const page = await this._waitForRequestedPage(safeUrl);
      if (!page) {
        this.lastError = '3F Browser 열기 요청은 전달했지만 제어 서비스 연결과 요청한 페이지를 확인하지 못했습니다.';
        return { ok: false, stdout: '', stderr: this.lastError, requested: true, url: safeUrl };
      }
      this.lastUrl = safeUrl;
      this.lastError = '';
      return { ok: true, stdout: `3F Browser에서 페이지를 열고 확인했습니다: ${safeUrl}`, stderr: '', url: safeUrl };
    } catch (_) {
      this.lastError = '3F Browser를 열지 못했습니다.';
      return { ok: false, stderr: this.lastError, url: safeUrl };
    }
  }

  async getStatus() {
    if (this._disabled()) return { enabled: false, available: false, isOpen: false, controlAvailable: false, activeUrl: '', statusText: '3F Browser 제어가 꺼져 있습니다.' };
    const controlResult = await this._request('GET', '/v1/status');
    // Older 3F builds report this while the selected tab is a blank new tab.
    // The authenticated response proves the control service is alive; only the page is not ready.
    if (!controlResult.unavailable && controlResult.status === 503 && controlResult.data?.error === 'browser view not ready') {
      return { enabled: true, available: true, isOpen: false, activeUrl: '', controlAvailable: true, statusText: '3F Browser 제어 서비스 연결됨 · 열린 페이지 없음' };
    }
    if (!controlResult.unavailable && controlResult.status >= 200 && controlResult.status < 300) {
      const activeUrl = safeWebUrl(controlResult.data.url);
      const pageOpen = Boolean(activeUrl);
      if (pageOpen) this.lastUrl = activeUrl;
      return {
        enabled: true, available: true, isOpen: pageOpen, activeUrl: pageOpen ? this.lastUrl : '', title: controlResult.data.title || '', controlAvailable: true,
        statusText: this.lastError || (pageOpen ? '3F Browser 제어 서비스 연결됨 · 페이지 열림' : '3F Browser 제어 서비스 연결됨 · 열린 페이지 없음')
      };
    }
    return {
      enabled: true, available: typeof this.openExternal === 'function', isOpen: false, activeUrl: '', controlAvailable: false,
      statusText: this.lastError || (typeof this.openExternal === 'function'
        ? '3F Browser 제어 서비스 사용 불가 · deep-link 열기만 가능'
        : '3F Browser 열기 연결을 사용할 수 없습니다.')
    };
  }

  async getAriaTree() {
    const page = await this._checkCurrentPage();
    if (!page.ok) return { ok: false, tabId: null, url: page.url || this.lastUrl, ariaTree: page.stderr, blocked: page.blocked === true };
    const result = await this._request('GET', '/v1/aria');
    if (result.disabled) return { ok: false, tabId: null, url: this.lastUrl, ariaTree: '3F Browser 제어가 꺼져 있습니다.' };
    if (result.unavailable || result.status < 200 || result.status >= 300) {
      return { ok: false, tabId: null, url: this.lastUrl, ariaTree: result.data?.error || '3F Browser 제어 서비스에 연결할 수 없습니다.' };
    }
    const verifiedPage = await this._verifyReturnedPage(result.data);
    if (!verifiedPage.ok) return { ok: false, tabId: null, url: verifiedPage.url || this.lastUrl, ariaTree: verifiedPage.stderr, blocked: verifiedPage.blocked === true };
    return { ok: true, tabId: '3f-browser', url: this.lastUrl, ariaTree: result.data.ariaTree || '' };
  }
  async readText() {
    const page = await this._checkCurrentPage();
    if (!page.ok) return { ok: false, stdout: '', stderr: page.stderr, blocked: page.blocked === true };
    const result = await this._request('GET', '/v1/read');
    if (result.disabled) return { ok: false, stdout: '', stderr: '3F Browser 제어가 꺼져 있습니다.' };
    if (result.unavailable || result.status < 200 || result.status >= 300) {
      return { ok: false, stdout: '', stderr: result.data?.error || '3F Browser 제어 서비스에 연결할 수 없습니다.' };
    }
    const verifiedPage = await this._verifyReturnedPage(result.data);
    if (!verifiedPage.ok) return { ok: false, stdout: '', stderr: verifiedPage.stderr, blocked: verifiedPage.blocked === true };
    return { ok: true, stdout: result.data.text || '', stderr: '' };
  }
  async history(action) {
    if (this._disabled()) return { ok: false, stderr: '3F Browser 제어가 꺼져 있습니다.' };
    if (!['back', 'forward', 'reload'].includes(action)) return { ok: false, stderr: '지원하지 않는 3F Browser 탐색 동작입니다.' };
    if (!this.policy || typeof this.policy.check !== 'function') return { ok: false, stderr: 'Focus Fence 정책을 확인할 수 없어 탐색을 중단했습니다.' };
    const status = await this._request('GET', '/v1/status');
    if (status.disabled) return { ok: false, stderr: '3F Browser 제어가 꺼져 있습니다.' };
    if (status.unavailable || status.status < 200 || status.status >= 300) return { ok: false, stderr: status.data?.error || '3F Browser 제어 서비스에 연결할 수 없습니다.' };
    const targetValue = action === 'back' ? status.data.backURL : action === 'forward' ? status.data.forwardURL : status.data.url;
    const target = safeWebUrl(targetValue);
    if (!target) return { ok: false, stderr: '이동할 안전한 3F Browser 페이지가 없습니다.' };
    let decision;
    try { decision = await this.policy.check(target); } catch (_) {}
    if (!decision?.allowed) return { ok: false, blocked: decision?.reason === 'blocked', stderr: decision?.reason === 'blocked' ? `Focus Fence 차단: ${decision.rule}` : 'Focus Fence 정책을 확인할 수 없어 탐색을 중단했습니다.' };
    const result = await this._request('POST', '/v1/history', { action });
    if (result.disabled) return { ok: false, stderr: '3F Browser 제어가 꺼져 있습니다.' };
    if (result.unavailable || result.status < 200 || result.status >= 300 || result.data?.ok !== true) return { ok: false, stderr: result.data?.error || '3F Browser 탐색 동작을 완료하지 못했습니다.' };
    const verifiedPage = await this._verifyReturnedPage(result.data);
    if (!verifiedPage.ok) return { ok: false, blocked: verifiedPage.blocked === true, stderr: verifiedPage.stderr, url: verifiedPage.url || '' };
    this.lastUrl = verifiedPage.url;
    return { ok: true, stdout: `3F Browser ${action} 완료`, stderr: '', url: this.lastUrl };
  }
  async act(action) {
    const page = await this._checkCurrentPage();
    if (!page.ok) return { ok: false, stdout: '', stderr: page.stderr, blocked: page.blocked === true };
    const result = await this._request('POST', '/v1/act', { action: String(action || '') });
    if (result.disabled) return { ok: false, stdout: '', stderr: '3F Browser 제어가 꺼져 있습니다.' };
    if (result.unavailable || result.status < 200 || result.status >= 300) {
      return { ok: false, stdout: '', stderr: result.data?.error || '3F Browser 제어 서비스에 연결할 수 없습니다.' };
    }
    if (result.data?.ok !== true) return { ok: false, stdout: '', stderr: result.data?.error || result.data?.result || '브라우저 동작 실패' };
    let responseData = result.data;
    if (typeof responseData.url !== 'string') {
      const currentPage = await this._request('GET', '/v1/status');
      if (currentPage.unavailable || currentPage.status < 200 || currentPage.status >= 300) {
        return { ok: false, stdout: '', stderr: currentPage.data?.error || '3F Browser 동작 후 현재 페이지를 확인하지 못했습니다.' };
      }
      responseData = currentPage.data;
    }
    const verifiedPage = await this._verifyReturnedPage(responseData);
    if (!verifiedPage.ok) return { ok: false, stdout: '', stderr: verifiedPage.stderr, blocked: verifiedPage.blocked === true };
    return { ok: true, stdout: result.data?.result || '', stderr: '' };
  }
  async recipePlay() {
    return this._disabled()
      ? { ok: false, stdout: '', stderr: '3F Browser 제어가 꺼져 있습니다.' }
      : { ok: false, stdout: '', stderr: '3F Browser 자동화 레시피 연결은 아직 제공되지 않습니다.' };
  }
}

module.exports = { ThreefBrowserBridge };
