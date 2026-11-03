'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tagName) { this.tagName = tagName; this.children = []; this.listeners = {}; this.attributes = {}; this.textContent = ''; this.removed = false; }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(...items) { this.children.push(...items); }
  appendChild(item) { this.children.push(item); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  remove() { this.removed = true; }
  focus() { this.ownerDocument.activeElement = this; }
}

const source = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.css'), 'utf8');
const start = source.indexOf('function setAssistantWorkStatus(card, text) {');
const end = source.indexOf('\nwindow.toggleAssistantMore =', start);
assert.ok(start >= 0 && end > start, 'approval event renderer must remain extractable');
assert.match(css, /\.assistant-tool-approval button:focus-visible/);
assert.match(css, /\.assistant-tool-approval \[role="status"\]:focus/);

async function verifyDecision(decision) {
  const document = {
    activeElement: null,
    createElement(tagName) { const element = new Element(tagName); element.ownerDocument = this; return element; }
  };
  const timeline = { scrollTop: 0, scrollHeight: 100 };
  const card = { content: { children: [], appendChild(element) { this.children.push(element); } }, workStatusNode: { textContent: '' } };
  let submitted;
  const context = {
    document, timeline, card,
    event: { type: 'tool_approval_required', requestId: 'req-123', sessionId: 'ses_0123456789abcdef', name: 'codex_cli_workspace_write_scope', args: { directory: '/workspace', reason: 'Review' } },
    fetch: async (_url, options) => { submitted = JSON.parse(options.body); return { ok: true }; },
    window: {},
    toolDisplayName: name => name === 'codex_cli_workspace_write_scope' ? 'Codex 요청 실행 범위 승인' : name
  };
  vm.runInNewContext(`${source.slice(start, end)}\nhandleStreamEvent(event, card);`, context);
  const panel = card.content.children[0];
  assert.equal(panel.attributes.role, 'group');
  assert.match(panel.attributes['aria-label'], /Codex 요청 실행 범위 승인/);
  const heading = panel.children[0];
  const approve = panel.children[2];
  const reject = panel.children[3];
  assert.equal(heading.attributes.role, 'status');
  assert.equal(heading.attributes['aria-live'], 'polite');
  assert.equal(approve.attributes['aria-label'], 'Codex 요청 실행 범위 승인 승인');
  assert.equal(reject.attributes['aria-label'], 'Codex 요청 실행 범위 승인 거절');
  await panel.children[decision === 'approve' ? 2 : 3].listeners.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(submitted.decision, decision);
  assert.equal(approve.removed, true);
  assert.equal(reject.removed, true);
  assert.equal(document.activeElement, heading, 'focus returns to the announced decision result');
  assert.match(heading.textContent, decision === 'approve' ? /승인됨/ : /거절됨/);
}

(async () => {
  await verifyDecision('approve');
  await verifyDecision('reject');
  console.log('toolApprovalAccessibility passed: named group, distinct actions, live decision, focus return');
})().catch(error => { console.error(error); process.exitCode = 1; });
