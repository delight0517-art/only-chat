'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { NativeSessionBridge, pythonExecutableForPlatform } = require('../src/core/NativeSessionBridge.js');

async function main() {
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-session-'));
try {
  assert.strictEqual(pythonExecutableForPlatform('win32'), 'python');
  assert.strictEqual(pythonExecutableForPlatform('darwin'), 'python3');

  const home = path.join(root, "owner's data");
  const codexDir = path.join(home, '.codex');
  const codexDb = path.join(codexDir, 'state.sqlite');
  const rollout = path.join(codexDir, 'sessions', 'rollout.jsonl');
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, [
    { type: 'event_msg', payload: { type: 'user_message', message: 'resume me' } },
    { type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'The secret phrase is Blue Harbor.' }] } }
  ].map(JSON.stringify).join('\n') + '\n');
  const oldRollout = path.join(codexDir, 'sessions', 'older.jsonl');
  fs.writeFileSync(oldRollout, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Found deep searchword here' } }) + '\n');
  const missingMetadataRollout = path.join(codexDir, 'sessions', 'missing-metadata.jsonl');
  fs.writeFileSync(missingMetadataRollout, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'legacy metadataneedle hit' } }) + '\n');
  const unicodeRollout = path.join(codexDir, 'sessions', 'unicode.jsonl');
  fs.writeFileSync(unicodeRollout, [
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '한국어 검색어 혼합 일치' } }),
    '{"type":"event_msg","payload":{"type":"user_message","message":"escaped \\uac80\\uc0c9\\uc5b4 query"}}',
    '{"type":"event_msg","payload":{"type":"user_message","message":"mixed raw 검\\uc0c9어 term"}}',
    '{"type":"event_msg","payload":{"type":"user_message","message":"mixed uppercase escape 한\\uAE00 hybridneedle"}}',
    '{"type":"event_msg","payload":{"type":"user_message","message":"literal escape \\\\uAE00 is not Hangul"}}',
    '{"type":"event_msg","payload":{"type":"user_message","message":"리터럴 한글과 escaped \\uac80\\uc0c9\\uc5b4 함께"}}',
    '{"type":"event_msg","payload":{"type":"user_message","message":"uppercase escape \\u00DC\\u00dC marker"}}',
    '{"type":"event_msg","payload":{"type":"user_message","message":"lowercase escape \\u00fc marker"}}',
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'KOREAN marker with 한글' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'tag 한글ABC result' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '두 항목 모두 들어 있음' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '한국어만 있고 다른항목은 없음' } })
  ].join('\n') + '\n');
  const expandingCaseRollout = path.join(codexDir, 'sessions', 'expanding-case.jsonl');
  fs.writeFileSync(expandingCaseRollout, JSON.stringify({
    type: 'event_msg', payload: { type: 'user_message', message: 'Codex Unicode uppercase STRAẞE marker' }
  }) + '\n');
  const outsideRollout = path.join(root, 'outside.jsonl');
  fs.writeFileSync(outsideRollout, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'outsideonly marker' } }) + '\n');
  const repeatedMatchRollout = path.join(codexDir, 'sessions', 'repeated-match.jsonl');
  fs.writeFileSync(repeatedMatchRollout, JSON.stringify({
    type: 'event_msg', payload: { type: 'user_message', message: '한글 codexrepeatneedle '.repeat(300000) }
  }) + '\n');
  const smallOrderRollout = path.join(codexDir, 'sessions', 'small-order.jsonl');
  fs.writeFileSync(smallOrderRollout, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'codexorderneedle small transcript' } }) + '\n');
  const largeOrderRollout = path.join(codexDir, 'sessions', 'large-order.jsonl');
  fs.writeFileSync(largeOrderRollout, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'padding '.repeat(4096) + ' codexorderneedle large transcript' } }) + '\n');
  const chunkBoundaryRollout = path.join(codexDir, 'sessions', 'chunk-boundary.jsonl');
  const scanChunkBytes = 16 * 1024 * 1024;
  const chunkTerm = 'codexchunkneedle';
  const chunkLinePrefix = '{"type":"event_msg","payload":{"type":"user_message","message":"';
  const chunkPaddingLength = scanChunkBytes * 2 - 4 - Buffer.byteLength(chunkLinePrefix);
  fs.writeFileSync(chunkBoundaryRollout, chunkLinePrefix + 'x'.repeat(chunkPaddingLength) + chunkTerm + ' boundary match"}}\n');
  const escapedUnicodeLongRollout = path.join(codexDir, 'sessions', 'escaped-unicode-long-row.jsonl');
  const unicodeLinePrefix = '{"type":"event_msg","payload":{"type":"user_message","message":"한글 ';
  const escapedUnicodePadding = '\\u0061'.repeat(Math.ceil((scanChunkBytes * 2) / 6));
  fs.writeFileSync(escapedUnicodeLongRollout, unicodeLinePrefix + escapedUnicodePadding + ' escapedneedle"}}\n');
  const pyPath = JSON.stringify(codexDb);
  execFileSync(pythonExecutableForPlatform(), ['-c', `import sqlite3\nc=sqlite3.connect(${pyPath})\nc.execute("CREATE TABLE threads (id TEXT, title TEXT, is_pinned INTEGER, thread_section_id TEXT, cwd TEXT, model TEXT, updated_at REAL, rollout_path TEXT)")\nc.execute("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ('thread-1', 'Codex task', 0, '', ${JSON.stringify(home)}, 'test-model', 1, ${JSON.stringify(rollout)}))\nc.commit()`]);

  execFileSync(pythonExecutableForPlatform(), ['-c', `import sqlite3\nc=sqlite3.connect(${pyPath})\nc.executemany("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [('thread-2', 'Old title', 0, '', ${JSON.stringify(home)}, 'test-model', 2, ${JSON.stringify(oldRollout)}), ('thread-outside', 'Outside', 0, '', ${JSON.stringify(home)}, 'test-model', 3, ${JSON.stringify(outsideRollout)}), ('thread-repeated', 'Repeated match', 0, '', ${JSON.stringify(home)}, 'test-model', 5, ${JSON.stringify(repeatedMatchRollout)})])\nc.commit()`]);

  execFileSync(pythonExecutableForPlatform(), ['-c', `import sqlite3\nc=sqlite3.connect(${pyPath})\nc.execute("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ('thread-unicode', 'Unicode title', 0, '', ${JSON.stringify(home)}, 'test-model', 4, ${JSON.stringify(unicodeRollout)}))\nc.commit()`]);

  execFileSync(pythonExecutableForPlatform(), ['-c', `import sqlite3\nc=sqlite3.connect(${pyPath})\nc.execute("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ('thread-missing-metadata', None, 0, '', ${JSON.stringify(home)}, 'test-model', None, ${JSON.stringify(missingMetadataRollout)}))\nc.commit()`]);

  execFileSync(pythonExecutableForPlatform(), ['-c', `import sqlite3\nc=sqlite3.connect(${pyPath})\nc.execute("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ('thread-expanding-case', 'Expanding case title', 0, '', ${JSON.stringify(home)}, 'test-model', 5, ${JSON.stringify(expandingCaseRollout)}))\nc.commit()`]);

  execFileSync(pythonExecutableForPlatform(), ['-c', `import sqlite3\nc=sqlite3.connect(${pyPath})\nc.executemany("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [('thread-small-order', 'Small transcript', 0, '', ${JSON.stringify(home)}, 'test-model', 1, ${JSON.stringify(smallOrderRollout)}), ('thread-large-order', 'Large transcript', 0, '', ${JSON.stringify(home)}, 'test-model', 100, ${JSON.stringify(largeOrderRollout)})])\nc.commit()`]);

  execFileSync(pythonExecutableForPlatform(), ['-c', `import sqlite3\nc=sqlite3.connect(${pyPath})\nc.execute("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ('thread-chunk-boundary', 'Chunk boundary', 0, '', ${JSON.stringify(home)}, 'test-model', 90, ${JSON.stringify(chunkBoundaryRollout)}))\nc.commit()`]);

  execFileSync(pythonExecutableForPlatform(), ['-c', `import sqlite3\nc=sqlite3.connect(${pyPath})\nc.execute("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ('thread-escaped-unicode-long', 'Escaped Unicode long row', 0, '', ${JSON.stringify(home)}, 'test-model', 0, ${JSON.stringify(escapedUnicodeLongRollout)}))\nc.commit()`]);

  const queueDb = path.join(codexDir, 'queue.sqlite');
  const queueDbArg = JSON.stringify(queueDb);
  const queuedPayload = JSON.stringify({ UserInput: { client_id: 'client-1', content: [{ type: 'text', text: 'Queued task title\nInspect only this fixture.' }, { type: 'image', image_url: 'private-image-reference' }] } });
  const secondQueuedPayload = JSON.stringify({ UserInput: { content: [{ type: 'text', text: 'Second queued task' }] } });
  const attachmentOnlyPayload = JSON.stringify({ UserInput: { content: [{ type: 'audio', data: 'private-audio-data' }] } });
  const oversizedQueuedPayload = JSON.stringify({ UserInput: { content: [{ type: 'text', text: 'L'.repeat(65540) }] } });
  execFileSync(pythonExecutableForPlatform(), ['-c', `import sqlite3\nc=sqlite3.connect(${queueDbArg})\nc.execute("CREATE TABLE queued_items (id TEXT PRIMARY KEY, thread_id TEXT, payload_json TEXT, queue_order INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER)")\nc.executemany("INSERT INTO queued_items VALUES (?, ?, ?, ?, ?, ?)", [('queued-1', 'thread-1', ${JSON.stringify(queuedPayload)}, 0, 1000, 2000), ('queued-empty', 'thread-1', '{}', 1, 1001, 2001), ('queued-2', 'thread-1', ${JSON.stringify(secondQueuedPayload)}, 2, 1002, 2002), ('queued-audio', 'thread-1', ${JSON.stringify(attachmentOnlyPayload)}, 3, 1003, 2003), ('queued-oversized', 'thread-1', ${JSON.stringify(oversizedQueuedPayload)}, 4, 1004, 2004)])\nc.commit()`]);

  const brainDir = path.join(home, '.gemini', 'antigravity', 'brain');
  const transcript = path.join(brainDir, 'agy-1', '.system_generated', 'logs', 'transcript.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, [
    { type: 'USER_INPUT', content: '<USER_REQUEST>Antigravity task</USER_REQUEST>' },
    { type: 'PLANNER_RESPONSE', content: 'Needle in Gemini assistant response' }
  ].map(JSON.stringify).join('\n') + '\n');
  const smallBrainTranscript = path.join(brainDir, 'agy-small', '.system_generated', 'logs', 'transcript.jsonl');
  fs.mkdirSync(path.dirname(smallBrainTranscript), { recursive: true });
  fs.writeFileSync(smallBrainTranscript, JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>agyorderneedle small transcript</USER_REQUEST>' }) + '\n');
  const largeBrainTranscript = path.join(brainDir, 'agy-large', '.system_generated', 'logs', 'transcript.jsonl');
  fs.mkdirSync(path.dirname(largeBrainTranscript), { recursive: true });
  fs.writeFileSync(largeBrainTranscript, JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>' + 'padding '.repeat(4096) + ' agyorderneedle large transcript</USER_REQUEST>' }) + '\n');
  fs.utimesSync(smallBrainTranscript, new Date(1000000), new Date(1000000));
  fs.utimesSync(largeBrainTranscript, new Date(2000000), new Date(2000000));
  const outsideBrain = path.join(root, 'outside-brain');
  const outsideTranscript = path.join(outsideBrain, 'outside-session', '.system_generated', 'logs', 'transcript.jsonl');
  fs.mkdirSync(path.dirname(outsideTranscript), { recursive: true });
  fs.writeFileSync(outsideTranscript, JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>outside brain data</USER_REQUEST>' }) + '\n');

  const bridge = new NativeSessionBridge({ codexStateDb: codexDb, codexQueueDb: queueDb, antigravityBrainDir: brainDir });
  const codex = bridge.loadCodexSessions();
  assert.strictEqual(codex.find(session => session.rawId === 'thread-1').title, 'Codex task');
  assert.deepStrictEqual(bridge.loadCodexThreadMetadata().find(session => session.rawId === 'thread-1'), {
    rawId: 'thread-1', title: 'Codex task', isArchived: false
  });
  const queuedItems = bridge.loadCodexQueuedItems();
  assert.strictEqual(queuedItems.available, true);
  assert.strictEqual(queuedItems.count, 4, 'queue reader ignores empty payloads but retains unsupported and oversized requests');
  assert.deepStrictEqual(queuedItems.items[0], {
    id: 'queued-1', threadId: 'thread-1', queueOrder: 0, createdAt: 1000, updatedAt: 2000,
    title: 'Queued task title', prompt: 'Queued task title\nInspect only this fixture.\n[Image attachment omitted]', hasImageAttachment: true, hasUnsupportedContent: true, promptTruncated: false
  });
  assert.strictEqual(queuedItems.items[1].hasImageAttachment, false);
  assert.strictEqual(queuedItems.items[1].hasUnsupportedContent, false);
  assert.deepStrictEqual(queuedItems.items[2], {
    id: 'queued-audio', threadId: 'thread-1', queueOrder: 3, createdAt: 1003, updatedAt: 2003,
    title: '[Unsupported attachment or content omitted]',
    prompt: '[Unsupported attachment or content omitted]',
    hasImageAttachment: false, hasUnsupportedContent: true, promptTruncated: false
  });
  const oversized = queuedItems.items[3];
  assert.equal(oversized.promptTruncated, true, 'long queue prompts must be marked as truncated');
  assert.ok(oversized.prompt.length <= 65536);
  assert.match(oversized.prompt, /original remains in Codex/);
  assert.deepStrictEqual(queuedItems.items.map(item => [item.id, item.queueOrder]), [['queued-1', 0], ['queued-2', 2], ['queued-audio', 3], ['queued-oversized', 4]], 'queue items retain their thread ordering');
  execFileSync(pythonExecutableForPlatform(), ['-c', `import sqlite3\nc=sqlite3.connect('file:' + ${JSON.stringify(queueDb)} + '?mode=ro', uri=True)\nassert c.execute('SELECT COUNT(*) FROM queued_items').fetchone()[0] == 5\nc.close()`]);
  assert.deepStrictEqual(new NativeSessionBridge({ codexStateDb: codexDb, codexQueueDb: path.join(codexDir, 'missing-queue.sqlite'), antigravityBrainDir: brainDir }).loadCodexQueuedItems(), {
    available: false, error: 'database_missing', count: 0, items: []
  });
  const unsupportedQueueDb = path.join(codexDir, 'unsupported-queue.sqlite');
  execFileSync(pythonExecutableForPlatform(), ['-c', `import sqlite3\nc=sqlite3.connect(${JSON.stringify(unsupportedQueueDb)})\nc.execute("CREATE TABLE queued_items (id TEXT)")\nc.commit()`]);
  assert.deepStrictEqual(new NativeSessionBridge({ codexStateDb: codexDb, codexQueueDb: unsupportedQueueDb, antigravityBrainDir: brainDir }).loadCodexQueuedItems(), {
    available: false, error: 'unsupported_schema', count: 0, items: []
  });
  assert.strictEqual(bridge.resumeSession('codex_thread-1').turns[0].content, 'resume me');
  assert.deepStrictEqual(bridge.resumeSession('codex_thread-outside').turns, [], 'Codex resume must ignore rollout paths outside the allowed roots');
  assert.equal(bridge.resumeSession('agy_../../outside-session'), null, 'Antigravity resume must reject traversal segments');
  assert.equal(bridge.resumeSession('codex_../thread-1'), null, 'Codex resume must reject path separators in IDs');
  assert.equal(bridge.resumeSession(42), null, 'resume rejects non-string IDs without throwing');

  const antigravity = bridge.loadAntigravitySessions();
  assert.strictEqual(antigravity[0].rawId, 'agy-1');
  assert.strictEqual(antigravity[0].title, 'Antigravity task');
  assert.strictEqual(bridge.resumeSession('agy_agy-1').turns[1].content, 'Needle in Gemini assistant response');
  fs.symlinkSync(path.dirname(path.dirname(path.dirname(outsideTranscript))), path.join(brainDir, 'escape'), 'dir');
  assert.equal(bridge.resumeSession('agy_escape'), null, 'Antigravity resume must reject a session symlink escaping the brain root');
  const codexHit = await bridge.searchSessions('searchword');
  assert.strictEqual(codexHit[0].id, 'codex_thread-2');
  assert.match(codexHit[0].snippet, /searchword/);
  assert.strictEqual('rolloutPath' in codexHit[0], false);
  const legacyMetadataHit = await bridge.searchSessions('metadataneedle');
  assert.strictEqual(legacyMetadataHit[0].id, 'codex_thread-missing-metadata');
  assert.strictEqual(legacyMetadataHit[0].title, 'Untitled');
  assert.strictEqual(legacyMetadataHit[0].updatedAt, 0);
  assert.strictEqual((await bridge.searchSessions('secret phrase'))[0].id, 'codex_thread-1');
  const streamedSearchEvents = [];
  const streamedSearchResults = await bridge.searchSessions('secret phrase', {
    onResult: item => streamedSearchEvents.push({ type: 'result', item }),
    onProgress: progress => streamedSearchEvents.push({ type: 'progress', ...progress })
  });
  assert.deepStrictEqual(streamedSearchResults.map(item => item.id), ['codex_thread-1']);
  assert.deepStrictEqual(streamedSearchEvents.filter(event => event.type === 'result').map(event => event.item.id), ['codex_thread-1']);
  assert.ok(streamedSearchEvents.some(event => event.complete === true), 'stream reports completion after its results');
  const chunkSearchProgress = [];
  const chunkSearchResults = await bridge.searchSessions(chunkTerm, {
    onProgress: progress => { if (progress.fileBytesTotal > 0) chunkSearchProgress.push(progress); }
  });
  assert.deepStrictEqual(chunkSearchResults.map(item => item.id), ['codex_thread-chunk-boundary'], 'ASCII terms spanning a scan-chunk boundary still match the full JSONL line');
  assert.ok(chunkSearchProgress.some(progress => progress.fileBytesScanned === scanChunkBytes && progress.fileBytesTotal > scanChunkBytes * 2), 'stream exposes bounded byte progress while scanning a large transcript');
  assert.deepStrictEqual((await bridge.searchSessions('한글 escapedneedle')).map(item => item.id), ['codex_thread-escaped-unicode-long'], 'Unicode search keeps a match inside one long escaped-JSON line spanning multiple scan chunks');
  const scanOrder = [];
  const scanProgress = [];
  const sizeOrderedResults = await bridge.searchSessions('codexorderneedle', {
    onResult: item => scanOrder.push(item.id),
    onProgress: progress => { if (progress.source === 'codex' && !progress.complete && !progress.fileBytesTotal) scanProgress.push(progress.scanned); }
  });
  assert.deepStrictEqual(scanOrder, ['codex_thread-small-order', 'codex_thread-large-order'], 'smaller rollout results arrive before larger files even when their updated_at is older');
  assert.deepStrictEqual(sizeOrderedResults.map(item => item.id), ['codex_thread-large-order', 'codex_thread-small-order'], 'final results retain newest-first ordering regardless of scan order');
  assert.ok(scanProgress.length >= 2 && scanProgress.every((value, index) => value === index + 1), 'stream progress advances for each candidate Codex transcript');
  const brainScanOrder = [];
  const brainProgress = [];
  const brainOrderResults = await bridge.searchSessions('agyorderneedle', {
    onResult: item => brainScanOrder.push(item.id),
    onProgress: progress => { if (progress.source === 'antigravity' && !progress.complete && !progress.fileBytesTotal) brainProgress.push(progress.scanned); }
  });
  assert.deepStrictEqual(brainScanOrder, ['agy_agy-small', 'agy_agy-large'], 'smaller Antigravity transcripts yield results first');
  assert.deepStrictEqual(brainOrderResults.map(item => item.id), ['agy_agy-large', 'agy_agy-small'], 'Antigravity streaming returns results newest first after size-prioritized scan');
  assert.ok(brainProgress.length >= 2 && brainProgress.every((value, index) => value === index + 1), 'Antigravity progress advances for every transcript');
  assert.strictEqual((await bridge.searchSessions('needle gemini'))[0].id, 'agy_agy-1');
  assert.strictEqual((await bridge.searchSessions('한국어 검색어'))[0].id, 'codex_thread-unicode');
  assert.strictEqual((await bridge.searchSessions('검색어 query'))[0].id, 'codex_thread-unicode');
  assert.strictEqual((await bridge.searchSessions('글 hybridneedle'))[0].id, 'codex_thread-unicode', 'case-insensitive escaped anchor search finds an uppercase JSON Unicode escape');
  assert.strictEqual((await bridge.searchSessions('검색어 term'))[0].id, 'codex_thread-unicode');
  assert.strictEqual((await bridge.searchSessions('한글 hybridneedle'))[0].id, 'codex_thread-unicode');
  assert.strictEqual((await bridge.searchSessions('한글 Hangul')).length, 0, 'literal double-escaped Unicode is not decoded as Hangul');
  assert.strictEqual((await bridge.searchSessions('리터럴 검색어 함께'))[0].id, 'codex_thread-unicode');
  assert.strictEqual((await bridge.searchSessions('korean 한글'))[0].id, 'codex_thread-unicode');
  assert.strictEqual((await bridge.searchSessions('한글ABC'))[0].id, 'codex_thread-unicode', 'Unicode seed must remain case-safe when an ASCII suffix is uppercased');
  assert.strictEqual((await bridge.searchSessions('ü marker'))[0].id, 'codex_thread-unicode');
  assert.strictEqual((await bridge.searchSessions('Ü MARKER'))[0].id, 'codex_thread-unicode');
  assert.strictEqual((await bridge.searchSessions('ß marker'))[0].id, 'codex_thread-expanding-case');
  assert.strictEqual((await bridge.searchSessions('straße marker'))[0].id, 'codex_thread-expanding-case');
  assert.strictEqual((await bridge.searchSessions('한글'))[0].id, 'codex_thread-repeated', 'a query repeated many times in one JSONL record is still a single candidate line');
  assert.strictEqual((await bridge.searchSessions('codexrepeatneedle'))[0].id, 'codex_thread-repeated', 'an ASCII seed repeated many times in one JSONL record is scanned once');
  assert.strictEqual((await bridge.searchSessions('존재하지않는 다중어')).length, 0);
  assert.strictEqual((await bridge.searchSessions('한국어 없는항목')).length, 0);
  assert.strictEqual((await bridge.searchSessions('outsideonly')).length, 0);
  assert.strictEqual((await bridge.searchSessions('no-such-session-term')).length, 0);

  const modernDb = path.join(codexDir, 'state-modern.sqlite');
  const modernDbArg = JSON.stringify(modernDb);
  execFileSync(pythonExecutableForPlatform(), ['-c', `import sqlite3
c=sqlite3.connect(${modernDbArg})
c.execute("CREATE TABLE projects (id TEXT, name TEXT, position INTEGER)")
c.execute("CREATE TABLE threads (id TEXT, title TEXT, is_pinned INTEGER, thread_section_id TEXT, cwd TEXT, model TEXT, updated_at REAL, rollout_path TEXT, archived INTEGER, project_id TEXT, first_user_message TEXT, preview TEXT)")
c.execute("INSERT INTO projects VALUES (?, ?, ?)", ('project-1', 'Research Project', 2))
c.executemany("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
 ('pinned-1', 'Pinned chat', 1, '', ${JSON.stringify(home)}, 'test-model', 4, '', 0, None, None, None),
 ('project-1-chat', 'Project chat', 0, '', ${JSON.stringify(home)}, 'test-model', 3, '', 0, 'project-1', None, None),
 ('recent-1', 'Recent chat', 0, '', ${JSON.stringify(home)}, 'test-model', 2, ${JSON.stringify(smallOrderRollout)}, 0, None, 'Cached metadata phrase', 'Cached metadata phrase'),
 ('archived-1', 'Archived chat', 0, '', ${JSON.stringify(home)}, 'test-model', 5, '', 1, None, None, None),
 ('metadata-split', 'Metadata split', 0, '', ${JSON.stringify(home)}, 'test-model', 6, '', 0, None, 'metadata split', 'fields needle')
])
c.commit()`]);
  const modern = new NativeSessionBridge({ codexStateDb: modernDb, antigravityBrainDir: path.join(home, 'missing-brain') }).listUnifiedSessions();
  assert.deepStrictEqual(modern.pinned.map(session => session.rawId), ['pinned-1']);
  assert.strictEqual(modern.projects[0].name, 'Research Project');
  assert.deepStrictEqual(modern.projects[0].items.map(session => session.rawId), ['project-1-chat']);
  assert.deepStrictEqual(modern.sections.find(section => section.id === 'recents').items.map(session => session.rawId), ['metadata-split', 'recent-1']);
  const modernBridge = new NativeSessionBridge({ codexStateDb: modernDb, antigravityBrainDir: path.join(home, 'missing-brain') });
  assert.deepStrictEqual(modernBridge.loadCodexThreadMetadata().filter(session => session.isArchived).map(session => session.rawId), ['archived-1']);
  const metadataSearchProgress = [];
  const metadataSearchResults = await modernBridge.searchSessions('cached metadata phrase', {
    onProgress: progress => metadataSearchProgress.push(progress)
  });
  assert.deepStrictEqual(metadataSearchResults.map(session => session.id), ['codex_recent-1'], 'Codex first-message/preview metadata can return a hit without reading its rollout');
  assert.deepStrictEqual(metadataSearchProgress.filter(progress => progress.fileBytesTotal > 0), [], 'metadata hits bypass full-transcript byte scanning');
  assert.deepStrictEqual(await modernBridge.searchSessions('metadata needle'), [], 'terms split across metadata fields do not create a false hit');

  if (process.platform !== 'win32') {
    const sleepingPython = path.join(root, 'sleeping-python');
    const childPidFile = path.join(root, 'search-child.pid');
    fs.writeFileSync(sleepingPython, `#!/bin/sh\nprintf '%s' "$$" > ${JSON.stringify(childPidFile)}\nexec sleep 30\n`, { mode: 0o700 });
    const cancellableBridge = new NativeSessionBridge({
      codexStateDb: codexDb,
      antigravityBrainDir: path.join(home, 'missing-brain'),
      pythonExecutable: sleepingPython
    });
    const controller = new AbortController();
    const cancelledSearch = cancellableBridge.searchSessions('cancel this search', { signal: controller.signal });
    const childPidDeadline = Date.now() + 2000;
    while (!fs.existsSync(childPidFile) && Date.now() < childPidDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(fs.existsSync(childPidFile), 'search child process should start before cancellation');
    const childPid = Number(fs.readFileSync(childPidFile, 'utf8'));
    controller.abort();
    await assert.rejects(cancelledSearch, error => error.name === 'AbortError');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.throws(() => process.kill(childPid, 0), error => error.code === 'ESRCH', 'aborting session search must terminate its Python child');
  }

  const ui = path.join(__dirname, '../src/ui/desktop');
  assert.match(fs.readFileSync(path.join(ui, 'index.html'), 'utf8'), /id="pinnedSessionList"/);
  assert.match(fs.readFileSync(path.join(ui, 'app.js'), 'utf8'), /renderProjectGroups\(projectList/);
  console.log('✓ read-only Codex session/project lookup, pinned/project grouping, and Antigravity resume passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
