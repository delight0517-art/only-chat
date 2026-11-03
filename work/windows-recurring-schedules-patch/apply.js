'use strict';
// Applies a narrowly scoped schedule feature overlay to the Windows canonical app_source.
// All expected anchors are checked before any source file is written.
const fs = require('node:fs');
const path = require('node:path');

const bundleDir = __dirname;
const sourceRoot = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(sourceRoot, 'package.json')) || !fs.existsSync(path.join(sourceRoot, 'src/ui/desktop/server.js'))) {
  console.error('Usage: node apply.js <absolute-path-to-canonical-app_source>'); process.exit(2);
}
const read = rel => fs.readFileSync(path.join(sourceRoot, rel), 'utf8');
const planned = new Map();
function matchLineEnding(text, anchor, label) {
  const candidates = [anchor, anchor.replace(/\n/g, '\r\n')];
  const matching = [...new Set(candidates)].filter(candidate => text.split(candidate).length - 1 === 1);
  if (matching.length !== 1) throw new Error(`${label}: expected exactly one anchor, found ${matching.length ? 'multiple' : 'none'}`);
  return matching[0];
}
function preserveLineEndings(text, value) {
  return text.includes('\r\n') ? value.replace(/\r?\n/g, '\r\n') : value;
}
function replaceOnce(rel, anchor, replacement, label) {
  let text = planned.has(rel) ? planned.get(rel) : read(rel);
  const matched = matchLineEnding(text, anchor, label);
  text = text.replace(matched, preserveLineEndings(text, replacement));
  planned.set(rel, text);
}
function appendBefore(rel, anchor, addition, label) {
  let text = planned.has(rel) ? planned.get(rel) : read(rel);
  const matched = matchLineEnding(text, anchor, label);
  const lineEnd = text.includes('\r\n') ? '\r\n' : '\n';
  text = text.replace(matched, `${preserveLineEndings(text, addition)}${lineEnd}${matched}`);
  planned.set(rel, text);
}
function resource(name) { return fs.readFileSync(path.join(bundleDir, name), 'utf8'); }

const server = 'src/ui/desktop/server.js';
const app = 'src/ui/desktop/app.js';
const html = 'src/ui/desktop/index.html';
const css = 'src/ui/desktop/app.css';
const imports = "const { FeatureModuleHub } = require('../../features/FeatureModuleHub.js');";
replaceOnce(server, imports, `${imports}\nconst { RecurringScheduleStore } = require('../../scheduler/RecurringScheduleStore.js');\nconst { WindowsRecurringScheduleService } = require('../../scheduler/WindowsRecurringScheduleService.js');`, 'server imports');
const activeTurnsAnchor = '    this.activeTurns = 0;';
const constructor = `${activeTurnsAnchor}\n    this.engine.dispatcher.canStartTask = () => this.activeTurns === 0;\n    this.scheduleStore = new RecurringScheduleStore({ dataDir: this.dataDir });\n    this.schedulesEnabled = options.enableSchedules ?? !this.isolated;\n    this.scheduleService = new WindowsRecurringScheduleService({\n      store: this.scheduleStore, engine: this.engine,\n      getActiveTurns: () => this.activeTurns + (this.engine.dispatcher.activeWorkers?.size || 0),\n      setActiveTurns: value => { this.activeTurns = value; }\n    });`;
replaceOnce(server, activeTurnsAnchor, constructor, 'schedule service initialization');
const startHook = "        if (this.schedulesEnabled) this.scheduleService.start();\n        resolve({ port: this.port, url });";
replaceOnce(server, '        resolve({ port: this.port, url });', startHook, 'server start hook');
appendBefore(server, "    this.features?.stop().catch(error=>console.error('Feature module stop:',error.message));", '    this.scheduleService?.stop();', 'server stop hook');
const route = `    // Recurring schedules: same-origin local API; bounded JSON and text-only attachments.\n    if (pathname === '/api/schedules' && req.method === 'GET') return this._json(res, 200, { schedules: this.scheduleStore.listSummaries() });\n    const scheduleMatch = /^\\/api\\/schedules\\/([^/]+)(?:\\/(run))?$/.exec(pathname);\n    if (pathname === '/api/schedules' && req.method === 'POST') {\n      if (!allowedOrigins.has(origin)) return this._json(res, 403, { error: 'Only Chat origin required.' });\n      try {\n        const body = await this._readBoundedJson(req, 256 * 1024);\n        const schedule = this.scheduleStore.create(this._normalizeScheduleBody(body));\n        return this._json(res, 201, { ok: true, schedule });\n      } catch (error) { return this._json(res, 400, { error: error.message || '일정을 저장하지 못했습니다.' }); }\n    }\n    if (scheduleMatch) {\n      let scheduleId;\n      try { scheduleId = decodeURIComponent(scheduleMatch[1]); } catch (_) { return this._json(res, 400, { error: '일정 ID가 올바르지 않습니다.' }); }\n      if (scheduleMatch[2] === 'run' && req.method === 'POST') {\n        if (!allowedOrigins.has(origin)) return this._json(res, 403, { error: 'Only Chat origin required.' });\n        try { const result = this.scheduleService.runNow(scheduleId); return this._json(res, result.accepted ? 202 : 409, result); }\n        catch (error) { return this._json(res, 404, { error: error.message || '일정을 실행하지 못했습니다.' }); }\n      }\n      if (!scheduleMatch[2] && req.method === 'GET') {\n        const schedule = this.scheduleStore.get(scheduleId);\n        return schedule ? this._json(res, 200, { schedule }) : this._json(res, 404, { error: '일정을 찾을 수 없습니다.' });\n      }\n      if (!scheduleMatch[2] && req.method === 'PUT') {\n        if (!allowedOrigins.has(origin)) return this._json(res, 403, { error: 'Only Chat origin required.' });\n        try { const body = await this._readBoundedJson(req, 256 * 1024); return this._json(res, 200, { ok: true, schedule: this.scheduleStore.update(scheduleId, this._normalizeScheduleBody(body)) }); }\n        catch (error) { return this._json(res, /not found/.test(error.message) ? 404 : 400, { error: error.message || '일정을 저장하지 못했습니다.' }); }\n      }\n      if (!scheduleMatch[2] && req.method === 'DELETE') {\n        if (!allowedOrigins.has(origin)) return this._json(res, 403, { error: 'Only Chat origin required.' });\n        try { return this._json(res, 200, { ok: this.scheduleStore.delete(scheduleId) }); }\n        catch (error) { return this._json(res, 400, { error: error.message || '일정을 삭제하지 못했습니다.' }); }\n      }\n    }\n\n`;
appendBefore(server, '    // 404 Not Found', route, 'schedule API routes');
const normalizeMethod = `  _normalizeScheduleBody(body) {\n    const input = { ...body };\n    if (Array.isArray(input.attachments)) input.attachments = input.attachments.map(item => {\n      if (item?.contentBase64 === undefined) return item;\n      if (typeof item.contentBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.contentBase64)) throw new Error('첨부 파일 인코딩이 올바르지 않습니다.');\n      const bytes = Buffer.from(item.contentBase64, 'base64');\n      if (bytes.toString('base64') !== item.contentBase64) throw new Error('첨부 파일 인코딩이 올바르지 않습니다.');\n      return { name: item.name, bytes };\n    });\n    return input;\n  }\n\n`;
appendBefore(server, '  _json(res, status, value) {', normalizeMethod, 'bounded schedule normalization');
const readBounded = `  _readBoundedJson(req, limit) {\n    return new Promise((resolve, reject) => {\n      if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return reject(new Error('Content-Type must be application/json.'));\n      const declared = Number(req.headers['content-length'] || 0);\n      if (declared > limit) return reject(new Error('Request body exceeds the allowed size.'));\n      const chunks = []; let size = 0; let done = false;\n      const finish = error => { if (done) return; done = true; clearTimeout(timer); if (error) return reject(error); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (_) { reject(new Error('요청 JSON을 읽지 못했습니다.')); } };\n      const timer = setTimeout(() => finish(new Error('Request body timed out.')), 10000); timer.unref?.();\n      req.on('data', chunk => { size += chunk.length; if (size > limit) return finish(new Error('Request body exceeds the allowed size.')); chunks.push(chunk); });\n      req.on('end', () => finish()); req.on('error', () => finish(new Error('Request body could not be read.')));\n    });\n  }\n\n`;
appendBefore(server, '  _json(res, status, value) {', readBounded, 'bounded schedule body reader');

const appConstAnchor = "const sessionTitleSearch = document.getElementById('sessionTitleSearch');";
replaceOnce(app, appConstAnchor, `${appConstAnchor}\nconst railSchedulesBtn = document.getElementById('railSchedulesBtn');`, 'schedule rail binding');
const historyHandler = `  document.getElementById('railHistoryBtn').addEventListener('click', () => {\n    if (sessionTitleSearch.hidden) btnSidebarSearch.click();\n    sessionTitleSearch.focus();\n  });`;
replaceOnce(app, historyHandler, `${historyHandler}\n  railSchedulesBtn?.addEventListener('click', () => { void openSchedules(); });\n  document.getElementById('btnCloseSchedules')?.addEventListener('click', closeSchedules);\n  document.getElementById('scheduleModal')?.addEventListener('click', event => { if (event.target.id === 'scheduleModal') closeSchedules(); });\n  document.getElementById('btnNewSchedule')?.addEventListener('click', () => beginScheduleEdit());\n  document.getElementById('btnRefreshSchedules')?.addEventListener('click', () => { void refreshScheduleList(); });\n  document.getElementById('scheduleFrequency')?.addEventListener('change', renderScheduleRecurrenceFields);\n  document.getElementById('btnScheduleAddFiles')?.addEventListener('click', () => document.getElementById('scheduleFiles')?.click());\n  document.getElementById('scheduleFiles')?.addEventListener('change', event => { void addScheduleFiles(event.currentTarget.files); event.currentTarget.value = ''; });\n  document.getElementById('scheduleForm')?.addEventListener('submit', event => { event.preventDefault(); void saveSchedule(); });\n  document.getElementById('btnDeleteSchedule')?.addEventListener('click', () => { void deleteSchedule(); });\n  document.getElementById('btnRunSchedule')?.addEventListener('click', () => { void runScheduleNow(); });`, 'schedule event handlers');
appendBefore(app, '// Load Priority Tiers into Settings > Models Stage', resource('schedule-ui.js'), 'schedule UI functions');
const railAnchor = '        <!-- Mentions / Assistant -->';
const railButton = `        <button class="rail-item" id="railSchedulesBtn" title="반복 스케줄 관리" aria-label="반복 스케줄 관리">\n          <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18M8 14h3m-3 4h8"/></svg>\n        </button>\n`;
replaceOnce(html, railAnchor, railButton + railAnchor, 'schedule rail button');
appendBefore(html, '</body>', resource('schedule-modal.html'), 'schedule manager modal');
const currentCss = read(css);
if (currentCss.includes('.schedule-manager-card {')) throw new Error('schedule styles already exist; refusing duplicate patch');
planned.set(css, currentCss + '\n\n' + resource('schedule-ui.css'));

const moduleFiles = [
  ['src/scheduler/RecurringScheduleStore.js', resource('RecurringScheduleStore.js')],
  ['src/scheduler/WindowsRecurringScheduleService.js', resource('WindowsRecurringScheduleService.js')]
];
for (const [rel] of moduleFiles) if (fs.existsSync(path.join(sourceRoot, rel))) throw new Error(`${rel} already exists; inspect the current Windows implementation before merging.`);
for (const [rel, text] of planned) fs.writeFileSync(path.join(sourceRoot, rel), text, 'utf8');
for (const [rel, text] of moduleFiles) { fs.mkdirSync(path.dirname(path.join(sourceRoot, rel)), { recursive: true }); fs.writeFileSync(path.join(sourceRoot, rel), text, 'utf8'); }
console.log(JSON.stringify({ ok: true, files: [...planned.keys(), ...moduleFiles.map(([rel]) => rel)], target: sourceRoot }, null, 2));
