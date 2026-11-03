'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_SCRIPT = path.join(os.homedir(), 'Documents/Codex/2026-10-20/new-chat-3/space-steward/steward.py');
const DEFAULT_STORAGE_GUARD = '/Users/rogan/bin/storage-guard';
const TASK_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

class SpaceKeeperConnector {
  constructor(options = {}) {
    this.script = options.script || DEFAULT_SCRIPT;
    this.storageGuard = options.storageGuard || DEFAULT_STORAGE_GUARD;
    this.python = options.python || '/usr/bin/python3';
    this.execFile = options.execFile || execFile;
  }

  async capacityStatus() {
    if (process.platform === 'win32') throw new Error('Mac 저장공간 가드는 이 기기에서 사용할 수 없습니다.');
    return new Promise((resolve, reject) => {
      this.execFile(this.storageGuard, ['check'],
        { timeout: 15000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout, stderr) => {
          if (error) return reject(new Error(`Space Keeper 용량 상태를 읽을 수 없습니다: ${(stderr || error.message).slice(0, 300)}`));
          try {
            const status = JSON.parse(stdout);
            if (typeof status.freeGiB !== 'number' || typeof status.severity !== 'string' || !Array.isArray(status.issues)) {
              return reject(new Error('Space Keeper가 유효하지 않은 용량 상태를 반환했습니다.'));
            }
            resolve(status);
          } catch (_) {
            reject(new Error('Space Keeper 용량 상태가 올바른 JSON이 아닙니다.'));
          }
        });
    });
  }

  async sessionReport(taskKey) {
    if (typeof taskKey !== 'string' || !TASK_KEY.test(taskKey)) {
      throw new Error('A valid Space Keeper task key is required.');
    }
    return new Promise((resolve, reject) => {
      this.execFile(this.python, [this.script, 'session-report', '--name', taskKey],
        { timeout: 15000, maxBuffer: 256 * 1024, windowsHide: true,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }, (error, stdout, stderr) => {
          if (error) return reject(new Error(`Space Keeper report unavailable: ${(stderr || error.message).slice(0, 300)}`));
          try {
            const report = JSON.parse(stdout);
            if (report.schemaVersion !== 1 || report.taskKey !== taskKey || typeof report.status !== 'string') {
              return reject(new Error('Space Keeper returned an invalid report.'));
            }
            resolve(report);
          } catch (_) {
            reject(new Error('Space Keeper returned invalid JSON.'));
          }
        });
    });
  }
}

module.exports = { SpaceKeeperConnector, DEFAULT_SCRIPT };
