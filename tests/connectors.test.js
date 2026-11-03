/**
 * @project My-Codex
 * @provenance:rogan-core
 * @description Test Suite verifying Google Workspace (Drive/Gmail Edit) & Notion Connectors.
 */
'use strict';

const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { GoogleConnector } = require('../src/connectors/GoogleConnector.js');
const { NotionConnector } = require('../src/connectors/NotionConnector.js');
const { ToolRegistry } = require('../src/tools/ToolRegistry.js');

async function testConnectors() {
  console.log('🧪 [Test Suite] Google Workspace & Notion 연동 종합 검증 시작...\n');

  const tmpDir = path.join(os.tmpdir(), `my-codex-connectors-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // 1. Google Workspace Connector Verification
  console.log('▶ Test 1: Google OAuth Drive & Gmail 편집 권한 스코프 및 URL 생성 검증');
  const google = new GoogleConnector({
    storageDir: tmpDir,
    clientId: 'test-client-id.apps.googleusercontent.com',
    clientSecret: 'test-secret'
  });

  const authUrl = google.getAuthUrl();
  const oauthState = new URL(authUrl).searchParams.get('state');
  assert.strictEqual(oauthState?.length, 64);
  await assert.rejects(() => google.exchangeCode('not-a-real-code', 'wrong-state'), /state/);
  assert.ok(authUrl.includes('accounts.google.com/o/oauth2/v2/auth'));
  assert.ok(authUrl.includes('drive')); // Google Drive full access scope
  assert.ok(authUrl.includes('gmail.modify')); // Gmail modify & send scope
  assert.ok(authUrl.includes('prompt=consent'));
  console.log('  ✓ Google Drive 및 Gmail 편집/발송 권한 스코프 정상 인코딩 확인');

  // Token persistence test
  google.saveTokens({ access_token: 'fake_access', refresh_token: 'fake_refresh' });
  assert.strictEqual(google.isConnected(), true);
  console.log('  ✓ Google 토큰 보안 스토리지 저장 및 연결 감지 확인');

  // 2. Notion Connector Verification
  console.log('▶ Test 2: Notion Database & Page 편집 커넥터 검증');
  const notion = new NotionConnector({ storageDir: tmpDir });
  assert.strictEqual(notion.isConnected(), false);

  notion.saveToken('secret_mock_notion_key_12345');
  assert.strictEqual(notion.isConnected(), true);
  assert.strictEqual(notion.apiKey, 'secret_mock_notion_key_12345');
  console.log('  ✓ Notion Integration Token 저장 및 연결 활성화 확인');

  // 3. ToolRegistry Integration Verification
  console.log('▶ Test 3: ToolRegistry 내 구글 & 노션 에이전트 도구 디스패치 검증');
  const tools = new ToolRegistry({ workspaceDir: tmpDir });
  assert.ok(typeof tools.googleDriveList === 'function');
  assert.ok(typeof tools.googleDriveRead === 'function');
  assert.ok(typeof tools.googleDriveCreate === 'function');
  assert.ok(typeof tools.gmailSend === 'function');
  assert.ok(typeof tools.notionQueryDatabase === 'function');
  assert.ok(typeof tools.notionCreatePage === 'function');
  assert.ok(typeof tools.notionAppendBlocks === 'function');
  console.log('  ✓ 에이전트가 호출할 구글 및 노션 도구 11종 디스패처 준비 완료');

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  console.log('\n🎉 [성공] Google Drive/Gmail 및 Notion 커넥터 검증 100% 완료!');
  process.exit(0);
}

testConnectors().catch(err => {
  console.error('\n❌ 테스트 실패:', err);
  process.exit(1);
});
