/**
 * @project My-Codex
 * @provenance:rogan-core
 * @description Test Suite verifying Metamorphic Hub (핫리로드 _ 신체 변형 시스템) & Collision Shield.
 */
'use strict';

const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { MetamorphicHub } = require('../src/morph/Hub.js');
let testProfile;

async function testMetamorphicHub() {
  console.log('🧪 [Test Suite] 핫리로드 _ 신체 변형 시스템 종합 검증 시작...\n');

  const tmpDir = testProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'only-chat-morph-test-'));
  const hub = new MetamorphicHub({ workspaceDir: tmpDir, dataDir: tmpDir, desktopUiDir: tmpDir, watchEnabled: false });

  // 1. Organ Slots Verification
  console.log('▶ Test 1: 독립 장기 슬롯(UI, Theme, Font, Features) 격리 구조 검증');
  const status = hub.getHubStatus();
  assert.ok(status.slots.theme);
  assert.ok(status.slots.font);
  assert.ok(status.slots.ui);
  assert.ok(status.slots.features);
  assert.strictEqual(status.slots.theme.organ, 'theme');

  // The renderer must consume the Hub's slot contract, not fields it never provides.
  const appSource = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
  const rendererSource = appSource.match(/function renderMorphSlots\(slots\) \{[\s\S]*?\n\}/);
  assert.ok(rendererSource, 'Metamorphic Hub renderer exists');
  const list = { children: [], appendChild(card) { this.children.push(card); }, replaceChildren() { this.children = []; } };
  const document = { createElement(tagName) { return {
    tagName, className: '', style: {}, children: [], textContent: '',
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); }
  }; } };
  const renderMorphSlots = new Function('document', 'morphSlotsList', `${rendererSource[0]}; return renderMorphSlots;`)(document, list);
  renderMorphSlots(status.slots);
  assert.strictEqual(list.children.length, 4, 'all four Hub slots render');
  const textOf = node => `${node.textContent || ''}${(node.children || []).map(textOf).join('')}`;
  assert.ok(list.children.every(card => !textOf(card).includes('undefined')), 'slot cards do not render missing contract fields');
  assert.ok(textOf(list.children[0]).includes('(theme)'), 'the organ kind comes from the Hub contract');
  assert.ok(textOf(list.children[0]).includes('마지막 변경:'), 'the available timestamp is shown instead of a missing author');
  assert.doesNotMatch(rendererSource[0], /innerHTML\s*=/, 'slot values render through text nodes instead of HTML parsing');
  renderMorphSlots({ hostile: { name: '<img src=x onerror=alert(1)>', organ: '<svg>', version: '<script>', lastModified: 'invalid' } });
  assert.equal(list.children[0].children[0].children[0].textContent, '<img src=x onerror=alert(1)> (<svg>)');
  assert.equal(list.children[0].children[0].children[1].textContent, 'v<script>');
  const reloadSafetySource = appSource.match(/function canReloadRendererNow\(\{[\s\S]*?\n\}/);
  assert.ok(reloadSafetySource, 'renderer reload safety gate exists');
  const canReloadRendererNow = new Function(`${reloadSafetySource[0]}; return canReloadRendererNow;`)();
  assert.strictEqual(canReloadRendererNow({}), true, 'an idle empty screen can reload updated renderer code');
  for (const state of [
    { inFlight: true }, { hasDraft: true }, { hasAttachments: true }, { hasConversation: true }
  ]) {
    assert.strictEqual(canReloadRendererNow(state), false, 'renderer reload is deferred while user work is present');
  }
  assert.match(appSource, /window\.location\.reload\(\)/, 'safe UI source changes reload the renderer');
  assert.match(appSource, /if \(organ === 'ui'.*requestSafeUiMorphReload\(\)/s, 'UI source events use the guarded reload path');
  console.log('  ✓ UI, 디자인, 폰트, 기능이 독립된 조립형 슬롯으로 격리 확인 완료');

  // 2. Surgical In-Place Mutation Test (No restart)
  console.log('▶ Test 2: 무중단 외과적 부분 변형(Surgical Mutation) 및 버전 갱신 검증');
  let eventFired = false;
  hub.once('morph_applied', (event) => {
    eventFired = true;
    assert.strictEqual(event.organ, 'theme');
    assert.strictEqual(event.payload.newValue, '#a855f7');
  });

  const mutationResult = hub.mutateOrgan('theme', 'accentCyan', '#a855f7', 'ai-agent');
  assert.strictEqual(mutationResult.ok, true);
  assert.strictEqual(mutationResult.value, '#a855f7');
  assert.strictEqual(eventFired, true);

  const updatedTheme = hub.getOrganData('theme');
  assert.strictEqual(updatedTheme.accentCyan, '#a855f7');
  console.log('  ✓ 앱 재시작 없이 디자인 슬롯만 실시간 핫스왑 성공 (v1 -> v2)');

  // 3. Collision Shield Test (Prevent uncommitted branch drift)
  console.log('▶ Test 3: 단일 진실 원천(Single Source) 잠금 및 버전 일치성 검증');
  assert.strictEqual(hub.slots.theme.version, 2);
  const lock1 = hub.acquireOrganLock('theme', 'worker-a', 200);
  assert.strictEqual(lock1.acquired, true);
  assert.strictEqual(hub.acquireOrganLock('theme', 'worker-b', 200).acquired, false);
  assert.throws(() => hub.mutateOrgan('theme', 'accentCyan', '#000000', 'worker-b', { lockOwner: 'worker-b' }), /currently locked/);
  hub.releaseOrganLock('theme', 'worker-a');
  assert.strictEqual(hub.acquireOrganLock('theme', 'worker-b', 200).acquired, true);
  hub.releaseOrganLock('theme', 'worker-b');
  console.log('  ✓ 모듈별 원자적 변경이 단일 레저에 기록되어 다중 버전 분기 방지 확인');

  // 4. Temp-file ignore + Deferred Busy Queue Test
  console.log('▶ Test 4: 임시 파일(.tmp) 감시 무시 및 활성 턴 지연 큐(deferIfBusy) 검증');
  assert.strictEqual(hub._isIgnoredWatchPath('theme/theme.json.1234.abcd.tmp'), true);
  assert.strictEqual(hub._isIgnoredWatchPath('.git/index.lock'), true);
  assert.strictEqual(hub._isIgnoredWatchPath('theme/theme.json'), false);

  let busy = true;
  const busyHub = new MetamorphicHub({
    workspaceDir: tmpDir,
    dataDir: tmpDir,
    desktopUiDir: tmpDir,
    watchEnabled: false,
    canMutate: () => !busy
  });
  assert.throws(() => busyHub.mutateOrgan('font', 'baseSize', '15px', 'agent'), /blocked while a request/);
  const queued = busyHub.mutateOrgan('font', 'baseSize', '15px', 'agent', { deferIfBusy: true });
  assert.strictEqual(queued.ok, true);
  assert.strictEqual(queued.queued, true);
  assert.strictEqual(busyHub.getHubStatus().pendingMutationsCount, 1);
  busy = false;
  const flushed = busyHub.flushPendingMutations();
  assert.strictEqual(flushed.flushed, 1);
  assert.strictEqual(busyHub.getOrganData('font').baseSize, '15px');

  // Auto-drain timer verification when busy clears asynchronously without manual flush call
  let asyncBusy = true;
  const autoHub = new MetamorphicHub({
    workspaceDir: tmpDir,
    dataDir: tmpDir,
    desktopUiDir: tmpDir,
    watchEnabled: false,
    pendingFlushIntervalMs: 15,
    canMutate: () => !asyncBusy
  });
  const autoQueued = autoHub.mutateOrgan('font', 'baseSize', '16px', 'agent', { deferIfBusy: true });
  assert.strictEqual(autoQueued.queued, true);
  asyncBusy = false;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.strictEqual(autoHub.getHubStatus().pendingMutationsCount, 0);
  assert.strictEqual(autoHub.getOrganData('font').baseSize, '16px');
  autoHub.stopWatchers();

  // Live DesktopServer HTTP /api/morph/mutate queue + turn-end flush verification
  const { DesktopServer } = require('../src/ui/desktop/server.js');
  if (typeof DesktopServer.prototype._decrementActiveTurns === 'function') {
    const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'only-chat-morph-http-'));
    const serverWorkspace = path.join(serverDir, 'workspace');
    fs.mkdirSync(serverWorkspace, { recursive: true });
    const app = new DesktopServer({ port: 0, isolated: true, dataDir: serverDir, workspaceDir: serverWorkspace, enableQuotaRefresh: false });
    try {
      const started = await app.start();
      app.activeTurns = 1;
      const mutateRes = await fetch(`${started.url}/api/morph/mutate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: started.url },
        body: JSON.stringify({ organ: 'theme', key: 'accentCyan', value: '#22c55e', author: 'ui-live-test' })
      });
      assert.strictEqual(mutateRes.status, 202);
      const mutateBody = await mutateRes.json();
      assert.strictEqual(mutateBody.queued, true);
      assert.strictEqual(app.hub.getHubStatus().pendingMutationsCount, 1);

      app._decrementActiveTurns();
      assert.strictEqual(app.activeTurns, 0);
      assert.strictEqual(app.hub.getHubStatus().pendingMutationsCount, 0);
      assert.strictEqual(app.hub.getOrganData('theme').accentCyan, '#22c55e');
    } finally {
      app.stop();
      fs.rmSync(serverDir, { recursive: true, force: true });
    }
  }
  console.log('  ✓ 활성 턴 중 변형 요청 유실 방지, 자동 드레인 타이머, HTTP 202 큐잉 및 턴 종료 즉시 반영 확인');

  console.log('\n🎉 [성공] 핫리로드 _ 신체 변형 시스템 검증 100% 완료!');
  return true;
}

testMetamorphicHub().catch(err => {
  console.error('\n❌ 테스트 실패:', err);
  process.exitCode = 1;
}).finally(() => {
  if (testProfile) fs.rmSync(testProfile, { recursive: true, force: true });
});
