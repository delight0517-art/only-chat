'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { GoogleConnector } = require('../src/connectors/GoogleConnector.js');

function makeConnector(t, request) {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-drive-access-'));
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));
  const connector = new GoogleConnector({ storageDir, clientConfigFile: false });
  connector.saveTokens({ access_token: 'test-access-token' });
  connector._httpRequest = request;
  return connector;
}

test('Drive account identity returns a hash without exposing permission ID or email', async t => {
  let requestPath;
  const connector = makeConnector(t, async (_host, path) => {
    requestPath = path;
    return { user: { permissionId: 'opaque-drive-user-id', emailAddress: 'private@example.test' } };
  });

  const identityHash = await connector.driveGetAccountIdentityHash();
  assert.equal(requestPath, '/drive/v3/about?fields=user(permissionId)');
  assert.equal(identityHash, crypto.createHash('sha256').update('opaque-drive-user-id').digest('hex'));
  assert.equal(identityHash.includes('opaque-drive-user-id'), false);
  assert.equal(identityHash.includes('private@example.test'), false);
});

test('mailbox folder verification requires the exact writable Drive folder', async t => {
  let requestPath;
  const connector = makeConnector(t, async (_host, path) => {
    requestPath = path;
    return {
      id: 'mailbox-folder-id',
      mimeType: 'application/vnd.google-apps.folder',
      capabilities: { canListChildren: true, canAddChildren: true }
    };
  });

  assert.deepEqual(await connector.driveVerifyMailboxFolder('mailbox-folder-id'), {
    folderId: 'mailbox-folder-id', canListChildren: true, canAddChildren: true
  });
  const fields = new URL(`https://www.googleapis.com${requestPath}`).searchParams.get('fields');
  assert.equal(fields, 'id,mimeType,capabilities(canListChildren,canAddChildren)');
});

test('mailbox folder verification fails closed for non-folders and insufficient access', async t => {
  let response = { id: 'mailbox-folder-id', mimeType: 'text/plain', capabilities: { canListChildren: true, canAddChildren: true } };
  const connector = makeConnector(t, async () => response);

  await assert.rejects(() => connector.driveVerifyMailboxFolder('mailbox-folder-id'), /확인된 폴더/);
  response = { id: 'mailbox-folder-id', mimeType: 'application/vnd.google-apps.folder', capabilities: { canListChildren: true, canAddChildren: false } };
  await assert.rejects(() => connector.driveVerifyMailboxFolder('mailbox-folder-id'), /목록 및 파일 추가 권한/);
});

test('mailbox folder verification rejects invalid IDs before requesting Drive', async t => {
  const connector = makeConnector(t, async () => { throw new Error('request should not be made'); });

  await assert.rejects(() => connector.driveVerifyMailboxFolder('bad\nid'), /폴더 ID/);
  await assert.rejects(() => connector.driveVerifyMailboxFolder('x'.repeat(513)), /폴더 ID/);
});
