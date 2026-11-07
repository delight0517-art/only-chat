'use strict';

const assert = require('node:assert/strict');
const { AgentEngine } = require('../src/core/AgentEngine.js');
const { EmbeddedThreefBrowserBridge } = require('../src/browser/EmbeddedThreefBrowserBridge.js');

async function main() {
  const { toolDefinitions, parseToolCalls } = await import('../src/features/provider/v1.mjs');
  const serverSource = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/ui/desktop/server.js'), 'utf8');
  assert.match(serverSource, /embeddedBrowserPanel:\s*this\.isolated\s*\?\s*null\s*:\s*this\.embeddedBrowserPanel/,
    'native embedded panel bridge is injected into the Only Chat agent');
  const definitions = toolDefinitions();
  const names = ['embedded_3f_status', 'embedded_3f_navigate', 'embedded_3f_read', 'embedded_3f_aria', 'embedded_3f_act', 'embedded_3f_history'];
  for (const name of names) assert.ok(definitions.some(tool => tool.function.name === name), `${name} is exposed to the Only Chat agent`);
  const readOnlyNames = toolDefinitions('read-only').map(tool => tool.function.name);
  for (const name of ['embedded_3f_status', 'embedded_3f_read', 'embedded_3f_aria']) assert.ok(readOnlyNames.includes(name));
  for (const name of ['embedded_3f_navigate', 'embedded_3f_act', 'embedded_3f_history']) assert.ok(!readOnlyNames.includes(name));
  assert.equal(parseToolCalls([{ id: 'panel', function: { name: 'embedded_3f_read', arguments: '{}' } }])[0].name, 'embedded_3f_read');

  const routed = Object.create(AgentEngine.prototype);
  const calls = [];
  const routeNames = {
    embedded_3f_status: 'embeddedThreefStatus', embedded_3f_navigate: 'embeddedThreefNavigate',
    embedded_3f_read: 'embeddedThreefRead', embedded_3f_aria: 'embeddedThreefAria',
    embedded_3f_act: 'embeddedThreefAct', embedded_3f_history: 'embeddedThreefHistory'
  };
  routed.tools = Object.fromEntries(Object.values(routeNames).map(method => [method, async value => { calls.push([method, value]); return method; }]));
  const routeArgs = { embedded_3f_navigate: { url: 'https://allowed.test' }, embedded_3f_act: { action: 'click oc-agent-1' }, embedded_3f_history: { action: 'back' } };
  for (const name of names) await routed._executeToolCall({ name, args: routeArgs[name] || {} });
  assert.deepEqual(calls.map(([method]) => method), names.map(name => routeNames[name]), 'agent calls reach the embedded 3F bridge routes');

  const commands = [];
  const bridge = new EmbeddedThreefBrowserBridge({
    policy: { check: async url => url.includes('blocked.test')
      ? { allowed: false, reason: 'blocked', rule: 'blocked.test' }
      : { allowed: true, reason: 'allowed' } },
    dispatch: async command => { commands.push(command); return { available: true, url: command.action === 'status' ? 'https://allowed.test/' : (command.url || 'https://allowed.test/') }; }
  });
  const opened = await bridge.launch('https://allowed.test');
  assert.equal(opened.ok, true);
  assert.deepEqual(commands[0], { action: 'navigate', url: 'https://allowed.test/' });
  assert.equal(opened.addressMatchesRequested, true);
  assert.equal((await bridge.navigate('https://blocked.test')).blocked, true);
  assert.equal((await bridge.navigate('https://user:secret@allowed.test')).ok, false);
  assert.equal((await bridge.getStatus()).controlAvailable, true);
  await bridge.getAriaTree();
  await bridge.readText();
  await bridge.act('click [oc-agent-1]');
  await bridge.history('back');
  assert.deepEqual(commands.filter(command => command.action !== 'status').map(command => command.action), ['navigate', 'aria', 'read', 'act', 'back']);

  const blockedPage = new EmbeddedThreefBrowserBridge({
    policy: { check: async () => ({ allowed: false, reason: 'blocked', rule: 'blocked.test' }) },
    dispatch: async command => ({ available: true, url: command.url || 'https://blocked.test' })
  });
  const blockedAria = await blockedPage.getAriaTree();
  assert.equal(blockedAria.ok, false);
  assert.equal(blockedAria.blocked, true);
  assert.match(blockedAria.ariaTree, /Focus Fence 차단: blocked\.test/);

  const offline = new EmbeddedThreefBrowserBridge({
    policy: { check: async () => ({ allowed: true }) },
    dispatch: async () => { throw new Error('panel disconnected'); }
  });
  assert.equal((await offline.navigate('https://allowed.test')).ok, false);
  assert.equal((await offline.getStatus()).controlAvailable, false);

  const connectedBlank = new EmbeddedThreefBrowserBridge({
    dispatch: async () => ({ available: true, url: 'about:blank' })
  });
  const blankStatus = await connectedBlank.getStatus();
  assert.equal(blankStatus.controlAvailable, true);
  assert.match(blankStatus.statusText, /열린 페이지 없음/);
  const blankRead = await new EmbeddedThreefBrowserBridge({
    policy: { check: async () => ({ allowed: true }) },
    dispatch: async command => command.action === 'status'
      ? { available: true, url: 'about:blank' }
      : { text: '' }
  }).readText();
  assert.equal(blankRead.ok, false, 'an empty page read must not be reported as verified success');
  assert.match(blankRead.stderr, /읽을 수 있는 텍스트가 없어 페이지 읽기를 확인하지 못했습니다/);

  const notYetNavigated = new EmbeddedThreefBrowserBridge({
    policy: { check: async () => ({ allowed: true }) },
    dispatch: async command => command.action === 'status'
      ? { available: true, url: 'about:blank' }
      : { accepted: true }
  });
  const pendingNavigation = await notYetNavigated.navigate('https://allowed.test');
  assert.equal(pendingNavigation.requested, true);
  assert.equal(pendingNavigation.addressMatchesRequested, false);
  assert.equal(pendingNavigation.url, 'about:blank', 'accepted command must not be reported as a completed navigation');

  const waitingPanel = new EmbeddedThreefBrowserBridge({
    policy: { check: async () => ({ allowed: true }) },
    dispatch: async command => command.action === 'status'
      ? { available: false, url: 'about:blank' }
      : { ok: true }
  });
  const waitingStatus = await waitingPanel.getStatus();
  assert.equal(waitingStatus.controlAvailable, false);
  assert.equal(waitingStatus.isOpen, false);
  assert.match(waitingStatus.statusText, /연결 대기/);

  const connectedPanel = new EmbeddedThreefBrowserBridge({
    policy: { check: async url => url.includes('youtube.com')
      ? { allowed: false, reason: 'blocked', rule: 'YouTube 사용량 제한' }
      : { allowed: true, reason: 'allowed' } },
    dispatch: async command => {
      if (command.action === 'status') {
        return { available: true, url: 'https://example.com/', title: 'Example Domain' };
      }
      if (command.action === 'read') {
        return { text: 'Example Domain documentation' };
      }
      if (command.action === 'aria') {
        return { text: '[oc-agent-1] a Learn more' };
      }
      return { ok: true, url: command.url || 'https://example.com/' };
    }
  });
  connectedPanel.policy.evaluate = async () => ({ decision: 'allowed', reasonCode: 'rules_allow', url: 'https://example.com/?secret=query', rule: 'private-rule', title: 'leak-title', body: 'leak-body' });
  const connectedStatus = await connectedPanel.getStatus();
  assert.deepEqual(connectedStatus.policyStatus, { decision: 'allowed', reasonCode: 'rules_allow' });
  assert.equal(connectedStatus.controlAvailable, true);
  const policyStatusText = JSON.stringify(connectedStatus.policyStatus);
  for (const secret of ['example.com', 'secret', 'query', 'Example Domain', 'private-rule', 'leak-title', 'leak-body']) {
    assert.equal(policyStatusText.includes(secret), false, `policyStatus must not leak ${secret}`);
  }
  assert.equal(connectedStatus.isOpen, true);
  assert.equal(connectedStatus.statusText, 'Only Chat 안의 3F Browser 연결됨');
  const connectedText = await connectedPanel.readText();
  assert.equal(connectedText.ok, true);
  assert.match(connectedText.stdout, /Example Domain/);
  const connectedAria = await connectedPanel.getAriaTree();
  assert.equal(connectedAria.ok, true);
  assert.equal(connectedAria.blocked, false);
  assert.match(connectedAria.ariaTree, /Learn more/);
  const youtubeBlock = await connectedPanel.navigate('https://www.youtube.com/watch?v=sample');
  assert.equal(youtubeBlock.ok, false);
  assert.equal(youtubeBlock.blocked, true);
  assert.match(youtubeBlock.stderr, /YouTube 사용량 제한/);

  console.log('Embedded 3F Browser routing, Focus Fence enforcement, URL credentials rejection, and offline behavior passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
