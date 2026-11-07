'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/server.js'), 'utf8');
const codexSource = fs.readFileSync(path.join(__dirname, '../src/providers/CodexCliAdapter.js'), 'utf8');

test('Turbo mode enables whole drive access read and write by default', () => {
  assert.match(serverSource, /const isTurbo = this\.approvalPolicy === 'never';/, 'server identifies Turbo mode by never policy');
  assert.match(serverSource, /effectiveFullAccess = body\.fullAccess === true \|\| \(isTurbo && body\.fullAccess !== false\);/, 'server defaults fullAccess to true in Turbo mode');
  assert.match(codexSource, /\[Full Access \/ Whole Drive Access\]/, 'Codex CLI adapter receives whole drive access instructions');
  assert.match(codexSource, /'--sandbox', fullAccess \? 'danger-full-access'/, 'Codex CLI executes with danger-full-access sandbox for whole drive access');
});

test('Desktop UI app.js keeps Full Access active in Turbo mode', () => {
  assert.match(appSource, /const isTurbo = activeApprovalPolicy === 'never';/, 'UI identifies Turbo mode');
  assert.match(appSource, /effectiveFullAccess = isTurbo \|\| fullAccessForTurn === true;/, 'UI promotes turn fullAccess in Turbo mode');
  assert.match(appSource, /Turbo Full access · 전체 디스크/, 'UI displays Turbo full drive label');
});
