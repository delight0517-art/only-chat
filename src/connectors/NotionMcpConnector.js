'use strict';

const crypto = require('node:crypto');
const { NotionCredentialStore } = require('./NotionCredentialStore.js');

const SERVER_URL = 'https://mcp.notion.com';
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function sameSecret(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

class NotionMcpConnector {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch;
    this.credentialStore = options.credentialStore || new NotionCredentialStore(options.credentialStoreOptions || {});
    this.redirectUri = options.redirectUri || 'http://localhost:8899/api/connectors/notion/callback';
    this.clientName = options.clientName || 'Only Chat';
    this.resourceMetadata = null;
    this.oauthMetadata = null;
    this.pendingAuth = null;
    this.credentials = null;
    this.credentialsLoaded = false;
    this.credentialsLoading = null;
    this.refreshing = null;
    this.toolCache = new Map();
    this.rpcId = 0;
    this.mcpSessionId = null;
    this.sessionToken = null;
    this.initializing = null;
  }

  async _jsonResponse(response, label) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error(`${label} 응답이 허용 크기를 넘었습니다.`);
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch (_) { body = {}; }
    if (!response.ok) {
      const error = new Error(body?.error_description || body?.message || body?.error || `${label} 요청 실패 (HTTP ${response.status}).`);
      error.status = response.status;
      error.code = body?.error || body?.code || null;
      throw error;
    }
    return { body, text, contentType: response.headers?.get?.('content-type') || '' };
  }

  async _getMetadata() {
    if (this.oauthMetadata) return this.oauthMetadata;
    if (!this.resourceMetadata) {
      const resourceUrl = new URL('/.well-known/oauth-protected-resource', SERVER_URL);
      const resourceResponse = await this.fetch(resourceUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000)
      });
      const { body: resource } = await this._jsonResponse(resourceResponse, 'Notion 보호 리소스 탐색');
      if (resource.resource !== SERVER_URL || !Array.isArray(resource.authorization_servers) || !resource.authorization_servers.length) {
        throw new Error('Notion 보호 리소스 정보가 예상한 MCP 서버와 일치하지 않습니다.');
      }
      const authServer = resource.authorization_servers[0];
      if (authServer !== SERVER_URL) throw new Error('Notion이 반환한 인증 서버가 신뢰된 Notion MCP 서버와 일치하지 않습니다.');
      this.resourceMetadata = resource;
    }
    const authServer = this.resourceMetadata.authorization_servers[0];
    const metadataUrl = new URL('/.well-known/oauth-authorization-server', authServer);
    const response = await this.fetch(metadataUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000)
    });
    const { body } = await this._jsonResponse(response, 'Notion OAuth 탐색');
    const endpointNames = ['authorization_endpoint', 'token_endpoint', 'registration_endpoint'];
    if (body.issuer !== authServer || endpointNames.some(name => {
      try { return new URL(body[name]).origin !== new URL(authServer).origin; } catch (_) { return true; }
    }) || !body.code_challenge_methods_supported?.includes('S256')) {
      throw new Error('Notion OAuth 서버 정보가 예상한 Notion 엔드포인트와 일치하지 않습니다.');
    }
    this.oauthMetadata = body;
    return body;
  }

  async _registerClient(metadata, redirectUri) {
    await this._loadCredentials();
    if (this.credentials?.clientId) return { client_id: this.credentials.clientId };
    const response = await this.fetch(metadata.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: this.clientName,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'default'
      }),
      signal: AbortSignal.timeout(15_000)
    });
    const { body } = await this._jsonResponse(response, 'Notion OAuth 클라이언트 등록');
    if (typeof body.client_id !== 'string' || !body.client_id) throw new Error('Notion OAuth 등록에서 client_id를 받지 못했습니다.');
    return body;
  }

  async getAuthUrl(redirectUri = this.redirectUri) {
    if (this.pendingAuth?.expiresAt > Date.now()) throw new Error('Notion 로그인이 이미 진행 중입니다. 열린 Notion 로그인 창을 확인해 주세요.');
    this.pendingAuth = null;
    const metadata = await this._getMetadata();
    const client = await this._registerClient(metadata, redirectUri);
    const verifier = b64url(crypto.randomBytes(32));
    const state = crypto.randomBytes(32).toString('hex');
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    this.pendingAuth = { clientId: client.client_id, redirectUri, verifier, state, expiresAt: Date.now() + 10 * 60_000 };
    const url = new URL(metadata.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope: 'default',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'consent'
    }).toString();
    return url.href;
  }

  cancelPendingAuth() {
    this.pendingAuth = null;
  }

  async exchangeOAuthCallback(code, state, issuer = null) {
    const pending = this.pendingAuth;
    this.pendingAuth = null;
    if (!pending || pending.expiresAt < Date.now() || !sameSecret(state, pending.state)) {
      throw new Error('Notion 로그인 상태 확인에 실패했거나 로그인 요청이 만료되었습니다. 다시 연결해 주세요.');
    }
    if (issuer && issuer !== SERVER_URL) throw new Error('Notion OAuth 발급자 확인에 실패했습니다. 다시 연결해 주세요.');
    if (typeof code !== 'string' || !code || code.length > 4096) throw new Error('Notion OAuth 인증 코드가 올바르지 않습니다.');
    const metadata = await this._getMetadata();
    const response = await this.fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: pending.clientId,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.verifier
      }).toString(),
      signal: AbortSignal.timeout(20_000)
    });
    const { body } = await this._jsonResponse(response, 'Notion 로그인 완료');
    if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
      throw new Error('Notion OAuth 응답에 access token 또는 refresh token이 없습니다.');
    }
    this.credentials = {
      version: 1,
      clientId: pending.clientId,
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Number.isFinite(body.expires_in) ? Date.now() + body.expires_in * 1000 : Date.now() + 60 * 60_000,
      workspaceId: body.workspace_id || null,
      workspaceName: body.workspace_name || null,
      userId: body.user_id || null
    };
    await this._saveCredentials();
    this.credentialsLoaded = true;
    this.sessionToken = null;
    this.toolCache.clear();
    return { workspaceId: this.credentials.workspaceId, workspaceName: this.credentials.workspaceName, userId: this.credentials.userId };
  }

  async _loadCredentials() {
    if (this.credentialsLoaded) return this.credentials;
    if (!this.credentialsLoading) {
      this.credentialsLoading = (async () => {
        const raw = await this.credentialStore.get();
        if (typeof raw === 'string') {
          try {
            const parsed = JSON.parse(raw);
            if (parsed?.version === 1 && parsed.clientId && parsed.refreshToken) this.credentials = parsed;
          } catch (_) {}
        }
        this.credentialsLoaded = true;
        return this.credentials;
      })().finally(() => { this.credentialsLoading = null; });
    }
    return this.credentialsLoading;
  }

  async _saveCredentials() {
    await this.credentialStore.set(JSON.stringify(this.credentials));
  }

  async isConnected() {
    await this._loadCredentials();
    return Boolean(this.credentials?.refreshToken);
  }

  async status() {
    await this._loadCredentials();
    return {
      connected: Boolean(this.credentials?.refreshToken),
      workspaceName: this.credentials?.workspaceName || null,
      workspaceId: this.credentials?.workspaceId || null,
      auth: 'Notion MCP OAuth + PKCE'
    };
  }

  authStatus() {
    return { connected: !this.pendingAuth && this.credentialsLoaded && Boolean(this.credentials?.refreshToken) };
  }

  async disconnect() {
    await this.credentialStore.delete();
    this.credentials = null;
    this.credentialsLoaded = true;
    this.sessionToken = null;
    this.toolCache.clear();
  }

  async _refreshAccessToken() {
    await this._loadCredentials();
    if (!this.credentials?.refreshToken) throw new Error('Notion 연결이 없습니다. Only Chat 설정에서 Notion에 로그인해 주세요.');
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const metadata = await this._getMetadata();
      const response = await this.fetch(metadata.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.credentials.refreshToken,
          client_id: this.credentials.clientId
        }).toString(),
        signal: AbortSignal.timeout(20_000)
      });
      let result;
      try { result = await this._jsonResponse(response, 'Notion 로그인 갱신'); }
      catch (error) {
        if (error.code === 'invalid_grant') {
          await this.disconnect();
          throw new Error('Notion 로그인이 만료되었거나 취소되었습니다. Only Chat 설정에서 다시 연결해 주세요.');
        }
        throw error;
      }
      const body = result.body;
      if (typeof body.access_token !== 'string') throw new Error('Notion 로그인 갱신에서 access token을 받지 못했습니다.');
      this.credentials = {
        ...this.credentials,
        accessToken: body.access_token,
        refreshToken: body.refresh_token || this.credentials.refreshToken,
        expiresAt: Number.isFinite(body.expires_in) ? Date.now() + body.expires_in * 1000 : Date.now() + 60 * 60_000
      };
      await this._saveCredentials();
      this.sessionToken = null;
      return this.credentials.accessToken;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async _accessToken(forceRefresh = false) {
    await this._loadCredentials();
    if (!this.credentials?.refreshToken) throw new Error('Notion 미연결: Only Chat 설정에서 Notion 로그인을 완료해 주세요.');
    if (forceRefresh || !this.credentials.accessToken || this.credentials.expiresAt <= Date.now() + 60_000) return this._refreshAccessToken();
    return this.credentials.accessToken;
  }

  async _readRpcResponse(response) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error('Notion MCP 응답이 10 MiB 제한을 넘었습니다.');
    if (!response.ok) {
      let body = {};
      try { body = JSON.parse(text); } catch (_) {}
      const error = new Error(body?.error?.message || body?.message || `Notion MCP 요청 실패 (HTTP ${response.status}).`);
      error.status = response.status;
      error.code = body?.error?.code || null;
      throw error;
    }
    const contentType = response.headers?.get?.('content-type') || '';
    if (contentType.includes('text/event-stream')) {
      const frames = text.split(/\r?\n\r?\n/);
      const messages = [];
      for (const frame of frames) {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (data && data !== '[DONE]') {
          try { messages.push(JSON.parse(data)); } catch (_) {}
        }
      }
      return messages.at(-1) || {};
    }
    try { return text ? JSON.parse(text) : {}; } catch (_) { throw new Error('Notion MCP가 올바르지 않은 응답을 반환했습니다.'); }
  }

  async _rpc(method, params = {}, retryAuth = true) {
    const token = await this._accessToken();
    const id = ++this.rpcId;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-03-26'
    };
    if (this.mcpSessionId) headers['Mcp-Session-Id'] = this.mcpSessionId;
    const response = await this.fetch(`${SERVER_URL}/mcp`, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(90_000)
    });
    const sessionId = response.headers?.get?.('mcp-session-id');
    if (sessionId) this.mcpSessionId = sessionId;
    if (response.status === 401 && retryAuth) {
      await response.body?.cancel?.();
      await this._refreshAccessToken();
      this.mcpSessionId = null;
      this.initializing = null;
      return this._rpc(method, params, false);
    }
    const result = await this._readRpcResponse(response);
    if (result.error) throw new Error(result.error.message || 'Notion MCP 도구 호출이 실패했습니다.');
    return result.result || null;
  }

  async _notify(method, params = {}) {
    const token = await this._accessToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-03-26'
    };
    if (this.mcpSessionId) headers['Mcp-Session-Id'] = this.mcpSessionId;
    const response = await this.fetch(`${SERVER_URL}/mcp`, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      signal: AbortSignal.timeout(15_000)
    });
    if (response.status === 401) {
      await response.body?.cancel?.();
      await this._refreshAccessToken();
      this.mcpSessionId = null;
      this.sessionToken = null;
      return;
    }
    if (![200, 202, 204].includes(response.status)) await this._readRpcResponse(response);
    else await response.body?.cancel?.();
  }

  async _ensureSession() {
    const token = await this._accessToken();
    if (this.sessionToken === token) return;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const result = await this._rpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'Only Chat', version: '1.0.1' }
      });
      if (!result?.protocolVersion) throw new Error('Notion MCP initialize 응답에 프로토콜 정보가 없습니다.');
      this.sessionToken = await this._accessToken();
      await this._notify('notifications/initialized', {});
    })().finally(() => { this.initializing = null; });
    return this.initializing;
  }

  async listTools() {
    await this._ensureSession();
    const result = await this._rpc('tools/list', {});
    if (!Array.isArray(result?.tools)) throw new Error('Notion MCP가 사용 가능한 도구 목록을 반환하지 않았습니다.');
    this.toolCache.clear();
    for (const tool of result.tools) if (typeof tool.name === 'string') this.toolCache.set(tool.name, tool);
    return result.tools;
  }

  isReadOnlyTool(name) {
    return this.toolCache.get(name)?.annotations?.readOnlyHint === true;
  }

  async callTool(name, args = {}) {
    if (typeof name !== 'string' || name.length > 200 || !args || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error('Notion MCP 도구 이름 또는 인자가 올바르지 않습니다.');
    }
    if (!this.toolCache.has(name)) await this.listTools();
    if (!this.toolCache.has(name)) throw new Error('해당 도구는 현재 Notion 로그인에서 사용할 수 없습니다.');
    await this._ensureSession();
    const result = await this._rpc('tools/call', { name, arguments: args });
    if (result?.isError) throw new Error(result.content?.map(item => item.text).filter(Boolean).join('\n') || 'Notion 도구가 실패했습니다.');
    return result;
  }
}

module.exports = { NotionMcpConnector, SERVER_URL };
