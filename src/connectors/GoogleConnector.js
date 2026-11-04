/**
 * @project My-Codex
 * @provenance:rogan-core
 * @author Rogan Kim (GeunHu Kim) & AI Architect
 * @license MIT
 * @description Google Workspace Connector (Drive & Gmail) with Full Edit Permissions.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const crypto = require('node:crypto');

const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];
const MAX_DRIVE_READ_BYTES = 1024 * 1024;
const WORKSPACE_EXPORTS = Object.freeze({
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain'
});

class GoogleConnector {
  constructor(options = {}) {
    this.storageDir = options.storageDir || options.dataDir || path.join(os.homedir(), '.my-codex');
    this.tokenFile = options.tokenFile ? path.resolve(options.tokenFile) : path.join(this.storageDir, 'google_tokens.json');
    this.clientConfigFile = options.clientConfigFile === false ? null : (options.clientConfigFile || path.join(os.homedir(), '.config/m-oasis/google-oauth/desktop-client.json'));

    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.redirectUri = options.redirectUri || 'http://localhost:8899/api/connectors/google/callback';
    this.oauthState = null;

    this._initClientConfig();
    this.tokens = this._loadTokens();
  }

  _initClientConfig() {
    if (!this.clientId && this.clientConfigFile && fs.existsSync(this.clientConfigFile)) {
      try {
        const raw = fs.readFileSync(this.clientConfigFile, 'utf8');
        const parsed = JSON.parse(raw);
        const installed = parsed.installed || parsed.web || {};
        this.clientId = installed.client_id;
        this.clientSecret = installed.client_secret;
      } catch (_) {}
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

  saveTokens(tokens) {
    this.tokens = {
      ...this.tokens,
      ...tokens,
      updatedAt: Date.now()
    };
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(this.tokenFile, JSON.stringify(this.tokens, null, 2), { mode: 0o600 });
    return this.tokens;
  }

  isConnected() {
    return !!(this.tokens && (this.tokens.access_token || this.tokens.refresh_token));
  }

  /**
   * Generate Google OAuth 2.0 authorization URL requesting full Drive & Gmail edit scopes
   */
  getAuthUrl() {
    if (!this.clientId) {
      throw new Error('Google OAuth Client ID가 구성되지 않았습니다.');
    }
    this.oauthState = crypto.randomBytes(32).toString('hex');
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: DEFAULT_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state: this.oauthState
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access & refresh tokens
   */
  async exchangeCode(code, state) {
    const expectedState = Buffer.from(this.oauthState || '');
    const receivedState = Buffer.from(state || '');
    if (!this.oauthState || receivedState.length !== expectedState.length || !crypto.timingSafeEqual(receivedState, expectedState)) {
      throw new Error('Google OAuth state 검증에 실패했습니다. 다시 연결해 주세요.');
    }
    this.oauthState = null;
    const postData = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code'
    }).toString();

    const res = await this._httpRequest('oauth2.googleapis.com', '/token', 'POST', postData, {
      'Content-Type': 'application/x-www-form-urlencoded'
    });

    if (res.error) {
      throw new Error(`Google OAuth exchange failed: ${res.error_description || res.error}`);
    }

    return this.saveTokens(res);
  }

  async getAccessToken() {
    if (!this.tokens) throw new Error('Google 계정이 연결되어 있지 않습니다. 먼저 로그인하세요.');
    
    // Check if token is expired
    const isExpired = this.tokens.expiry_date && Date.now() >= this.tokens.expiry_date;
    if (isExpired && this.tokens.refresh_token) {
      await this.refreshToken();
    }
    return this.tokens.access_token;
  }

  async refreshToken() {
    if (!this.tokens?.refresh_token) throw new Error('Refresh token이 없습니다.');
    const postData = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.tokens.refresh_token,
      grant_type: 'refresh_token'
    }).toString();

    const res = await this._httpRequest('oauth2.googleapis.com', '/token', 'POST', postData, {
      'Content-Type': 'application/x-www-form-urlencoded'
    });

    return this.saveTokens({
      ...res,
      expiry_date: Date.now() + ((res.expires_in || 3600) * 1000)
    });
  }

  // =========================================================================
  // Google Drive API Methods (Edit Permissions)
  // =========================================================================

  async driveListFiles(options = {}) {
    const token = await this.getAccessToken();
    const query = typeof options.q === 'string' && options.q.trim() ? options.q.trim().slice(0, 1000) : "trashed = false";
    const pageSize = Math.max(1, Math.min(100, Number.parseInt(options.pageSize, 10) || 20));
    if (options.pageToken !== undefined && options.pageToken !== null && typeof options.pageToken !== 'string') {
      throw new TypeError('Google Drive pageToken must be a string');
    }
    const pageToken = typeof options.pageToken === 'string' ? options.pageToken.trim() : '';
    if (pageToken.length > 4096 || /[\u0000-\u001f\u007f]/u.test(pageToken)) {
      throw new TypeError('Google Drive pageToken is invalid');
    }
    const params = new URLSearchParams({
      q: query,
      pageSize: String(pageSize),
      fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink)'
    });
    if (pageToken) params.set('pageToken', pageToken);
    const requestPath = `/drive/v3/files?${params.toString()}`;

    return this._httpRequest('www.googleapis.com', requestPath, 'GET', null, {
      Authorization: `Bearer ${token}`
    });
  }

  async driveGetAccountIdentityHash() {
    const token = await this.getAccessToken();
    const about = await this._httpRequest('www.googleapis.com', '/drive/v3/about?fields=user(permissionId)', 'GET', null, {
      Authorization: `Bearer ${token}`
    });
    if (about?.error) throw new Error(about.error.message || 'Google Drive 계정 정보를 확인하지 못했습니다.');
    const permissionId = typeof about?.user?.permissionId === 'string' ? about.user.permissionId.trim() : '';
    if (!permissionId) throw new Error('Google Drive 계정 식별자를 확인할 수 없습니다.');
    return crypto.createHash('sha256').update(permissionId, 'utf8').digest('hex');
  }

  async driveVerifyMailboxFolder(folderId) {
    const safeId = String(folderId || '').trim();
    if (!safeId || safeId.length > 512 || /[\u0000-\u001f\u007f]/u.test(safeId)) {
      throw new Error('Google Drive 메일박스 폴더 ID가 올바르지 않습니다.');
    }
    const token = await this.getAccessToken();
    const fields = 'id,mimeType,capabilities(canListChildren,canAddChildren)';
    const metadata = await this._httpRequest('www.googleapis.com',
      `/drive/v3/files/${encodeURIComponent(safeId)}?fields=${encodeURIComponent(fields)}`, 'GET', null, {
        Authorization: `Bearer ${token}`
      });
    if (metadata?.error) throw new Error(metadata.error.message || 'Google Drive 메일박스 폴더를 확인하지 못했습니다.');
    if (metadata?.id !== safeId || metadata?.mimeType !== 'application/vnd.google-apps.folder') {
      throw new Error('Google Drive 메일박스 대상은 확인된 폴더여야 합니다.');
    }
    if (metadata.capabilities?.canListChildren !== true || metadata.capabilities?.canAddChildren !== true) {
      throw new Error('Google Drive 메일박스 폴더에 목록 및 파일 추가 권한이 필요합니다.');
    }
    return { folderId: safeId, canListChildren: true, canAddChildren: true };
  }

  async driveReadFile(fileId) {
    const safeId = String(fileId || '').trim();
    if (!safeId || safeId.length > 512) throw new Error('Google Drive fileId가 필요합니다.');
    const token = await this.getAccessToken();
    const encodedId = encodeURIComponent(safeId);
    const metadata = await this._httpRequest('www.googleapis.com', `/drive/v3/files/${encodedId}?fields=id,name,mimeType,size,modifiedTime,webViewLink,capabilities(canDownload)`, 'GET', null, {
      Authorization: `Bearer ${token}`
    });
    if (metadata?.error) throw new Error(metadata.error.message || 'Google Drive 파일 정보를 읽지 못했습니다.');
    if (metadata.capabilities?.canDownload === false) throw new Error('이 Google Drive 파일은 다운로드 또는 내보내기가 허용되지 않습니다.');

    let contentType;
    let contentPath;
    const exportType = WORKSPACE_EXPORTS[metadata.mimeType];
    if (exportType) {
      contentType = exportType;
      contentPath = `/drive/v3/files/${encodedId}/export?mimeType=${encodeURIComponent(exportType)}`;
    } else if (/^text\/(?:plain|csv|tab-separated-values|markdown|html)$/i.test(metadata.mimeType || '')
      || ['application/json', 'application/xml'].includes(metadata.mimeType)) {
      const reportedSize = Number(metadata.size);
      if (Number.isFinite(reportedSize) && reportedSize > MAX_DRIVE_READ_BYTES) {
        throw new Error(`Google Drive 텍스트 파일이 읽기 한도(${MAX_DRIVE_READ_BYTES} bytes)를 넘습니다.`);
      }
      contentType = metadata.mimeType;
      contentPath = `/drive/v3/files/${encodedId}?alt=media`;
    } else {
      throw new Error(`현재 텍스트 읽기를 지원하지 않는 Google Drive 파일 형식입니다: ${metadata.mimeType || 'unknown'}`);
    }

    const content = await this._httpRequestText('www.googleapis.com', contentPath, {
      Authorization: `Bearer ${token}`
    }, MAX_DRIVE_READ_BYTES);
    return { file: metadata, contentType, content };
  }

  async driveCreateFile(name, mimeType = 'text/plain', content = '', parentId = null) {
    const token = await this.getAccessToken();
    const metadata = { name, mimeType };
    if (parentId) metadata.parents = [parentId];

    const boundary = '-------314159265358979323846';
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const multipartBody = Buffer.concat([
      Buffer.from(delimiter + 'Content-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata)),
      Buffer.from(delimiter + `Content-Type: ${mimeType}\r\n\r\n` + content),
      Buffer.from(closeDelimiter)
    ]);

    return this._httpRequest('www.googleapis.com', '/upload/drive/v3/files?uploadType=multipart', 'POST', multipartBody, {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`
    });
  }

  async driveUpdateFile(fileId, content, mimeType = 'text/plain') {
    const token = await this.getAccessToken();
    return this._httpRequest('www.googleapis.com', `/upload/drive/v3/files/${fileId}?uploadType=media`, 'PATCH', content, {
      Authorization: `Bearer ${token}`,
      'Content-Type': mimeType
    });
  }

  // =========================================================================
  // Gmail API Methods (Edit & Send Permissions)
  // =========================================================================

  async gmailListMessages(options = {}) {
    const token = await this.getAccessToken();
    const q = options.q || '';
    const maxResults = options.maxResults || 10;
    const path = `/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${maxResults}`;

    return this._httpRequest('gmail.googleapis.com', path, 'GET', null, {
      Authorization: `Bearer ${token}`
    });
  }

  async gmailReadMessage(messageId) {
    const token = await this.getAccessToken();
    const safeId = String(messageId || '').trim();
    if (!safeId || safeId.length > 512) throw new Error('Gmail messageId가 필요합니다.');
    const path = `/gmail/v1/users/me/messages/${encodeURIComponent(safeId)}?format=full`;

    return this._httpRequest('gmail.googleapis.com', path, 'GET', null, {
      Authorization: `Bearer ${token}`
    });
  }

  async gmailSendMessage(to, subject, bodyText) {
    const token = await this.getAccessToken();
    const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
    const emailLines = [
      `To: ${to}`,
      'Content-Type: text/plain; charset=utf-8',
      'MIME-Version: 1.0',
      `Subject: ${utf8Subject}`,
      '',
      bodyText
    ];
    const raw = Buffer.from(emailLines.join('\r\n')).toString('base64url');

    return this._httpRequest('gmail.googleapis.com', '/gmail/v1/users/me/messages/send', 'POST', JSON.stringify({ raw }), {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    });
  }

  _httpRequest(hostname, path, method, data, headers = {}) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname,
        port: 443,
        path,
        method,
        headers
      };

      const req = https.request(options, res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body || '{}');
            resolve(parsed);
          } catch (_) {
            resolve(body);
          }
        });
      });

      req.on('error', err => reject(err));
      if (data) {
        req.write(data);
      }
      req.end();
    });
  }

  _httpRequestText(hostname, requestPath, headers = {}, maxBytes = MAX_DRIVE_READ_BYTES) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (error) reject(error); else resolve(value);
      };
      const req = https.request({ hostname, port: 443, path: requestPath, method: 'GET', headers }, res => {
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > maxBytes) {
            finish(new Error(`Google Drive 텍스트 응답이 읽기 한도(${maxBytes} bytes)를 넘습니다.`));
            res.destroy();
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', error => finish(error));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            let message = `Google Drive 파일 읽기 실패 (HTTP ${res.statusCode}).`;
            try { message = JSON.parse(text)?.error?.message || message; } catch (_) {}
            finish(new Error(message));
            return;
          }
          finish(null, text);
        });
      });
      req.on('error', error => finish(error));
      req.end();
    });
  }
}

module.exports = { GoogleConnector, DEFAULT_SCOPES };
