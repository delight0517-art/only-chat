'use strict';

const assert = require('node:assert/strict');
const { resolveBrowserInput } = require('../src/ui/desktop/browser-address.js');

assert.equal(resolveBrowserInput(''), 'https://www.google.com');
assert.equal(resolveBrowserInput('example.com/path?q=a b'), 'https://example.com/path?q=a%20b');
assert.equal(resolveBrowserInput('localhost:3000/health'), 'https://localhost:3000/health');
assert.equal(resolveBrowserInput('http://example.com'), 'http://example.com/');
assert.equal(resolveBrowserInput('search these words'), 'https://www.google.com/search?q=search%20these%20words');
assert.equal(resolveBrowserInput('javascript://example.com'), null);
assert.equal(resolveBrowserInput('file:///etc/passwd'), null);
assert.equal(resolveBrowserInput('https://user:password@example.com'), null);
console.log('3F in-app browser address/search resolution passed');
