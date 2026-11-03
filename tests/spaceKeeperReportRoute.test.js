'use strict';

const assert = require('node:assert');
const http = require('node:http');
const { DesktopServer } = require('../src/ui/desktop/server.js');
const { SpaceKeeperConnector } = require('../src/connectors/SpaceKeeperConnector.js');

async function post(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST',
      path: '/api/spacekeeper/session-report',
      headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' }
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function main() {
  const app = Object.create(DesktopServer.prototype);
  app.port = 0;
  const calls = [];
  app.engine = { tools: { spaceKeeperSessionReport: async taskKey => {
    calls.push(taskKey);
    if (taskKey === 'unavailable-task') throw new Error('internal connector detail');
    return { schemaVersion: 1, taskKey, status: 'ok', capacityRecoveries: [], taskReview: { items: [] } };
  } } };
  const server = http.createServer((req, res) => app._handleRequest(req, res));
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    app.port = server.address().port;

    const valid = await post(app.port, { taskKey: 'detox-newcomer-qa-capacity-20261029' });
    assert.strictEqual(valid.status, 200);
    assert.strictEqual(valid.headers['cache-control'], 'no-store');
    assert.strictEqual(valid.body.taskKey, 'detox-newcomer-qa-capacity-20261029');
    assert.deepStrictEqual(calls, ['detox-newcomer-qa-capacity-20261029']);

    const invalid = await post(app.port, { taskKey: '../private' });
    assert.strictEqual(invalid.status, 400);
    assert.strictEqual(calls.length, 1);

    const unavailable = await post(app.port, { taskKey: 'unavailable-task' });
    assert.strictEqual(unavailable.status, 502);
    assert.match(unavailable.body.error, /Space Keeper/);
    assert.doesNotMatch(JSON.stringify(unavailable.body), /internal connector detail/);

    app.engine.tools.spaceKeeperSessionReport = taskKey => new SpaceKeeperConnector().sessionReport(taskKey);
    const live = await post(app.port, { taskKey: 'detox-newcomer-qa-capacity-20261029' });
    assert.strictEqual(live.status, 200);
    assert.strictEqual(live.body.status, 'ok');
    assert.strictEqual(live.body.taskKey, 'detox-newcomer-qa-capacity-20261029');
    assert.ok(Array.isArray(live.body.capacityRecoveries));
    assert.ok(Array.isArray(live.body.taskReview.items));
    assert.ok(Array.isArray(live.body.taskReview.currentItems));
    assert.ok(Array.isArray(live.body.taskReview.actions));
    assert.deepStrictEqual(Object.keys(live.body.storageDisposition).sort(),
      ['approved-expiry', 'keep', 'manual-review']);
    for (const disposition of Object.values(live.body.storageDisposition)) assert.ok(Array.isArray(disposition));
    assert.strictEqual(live.body.capacity.reserveGiB, 20);
    const classifications = new Set(live.body.taskReview.currentItems.map(item => item.classification));
    assert.ok(classifications.has('keep'));
    assert.ok(classifications.has('manual-review'));
    assert.ok(live.body.capacityRecoveries.every(row => row.task === live.body.taskKey));
    const blockedRecovery = live.body.capacityRecoveries.find(row => row.outcome === 'blocked');
    assert.ok(blockedRecovery);
    assert.strictEqual(blockedRecovery.deletedCount, 0);
    assert.ok(live.body.taskReview.actions.some(action =>
      action.action === 'generated-cache-cleanup' && action.status === 'refused' &&
      action.target === 'expired registered outputs' && action.reportedBytesFreed === 0));
    assert.doesNotMatch(JSON.stringify(live.body), /\/Users\//);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log('Space Keeper report route passed: validation/error paths and real local connector readback');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
