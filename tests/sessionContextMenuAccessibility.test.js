'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { createSessionMetadataGuard } = require('../src/ui/desktop/sessionDropMapping.js');

class Element {
  constructor() { this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.style = {}; this.hidden = true; this.isConnected = true; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  querySelector(selector) {
    if (selector === 'button') return this.children.find(child => child.tagName === 'button') || null;
    if (selector === '.session-menu-button') return this.children.find(child => child.className === 'session-menu-button') || null;
    return null;
  }
  querySelectorAll(selector) { return selector === '[role="menuitem"]' ? this.children.filter(child => child.attributes.role === 'menuitem') : []; }
  contains(target) { return this === target || this.children.includes(target); }
  getBoundingClientRect() { return { right: 10, bottom: 10 }; }
  focus() { this.ownerDocument.activeElement = this; }
}

test('internal session menu supports keyboard navigation and preserves data when destructive/edit prompts are cancelled', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
  const start = source.indexOf('function hideSessionContextMenu(');
  const end = source.indexOf('\nasync function loadSessions()', start);
  assert.ok(start >= 0 && end > start, 'session menu functions must remain in the expected source slice');
  const menu = new Element();
  const document = {
    activeElement: null,
    listeners: {},
    pageItems: [],
    createElement(tagName) { const element = new Element(); element.tagName = tagName; element.ownerDocument = this; return element; },
    getElementById: () => menu,
    querySelectorAll(selector) { return selector === '[data-session-id]' ? this.pageItems : []; },
    querySelector(selector) { return selector === '.session-menu-button' ? this.pageItems.map(item => item.querySelector(selector)).find(Boolean) || null : null; },
    addEventListener(name, handler) { this.listeners[name] = handler; }
  };
  menu.ownerDocument = document;
  let confirmResult = true;
  let fetchCalls = 0;
  const window = { innerWidth: 800, innerHeight: 600, confirm: () => confirmResult, prompt: () => null, alert() {} };
  const context = { document, window, sessionMetadataGuard: createSessionMetadataGuard(), fetch: async () => { fetchCalls++; return { ok: true }; }, loadSessions: async () => {} };
  vm.runInNewContext(`let sessionContextActionPending = false; const sessionContextMenu = document.getElementById('sessionContextMenu'); const sessionMetadataGuard = globalThis.sessionMetadataGuard;\n${source.slice(start, end)}\nglobalThis.openMenu = openSessionContextMenu;`, context);
  const trigger = new Element();
  trigger.ownerDocument = document;
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  context.openMenu({ source: 'internal', sessionId: 'ses_0123456789abcdef', title: 'Test' }, 10, 10, trigger);
  const items = menu.querySelectorAll('[role="menuitem"]');
  assert.equal(items.length, 5);
  assert.equal(document.activeElement, items[0]);
  assert.equal(menu.attributes['aria-label'], 'Test 작업 메뉴');
  assert.equal(trigger.attributes['aria-expanded'], 'true');
  const key = value => {
    let prevented = false;
    document.listeners.keydown({ key: value, preventDefault() { prevented = true; } });
    return prevented;
  };
  assert.equal(key('ArrowDown'), true);
  assert.equal(document.activeElement, items[1]);
  key('ArrowUp');
  assert.equal(document.activeElement, items[0]);
  key('End');
  assert.equal(document.activeElement, items[4]);
  key('Home');
  assert.equal(document.activeElement, items[0]);
  key('Escape');
  assert.equal(menu.hidden, true);
  assert.equal(document.activeElement, trigger);
  assert.equal(trigger.attributes['aria-expanded'], 'false');

  context.openMenu({ source: 'internal', sessionId: 'ses_0123456789abcdef', title: 'Test' }, 10, 10, trigger);
  assert.equal(key('Tab'), false, 'Tab keeps its native navigation behavior');
  assert.equal(menu.hidden, true, 'Tab closes the menu before focus leaves it');
  assert.equal(document.activeElement, trigger, 'the native Tab step continues from the menu trigger');
  assert.equal(trigger.attributes['aria-expanded'], 'false');

  context.openMenu({ source: 'internal', sessionId: 'ses_0123456789abcdef', title: 'Test' }, 10, 10, trigger);
  const outsideControl = new Element();
  outsideControl.ownerDocument = document;
  document.activeElement = outsideControl;
  key('Escape');
  assert.equal(menu.hidden, true, 'Escape closes the menu after focus moves outside it');
  assert.equal(document.activeElement, trigger, 'Escape restores focus to the control that opened the menu');

  confirmResult = false;
  context.openMenu({ source: 'internal', sessionId: 'ses_0123456789abcdef', title: 'Test' }, 10, 10, trigger);
  const deleteAction = menu.querySelectorAll('[role="menuitem"]')[4];
  await deleteAction.listeners.click();
  assert.equal(fetchCalls, 0, 'cancelled permanent deletion never reaches the metadata API');
  assert.equal(menu.hidden, true);
  assert.equal(document.activeElement, trigger, 'cancel returns focus to the session menu button');

  context.openMenu({ source: 'internal', sessionId: 'ses_0123456789abcdef', title: 'Test' }, 10, 10, trigger);
  const renameAction = menu.querySelectorAll('[role="menuitem"]')[0];
  await renameAction.listeners.click();
  assert.equal(fetchCalls, 0, 'cancelled rename prompt never reaches the metadata API');
  assert.equal(menu.hidden, true);
  assert.equal(document.activeElement, trigger, 'cancelled rename returns focus to its trigger');

  context.sessionMetadataGuard.begin('ses_0123456789abcdef');
  context.openMenu({ source: 'internal', sessionId: 'ses_0123456789abcdef', title: 'Test' }, 10, 10, trigger);
  await menu.querySelectorAll('[role="menuitem"]')[1].listeners.click();
  assert.equal(fetchCalls, 0, 'a context-menu mutation cannot race an in-flight drag/drop metadata change');
  assert.equal(menu.hidden, true, 'a conflicting mutation closes the menu cleanly');
  context.sessionMetadataGuard.end('ses_0123456789abcdef');
});

test('successful session menu action returns focus to the refreshed session row', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
  const start = source.indexOf('function hideSessionContextMenu(');
  const end = source.indexOf('\nasync function loadSessions()', start);
  const menu = new Element();
  let metadataCalls = 0;
  let resolveMetadata;
  let failNextMetadata = false;
  let alerts = 0;
  const document = {
    activeElement: null,
    listeners: {},
    pageItems: [],
    createElement(tagName) { const element = new Element(); element.tagName = tagName; element.ownerDocument = this; return element; },
    getElementById: () => menu,
    querySelectorAll(selector) { return selector === '[data-session-id]' ? this.pageItems : []; },
    querySelector(selector) { return selector === '.session-menu-button' ? this.pageItems.map(item => item.querySelector(selector)).find(Boolean) || null : null; },
    addEventListener(name, handler) { this.listeners[name] = handler; }
  };
  menu.ownerDocument = document;
  const context = {
    document,
    sessionMetadataGuard: createSessionMetadataGuard(),
    window: { innerWidth: 800, innerHeight: 600, confirm: () => true, prompt: () => null, alert() { alerts++; } },
    fetch: () => {
      metadataCalls++;
      if (failNextMetadata) return Promise.reject(new Error('offline'));
      return new Promise(resolve => { resolveMetadata = resolve; });
    },
    async loadSessions() {
      const row = new Element(); row.ownerDocument = document; row.dataset.sessionId = 'ses_0123456789abcdef';
      const button = document.createElement('button'); button.className = 'session-menu-button';
      row.appendChild(button); document.pageItems = [row];
    }
  };
  vm.runInNewContext(`let sessionContextActionPending = false; const sessionContextMenu = document.getElementById('sessionContextMenu'); const sessionMetadataGuard = globalThis.sessionMetadataGuard;\n${source.slice(start, end)}\nglobalThis.openMenu = openSessionContextMenu;`, context);
  const trigger = document.createElement('button');
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  context.openMenu({ source: 'internal', sessionId: 'ses_0123456789abcdef', title: 'Test' }, 10, 10, trigger);
  const actions = menu.querySelectorAll('[role="menuitem"]');
  const firstAction = actions[1].listeners.click();
  await actions[1].listeners.click();
  assert.equal(metadataCalls, 1, 'a second click cannot issue another metadata request while the first is pending');
  assert.equal(actions.every(action => action.disabled), true, 'all menu actions are disabled during the mutation');
  resolveMetadata({ ok: true });
  await firstAction;
  assert.equal(menu.hidden, true);
  assert.equal(document.activeElement, document.pageItems[0].querySelector('.session-menu-button'));

  failNextMetadata = true;
  context.openMenu({ source: 'internal', sessionId: 'ses_0123456789abcdef', title: 'Test' }, 10, 10, trigger);
  await menu.querySelectorAll('[role="menuitem"]')[1].listeners.click();
  assert.equal(menu.hidden, true, 'network failure closes the menu after reporting the error');
  assert.equal(alerts, 1);
  assert.equal(document.activeElement, trigger, 'network failure returns focus to the menu trigger');
  context.openMenu({ source: 'internal', sessionId: 'ses_0123456789abcdef', title: 'Test' }, 10, 10, trigger);
  assert.equal(menu.hidden, false, 'a failed request releases the single-flight guard');
});
