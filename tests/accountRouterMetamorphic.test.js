'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EvolutionInbox } = require('../src/sync/EvolutionInbox.js');
const { EvolutionRelay } = require('../src/sync/EvolutionRelay.js');
const { AccountRouterModuleSlot } = require('../src/features/provider/AccountRouterModuleSlot.js');
const { AgentEngine } = require('../src/core/AgentEngine.js');

const PROVIDER = 'src/features/provider/v1.mjs';
const THEME = 'src/ui/desktop/modules/theme/v1.mjs';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const providerSource = version => `export const version = '${version}';\nexport function createAccountRouterAdapter() { return Object.freeze({ getChain: async () => ({ enabled: false, accounts: [] }), call: async () => ({ content: version, toolCalls: [], protocol: 'openai-compatible' }) }); }\n`;

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'OnlyChat-AccountRouterMorph-'));
  const senderRoot = path.join(root, 'sender');
  const receiverRoot = path.join(root, 'receiver');
  const relayRoot = path.join(root, 'relay');
  const dataDir = path.join(root, 'receiver-data');
  const before = Buffer.from(providerSource('old'));
  const after = Buffer.from(providerSource('new'));
  let sender = null;
  let inbox = null;
  try {
    for (const sourceRoot of [senderRoot, receiverRoot]) {
      const providerPath = path.join(sourceRoot, PROVIDER);
      const themePath = path.join(sourceRoot, THEME);
      fs.mkdirSync(path.dirname(providerPath), { recursive: true });
      fs.mkdirSync(path.dirname(themePath), { recursive: true });
      fs.writeFileSync(providerPath, before);
      fs.writeFileSync(themePath, 'export const theme = \'old\';\n');
    }

    const slot = new AccountRouterModuleSlot({ projectRoot: receiverRoot });
    await slot.load();
    const engine = Object.create(AgentEngine.prototype);
    Object.assign(engine, {
      isolated: false,
      accountRouterModuleSlot: slot,
      currentSession: { sessionId: 'synthetic-session' },
      workspaceDir: receiverRoot,
      tools: { approvalPolicy: 'on-request' }
    });
    const inFlightAdapter = await engine._getAccountRouterAdapter();
    assert.equal((await inFlightAdapter.call({}, [{ role: 'user', content: 'before update' }])).content, 'old');
    sender = new EvolutionRelay({ canonicalRoot: senderRoot, relayRoot, deviceId: 'peer', platform: 'darwin' });
    sender.start();
    let blockers = ['active_turn'];
    let verifierCalls = 0;
    inbox = new EvolutionInbox({
      canonicalRoot: receiverRoot,
      dataDir,
      platform: 'darwin',
      getBlockers: () => blockers,
      verifyReload: context => {
        verifierCalls += 1;
        if (!context.files.some(file => file.path === PROVIDER)) return { state: 'source-applied' };
        return engine.verifyMetamorphicProviderReload(context);
      }
    });
    inbox.configure({ relayRoot });

    const providerPacket = sender.publish({
      summary: 'Router provider module update',
      files: [{ path: PROVIDER, baseHash: digest(before), content: after }]
    });
    assert.equal((await inbox.relay.apply(providerPacket.packetId)).state, 'deferred');
    assert.equal(fs.readFileSync(path.join(receiverRoot, PROVIDER), 'utf8'), before.toString());
    blockers = [];
    const providerReceipt = await inbox.relay.apply(providerPacket.packetId);
    assert.equal(providerReceipt.state, 'runtime-applied');
    assert.equal(providerReceipt.loadedHashes[PROVIDER], digest(after));
    assert.equal(slot.status().loadedHash, digest(after));
    assert.equal((await inFlightAdapter.call({}, [{ role: 'user', content: 'in flight' }])).content, 'old');
    const nextTurn = await engine._callProviderWithFallback(
      { id: 'router', provider: 'account-router', model: 'auto' },
      [{ role: 'user', content: 'after update' }],
      {},
      { reasoningEffort: 'low' }
    );
    assert.equal(nextTurn.content, 'new');

    const themeBefore = Buffer.from("export const theme = 'old';\n");
    const themeAfter = Buffer.from("export const theme = 'new';\n");
    const themePacket = sender.publish({
      summary: 'Theme source update',
      files: [{ path: THEME, baseHash: digest(themeBefore), content: themeAfter }]
    });
    const themeReceipt = await inbox.relay.apply(themePacket.packetId);
    assert.equal(themeReceipt.state, 'source-applied');
    assert.equal(themeReceipt.loadedHashes && Object.keys(themeReceipt.loadedHashes).length, 0);
    assert.equal(fs.readFileSync(path.join(receiverRoot, THEME), 'utf8'), themeAfter.toString());
    assert.equal(verifierCalls, 2);

    console.log('accountRouterMetamorphic.test.js: passed (busy deferral, exact hash ACK, in-flight adapter preservation, next-turn reload, non-provider source-only receipt)');
  } finally {
    if (inbox?.relay) await inbox.relay.stop();
    if (sender) await sender.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
