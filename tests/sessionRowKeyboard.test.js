'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.dataset = {};
    this.classList = { add: name => { this.className = `${this.className || ''} ${name}`.trim(); } };
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
}

const source = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
const start = source.indexOf('function renderSessionItems(');
const end = source.indexOf('\nfunction renderProjectGroups(', start);
assert.ok(start >= 0 && end > start, 'session item renderer must remain extractable');
const opened = [];
const context = {
  document: { createElement: tagName => new Element(tagName) },
  currentSessionId: 'codex_thread-current',
  loadSession: (...args) => opened.push(args),
  openSessionContextMenu() {},
  setDropTargetFeedback() {}
};
vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.render = renderSessionItems;`, context);

const list = new Element('div');
context.render(list, [{ id: 'codex_thread-current', source: 'codex', title: '현재 대화' }]);
const row = list.children[0];
const openButton = row.children[0];
assert.equal(openButton.tagName, 'button');
assert.equal(openButton.attributes.type, undefined, 'button type is assigned through the native type property');
assert.equal(openButton.type, 'button');
assert.equal(openButton.attributes['aria-label'], '현재 대화 열기');
assert.equal(openButton.attributes['aria-current'], 'page');
openButton.listeners.click();
assert.deepEqual(opened.pop(), ['codex_thread-current', '현재 대화', 'codex']);

const internalList = new Element('div');
context.render(internalList, [{ sessionId: 'ses_0123456789abcdef', source: 'internal', title: '내부 대화' }], true);
const internalRow = internalList.children[0];
assert.equal(internalRow.children[0].tagName, 'button');
assert.equal(internalRow.children[1].className, 'session-menu-button', 'menu remains a separate, valid sibling control');
internalRow.children[0].listeners.click();
assert.deepEqual(opened.pop(), ['ses_0123456789abcdef', '내부 대화', 'internal']);

const css = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.css'), 'utf8');
assert.match(css, /\.session-open-button:focus-visible\s*\{[^}]*outline-offset:\s*-2px/s, 'focus indicator stays inside the clipped sidebar row');
console.log('sessionRowKeyboard passed: native button activation, accessible name, current state, and separate menu control');
