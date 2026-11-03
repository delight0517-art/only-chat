'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../src/ui/desktop/app.js'), 'utf8');
const speechStart = source.indexOf('function setSpeechRecording(');
const speechEnd = source.indexOf('\nwindow.onlyChatSpeechError', speechStart);
assert(speechStart >= 0 && speechEnd > speechStart, 'speech draft handlers remain extractable');

const transcriptStart = source.indexOf('function isUsableSpeechTranscript(');
const transcriptEnd = source.indexOf('\n}', transcriptStart) + 2;
assert(transcriptStart >= 0 && transcriptEnd > transcriptStart, 'Whisper transcript validator remains extractable');
const transcriptContext = vm.createContext({});
vm.runInContext(`${source.slice(transcriptStart, transcriptEnd)}\nglobalThis.isUsableSpeechTranscript = isUsableSpeechTranscript;`, transcriptContext);
assert.equal(transcriptContext.isUsableSpeechTranscript('안녕하세요. 회의 내용을 정리해 주세요.'), true);
assert.equal(transcriptContext.isUsableSpeechTranscript('<|de|><|de|>'), false);
assert.equal(transcriptContext.isUsableSpeechTranscript('  '), false);

const transcribeStart = transcriptStart;
const transcribeEnd = source.indexOf('\nfunction setSpeechRecording(', transcribeStart);
assert(transcribeEnd > transcribeStart, 'Whisper transcription handler remains extractable');
const memoAudio = { size: 2048, type: 'audio/webm' };
const memoElements = {
  voiceMemoStatus: { textContent: '' },
  voiceMemoAudio: { src: 'blob:recorded-audio', hidden: false },
  voiceMemoTranscript: { value: '' },
  btnVoiceMemoUse: { disabled: false },
  btnVoiceMemoRetry: { hidden: true }
};
const memoContext = vm.createContext({
  memoAudio,
  document: { getElementById: id => memoElements[id] },
  FileReader: class { readAsDataURL() { this.result = 'data:audio/webm;base64,YWJj'; this.onload(); } },
  fetch: async () => ({ ok: true, json: async () => ({ transcript: '<|de|><|de|> сист', language: 'ko' }) }),
  composerInput: { readOnly: true }
});
vm.runInContext(`let speechTranscriptionRunning = false; let speechTranscribing = false; let pendingSpeechMemoBlob = memoAudio; ${source.slice(transcribeStart, transcribeEnd)} globalThis.runMemoTranscription = transcribeSpeechMemo;`, memoContext);

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
  const button = { classList: { toggle() {} }, setAttribute() {}, title: '' };
  const context = vm.createContext({
    composerInput,
    btnMicrophone: button,
    window: {},
    Event,
    showMorphToast() {}
  });
  vm.runInContext(`
    let isRecording = false;
    let speechDraftPrefix = null;
    let speechDraftSuffix = '';
    let speechTranscribing = false;
    ${source.slice(speechStart, speechEnd)}
  `, context);
  return { context, composerInput, button };
}

const run = async () => {
  await memoContext.runMemoTranscription();
  assert.equal(memoElements.voiceMemoTranscript.value, '<|de|><|de|> сист', 'keep malformed Whisper output available for manual correction');
  assert.equal(memoElements.btnVoiceMemoUse.disabled, true, 'never send malformed model tokens into the analysis draft');
  assert.equal(memoElements.btnVoiceMemoRetry.hidden, false, 'keep retry available for the retained audio');
  assert.match(memoElements.voiceMemoStatus.textContent, /손상된 형식/);
  assert.equal(vm.runInContext('pendingSpeechMemoBlob === memoAudio && !speechTranscribing && !speechTranscriptionRunning', memoContext), true);

  const test = makeHarness('초안 이어쓰기', 2);
  vm.runInContext('setSpeechRecording(true)', test.context);
  assert.equal(test.composerInput.readOnly, true, 'draft edits are frozen while speech owns the insertion range');
  test.context.window.onlyChatSpeechResult('추가 문장');
  assert.equal(test.composerInput.value, '초안 추가 문장 이어쓰기', 'the completed voice memo is inserted at the captured draft selection');
  vm.runInContext('setSpeechRecording(false)', test.context);
  assert.equal(test.composerInput.readOnly, false);
  assert.equal(test.composerInput.value, '초안 추가 문장 이어쓰기');

  const empty = makeHarness('보존할 초안', 6);
  vm.runInContext('setSpeechRecording(true); setSpeechRecording(false)', empty.context);
  assert.equal(empty.composerInput.value, '보존할 초안', 'stopping without a transcript leaves the draft unchanged');
  assert.equal(empty.composerInput.readOnly, false);
  console.log('speechDraftPreservation passed: voice memo insertion preserves surrounding draft and empty dictation');
};

run().catch(error => { console.error(error); process.exitCode = 1; });
