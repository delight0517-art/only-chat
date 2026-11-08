/**
 * @project My-Codex
 * @provenance:rogan-core
 * @author Rogan Kim (GeunHu Kim) & AI Architect
 * @license MIT
 * @description Local session, thread, and turn history persistence engine in JSONL format.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

class SessionStore {
  static SESSION_ID = /^ses_[a-f0-9]{16}$/;
  static MAX_SESSION_HEADER_BYTES = 1024 * 1024;
  constructor(options = {}) {
    this.storageDir = options.storageDir || path.join(options.dataDir || path.join(os.homedir(), '.my-codex'), 'sessions');
    this._ensureDir();
  }

  _ensureDir() {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o700 });
    }
    const stat = fs.lstatSync(this.storageDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Session storage directory must be a regular directory.');
  }

  _openSessionFile(sessionId, flags, strict = false) {
    const sessionFile = path.join(this.storageDir, `${sessionId}.jsonl`);
    let before;
    try { before = fs.lstatSync(sessionFile); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (before.isSymbolicLink() || !before.isFile()) {
      if (strict) throw new Error('Unsafe internal session file.');
      return null;
    }
    let fd;
    try {
      fd = fs.openSync(sessionFile, flags | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error('Internal session file changed while opening.');
      }
      const header = Buffer.alloc(Math.min(Math.max(1, opened.size), SessionStore.MAX_SESSION_HEADER_BYTES));
      const headerBytes = fs.readSync(fd, header, 0, header.length, 0);
      const newline = header.indexOf(0x0a, 0);
      const headerEnd = newline === -1 ? headerBytes : newline;
      let initialRecord;
      try { initialRecord = JSON.parse(header.subarray(0, headerEnd).toString('utf8')); }
      catch (_) { initialRecord = null; }
      if ((newline === -1 && opened.size >= SessionStore.MAX_SESSION_HEADER_BYTES)
        || initialRecord?.type !== 'session_init' || initialRecord.sessionId !== sessionId) {
        const error = new Error('Internal session header does not match its filename.');
        error.code = 'INVALID_SESSION_HEADER';
        throw error;
      }
      return fd;
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      if (!strict && ['ELOOP', 'INVALID_SESSION_HEADER'].includes(error.code)) return null;
      throw error;
    }
  }

  createSession(metadata = {}) {
    const sessionId = `ses_${crypto.randomBytes(8).toString('hex')}`;
    const sessionFile = path.join(this.storageDir, `${sessionId}.jsonl`);
    const initialRecord = {
      type: 'session_init',
      sessionId,
      createdAt: Date.now(),
      workspaceDir: metadata.workspaceDir || process.cwd(),
      model: metadata.model || 'gemini-3.8-flash-medium',
      provider: metadata.provider || 'antigravity-cli',
      metadata
    };
    const fd = fs.openSync(sessionFile, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(initialRecord) + '\n', 'utf8'); }
    finally { fs.closeSync(fd); }
    return { sessionId, sessionFile, metadata: initialRecord };
  }

  appendItem(sessionId, item) {
    if (typeof sessionId !== 'string' || !SessionStore.SESSION_ID.test(sessionId)) {
      throw new Error('Invalid session ID.');
    }
    const fd = this._openSessionFile(sessionId, fs.constants.O_RDWR | fs.constants.O_APPEND, true);
    if (fd === null) {
      throw new Error(`Session ${sessionId} not found.`);
    }
    const record = {
      ...item,
      timestamp: Date.now()
    };
    try { fs.writeFileSync(fd, JSON.stringify(record) + '\n', 'utf8'); }
    finally { fs.closeSync(fd); }
    return record;
  }

  readSession(sessionId) {
    if (typeof sessionId !== 'string' || !SessionStore.SESSION_ID.test(sessionId)) return null;
    const fd = this._openSessionFile(sessionId, fs.constants.O_RDONLY);
    if (fd === null) return null;
    let content;
    try { content = fs.readFileSync(fd, 'utf8'); }
    finally { fs.closeSync(fd); }
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.map(line => {
      try { return JSON.parse(line); } catch (_) { return null; }
    }).filter(Boolean);
  }

  listSessions() {
    this._ensureDir();
    const files = fs.readdirSync(this.storageDir).filter(file =>
      file.endsWith('.jsonl') && SessionStore.SESSION_ID.test(file.slice(0, -'.jsonl'.length)));
    const sessions = [];
    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');
      try {
        const fd = this._openSessionFile(sessionId, fs.constants.O_RDONLY);
        if (fd === null) continue;
        let fileContent;
        try { fileContent = fs.readFileSync(fd, 'utf8'); }
        finally { fs.closeSync(fd); }
        const firstLine = fileContent.split('\n')[0];
        if (firstLine) {
          const init = JSON.parse(firstLine);
          const events = fileContent.split('\n').slice(1).filter(Boolean).flatMap(line => {
            try { const event = JSON.parse(line); return event.type === 'session_metadata' ? [event] : []; } catch (_) { return []; }
          });
          const metadata = events.reduce((value, event) => ({ ...value, ...event.metadata }), {});
          sessions.push({
            id: sessionId,
            sessionId,
            source: 'internal',
            createdAt: init.createdAt,
            workspaceDir: init.workspaceDir,
            model: init.model,
            provider: init.provider,
            title: metadata.title || init.metadata?.title || 'Only Chat 세션',
            resumedFrom: metadata.resumedFrom || init.metadata?.resumedFrom || null,
            externalSessionId: metadata.externalSessionId || init.metadata?.externalSessionId || null,
            pinned: metadata.pinned === true,
            section: metadata.section || 'recents',
            archived: metadata.archived === true
          });
        }
      } catch (_) {}
    }
    return sessions.sort((a, b) => b.createdAt - a.createdAt);
  }

  async storageReport(options = {}) {
    const days = Number.isInteger(options.days) && options.days >= 1 && options.days <= 90 ? options.days : 7;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const sessions = new Map();
    const types = new Map();
    let totalBytes = 0;
    let recentBytes = 0;
    let records = 0;
    let malformedBytes = 0;
    let oversizedBytes = 0;
    let incomplete = false;
    for (const file of fs.readdirSync(this.storageDir, { withFileTypes: true })) {
      if (!/^ses_[a-f0-9]{16}\.jsonl$/.test(file.name)) continue;
      const sessionId = file.name.slice(0, -6);
      const session = { sessionId, title: 'Only Chat 세션', bytes: 0, records: 0, recentBytes: 0, recentRecords: 0, types: new Map() };
      let fd;
      try { fd = this._openSessionFile(sessionId, fs.constants.O_RDONLY); }
      catch (_) { incomplete = true; continue; }
      if (fd === null) {
        if (file.isSymbolicLink()) incomplete = true;
        continue;
      }
      let fileStat;
      try { fileStat = fs.fstatSync(fd); }
      catch (error) { fs.closeSync(fd); throw error; }
      const fileBytes = fileStat.size;
      totalBytes += fileBytes;
      session.bytes = fileBytes;
      let pending = Buffer.alloc(0);
      let pendingBytes = 0;
      let oversized = false;
      const addLineBytes = bytes => {
        pendingBytes += bytes.length;
        if (!oversized && pendingBytes <= 4 * 1024 * 1024) pending = pending.length ? Buffer.concat([pending, bytes]) : Buffer.from(bytes);
        else { oversized = true; pending = Buffer.alloc(0); }
      };
      const resetLine = () => { pending = Buffer.alloc(0); pendingBytes = 0; oversized = false; };
      const consumeLine = separatorBytes => {
        const bytes = pendingBytes + separatorBytes;
        if (!pendingBytes) { resetLine(); return; }
        let record;
        try {
          if (oversized) throw Object.assign(new Error('oversized JSONL row'), { oversized: true });
          record = JSON.parse(pending.toString('utf8'));
        } catch (error) {
          if (error.oversized) {
            oversizedBytes += bytes;
            incomplete = true;
            record = { type: 'oversized_record' };
          } else {
            malformedBytes += bytes;
            incomplete = true;
            resetLine();
            return;
          }
        }
        const type = typeof record.type === 'string' ? record.type : 'untyped';
        const recordedAt = Number.isFinite(record.timestamp) ? record.timestamp : record.createdAt;
        const recent = type !== 'oversized_record' && Number.isFinite(recordedAt) && recordedAt >= cutoff;
        records++;
        session.records++;
        if (recent) {
          recentBytes += bytes;
          session.recentBytes += bytes;
          session.recentRecords++;
        }
        const typeStats = types.get(type) || { type, bytes: 0, records: 0, recentBytes: 0, recentRecords: 0 };
        typeStats.bytes += bytes;
        typeStats.records++;
        if (recent) { typeStats.recentBytes += bytes; typeStats.recentRecords++; }
        types.set(type, typeStats);
        const sessionType = session.types.get(type) || { type, bytes: 0, records: 0, recentBytes: 0, recentRecords: 0 };
        sessionType.bytes += bytes;
        sessionType.records++;
        if (recent) { sessionType.recentBytes += bytes; sessionType.recentRecords++; }
        session.types.set(type, sessionType);
        if (record.type === 'session_init') session.title = record.metadata?.title || session.title;
        if (record.type === 'session_metadata' && typeof record.metadata?.title === 'string') session.title = record.metadata.title;
        resetLine();
      };
      try {
        for await (const chunk of fs.createReadStream(null, { fd, autoClose: false, highWaterMark: 64 * 1024 })) {
          let offset = 0;
          while (offset < chunk.length) {
            const newline = chunk.indexOf(0x0a, offset);
            const end = newline === -1 ? chunk.length : newline;
            addLineBytes(chunk.subarray(offset, end));
            if (newline === -1) break;
            consumeLine(1);
            offset = newline + 1;
          }
        }
      } finally {
        fs.closeSync(fd);
      }
      if (pendingBytes) consumeLine(0);
      sessions.set(sessionId, session);
    }
    const topSessions = [...sessions.values()]
      .map(item => ({ ...item, types: [...item.types.values()].sort((a, b) => b.bytes - a.bytes) }))
      .sort((a, b) => b.bytes - a.bytes).slice(0, 10);
    return {
      scope: 'Only Chat internal JSONL sessions; external Codex sessions and other app files are excluded',
      storageDir: this.storageDir,
      measuredAt: Date.now(),
      windowDays: days,
      totalBytes,
      totalRecords: records,
      recentBytes,
      recentRecords: [...types.values()].reduce((sum, item) => sum + item.recentRecords, 0),
      malformedBytes,
      oversizedBytes,
      incomplete,
      unattributedBytes: Math.max(0, totalBytes - [...types.values()].reduce((sum, item) => sum + item.bytes, 0)),
      byRecordType: [...types.values()].sort((a, b) => b.bytes - a.bytes),
      largestSessions: topSessions
    };
  }

  updateSessionMetadata(sessionId, action, payload = {}) {
    if (typeof sessionId !== 'string' || !SessionStore.SESSION_ID.test(sessionId)) throw new Error('Invalid session ID.');
    const listed = this.listSessions().find(session => session.sessionId === sessionId && session.source === 'internal');
    if (!listed) throw new Error('Internal session not found.');
    if (listed.archived && ['pin', 'move'].includes(action)) throw new Error('Archived sessions cannot be moved into active groups.');
    const current = { title: listed.title, pinned: listed.pinned, section: listed.section, archived: listed.archived };
    let metadata;
    if (action === 'rename' && typeof payload.title === 'string'
      && payload.title.trim().length > 0 && payload.title.trim().length <= 80
      && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(payload.title.trim())) metadata = { title: payload.title.trim() };
    else if (action === 'pin' && typeof payload.pinned === 'boolean') metadata = { pinned: payload.pinned };
    else if (action === 'move' && typeof payload.section === 'string' && /^[\p{L}\p{N} _-]{1,32}$/u.test(payload.section.trim())
      && (payload.pinned === undefined || payload.pinned === false)) metadata = { section: payload.section.trim() || 'recents', ...(payload.pinned === false ? { pinned: false } : {}) };
    else if (action === 'archive' && typeof payload.archived === 'boolean') metadata = { archived: payload.archived };
    else if (action === 'delete' && payload.confirm === true) {
      const fd = this._openSessionFile(sessionId, fs.constants.O_RDONLY, true);
      if (fd === null) throw new Error('Internal session not found.');
      fs.closeSync(fd);
      fs.unlinkSync(path.join(this.storageDir, `${sessionId}.jsonl`));
      return { deleted: true };
    } else throw new Error('Invalid session metadata action.');
    this._appendMetadataAtomically(sessionId, metadata);
    return { ...current, ...metadata };
  }

  _appendMetadataAtomically(sessionId, metadata) {
    const sessionFile = path.join(this.storageDir, `${sessionId}.jsonl`);
    const fd = this._openSessionFile(sessionId, fs.constants.O_RDONLY, true);
    if (fd === null) throw new Error('Internal session not found.');
    let existing;
    try { existing = fs.readFileSync(fd); }
    finally { fs.closeSync(fd); }
    const event = Buffer.from(`${JSON.stringify({ type: 'session_metadata', timestamp: Date.now(), metadata })}\n`, 'utf8');
    const temporaryFile = path.join(this.storageDir, `.${sessionId}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    let descriptor;
    try {
      descriptor = fs.openSync(temporaryFile, 'wx', 0o600);
      fs.writeFileSync(descriptor, Buffer.concat([existing, event]));
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryFile, sessionFile);
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporaryFile); } catch (_) {}
      throw error;
    }
  }

  resumeSession(sessionId) {
    if (typeof sessionId !== 'string' || !/^ses_[a-f0-9]{16}$/.test(sessionId)) return null;
    const records = this.readSession(sessionId);
    if (!records) return null;
    const init = records.find(record => record.type === 'session_init') || {};
    const sessionMetadata = records.filter(record => record.type === 'session_metadata')
      .reduce((value, event) => ({ ...value, ...event.metadata }), {});
    const turns = [];
    const conversationHistory = [];
    for (const record of records) {
      if (record.type === 'user_message' && typeof (record.resolvedContent || record.content) === 'string') {
        const item = { role: 'user', content: record.resolvedContent || record.content };
        turns.push(item);
        conversationHistory.push(item);
      } else if (record.type === 'assistant_message' && typeof record.content === 'string') {
        const item = { role: 'assistant', content: record.content };
        turns.push(item);
        conversationHistory.push(item);
      } else if (record.type === 'assistant_tool_calls' && Array.isArray(record.toolCalls)) {
        const tool_calls = record.toolCalls.filter(call => typeof call?.id === 'string' && typeof call?.name === 'string')
          .map(call => ({ id: call.id, type: 'function', function: {
            name: call.name,
            arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments || {})
          } }));
        if (tool_calls.length) conversationHistory.push({ role: 'assistant', content: null, tool_calls });
      } else if (record.type === 'tool_result' && typeof record.tool_call_id === 'string') {
        conversationHistory.push({ role: 'tool', tool_call_id: record.tool_call_id,
          content: typeof record.result === 'string' ? record.result : JSON.stringify(record.result) });
      } else if (record.type === 'turn_error') {
        turns.push({ role: 'assistant', outcome: 'error', error: {
          category: record.category, model: record.model, rank: record.rank
        } });
      }
    }
    return {
      id: sessionId,
      sessionId,
      source: 'internal',
      title: sessionMetadata.title || (typeof init.metadata?.title === 'string' ? init.metadata.title : 'Only Chat 세션'),
      cwd: init.workspaceDir,
      model: init.model,
      provider: init.provider,
      turns,
      conversationHistory
    };
  }
}

module.exports = { SessionStore };
