'use strict';

const { normalizeHttpUrl } = require('./FocusFencePolicy.js');
const { buildFocusFenceContentScript } = require('./FocusFenceContent.js');

class EmbeddedBrowser {
  constructor(options = {}) {
    this.BrowserWindow = options.BrowserWindow;
    this.session = options.session;
    this.policy = options.policy;
    this.window = null;
    this.activeUrl = 'about:blank';
    this.lastError = '';
    this.approvedUrl = null;
    this.policyTimer = null;
  }

  isAvailable() { return Boolean(this.BrowserWindow && this.policy); }

  async launch(url = 'https://google.com') { return this.navigate(url); }

  async navigate(value) {
    const url = normalizeHttpUrl(value);
    const decision = await this.policy.check(url);
    if (!decision.allowed) {
      this.lastError = decision.reason === 'blocked'
        ? `Focus Fence 차단: ${decision.rule}`
        : decision.reason === 'focus_fence_unavailable'
          ? 'Focus Fence 규칙 서비스에 연결할 수 없어 탐색을 중단했습니다.'
          : 'Focus Fence 정책을 확인하지 못해 탐색을 중단했습니다.';
      this.activeUrl = url;
      if (this.window && !this.window.isDestroyed()) {
        await this.window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(this._blockedHtml(this.lastError, url))}`);
        this.window.show();
      }
      return { ok: false, stdout: '', stderr: this.lastError, url, blocked: true };
    }
    this.lastError = '';
    this.activeUrl = url;
    this._ensureWindow();
    this.approvedUrl = url;
    await this.window.loadURL(url);
    this.window.show();
    this.window.focus();
    return { ok: true, stdout: `내장 브라우저에서 열었습니다: ${url}`, stderr: '', url };
  }

  _ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return;
    this.window = new this.BrowserWindow({
      width: 1180, height: 820, minWidth: 720, minHeight: 520,
      title: 'Only Chat Browser', autoHideMenuBar: true,
      webPreferences: { session: this.session, contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    const contents = this.window.webContents;
    const contentsId = contents.id;
    this.session?.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      if (details.webContentsId !== contentsId || details.resourceType !== 'subFrame') return callback({});
      this.policy.check(details.url).then(decision => {
        callback(decision.allowed ? {} : { cancel: true });
      }).catch(() => callback({ cancel: true }));
    });
    contents.setWindowOpenHandler(({ url }) => {
      void this.navigate(url).catch(error => { this.lastError = error.message; });
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (url === this.approvedUrl) { this.approvedUrl = null; return; }
      event.preventDefault();
      void this.navigate(url).catch(error => { this.lastError = error.message; });
    });
    contents.on('will-redirect', (event, url) => {
      event.preventDefault();
      void this.navigate(url).catch(error => { this.lastError = error.message; });
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      void this.policy.check(url).then(decision => {
        if (decision.allowed) return this._applyContentPolicy();
        if (!this.window || this.window.isDestroyed()) return;
        this.lastError = decision.reason === 'blocked'
          ? `Focus Fence 차단: ${decision.rule}`
          : 'Focus Fence 정책을 확인하지 못해 탐색을 중단했습니다.';
        this.activeUrl = url;
        return this.window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(this._blockedHtml(this.lastError, url))}`);
      }).catch(() => {});
    });
    contents.on('page-title-updated', (_event, title) => {
      if (!this.window.isDestroyed()) this.window.setTitle(`Only Chat Browser · ${title}`);
    });
    contents.on('did-finish-load', () => { void this._applyContentPolicy().catch(() => {}); });
    this.policyTimer = setInterval(() => { void this._applyContentPolicy().catch(() => {}); }, 5000);
    this.policyTimer.unref?.();
    this.window.on('closed', () => {
      clearInterval(this.policyTimer);
      this.policyTimer = null;
      this.window = null;
      this.activeUrl = 'about:blank';
    });
  }

  async _applyContentPolicy() {
    if (!this.window || this.window.isDestroyed()) return;
    const url = this.window.webContents.getURL();
    if (!/^https?:\/\//i.test(url)) return;
    const snapshot = await this.policy.getRules();
    if (!snapshot) return;
    const code = buildFocusFenceContentScript(snapshot.rules);
    if (this.window.webContents.executeJavaScriptInIsolatedWorld) {
      await this.window.webContents.executeJavaScriptInIsolatedWorld(991, [{ code }]);
    } else {
      await this.window.webContents.executeJavaScript(code);
    }
  }

  _blockedHtml(message, url) {
    return `<!doctype html><meta charset="utf-8"><title>Focus Fence 차단</title><style>body{font:16px system-ui;background:#111827;color:#f9fafb;display:grid;place-items:center;min-height:90vh}main{max-width:640px;padding:32px}p{overflow-wrap:anywhere;color:#cbd5e1}</style><main><h1>Focus Fence가 탐색을 차단했습니다</h1><p>${this._escape(message)}</p><p>${this._escape(url)}</p></main>`;
  }

  _escape(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

  async getStatus() {
    const rules = await this.policy.getRules();
    return {
      available: this.isAvailable(), isOpen: Boolean(this.window && !this.window.isDestroyed()),
      activeUrl: this.window && !this.window.isDestroyed() ? this.window.webContents.getURL() : this.activeUrl,
      focusFenceConnected: Boolean(rules), protectionEnabled: rules?.rules.protectionEnabled ?? null,
      statusText: this.lastError || (rules ? 'Focus Fence 정책 연결됨' : 'Focus Fence 규칙 서비스에 연결되지 않음')
    };
  }

  async getAriaTree() {
    if (!this.window || this.window.isDestroyed()) return { tabId: null, url: this.activeUrl, ariaTree: '브라우저가 열려 있지 않습니다.' };
    const ariaTree = await this.window.webContents.executeJavaScript(`(() => {
      const els = [...document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"],[role="textbox"]')];
      let n = 0;
      return els.slice(0, 100).map(el => {
        const id = 'oc-agent-' + (++n); el.dataset.ocAgentId = id;
        const label = el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || '';
        return '[' + id + '] ' + (el.getAttribute('role') || el.tagName.toLowerCase()) + ' ' + String(label).trim().replace(/\\s+/g, ' ').slice(0, 180);
      }).filter(x => !x.endsWith(' ')).join('\\n') + '\\n' + document.body.innerText.slice(0, 6000);
    })()`);
    return { tabId: 'onlychat', url: this.window.webContents.getURL(), ariaTree };
  }

  async readText() {
    if (!this.window || this.window.isDestroyed()) return { ok: false, stdout: '', stderr: '브라우저가 열려 있지 않습니다.' };
    const stdout = await this.window.webContents.executeJavaScript('document.body.innerText.slice(0, 12000)');
    return { ok: true, stdout, stderr: '' };
  }

  async act(action) {
    if (String(action).trim() === 'read') return this.readText();
    if (!this.window || this.window.isDestroyed()) return { ok: false, stderr: '브라우저가 열려 있지 않습니다.' };
    const match = String(action || '').trim().match(/^(click|type|fill)\s+\[?(oc-agent-\d+)\]?\s*(.*)$/i);
    if (!match) return { ok: false, stderr: '지원 동작: click [oc-agent-N], type [oc-agent-N] 텍스트' };
    const [, operation, id, value] = match;
    const result = await this.window.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('[data-oc-agent-id="${id}"]'); if (!el) return '요소를 찾지 못했습니다.';
      if (${JSON.stringify(operation.toLowerCase())} === 'click') { el.click(); return '클릭했습니다.'; }
      if (!('value' in el)) return '입력 가능한 요소가 아닙니다.';
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      setter ? setter.call(el, ${JSON.stringify(value)}) : (el.value = ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      return '입력했습니다.';
    })()`);
    return { ok: result.endsWith('했습니다.'), stdout: result, stderr: result.endsWith('했습니다.') ? '' : result };
  }

  async recipePlay() { return { ok: false, stderr: 'Aside 브라우저 레시피는 내장 브라우저에서 지원되지 않습니다.' }; }
}

module.exports = { EmbeddedBrowser };
