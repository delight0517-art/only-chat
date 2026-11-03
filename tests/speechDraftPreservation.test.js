'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../src/ui/desktop/app.js'), 'utf8');
const markup = fs.readFileSync(require.resolve('../src/ui/desktop/index.html'), 'utf8');
assert.doesNotMatch(markup, /id="voiceMemoDialog"/, 'voice capture no longer opens a separate dialog');
assert.match(markup, /id="voiceWaveform"/, 'composer includes the inline waveform');
const speechStart = source.indexOf('function setSpeechRecording(');
const speechEnd = source.indexOf('\nfunction startSpeechWaveform', speechStart);
assert(speechStart >= 0 && speechEnd > speechStart, 'speech draft handlers remain extractable');

const transcriptStart = source.indexOf('function isUsableSpeechTranscript(');
const transcriptEnd = source.indexOf('\n}', transcriptStart) + 2;
assert(transcriptStart >= 0 && transcriptEnd > transcriptStart, 'Whisper transcript validator remains extractable');
const transcriptContext = vm.createContext({});
vm.runInContext(`${source.slice(transcriptStart, transcriptEnd)}\nglobalThis.isUsableSpeechTranscript = isUsableSpeechTranscript;`, transcriptContext);
assert.equal(transcriptContext.isUsableSpeechTranscript('안녕하세요. 회의 내용을 정리해 주세요.'), true);
assert.equal(transcriptContext.isUsableSpeechTranscript('<|de|><|de|>'), false);
assert.equal(transcriptContext.isUsableSpeechTranscript('  '), false);

const enterStart = source.indexOf('function handleComposerKeydown(');
const enterEnd = source.indexOf('\n}', enterStart) + 2;
assert(enterEnd > enterStart, 'composer Enter handler remains extractable');
const enterContext = vm.createContext({});
vm.runInContext(`let isRecording = true; let speechTranscribing = false; let isGenerating = false; let stopCount = 0; let sendCount = 0; function stopSpeechMemo() { stopCount++; } function handleSend() { sendCount++; } ${source.slice(enterStart, enterEnd)} globalThis.pressComposerKey = handleComposerKeydown;`, enterContext);
const pressEnter = options => {
  let prevented = false;
  enterContext.pressComposerKey({ key: 'Enter', shiftKey: false, ...options, preventDefault() { prevented = true; } });
  return prevented;
};
assert.equal(pressEnter(), true);
assert.equal(vm.runInContext('stopCount', enterContext), 1, 'Enter ends an active voice capture');
assert.equal(vm.runInContext('sendCount', enterContext), 0, 'Enter waits for transcription while recording');
vm.runInContext('isRecording = false; speechTranscribing = true', enterContext);
assert.equal(pressEnter(), true);
assert.equal(vm.runInContext('sendCount', enterContext), 0, 'Enter cannot send an unfinished transcription');
vm.runInContext('speechTranscribing = false', enterContext);
assert.equal(pressEnter(), true);
assert.equal(vm.runInContext('sendCount', enterContext), 1, 'normal Enter still sends typed text');
assert.equal(pressEnter({ shiftKey: true }), false, 'Shift+Enter keeps the normal multiline behavior');

const transcribeStart = transcriptStart;
const transcribeEnd = source.indexOf('\nfunction setSpeechRecording(', transcribeStart);
assert(transcribeEnd > transcribeStart, 'Whisper transcription handler remains extractable');
const memoAudio = { size: 2048, type: 'audio/webm' };
const applyStart = source.indexOf('function applySpeechTranscript(');
const applyEnd = source.indexOf('\n}', applyStart) + 2;
assert(applyEnd > applyStart, 'transcript insertion helper remains extractable');

function makeTranscriptionHarness(result) {
  let sentMessage = null;
  const elements = { voiceCaptureStatus: { textContent: '', hidden: false }, btnVoiceRetry: { hidden: true } };
  const composerInput = {
    value: '', readOnly: true, selectionStart: 0, selectionEnd: 0,
    dispatchEvent() {}, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  };
  const context = vm.createContext({
    memoAudio,
    Event,
    composerInput,
    document: { getElementById: id => elements[id] },
    FileReader: class { readAsDataURL() { this.result = 'data:audio/webm;base64,YWJj'; this.onload(); } },
    fetch: async () => ({ ok: true, json: async () => result }),
    updateVoiceCaptureUI() {}
  });
  context.handleSend = async () => { sentMessage = composerInput.value; };
  vm.runInContext(`let speechTranscriptionRunning = false; let speechTranscribing = false; let isGenerating = false; let pendingSpeechMemoBlob = memoAudio; let speechDraftPrefix = ''; let speechDraftSuffix = ''; ${source.slice(transcribeStart, transcribeEnd)} ${source.slice(applyStart, applyEnd)} globalThis.runMemoTranscription = transcribeSpeechMemo;`, context);
  return { context, composerInput, elements, getSentMessage: () => sentMessage };
}

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
  const elements = { voiceMicIcon: { hidden: false }, voiceCaptureIndicator: { hidden: true } };
  const context = vm.createContext({
    composerInput,
    btnMicrophone: button,
    document: { getElementById: id => elements[id] },
    window: {},
    Event,
    showMorphToast() {}
  });
  vm.runInContext(`
    let isRecording = false;
    let speechDraftPrefix = null;
    let speechDraftSuffix = '';
    let speechTranscribing = false;
    let speechStarting = false;
    let speechAudioContext = null;
    let speechAnalyser = null;
    let speechAnimationFrame = null;
    ${source.slice(speechStart, speechEnd)}
    ${source.slice(applyStart, applyEnd)}
    globalThis.setSpeechRecording = setSpeechRecording;
    globalThis.applySpeechTranscript = applySpeechTranscript;
  `, context);
  return { context, composerInput, button };
}

const run = async () => {
  const malformed = makeTranscriptionHarness({ transcript: '<|de|><|de|> сист', language: 'ko' });
  await malformed.context.runMemoTranscription(memoAudio, true);
  assert.equal(malformed.composerInput.value, '', 'malformed transcript is not inserted');
  assert.equal(malformed.getSentMessage(), null, 'malformed transcript is never auto-sent');
  assert.equal(malformed.elements.btnVoiceRetry.hidden, false, 'keep retry available for the retained audio');
  assert.match(malformed.elements.voiceCaptureStatus.textContent, /읽을 수 없습니다/);
  assert.equal(vm.runInContext('pendingSpeechMemoBlob === memoAudio && !speechTranscribing && !speechTranscriptionRunning', malformed.context), true);

  const valid = makeTranscriptionHarness({ transcript: '회의 일정을 내일로 바꿔 주세요.', language: 'ko' });
  await valid.context.runMemoTranscription(memoAudio, true);
  assert.equal(valid.composerInput.value, '회의 일정을 내일로 바꿔 주세요.');
  assert.equal(valid.getSentMessage(), '회의 일정을 내일로 바꿔 주세요.', 'valid voice text is inserted and sent automatically');
  assert.equal(vm.runInContext('pendingSpeechMemoBlob === null', valid.context), true);

  const test = makeHarness('초안 이어쓰기', 2);
  vm.runInContext('setSpeechRecording(true)', test.context);
  assert.equal(test.composerInput.readOnly, true, 'draft edits are frozen while speech owns the insertion range');
  test.context.applySpeechTranscript('추가 문장');
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
