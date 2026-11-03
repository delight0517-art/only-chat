/**
 * @project My-Codex
 * @provenance:rogan-core
 * @author Rogan Kim (GeunHu Kim) & AI Architect
 * @license MIT
 * @description Notion API Connector with Database Query & Edit Capabilities.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const NOTION_API_VERSION = '2026-03-11';
const NOTION_API_BASE = 'https://api.notion.com';
const READ_METHODS = new Set(['GET', 'POST']);
const WRITE_METHODS = new Set(['POST', 'PATCH', 'DELETE']);
const READ_ONLY_POST_PATHS = [/^\/v1\/search$/, /^\/v1\/data_sources\/[^/]+\/query$/, /^\/v1\/views\/[^/]+\/query$/];

class NotionConnector {
  constructor(options = {}) {
    this.storageDir = options.storageDir || options.dataDir || path.join(os.homedir(), '.my-codex');
    this.tokenFile = path.join(this.storageDir, 'notion_tokens.json');
    this.apiKey = options.apiKey || (options.readEnvironment === false ? null : process.env.NOTION_API_KEY) || null;
    this.fetch = options.fetch || globalThis.fetch;

    this.tokens = this._loadTokens();
    if (this.tokens?.apiKey) {
      this.apiKey = this.tokens.apiKey;
    }
  }

  _loadTokens() {
    if (fs.existsSync(this.tokenFile)) {
      try {
        return JSON.parse(fs.readFileSync(this.tokenFile, 'utf8'));
      } catch (_) {}
    }
    return null;
  }

  saveToken(apiKey) {
    const token = String(apiKey || '').trim();
    if (token.length < 20 || token.length > 4096) throw new Error('유효한 Notion 연결 토큰을 입력해 주세요.');
    this.apiKey = token;
    this.tokens = {
      apiKey: this.apiKey,
      updatedAt: Date.now()
    };
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(this.tokenFile, JSON.stringify(this.tokens, null, 2), { mode: 0o600 });
    fs.chmodSync(this.tokenFile, 0o600);
    return this.tokens;
  }

  isConnected() {
    return !!(this.apiKey && this.apiKey.length > 5);
  }

  async verifyToken(token = this.apiKey) {
    const value = String(token || '').trim();
    if (!value) throw new Error('Notion 연결 토큰이 필요합니다.');
    return this._request('/v1/users/me', 'GET', null, value);
  }

  async apiRead(method, endpoint, query = {}, body = null) {
    const verb = String(method || 'GET').toUpperCase();
    const pathname = this._requestUrl(endpoint).pathname;
    if (!READ_METHODS.has(verb) || (verb === 'POST' && !READ_ONLY_POST_PATHS.some(pattern => pattern.test(pathname)))) {
      throw new Error('Notion 읽기 도구는 GET 또는 확인된 읽기 전용 검색·쿼리 POST만 지원합니다.');
    }
    return this._request(endpoint, verb, verb === 'GET' ? query : body);
  }

  async apiWrite(method, endpoint, body) {
    const verb = String(method || '').toUpperCase();
    if (!WRITE_METHODS.has(verb)) throw new Error('Notion 쓰기 요청은 POST, PATCH 또는 DELETE만 지원합니다.');
    return this._request(endpoint, verb, verb === 'DELETE' && body === undefined ? null : body);
  }

  /**
   * Search databases and pages in Notion
   */
  async search(query = '', filterKind = null) {
    const payload = { query };
    if (filterKind) {
      payload.filter = { value: filterKind === 'database' ? 'data_source' : filterKind, property: 'object' };
    }
    return this._request('/v1/search', 'POST', payload);
  }

  /**
   * Query records in a specific Notion database
   */
  async queryDatabase(dataSourceId, filter = null, sorts = null) {
    const payload = {};
    if (filter) payload.filter = filter;
    if (sorts) payload.sorts = sorts;
    return this._request(`/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`, 'POST', payload);
  }

  /**
   * Get metadata of a page
   */
  async getPage(pageId) {
    return this._request(`/v1/pages/${encodeURIComponent(pageId)}`, 'GET');
  }

  /**
   * Read block children (paragraphs, headings, items) of a page
   */
  async getPageContent(pageId) {
    return this._request(`/v1/blocks/${encodeURIComponent(pageId)}/children`, 'GET', { page_size: 100 });
  }

  /**
   * Create a new page / record in a database
   */
  async createPage(dataSourceId, title, properties = {}, children = []) {
    const parent = { data_source_id: dataSourceId };
    const pageProps = {
      ...properties,
      title: {
        title: [{ text: { content: title } }]
      }
    };
    return this._request('/v1/pages', 'POST', {
      parent,
      properties: pageProps,
      children
    });
  }

  /**
   * Update properties of an existing page
   */
  async updatePage(pageId, properties = {}) {
    return this._request(`/v1/pages/${encodeURIComponent(pageId)}`, 'PATCH', { properties });
  }

  /**
   * Append content blocks to a Notion page or block
   */
  async appendBlocks(blockId, blocks = []) {
    return this._request(`/v1/blocks/${encodeURIComponent(blockId)}/children`, 'PATCH', { children: blocks });
  }

  _requestUrl(endpoint, query) {
    const url = new URL(String(endpoint || ''), NOTION_API_BASE);
    if (url.origin !== NOTION_API_BASE || url.username || url.password || url.hash || !url.pathname.startsWith('/v1/')) {
      throw new Error('Notion 요청 경로는 api.notion.com의 /v1 API로 제한됩니다.');
    }
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
    return url;
  }

  async _request(endpoint, method, data = null, token = this.apiKey) {
    if (!token || token.length < 20) {
      throw new Error('Notion API 키가 연결되어 있지 않습니다. 먼저 토큰을 등록하세요.');
    }
    const verb = String(method || '').toUpperCase();
    if (!READ_METHODS.has(verb) && !WRITE_METHODS.has(verb)) throw new Error('지원하지 않는 Notion API 요청 방식입니다.');
    const url = this._requestUrl(endpoint, verb === 'GET' ? data : null);
    const options = {
      method: verb,
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_API_VERSION,
        Accept: 'application/json',
        ...(verb === 'GET' || (verb === 'DELETE' && data == null) ? {} : { 'Content-Type': 'application/json' })
      },
      ...(verb === 'GET' || (verb === 'DELETE' && data == null) ? {} : { body: JSON.stringify(data ?? {}) }),
      signal: AbortSignal.timeout(30_000)
    };

    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await this.fetch(url, options);
      const raw = await response.text();
      let result = {};
      if (raw) {
        try { result = JSON.parse(raw); } catch (_) { result = raw; }
      }
      if (response.ok) return result;

      const code = result?.code || 'notion_api_error';
      const retryable = [429, 529].includes(response.status)
        || (verb === 'GET' && [500, 502, 503, 504].includes(response.status));
      if (retryable && attempt < 3 && code !== 'public_api_request_blocked') {
        const retryAfter = Number.parseInt(response.headers?.get?.('retry-after') || '', 10);
        const delayMs = Number.isFinite(retryAfter) ? Math.max(0, Math.min(60_000, retryAfter * 1000)) : Math.min(8_000, 500 * (2 ** attempt));
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
      const error = new Error(result?.message || `Notion API returned HTTP ${response.status} (${code}).`);
      error.status = response.status;
      error.code = code;
      error.retryAfter = response.headers?.get?.('retry-after') || null;
      throw error;
    }
    throw new Error('Notion API request retry limit reached.');
  }
}

module.exports = { NOTION_API_VERSION, NotionConnector };
