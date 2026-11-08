'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { DesktopServer } = require('../src/ui/desktop/server.js');
const { PriorityChainEngine } = require('../src/priority/PriorityChainEngine.js');

function post(port, body) {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/turn', method: 'POST',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
        'Content-Length': payload.length
      }
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('a selected model routes only to matching configured tiers and auto preserves priority order', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-model-route-'));
  const called = [];
  const toolProfiles = [];
  let statusToolCalls = 0;
  let app;
  try {
    app = new DesktopServer({
      port: 0,
      isolated: true,
      dataDir,
      workspaceDir: path.join(dataDir, 'workspace'),
      enableQuotaRefresh: false,
      isTierReady: () => true,
      providerAdapter: async (tier, _history, _hooks, context) => {
        called.push(tier.model);
        toolProfiles.push(context?.toolProfile || null);
        if (context?.toolProfile === 'embedded-3f-status') {
          if (_history.some(message => message.role === 'tool')) return { content: '3F Browser 제어 연결됨 · 열린 페이지 없음', toolCalls: [] };
          return { content: '', toolCalls: [{ id: 'embedded-status', name: 'embedded_3f_status', args: {} }] };
        }
        return { content: `response from ${tier.model}`, toolCalls: [] };
      }
    });
    app.engine.priorityChain.setTiers([
      { tier: 1, id: 'first', name: 'First', provider: 'synthetic', model: 'alpha-model', enabled: true },
      { tier: 2, id: 'second', name: 'Second', provider: 'synthetic', model: 'beta-model', enabled: true }
    ]);
    app.engine.initSession({ title: 'Model routing test' });
    const executeToolCall = app.engine._executeToolCall.bind(app.engine);
    app.engine._executeToolCall = async call => {
      if (call.name !== 'embedded_3f_status') return executeToolCall(call);
      statusToolCalls++;
      return { available: true, controlAvailable: true, activeUrl: 'about:blank', statusText: '3F Browser 제어 연결됨 · 열린 페이지 없음' };
    };
    await app.start();

    const selected = await post(app.port, { prompt: 'use the chosen model', reasoningEffort: 'low', modelSelection: 'beta-model' });
    assert.equal(selected.status, 200);
    assert.match(selected.text, /"type":"tier_resolved","tier":\{"tier":2,"id":"second"/);
    assert.deepEqual(called, ['beta-model']);

    const automatic = await post(app.port, { prompt: 'return to automatic', reasoningEffort: 'low', modelSelection: 'auto' });
    assert.equal(automatic.status, 200);
    assert.match(automatic.text, /"type":"tier_resolved","tier":\{"tier":1,"id":"first"/);
    assert.deepEqual(called, ['beta-model', 'alpha-model']);

    const statusProfile = await post(app.port, {
      prompt: '3F Browser 상태를 확인해.', reasoningEffort: 'low', modelSelection: 'alpha-model', toolProfile: 'embedded-3f-status'
    });
    assert.equal(statusProfile.status, 200, 'desktop API accepts the narrow read-only 3F status profile');
    assert.equal(toolProfiles.at(-1), 'embedded-3f-status', 'the profile reaches the provider adapter even in an isolated test runtime');
    assert.deepEqual(called, ['beta-model', 'alpha-model', 'alpha-model', 'alpha-model']);
    assert.equal(statusToolCalls, 1, 'AgentEngine allows the exact read-only status call in this profile');
    assert.match(statusProfile.text, /3F Browser 제어 연결됨 · 열린 페이지 없음/);

    const unsupported = await post(app.port, { prompt: 'reject an unknown model', reasoningEffort: 'low', modelSelection: 'not-configured' });
    assert.equal(unsupported.status, 400);
    assert.deepEqual(called, ['beta-model', 'alpha-model', 'alpha-model', 'alpha-model']);

    const malformed = await post(app.port, { prompt: 'reject malformed model choice', reasoningEffort: 'low', modelSelection: 42 });
    assert.equal(malformed.status, 400);
    assert.deepEqual(called, ['beta-model', 'alpha-model', 'alpha-model', 'alpha-model']);

    assert.equal(app.engine.priorityChain.setManualTier('second'), true);
    const wrongManualModel = await post(app.port, { prompt: 'do not switch manual accounts', reasoningEffort: 'low', modelSelection: 'alpha-model' });
    assert.equal(wrongManualModel.status, 409);
    assert.deepEqual(called, ['beta-model', 'alpha-model', 'alpha-model', 'alpha-model']);
  } finally {
    await app?.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('model preference respects manual account selection and matching tier fallback', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-model-chain-'));
  try {
    const chain = new PriorityChainEngine({ configDir, notify: () => {}, isTierReady: () => true });
    chain.setTiers([
      { tier: 1, id: 'first', name: 'First', provider: 'synthetic', model: 'alpha-model', enabled: true },
      { tier: 2, id: 'second', name: 'Second', provider: 'synthetic', model: 'beta-model', enabled: true },
      { tier: 3, id: 'third', name: 'Third', provider: 'synthetic', model: 'beta-model', enabled: true }
    ]);
    assert.equal(chain.resolveActiveTier(null, 'beta-model').id, 'second');
    chain.reportTierFailure('second', new Error('network disconnected'));
    assert.equal(chain.resolveActiveTier(null, 'beta-model').id, 'third');
    chain.setManualTier('third');
    assert.equal(chain.resolveActiveTier(null, 'beta-model').id, 'third');
    assert.equal(chain.resolveActiveTier(null, 'alpha-model'), null);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
