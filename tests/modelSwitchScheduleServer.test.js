'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DesktopServer } = require('../src/ui/desktop/server.js');
const { ModelSwitchScheduleStore } = require('../src/core/ModelSwitchScheduleStore.js');

function request(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const origin = `http://127.0.0.1:${port}`;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: {
      Host: `127.0.0.1:${port}`, Origin: origin, 'Sec-Fetch-Site': 'same-origin',
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {})
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('model switch schedule routes persist, validate configured targets, and cancel', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-model-switch-http-'));
  const app = Object.create(DesktopServer.prototype);
  app.port = 0;
  app.isolated = false;
  app.syncEnabled = false;
  app.modelSwitchScheduleStore = new ModelSwitchScheduleStore({ dataDir });
  app.engine = { priorityChain: { chain: { tiers: [
    { enabled: true, model: 'gpt-6-sol' }, { enabled: true, model: 'gpt-6-luna' }
  ] } } };
  const server = http.createServer((req, res) => app._handleRequest(req, res));
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    app.port = server.address().port;
    const sessionId = 'session_1793700000000';
    const invalid = await request(app.port, 'POST', '/api/model-switch-schedule', {
      sessionId, requestId: 'bad-target', currentModel: 'gpt-6-sol', currentEffort: 'xhigh', targetModel: 'gpt-6-unknown', targetEffort: 'low', durationMinutes: 5
    });
    assert.equal(invalid.status, 409, 'unconfigured model cannot be scheduled');
    const created = await request(app.port, 'POST', '/api/model-switch-schedule', {
      sessionId, requestId: 'schedule-1', currentModel: 'gpt-6-sol', currentEffort: 'xhigh', targetModel: 'gpt-6-luna', targetEffort: 'low', durationMinutes: 5
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.schedule.state, 'scheduled');
    const fetched = await request(app.port, 'GET', `/api/model-switch-schedule?sessionId=${sessionId}`);
    assert.equal(fetched.body.schedule.id, created.body.schedule.id);
    const cancelled = await request(app.port, 'DELETE', '/api/model-switch-schedule', { sessionId });
    assert.equal(cancelled.body.schedule.state, 'cancelled');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
    assert.equal(fs.existsSync(dataDir), false, 'temporary test profile is removed');
  }
});
