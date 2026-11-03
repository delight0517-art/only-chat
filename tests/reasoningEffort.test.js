'use strict';

const assert = require('node:assert/strict');
const { REASONING_EFFORTS, parseReasoningEffort } = require('../src/core/ReasoningEffort.js');

assert.deepEqual(REASONING_EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max']);
assert.equal(parseReasoningEffort(undefined), 'low');
assert.equal(parseReasoningEffort('med'), 'medium');
assert.equal(parseReasoningEffort('Medium'), 'medium');
assert.equal(parseReasoningEffort('Light'), 'low');
assert.equal(parseReasoningEffort('Extra High'), 'xhigh');
assert.equal(parseReasoningEffort('high'), 'high');
assert.equal(parseReasoningEffort('invalid'), null);

console.log('reasoning effort aliases, defaults and supported levels passed');
