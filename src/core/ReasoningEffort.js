'use strict';

const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

function parseReasoningEffort(value) {
  if (value == null || value === '') return 'low';
  const normalized = String(value).trim().toLowerCase().replace(/[ _-]+/g, ' ');
  const aliases = new Map([
    ['light', 'low'],
    ['med', 'medium'],
    ['extra high', 'xhigh'],
    ['extra-high', 'xhigh']
  ]);
  const effort = aliases.get(normalized) || normalized;
  return REASONING_EFFORTS.includes(effort) ? effort : null;
}

module.exports = { REASONING_EFFORTS, parseReasoningEffort };
