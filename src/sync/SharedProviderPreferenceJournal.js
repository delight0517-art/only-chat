'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const CONTRACT_VERSION = 1;
const MAX_PROFILES = 128;
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const MAX_SHARED_RECORDS = 2048;
const MAX_SHARED_DIRECTORY_BYTES = 32 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[a-f0-9]{64}$/i;
const PROVIDERS = new Set(['openai-compatible', 'antigravity-agent', 'antigravity-cli', 'codex-app-server', 'chatgpt-plan', 'openrouter', 'codex-cli', 'antigravity']);
const PLATFORMS = new Set(['win32', 'darwin', 'linux']);

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} contains missing or unsupported fields.`);
  }
}

function allowKeys(value, required, optional, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  const allowed = new Set([...required, ...optional]);
  if (required.some(key => !Object.prototype.hasOwnProperty.call(value, key)) || Object.keys(value).some(key => !allowed.has(key))) {
    throw new TypeError(`${label} contains missing or unsupported fields.`);
  }
}

function normalizeProfiles(profiles) {
  if (!Array.isArray(profiles) || profiles.length > MAX_PROFILES) throw new TypeError('profiles must be an array of at most 128 entries.');
  const ids = new Set();
  return profiles.map((profile, index) => {
    exactKeys(profile, ['id', 'provider', 'model', 'priority', 'enabled'], `profiles[${index}]`);
    if (typeof profile.id !== 'string' || !ID_RE.test(profile.id) || ids.has(profile.id)) throw new TypeError(`profiles[${index}].id is invalid or duplicated.`);
    if (!PROVIDERS.has(profile.provider)) throw new TypeError(`profiles[${index}].provider is unsupported.`);
    if (typeof profile.model !== 'string' || !profile.model.trim() || profile.model.length > 160 || /[\r\n\0]/.test(profile.model)) throw new TypeError(`profiles[${index}].model is invalid.`);
    if (!Number.isSafeInteger(profile.priority) || profile.priority < 1 || profile.priority > 1000) throw new TypeError(`profiles[${index}].priority is invalid.`);
    if (typeof profile.enabled !== 'boolean') throw new TypeError(`profiles[${index}].enabled must be boolean.`);
    ids.add(profile.id);
    return { id: profile.id, provider: profile.provider, model: profile.model.trim(), priority: profile.priority, enabled: profile.enabled };
  }).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

function createSnapshot(input = {}) {
  allowKeys(input, ['deviceId', 'platform', 'profiles'], ['baseStateHash', 'operationId', 'createdAt'], 'snapshot input');
  const { deviceId, platform, profiles } = input;
  const baseStateHash = input.baseStateHash ?? null;
  const operationId = input.operationId ?? crypto.randomUUID();
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!UUID_RE.test(deviceId || '') || !UUID_RE.test(operationId || '')) throw new TypeError('Device and operation IDs must be UUIDs.');
  if (!PLATFORMS.has(platform)) throw new TypeError('Platform is unsupported.');
  if (baseStateHash !== null && !HASH_RE.test(baseStateHash)) throw new TypeError('baseStateHash is invalid.');
  if (!Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) throw new TypeError('createdAt must be an ISO UTC timestamp.');
  const normalizedProfiles = normalizeProfiles(profiles);
  const stateHash = sha256({ schemaVersion: SCHEMA_VERSION, profiles: normalizedProfiles });
  if (baseStateHash && baseStateHash === stateHash) throw new TypeError('A snapshot must change the shared state.');
  const payload = { schemaVersion: SCHEMA_VERSION, contractVersion: CONTRACT_VERSION, operationId, deviceId, platform, baseStateHash, createdAt, stateHash, profiles: normalizedProfiles };
  return { ...payload, snapshotHash: sha256(payload) };
}

function validateSnapshot(value) {
  exactKeys(value, ['schemaVersion', 'contractVersion', 'operationId', 'deviceId', 'platform', 'baseStateHash', 'createdAt', 'stateHash', 'profiles', 'snapshotHash'], 'snapshot');
  if (value.schemaVersion !== SCHEMA_VERSION || value.contractVersion !== CONTRACT_VERSION) throw new TypeError('Snapshot schema or contract version is unsupported.');
  const rebuilt = createSnapshot({
    deviceId: value.deviceId,
    platform: value.platform,
    baseStateHash: value.baseStateHash,
    profiles: value.profiles,
    operationId: value.operationId,
    createdAt: value.createdAt
  });
  if (rebuilt.stateHash !== value.stateHash || rebuilt.snapshotHash !== value.snapshotHash) throw new TypeError('Snapshot hash verification failed.');
  return rebuilt;
}

function createAcknowledgement(input = {}) {
  allowKeys(input, ['deviceId', 'platform', 'stateHash'], ['acknowledgedAt', 'ackId'], 'acknowledgement input');
  const { deviceId, platform, stateHash } = input;
  const acknowledgedAt = input.acknowledgedAt ?? new Date().toISOString();
  const ackId = input.ackId ?? crypto.randomUUID();
  if (!UUID_RE.test(deviceId || '') || !UUID_RE.test(ackId || '')) throw new TypeError('Device and acknowledgement IDs must be UUIDs.');
  if (!PLATFORMS.has(platform) || !HASH_RE.test(stateHash || '')) throw new TypeError('Acknowledgement target is invalid.');
  if (!Number.isFinite(Date.parse(acknowledgedAt)) || new Date(acknowledgedAt).toISOString() !== acknowledgedAt) throw new TypeError('acknowledgedAt must be an ISO UTC timestamp.');
  const payload = { schemaVersion: SCHEMA_VERSION, contractVersion: CONTRACT_VERSION, ackId, deviceId, platform, stateHash, acknowledgedAt };
  return { ...payload, acknowledgementHash: sha256(payload) };
}

function validateAcknowledgement(value) {
  exactKeys(value, ['schemaVersion', 'contractVersion', 'ackId', 'deviceId', 'platform', 'stateHash', 'acknowledgedAt', 'acknowledgementHash'], 'acknowledgement');
  if (value.schemaVersion !== SCHEMA_VERSION || value.contractVersion !== CONTRACT_VERSION) throw new TypeError('Acknowledgement schema or contract version is unsupported.');
  const rebuilt = createAcknowledgement({
    deviceId: value.deviceId,
    platform: value.platform,
    stateHash: value.stateHash,
    acknowledgedAt: value.acknowledgedAt,
    ackId: value.ackId
  });
  if (rebuilt.acknowledgementHash !== value.acknowledgementHash) throw new TypeError('Acknowledgement hash verification failed.');
  return rebuilt;
}

function writeImmutable(directory, subdirectory, filename, value, hashKey) {
  if (typeof directory !== 'string' || !directory.trim() || !path.isAbsolute(directory)) throw new TypeError('An explicit absolute shared directory is required.');
  const root = path.resolve(directory);
  const folder = path.join(root, subdirectory);
  fs.mkdirSync(folder, { recursive: true });
  const target = path.join(folder, filename);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SNAPSHOT_BYTES) throw new TypeError('Shared record exceeds the size limit.');
  if (fs.existsSync(target)) {
    if (!fs.lstatSync(target).isFile()) throw new Error('Immutable shared record path is not a regular file.');
    const existing = JSON.parse(fs.readFileSync(target, 'utf8'));
    const validated = hashKey === 'snapshotHash' ? validateSnapshot(existing) : validateAcknowledgement(existing);
    const sameAck = hashKey === 'acknowledgementHash'
      && validated.deviceId === value.deviceId
      && validated.platform === value.platform
      && validated.stateHash === value.stateHash;
    if (validated[hashKey] === value[hashKey] || sameAck) return { path: target, idempotent: true, hash: validated[hashKey] };
    throw new Error('Immutable shared record path already contains different data.');
  }
  let descriptor;
  try {
    descriptor = fs.openSync(target, 'wx', 0o600);
    fs.writeFileSync(descriptor, serialized, 'utf8');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error.code === 'EEXIST' && fs.existsSync(target) && fs.lstatSync(target).isFile()) {
      try {
        const existing = JSON.parse(fs.readFileSync(target, 'utf8'));
        const validated = hashKey === 'snapshotHash' ? validateSnapshot(existing) : validateAcknowledgement(existing);
        const sameAck = hashKey === 'acknowledgementHash'
          && validated.deviceId === value.deviceId
          && validated.platform === value.platform
          && validated.stateHash === value.stateHash;
        if (validated[hashKey] === value[hashKey] || sameAck) return { path: target, idempotent: true, hash: validated[hashKey] };
      } catch (readError) {
        throw new Error(`Existing immutable shared record is unreadable: ${readError.message}`);
      }
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return { path: target, idempotent: false, hash: value[hashKey] };
}

function writeSnapshot(directory, snapshot) {
  const value = validateSnapshot(snapshot);
  return writeImmutable(directory, 'snapshots', `${value.deviceId}-${value.operationId}.json`, value, 'snapshotHash');
}

function writeAcknowledgement(directory, acknowledgement) {
  const value = validateAcknowledgement(acknowledgement);
  return writeImmutable(directory, 'acknowledgements', `${value.deviceId}-${value.stateHash}.json`, value, 'acknowledgementHash');
}

function readRecords(directory, subdirectory, validator, filenamePattern) {
  if (typeof directory !== 'string' || !directory.trim() || !path.isAbsolute(directory)) throw new TypeError('An explicit absolute shared directory is required.');
  const folder = path.join(path.resolve(directory), subdirectory);
  if (!fs.existsSync(folder)) return [];
  const records = [];
  let totalBytes = 0;
  for (const filename of fs.readdirSync(folder).sort()) {
    if (filename.startsWith('.') && filename.endsWith('.tmp')) continue;
    if (!filenamePattern.test(filename)) throw new Error(`Unexpected shared record name: ${filename}`);
    if (records.length >= MAX_SHARED_RECORDS) throw new Error('Shared record count limit exceeded.');
    const fullPath = path.join(folder, filename);
    const stat = fs.lstatSync(fullPath);
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) throw new Error(`Shared record is not a bounded file: ${filename}`);
    totalBytes += stat.size;
    if (totalBytes > MAX_SHARED_DIRECTORY_BYTES) throw new Error('Shared directory size limit exceeded.');
    const record = validator(JSON.parse(fs.readFileSync(fullPath, 'utf8')));
    records.push({ filename, record });
  }
  return records;
}

function readSnapshots(directory) {
  const records = readRecords(directory, 'snapshots', validateSnapshot, /^[a-f0-9-]{36}-[a-f0-9-]{36}\.json$/i);
  for (const { filename, record } of records) {
    if (filename !== `${record.deviceId}-${record.operationId}.json`) throw new Error(`Snapshot filename does not match its identity: ${filename}`);
  }
  return records.map(item => item.record);
}

function readAcknowledgements(directory) {
  const records = readRecords(directory, 'acknowledgements', validateAcknowledgement, /^[a-f0-9-]{36}-[a-f0-9]{64}\.json$/i);
  for (const { filename, record } of records) {
    if (filename !== `${record.deviceId}-${record.stateHash}.json`) throw new Error(`Acknowledgement filename does not match its identity: ${filename}`);
  }
  return records.map(item => item.record);
}

function resolveSnapshots(snapshots) {
  if (!Array.isArray(snapshots)) throw new TypeError('snapshots must be an array.');
  const validated = snapshots.map(validateSnapshot);
  const operations = new Map();
  for (const snapshot of validated) {
    const operationKey = `${snapshot.deviceId}:${snapshot.operationId}`;
    const previous = operations.get(operationKey);
    if (previous && previous !== snapshot.snapshotHash) throw new Error('A device operation ID is bound to multiple snapshots.');
    operations.set(operationKey, snapshot.snapshotHash);
  }
  const stateGroups = new Map();
  for (const snapshot of validated) {
    const key = snapshot.baseStateHash || 'ROOT';
    if (!stateGroups.has(key)) stateGroups.set(key, new Map());
    const stateSet = stateGroups.get(key);
    if (!stateSet.has(snapshot.stateHash)) stateSet.set(snapshot.stateHash, []);
    stateSet.get(snapshot.stateHash).push(snapshot);
  }
  if (!validated.length) return { status: 'empty', state: null, conflicts: [], pending: [] };
  const roots = stateGroups.get('ROOT') || new Map();
  if (!roots.size) return { status: 'incomplete', state: null, conflicts: [], pending: validated.map(item => item.snapshotHash) };
  if (roots.size > 1) return { status: 'conflict', state: null, conflicts: [...roots.keys()], pending: [] };
  let stateHash = roots.keys().next().value;
  let current = roots.get(stateHash)[0];
  const visited = new Set([stateHash]);
  while (true) {
    const children = stateGroups.get(stateHash) || new Map();
    if (!children.size) break;
    if (children.size > 1) return { status: 'conflict', state: current, conflicts: [...children.keys()], pending: [] };
    const nextHash = children.keys().next().value;
    if (visited.has(nextHash)) return { status: 'conflict', state: current, conflicts: [nextHash], pending: [] };
    current = children.get(nextHash)[0];
    stateHash = nextHash;
    visited.add(stateHash);
  }
  const pending = validated.filter(item => !visited.has(item.stateHash)).map(item => item.snapshotHash);
  return { status: pending.length ? 'incomplete' : 'ready', state: current, conflicts: [], pending };
}

function acknowledgementsForState(acknowledgements, stateHash) {
  if (!Array.isArray(acknowledgements) || !HASH_RE.test(stateHash || '')) throw new TypeError('Acknowledgements and target hash are required.');
  const seenDevices = new Map();
  for (const raw of acknowledgements) {
    const ack = validateAcknowledgement(raw);
    if (ack.stateHash !== stateHash) continue;
    const existing = seenDevices.get(ack.deviceId);
    if (!existing || existing.acknowledgedAt < ack.acknowledgedAt) seenDevices.set(ack.deviceId, ack);
  }
  return [...seenDevices.values()].sort((a, b) => a.platform.localeCompare(b.platform) || a.deviceId.localeCompare(b.deviceId));
}

module.exports = {
  SCHEMA_VERSION,
  CONTRACT_VERSION,
  createSnapshot,
  validateSnapshot,
  writeSnapshot,
  readSnapshots,
  resolveSnapshots,
  createAcknowledgement,
  validateAcknowledgement,
  writeAcknowledgement,
  readAcknowledgements,
  acknowledgementsForState
};
