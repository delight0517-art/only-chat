'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ForAiFeedbackInbox, safeProjectRoot } = require('../src/connectors/ForAiFeedbackInbox.js');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-for-ai-inbox-'));
process.on('exit', () => fs.rmSync(temp, { recursive: true, force: true }));

function setup(name = 'one') {
  const root = path.join(temp, name);
  const connector = path.join(root, 'connector');
  const data = path.join(root, 'data');
  const project = path.join(root, 'project');
  fs.mkdirSync(connector, { recursive: true, mode: 0o700 });
  fs.mkdirSync(project, { recursive: true, mode: 0o700 });
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(connector, 'connection.json'), JSON.stringify({ paired: true, enabled: true, token, scopes: ['for_ai'], cloudIdentity: { username: 'owner', cloudUserId: 'verified' } }), { mode: 0o600 });
  fs.writeFileSync(path.join(connector, 'plugin.json'), JSON.stringify({ token }), { mode: 0o600 });
  const dispatcher = new EventEmitter(); dispatcher.enqueueTasks = tasks => { dispatcher.last = tasks; return tasks; };
  const inbox = new ForAiFeedbackInbox({ dataDir: data, dispatcher, connectionDir: connector, projects: { for_ai: project } });
  return { inbox, dispatcher, token, data, project, connector };
}

function request(token, origin) {
  return { headers: { authorization: `Bearer ${token}`, ...(origin ? { origin } : {}) } };
}

const payload = (feedbackId, message = 'Fix this bug') => ({ feedbackId, project: 'for_ai', message });

test('authenticated enabled For AI feedback is queued once in its fixed project and body is not copied to the receipt store', () => {
  const { inbox, dispatcher, token, data, project } = setup();
  const id = '4e6820c4-4a63-4af2-b78d-96805039f7a1';
  const first = inbox.submit(request(token), payload(id));
  assert.equal(first.status, 'queued');
  assert.equal(first.duplicate, false);
  assert.equal(dispatcher.last[0].forAiProject, 'for_ai');
  assert.equal(dispatcher.last[0].allowedTools.includes('exec_command'), true);
  assert.equal(dispatcher.last[0].workspaceDir, undefined);
  assert.equal(inbox.isTaskAuthorized(dispatcher.last[0]), true);
  assert.equal(safeProjectRoot('for_ai', { for_ai: project }), fs.realpathSync(project));
  assert.equal(fs.readFileSync(path.join(data, 'for-ai-feedback-inbox.json'), 'utf8').includes('Fix this bug'), false);
  const duplicate = inbox.submit(request(token), payload(id));
  assert.equal(duplicate.duplicate, true);
  assert.equal(dispatcher.last.length, 1);
  assert.throws(() => inbox.submit(request(token), payload(id, 'different content')), error => error.statusCode === 409);
});

test('pairing, enablement, exact project scope and origin are required', () => {
  const { inbox, dispatcher, token, data, connector } = setup('auth');
  const id = 'f559e85c-4a2c-4d3a-8a7d-3d4072200494';
  assert.throws(() => inbox.submit(request('0'.repeat(64)), payload(id)), error => error.statusCode === 401);
  assert.throws(() => inbox.submit(request(token, 'https://attacker.example'), payload(id)), error => error.statusCode === 401);
  assert.throws(() => inbox.submit(request(token), { ...payload(id), project: 'detox' }), error => error.statusCode === 403);
  const configPath = path.join(connector, 'connection.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.enabled = false;
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  assert.equal(inbox.isTaskAuthorized({ forAiProject: 'for_ai' }), false);
  assert.throws(() => inbox.submit(request(token), payload(id)), error => error.statusCode === 401);
  assert.equal(dispatcher.last, undefined);
});

test('only one of the fixed absolute project roots can be selected', () => {
  const link = path.join(temp, 'for-ai-project-link');
  try { fs.symlinkSync(temp, link); } catch (_) {}
  if (fs.existsSync(link)) assert.throws(() => safeProjectRoot('link', { link }));
});

test('worker events persist status and interrupted work is never silently retried after restart', () => {
  const { inbox, dispatcher, token, data, project, connector } = setup('restart');
  const id = 'dcf0640a-3530-46b4-9822-4b04d8a5a99c';
  const receipt = inbox.submit(request(token), payload(id));
  const key = receipt.receiptId;
  dispatcher.emit('worker_started', { task: dispatcher.last[0] });
  assert.equal(inbox.status(request(token), id).status, 'running');
  const nextDispatcher = new EventEmitter(); nextDispatcher.enqueueTasks = () => { throw new Error('must not retry'); };
  const next = new ForAiFeedbackInbox({ dataDir: data, dispatcher: nextDispatcher, connectionDir: connector, projects: { for_ai: project } });
  assert.equal(next.entries[key].status, 'interrupted');
  assert.equal(next.submit(request(token), payload(id)).duplicate, true);
  assert.equal(next.entries[key].status, 'interrupted');
});
