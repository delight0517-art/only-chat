'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/index.html'), 'utf8');
assert.match(html, /id="settingApprovalPolicy"[\s\S]*?Codex 요청마다 작업공간 쓰기 승인/);
assert.match(html, /id="settingsApprovalSelect"[\s\S]*?Codex 요청마다 작업공간 쓰기 승인/);
assert.equal((html.match(/앱 도구는 호출별로 승인합니다\. On Request에서 Codex는 요청마다 작업공간 쓰기 범위를 먼저 승인받고, Read Only에서는 화면·전원 변경 도구도 사용할 수 없습니다\./g) || []).length, 2);
console.log('approvalPolicySettingsCopy passed: both settings surfaces explain actual Codex and read-only behavior');
