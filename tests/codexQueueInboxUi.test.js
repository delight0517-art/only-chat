'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.textContent = ''; this.value = ''; this.readOnly = false; this.disabled = false; this.dataset = {}; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = [...children]; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute(name, value) { this.attributes ||= {}; this.attributes[name] = value; }
  dispatchEvent() { this.dispatched = true; }
  focus() { this.focused = true; }
  click() { this.listeners.click?.(); }
}

const source = fs.readFileSync(require.resolve('../src/ui/desktop/app.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../src/ui/desktop/index.html'), 'utf8');
const css = fs.readFileSync(require.resolve('../src/ui/desktop/app.css'), 'utf8');
assert.match(html, /id="codexQueueList"/);
assert.match(html, /id="codexQueueCount"[^>]*>—<\/span>/, 'the initial count must not imply a successfully read empty queue');
assert.match(source, /void loadCodexQueueInbox\(\)/);
assert.match(source, /setInterval\(\(\) => \{\s*refreshCodexQueueWhenVisible\(\);\s*\}, 30000\)/);
assert.match(source, /document\.addEventListener\('visibilitychange', refreshCodexQueueWhenVisible\)/);
assert.match(css, /\.nav-item-action\s*\{[^}]*var\(--bg-card-hover\)/);
assert.match(css, /\.nav-item-action:hover\s*\{[^}]*var\(--accent-orange\)/);
const loadStart = source.indexOf('async function loadCodexQueueInbox() {');
const start = source.indexOf('function renderCodexQueueInbox(items) {');
const end = source.indexOf('\nfunction isValidSessionListData(data) {', start);
const queueStateStart = source.indexOf("const CODEX_QUEUE_SEND_STATES_KEY = 'onlychat.codexQueueSendStates.v1';");
const queueStateEnd = source.indexOf('\nfunction setDropTargetFeedback(target, active) {', queueStateStart);
const abortCleanupStart = source.indexOf('function clearCurrentAbortControllerIfSame(turnAbortController) {');
const abortCleanupEnd = source.indexOf('\nfunction abortActiveTurn()', abortCleanupStart);
const composerGuardStart = source.indexOf('function isCodexQueueComposerProtected() {');
const composerGuardEnd = source.indexOf('\nfunction getCodexQueueSendStateAfterTurn', composerGuardStart);
assert.ok(loadStart >= 0 && start > loadStart && queueStateStart > 0 && queueStateEnd > queueStateStart && end > start, 'queue loader, send-state and renderer should remain testable functions');
assert.ok(abortCleanupStart >= 0 && abortCleanupEnd > abortCleanupStart, 'turn controller cleanup should remain testable');
assert.ok(composerGuardStart >= 0 && composerGuardEnd > composerGuardStart, 'composer protection guard should remain testable');
const turnRequestStart = source.indexOf('const turnAbortController = new AbortController();');
const turnRequestFinally = source.indexOf('} finally {', turnRequestStart);
const turnCleanupEnd = source.indexOf('\nfunction clearCurrentAbortControllerIfSame', turnRequestFinally);
assert.ok(turnRequestStart >= 0 && turnRequestFinally > turnRequestStart && turnCleanupEnd > turnRequestFinally, 'provider turn must have a settled cleanup path');
assert.match(source.slice(turnRequestStart, turnRequestFinally), /signal:\s*turnAbortController\.signal/, 'the provider request must use its own abort controller');
assert.match(source.slice(turnRequestFinally, turnCleanupEnd), /clearCurrentAbortControllerIfSame\(turnAbortController\)/, 'the provider finally block must release the queue preparation guard');
const elements = new Map(['codexQueueList', 'codexQueueCount', 'codexQueueStatus', 'composerStatus'].map(id => [id, new Element()]));
const emptyState = new Element('empty');
const composerInput = new Element('input');
const timeline = new Element('main');
timeline.children = [emptyState];
let fetchCalls = 0;
let resolveFetch;
const storedValues = new Map();
const localStorage = { getItem: key => storedValues.get(key) || null, setItem: (key, value) => storedValues.set(key, String(value)) };
const context = {
  document: { hidden: false, listeners: {}, addEventListener(name, listener) { this.listeners[name] = listener; }, getElementById: id => elements.get(id) || null, createElement: tag => new Element(tag) },
  fetch: () => { fetchCalls++; return new Promise(resolve => { resolveFetch = resolve; }); },
  loadSession: async (sessionId, title, source) => {
    assert.equal(sessionId, 'codex_thread-2');
    assert.equal(title, 'Active source');
    assert.equal(source, 'codex');
    context.currentCodexThreadId = 'thread-2';
    timeline.children = [new Element('message')];
    return true;
  },
  console: { warn() {} },
  localStorage,
  composerInput,
  timeline,
  emptyState,
  currentAbortController: null,
  currentCodexThreadId: null,
  codexQueueLoadInFlight: false,
  isRecording: false,
  btnMicrophone: new Element('button'),
  window: { confirm: () => true },
  Event: class Event { constructor(type, options) { this.type = type; this.options = options; } }
};
assert.match(source, /setCodexQueueItemSendState\(codexQueueFingerprint, 'inflight'\)/, 'queue-origin sends are recorded before request dispatch');
vm.runInNewContext(`${source.slice(queueStateStart, queueStateEnd)};`, context);
vm.runInNewContext(`${source.slice(loadStart, end)}; globalThis.getCodexQueueSendFailureNotice = getCodexQueueSendFailureNotice; globalThis.refreshCodexQueueWhenVisible = refreshCodexQueueWhenVisible;`, context);
vm.runInNewContext(`${source.slice(abortCleanupStart, abortCleanupEnd)}; globalThis.clearCurrentAbortControllerIfSame = clearCurrentAbortControllerIfSame;`, context);
vm.runInNewContext(`${source.slice(composerGuardStart, composerGuardEnd)}; globalThis.isCodexQueueComposerProtected = isCodexQueueComposerProtected;`, context);

async function main() {
  assert.equal(context.getCodexQueueSendFailureNotice(false), '', 'ordinary request failures do not claim Codex queue retention');
  assert.match(context.getCodexQueueSendFailureNotice(true), /Only Chat 화면에 남아 있고 원본 Codex 큐도 유지됩니다/);
  assert.equal(context.getCodexQueueSendStateAfterTurn(undefined), 'submitted', 'a normally completed Only Chat turn records the queue item as submitted');
  assert.equal(context.getCodexQueueSendStateAfterTurn('error'), 'uncertain', 'provider/tool errors keep the item locked for state confirmation');
  assert.equal(context.getCodexQueueSendStateAfterTurn('aborted'), 'uncertain', 'an interrupted queue turn is not eligible for duplicate submission');
  const untrustedTitle = '<img src=x onerror=alert(1)>';
  const items = [
    { id: 'queued-archived', threadId: 'thread-1', threadTitle: 'Archived source', threadArchived: true, threadVerified: true, title: untrustedTitle, prompt: 'Archived work' },
    { id: 'queued-unknown', threadId: 'thread-3', threadTitle: 'Codex 대화', threadArchived: false, threadVerified: false, title: 'Unknown source', prompt: 'Unverified work' },
    { id: 'queued-active', threadId: 'thread-2', threadTitle: 'Active source', threadArchived: false, threadVerified: true, title: 'Active work', prompt: 'Do the requested work' },
    { id: 'queued-image', threadId: 'thread-4', threadTitle: 'Image source', threadArchived: false, threadVerified: true, title: 'Image request', prompt: 'Inspect this image. [Image attachment omitted]', hasImageAttachment: true, hasUnsupportedContent: true },
    { id: 'queued-truncated', threadId: 'thread-5', threadTitle: 'Long source', threadArchived: false, threadVerified: true, title: 'Long request', prompt: 'Long request…[Codex request truncated by Only Chat; original remains in Codex]', promptTruncated: true }
  ];
  const first = context.loadCodexQueueInbox();
  const overlapping = context.loadCodexQueueInbox();
  assert.equal(fetchCalls, 1, 'queue refreshes must not overlap');
  resolveFetch({ ok: true, json: async () => ({ available: true, count: 5, items }) });
  await Promise.all([first, overlapping]);
  context.fetch = async () => ({ ok: true, json: async () => ({ available: true, items: [items[2]] }) });
  assert.equal(elements.get('codexQueueCount').textContent, '1', 'the badge must count only verified active items that can be prepared');
  assert.equal(elements.get('codexQueueCount').attributes?.['aria-label'], '실행 준비 가능한 활성 대기 작업 1개 · 전체 5개');
  assert.match(elements.get('codexQueueStatus').textContent, /전체 5개\(보관·출처 미확인·미지원 첨부·잘린 요청 포함\)/);
  const row = elements.get('codexQueueList').children[0];
  const button = row.children[1];
  assert.equal(row.children[0].children[0].textContent, 'Active work', 'active source conversations should be shown before archived ones');
  assert.equal(row.children[0].children[1].textContent, 'Active source');
  const imageRow = elements.get('codexQueueList').children[1];
  assert.equal(imageRow.children[0].children[1].textContent, 'Image source · 첨부 콘텐츠 미지원');
  assert.equal(imageRow.children[1].disabled, true, 'image-only context must not be silently discarded');
  assert.equal(imageRow.children[1].textContent, '첨부 미지원');
  imageRow.children[1].click();
  assert.equal(composerInput.value, '', 'unsupported image tasks must not be prepared');
  const truncatedRow = elements.get('codexQueueList').children[2];
  assert.equal(truncatedRow.children[0].children[1].textContent, 'Long source · 요청 내용 잘림');
  assert.equal(truncatedRow.children[1].disabled, true, 'truncated request bodies must not be prepared');
  assert.equal(truncatedRow.children[1].textContent, '내용 잘림');
  truncatedRow.children[1].click();
  assert.equal(composerInput.value, '', 'a truncated queue prompt must never be silently submitted');
  const unknownRow = elements.get('codexQueueList').children[3];
  assert.equal(unknownRow.children[0].children[1].textContent, 'Codex 대화 · 출처 확인 안 됨');
  assert.equal(unknownRow.children[1].disabled, true, 'unverified source threads must not be prepared for execution');
  unknownRow.children[1].click();
  assert.equal(composerInput.value, '');
  const archivedRow = elements.get('codexQueueList').children[4];
  assert.equal(archivedRow.children[0].children[0].textContent, untrustedTitle, 'queue titles are rendered as text, not HTML');
  assert.equal(archivedRow.children[0].children[1].textContent, 'Archived source · 보관된 대화');
  composerInput.value = 'unsent user draft';
  button.click();
  assert.equal(composerInput.value, 'unsent user draft', 'queue preparation must preserve an existing draft');
  assert.match(elements.get('codexQueueStatus').textContent, /보존했습니다/);

  composerInput.value = '';
  context.isRecording = true;
  const fetchesBeforeRecordingGuard = fetchCalls;
  button.click();
  assert.equal(composerInput.value, '', 'active microphone dictation protects an otherwise empty composer');
  assert.equal(fetchCalls, fetchesBeforeRecordingGuard, 'recording is rejected before queue context or item reads');
  assert.match(elements.get('codexQueueStatus').textContent, /음성 입력.*보존/);
  context.isRecording = false;

  const failedTurnController = {};
  context.currentAbortController = failedTurnController;
  button.click();
  assert.equal(composerInput.value, '', 'an unfinished turn controller protects the composer');
  assert.match(elements.get('codexQueueStatus').textContent, /보존했습니다/);
  context.clearCurrentAbortControllerIfSame(failedTurnController);
  assert.equal(context.currentAbortController, null, 'a settled failed turn releases the queue preparation guard');
  button.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(composerInput.value, 'Do the requested work', 'a blank chat can prepare a preserved queue item after a failed turn settles');
  const replacementController = {};
  context.currentAbortController = replacementController;
  context.clearCurrentAbortControllerIfSame(failedTurnController);
  assert.equal(context.currentAbortController, replacementController, 'settling an older turn must not clear a replacement controller');
  context.currentAbortController = null;

  composerInput.value = '';
  button.click();
  assert.equal(composerInput.readOnly, true, 'composer input is temporarily locked while the source context loads');
  assert.equal(context.btnMicrophone.disabled, true, 'microphone cannot start while importing the source conversation');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(composerInput.readOnly, false, 'composer input returns to its prior state after preparation');
  assert.equal(context.btnMicrophone.disabled, false, 'microphone is restored after source conversation import');
  assert.equal(composerInput.value, 'Do the requested work');
  assert.equal(composerInput.dispatched, true);
  assert.equal(composerInput.focused, true);
  assert.equal(elements.get('composerStatus').textContent, 'Codex 대기열 · Active source · 원본 항목은 유지됩니다. 전송 전 요청을 검토하세요.');
  assert.match(elements.get('codexQueueStatus').textContent, /원본 Codex 대화 맥락을 불러온/);
  composerInput.value = '';
  context.currentCodexThreadId = 'thread-2';
  timeline.children = [new Element('message')];
  button.click();
  assert.equal(composerInput.readOnly, true, 'the matching-thread queue validation temporarily protects the empty composer');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(composerInput.readOnly, false);
  assert.equal(composerInput.value, 'Do the requested work', 'a queue item from the currently resumed Codex thread can be prepared with its imported context');
  assert.match(elements.get('codexQueueStatus').textContent, /원본 Codex 대화 맥락을 불러온/);

  composerInput.value = '';
  let resolveQueueValidation;
  context.fetch = () => new Promise(resolve => { resolveQueueValidation = resolve; });
  button.click();
  assert.equal(context.btnMicrophone.disabled, true, 'microphone cannot start during async queue validation');
  context.isRecording = true;
  composerInput.readOnly = true;
  resolveQueueValidation({ ok: true, json: async () => ({ available: true, items: [items[2]] }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(composerInput.value, '', 'dictation that begins during async validation is never overwritten by a queue prompt');
  assert.equal(composerInput.readOnly, true, 'the composer stays read-only if speech is active when validation ends');
  assert.equal(context.btnMicrophone.disabled, false, 'microphone returns to its prior enabled state after validation');
  assert.match(elements.get('codexQueueStatus').textContent, /음성 입력/);
  context.isRecording = false;
  composerInput.readOnly = false;
  composerInput.value = '';
  context.fetch = async () => ({ ok: true, json: async () => ({ available: true, items: [] }) });
  button.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(composerInput.value, '', 'a stale queue item is not prepared even when its Codex context is already open');
  assert.match(elements.get('codexQueueStatus').textContent, /변경·삭제되었거나 확인할 수 없어/);
  context.fetch = async () => ({ ok: true, json: async () => ({ available: true, items: [items[2]] }) });
  context.currentCodexThreadId = 'different-thread';
  button.click();
  assert.equal(composerInput.value, '', 'a queue item from a different Codex thread must not be added to the current conversation');
  assert.match(elements.get('codexQueueStatus').textContent, /다른 대화를 보존했습니다/);
  composerInput.value = '';
  timeline.children = [emptyState];
  context.currentCodexThreadId = null;
  context.loadSession = async () => {
    context.currentCodexThreadId = 'thread-2';
    timeline.children = [new Element('message')];
    return true;
  };
  context.fetch = async () => ({ ok: true, json: async () => ({ available: true, items: [] }) });
  button.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(composerInput.value, '', 'a queue item removed during context loading must not be prepared');
  assert.match(elements.get('codexQueueStatus').textContent, /변경·삭제되었거나 확인할 수 없어/);
  composerInput.value = '';
  timeline.children = [emptyState];
  context.currentCodexThreadId = null;
  context.loadSession = async () => false;
  button.click();
  assert.equal(composerInput.readOnly, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(composerInput.readOnly, false, 'composer input is restored after context load failure');
  assert.equal(composerInput.value, '', 'a failed Codex context load must not prepare the queued prompt');
  assert.match(elements.get('codexQueueStatus').textContent, /맥락을 열지 못해 요청을 준비하지 않았습니다/);
  assert.equal(archivedRow.children[1].disabled, true, 'archived-origin queue items must not be prepared for execution');
  assert.equal(archivedRow.children[1].textContent, '보관된 대화');
  composerInput.value = 'Do the requested work';
  archivedRow.children[1].click();
  assert.equal(composerInput.value, 'Do the requested work', 'archived queue click must leave the current composer unchanged');
  context.fetch = async () => ({ ok: false, status: 404 });
  await context.loadCodexQueueInbox();
  assert.equal(elements.get('codexQueueCount').textContent, '—', 'an API failure must not look like an empty queue');
  assert.match(elements.get('codexQueueStatus').textContent, /읽지 못했습니다/);
  assert.equal(elements.get('codexQueueList').children.length, 1, 'a failed refresh must remove stale queue actions');
  assert.equal(elements.get('codexQueueList').children[0].textContent, 'Codex 대기열을 읽지 못했습니다.');
  context.fetch = async () => ({ ok: true, json: async () => ({ available: true, count: items.length, items }) });
  await context.loadCodexQueueInbox();
  assert.equal(elements.get('codexQueueCount').textContent, '1', 'a later successful poll restores the actionable count');
  assert.equal(elements.get('codexQueueList').children.length, 5, 'a later successful poll restores the current queue items');
  let visibilityFetches = 0;
  context.fetch = async () => { visibilityFetches++; return { ok: true, json: async () => ({ available: true, items: [] }) }; };
  context.document.hidden = true;
  context.refreshCodexQueueWhenVisible();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(visibilityFetches, 0, 'background visibility events do not cause redundant queue reads');
  context.document.hidden = false;
  context.document.addEventListener('visibilitychange', context.refreshCodexQueueWhenVisible);
  context.document.listeners.visibilitychange();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(visibilityFetches, 1, 'returning to Only Chat immediately refreshes the Codex queue');
  assert.equal(elements.get('codexQueueStatus').textContent, 'Codex 대기 작업이 없습니다.');
  const fingerprint = context.codexQueueItemFingerprint(items[2]);
  context.setCodexQueueItemSendState(fingerprint, 'inflight');
  context.codexQueueInboxItems = [items[2]];
  context.renderCodexQueueInbox([items[2]]);
  assert.equal(elements.get('codexQueueList').children[0].children[1].disabled, true, 'inflight queue work cannot be prepared a second time');
  assert.equal(elements.get('codexQueueList').children[0].children[1].title, '현재 Only Chat에서 이 큐 요청을 처리 중입니다.');
  context.setCodexQueueItemSendState(fingerprint, 'submitted');
  context.renderCodexQueueInbox([items[2]]);
  assert.equal(elements.get('codexQueueList').children[0].children[1].textContent, '다시 준비');
  assert.equal(elements.get('codexQueueList').children[0].children[1].disabled, false, 'a submitted queue item can be retried only through explicit confirmation');
  assert.equal(context.codexQueueItemFingerprint({ ...items[2], prompt: 'Changed queued prompt' }), fingerprint, 'the same queue identity remains subject to retry confirmation even if its payload changes');
  assert.doesNotMatch(storedValues.get('onlychat.codexQueueSendStates.v1'), /Do the requested work/, 'persistent deduplication state contains only hashed queue identity, never prompt text');
  const reloadedElements = new Map(['codexQueueList'].map(id => [id, new Element()]));
  const reloaded = {
    document: { getElementById: id => reloadedElements.get(id) || null, createElement: tag => new Element(tag) },
    localStorage,
    composerInput: new Element('input'),
    timeline: { children: [] },
    emptyState: new Element('empty'),
    currentAbortController: null,
    currentCodexThreadId: null
  };
  vm.runInNewContext(`${source.slice(queueStateStart, queueStateEnd)};`, reloaded);
  vm.runInNewContext(`${source.slice(loadStart, end)};`, reloaded);
  assert.equal(reloaded.getCodexQueueItemSendState(fingerprint), 'submitted', 'send state persists across renderer reloads without storing the prompt text');
  reloaded.renderCodexQueueInbox([items[2]]);
  assert.equal(reloadedElements.get('codexQueueList').children[0].children[1].disabled, false, 'a reloaded renderer preserves the explicit retry affordance');
  assert.equal(reloadedElements.get('codexQueueList').children[0].children[1].textContent, '다시 준비');
  composerInput.value = '';
  timeline.children = [emptyState];
  context.currentCodexThreadId = null;
  context.fetch = async () => ({ ok: true, json: async () => ({ available: true, items: [items[2]] }) });
  context.loadSession = async sessionId => {
    context.currentCodexThreadId = 'thread-2';
    timeline.children = [new Element('message')];
    return sessionId === 'codex_thread-2';
  };
  context.window.confirm = () => false;
  const retryButton = elements.get('codexQueueList').children[0].children[1];
  retryButton.click();
  assert.equal(composerInput.value, '', 'declining retry confirmation leaves the composer unchanged');
  context.window.confirm = () => true;
  retryButton.click();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(composerInput.value, items[2].prompt, `confirmed retry prepares only after reopening and revalidating the source conversation; status=${elements.get('codexQueueStatus').textContent}; savedState=${context.getCodexQueueItemSendState(fingerprint)}`);
  assert.equal(context.getCodexQueueItemSendState(fingerprint), '', 'dedupe state clears only when the confirmed prompt is ready in the composer');
  console.log('Codex queue inbox refresh, safety, and draft-preservation UI passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
