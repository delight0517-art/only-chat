'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EmbeddedThreefBrowserBridge } = require('../src/browser/EmbeddedThreefBrowserBridge.js');

test('embedded browser navigation succeeds only when the active address matches the request', async () => {
  let activeUrl = 'about:blank';
  const bridge = new EmbeddedThreefBrowserBridge({
    policy: { check: async url => ({ allowed: true, url }) },
    dispatch: async command => {
      if (command.action === 'navigate') activeUrl = command.url;
      return { available: true, url: activeUrl };
    }
  });

  const result = await bridge.navigate('https://example.com');
  assert.equal(result.ok, true);
  assert.equal(result.addressMatchesRequested, true);
  assert.equal(result.url, 'https://example.com/');
  assert.match(result.stdout, /주소를 확인했습니다/);
});

test('accepted navigation that leaves the previous address is reported as unverified', async () => {
  const bridge = new EmbeddedThreefBrowserBridge({
    policy: { check: async url => ({ allowed: true, url }) },
    dispatch: async command => command.action === 'status'
      ? { available: true, url: 'about:blank' }
      : { accepted: true }
  });

  const result = await bridge.navigate('https://example.com');
  assert.equal(result.ok, false);
  assert.equal(result.requested, true);
  assert.equal(result.addressMatchesRequested, false);
  assert.equal(result.url, 'about:blank');
  assert.match(result.stderr, /이동했는지 확인되지 않았습니다/);
});

test('navigation is not called successful when the browser status cannot be read back', async () => {
  const bridge = new EmbeddedThreefBrowserBridge({
    policy: { check: async url => ({ allowed: true, url }) },
    dispatch: async command => command.action === 'status'
      ? { available: false, url: 'about:blank' }
      : { accepted: true }
  });

  const result = await bridge.navigate('https://example.com');
  assert.equal(result.ok, false);
  assert.equal(result.addressMatchesRequested, false);
  assert.match(result.stderr, /주소를 확인할 수 없습니다/);
});
