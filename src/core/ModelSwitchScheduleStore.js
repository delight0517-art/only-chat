'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseReasoningEffort } = require('./ReasoningEffort.js');

const SESSION_ID = /^(?:session_\d{10,16}|ses_[a-f0-9]{16})$/;
const MODEL_ID = /^[a-z0-9][a-z0-9._/-]{0,127}$/i;

class ModelSwitchScheduleStore {
  constructor({ dataDir, filePath, clock = () => Date.now() } = {}) {
    this.filePath = filePath || (dataDir ? path.join(dataDir, 'model-switch-schedules.json') : null);
    if (!this.filePath) throw new Error('Model switch schedule storage path is required.');
    this.clock = clock;
    this.state = this._read();
  }

  _read() {
    try {
      const state = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (state?.version !== 1 || !Number.isSafeInteger(state.revision) || !state.schedules || typeof state.schedules !== 'object' || Array.isArray(state.schedules)) {
        throw new Error('Model switch schedule data is invalid.');
      }
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, revision: 0, schedules: {} };
      throw error;
    }
  }

  _write() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(this.state), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(tempPath, this.filePath);
    } finally {
      try { fs.unlinkSync(tempPath); } catch (_) {}
    }
  }

  _sessionId(value) {
    if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new Error('A valid chat session is required.');
    return value;
  }

  get(sessionId) {
    return this.state.schedules[this._sessionId(sessionId)] || null;
  }

  schedule(input) {
    const sessionId = this._sessionId(input?.sessionId);
    const requestId = typeof input.requestId === 'string' && input.requestId.length <= 128 ? input.requestId : '';
    if (!requestId) throw new Error('A schedule request ID is required.');
    const existing = this.get(sessionId);
    if (existing?.requestId === requestId) return existing;

    const currentModel = String(input.currentModel || '').trim().toLowerCase();
    const targetModel = String(input.targetModel || '').trim().toLowerCase();
    const currentEffort = parseReasoningEffort(input.currentEffort);
    const targetEffort = parseReasoningEffort(input.targetEffort);
    const durationMinutes = Number(input.durationMinutes);
    if (!(currentModel === 'auto' || MODEL_ID.test(currentModel)) || !MODEL_ID.test(targetModel) || targetModel === 'auto' ||
        !currentEffort || !targetEffort || !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440) {
      throw new Error('Model, reasoning effort or schedule duration is invalid.');
    }
    const now = this.clock();
    const schedule = {
      id: crypto.randomUUID(), requestId, sessionId,
      currentModel, currentEffort, targetModel, targetEffort,
      createdAt: now, dueAt: now + durationMinutes * 60_000,
      appliedAt: null, state: 'scheduled', reason: null,
      revision: this.state.revision + 1
    };
    this.state.revision = schedule.revision;
    this.state.schedules[sessionId] = schedule;
    this._write();
    return schedule;
  }

  cancel(sessionId, reason = 'manual-change') {
    const schedule = this.get(sessionId);
    if (!schedule || (schedule.state !== 'scheduled' && schedule.state !== 'applied')) return schedule;
    const cancelled = { ...schedule, state: 'cancelled', reason, revision: this.state.revision + 1 };
    this.state.revision = cancelled.revision;
    this.state.schedules[schedule.sessionId] = cancelled;
    this._write();
    return cancelled;
  }

  resolveForRequest(sessionId, { model, effort, targetAvailable }) {
    const schedule = this.get(sessionId);
    if (!schedule || (schedule.state !== 'scheduled' && schedule.state !== 'applied')) return { schedule };
    const currentModel = String(model || '').trim().toLowerCase();
    const currentEffort = parseReasoningEffort(effort);
    if (schedule.state === 'scheduled' && (currentModel !== schedule.currentModel || currentEffort !== schedule.currentEffort)) {
      return { schedule: this.cancel(sessionId, 'manual-change') };
    }
    if (schedule.state === 'applied' && (currentModel !== schedule.targetModel || currentEffort !== schedule.targetEffort)) {
      return { schedule: this.cancel(sessionId, 'manual-change') };
    }
    if (schedule.state === 'scheduled' && this.clock() < schedule.dueAt) return { schedule };
    if (schedule.state === 'scheduled' && !targetAvailable(schedule.targetModel)) {
      const blocked = { ...schedule, state: 'blocked', reason: 'target-unavailable', revision: this.state.revision + 1 };
      this.state.revision = blocked.revision;
      this.state.schedules[sessionId] = blocked;
      this._write();
      return { schedule: blocked, blocked: true };
    }
    if (schedule.state === 'scheduled') {
      const applied = { ...schedule, state: 'applied', appliedAt: this.clock(), revision: this.state.revision + 1 };
      this.state.revision = applied.revision;
      this.state.schedules[sessionId] = applied;
      this._write();
      return { schedule: applied, apply: { model: applied.targetModel, effort: applied.targetEffort } };
    }
    return { schedule, apply: { model: schedule.targetModel, effort: schedule.targetEffort } };
  }

  moveSession(fromSessionId, toSessionId) {
    const from = this._sessionId(fromSessionId);
    const to = this._sessionId(toSessionId);
    if (from === to || !this.state.schedules[from]) return this.get(to);
    if (this.state.schedules[to]) throw new Error('A schedule already exists for the destination session.');
    const moved = { ...this.state.schedules[from], sessionId: to, revision: this.state.revision + 1 };
    delete this.state.schedules[from];
    this.state.schedules[to] = moved;
    this.state.revision = moved.revision;
    this._write();
    return moved;
  }
}

module.exports = { ModelSwitchScheduleStore };
