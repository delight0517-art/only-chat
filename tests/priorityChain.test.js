/**
 * @project My-Codex
 * @provenance:rogan-core
 * @description Comprehensive test suite verifying Priority Chain fallback, Auth, and Tool execution.
 */
'use strict';

const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { PriorityChainEngine } = require('../src/priority/PriorityChainEngine.js');
const { AgentEngine } = require('../src/core/AgentEngine.js');
const { DEFAULT_PRESET_TIERS } = require('../src/priority/PriorityChainEngine.js');
const { AuthManager } = require('../src/auth/AuthManager.js');
const { ToolRegistry, shellInvocation } = require('../src/tools/ToolRegistry.js');
const { parseUsageForTier } = require('../src/providers/AntigravityCliAdapter.js');
const { QUOTA_REFRESH_INTERVAL_MS } = require('../src/ui/desktop/server.js');

async function runTests() {
  console.log('🧪 [Test Suite] My-Codex 종합 검증 시작...\n');

  const testConfigDir = path.join(os.tmpdir(), `my-codex-test-${Date.now()}`);

  // Test 1: Priority Chain Resolution
  console.log('▶ Test 1: 우선순위 체인 1순위 (Antigravity Google) 정상 확인');
  const chain = new PriorityChainEngine({ configDir: testConfigDir, notify: () => {} });
  let active = chain.resolveActiveTier();
  assert.strictEqual(active.id, 'antigravity-flash-med');
  const filteredChain = new PriorityChainEngine({ configDir: path.join(testConfigDir, 'provider-filter'), notify: () => {} });
  assert.strictEqual(filteredChain.resolveActiveTier(null, null, { allowedProviderIds: ['codex-primary'] }).id, 'codex-primary', 'dispatcher resolution can filter tiers without changing normal priority order');
  assert.strictEqual(active.email, 'rogan2534@gmail.com');
  assert.strictEqual(active.tier, 1);
  const initialHealth = chain.getStatus().tiers[0].health;
  assert.strictEqual(initialHealth.totalRemainingPercent, null, 'unread quota must not look like 100% remaining');
  assert.strictEqual(initialHealth.fiveHourRemainingPercent, null, 'five-hour quota must stay unknown until read');
  assert.strictEqual(initialHealth.lastCheckedAt, null, 'an unperformed quota check must not get a timestamp');
  const disconnectedChain = new PriorityChainEngine({
    configDir: path.join(testConfigDir, 'disconnected-provider'),
    isTierReady: () => false,
    notify: () => {}
  });
  assert.strictEqual(disconnectedChain.resolveActiveTier(), null, 'disconnected provider tiers must not be presented as ready');
  assert.strictEqual(disconnectedChain.getStatus().activeTier, null, 'status must not advertise a disconnected provider');
  const customThresholdChain = new PriorityChainEngine({
    configDir: path.join(testConfigDir, 'custom-threshold'),
    thresholdPercent: 15,
    notify: () => {}
  });
  customThresholdChain.updateTierQuota('antigravity-flash-med', 12);
  const customThresholdStatus = customThresholdChain.getStatus();
  assert.strictEqual(customThresholdStatus.thresholds.totalRemainingPercent, 15, 'status must expose the effective resolver threshold');
  assert.strictEqual(customThresholdStatus.activeTier.id, 'codex-secondary', 'fallback must use the same threshold exposed to the UI');
  const exampleResetAt = '2026-10-31T01:37:09Z';
  assert.strictEqual(chain.updateTierQuota('antigravity-flash-med', 72, { fiveHourRemainingPercent: 55, nextResetAt: exampleResetAt }), undefined);
  assert.strictEqual(chain.getStatus().tiers[0].health.totalRemainingPercent, 72);
  assert.strictEqual(chain.getStatus().tiers[0].health.fiveHourRemainingPercent, 55);
  chain.updateTierQuota('antigravity-flash-med', 10, { fiveHourRemainingPercent: 8, nextResetAt: exampleResetAt });
  assert.strictEqual(chain.resolveActiveTier().id, 'codex-secondary', '10% remaining must skip tier 1');
  assert.strictEqual(chain.getStatus().tiers[0].health.nextResetAt, new Date(exampleResetAt).toISOString());
  chain.updateTierQuota('antigravity-flash-med', 72, { fiveHourRemainingPercent: 55 });
  assert.strictEqual(chain.resolveActiveTier().id, 'antigravity-flash-med', 'a fresh above-threshold quota read must re-enable tier 1');
  console.log('  ✓ 1순위 Antigravity (Google: Gemini 3.8 Flash Med) 확인 완료');

  // Test 2: Auto-fallback on rate limit
  console.log('▶ Test 2: 1순위 한도 도달 시 2순위 (Codex Secondary) 자동 폴백 검증');
  chain.reportTierFailure('antigravity-flash-med', new Error('Rate limit 429: quota exceeded'));
  active = chain.resolveActiveTier();
  assert.strictEqual(active.id, 'codex-secondary');
  assert.strictEqual(active.email, 'f123123ff@gmail.com');
  assert.strictEqual(active.tier, 2);
  const exhaustedAntigravity = chain.getStatus().tiers.find(t => t.id === 'antigravity-flash-med').health;
  assert.strictEqual(exhaustedAntigravity.totalRemainingPercent, null, '429 must clear a stale percentage instead of showing 100%');
  assert.strictEqual(exhaustedAntigravity.quotaState, 'limit-detected');
  assert.strictEqual(exhaustedAntigravity.isThrottled, true);
  console.log('  ✓ 2순위 Codex Secondary (f123123ff@gmail.com) 로 무중단 자동 전환 성공');

  // Test 3: Second fallback to Tier 3
  console.log('▶ Test 3: 2순위 한도 도달 시 3순위 (Codex Primary) 최종 방어선 전환 검증');
  chain.reportTierFailure('codex-secondary', new Error('HTTP 429 Quota exhausted'));
  active = chain.resolveActiveTier();
  assert.strictEqual(active.id, 'codex-primary');
  assert.strictEqual(active.email, 'rogan2534@gmail.com');
  assert.strictEqual(active.tier, 3);
  console.log('  ✓ 3순위 Codex Primary (rogan2534@gmail.com) 최종 계정 안전 전환 성공');

  chain.reportTierFailure('codex-primary', new Error('503 RESOURCE_EXHAUSTED: request limit reached'));
  assert.strictEqual(chain.resolveActiveTier(), null, 'all unavailable tiers must not fall back to exhausted tier 1');
  assert.strictEqual(chain.getStatus().activeTier, null, 'status must not claim an exhausted tier is active');

  // Exercise the real AgentEngine retry loop with a local deterministic provider adapter.
  console.log('▶ Test 3b: 실제 turn retry 루프에서 429 후 2순위 호출 확인');
  const engineDataDir = path.join(testConfigDir, 'isolated-turn-engine');
  const providerAttempts = [];
  const resolvedTiers = [];
  const turnEngine = new AgentEngine({
    isolated: true,
    dataDir: engineDataDir,
    workspaceDir: path.join(engineDataDir, 'workspace'),
    notify: () => {},
    providerAdapter: async tier => {
      providerAttempts.push(tier.id);
      if (tier.id === 'antigravity-flash-med') throw new Error('HTTP 429: quota exhausted');
      return { content: 'tier 2 response', toolCalls: [] };
    }
  });
  turnEngine.priorityChain.setTiers(DEFAULT_PRESET_TIERS);
  const turnResult = await turnEngine.executeTurn('synthetic fallback check', {
    reasoningEffort: 'low',
    onTierResolved: tier => resolvedTiers.push(tier.id)
  });
  assert.deepStrictEqual(providerAttempts, ['antigravity-flash-med', 'codex-secondary']);
  assert.deepStrictEqual(resolvedTiers, ['antigravity-flash-med', 'codex-secondary']);
  assert.strictEqual(turnResult.content, 'tier 2 response');
  assert.strictEqual(turnEngine.priorityChain.getStatus().activeTier.id, 'codex-secondary');
  console.log('  ✓ 실제 AgentEngine 재시도 경로가 1순위 429 뒤 2순위로 응답 완료 (로컬 합성 어댑터)');

  // Test 3a: Visible M-Oasis rank controls are enabled and persist through the API engine.
  console.log('▶ Test 3a: M-Oasis 설정의 사용자 순위 이동 및 저장 검증');
  const settingsRenderer = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
  const appearanceMarkup = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/index.html'), 'utf8');
  const themeStyles = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.css'), 'utf8');
  assert.match(settingsRenderer, /data-priority-rank="1"[^>]*>1순위<\/button>/);
  assert.match(settingsRenderer, /data-priority-rank="2"[^>]*>2순위<\/button>/);
  assert.match(settingsRenderer, /data-priority-rank="3"[^>]*>3순위<\/button>/);
  assert.match(settingsRenderer, /card\.querySelectorAll\('\[data-priority-rank\]'\)[\s\S]*button\.disabled = !tierId[\s\S]*setAsRank\(tierId, Number\(button\.dataset\.priorityRank\)\)/);
  assert.match(settingsRenderer, /Number\.isInteger\(rank\).*?rank > 3/s);
  assert.match(settingsRenderer, /providerReady\?\.connected/);
  assert.match(settingsRenderer, /실행 연결됨/);
  assert.match(settingsRenderer, /Codex 로그인 상태 확인 불가/);
  assert.match(settingsRenderer, /priority-account-pair-title/);
  assert.match(settingsRenderer, /같은 모델 · 다른 Codex 계정/);
  assert.match(settingsRenderer, /const explicitRankLabel = tier\.tier === 2 \? '2순위 · Codex 보조 계정' : tier\.tier === 3 \? '3순위 · Codex 주 계정'/);
  assert.match(settingsRenderer, /계정 ID · \$\{escapeHtml\(tier\.account \|\| tier\.id/);
  assert.match(settingsRenderer, /<span>\$\{escapeHtml\(displayPriorityModel\(tier\.model\)\)\} · \$\{escapeHtml\(accountEmail\)\}<\/span>/);
  assert.match(themeStyles, /\.priority-account-card\.tier-2\.codex-account/);
  assert.match(themeStyles, /\.priority-account-card\.tier-3\.codex-account/);
  assert.match(settingsRenderer, /실제 다음 요청에 사용할 경로/);
  assert.match(settingsRenderer, /priority-route-account/);
  assert.match(settingsRenderer, /priority-account-pair-state/);
  assert.match(themeStyles, /\.priority-current-selection > strong \{ font-size: 30px/);
  assert.match(themeStyles, /\.priority-account-pair-row\.tier-3 \{ border-left-color: #a855f7/);
  assert.match(themeStyles, /\.priority-account-pair-row\.tier-3 \.priority-account-pair-rank/);
  assert.match(appearanceMarkup, /id="panelTabAppearance"/);
  assert.match(appearanceMarkup, /id="fantasyWarriorModeToggle"/);
  assert.doesNotMatch(appearanceMarkup.match(/id="fantasyWarriorModeToggle"[^>]*>/)?.[0] || '', /checked/);
  assert.match(settingsRenderer, /localStorage\.getItem\(FANTASY_WARRIOR_MODE_KEY\) === 'true'/);
  assert.match(settingsRenderer, /selectable: tier\?\.enabled !== false && connected && !depleted/);
  assert.match(settingsRenderer, /select\.disabled = !selectable/);
  assert.match(themeStyles, /:root\[data-theme="fantasy"\]/);
  assert.match(settingsRenderer, /priorityAutoToggle/);
  assert.match(settingsRenderer, /function setAutomaticPriority/);

  const manualConfigDir = path.join(testConfigDir, 'manual-priority');
  const accountReady = tier => tier.provider !== 'codex' || tier.id === 'codex-primary';
  const manualChain = new PriorityChainEngine({ configDir: manualConfigDir, notify: () => {}, isTierReady: accountReady });
  manualChain.markTierQuotaExhausted('antigravity-flash-med', 'user-report');
  assert.strictEqual(manualChain.resolveActiveTier().id, 'codex-primary', 'auto mode skips an unconnected secondary account');
  assert.strictEqual(manualChain.setManualTier('codex-secondary'), false, 'manual selection must reject an unconnected account');
  assert.strictEqual(manualChain.setManualTier('codex-primary'), true);
  manualChain.updateTierQuota('antigravity-flash-med', 85);
  assert.strictEqual(manualChain.resolveActiveTier().id, 'codex-primary', 'manual mode must keep the selected account when a higher rank recovers');
  const manualReload = new PriorityChainEngine({ configDir: manualConfigDir, notify: () => {}, isTierReady: accountReady });
  assert.strictEqual(manualReload.getStatus().enabled, false, 'manual mode must persist across restart');
  assert.strictEqual(manualReload.getStatus().activeTier.id, 'codex-primary', 'manual account selection must persist across restart');
  manualReload.reportTierFailure('codex-primary', new Error('network disconnected'));
  assert.strictEqual(manualReload.getStatus().activeTier, null, 'manual mode must not fail over after a provider error');
  manualReload.reportTierSuccess('codex-primary');
  assert.strictEqual(manualReload.setAutomaticPriority(true), true);
  assert.strictEqual(manualReload.getStatus().activeTier.id, 'antigravity-flash-med', 'turning auto mode back on restores ranked routing');

  assert.strictEqual(chain.setTierRank('antigravity-flash-med', 3), true);
  let chainStatus = chain.getStatus();
  assert.deepStrictEqual(chainStatus.tiers.map(t => [t.id, t.tier]), [
    ['codex-secondary', 1], ['codex-primary', 2], ['antigravity-flash-med', 3]
  ]);
  const reloadedChain = new PriorityChainEngine({ configDir: testConfigDir, notify: () => {} });
  assert.deepStrictEqual(reloadedChain.getStatus().tiers.map(t => [t.id, t.tier]), [
    ['codex-secondary', 1], ['codex-primary', 2], ['antigravity-flash-med', 3]
  ]);
  assert.strictEqual(reloadedChain.getStatus().activeTier, null, 'unavailable tier state must survive process restart');
  assert.strictEqual(reloadedChain.getStatus().tiers.find(t => t.id === 'antigravity-flash-med').health.quotaState, 'limit-detected');
  reloadedChain.updateTierQuota('antigravity-flash-med', 85);
  assert.strictEqual(reloadedChain.getStatus().activeTier.id, 'antigravity-flash-med', 'a fresh quota read must restore a tier');

  const reportedConfigDir = path.join(testConfigDir, 'reported-exhaustion');
  const reportedChain = new PriorityChainEngine({ configDir: reportedConfigDir, notify: () => {} });
  assert.strictEqual(reportedChain.markTierQuotaExhausted('antigravity-flash-med', 'user-report').id, 'codex-secondary');
  const reportedReload = new PriorityChainEngine({ configDir: reportedConfigDir, notify: () => {} });
  assert.strictEqual(reportedReload.getStatus().activeTier.id, 'codex-secondary', 'user-reported exhaustion must choose tier 2 after restart');
  assert.strictEqual(reportedReload.getStatus().tiers[0].health.quotaState, 'limit-reported');
  assert.strictEqual(reportedReload.getStatus().tiers[0].health.cooldownUntil, null, 'user-reported exhaustion stays skipped until a fresh quota/success clears it');
  const usageFixture = { command: { data: { groups: [{
    name: 'Gemini Models', buckets: [
      { window: 'weekly', remaining_fraction: 0, reset_time: exampleResetAt },
      { window: '5h', disabled: true, remaining_fraction: 1 }
    ]
  }] } } };
  assert.deepStrictEqual(parseUsageForTier(usageFixture, DEFAULT_PRESET_TIERS[0]), {
    remainingPercent: 0, fiveHourRemainingPercent: undefined, nextResetAt: exampleResetAt
  });
  assert.strictEqual(parseUsageForTier(usageFixture, DEFAULT_PRESET_TIERS[1]), null, 'Antigravity quota must never be assigned to a Codex account');
  assert.strictEqual(QUOTA_REFRESH_INTERVAL_MS, 30 * 60 * 1000, 'provider quota refresh interval must be 30 minutes');
  const desktopServerSource = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/server.js'), 'utf8');
  const desktopUiSource = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
  assert.match(desktopServerSource, /this\._startQuotaRefresh\(\)/);
  assert.match(desktopUiSource, /new EventSource\('\/api\/priority\/stream'\)/, 'quota refresh state must reach the open UI without polling');
  reportedReload.updateTierQuota('antigravity-flash-med', 0, { nextResetAt: exampleResetAt });
  assert.strictEqual(reportedReload.getStatus().activeTier.id, 'codex-secondary', 'a refreshed exhausted quota must remain skipped');
  assert.strictEqual(reportedReload.getStatus().tiers[0].health.nextResetAt, new Date(exampleResetAt).toISOString());
  reportedReload.updateTierQuota('antigravity-flash-med', 38, { fiveHourRemainingPercent: 100 });
  assert.strictEqual(reportedReload.getStatus().activeTier.id, 'antigravity-flash-med', 'a refreshed recovered quota must re-enable tier 1');
  assert.strictEqual(reloadedChain.setTierRank('missing-tier', 1), false);
  console.log('  ✓ 자동/수동 모드, 계정 준비 상태, 우선순위 및 선택값 저장 확인');

  // Test 4: Auth Manager persistence
  console.log('▶ Test 4: AuthManager ChatGPT 및 Google 멀티 계정 검증');
  const testAuthFile = path.join(testConfigDir, 'auth.json');
  const auth = new AuthManager({ authFile: testAuthFile });
  const accounts = auth.listAccounts();
  assert.ok(accounts.length >= 3);
  assert.ok(accounts.some(a => a.email === 'rogan2534@gmail.com' && a.type === 'google-oauth'));
  assert.ok(accounts.some(a => a.email === 'f123123ff@gmail.com' && a.type === 'openai-oauth'));
  console.log('  ✓ 멀티 계정 (Google Antigravity + ChatGPT) 스토리지 검증 성공');

  // Test 5: Tool Execution
  console.log('▶ Test 5: ToolRegistry Bash 실행 및 안전 샌드박스 검증');
  const tools = new ToolRegistry({ workspaceDir: os.tmpdir(), approvalPolicy: 'on-request' });
  const echoRes = await tools.execCommand('echo "Hello My-Codex"');
  assert.strictEqual(echoRes.exitCode, 0);
  assert.ok(echoRes.stdout.includes('Hello My-Codex'));
  assert.deepStrictEqual(shellInvocation('echo ok', 'win32', { ComSpec: 'cmd.exe' }), {
    executable: 'cmd.exe', args: ['/d', '/s', '/c', 'echo ok']
  });
  let patchInput;
  tools.execCommand = async (command, _onChunk, options) => {
    patchInput = { command, input: options.input };
    return { exitCode: 0 };
  };
  await tools.applyPatch('diff --git a/a b/a');
  assert.deepStrictEqual(patchInput, { command: 'git apply -', input: 'diff --git a/a b/a' });
  console.log('  ✓ 로컬 셸 명령어 정상 스트리밍 및 반환 확인');

  // Cleanup test temp files
  try {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
  } catch (_) {}

  console.log('\n🎉 [성공] 이 테스트 파일의 모든 검증 항목이 통과되었습니다.');
}

runTests().catch(err => {
  console.error('\n❌ 테스트 실패:', err);
  process.exit(1);
});
