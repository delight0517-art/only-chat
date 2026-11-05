'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

class NotionCredentialStore {
  constructor(options = {}) {
    this.helperPath = options.helperPath || process.env.ONLY_CHAT_KEYCHAIN_HELPER || null;
    this.invoke = options.invoke || null;
  }

  async _call(action, value) {
    if (this.invoke) return this.invoke(action, value);
    if (!this.helperPath || !path.isAbsolute(this.helperPath)) {
      throw new Error('Notion 로그인 정보를 보호할 macOS 키체인 브리지가 없습니다. Only Chat 앱을 다시 빌드해 주세요.');
    }
    return new Promise((resolve, reject) => {
      const child = spawn(this.helperPath, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      let stdout = '';
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(new Error('macOS 키체인 요청 시간이 초과되었습니다.'));
      }, 10_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.length > 70_000) {
          child.kill('SIGTERM');
          finish(new Error('macOS 키체인 응답 크기가 제한을 넘었습니다.'));
        }
      });
      child.on('error', () => finish(new Error('macOS 키체인 브리지를 실행하지 못했습니다.')));
      child.on('close', code => {
        if (settled) return;
        try {
          const response = JSON.parse(stdout.trim());
          if (code !== 0 || !response.ok) throw new Error(response.error || 'macOS 키체인 요청이 실패했습니다.');
          finish(null, response);
        } catch (error) {
          finish(error instanceof SyntaxError ? new Error('macOS 키체인 응답을 읽지 못했습니다.') : error);
        }
      });
      child.stdin.end(JSON.stringify({ action, ...(value === undefined ? {} : { value }) }));
    });
  }

  async get() {
    const result = await this._call('get');
    return result?.value ?? null;
  }
  async set(value) {
    const result = await this._call('set', value);
    if (result?.verified !== true) {
      throw new Error('Notion 로그인 정보의 저장 결과를 확인하지 못했습니다.');
    }
  }
  async delete() { await this._call('delete'); }
}

module.exports = { NotionCredentialStore };
