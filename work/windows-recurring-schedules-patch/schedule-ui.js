let selectedScheduleId = null;
let retainedScheduleAttachments = [];
let addedScheduleAttachments = [];
const SCHEDULE_ATTACHMENT_BYTES = 64 * 1024;
const SCHEDULE_TOTAL_ATTACHMENT_BYTES = 128 * 1024;
const SCHEDULE_ALLOWED_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.yaml', '.yml', '.xml', '.html', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.sh', '.sql']);

function closeSchedules() {
  const modal = document.getElementById('scheduleModal');
  if (modal) modal.style.display = 'none';
  railSchedulesBtn?.classList.remove('active');
}

async function openSchedules() {
  const modal = document.getElementById('scheduleModal');
  if (!modal) return;
  modal.style.display = 'flex';
  railSchedulesBtn?.classList.add('active');
  beginScheduleEdit();
  await refreshScheduleList();
}

function scheduleFormStatus(message, isError = false) {
  const target = document.getElementById('scheduleFormStatus');
  if (!target) return;
  target.textContent = message;
  target.dataset.error = String(isError);
}

function beginScheduleEdit(schedule = null) {
  const form = document.getElementById('scheduleForm');
  if (!form) return;
  form.reset();
  selectedScheduleId = schedule?.id || null;
  retainedScheduleAttachments = (schedule?.attachments || []).map(({ id, name, size }) => ({ id, name, size }));
  addedScheduleAttachments = [];
  document.getElementById('scheduleId').value = selectedScheduleId || '';
  document.getElementById('scheduleTitle').value = schedule?.title || '';
  document.getElementById('schedulePrompt').value = schedule?.prompt || '';
  document.getElementById('scheduleFrequency').value = schedule?.frequency || 'monthly';
  document.getElementById('scheduleMonthDay').value = String(schedule?.monthDay || 1);
  document.getElementById('scheduleWeekday').value = String(schedule?.weekday ?? 1);
  document.getElementById('scheduleLocalTime').value = schedule?.localTime || '09:00';
  document.getElementById('scheduleEnabled').checked = schedule?.enabled !== false;
  document.getElementById('btnDeleteSchedule').hidden = !selectedScheduleId;
  document.getElementById('btnRunSchedule').hidden = !selectedScheduleId;
  renderScheduleRecurrenceFields();
  renderScheduleAttachments();
  renderScheduleLastRun(schedule);
  scheduleFormStatus(schedule ? '수정 중' : '새 반복 일정을 입력하세요.');
}

function renderScheduleRecurrenceFields() {
  const frequency = document.getElementById('scheduleFrequency')?.value;
  document.getElementById('scheduleMonthDayWrap').hidden = frequency !== 'monthly';
  document.getElementById('scheduleWeekdayWrap').hidden = frequency !== 'weekly';
}

function renderScheduleLastRun(schedule) {
  const target = document.getElementById('scheduleLastRun');
  if (!target) return;
  if (!schedule) { target.textContent = '마지막 실행 기록 없음'; return; }
  const next = schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : '미정';
  const status = schedule.lastStatus || schedule.status || 'scheduled';
  const result = schedule.lastResult ? `\n${String(schedule.lastResult).slice(0, 800)}` : '';
  target.textContent = `상태: ${status} · 다음 실행: ${next}${result}`;
}

function renderScheduleAttachments() {
  const container = document.getElementById('scheduleAttachments');
  if (!container) return;
  container.replaceChildren();
  const items = [...retainedScheduleAttachments.map(item => ({ ...item, existing: true })), ...addedScheduleAttachments];
  for (const item of items) {
    const chip = document.createElement('span');
    chip.className = 'schedule-attachment-chip';
    const label = document.createElement('span');
    label.textContent = `${item.name} · ${formatBytes(item.size || item.bytes || 0)}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', `${item.name} 첨부 제거`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      if (item.existing) retainedScheduleAttachments = retainedScheduleAttachments.filter(value => value.id !== item.id);
      else addedScheduleAttachments = addedScheduleAttachments.filter(value => value !== item);
      renderScheduleAttachments();
    });
    chip.append(label, remove);
    container.append(chip);
  }
}

function formatBytes(value) {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`;
}

function encodeBase64(bytes) {
  let binary = '';
  const chunk = 0x4000;
  for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  return btoa(binary);
}

async function addScheduleFiles(fileList) {
  const files = [...(fileList || [])];
  for (const file of files) {
    const extension = `.${file.name.split('.').pop()}`.toLowerCase();
    if (!SCHEDULE_ALLOWED_EXTENSIONS.has(extension)) { scheduleFormStatus(`${file.name}: 허용되지 않는 텍스트/소스 파일 형식입니다.`, true); continue; }
    if (file.size > SCHEDULE_ATTACHMENT_BYTES) { scheduleFormStatus(`${file.name}: 파일은 64 KiB 이하여야 합니다.`, true); continue; }
    if (retainedScheduleAttachments.length + addedScheduleAttachments.length >= 5) { scheduleFormStatus('첨부 파일은 최대 5개까지 등록할 수 있습니다.', true); break; }
    const total = [...retainedScheduleAttachments.map(item => item.size), ...addedScheduleAttachments.map(item => item.size)].reduce((sum, size) => sum + size, 0);
    if (total + file.size > SCHEDULE_TOTAL_ATTACHMENT_BYTES) { scheduleFormStatus('첨부 파일 합계는 128 KiB 이하여야 합니다.', true); continue; }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      addedScheduleAttachments.push({ name: file.name, size: bytes.length, contentBase64: encodeBase64(bytes) });
      scheduleFormStatus(`${file.name} 첨부 준비 완료`);
    } catch (error) { scheduleFormStatus(`${file.name}을 읽지 못했습니다: ${error.message}`, true); }
  }
  renderScheduleAttachments();
}

async function refreshScheduleList() {
  const list = document.getElementById('scheduleList');
  const empty = document.getElementById('scheduleListEmpty');
  if (!list) return;
  list.replaceChildren();
  try {
    const response = await fetch('/api/schedules');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '목록을 읽지 못했습니다.');
    const schedules = Array.isArray(data.schedules) ? data.schedules : [];
    if (empty) empty.hidden = schedules.length > 0;
    for (const schedule of schedules) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `schedule-list-item${schedule.id === selectedScheduleId ? ' selected' : ''}`;
      button.setAttribute('role', 'listitem');
      const title = document.createElement('strong'); title.textContent = schedule.title;
      const detail = document.createElement('small'); detail.textContent = `${schedule.enabled ? '사용 중' : '꺼짐'} · ${schedule.frequency === 'monthly' ? `매월 ${schedule.monthDay}일` : schedule.frequency === 'weekly' ? `매주 ${['일','월','화','수','목','금','토'][schedule.weekday]}요일` : '매일'} ${schedule.localTime}`;
      button.append(title, detail);
      button.addEventListener('click', () => { void loadSchedule(schedule.id); });
      list.append(button);
    }
  } catch (error) {
    if (empty) { empty.hidden = false; empty.textContent = `스케줄 목록 오류: ${error.message}`; }
  }
}

async function loadSchedule(id) {
  try {
    const response = await fetch(`/api/schedules/${encodeURIComponent(id)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '일정을 읽지 못했습니다.');
    beginScheduleEdit(data.schedule);
    await refreshScheduleList();
  } catch (error) { scheduleFormStatus(error.message, true); }
}

function schedulePayload() {
  const payload = {
    title: document.getElementById('scheduleTitle').value,
    prompt: document.getElementById('schedulePrompt').value,
    frequency: document.getElementById('scheduleFrequency').value,
    localTime: document.getElementById('scheduleLocalTime').value,
    enabled: document.getElementById('scheduleEnabled').checked,
    attachments: [...retainedScheduleAttachments.map(({ id }) => ({ id })), ...addedScheduleAttachments.map(({ name, contentBase64 }) => ({ name, contentBase64 }))]
  };
  if (payload.frequency === 'monthly') payload.monthDay = Number(document.getElementById('scheduleMonthDay').value);
  if (payload.frequency === 'weekly') payload.weekday = Number(document.getElementById('scheduleWeekday').value);
  return payload;
}

async function saveSchedule() {
  const id = selectedScheduleId;
  const url = id ? `/api/schedules/${encodeURIComponent(id)}` : '/api/schedules';
  try {
    const response = await fetch(url, { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(schedulePayload()) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '저장하지 못했습니다.');
    beginScheduleEdit(data.schedule);
    await refreshScheduleList();
    scheduleFormStatus('스케줄을 저장했습니다.');
  } catch (error) { scheduleFormStatus(error.message, true); }
}

async function deleteSchedule() {
  if (!selectedScheduleId || !window.confirm('이 반복 스케줄과 첨부 파일을 삭제할까요?')) return;
  try {
    const response = await fetch(`/api/schedules/${encodeURIComponent(selectedScheduleId)}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '삭제하지 못했습니다.');
    beginScheduleEdit();
    await refreshScheduleList();
    scheduleFormStatus('스케줄과 첨부 파일을 삭제했습니다.');
  } catch (error) { scheduleFormStatus(error.message, true); }
}

async function runScheduleNow() {
  if (!selectedScheduleId) return;
  try {
    const response = await fetch(`/api/schedules/${encodeURIComponent(selectedScheduleId)}/run`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok || !data.accepted) throw new Error(data.reason || data.error || '이미 실행 중이거나 예약이 대기 중입니다.');
    scheduleFormStatus('작업을 실행 대기열에 넣었습니다. 완료와 승인 필요 여부는 마지막 실행 기록에 표시됩니다.');
    window.setTimeout(() => { void loadSchedule(selectedScheduleId); }, 1200);
  } catch (error) { scheduleFormStatus(error.message, true); }
}
