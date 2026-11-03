'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src/ui/desktop/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/ui/desktop/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/ui/desktop/app.css'), 'utf8');
assert.match(html, /<summary>모델 변경 예약<\/summary>/);
assert.match(html, /id="modelSwitchDelay"/);
assert.match(html, /id="modelSwitchTarget"/);
assert.match(html, /id="modelSwitchEffort"/);
assert.match(app, /\/api\/model-switch-schedule\?sessionId=/);
assert.match(app, /\/api\/model-switch-schedule/);
assert.match(app, /model_switch_schedule_applied/);
assert.match(app, /이후 요청에도 목표 설정 사용/);
assert.match(css, /\.model-switch-schedule/);
console.log('modelSwitchScheduleUi passed: compact schedule disclosure, dynamic target, status, and applied settings');
