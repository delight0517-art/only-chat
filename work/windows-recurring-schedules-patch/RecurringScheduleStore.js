'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');

const SCHEMA_VERSION = 1;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 64 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 128 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.yaml', '.yml', '.xml', '.html', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.sh', '.sql']);
const STATUSES = new Set(['scheduled', 'queued', 'running', 'completed', 'blocked', 'failed', 'interrupted']);

function validateTitle(title) {
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 120 || /[\u0000-\u001f\u007f]/u.test(title)) {
    throw new TypeError('title must be 1–120 printable characters');
  }
  return title.trim();
}

function validatePrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.trim().length > 100_000 || prompt.includes('\0')) {
    throw new TypeError('prompt must be 1–100000 characters');
  }
  return prompt.trim();
}

function assertSafeName(name) {
  if (typeof name !== 'string' || !name || name.length > 180 || name === '.' || name === '..'
      || name.includes('/') || name.includes('\\') || name.includes('\0') || path.basename(name) !== name) {
    throw new TypeError('attachment name must be a plain file name without traversal');
  }
  const extension = path.extname(name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) throw new TypeError('attachment file extension is not allowed');
  return name;
}

function attachmentBytes(value) {
  const bytes = Buffer.isBuffer(value) ? Buffer.from(value)
    : value instanceof Uint8Array ? Buffer.from(value)
      : typeof value === 'string' ? Buffer.from(value, 'utf8') : null;
  if (!bytes) throw new TypeError('attachment content must be UTF-8 text/source bytes');
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new RangeError('attachment exceeds 64 KiB');
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (_) { throw new TypeError('attachment must contain valid UTF-8'); }
  return bytes;
}

function nextOccurrence(schedule, after = new Date()) {
  const now = after instanceof Date ? new Date(after.getTime()) : new Date(after);
  if (!Number.isFinite(now.getTime())) throw new TypeError('after must be a valid date');
  const match = /^(\d{2}):(\d{2})$/.exec(schedule.localTime || '');
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new TypeError('localTime must use HH:mm');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const frequency = schedule.frequency;
  if (!['daily', 'weekly', 'monthly'].includes(frequency)) throw new TypeError('frequency must be daily, weekly, or monthly');
  const candidate = (year, month, day) => new Date(year, month, day, hour, minute, 0, 0);
  if (frequency === 'daily') {
    const result = candidate(now.getFullYear(), now.getMonth(), now.getDate());
    if (result <= now) result.setDate(result.getDate() + 1);
    return result.toISOString();
  }
  if (frequency === 'weekly') {
    const weekday = Number(schedule.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new TypeError('weekday must be 0–6');
    const daysAhead = (weekday - now.getDay() + 7) % 7;
    let result = candidate(now.getFullYear(), now.getMonth(), now.getDate() + daysAhead);
    if (result <= now) result.setDate(result.getDate() + 7);
    return result.toISOString();
  }
  const monthDay = Number(schedule.monthDay);
  if (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 31) throw new TypeError('monthDay must be 1–31');
  let year = now.getFullYear();
  let month = now.getMonth();
  for (let i = 0; i < 24; i++) {
    const lastDay = new Date(year, month + 1, 0).getDate();
    const result = candidate(year, month, Math.min(monthDay, lastDay));
    if (result > now) return result.toISOString();
    month++;
    if (month > 11) { month = 0; year++; }
  }
  throw new Error('could not calculate next monthly occurrence');
}

class RecurringScheduleStore {
  constructor(options = {}) {
    if (!options.dataDir) throw new TypeError('dataDir is required');
    this.dataDir = path.resolve(options.dataDir);
    this.storeDir = path.join(this.dataDir, 'recurring-schedules');
    this.filePath = path.join(this.storeDir, 'index.json');
    this.attachmentDir = path.join(this.storeDir, 'attachments');
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.storeDir, { recursive: true, mode: 0o700 });
    const storeDirStat = fs.lstatSync(this.storeDir);
    if (storeDirStat.isSymbolicLink() || !storeDirStat.isDirectory()) throw new Error('schedule data directory is unsafe');
    fs.chmodSync(this.storeDir, 0o700);
    fs.mkdirSync(this.attachmentDir, { recursive: true, mode: 0o700 });
    const attachmentDirStat = fs.lstatSync(this.attachmentDir);
    if (attachmentDirStat.isSymbolicLink() || !attachmentDirStat.isDirectory()) throw new Error('schedule attachment directory is unsafe');
    fs.chmodSync(this.attachmentDir, 0o700);
    this.schedules = new Map();
    this._load();
  }

  _load() {
    let document;
    try {
      const stat = fs.lstatSync(this.filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('schedule store must be a regular file');
      document = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    }
    catch (error) {
      if (error.code === 'ENOENT') return;
      throw new Error(`Recurring schedule store is unreadable: ${error.message}`);
    }
    if (document.schemaVersion !== SCHEMA_VERSION || !Array.isArray(document.schedules)) throw new Error('Unsupported recurring schedule schema');
    for (const schedule of document.schedules) {
      if (!schedule || typeof schedule.id !== 'string' || !STATUSES.has(schedule.status)) throw new Error('Invalid recurring schedule record');
      if (schedule.status === 'queued' || schedule.status === 'running') {
        schedule.status = 'interrupted';
        schedule.lastStatus = 'interrupted';
        schedule.lastResult = 'Application restarted before the scheduled execution completed.';
        schedule.updatedAt = new Date().toISOString();
      }
      this.schedules.set(schedule.id, schedule);
    }
    if ([...this.schedules.values()].some(item => item.status === 'interrupted')) this._save();
  }

  _save() {
    const temp = path.join(this.storeDir, `.index.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ schemaVersion: SCHEMA_VERSION, schedules: [...this.schedules.values()] }), 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
      // Windows does not allow opening directories as file descriptors. The JSON file
      // itself is flushed before rename; POSIX also flushes the containing directory.
      if (process.platform !== 'win32') {
        try {
          const dirFd = fs.openSync(this.storeDir, 'r');
          try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
        } catch (_) { /* Rename already committed; unsupported directory fsync must not roll back memory. */ }
      }
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temp); } catch (_) {}
      throw error;
    }
  }

  _normalize(input, existing = {}) {
    const frequency = input.frequency ?? existing.frequency;
    const recurrence = { frequency, localTime: input.localTime ?? existing.localTime,
      ...(input.weekday !== undefined || existing.weekday !== undefined ? { weekday: input.weekday ?? existing.weekday } : {}),
      ...(input.monthDay !== undefined || existing.monthDay !== undefined ? { monthDay: input.monthDay ?? existing.monthDay } : {}) };
    const calculatedNextRun = nextOccurrence(recurrence, new Date());
    const nextRunAt = input.nextRunAt ?? calculatedNextRun;
    if (!Number.isFinite(new Date(nextRunAt).getTime())) throw new TypeError('nextRunAt must be a valid date');
    return {
      ...existing,
      title: validateTitle(input.title ?? existing.title),
      prompt: validatePrompt(input.prompt ?? existing.prompt),
      ...recurrence,
      nextRunAt: new Date(nextRunAt).toISOString(),
      enabled: input.enabled === undefined ? (existing.enabled ?? true) : Boolean(input.enabled),
      attachments: existing.attachments || [],
      status: existing.status || 'scheduled',
      lastStatus: existing.lastStatus ?? null,
      lastResult: existing.lastResult ?? null,
      lastSessionId: existing.lastSessionId ?? null,
      taskId: existing.taskId ?? null,
      createdAt: existing.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  create(input = {}) {
    const id = input.id || `sch_${crypto.randomBytes(12).toString('hex')}`;
    if (this.schedules.has(id)) throw new Error('schedule already exists');
    const schedule = this._normalize(input);
    schedule.id = id;
    if (input.attachments !== undefined) schedule.attachments = this._replaceAttachments({ attachments: [] }, input.attachments);
    this.schedules.set(id, schedule);
    try { this._save(); } catch (error) {
      for (const item of schedule.attachments) this._removeAttachmentFile(item.id);
      this.schedules.delete(id); throw error;
    }
    return this.get(id);
  }

  get(id) {
    const schedule = this.schedules.get(id);
    if (!schedule) return null;
    return this._withAttachmentContents(schedule);
  }

  list() { return [...this.schedules.keys()].map(id => this.get(id)); }

  listSummaries() {
    return [...this.schedules.values()].map(schedule => ({
      ...structuredClone(schedule),
      attachments: (schedule.attachments || []).map(({ id, name, size }) => ({ id, name, size }))
    }));
  }

  update(id, patch = {}) {
    const existing = this.schedules.get(id);
    if (!existing) throw new Error('schedule not found');
    const before = structuredClone(existing);
    const updated = this._normalize(patch, existing);
    const removedAttachments = patch.attachments === undefined ? []
      : existing.attachments.filter(item => !patch.attachments.some(value => value?.id === item.id));
    if (patch.attachments !== undefined) updated.attachments = this._replaceAttachments(existing, patch.attachments);
    this.schedules.set(id, updated);
    try { this._save(); } catch (error) {
      this.schedules.set(id, before);
      for (const item of updated.attachments) if (!existing.attachments.some(old => old.id === item.id)) this._removeAttachmentFile(item.id);
      throw error;
    }
    for (const item of removedAttachments) this._removeAttachmentFile(item.id);
    return this.get(id);
  }

  delete(id) {
    const existing = this.schedules.get(id);
    if (!existing) return false;
    this.schedules.delete(id);
    try { this._save(); } catch (error) { this.schedules.set(id, existing); throw error; }
    for (const attachment of existing.attachments || []) this._removeAttachmentFile(attachment.id);
    return true;
  }

  setStatus(id, status, fields = {}) {
    if (!STATUSES.has(status)) throw new TypeError('invalid schedule status');
    const schedule = this.schedules.get(id);
    if (!schedule) throw new Error('schedule not found');
    const before = structuredClone(schedule);
    Object.assign(schedule, {
      status, lastStatus: status,
      ...(fields.lastResult !== undefined ? { lastResult: fields.lastResult } : {}),
      ...(fields.sessionId !== undefined ? { lastSessionId: fields.sessionId } : {}),
      ...(fields.taskId !== undefined ? { taskId: fields.taskId } : {}),
      ...(fields.nextRunAt !== undefined ? { nextRunAt: new Date(fields.nextRunAt).toISOString() } : {}),
      updatedAt: new Date().toISOString()
    });
    try { this._save(); } catch (error) { this.schedules.set(id, before); throw error; }
    return this.get(id);
  }

  addAttachments(id, attachments = []) {
    const current = this.schedules.get(id);
    if (!current) throw new Error('schedule not found');
    return this.update(id, { attachments: [...current.attachments, ...attachments] });
  }

  _replaceAttachments(existing, requested) {
    if (!Array.isArray(requested)) throw new TypeError('attachments must be an array');
    if (requested.length > MAX_ATTACHMENTS) throw new RangeError('at most 5 attachments are allowed');
    const oldById = new Map((existing.attachments || []).map(item => [item.id, item]));
    const seen = new Set();
    let total = 0;
    const staged = [];
    try {
      for (const item of requested) {
        if (item && typeof item.id === 'string' && oldById.has(item.id) && item.content === undefined && item.bytes === undefined) {
          const previous = oldById.get(item.id);
          if (seen.has(previous.id)) throw new TypeError('duplicate attachment');
          seen.add(previous.id); total += previous.size;
          staged.push(previous); continue;
        }
        const name = assertSafeName(item?.name);
        const bytes = attachmentBytes(item.content ?? item.bytes);
        total += bytes.length;
        if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new RangeError('attachments exceed 128 KiB total');
        const id = `att_${crypto.randomBytes(12).toString('hex')}`;
        const target = this._attachmentPath(id);
        const fd = fs.openSync(target, 'wx', 0o600);
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        staged.push({ id, name, size: bytes.length });
      }
      for (const item of requested) {
        if (item?.id && seen.has(item.id)) assertSafeName(oldById.get(item.id).name);
      }
      return staged;
    } catch (error) {
      for (const item of staged) if (!oldById.has(item.id)) this._removeAttachmentFile(item.id);
      throw error;
    }
  }

  _attachmentPath(id) {
    if (typeof id !== 'string' || !/^att_[a-f0-9]{24}$/.test(id)) throw new TypeError('invalid attachment ID');
    return path.join(this.attachmentDir, `${id}.txt`);
  }

  _removeAttachmentFile(id) {
    const file = this._attachmentPath(id);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('attachment file is not a regular file');
      fs.unlinkSync(file);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  _withAttachmentContents(schedule) {
    return { ...structuredClone(schedule), attachments: (schedule.attachments || []).map(item => {
      const file = this._attachmentPath(item.id);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== item.size || stat.size > MAX_ATTACHMENT_BYTES) throw new Error(`attachment is missing or unsafe: ${item.id}`);
      const bytes = fs.readFileSync(file);
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch (_) { throw new Error(`attachment is not valid UTF-8: ${item.id}`); }
      return { ...item, content: bytes.toString('utf8') };
    }) };
  }

  static nextOccurrence(schedule, after) { return nextOccurrence(schedule, after); }
}

module.exports = { RecurringScheduleStore, nextOccurrence, validateTitle, validatePrompt };
