'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
const start = source.indexOf("case 'message_delta': {");
const end = source.indexOf("case 'tool_start': {", start);
assert(start >= 0 && end > start, 'message streaming handler should exist');
const handler = source.slice(start, end);
assert.match(handler, /if \(!card\.messageNode\)/);
assert.match(handler, /card\.messageText \+= String\(event\.delta \|\| ''\)/);
assert.match(handler, /card\.messageNode\.textContent = card\.messageText/);
assert.doesNotMatch(handler, /innerHTML\s*\+=/);

console.log('streamed assistant text reuses one text node');
