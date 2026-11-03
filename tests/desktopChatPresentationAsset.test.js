'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { DesktopServer } = require('../src/ui/desktop/server.js');

async function main() {
  const app = Object.create(DesktopServer.prototype);
  app.port = 0;
  app.isolated = false;
  app.syncEnabled = false;
  app.staticDir = path.join(__dirname, '../src/ui/desktop');
  const server = http.createServer((req, res) => app._handleRequest(req, res));
  try {
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    app.port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${app.port}/chatPresentation.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/javascript/);
    assert.match(await response.text(), /formatElapsed/);
    console.log('desktop chat presentation asset is served to the renderer');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
