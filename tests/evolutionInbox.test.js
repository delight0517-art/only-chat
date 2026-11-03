'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EvolutionInbox } = require('../src/sync/EvolutionInbox.js');
const { EvolutionRelay } = require('../src/sync/EvolutionRelay.js');

const modulePath = 'src/ui/desktop/modules/theme/v1.mjs';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'OnlyChat-EvolutionInbox-'));
  const macRoot = path.join(temp, 'mac-source'); const winRoot = path.join(temp, 'windows-source');
  const relayRoot = path.join(temp, 'shared-relay'); const dataDir = path.join(temp, 'app-data');
  const original = Buffer.from('export const theme="base";\n');
  const changed = Buffer.from('export const theme="windows";\n');
  let inbox; let windows;
  try {
    fs.mkdirSync(relayRoot, { recursive: true });
    for (const root of [macRoot, winRoot]) {
      fs.mkdirSync(path.dirname(path.join(root, modulePath)), { recursive: true });
      fs.writeFileSync(path.join(root, modulePath), original);
    }
    inbox = new EvolutionInbox({ canonicalRoot: macRoot, dataDir, platform: 'darwin' });
    const status = inbox.configure({ relayRoot });
    assert.equal(status.enabled, true);
    assert.equal(status.pending.length, 0);
    const deviceId = status.deviceId;
    windows = new EvolutionRelay({ canonicalRoot: winRoot, relayRoot, deviceId: 'windows-test', platform: 'win32' });
    windows.start();
    const packet = windows.publish({ summary: 'Windows theme adjustment', task: 'Keep pending until Mac integration is verified.', files: [{ path: modulePath, baseHash: digest(original), content: changed }] });
    const deadline = Date.now() + 1000;
    let pending = [];
    while (Date.now() < deadline) {
      pending = inbox.status().pending;
      if (pending.some(item => item.packetId === packet.packetId)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(pending.length, 1);
    assert.equal(pending[0].packetId, packet.packetId);
    assert.equal(pending[0].authorDeviceId, 'windows-test');
    assert.equal(fs.readFileSync(path.join(macRoot, modulePath)).toString(), original.toString(), 'receiving only queues metadata and never applies source');
    await inbox.stop();
    const resumed = new EvolutionInbox({ canonicalRoot: macRoot, dataDir, platform: 'darwin' });
    assert.equal(resumed.startConfigured().pending[0].packetId, packet.packetId, 'pending change survives app restart');
    assert.equal(resumed.disable().enabled, false);
    assert.equal(new EvolutionInbox({ canonicalRoot: macRoot, dataDir, platform: 'darwin' }).startConfigured().enabled, false);
    console.log('evolutionInbox.test.js: passed (event-driven arrival, restart persistence, explicit disconnect, no blind source apply)');
  } finally {
    inbox?.stop();
    await windows?.stop();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
