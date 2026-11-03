'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/index.html'), 'utf8');

assert.match(app, /modelSelection:\s*selectedModelId/, 'composer requests must carry the visible model choice');
assert.match(app, /function syncAvailableModelOptions\(\)/, 'model choices must come from configured priority tiers');
assert.match(app, /autoOption\?\.classList\.toggle\('selected', selectedModelId === 'auto'\)/, 'the automatic choice keeps its visual and aria selection state in sync');
assert.match(app, /function resolveSelectedModelTier\(\)/, 'the displayed account route must match the selected model');
assert.match(app, /function priorityRouteHealth\(tier\)/, 'provider health is rendered separately from CLI readiness');
const healthHelperStart = app.indexOf('function priorityRouteHealth(tier) {');
const healthHelperEnd = app.indexOf('\nfunction renderActiveModelSelection()', healthHelperStart);
assert.ok(healthHelperStart >= 0 && healthHelperEnd > healthHelperStart, 'provider health helper remains independently checkable');
const healthContext = {};
vm.runInNewContext(`${app.slice(healthHelperStart, healthHelperEnd)}\nglobalThis.resolve = priorityRouteHealth;`, healthContext);
assert.deepEqual(JSON.parse(JSON.stringify(healthContext.resolve({ providerReady: { connected: true }, health: { quotaState: 'provider-unavailable', throttledReason: 'provider-error' } }))), { label: '최근 생성 실패', className: 'disconnected' }, 'a connected CLI with a failed provider request must show the failure');
assert.deepEqual(JSON.parse(JSON.stringify(healthContext.resolve({ providerReady: { connected: true }, health: { quotaState: 'available' } }))), { label: '실행 경로 연결됨', className: 'connected' }, 'healthy provider status retains its connected label');
const connectionLabelStart = app.indexOf('function tierConnectionLabel(tier) {');
const connectionLabelEnd = app.indexOf('\nfunction tierQuotaCheckedLabel(', connectionLabelStart);
assert.ok(connectionLabelStart >= 0 && connectionLabelEnd > connectionLabelStart, 'account drawer connection label helper remains independently checkable');
const labelContext = { priorityRouteHealth: healthContext.resolve };
vm.runInNewContext(`${app.slice(connectionLabelStart, connectionLabelEnd)}\nglobalThis.resolve = tierConnectionLabel;`, labelContext);
assert.equal(labelContext.resolve({ provider: 'antigravity-cli', providerReady: { connected: true }, health: { quotaState: 'provider-unavailable', throttledReason: 'provider-error' } }), '최근 생성 실패', 'account drawer must expose a recent provider error even when CLI readiness is connected');
assert.equal(labelContext.resolve({ provider: 'antigravity-cli', providerReady: { connected: true }, health: { quotaState: 'unknown' } }), '실행 경로 연결됨', 'healthy connected provider retains its connection status');
assert.match(app, /const routeState = isCodex \? \(routeReady \? '연결됨' : routeTier\.providerReady\?\.message \|\| '로그인 필요'\) : routeHealth\.label;/, 'non-Codex route shows provider health instead of a hard-coded connected label');
assert.match(app, /const connection = isCodex \? \(routeReady \? '실행 연결됨' : '로그인 필요'\) : routeHealth\.label;/, 'selected route badge matches the same provider health state');
assert.match(app, /priorityRouteHealth\(tier\)\.className === 'disconnected'[\s\S]*?priorityRouteHealth\(tier\)\.label/, 'priority settings account cards use the same failure-aware provider state');
assert.match(app, /const selectedRouteTier = resolveSelectedModelTier\(\)/, 'priority cards must use the same selected-model route');
assert.match(app, /resolveModelTierFromStatus\(data, selectedModelId\)/, 'provider status and settings route must use the selected model');
assert.match(app, /const requestId = beginPriorityStatusRefresh\(\);[\s\S]*?if \(!isPriorityStatusRefreshCurrent\(requestId\)\) return;/, 'late priority API responses cannot overwrite newer state');
assert.match(app, /const res = await fetch\('\/api\/status'\);\s*if \(!res\.ok\)[\s\S]*?const data = await res\.json\(\);\s*if \(!data \|\| !Array\.isArray\(data\.tiers\)\)/, 'HTTP and malformed priority responses cannot replace the last valid state');
assert.match(app, /setPriorityStatusSnapshot\(message\.status\)/, 'live stream status invalidates pending API snapshots');
const requestHelperStart = app.indexOf('function beginPriorityStatusRefresh() {');
const requestHelperEnd = app.indexOf('\nfunction initWindowsInboxLiveStream()', requestHelperStart);
assert.ok(requestHelperStart >= 0 && requestHelperEnd > requestHelperStart, 'priority status freshness helpers remain independently checkable');
const freshness = {};
vm.runInNewContext(`let priorityStatusRequestId = 0; let priorityStatus = null; let activeTier = null;\n${app.slice(requestHelperStart, requestHelperEnd)}\nglobalThis.begin = beginPriorityStatusRefresh; globalThis.current = isPriorityStatusRefreshCurrent; globalThis.setSnapshot = setPriorityStatusSnapshot; globalThis.getStatus = () => priorityStatus; globalThis.getActiveTier = () => activeTier;`, freshness);
const olderStatusRequest = freshness.begin();
const latestStatusRequest = freshness.begin();
assert.equal(freshness.current(olderStatusRequest), false);
assert.equal(freshness.current(latestStatusRequest), true);
const liveStatus = { activeTier: { id: 'live' } };
liveStatus.tiers = [];
assert.equal(freshness.setSnapshot({ activeTier: { id: 'invalid' } }), false, 'malformed SSE/mutation snapshots are rejected');
assert.equal(freshness.current(latestStatusRequest), true, 'malformed snapshots do not invalidate a valid pending response');
assert.equal(freshness.setSnapshot(liveStatus), true);
assert.equal(freshness.current(latestStatusRequest), false, 'newer live state invalidates any in-flight HTTP response');
assert.equal(freshness.getStatus(), liveStatus);
assert.equal(freshness.getActiveTier().id, 'live');
assert.match(app, /modelSelectorPopup\.addEventListener\('click'/, 'dynamically created model buttons must remain selectable');
assert.match(app, /modelSelectorPopup\.addEventListener\('keydown'/, 'the model list supports keyboard navigation and Escape');
assert.match(app, /modelPillTrigger\.focus\(\)/, 'closing the model list returns focus to its trigger');
assert.match(app, /container\.dataset\.modelSignature/, 'unchanged provider updates preserve model option nodes and focus');
assert.match(html, /id="availableModelOptions"/, 'model choices are rendered from live configuration');
assert.match(html, /id="automaticModelOptionTitle"/, 'automatic/manual routing mode has an accurate selector label');
assert.doesNotMatch(html, /data-model="gpt-6\.1-sol"/, 'unsupported hard-coded models must not be offered');

const helperStart = app.indexOf('function resolveModelTierFromStatus(status, modelSelection) {');
const helperEnd = app.indexOf('\nfunction tierQuotaLabel(', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'selected model route helper remains independently checkable');
const context = {};
vm.runInNewContext(`${app.slice(helperStart, helperEnd)}\nglobalThis.resolve = resolveModelTierFromStatus; globalThis.fantasyAvailability = fantasyWarriorTierAvailability;`, context);
const first = { id: 'first', tier: 1, model: 'alpha-model' };
const second = { id: 'second', tier: 2, model: 'beta-model' };
const third = { id: 'third', tier: 3, model: 'beta-model' };
const status = {
  enabled: true,
  activeTier: first,
  thresholds: { totalRemainingPercent: 10 },
  tiers: [first, second, third].map(tier => ({
    ...tier,
    enabled: true,
    providerReady: { connected: true },
    health: { isThrottled: false, totalRemainingPercent: null }
  }))
};
assert.equal(context.resolve(status, 'auto'), first);
assert.equal(context.resolve(status, 'beta-model').id, 'second');
const fantasyStatus = { thresholds: { totalRemainingPercent: 15 } };
assert.equal(context.fantasyAvailability(fantasyStatus, { enabled: true, providerReady: { connected: true }, health: { totalRemainingPercent: 12 } }).selectable, false, 'fantasy UI must honor the configured routing threshold');
assert.equal(context.fantasyAvailability(fantasyStatus, { enabled: true, providerReady: { connected: true }, health: { totalRemainingPercent: 15 } }).selectable, false, 'quota at the configured threshold is not selectable');
assert.equal(context.fantasyAvailability(fantasyStatus, { enabled: true, providerReady: { connected: true }, health: { totalRemainingPercent: 16 } }).selectable, true, 'quota above the configured threshold is selectable');
assert.equal(context.fantasyAvailability(fantasyStatus, { enabled: true, providerReady: { connected: true }, health: { totalRemainingPercent: null } }).hasKnownQuota, false, 'null quota remains unknown instead of being coerced to zero');
const connectionUnknownTier = { ...status.tiers[1], providerReady: undefined };
assert.equal(context.resolve({ ...status, tiers: [connectionUnknownTier] }, 'beta-model'), null, 'manual routing does not select an account with unknown connection state');
assert.equal(context.fantasyAvailability(fantasyStatus, connectionUnknownTier).selectable, false, 'fantasy account selection fails closed when connection state is missing');
status.tiers[1].health.isThrottled = true;
assert.equal(context.resolve(status, 'beta-model').id, 'third');
status.enabled = false;
status.activeTier = status.tiers[2];
assert.equal(context.resolve(status, 'beta-model').id, 'third');
assert.equal(context.resolve(status, 'alpha-model'), null);
console.log('modelSelectionUi passed');
