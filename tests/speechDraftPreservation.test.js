'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../src/ui/desktop/app.js'), 'utf8');
const stopStart = source.indexOf('function stopRecording() {');
const stopEnd = source.indexOf('\nfunction setSpeechRecording(', stopStart);
const speechStart = stopEnd + 1;
const speechEnd = source.indexOf('\nwindow.onlyChatSpeechError', speechStart);
assert(stopStart >= 0 && stopEnd > stopStart && speechEnd > speechStart, 'speech draft handlers remain extractable');

function makeHarness(value, selectionStart) {
  const composerInput = {
    value,
    selectionStart,
    selectionEnd: selectionStart,
    readOnly: false,
    placeholder: 'Work with Only Chat...',
    events: [],
    dispatchEvent(event) { this.events.push(event.type); },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  };
  const button = { classList: { toggle() {} }, title: '' };
  const context = vm.createContext({
    composerInput,
    btnMicrophone: button,
    window: {},
    Event,
    showMorphToast() {}
  });
  vm.runInContext(`
    let isRecording = false;
    let speechRecognition = null;
    let speechDraftPrefix = null;
    let speechDraftSuffix = '';
    ${source.slice(stopStart, stopEnd)}
    ${source.slice(speechStart, speechEnd)}
    globalThis.stopSpeechRecording = stopRecording;
    globalThis.setSpeechRecording = setSpeechRecording;
  `, context);
  return { context, composerInput, button };
}

const run = async () => {
  const test = makeHarness('초안 이어쓰기', 2);
  vm.runInContext('setSpeechRecording(true)', test.context);
  assert.equal(test.composerInput.readOnly, true, 'draft edits are frozen while speech owns the insertion range');
  test.context.window.onlyChatSpeechResult('추가');
  assert.equal(test.composerInput.value, '초안 추가 이어쓰기');
  test.context.window.onlyChatSpeechResult('추가 문장');
  assert.equal(test.composerInput.value, '초안 추가 문장 이어쓰기', 'cumulative partial results replace the prior dictated segment');

  let stopped = false;
  vm.runInContext('speechRecognition = { stop() { globalThis.stopWasCalled = true; } }', test.context);
  test.context.stopSpeechRecording();
  assert.equal(test.context.stopWasCalled, true);
  assert.equal(test.composerInput.readOnly, true, 'browser stop keeps the insertion snapshot until the final result callback');
  test.context.window.onlyChatSpeechResult('최종 문장');
  assert.equal(test.composerInput.value, '초안 최종 문장 이어쓰기', 'the final stop result replaces partial text without losing the draft');
  vm.runInContext('setSpeechRecording(false)', test.context);
  assert.equal(test.composerInput.readOnly, false);
  assert.equal(test.composerInput.value, '초안 최종 문장 이어쓰기');

  const empty = makeHarness('보존할 초안', 6);
  vm.runInContext('setSpeechRecording(true); setSpeechRecording(false)', empty.context);
  assert.equal(empty.composerInput.value, '보존할 초안', 'stopping without a transcript leaves the draft unchanged');
  assert.equal(empty.composerInput.readOnly, false);
  console.log('speechDraftPreservation passed: existing text, cumulative results, final stop result, and empty dictation');
};

run().catch(error => { console.error(error); process.exitCode = 1; });
