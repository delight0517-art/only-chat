/**
 * @project My-Codex
 * @provenance:rogan-core
 * @description Test Suite verifying Built-in Aside / REA Browser Engine.
 */
'use strict';

const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { AsideBrowser } = require('../src/browser/AsideBrowser.js');
const { ToolRegistry } = require('../src/tools/ToolRegistry.js');

async function testAsideBrowser() {
  console.log('🧪 [Test Suite] 자체 내장 Aside / REA 브라우저 종합 검증 시작...\n');

  // 1. Aside Binary Detection
  console.log('▶ Test 1: Aside 브라우저 바이너리 감지 및 가용성 검증');
  const browser = new AsideBrowser();
  assert.ok(browser.asideBinary.includes('aside'));
  const isAvailable = browser.isAvailable();
  console.log(`  - Aside 바이너리 경로: ${browser.asideBinary} (가용: ${isAvailable ? '예' : '아니오'})`);
  assert.strictEqual(isAvailable, true);
  console.log('  ✓ Aside 브라우저 네이티브 바이너리 감지 성공');

  // 2. Status inspection
  console.log('▶ Test 2: 브라우저 상태 조회 (REA CDP 프로토콜 호환)');
  const status = await browser.getStatus();
  assert.strictEqual(status.available, true);
  assert.strictEqual(typeof status.activeUrl, 'string');
  console.log('  ✓ 브라우저 상태 및 탭 감시 프로토콜 정상 작동 확인');

  // 3. ToolRegistry Browser Dispatcher Verification
  console.log('▶ Test 3: ToolRegistry 내 내장 브라우저 AI 도구 7종 검증');
  const tools = new ToolRegistry();
  assert.ok(typeof tools.browserOpen === 'function');
  assert.ok(typeof tools.browserNavigate === 'function');
  assert.ok(typeof tools.browserAria === 'function');
  assert.ok(typeof tools.browserAct === 'function');
  assert.ok(typeof tools.browserRead === 'function');
  assert.ok(typeof tools.browserRecipe === 'function');
  assert.ok(typeof tools.browserStatus === 'function');
  console.log('  ✓ 에이전트 브라우저 제어 도구 (ARIA 스냅샷, 텍스트 추출, 액션, 레시피) 준비 완료');

  console.log('\n🎉 [성공] 자체 내장 Aside / REA 브라우저 엔진 검증 100% 완료!');
  process.exit(0);
}

testAsideBrowser().catch(err => {
  console.error('\n❌ 테스트 실패:', err);
  process.exit(1);
});
