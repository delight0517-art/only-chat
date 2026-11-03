'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/ui/desktop/app.js'), 'utf8');
const start = source.indexOf('async function refreshScheduleList() {');
const end = source.indexOf('\nfunction schedulePayload()', start);
assert.ok(start >= 0 && end > start, 'schedule list/detail functions remain extractable');

const list = {
  items: [],
  replaceChildren(...items) { this.items = items; },
  append(item) { this.items.push(item); }
};
const empty = { hidden: true, textContent: '' };
const pending = [];
const edited = [];
const context = {
  selectedScheduleId: null,
  scheduleListRequestId: 0,
  scheduleDetailRequestId: 0,
  document: {
    getElementById: id => id === 'scheduleList' ? list : empty,
    createElement: tag => ({ tag, children: [], append(...items) { this.children.push(...items); }, addEventListener() {}, setAttribute() {} })
  },
  fetch: () => new Promise(resolve => pending.push(resolve)),
  beginScheduleEdit: schedule => edited.push(schedule),
  scheduleFormStatus() {},
  encodeURIComponent
};
vm.runInNewContext(`let scheduleListRequestId = 0; let scheduleDetailRequestId = 0; let selectedScheduleId = null;\n${source.slice(start, end)}\nglobalThis.refresh = refreshScheduleList; globalThis.load = loadSchedule; globalThis.validSummaries = isValidScheduleSummaries;`, context);

function response(schedules) {
  return { ok: true, json: async () => ({ schedules }) };
}

async function main() {
  assert.equal(context.validSummaries([{ id: 'legacy-weekly', title: 'Legacy value', enabled: true, allowedTools: [], frequency: 'weekly', weekday: '3', localTime: '09:00' }]), true, 'numeric strings accepted by the schedule API remain displayable');
  const stale = context.refresh();
  const latest = context.refresh();
  pending[1](response([{ id: 'new', title: 'Latest schedule', enabled: true, allowedTools: ['read_file'], frequency: 'daily', localTime: '09:00' }]));
  await latest;
  pending[0](response([{ id: 'old', title: 'Stale schedule', enabled: true, allowedTools: ['read_file'], frequency: 'daily', localTime: '09:00' }]));
  await stale;
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].children[0].textContent, 'Latest schedule');
  assert.equal(empty.hidden, true);

  const retainedRows = list.items.slice();
  const failedRefresh = context.refresh();
  pending[2]({ ok: false, json: async () => ({ error: 'private server detail' }) });
  await failedRefresh;
  assert.deepEqual(list.items, retainedRows, 'HTTP error leaves the last valid schedule list visible');
  assert.equal(empty.hidden, false);
  assert.match(empty.textContent, /기존 표시를 유지/);
  assert.doesNotMatch(empty.textContent, /private server detail/);

  const malformedRefresh = context.refresh();
  pending[3](response([{ id: 'bad', title: 'Broken', enabled: true, frequency: 'weekly', localTime: '29:99', weekday: 8 }]));
  await malformedRefresh;
  assert.deepEqual(list.items, retainedRows, 'malformed schedule rows leave the last valid list visible');

  const emptyRefresh = context.refresh();
  pending[4](response([]));
  await emptyRefresh;
  assert.equal(list.items.length, 0, 'a valid empty response clears the previous rows');
  assert.equal(empty.hidden, false);
  assert.equal(empty.textContent, '등록된 반복 일정이 없습니다.');

  const olderDetail = context.load('older');
  const newerDetail = context.load('newer');
  pending[6]({ ok: true, json: async () => ({ schedule: { id: 'newer', title: 'Newer detail', prompt: 'Continue approved work', allowedTools: ['read_file'], enabled: true, frequency: 'daily', localTime: '09:00', nextRunAt: '2026-11-02T00:00:00.000Z', attachments: [], lastStatus: null, lastResult: null } }) });
  while (pending.length < 8) await new Promise(resolve => setImmediate(resolve));
  pending[7](response([{ id: 'newer', title: 'Newer detail', enabled: true, allowedTools: ['read_file'], frequency: 'daily', localTime: '09:00' }]));
  await newerDetail;
  pending[5]({ ok: true, json: async () => ({ schedule: { id: 'older', title: 'Older detail', prompt: 'Continue approved work', allowedTools: ['read_file'], enabled: true, frequency: 'daily', localTime: '09:00', nextRunAt: '2026-11-02T00:00:00.000Z', attachments: [], lastStatus: null, lastResult: null } }) });
  await olderDetail;
  assert.deepEqual(edited.map(schedule => schedule.id), ['newer'], 'stale detail cannot restore an older selected form');
  console.log('recurringScheduleUiRace.test.js: PASS (late stale list response ignored)');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
