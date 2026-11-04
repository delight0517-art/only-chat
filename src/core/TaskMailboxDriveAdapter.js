'use strict';

const crypto = require('node:crypto');

const MAILBOX_PREFIX = 'onlychat-mailbox-v1-';
const JSON_MIME = 'application/json';
const MAX_ENVELOPE_BYTES = 64 * 1024;
const MAX_PAGES = 200;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value, size = 32) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, size);
}

function safeQueryLiteral(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function messageEnvelope(message, localHostId) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new TypeError('message is required');
  if (message.senderHostId !== localHostId) throw new Error('only locally sent messages can be published');
  if (!message.recipientHostId || message.recipientHostId === localHostId) throw new Error('message must target another host');
  if (!['message', 'ack'].includes(message.type)) throw new TypeError('unsupported mailbox message type');
  const envelope = {
    schemaVersion: 1,
    type: 'message',
    message: {
      messageId: message.messageId,
      taskKey: message.taskKey,
      senderChatId: message.senderChatId,
      senderHostId: message.senderHostId,
      recipientChatId: message.recipientChatId ?? null,
      recipientHostId: message.recipientHostId,
      type: message.type,
      text: message.text,
      inReplyToMessageId: message.inReplyToMessageId ?? null,
      createdAt: message.createdAt
    }
  };
  return envelope;
}

class TaskMailboxDriveAdapter {
  constructor({ connector, store, folderId, expectedAccountIdentityHash, peerHostId, pageSize = 100 } = {}) {
    if (!connector || typeof connector.driveListFiles !== 'function'
      || typeof connector.driveReadFile !== 'function' || typeof connector.driveCreateFile !== 'function'
      || typeof connector.driveVerifyMailboxFolder !== 'function'
      || typeof connector.driveGetAccountIdentityHash !== 'function') {
      throw new TypeError('a connected Google Drive connector is required');
    }
    if (!store || typeof store.exportConversationTask !== 'function'
      || typeof store.importConversationTask !== 'function' || typeof store.importRemoteMessage !== 'function'
      || typeof store.hostId !== 'string' || !store.hostId) {
      throw new TypeError('a host-identified task registry store is required');
    }
    if (typeof folderId !== 'string' || !folderId.trim()) throw new TypeError('mailbox folderId is required');
    if (!/^[a-f0-9]{64}$/i.test(expectedAccountIdentityHash || '')) {
      throw new TypeError('expected Drive account identity hash is required');
    }
    if (typeof peerHostId !== 'string' || !peerHostId.trim() || peerHostId.trim() === store.hostId) {
      throw new TypeError('a distinct paired peerHostId is required');
    }
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new RangeError('pageSize must be 1–100');
    this.connector = connector;
    this.store = store;
    this.folderId = folderId.trim();
    this.expectedAccountIdentityHash = expectedAccountIdentityHash.toLowerCase();
    this.peerHostId = peerHostId.trim();
    this.pageSize = pageSize;
  }

  async _assertReady() {
    const accountHash = await this.connector.driveGetAccountIdentityHash();
    if (typeof accountHash !== 'string' || accountHash.toLowerCase() !== this.expectedAccountIdentityHash) {
      throw new Error('Google Drive account does not match the configured Only Chat mailbox account');
    }
    const folder = await this.connector.driveVerifyMailboxFolder(this.folderId);
    if (folder?.folderId !== this.folderId || folder.canListChildren !== true || folder.canAddChildren !== true) {
      throw new Error('Google Drive mailbox folder is not verified for read and write');
    }
  }

  _taskName(task) {
    return `${MAILBOX_PREFIX}task-${digest(task.taskKey, 24)}-${digest(task.sourceHostId, 24)}.json`;
  }

  _messageName(message) {
    return `${MAILBOX_PREFIX}message-${digest(message.recipientHostId, 24)}-${digest(message.messageId, 32)}.json`;
  }

  async _listAll(query) {
    const files = [];
    const seenTokens = new Set();
    let pageToken;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.connector.driveListFiles({ q: query, pageSize: this.pageSize, pageToken });
      if (result?.error) throw new Error(result.error.message || 'Google Drive mailbox listing failed');
      if (!result || !Array.isArray(result.files)) throw new Error('Google Drive mailbox listing returned an invalid response');
      files.push(...result.files);
      const next = result.nextPageToken;
      if (!next) return files;
      if (typeof next !== 'string' || seenTokens.has(next)) throw new Error('Google Drive mailbox pagination cursor is invalid');
      seenTokens.add(next);
      pageToken = next;
    }
    throw new Error('Google Drive mailbox exceeded the pagination safety limit');
  }

  async _createOnce(name, envelope) {
    const query = `'${safeQueryLiteral(this.folderId)}' in parents and trashed = false and name = '${safeQueryLiteral(name)}'`;
    const existing = await this._listAll(query);
    const expected = stableJson(envelope);
    for (const file of existing) {
      if (!file?.id) throw new Error('Google Drive mailbox returned a file without an ID');
      const read = await this.connector.driveReadFile(file.id);
      if (read?.error || typeof read?.content !== 'string') throw new Error('Google Drive mailbox file could not be read');
      let actual;
      try { actual = JSON.parse(read.content); }
      catch (_) { throw new Error('Google Drive mailbox file is not valid JSON'); }
      if (stableJson(actual) !== expected) throw new Error('Google Drive mailbox file name is already bound to different content');
    }
    if (existing.length) return { created: false, replayed: true, fileId: existing[0].id, duplicateFileCount: existing.length };
    const content = JSON.stringify(envelope);
    if (Buffer.byteLength(content, 'utf8') > MAX_ENVELOPE_BYTES) throw new RangeError('mailbox envelope exceeds the 64 KiB limit');
    const created = await this.connector.driveCreateFile(name, JSON_MIME, content, this.folderId);
    if (created?.error) throw new Error(created.error.message || 'Google Drive mailbox write failed');
    if (!created?.id) throw new Error('Google Drive mailbox write did not return a file ID');
    return { created: true, replayed: false, fileId: created.id, duplicateFileCount: 0 };
  }

  async publishTask(taskKey) {
    await this._assertReady();
    const task = this.store.exportConversationTask(taskKey);
    if (task?.sourceHostId !== this.store.hostId) throw new Error('only locally originated tasks can be published');
    const envelope = { schemaVersion: 1, type: 'task', task };
    return this._createOnce(this._taskName(task), envelope);
  }

  async publishMessage(message) {
    await this._assertReady();
    const envelope = messageEnvelope(message, this.store.hostId);
    if (envelope.message.recipientHostId !== this.peerHostId) {
      throw new Error('message recipient host is not the configured Only Chat peer');
    }
    return this._createOnce(this._messageName(envelope.message), envelope);
  }

  async syncIncoming() {
    await this._assertReady();
    const query = `'${safeQueryLiteral(this.folderId)}' in parents and trashed = false and name contains '${MAILBOX_PREFIX}'`;
    const files = await this._listAll(query);
    const result = { tasksImported: 0, messagesImported: 0, replayed: 0, ignored: 0 };
    const taskEnvelopes = [];
    const messageEnvelopes = [];
    for (const file of files) {
      if (!file?.id || typeof file.name !== 'string' || !file.name.startsWith(MAILBOX_PREFIX)) {
        result.ignored += 1;
        continue;
      }
      const read = await this.connector.driveReadFile(file.id);
      if (read?.error || typeof read?.content !== 'string') throw new Error(`Google Drive mailbox file ${file.id} could not be read`);
      let envelope;
      try { envelope = JSON.parse(read.content); }
      catch (_) { throw new Error(`Google Drive mailbox file ${file.id} is not valid JSON`); }
      if (envelope?.schemaVersion !== 1) throw new Error(`Google Drive mailbox file ${file.id} has an unsupported schema`);
      if (envelope.type === 'task' && file.name.startsWith(`${MAILBOX_PREFIX}task-`)) {
        if (envelope.task?.sourceHostId !== this.peerHostId || file.name !== this._taskName(envelope.task)) {
          result.ignored += 1;
          continue;
        }
        taskEnvelopes.push(envelope.task);
      } else if (envelope.type === 'message' && file.name.startsWith(`${MAILBOX_PREFIX}message-`)) {
        const message = envelope.message;
        if (message?.recipientHostId !== this.store.hostId || message?.senderHostId !== this.peerHostId
          || file.name !== this._messageName(message)) {
          result.ignored += 1;
          continue;
        }
        messageEnvelopes.push(message);
      } else {
        result.ignored += 1;
      }
    }

    // Drive does not promise task files precede their messages. Import all task
    // shells first so listing order cannot silently drop a message on first sync.
    const importableTaskKeys = new Set();
    for (const task of taskEnvelopes) {
      const imported = await this.store.importConversationTask(task);
      if (imported.imported) {
        result.tasksImported += 1;
        importableTaskKeys.add(task.taskKey);
      } else if (imported.replayed) {
        result.replayed += 1;
        if (!imported.localTaskPreserved) importableTaskKeys.add(task.taskKey);
      } else {
        result.ignored += 1;
      }
    }

    for (const message of messageEnvelopes) {
      // Regular remote messages require a peer-originated conversation shell.
      // ACKs may target a local task; the store verifies their original message.
      if (message.type !== 'ack' && !importableTaskKeys.has(message.taskKey)) {
        result.ignored += 1;
        continue;
      }
      const imported = await this.store.importRemoteMessage(message);
      if (imported.imported) result.messagesImported += 1;
      else if (imported.replayed) result.replayed += 1;
      else result.ignored += 1;
    }
    return result;
  }
}

module.exports = { TaskMailboxDriveAdapter, MAILBOX_PREFIX };
