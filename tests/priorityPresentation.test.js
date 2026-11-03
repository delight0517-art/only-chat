'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const ui = fs.readFileSync(require.resolve('../src/ui/desktop/app.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../src/ui/desktop/index.html'), 'utf8');
const css = fs.readFileSync(require.resolve('../src/ui/desktop/app.css'), 'utf8');

assert.match(ui, /modelSelection:\s*selectedModelId/);
assert.match(ui, /resolveSelectedModelTier\(\)/);
assert.match(ui, /activeModelLabel\.textContent = selectedModel/);
assert.match(ui, /실제 요청 계정:/);
assert.match(ui, /2순위 · Codex 보조 계정/);
assert.match(ui, /3순위 · Codex 주 계정/);
assert.match(ui, /aria-label.*현재 선택\/라우팅|setAttribute\('aria-label', `\$\{explicitRankLabel\}/s);
assert.match(ui, /로그인 이메일/);
assert.match(ui, /계정 ID/);
assert.match(ui, /현재 선택 · 자동 라우팅/);
assert.match(ui, /폴백 계정/);
assert.match(ui, /실제 다음 요청에 사용할 경로/);
assert.match(ui, /이 순위의 Codex 로그인 계정/);
assert.match(ui, /priority-route-model/);
assert.match(ui, /priority-route-account/);
assert.match(ui, /이번 요청 계정/);
assert.match(ui, /GPT-6 Luna \+ Light/);
assert.match(ui, /\$\{routingMode\} · \$\{displayPriorityModel\(routeTier\.model\)\}/);
assert.match(ui, /rank-tier-\$\{rankNum\}/);
assert.doesNotMatch(ui, /if \(selectedModelId === 'auto'\)\s*\{\s*selectedModelId = 'gpt-6-luna'/);
const stagePriorityStart = ui.indexOf('async function loadStagePriorityTiers() {');
const stagePriorityEnd = ui.indexOf('\n// Ensure loadStagePriorityTiers', stagePriorityStart);
assert.ok(stagePriorityStart >= 0 && stagePriorityEnd > stagePriorityStart);
const stagePriority = ui.slice(stagePriorityStart, stagePriorityEnd);
assert.match(ui, /let stagePriorityLoadRequestId = 0;/);
assert.match(stagePriority, /const requestId = \+\+stagePriorityLoadRequestId/);
assert.match(stagePriority, /if \(requestId !== stagePriorityLoadRequestId\) return/, 'stale settings responses and errors cannot overwrite a newer tier list');
assert.doesNotMatch(stagePriority, /onclick=/, 'account IDs are not interpolated into inline JavaScript handlers');
assert.match(stagePriority, /button\.addEventListener\('click', \(\) => \{ if \(tierId\) void setAsRank/);
assert.match(stagePriority, /switchButton\.addEventListener\('click', \(\) => \{ if \(tierId\) void switchTier/);
assert.match(stagePriority, /error\.textContent = `우선순위 체인 로드 오류:/, 'server error details are rendered as text');
assert.match(stagePriority, /error\.setAttribute\('role', 'status'\)/);
assert.match(stagePriority, /error\.setAttribute\('aria-live', 'polite'\)/);
assert.ok(stagePriority.indexOf('!Array.isArray(data?.tiers)') < stagePriority.indexOf('container.innerHTML = tiers.map'), 'status payload is validated before replacing the last valid list');
const bindStart = stagePriority.indexOf("[...container.querySelectorAll('.priority-rank-card')]");
const bindEnd = stagePriority.indexOf('\n  } catch', bindStart);
assert.ok(bindStart >= 0 && bindEnd > bindStart, 'safe priority action binding remains independently testable');
const actions = [];
const makeButton = rank => ({ disabled: false, dataset: { priorityRank: String(rank) }, listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; } });
const rankButtons = [makeButton(1), makeButton(2), makeButton(3)];
const switchButton = makeButton(0);
const card = { querySelectorAll: () => rankButtons, querySelector: () => switchButton };
const container = { querySelectorAll: () => [card] };
new Function('container', 'tiers', 'setAsRank', 'switchTier', stagePriority.slice(bindStart, bindEnd))(
  container, [{ id: "tier'\"><svg onload=alert(1)>" }], (...args) => actions.push(['rank', ...args]), id => actions.push(['switch', id])
);
rankButtons[1].listeners.click();
switchButton.listeners.click();
assert.deepEqual(actions, [['rank', "tier'\"><svg onload=alert(1)>", 2], ['switch', "tier'\"><svg onload=alert(1)>"]], 'untrusted tier IDs are passed as values through listeners');
const invalidCard = { querySelectorAll: () => rankButtons, querySelector: () => switchButton };
new Function('container', 'tiers', 'setAsRank', 'switchTier', stagePriority.slice(bindStart, bindEnd))(
  { querySelectorAll: () => [invalidCard] }, [{ id: { hostile: true } }], () => assert.fail('invalid ID must not activate'), () => assert.fail('invalid ID must not switch')
);
assert.ok(rankButtons.every(button => button.disabled), 'non-string tier IDs disable rank controls');
assert.match(html, /자동 우선순위 모델/);
assert.match(html, /id="activeModelLabel">GPT-6 Luna \+ Light<\/span>/);
assert.match(html, /aria-label="현재 선택 모델 GPT-6 Luna \+ Light"/);
assert.match(html, /id="effortPopupModel">GPT-6 Luna \+ Light<\/span>/);
assert.match(css, /\.priority-rank-card\.rank-tier-2/);
assert.match(css, /\.priority-rank-card\.rank-tier-3/);
assert.match(css, /\.priority-rank-card\.rank-tier-2 \{ border-left: 6px solid #0284c7/);
assert.match(css, /\.priority-rank-card\.rank-tier-3 \{ border-left: 6px double #9333ea/);
assert.match(css, /\.priority-account-identity/);
assert.match(css, /priority-account-card\.tier-2 \.priority-account-provider::after\s*\{ content: '보조 계정'/);
assert.match(css, /priority-account-card\.tier-3 \.priority-account-provider::after\s*\{ content: '주 계정'/);
assert.match(css, /priority-account-model > strong \{ font-size: 24px/);
assert.match(css, /priority-account-card\.tier-2\.codex-account\.active[^\{]*\{[^}]*border-left: 8px solid/s);
assert.match(css, /priority-account-card\.tier-3\.codex-account\.active[^\{]*\{[^}]*border-left: 8px double/s);
assert.match(css, /\.priority-account-active\.fallback/);
assert.match(css, /\.priority-rank-model span[^\{]*\{[^}]*font-size: 18px/s);
assert.match(css, /\.priority-route-model\s*\{[^}]*font-size: 20px/s);
assert.match(css, /\.priority-rank-card\.rank-tier-2:not\(\.active-tier\)[^\{]*\{[^}]*#0ea5e9/s);
assert.match(css, /\.priority-rank-card\.rank-tier-3:not\(\.active-tier\)[^\{]*\{[^}]*#a855f7/s);

console.log('priorityPresentation passed: selected model, request account, rank and auto selection are visibly distinct');
