'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src/ui/desktop/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/ui/desktop/app.js'), 'utf8');

assert.ok(html.includes('id="btnRestartOnlyChatServer"'), 'General settings exposes the restart action');
assert.ok(/id="serverRestartStatus"[^>]*role="status"[^>]*aria-live="polite"/.test(html), 'restart progress is accessible');
assert.ok(html.includes('진행 중인 요청은 체크포인트에 저장하고, 재시작 후 안전한 경우 한 번 자동으로 이어갑니다'), 'the UI explains restart recovery');
assert.ok(/getElementById\('btnRestartOnlyChatServer'\)\?\.addEventListener\('click'/.test(app), 'the button has a click handler');
assert.ok(/fetch\('\/api\/server\/restart'/.test(app), 'the click uses the same-origin restart endpoint');
assert.ok(/response\.status !== 202 \|\| !result\.ok/.test(app), 'the UI requires accepted restart status');
assert.ok(app.includes('재시작 요청 실패'), 'failure is reported and the button can be retried');

console.log('serverRestartUi passed');
