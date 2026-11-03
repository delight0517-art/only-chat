/**
 * @project My-Codex
 * @provenance:rogan-core
 * @license MIT
 * @description Passkey & Credential Vault Unit Tests
 */
'use strict';

const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { PasskeyVault } = require('../src/auth/PasskeyVault.js');
const rendererSource = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/server.js'), 'utf8');
const vaultListSource = rendererSource.slice(rendererSource.indexOf('async function refreshVaultList() {'), rendererSource.indexOf('\nasync function handleVaultSave()', rendererSource.indexOf('async function refreshVaultList() {')));
const stageVaultStart = rendererSource.indexOf('async function refreshStageVault() {');
const stageVaultSource = rendererSource.slice(stageVaultStart, rendererSource.indexOf('\nasync function handleStageVaultSave()', stageVaultStart));
assert.doesNotMatch(vaultListSource, /innerHTML\s*=|onclick=/, 'compact vault rows use text nodes and event listeners');
assert.doesNotMatch(stageVaultSource, /innerHTML\s*=|onclick=|deleteVaultItem/, 'settings vault rows use safe text nodes and the working delete handler');
assert.match(vaultListSource, /if \(!res\.ok\) throw new Error/);
assert.match(vaultListSource, /if \(!Array\.isArray\(items\)\) throw new Error/);
assert.ok(vaultListSource.indexOf('if (!Array.isArray(items))') < vaultListSource.indexOf('container.replaceChildren()'), 'compact vault preserves last good rows for invalid responses');
assert.match(stageVaultSource, /if \(!res\.ok\) throw new Error/);
assert.match(stageVaultSource, /!Array\.isArray\(data\)/);
assert.match(stageVaultSource, /for \(const credential of data\)/);
assert.match(stageVaultSource, /remove\.setAttribute\('aria-label', `\$\{credential\.service \|\| '자격증명'\} 삭제`\)/);
assert.ok(stageVaultSource.indexOf('!Array.isArray(data)') < stageVaultSource.indexOf('stageList.replaceChildren()'), 'settings vault preserves last good rows for invalid responses');
const vaultListRouteStart = serverSource.indexOf("if (pathname === '/api/vault/list'");
const vaultListRouteEnd = serverSource.indexOf("if (pathname === '/api/vault/save'", vaultListRouteStart);
assert.match(serverSource.slice(vaultListRouteStart, vaultListRouteEnd), /JSON\.stringify\(list\)/, 'vault list API returns the credential array directly');
const compactSaveStart = rendererSource.indexOf('async function handleVaultSave() {');
const compactSave = rendererSource.slice(compactSaveStart, rendererSource.indexOf('\nwindow.handleVaultDelete', compactSaveStart));
assert.match(compactSave, /fetch\('\/api\/vault\/save'/);
assert.match(compactSave, /allowAiUse/);
assert.match(compactSave, /!res\.ok \|\| !result\.ok/);
assert.match(compactSave, /catch \(err\)[\s\S]*alert\('보관함 오류: ' \+ err\.message\)/);
assert.match(vaultListSource, /data-vault-refresh-error/);
assert.match(stageVaultSource, /data-vault-refresh-error/);
assert.match(vaultListSource, /error\.setAttribute\('role', 'status'\)/);
assert.match(stageVaultSource, /errorMessage\.setAttribute\('role', 'status'\)/);
assert.match(vaultListSource, /error\.setAttribute\('aria-live', 'polite'\)/);
assert.match(stageVaultSource, /errorMessage\.setAttribute\('aria-live', 'polite'\)/);
assert.match(vaultListSource, /window\.handleVaultDelete\(item\.id\)/);
assert.match(stageVaultSource, /window\.handleVaultDelete\(credential\.id\)/);
assert.match(stageVaultSource, /credential\.allowAiUse \? 'AI 승인됨' : 'AI 차단됨'/);
assert.match(stageVaultSource, /permission\.style\.cssText = credential\.allowAiUse\s*\?/);
assert.match(stageVaultSource, /color:var\(--vault-allow-text\);background:var\(--vault-allow-bg\)/);
assert.match(stageVaultSource, /color:var\(--vault-block-text\);background:var\(--vault-block-bg\)/);
assert.match(rendererSource, /await Promise\.all\(\[refreshVaultList\(\), refreshStageVault\(\)\]\)/, 'deleting from either vault view refreshes both lists');
const stageSaveStart = rendererSource.indexOf('async function handleStageVaultSave() {');
const stageSave = rendererSource.slice(stageSaveStart, rendererSource.indexOf('\n// ===', stageSaveStart));
assert.match(serverSource, /pathname === '\/api\/vault\/save'/);
assert.doesNotMatch(serverSource, /pathname === '\/api\/vault\/store'/);
assert.match(stageSave, /fetch\('\/api\/vault\/save'/);
assert.match(stageSave, /allowAiUse: allowAi/);
assert.match(stageSave, /!res\.ok \|\| !d\.ok/);
assert.match(stageSave, /Promise\.all\(\[refreshVaultList\(\), refreshStageVault\(\)\]\)/);
const deleteHandlerStart = rendererSource.indexOf('window.handleVaultDelete = async function(id) {');
const deleteHandler = rendererSource.slice(deleteHandlerStart, rendererSource.indexOf('\n};', deleteHandlerStart));
assert.match(deleteHandler, /if \(!response\.ok\) throw new Error/);
assert.match(deleteHandler, /if \(!result\.ok\) throw new Error/);
assert.match(deleteHandler, /window\.alert\(`패스키를 삭제하지 못했습니다:/);

async function runTests() {
  console.log('\n🧪 [Test Suite] Passkey & Credential Vault 종합 검증 시작...\n');

  const tmpDir = path.join(os.tmpdir(), `my-codex-vault-test-${Date.now()}`);
  try {
    const vault = new PasskeyVault({ vaultDir: tmpDir });
    // Test 1: 패스키 저장 및 마스킹된 메타데이터 반환 검증
    console.log('▶ Test 1: 패스키 암호화 저장 및 안전 메타데이터 검증');
    const saved = vault.saveCredential('Google', {
      username: 'rogan2534@gmail.com',
      secret: 'super-secure-passkey-12345',
      allowAiUse: true
    });
    assert.ok(saved.id, 'Credential ID should exist');
    assert.strictEqual(saved.service, 'Google');
    assert.strictEqual(saved.allowAiUse, true);
    console.log('  ✓ 자격증명 파일 영속화 및 안전 메타데이터 반환 확인');

    // Test 2: AI 접근 권한 승인/차단(allowAiUse) 보안 게이트 검증
    console.log('▶ Test 2: AI 접근 권한 승인/차단(allowAiUse) 보안 게이트 검증');
    const aiCred = vault.requestAccessForAi('Google');
    assert.strictEqual(aiCred.secret, 'super-secure-passkey-12345', 'Authorized AI should get secret');
    console.log('  ✓ AI 접근 권한 승인(allowAiUse: true) 시 정상 복호화 확인');

    // Save non-allowed credential
    vault.saveCredential('Bank', {
      username: 'rogan_bank',
      secret: 'bank-secret-999',
      allowAiUse: false
    });
    
    assert.throws(() => {
      vault.requestAccessForAi('Bank');
    }, /권한이 비활성화/, 'Disallowed credential must throw permission error');
    console.log('  ✓ AI 접근 권한 차단 플래그(allowAiUse: false) 완전 차단 확인');

    // Test 3: 자격증명 목록 마스킹 및 안전 삭제 검증
    console.log('▶ Test 3: 자격증명 메타데이터 목록 마스킹 및 안전 삭제 검증');
    const list = vault.listCredentials();
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].secret, undefined, 'Secret should be stripped in listing');

    const deleted = vault.deleteCredential('bank');
    assert.strictEqual(deleted, true);
    assert.strictEqual(vault.listCredentials().length, 1);
    console.log('  ✓ 비밀번호 마스킹 및 삭제 정상 완료');

    console.log('\n🎉 [성공] Passkey & Credential Vault 검증 100% 완료!\n');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exitCode = 1;
});
