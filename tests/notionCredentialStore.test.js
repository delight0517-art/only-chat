'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'only-chat-keychain-test-'));
const keychainPath = path.join(temp, 'only-chat-test.keychain-db');
const helperPath = path.join(temp, 'NotionCredentialBridge');
const keychainPassword = 'synthetic-test-keychain-password';

function call(action, value) {
  const input = JSON.stringify({ action, ...(value === undefined ? {} : { value }) });
  return JSON.parse(execFileSync(helperPath, [], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ONLY_CHAT_TEST_KEYCHAIN_PATH: keychainPath },
    maxBuffer: 1024 * 1024,
  }));
}

try {
  execFileSync('/usr/bin/swiftc', [
    '-D', 'ONLY_CHAT_KEYCHAIN_TESTING', '-framework', 'Security',
    path.join(root, 'macOS/NotionCredentialBridge.swift'), '-o', helperPath,
  ], { stdio: 'ignore' });
  execFileSync('/usr/bin/security', ['create-keychain', '-p', keychainPassword, keychainPath], {
    stdio: 'ignore',
  });
  execFileSync('/usr/bin/security', ['unlock-keychain', '-p', keychainPassword, keychainPath], {
    stdio: 'ignore',
  });

  const secret = `synthetic-long-value-${'x'.repeat(32_000)}\nwith exact whitespace`;
  assert.deepEqual(call('set', secret), { ok: true, verified: true });
  assert.equal(call('get').value, secret);
  const replacement = `${secret} updated`;
  assert.deepEqual(call('set', replacement), { ok: true, verified: true });
  assert.equal(call('get').value, replacement);
  assert.deepEqual(call('delete'), { ok: true });
  assert.equal(call('get').value, null);
  process.stdout.write('Only Chat native bridge 32KB Keychain roundtrip/update/delete passed in isolated temporary keychain.\n');
} finally {
  try { execFileSync('/usr/bin/security', ['delete-keychain', keychainPath], { stdio: 'ignore' }); } catch (e) {}
  fs.rmSync(temp, { recursive: true, force: true });
}
