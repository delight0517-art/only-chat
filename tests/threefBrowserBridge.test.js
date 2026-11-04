'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ThreefBrowserBridge } = require('../src/browser/ThreefBrowserBridge.js');

async function main() {
  const descriptorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-3f-descriptor-'));
  try {
    const descriptorPath = path.join(descriptorRoot, 'descriptor.json');
    fs.writeFileSync(descriptorPath, JSON.stringify({ schemaVersion: 1, host: '127.0.0.1', port: 43121, token: 'a'.repeat(96) }), { mode: 0o600 });
    const descriptorBridge = new ThreefBrowserBridge({ descriptorPath });
    assert.equal(descriptorBridge.isAvailable(), true, 'a valid owner-only regular descriptor remains available');
    const outsideDescriptor = path.join(descriptorRoot, 'outside.json');
    fs.writeFileSync(outsideDescriptor, fs.readFileSync(descriptorPath));
    fs.unlinkSync(descriptorPath);
    fs.symlinkSync(outsideDescriptor, descriptorPath);
    assert.equal(descriptorBridge.isAvailable(), false, 'descriptor symlinks are rejected');
    fs.unlinkSync(descriptorPath);
    fs.writeFileSync(descriptorPath, fs.readFileSync(outsideDescriptor), { mode: 0o644 });
    assert.equal(descriptorBridge.isAvailable(), false, 'group/world-readable descriptors are rejected');
  } finally { fs.rmSync(descriptorRoot, { recursive: true, force: true }); }
  let opened = null;
  const bridge = new ThreefBrowserBridge({
    openExternal: async value => { opened = value; },
    readDescriptor: () => null,
    policy: { check: async () => ({ allowed: true }) },
    startupProbeTimeoutMs: 0
  });
  const openedResult = await bridge.launch('https://example.com/path?q=hello%20world');
  assert.equal(openedResult.ok, false, 'sending a deep link alone must not count as a verified browser open');
  assert.equal(openedResult.requested, true);
  assert.match(openedResult.stderr, /페이지를 확인하지 못했습니다/);
  assert.equal(new URL(opened).protocol, 'threef:');
  assert.equal(new URL(opened).searchParams.get('url'), 'https://example.com/path?q=hello%20world');

  const beforeInvalid = opened;
  assert.equal((await bridge.navigate('javascript:alert(1)')).ok, false);
  assert.equal((await bridge.navigate('https://user:secret@example.com')).ok, false);
  assert.equal(opened, beforeInvalid);

  const blocked = new ThreefBrowserBridge({
    openExternal: async value => { opened = value; },
    readDescriptor: () => null,
    policy: { check: async () => ({ allowed: false, reason: 'blocked', rule: 'example.com' }) }
  });
  assert.equal((await blocked.navigate('https://example.com')).blocked, true);
  assert.equal(opened, beforeInvalid);

  const status = await bridge.getStatus();
  assert.equal(status.controlAvailable, false);
  assert.match(status.statusText, /제어 서비스/);
  assert.equal((await bridge.readText()).ok, false);
  assert.match((await bridge.getAriaTree()).ariaTree, /제어 서비스/);

  const connectedBlankTab = new ThreefBrowserBridge({
    descriptorPath: '/not-used-in-test',
    readDescriptor: () => ({ schemaVersion: 1, host: '127.0.0.1', port: 43120, token: 'a'.repeat(96) }),
    fetchImpl: async () => ({ status: 503, json: async () => ({ ok: false, error: 'browser view not ready' }) })
  });
  const blankTabStatus = await connectedBlankTab.getStatus();
  assert.equal(blankTabStatus.controlAvailable, true, 'authenticated blank-tab response proves the control service is connected');
  assert.equal(blankTabStatus.isOpen, false, 'a connected service with a blank tab has no open page');
  assert.equal(blankTabStatus.activeUrl, '');
  assert.match(blankTabStatus.statusText, /연결됨 · 열린 페이지 없음/);

  const token = 'a'.repeat(96);
  const requests = [];
  opened = null;
  const controlled = new ThreefBrowserBridge({
    openExternal: async value => { opened = value; },
    descriptorPath: '/not-used-in-test',
    readDescriptor: () => ({ schemaVersion: 1, host: '127.0.0.1', port: 43121, token }),
    policy: { check: async () => ({ allowed: true }) },
    fetchImpl: async (url, options) => {
      requests.push({ path: new URL(url).pathname, authorization: options.headers.Authorization, body: options.body });
      const payload = new URL(url).pathname === '/v1/status' ? { ok: true, url: 'https://example.com/', title: 'Example', backURL: 'https://example.com/previous', forwardURL: '' }
        : new URL(url).pathname === '/v1/navigate' ? { ok: true, url: 'https://example.com/' }
        : new URL(url).pathname === '/v1/aria' ? { ok: true, url: 'https://example.com', ariaTree: 'button [oc-agent-1] Submit' }
          : new URL(url).pathname === '/v1/read' ? { ok: true, url: 'https://example.com', text: 'page content' }
            : new URL(url).pathname === '/v1/history' ? { ok: true, url: 'https://example.com/previous' }
              : new URL(url).pathname === '/v1/act' ? { ok: true, url: 'https://example.com/', result: 'clicked' }
                : { ok: true, result: 'clicked' };
      return { status: 200, json: async () => payload };
    }
  });
  const controlledNavigation = await controlled.navigate('https://example.com');
  assert.equal(controlledNavigation.ok, true);
  assert.equal(opened, null, 'live control channel should navigate the 3F tab without another handoff');
  assert.equal((await controlled.getStatus()).controlAvailable, true);
  assert.match((await controlled.getAriaTree()).ariaTree, /oc-agent-1/);
  assert.equal((await controlled.readText()).stdout, 'page content');
  assert.equal((await controlled.act('click [oc-agent-1]')).stdout, 'clicked');
  assert.equal((await controlled.history('back')).ok, true);
  assert.equal((await controlled.history('reload')).ok, true);
  assert.equal((await controlled.history('forward')).ok, false);
  assert.ok(requests.every(request => request.authorization === `Bearer ${token}`));

  const navigationResponse = async responseUrl => new ThreefBrowserBridge({
    descriptorPath: '/not-used-in-test',
    readDescriptor: () => ({ schemaVersion: 1, host: '127.0.0.1', port: 43121, token }),
    policy: { check: async url => url.startsWith('https://example.com')
      ? { allowed: true }
      : { allowed: false, reason: 'blocked', rule: 'private.example' } },
    fetchImpl: async () => ({ status: 200, json: async () => ({ ok: true, ...(responseUrl === undefined ? {} : { url: responseUrl }) }) })
  }).navigate('https://example.com/');
  const blockedNavigationResponse = await navigationResponse('https://private.example/account');
  assert.equal(blockedNavigationResponse.ok, false, 'direct navigation response is rechecked if it redirects to a blocked page');
  assert.equal(blockedNavigationResponse.blocked, true);
  const missingNavigationResponse = await navigationResponse(undefined);
  assert.equal(missingNavigationResponse.ok, false, 'direct navigation must return a verifiable actual URL');
  const mismatchedNavigationResponse = await navigationResponse('https://example.com/other');
  assert.equal(mismatchedNavigationResponse.ok, false, 'a different actual page is not reported as the requested navigation');

  const staleDescriptor = new ThreefBrowserBridge({
    descriptorPath: '/not-used-in-test',
    readDescriptor: () => ({ schemaVersion: 1, host: '127.0.0.1', port: 43122, token }),
    fetchImpl: async () => { throw new TypeError('connect ECONNREFUSED 127.0.0.1:43122'); }
  });
  const staleStatus = await staleDescriptor.getStatus();
  assert.equal(staleStatus.enabled, true);
  assert.equal(staleStatus.controlAvailable, false, 'a valid stale descriptor must not claim the 3F control service is connected');
  assert.equal(staleStatus.isOpen, false);
  assert.match(staleStatus.statusText, /연결을 사용할 수 없습니다/);

  const blockedRequests = [];
  const blockedPageBridge = new ThreefBrowserBridge({
    descriptorPath: '/not-used-in-test',
    readDescriptor: () => ({ schemaVersion: 1, host: '127.0.0.1', port: 43121, token }),
    policy: { check: async () => ({ allowed: false, reason: 'blocked', rule: 'private.example' }) },
    fetchImpl: async url => {
      blockedRequests.push(new URL(url).pathname);
      return { status: 200, json: async () => ({ ok: true, url: 'https://private.example/account', backURL: 'https://private.example/previous' }) };
    }
  });
  const blockedRead = await blockedPageBridge.readText();
  assert.equal(blockedRead.blocked, true);
  assert.deepEqual(blockedRequests, ['/v1/status'], 'blocked page content must not be read after the Focus Fence recheck');
  const blockedHistory = await blockedPageBridge.history('back');
  assert.equal(blockedHistory.blocked, true);
  assert.deepEqual(blockedRequests, ['/v1/status', '/v1/status'], 'blocked history target must not be submitted to the 3F controller');

  const racedRead = new ThreefBrowserBridge({
    descriptorPath: '/not-used-in-test',
    readDescriptor: () => ({ schemaVersion: 1, host: '127.0.0.1', port: 43121, token }),
    policy: { check: async url => url.startsWith('https://example.com')
      ? { allowed: true }
      : { allowed: false, reason: 'blocked', rule: 'private.example' } },
    fetchImpl: async url => ({ status: 200, json: async () => new URL(url).pathname === '/v1/status'
      ? { ok: true, url: 'https://example.com/' }
      : { ok: true, url: 'https://private.example/account', text: 'secret page text' } })
  });
  const racedReadResult = await racedRead.readText();
  assert.equal(racedReadResult.ok, false, 'read content is withheld when the page changes to a blocked URL after the initial status check');
  assert.equal(racedReadResult.stdout, '');
  assert.equal(racedReadResult.blocked, true);
  assert.match(racedReadResult.stderr, /Focus Fence 차단/);

  const racedAria = new ThreefBrowserBridge({
    descriptorPath: '/not-used-in-test',
    readDescriptor: () => ({ schemaVersion: 1, host: '127.0.0.1', port: 43121, token }),
    policy: { check: async url => url.startsWith('https://example.com')
      ? { allowed: true }
      : { allowed: false, reason: 'blocked', rule: 'private.example' } },
    fetchImpl: async url => ({ status: 200, json: async () => new URL(url).pathname === '/v1/status'
      ? { ok: true, url: 'https://example.com/' }
      : { ok: true, url: 'https://private.example/account', ariaTree: 'button [oc-agent-1] Secret' } })
  });
  const racedAriaResult = await racedAria.getAriaTree();
  assert.equal(racedAriaResult.blocked, true, 'ARIA is withheld when its response URL differs into a blocked page');
  assert.equal(racedAriaResult.ariaTree.startsWith('Focus Fence 차단'), true);

  for (const responseUrl of [undefined, 'javascript:alert(1)']) {
    const invalidResponseUrl = new ThreefBrowserBridge({
      descriptorPath: '/not-used-in-test',
      readDescriptor: () => ({ schemaVersion: 1, host: '127.0.0.1', port: 43121, token }),
      policy: { check: async () => ({ allowed: true }) },
      fetchImpl: async url => ({ status: 200, json: async () => new URL(url).pathname === '/v1/status'
        ? { ok: true, url: 'https://example.com/' }
        : { ok: true, ...(responseUrl === undefined ? {} : { url: responseUrl }), text: 'unverified content' } })
    });
    const invalidResponse = await invalidResponseUrl.readText();
    assert.equal(invalidResponse.ok, false, `read rejects response URL ${String(responseUrl)}`);
    assert.equal(invalidResponse.stdout, '', 'unverified response content is never returned');
  }

  const responsePolicyFailure = new ThreefBrowserBridge({
    descriptorPath: '/not-used-in-test',
    readDescriptor: () => ({ schemaVersion: 1, host: '127.0.0.1', port: 43121, token }),
    policy: { check: async (_url, count = 0) => { if (++responsePolicyFailureChecks > 1) throw new Error('synthetic policy offline'); return { allowed: true }; } },
    fetchImpl: async url => ({ status: 200, json: async () => new URL(url).pathname === '/v1/status'
      ? { ok: true, url: 'https://example.com/' }
      : { ok: true, url: 'https://example.com/changed', text: 'unverified content' } })
  });
  let responsePolicyFailureChecks = 0;
  const policyFailureResult = await responsePolicyFailure.readText();
  assert.equal(policyFailureResult.ok, false, 'a policy outage during response URL recheck fails closed');
  assert.equal(policyFailureResult.stdout, '');
  assert.match(policyFailureResult.stderr, /정책을 확인할 수 없어/);

  const missingAriaUrl = new ThreefBrowserBridge({
    descriptorPath: '/not-used-in-test',
    readDescriptor: () => ({ schemaVersion: 1, host: '127.0.0.1', port: 43121, token }),
    policy: { check: async () => ({ allowed: true }) },
    fetchImpl: async url => ({ status: 200, json: async () => new URL(url).pathname === '/v1/status'
      ? { ok: true, url: 'https://example.com/' }
      : { ok: true, ariaTree: 'unverified controls' } })
  });
  const missingAriaResult = await missingAriaUrl.getAriaTree();
  assert.equal(missingAriaResult.tabId, null, 'ARIA response without a verified page URL is rejected');
  assert.match(missingAriaResult.ariaTree, /주소를 확인할 수 없어/);

  const racedHistoryRequests = [];
  const racedHistory = new ThreefBrowserBridge({
    descriptorPath: '/not-used-in-test',
    readDescriptor: () => ({ schemaVersion: 1, host: '127.0.0.1', port: 43121, token }),
    policy: { check: async url => url.startsWith('https://example.com')
      ? { allowed: true }
      : { allowed: false, reason: 'blocked', rule: 'private.example' } },
    fetchImpl: async (url, options) => {
      const pathname = new URL(url).pathname;
      racedHistoryRequests.push(pathname);
      return { status: 200, json: async () => pathname === '/v1/status'
        ? { ok: true, url: 'https://example.com/current', backURL: 'https://example.com/previous' }
        : { ok: true, url: 'https://private.example/account' } };
    }
  });
  const racedHistoryResult = await racedHistory.history('back');
  assert.equal(racedHistoryResult.ok, false, 'history does not report success if its actual destination is blocked');
  assert.equal(racedHistoryResult.blocked, true);
  assert.match(racedHistoryResult.stderr, /Focus Fence 차단/);
  assert.deepEqual(racedHistoryRequests, ['/v1/status', '/v1/history'], 'the destination is rechecked only after the requested history action returns');

  const racedActionRequests = [];
  const racedAction = new ThreefBrowserBridge({
    descriptorPath: '/not-used-in-test',
    readDescriptor: () => ({ schemaVersion: 1, host: '127.0.0.1', port: 43121, token }),
    policy: { check: async url => url.startsWith('https://example.com')
      ? { allowed: true }
      : { allowed: false, reason: 'blocked', rule: 'private.example' } },
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      racedActionRequests.push(pathname);
      return { status: 200, json: async () => pathname === '/v1/status'
        ? { ok: true, url: 'https://example.com/current' }
        : { ok: true, url: 'https://private.example/account', result: 'private page content' } };
    }
  });
  const racedActionResult = await racedAction.act('read [oc-agent-1]');
  assert.equal(racedActionResult.ok, false, 'an action result from a newly blocked page is withheld');
  assert.equal(racedActionResult.stdout, '');
  assert.equal(racedActionResult.blocked, true);
  assert.match(racedActionResult.stderr, /Focus Fence 차단/);
  assert.deepEqual(racedActionRequests, ['/v1/status', '/v1/act']);

  const missingActionUrl = new ThreefBrowserBridge({
    descriptorPath: '/not-used-in-test',
    readDescriptor: () => ({ schemaVersion: 1, host: '127.0.0.1', port: 43121, token }),
    policy: { check: async () => ({ allowed: true }) },
    fetchImpl: async url => ({ status: 200, json: async () => new URL(url).pathname === '/v1/status'
      ? { ok: true, url: 'https://example.com/current' }
      : { ok: true, result: 'unverified action output' } })
  });
  const missingActionUrlResult = await missingActionUrl.act('read [oc-agent-1]');
  assert.equal(missingActionUrlResult.ok, false, 'an action result without a verifiable response URL is rejected');
  assert.equal(missingActionUrlResult.stdout, '', 'action output is withheld when the response URL is missing');
  assert.match(missingActionUrlResult.stderr, /주소를 확인할 수 없어/);

  let unsafeFetches = 0;
  const unsafeDescriptor = new ThreefBrowserBridge({
    descriptorPath: '/not-used-in-test',
    readDescriptor: () => ({ schemaVersion: 1, host: '0.0.0.0', port: 43121, token }),
    fetchImpl: async () => { unsafeFetches++; }
  });
  assert.equal((await unsafeDescriptor.readText()).ok, false);
  assert.equal(unsafeFetches, 0);

  let launchForLateView = null;
  const notReady = new ThreefBrowserBridge({
    openExternal: async value => { launchForLateView = value; },
    descriptorPath: '/not-used-in-test',
    readDescriptor: () => ({ schemaVersion: 1, host: '127.0.0.1', port: 43121, token }),
    policy: { check: async () => ({ allowed: true }) },
    startupProbeTimeoutMs: 0,
    fetchImpl: async () => ({ status: 503, json: async () => ({ ok: false, error: 'browser view not ready' }) })
  });
  assert.equal((await notReady.navigate('https://example.com')).ok, false);
  assert.equal(new URL(launchForLateView).protocol, 'threef:');

  let pageReady = false;
  const lateController = new ThreefBrowserBridge({
    openExternal: async () => { pageReady = true; },
    descriptorPath: '/not-used-in-test',
    readDescriptor: () => ({ schemaVersion: 1, host: '127.0.0.1', port: 43121, token }),
    policy: { check: async () => ({ allowed: true }) },
    startupProbeTimeoutMs: 100,
    startupProbeIntervalMs: 0,
    fetchImpl: async (_url, options) => {
      if (options.method === 'POST') return { status: 503, json: async () => ({ ok: false, error: 'browser view not ready' }) };
      return pageReady
        ? { status: 200, json: async () => ({ ok: true, url: 'https://example.com/' }) }
        : { status: 503, json: async () => ({ ok: false, error: 'browser view not ready' }) };
    }
  });
  const verifiedLateOpen = await lateController.navigate('https://example.com');
  assert.equal(verifiedLateOpen.ok, true, 'late 3F startup succeeds only after status confirms the requested page');
  assert.match(verifiedLateOpen.stdout, /열고 확인했습니다/);

  const unavailable = new ThreefBrowserBridge({ readDescriptor: () => null });
  assert.equal((await unavailable.navigate('https://example.com')).ok, false);
  let disabledCalls = 0;
  const disabled = new ThreefBrowserBridge({ isEnabled: () => false, openExternal: async () => { disabledCalls++; }, readDescriptor: () => ({ schemaVersion:1,host:'127.0.0.1',port:1,token:'a'.repeat(96) }), fetchImpl: async () => { disabledCalls++; } });
  assert.equal((await disabled.navigate('https://example.com')).ok, false);
  assert.equal((await disabled.getStatus()).enabled, false);
  assert.equal((await disabled.readText()).ok, false);
  assert.deepEqual((await disabled.getAriaTree()).blocked, false);
  assert.equal((await disabled.history('back')).ok, false);
  assert.equal((await disabled.act('click')).ok, false);
  assert.equal(disabledCalls, 0);
  const missingPolicy = new ThreefBrowserBridge({ openExternal: async () => { disabledCalls++; }, readDescriptor: () => null });
  assert.equal((await missingPolicy.navigate('https://example.com')).ok, false);
  const policyError = new ThreefBrowserBridge({ openExternal: async () => { disabledCalls++; }, policy: { check: async () => { throw new Error('offline'); } } });
  assert.equal((await policyError.navigate('https://example.com')).ok, false);
  assert.equal(disabledCalls, 0);
  console.log('3F Browser navigation handoff, response URL/policy fail-closed checks, Focus Fence blocks, and unsupported-control status passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
