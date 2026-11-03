'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DesktopServer } = require('../src/ui/desktop/server.js');
const { RecurringScheduleStore } = require('../src/scheduler/RecurringScheduleStore.js');

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

test('schedule HTTP routes create, list, read, update, run and delete schedules safely', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-schedule-http-'));
  const app = Object.create(DesktopServer.prototype);
  app.port = 0;
  app.isolated = false;
  app.syncEnabled = false;
  app.scheduleStore = new RecurringScheduleStore({ dataDir });
  let runCalled = false;
  app.scheduleService = { runNow(id) { runCalled = true; return { accepted: true, scheduleId: id, taskId: 'queued_test' }; } };
  const server = http.createServer((req, res) => app._handleRequest(req, res));
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    app.port = server.address().port;
    const missingTools = await request(app.port, 'POST', '/api/schedules', {
      title: 'Missing tools', prompt: 'Review notes', frequency: 'daily', localTime: '09:00', enabled: true,
      attachments: []
    });
    assert.equal(missingTools.status, 400, 'schedule creation without an explicit tool allowlist is rejected');
    const stringEnabled = await request(app.port, 'POST', '/api/schedules', {
      title: 'String enabled', prompt: 'Do not run', allowedTools: ['read_file'], frequency: 'daily', localTime: '09:00', enabled: 'false'
    });
    assert.equal(stringEnabled.status, 400, 'string false is rejected instead of enabling a recurring task');
    const created = await request(app.port, 'POST', '/api/schedules', {
      title: 'Monthly review', prompt: 'Review current notes', allowedTools: ['read_file', 'read_file'], frequency: 'monthly', monthDay: 31, localTime: '09:00', enabled: true,
      attachments: [{ name: 'notes.md', contentBase64: Buffer.from('review data').toString('base64') }]
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.schedule.attachments[0].content, 'review data');
    assert.deepEqual(created.body.schedule.allowedTools, ['read_file']);
    const id = created.body.schedule.id;

    const invalidUpdate = await request(app.port, 'PUT', `/api/schedules/${id}`, { enabled: 'false' });
    assert.equal(invalidUpdate.status, 400, 'invalid enabled update is rejected');
    assert.equal(app.scheduleStore.get(id).enabled, true, 'invalid update leaves the active schedule unchanged');

    const list = await request(app.port, 'GET', '/api/schedules');
    assert.equal(list.status, 200);
    assert.equal(list.body.schedules[0].title, 'Monthly review');
    assert.equal('content' in list.body.schedules[0].attachments[0], false, 'list response does not expand attachment content');

    const fetched = await request(app.port, 'GET', `/api/schedules/${id}`);
    assert.equal(fetched.body.schedule.attachments[0].content, 'review data');
    const updated = await request(app.port, 'PUT', `/api/schedules/${id}`, {
      title: 'Edited review', prompt: 'Review again', allowedTools: ['google_drive_read'], frequency: 'weekly', weekday: 2, localTime: '10:00', enabled: false,
      attachments: [{ id: created.body.schedule.attachments[0].id }]
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.schedule.title, 'Edited review');
    assert.deepEqual(updated.body.schedule.allowedTools, ['google_drive_read']);
    assert.equal(updated.body.schedule.attachments[0].content, 'review data');

    const run = await request(app.port, 'POST', `/api/schedules/${id}/run`, {});
    assert.equal(run.status, 202);
    assert.equal(runCalled, true);
    const deleted = await request(app.port, 'DELETE', `/api/schedules/${id}`);
    assert.deepEqual(deleted.body, { ok: true });
    assert.equal(app.scheduleStore.get(id), null);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('schedule HTTP attachment parser rejects noncanonical base64 and too many files', () => {
  const app = Object.create(DesktopServer.prototype);
  assert.throws(() => app._scheduleInput({ attachments: [{ name: 'x.txt', contentBase64: '%%%=' }] }), /인코딩/);
  assert.throws(() => app._scheduleInput({ attachments: Array.from({ length: 6 }, () => ({ id: 'att_000000000000000000000000' })) }), /최대 5개/);
});
