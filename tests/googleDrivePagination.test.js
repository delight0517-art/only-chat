'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { GoogleConnector } = require('../src/connectors/GoogleConnector.js');

test('Drive file listing returns a continuation token and requests the next page safely', async t => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-drive-page-'));
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));

  const connector = new GoogleConnector({ storageDir, clientConfigFile: false });
  connector.saveTokens({ access_token: 'test-access-token' });
  const requests = [];
  connector._httpRequest = async (...args) => {
    requests.push(args);
    return { files: [{ id: 'message-file' }], nextPageToken: 'continuation-token' };
  };

  const first = await connector.driveListFiles({ q: "'folder-id' in parents", pageSize: 100 });
  assert.equal(first.files.length, 1);
  assert.equal(first.nextPageToken, 'continuation-token');
  assert.equal(new URL(`https://www.googleapis.com${requests[0][1]}`).searchParams.has('pageToken'), false);
  assert.match(new URL(`https://www.googleapis.com${requests[0][1]}`).searchParams.get('fields'), /^nextPageToken,/);

  const second = await connector.driveListFiles({ q: "'folder-id' in parents", pageSize: 100, pageToken: first.nextPageToken });
  assert.equal(new URL(`https://www.googleapis.com${requests[1][1]}`).searchParams.get('pageToken'), 'continuation-token');
  assert.equal(second.nextPageToken, 'continuation-token');
  assert.equal(requests[1][0], 'www.googleapis.com');
  assert.equal(requests[1][2], 'GET');
});

test('Drive file listing rejects malformed continuation tokens before making a request', async t => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-drive-bad-page-'));
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));

  const connector = new GoogleConnector({ storageDir, clientConfigFile: false });
  connector.saveTokens({ access_token: 'test-access-token' });
  connector._httpRequest = async () => { throw new Error('request should not be made'); };

  await assert.rejects(() => connector.driveListFiles({ pageToken: 42 }), /pageToken must be a string/);
  await assert.rejects(() => connector.driveListFiles({ pageToken: `bad\ntoken` }), /pageToken is invalid/);
  await assert.rejects(() => connector.driveListFiles({ pageToken: 'x'.repeat(4097) }), /pageToken is invalid/);
});
