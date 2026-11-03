'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
const start = appSource.indexOf('function isValidScheduleSummaries(schedules) {');
const end = appSource.indexOf('\nasync function loadSchedule(id)', start);
assert.ok(start >= 0 && end > start, 'schedule summary validator remains independently testable');
const app = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
const detailEnd = app.indexOf('\nfunction schedulePayload()', end);
assert.ok(detailEnd > end, 'schedule detail loader and validator remain extractable');
const context = vm.createContext({ Date, Number, Set, Array, String, TextEncoder, encodeURIComponent });
vm.runInContext(`${appSource.slice(start, end)}\n${appSource.slice(end, detailEnd)}\nglobalThis.validDetail = isValidScheduleDetail;`, context);

const valid = {
  id: 'sch_valid', title: 'Daily', enabled: true, allowedTools: ['read_file'], frequency: 'daily', localTime: '09:00',
  prompt: 'Continue the approved TODO', nextRunAt: '2026-11-02T00:00:00.000Z',
  attachments: [{ id: 'att_1', name: 'notes.txt', size: 4, content: 'safe' }],
  lastStatus: 'completed', lastResult: 'done', lastSessionId: null, taskId: null
};
assert.equal(context.validDetail(valid, 'sch_valid'), true, 'valid store-backed detail with embedded attachment content is accepted');
assert.equal(context.validDetail({ ...valid, attachments: [{ id: 'att_ko', name: 'korean.txt', size: 6, content: '한글' }] }, 'sch_valid'), true, 'UTF-8 byte length accepts multibyte attachment text when the stored size matches');
for (const [label, schedule] of [
  ['wrong selected ID', { ...valid, id: 'sch_other' }],
  ['invalid recurring time', { ...valid, localTime: '29:77' }],
  ['invalid next run date', { ...valid, nextRunAt: 'not-a-date' }],
  ['missing prompt', { ...valid, prompt: undefined }],
  ['malformed tool allowlist', { ...valid, allowedTools: ['read file'] }],
  ['missing tool allowlist', { ...valid, allowedTools: undefined }],
  ['malformed attachment list', { ...valid, attachments: {} }],
  ['attachment content too large', { ...valid, attachments: [{ id: 'att_1', name: 'x.txt', size: 1, content: 'x'.repeat(65537) }] }],
  ['malformed run result', { ...valid, lastResult: {} }]
]) assert.equal(context.validDetail(schedule, 'sch_valid'), false, `${label} is rejected before editing`);

assert.match(appSource, /if \(!isValidScheduleDetail\(data\?\.schedule, id\)\) throw new Error/);
console.log('recurringScheduleDetailValidation passed: selected identity and detail contract are checked before editing');

async function rejectsMismatchedDetailWithoutEditingCurrentForm() {
  const edits = [];
  const statuses = [];
  const invalidResponse = {
    ok: true,
    async json() {
      return { schedule: { ...valid, id: 'sch_other' } };
    }
  };
  const loadContext = vm.createContext({
    Date, Number, Set, Array, String, TextEncoder, encodeURIComponent,
    fetch: async () => invalidResponse,
    beginScheduleEdit(schedule) { edits.push(schedule); },
    async refreshScheduleList() {},
    scheduleFormStatus(message, isError) { statuses.push({ message, isError }); }
  });
  vm.runInContext(`let scheduleDetailRequestId = 0;\n${appSource.slice(end, detailEnd)}\nglobalThis.load = loadSchedule;`, loadContext);
  await loadContext.load('sch_valid');
  assert.equal(edits.length, 0, 'malformed detail never replaces the existing form');
  assert.match(statuses.at(-1).message, /형식이 올바르지 않습니다.*기존 입력을 유지/);
  assert.equal(statuses.at(-1).isError, true);
}

rejectsMismatchedDetailWithoutEditingCurrentForm().then(() => console.log('schedule detail rejection preserves the current editor values'));
