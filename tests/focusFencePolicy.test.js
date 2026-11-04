'use strict';

const assert = require('node:assert/strict');
const { FocusFencePolicy, normalizeHttpUrl, matchPolicy } = require('../src/browser/FocusFencePolicy.js');

assert.equal(normalizeHttpUrl('example.com'), 'https://example.com/');
assert.throws(() => normalizeHttpUrl('javascript:alert(1)'), /HTTP와 HTTPS/);
assert.equal(matchPolicy('https://sub.example.com/watch', { blockedDomains: ['example.com'] }), 'example.com');
assert.equal(matchPolicy('https://youtube.com/@blocked', { keywords: ['youtube.com/@blocked'] }), 'youtube.com/@blocked');
assert.equal(matchPolicy('https://example.com/fun/path', { keywords: ['example.com/fun/*'] }), 'example.com/fun/*');
assert.equal(matchPolicy('https://google.com/search?q=casino', { searchQueries: [{ term: 'casino', match: 'contains' }] }), 'casino');
assert.equal(matchPolicy('https://example.com/safe', { blockedDomains: [], keywords: [] }), null);
assert.equal(matchPolicy('https://example.com/blocked/path', { blockedDomains: [], blockedUrlParts: ['blocked/path'], keywords: [] }), 'blocked/path');
assert.equal(matchPolicy('https://youtube.com/watch?v=AbCdEf12345', { blockedDomains: [], keywords: [], blockedYoutubeVideoIds: ['AbCdEf12345'] }), 'AbCdEf12345');
assert.equal(matchPolicy('https://youtube.com/watch?v=AbCdEf12345', { blockedDomains: [], keywords: [], blockedVideos: ['AbCdEf12345'] }), 'AbCdEf12345');
assert.equal(matchPolicy('https://youtube.com/@Creator', { blockedDomains: [], keywords: [], blockedYoutubeHandles: ['creator'] }), '@Creator');
assert.equal(matchPolicy('https://youtube.com/@Creator', { blockedDomains: [], keywords: [], blockedChannels: ['@creator'] }), '@Creator');

async function main() {
  const calls = [];
  const youtube = new FocusFencePolicy({ ports: [17361], fetch: async url => {
    calls.push(String(url));
    if (String(url).includes('/rules')) return { ok: true, json: async () => ({ protectionEnabled: true, blockedDomains: [], blockedUrlParts: [], keywords: [], youtubeQuotaBlocked: true }) };
    if (String(url).includes('/block')) return { ok: true, json: async () => ({}) };
    throw new Error('Unexpected request');
  } });
  const videoDecision = await youtube.check('https://youtube.com/watch?v=AbCdEf12345');
  assert.equal(videoDecision.allowed, false);
  assert.equal(videoDecision.rule, 'YouTube 사용량 제한');
  assert.equal(calls.some(url => url.includes('/youtube/check') || url.includes('/youtube/channel-check')), false,
    'the current Focus Fence rules snapshot supplies the YouTube quota decision');

  const youtubeAllowed = await new FocusFencePolicy({ ports: [17361], fetch: async url => {
    if (String(url).includes('/rules')) return { ok: true, json: async () => ({ blockedDomains: [], blockedUrlParts: [], keywords: [], youtubeQuotaBlocked: false }) };
    throw new Error('Unexpected request');
  } }).check('https://youtube.com/');
  assert.deepEqual(youtubeAllowed, { allowed: true, url: 'https://youtube.com/', reason: 'allowed' });

  const youtubeUnknown = await new FocusFencePolicy({ ports: [17361], fetch: async url => {
    if (String(url).includes('/rules')) return { ok: true, json: async () => ({ blockedDomains: [], blockedUrlParts: [], keywords: [] }) };
    throw new Error('Unexpected request');
  } }).check('https://youtube.com/');
  assert.equal(youtubeUnknown.reason, 'focus_fence_unavailable', 'missing quota state must fail closed for YouTube');

  const policyFor = rules => new FocusFencePolicy({ ports: [17361], fetch: async url => {
    if (url.includes('/rules')) return { ok: true, json: async () => rules };
    if (url.includes('/block')) return { ok: true, json: async () => ({}) };
    throw new Error('Unexpected request');
  } });
  const modernRules = { blockedDomains: ['blocked.test'], blockedUrlParts: ['blocked/path'], keywords: ['restricted-term'] };
  const modernBlock = await policyFor(modernRules).check('https://blocked.test');
  assert.deepEqual(modernBlock, {
    allowed: false, url: 'https://blocked.test/', reason: 'blocked', rule: 'blocked.test'
  });
  assert.equal((await policyFor(modernRules).check('https://allowed.test')).reason, 'allowed');

  const legacyTrue = await policyFor({ protectionEnabled: true, blockedDomains: ['blocked.test'], blockedUrlParts: [], keywords: [] }).check('https://blocked.test');
  assert.equal(legacyTrue.reason, 'blocked');
  assert.equal((await policyFor({ protectionEnabled: false, blockedDomains: ['blocked.test'], blockedUrlParts: [], keywords: [] }).check('https://blocked.test')).reason, 'protection_disabled');

  for (const malformed of [
    { blockedDomains: [], keywords: [] },
    { protectionEnabled: 'true', blockedDomains: [], blockedUrlParts: [], keywords: [] },
    { protectionEnabled: true, blockedDomains: [], blockedUrlParts: null, keywords: [] },
    { unrecognized: true }
  ]) {
    assert.equal((await policyFor(malformed).check('https://example.com')).reason, 'focus_fence_unavailable');
  }

  const unavailable = new FocusFencePolicy({ ports: [17361], fetch: async () => { throw new Error('offline'); } });
  assert.equal((await unavailable.check('https://example.com')).reason, 'focus_fence_unavailable');
  console.log('Focus Fence policy checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
