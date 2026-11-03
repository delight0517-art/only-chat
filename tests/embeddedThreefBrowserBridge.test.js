'use strict';

const assert = require('node:assert/strict');
const { EmbeddedThreefBrowserBridge } = require('../src/browser/EmbeddedThreefBrowserBridge.js');

async function main() {
  const commands = [];
  const bridge = new EmbeddedThreefBrowserBridge({
    policy: { check: async url => url.includes('blocked.test')
      ? { allowed: false, reason: 'blocked', rule: 'blocked.test' }
      : { allowed: true, reason: 'allowed' } },
    dispatch: async command => { commands.push(command); return { available: true, url: command.url || 'https://allowed.test' }; }
  });
  const opened = await bridge.launch('https://allowed.test');
  assert.equal(opened.ok, true);
  assert.deepEqual(commands[0], { action: 'navigate', url: 'https://allowed.test/' });
  assert.equal((await bridge.navigate('https://blocked.test')).blocked, true);
  assert.equal((await bridge.navigate('https://user:secret@allowed.test')).ok, false);
  assert.equal((await bridge.getStatus()).controlAvailable, true);
  await bridge.getAriaTree();
  await bridge.readText();
  await bridge.act('click [oc-agent-1]');
  await bridge.history('back');
  assert.deepEqual(commands.filter(command => command.action !== 'status').map(command => command.action), ['navigate', 'aria', 'read', 'act', 'back']);

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
  console.log('Embedded 3F Browser routing, Focus Fence enforcement, URL credentials rejection, and offline behavior passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
