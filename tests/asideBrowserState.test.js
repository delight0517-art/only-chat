'use strict';

const assert = require('node:assert/strict');
const { AsideBrowser } = require('../src/browser/AsideBrowser.js');

async function main() {
  const unavailable = new AsideBrowser({ asideBinary: '/usr/bin/false' });
  const failedLaunch = await unavailable.launch('https://example.com');
  assert.equal(failedLaunch.ok, false);
  assert.equal(unavailable.isOpen, false);
  assert.equal(unavailable.activeUrl, 'about:blank');

  const browser = new AsideBrowser({ asideBinary: '/usr/bin/true' });
  const launched = await browser.launch('https://example.com');
  assert.equal(launched.ok, true);
  assert.equal(browser.isOpen, true);
  assert.equal(browser.activeUrl, 'https://example.com');

  browser.asideBinary = '/usr/bin/false';
  const failedNavigation = await browser.navigate('https://other.example');
  assert.equal(failedNavigation.ok, false);
  assert.equal(browser.activeUrl, 'https://example.com');
  assert.equal(browser.isOpen, true);

  console.log('Aside browser status tracks successful launch and navigation only');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
