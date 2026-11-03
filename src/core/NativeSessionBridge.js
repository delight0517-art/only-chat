/**
 * @project Only Chat (Codex Sovereign Edition)
 * @provenance:rogan-core
 * @license MIT
 * @description Bridges and imports active/past sessions directly from native Codex (state_5.sqlite & rollouts)
 * and Google Antigravity (brain transcript logs) so users can seamlessly resume them in Only Chat.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, execFileSync } = require('node:child_process');

function pythonExecutableForPlatform(platform = process.platform) {
  return platform === 'win32' ? 'python' : 'python3';
}

function isSafeSessionSegment(value) {
  return typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..'
    && !/[\\/\0]/.test(value) && !path.isAbsolute(value);
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

class NativeSessionBridge {
  constructor(options = {}) {
    this.codexStateDb = options.codexStateDb || path.join(os.homedir(), '.codex/state_5.sqlite');
    this.codexQueueDb = options.codexQueueDb || path.join(os.homedir(), '.codex/queue_1.sqlite');
    this.antigravityBrainDir = options.antigravityBrainDir || path.join(os.homedir(), '.gemini/antigravity/brain');
    this.pythonExecutable = options.pythonExecutable || pythonExecutableForPlatform();
  }

  _runPython(script, options = {}) {
    return execFileSync(this.pythonExecutable, ['-c', script], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  }

  _runPythonAsync(script, options = {}) {
    return new Promise((resolve, reject) => {
      const { onStdoutChunk, ...execOptions } = options;
      const child = execFile(this.pythonExecutable, ['-c', script], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...execOptions }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
      if (typeof onStdoutChunk === 'function') {
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', onStdoutChunk);
      }
    });
  }

  async searchSessions(query, options = {}) {
    const normalizedQuery = String(query || '').trim().toLocaleLowerCase();
    if (!normalizedQuery) return [];

    const searchText = JSON.stringify(normalizedQuery);
    const dbPath = JSON.stringify(this.codexStateDb);
    const brainDir = JSON.stringify(this.antigravityBrainDir);
    const streamResults = typeof options.onResult === 'function' || typeof options.onProgress === 'function';
    const pythonScript = `
import glob, json, mmap, os, pathlib, re, sqlite3

query = ${searchText}
stream_results = ${streamResults ? 'True' : 'False'}
terms = query.split()
# Safe Unicode searches scan from a raw non-ASCII seed and retain escaped JSON lines for decoding.
ascii_query = query.isascii()
terms_bytes = [term.encode('ascii') for term in terms] if ascii_query else []
unicode_terms_bytes = [term.encode('utf-8') for term in terms] if not ascii_query else []
# UTF-8 byte filtering is exact for uncased scripts (for example Korean) and
# ASCII letters after bytes.lower(); other Unicode case mappings use full JSON parsing.
unicode_byte_prefilter_safe = not ascii_query and all(
    all(ord(char) < 128 or (char.lower() == char and char.upper() == char and char.casefold() == char) for char in term)
    for term in terms
)
unicode_query_has_ascii_letters = any(
    65 <= byte <= 90 or 97 <= byte <= 122
    for term in unicode_terms_bytes for byte in term
)
non_ascii_pattern = re.compile('[^' + chr(0) + '-' + chr(127) + ']+')
unicode_seed = max(
    (match.encode('utf-8') for term in terms for match in non_ascii_pattern.findall(term)),
    key=len,
    default=b''
)
unicode_anchor = unicode_seed.decode('utf-8')[0] if unicode_seed and unicode_byte_prefilter_safe else ''
unicode_anchor_raw = unicode_anchor.encode('utf-8') if unicode_anchor else b''
unicode_anchor_escaped = json.dumps(unicode_anchor, ensure_ascii=True)[1:-1].encode('ascii') if unicode_anchor else b''
unicode_anchor_escape_pattern = re.compile(re.escape(unicode_anchor_escaped), re.IGNORECASE) if unicode_anchor_escaped else None
unicode_candidate_needles = (unicode_seed, b'\\\\u') if unicode_seed else ()
ascii_term_patterns = [re.compile(re.escape(term), re.IGNORECASE) for term in terms_bytes] if ascii_query else []
ascii_seed_bytes = max(terms_bytes, key=len) if terms_bytes else b''
ascii_seed_pattern = re.compile(re.escape(ascii_seed_bytes), re.IGNORECASE) if ascii_seed_bytes else None
scan_chunk_bytes = 16 * 1024 * 1024
results = []

def emit_scan_progress(scanned, total, source, file_bytes_scanned, file_bytes_total):
    if stream_results:
        print(json.dumps({
            'type': 'progress', 'scanned': scanned, 'total': total, 'source': source,
            'fileBytesScanned': file_bytes_scanned, 'fileBytesTotal': file_bytes_total
        }), flush=True)

def add_result(item):
    results.append(item)
    if stream_results:
        print(json.dumps({'type': 'result', 'item': item}, ensure_ascii=False), flush=True)

def candidate_line_starts(data, needles, on_progress=None, candidate_anchors=()):
    size = len(data)
    overlap = max((len(needle) for needle in needles), default=1) - 1
    last_line_start = -1
    covered_line_end = -1
    for chunk_start in range(0, size, scan_chunk_bytes):
        primary_end = min(size, chunk_start + scan_chunk_bytes)
        search_start = max(0, chunk_start - overlap, covered_line_end + 1)
        search_end = min(size, primary_end + overlap)
        found_line_starts = set()
        found_line_ends = {}
        for needle in needles:
            offset = search_start
            while True:
                found = data.find(needle, offset, search_end)
                if found < 0 or found >= primary_end:
                    break
                line_start = data.rfind(b'\\n', 0, found) + 1
                line_end = data.find(b'\\n', line_start)
                line_limit = line_end if line_end >= 0 else size
                found_line_ends[line_start] = max(found_line_ends.get(line_start, -1), line_limit)
                if needle == b'\\\\u' and candidate_anchors:
                    has_anchor = data.find(candidate_anchors[0], line_start, line_limit) >= 0
                    if not has_anchor and len(candidate_anchors) > 1:
                        has_anchor = candidate_anchors[1].search(data, line_start, line_limit) is not None
                    if not has_anchor:
                        offset = line_end + 1 if line_end >= 0 else size
                        continue
                if line_start > last_line_start:
                    found_line_starts.add(line_start)
                # One candidate per JSONL record is enough; skip repeated seeds
                # on the same (possibly very large) line.
                offset = line_end + 1 if line_end >= 0 else size
        if found_line_ends:
            covered_line_end = max(covered_line_end, max(found_line_ends.values()))
        for line_start in sorted(found_line_starts):
            if line_start <= last_line_start:
                continue
            last_line_start = line_start
            yield line_start
        if on_progress:
            on_progress(primary_end, size)

def candidate_lines(path, on_progress=None):
    with open(path, 'rb') as source:
        if not ascii_query:
            if not unicode_byte_prefilter_safe:
                scanned = 0
                next_progress = scan_chunk_bytes
                file_size = os.fstat(source.fileno()).st_size
                for line in source:
                    yield line
                    scanned += len(line)
                    if on_progress and scanned >= next_progress:
                        on_progress(min(scanned, file_size), file_size)
                        next_progress = scanned + scan_chunk_bytes
                return
            if not unicode_seed:
                return
        if not ascii_query or os.fstat(source.fileno()).st_size:
            if not os.fstat(source.fileno()).st_size:
                return
            with mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ) as data:
                if not ascii_query:
                    for start in candidate_line_starts(data, unicode_candidate_needles, on_progress, (unicode_anchor_raw, unicode_anchor_escape_pattern) if unicode_anchor_raw else ()):
                        end = data.find(b'\\n', start)
                        if end < 0:
                            end = len(data)
                        line = data[start:end]
                        candidate = line.lower() if unicode_query_has_ascii_letters else line
                        if b'\\\\u' in line or all(term in candidate for term in unicode_terms_bytes):
                            yield line
                    return
                size = len(data)
                last_line_start = -1
                last_line_end = -1
                seed_size = len(ascii_seed_bytes)
                for chunk_start in range(0, size, scan_chunk_bytes):
                    primary_end = min(size, chunk_start + scan_chunk_bytes)
                    search_start = max(0, chunk_start - seed_size + 1)
                    search_end = min(size, primary_end + seed_size - 1)
                    block = data[search_start:search_end]
                    offset = 0
                    while True:
                        match = ascii_seed_pattern.search(block, offset)
                        if match is None:
                            break
                        absolute = search_start + match.start()
                        if absolute < chunk_start:
                            offset = match.end()
                            continue
                        if absolute >= primary_end:
                            break
                        if absolute < last_line_end:
                            offset = max(match.end(), last_line_end - search_start + 1)
                            continue
                        start = data.rfind(b'\\n', 0, absolute) + 1
                        last_line_start = start
                        end = data.find(b'\\n', absolute)
                        if end < 0:
                            end = size
                        last_line_end = end
                        line = data[start:end]
                        if all(pattern.search(line) for pattern in ascii_term_patterns):
                            yield line
                        offset = max(match.end(), end - search_start + 1)
                    if on_progress:
                        on_progress(primary_end, size)

def hit(text):
    text = text or ''
    lowered = text.lower()
    positions = [lowered.find(term) for term in terms]
    if not positions or any(position < 0 for position in positions):
        return None
    start = max(0, min(positions) - 60)
    snippet = text[start:start + 180].replace('\\n', ' ').replace('\\r', ' ').strip()
    return ('…' if start else '') + snippet + ('…' if start + 180 < len(text) else '')

def title_from(value):
    title = str(value or 'Untitled')
    if title.startswith('# Files mentioned') and '## My request:' in title:
        title = title.split('## My request:', 1)[1].strip()
    return title.split('\\n')[0][:55]

def inside(root, candidate):
    try:
        return os.path.commonpath([root, candidate]) == root
    except ValueError:
        return False

def safe_file_size(roots, candidate):
    try:
        real_path = os.path.realpath(candidate)
        if not any(inside(root, real_path) for root in roots) or not os.path.isfile(real_path):
            return float('inf')
        return os.path.getsize(real_path)
    except (OSError, ValueError):
        return float('inf')

db_path = ${dbPath}
db_uri = pathlib.Path(db_path).resolve().as_uri() + '?mode=ro'
codex_root = os.path.realpath(os.path.dirname(db_path))
allowed_rollout_roots = [os.path.realpath(os.path.join(codex_root, name)) for name in ('sessions', 'archived_sessions')]
if os.path.exists(db_path):
    try:
        con = sqlite3.connect(db_uri, uri=True)
        columns = {row[1] for row in con.execute('PRAGMA table_info(threads)')}
        metadata_fields = [field for field in ('first_user_message', 'preview') if field in columns]
        selected_fields = ['id', 'title', 'updated_at', 'rollout_path', *metadata_fields]
        rows = con.execute('SELECT ' + ', '.join('"' + field + '"' for field in selected_fields) + ' FROM threads').fetchall()
        con.close()
        metadata_matches = []
        metadata_match_ids = set()
        for row in rows:
            raw_id, raw_title, updated_at = row[:3]
            title = title_from(raw_title)
            excerpt = None
            for metadata_text in (title, *(str(value or '') for value in row[4:])):
                excerpt = hit(metadata_text)
                if excerpt:
                    break
            if excerpt:
                metadata_match_ids.add(raw_id)
                metadata_matches.append({'id': 'codex_' + raw_id, 'source': 'codex', 'title': title, 'updatedAt': (updated_at or 0) * 1000, 'snippet': excerpt})
        metadata_matches.sort(key=lambda item: item['updatedAt'], reverse=True)
        for item in metadata_matches:
            add_result(item)
        # Search small transcripts first so useful matches appear before a single huge rollout stalls the scan.
        rows.sort(key=lambda row: safe_file_size(allowed_rollout_roots, row[3]) if row[3] else 0)
        for thread_index, row in enumerate(rows, 1):
            raw_id, raw_title, updated_at, rollout_path = row[:4]
            emit_scan_progress(thread_index, len(rows), 'codex', 0, 0)
            if raw_id in metadata_match_ids:
                continue
            title = title_from(raw_title)
            excerpt = hit(title)
            if not excerpt and rollout_path:
                real_path = os.path.realpath(rollout_path)
                if any(inside(root, real_path) for root in allowed_rollout_roots):
                    try:
                        on_progress = lambda scanned, total: emit_scan_progress(thread_index, len(rows), 'codex', scanned, total)
                        for line in candidate_lines(real_path, on_progress):
                            try:
                                record = json.loads(line)
                                payload = record.get('payload', {})
                                content = ''
                                if record.get('type') == 'event_msg' and payload.get('type') == 'user_message':
                                    content = payload.get('message', '')
                                elif record.get('type') == 'response_item' and payload.get('role') == 'assistant':
                                    content = ''.join(part.get('text', '') for part in payload.get('content', []) if part.get('type') in ('output_text', 'text'))
                                excerpt = hit(content)
                                if excerpt:
                                    break
                            except Exception:
                                continue
                    except (OSError, ValueError):
                        pass
            if excerpt:
                add_result({'id': 'codex_' + raw_id, 'source': 'codex', 'title': title, 'updatedAt': (updated_at or 0) * 1000, 'snippet': excerpt})
    except Exception:
        pass

brain_dir = os.path.realpath(${brainDir})
if os.path.isdir(brain_dir):
    transcripts = glob.glob(os.path.join(brain_dir, '*', '.system_generated', 'logs', 'transcript.jsonl'))
    transcripts.sort(key=lambda transcript: safe_file_size([brain_dir], transcript))
    for transcript_index, transcript in enumerate(transcripts, 1):
        emit_scan_progress(transcript_index, len(transcripts), 'antigravity', 0, 0)
        real_path = os.path.realpath(transcript)
        if not inside(brain_dir, real_path):
            continue
        raw_id = os.path.basename(os.path.dirname(os.path.dirname(os.path.dirname(real_path))))
        title = 'Antigravity Session'
        excerpt = None
        try:
            on_progress = lambda scanned, total: emit_scan_progress(transcript_index, len(transcripts), 'antigravity', scanned, total)
            for line in candidate_lines(real_path, on_progress):
                try:
                    record = json.loads(line)
                    kind = record.get('type')
                    content = record.get('content', '') or ''
                    if kind == 'USER_INPUT':
                        content = content.replace('<USER_REQUEST>', '').replace('</USER_REQUEST>', '').strip()
                        if title == 'Antigravity Session':
                            title = title_from(content)
                    elif kind != 'PLANNER_RESPONSE':
                        continue
                    excerpt = hit(content)
                    if excerpt:
                        break
                except Exception:
                    continue
            if excerpt:
                add_result({'id': 'agy_' + raw_id, 'source': 'antigravity', 'title': title, 'updatedAt': int(os.path.getmtime(real_path) * 1000), 'snippet': excerpt})
        except (OSError, ValueError):
            pass

results.sort(key=lambda item: item['updatedAt'], reverse=True)
if stream_results:
    print(json.dumps({'type': 'complete', 'count': len(results)}), flush=True)
else:
    print(json.dumps(results, ensure_ascii=False))
`;
    if (streamResults) {
      const streamedResults = [];
      let pending = '';
      let parseError = null;
      await this._runPythonAsync(pythonScript, {
        timeout: 120000,
        signal: options.signal,
        onStdoutChunk: chunk => {
          pending += chunk;
          let newline;
          while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (!line) continue;
            try {
              const event = JSON.parse(line);
              if (event.type === 'result' && event.item) {
                streamedResults.push(event.item);
                options.onResult?.(event.item);
              } else if (event.type === 'progress') {
                options.onProgress?.({ scanned: event.scanned, total: event.total, source: event.source, fileBytesScanned: event.fileBytesScanned, fileBytesTotal: event.fileBytesTotal });
              } else if (event.type === 'complete') {
                options.onProgress?.({ complete: true, resultCount: event.count });
              }
            } catch (error) {
              parseError = error;
            }
          }
        }
      });
      if (pending.trim()) {
        try {
          const event = JSON.parse(pending);
          if (event.type === 'complete') options.onProgress?.({ complete: true, resultCount: event.count });
        } catch (error) { parseError = error; }
      }
      if (parseError) throw parseError;
      streamedResults.sort((a, b) => b.updatedAt - a.updatedAt);
      return streamedResults;
    }
    const out = await this._runPythonAsync(pythonScript, { timeout: 120000, signal: options.signal });
    return JSON.parse(out.trim() || '[]');
  }

  /**
   * List unified sessions across Codex, Antigravity, and Only Chat
   */
  listUnifiedSessions() {
    const codexSessions = this.loadCodexSessions();
    const projects = this.loadCodexProjects();
    const projectById = new Map(projects.map(project => [project.id, project]));
    for (const session of codexSessions) {
      if (!session.projectId || session.isPinned) continue;
      let project = projectById.get(session.projectId);
      if (!project) {
        project = { id: session.projectId, name: 'Project', position: Number.MAX_SAFE_INTEGER, items: [] };
        projects.push(project);
        projectById.set(project.id, project);
      }
      project.items.push(session);
    }
    projects.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    const antigravitySessions = this.loadAntigravitySessions();
    const recents = [...codexSessions.filter(s => !s.isPinned && !s.projectId), ...antigravitySessions]
      .sort((a, b) => b.updatedAt - a.updatedAt);

    return {
      pinned: codexSessions.filter(s => s.isPinned),
      sections: [
        {
          id: 'pinned',
          name: 'Pinned',
          items: codexSessions.filter(s => s.isPinned)
        },
        {
          id: 'projects',
          name: 'Projects >',
          items: projects.flatMap(project => project.items)
        },
        {
          id: 'recents',
          name: 'Recents',
          items: recents.slice(0, 200)
        },
        {
          id: 'antigravity',
          name: 'Antigravity 세션',
          items: antigravitySessions.slice(0, 15)
        }
      ],
      projects,
      allCount: codexSessions.length + antigravitySessions.length
    };
  }

  loadCodexSessions() {
    if (!fs.existsSync(this.codexStateDb)) return [];

    try {
      const dbPath = JSON.stringify(this.codexStateDb);
      const pythonScript = `
import sqlite3, json, sys, os, pathlib
try:
    db_uri = pathlib.Path(${dbPath}).resolve().as_uri() + '?mode=ro'
    con = sqlite3.connect(db_uri, uri=True)
    cur = con.cursor()
    columns = {row[1] for row in cur.execute('PRAGMA table_info(threads)')}
    if 'id' not in columns:
        print('[]')
        raise SystemExit
    fields = ('id', 'title', 'is_pinned', 'thread_section_id', 'cwd', 'model', 'updated_at', 'rollout_path', 'project_id')
    selected = [field for field in fields if field in columns]
    order = ' ORDER BY updated_at DESC' if 'updated_at' in columns else ''
    where = ' WHERE archived = 0' if 'archived' in columns else ''
    cur.execute('SELECT ' + ', '.join('"' + field + '"' for field in selected) + ' FROM threads' + where + order + ' LIMIT 2000')
    rows = cur.fetchall()
    res = []
    for r in rows:
        row = dict(zip(selected, r))
        title = row.get('title') or 'Untitled'
        # Clean title
        if title.startswith('# Files mentioned'):
            # Extract request part
            if '## My request:' in title:
                title = title.split('## My request:')[1].strip()
        title = title.split('\\n')[0][:55]
        res.append({
            'source': 'codex',
            'id': 'codex_' + row['id'],
            'rawId': row['id'],
            'title': title,
            'isPinned': bool(row.get('is_pinned')),
            'sectionId': row.get('thread_section_id'),
            'cwd': row.get('cwd') or os.path.expanduser('~'),
            'model': row.get('model') or 'gpt-6-luna',
            'updatedAt': (row.get('updated_at') or 0) * 1000,
            'rolloutPath': row.get('rollout_path') or '',
            'projectId': row.get('project_id')
        })
    print(json.dumps(res))
except Exception as e:
    print('[]')
`;
      const out = this._runPython(pythonScript);
      return JSON.parse(out.trim() || '[]');
    } catch (_) {
      return [];
    }
  }

  /** Read Codex's queued user inputs without changing the Codex queue. */
  loadCodexQueuedItems() {
    if (!fs.existsSync(this.codexQueueDb)) return { available: false, error: 'database_missing', count: 0, items: [] };
    try {
      const dbPath = JSON.stringify(this.codexQueueDb);
      const pythonScript = `
import json, pathlib, sqlite3
db_path = ${dbPath}
db_uri = pathlib.Path(db_path).resolve().as_uri() + '?mode=ro'
try:
    con = sqlite3.connect(db_uri, uri=True)
    try:
        columns = {row[1] for row in con.execute('PRAGMA table_info(queued_items)')}
        required = {'id', 'thread_id', 'payload_json', 'queue_order', 'created_at_ms', 'updated_at_ms'}
        if not required.issubset(columns):
            print(json.dumps({'available': False, 'error': 'unsupported_schema', 'count': 0, 'items': []}))
        else:
            rows = con.execute('SELECT id, thread_id, payload_json, queue_order, created_at_ms, updated_at_ms FROM queued_items ORDER BY thread_id, queue_order, created_at_ms').fetchall()
            items = []
            for item_id, thread_id, raw_payload, queue_order, created_at, updated_at in rows:
                try:
                    payload = json.loads(raw_payload)
                    user_input = payload.get('UserInput', {}) if isinstance(payload, dict) else {}
                    blocks = user_input.get('content', []) if isinstance(user_input, dict) else []
                    text_parts = []
                    has_image = False
                    has_unsupported_content = False
                    for block in blocks if isinstance(blocks, list) else []:
                        if not isinstance(block, dict):
                            has_unsupported_content = True
                            continue
                        if block.get('type') == 'text' and isinstance(block.get('text'), str):
                            text_parts.append(block['text'])
                        elif block.get('type') == 'image':
                            has_image = True
                        else:
                            has_unsupported_content = True
                    prompt = '\\n'.join(part for part in text_parts if part).strip()
                    if has_image:
                        prompt = (prompt + '\\n[Image attachment omitted]').strip()
                    if has_unsupported_content:
                        prompt = (prompt + '\\n[Unsupported attachment or content omitted]').strip()
                    if not prompt:
                        if not (has_image or has_unsupported_content):
                            continue
                        prompt = '[Codex request contains attachment content that Only Chat cannot receive]'
                    prompt_truncated = len(prompt) > 65536
                    if prompt_truncated:
                        prompt = prompt[:65450] + '\\n[Codex request truncated by Only Chat; original remains in Codex]'
                    items.append({
                        'id': item_id,
                        'threadId': thread_id,
                        'queueOrder': queue_order,
                        'createdAt': created_at,
                        'updatedAt': updated_at,
                        'title': prompt.splitlines()[0][:100] or 'Codex queued task',
                        'prompt': prompt,
                        'hasImageAttachment': has_image,
                        'hasUnsupportedContent': has_image or has_unsupported_content,
                        'promptTruncated': prompt_truncated
                    })
                except Exception:
                    continue
            print(json.dumps({'available': True, 'error': None, 'count': len(items), 'items': items}, ensure_ascii=False))
    finally:
        con.close()
except Exception:
    print(json.dumps({'available': False, 'error': 'read_failed', 'count': 0, 'items': []}))
`;
      const out = this._runPython(pythonScript);
      const inbox = JSON.parse(out.trim() || '{}');
      if (!inbox || typeof inbox !== 'object' || typeof inbox.available !== 'boolean' || !Array.isArray(inbox.items)) {
        return { available: false, error: 'invalid_response', count: 0, items: [] };
      }
      return inbox;
    } catch (_) {
      return { available: false, error: 'read_failed', count: 0, items: [] };
    }
  }

  /** Read Codex thread titles and archive state for queued-item source labels. */
  loadCodexThreadMetadata() {
    if (!fs.existsSync(this.codexStateDb)) return [];
    try {
      const dbPath = JSON.stringify(this.codexStateDb);
      const pythonScript = `
import json, pathlib, sqlite3
db_uri = pathlib.Path(${dbPath}).resolve().as_uri() + '?mode=ro'
try:
    con = sqlite3.connect(db_uri, uri=True)
    try:
        columns = {row[1] for row in con.execute('PRAGMA table_info(threads)')}
        if not {'id', 'title'}.issubset(columns):
            print('[]')
        else:
            archived = 'archived' if 'archived' in columns else '0'
            rows = con.execute('SELECT id, title, ' + archived + ' FROM threads').fetchall()
            result = []
            for thread_id, raw_title, is_archived in rows:
                title = str(raw_title or 'Untitled')
                if title.startswith('# Files mentioned') and '## My request:' in title:
                    title = title.split('## My request:', 1)[1].strip()
                result.append({'rawId': thread_id, 'title': title.split('\\n')[0][:55], 'isArchived': bool(is_archived)})
            print(json.dumps(result, ensure_ascii=False))
    finally:
        con.close()
except Exception:
    print('[]')
`;
      const out = this._runPython(pythonScript);
      const metadata = JSON.parse(out.trim() || '[]');
      return Array.isArray(metadata) ? metadata.filter(item => item && typeof item.rawId === 'string'
        && typeof item.title === 'string' && typeof item.isArchived === 'boolean') : [];
    } catch (_) {
      return [];
    }
  }

  loadCodexProjects() {
    if (!fs.existsSync(this.codexStateDb)) return [];
    try {
      const dbPath = JSON.stringify(this.codexStateDb);
      const script = `
import json, pathlib, sqlite3
db_uri = pathlib.Path(${dbPath}).resolve().as_uri() + '?mode=ro'
con = sqlite3.connect(db_uri, uri=True)
try:
    columns = {row[1] for row in con.execute('PRAGMA table_info(projects)')}
    if not {'id', 'name'}.issubset(columns):
        rows = []
    else:
        position = 'position' if 'position' in columns else '0'
        rows = con.execute('SELECT id, name, ' + position + ' FROM projects ORDER BY ' + position + ', name').fetchall()
    print(json.dumps([{'id': row[0], 'name': row[1] or 'Project', 'position': row[2] or 0, 'items': []} for row in rows]))
finally:
    con.close()
`;
      return JSON.parse(this._runPython(script).trim() || '[]');
    } catch (_) { return []; }
  }

  loadAntigravitySessions() {
    if (!fs.existsSync(this.antigravityBrainDir)) return [];

    try {
      const brainDir = JSON.stringify(this.antigravityBrainDir);
      const pythonScript = `
import os, json, glob
brain_dir = ${brainDir}
convs = []
for p in glob.glob(os.path.join(brain_dir, '*', '.system_generated', 'logs', 'transcript.jsonl')):
    conv_id = os.path.basename(os.path.dirname(os.path.dirname(os.path.dirname(p))))
    mtime = os.path.getmtime(p)
    title = 'Antigravity Session'
    try:
        with open(p, 'r') as f:
            for line in f:
                d = json.loads(line)
                if d.get('type') == 'USER_INPUT':
                    content = d.get('content', '').replace('<USER_REQUEST>', '').replace('</USER_REQUEST>', '').strip()
                    title = content.split('\\n')[0][:55]
                    break
    except:
        pass
    convs.append({
        'source': 'antigravity',
        'id': 'agy_' + conv_id,
        'rawId': conv_id,
        'title': title,
        'isPinned': False,
        'cwd': os.path.expanduser('~'),
        'model': 'gemini-3.8-flash-med',
        'updatedAt': int(mtime * 1000),
        'transcriptPath': p
    })
convs.sort(key=lambda x: x['updatedAt'], reverse=True)
print(json.dumps(convs[:25]))
`;
      const out = this._runPython(pythonScript);
      return JSON.parse(out.trim() || '[]');
    } catch (_) {
      return [];
    }
  }

  /**
   * Resume and load full transcript/turns of an external session
   */
  resumeSession(sessionId) {
    if (typeof sessionId !== 'string') return null;
    if (sessionId.startsWith('codex_')) {
      const rawId = sessionId.slice('codex_'.length);
      if (!isSafeSessionSegment(rawId)) return null;
      return this._resumeCodexSession(rawId);
    } else if (sessionId.startsWith('agy_')) {
      const rawId = sessionId.slice('agy_'.length);
      if (!isSafeSessionSegment(rawId)) return null;
      return this._resumeAntigravitySession(rawId);
    }
    return null;
  }

  _resumeCodexSession(rawId) {
    // 1. Find rollout path from DB
    try {
      const dbPath = JSON.stringify(this.codexStateDb);
      const sessionId = JSON.stringify(rawId);
      const pythonScript = `
import sqlite3, json, os, pathlib
db_path = ${dbPath}
db_uri = pathlib.Path(db_path).resolve().as_uri() + '?mode=ro'
con = sqlite3.connect(db_uri, uri=True)
cur = con.cursor()
cur.execute('SELECT title, cwd, model, rollout_path FROM threads WHERE id = ?;', (${sessionId},))
row = cur.fetchone()
if not row:
    print('null')
    exit()

def inside(root, candidate):
    try:
        return os.path.commonpath([root, candidate]) == root
    except ValueError:
        return False

title, cwd, model, rollout_path = row
turns = []

codex_root = os.path.realpath(os.path.dirname(db_path))
allowed_rollout_roots = [os.path.realpath(os.path.join(codex_root, name)) for name in ('sessions', 'archived_sessions')]
if rollout_path:
    real_rollout_path = os.path.realpath(rollout_path)
    if not any(inside(root, real_rollout_path) for root in allowed_rollout_roots):
        rollout_path = None

if rollout_path and os.path.isfile(rollout_path):
    with open(rollout_path, 'r') as f:
        for line in f:
            try:
                d = json.loads(line)
                t = d.get('type')
                p = d.get('payload', {})
                if t == 'event_msg' and p.get('type') == 'user_message':
                    turns.append({'role': 'user', 'content': p.get('message', '')})
                elif t == 'response_item' and isinstance(p, dict) and p.get('role') == 'assistant':
                    txt = ''
                    for c in p.get('content', []):
                        if c.get('type') in ('output_text', 'text'):
                            txt += c.get('text', '')
                    if txt:
                        turns.append({'role': 'assistant', 'content': txt})
            except:
                pass

print(json.dumps({
    'id': 'codex_' + ${sessionId},
    'title': title or 'Codex Session',
    'cwd': cwd or os.path.expanduser('~'),
    'model': model or 'gpt-6-luna',
    'source': 'codex',
    'turns': turns
}))
`;
      const out = this._runPython(pythonScript);
      return JSON.parse(out.trim() || 'null');
    } catch (err) {
      return { error: err.message };
    }
  }

  _resumeAntigravitySession(rawId) {
    let transcriptPath;
    try {
      const brainRoot = fs.realpathSync(this.antigravityBrainDir);
      const sessionRoot = path.resolve(brainRoot, rawId);
      if (!isPathInside(brainRoot, sessionRoot)) return null;
      transcriptPath = fs.realpathSync(path.join(sessionRoot, '.system_generated/logs/transcript.jsonl'));
      if (!isPathInside(brainRoot, transcriptPath) || !fs.statSync(transcriptPath).isFile()) return null;
    } catch (_) {
      return null;
    }

    try {
      const transcript = JSON.stringify(transcriptPath);
      const sessionId = JSON.stringify(rawId);
      const pythonScript = `
import json, os
path = ${transcript}
turns = []
title = 'Antigravity Session'
with open(path, 'r') as f:
    for line in f:
        try:
            d = json.loads(line)
            t = d.get('type')
            c = d.get('content', '')
            if t == 'USER_INPUT':
                clean_c = c.replace('<USER_REQUEST>', '').replace('</USER_REQUEST>', '').strip()
                if not turns:
                    title = clean_c.split('\\n')[0][:50]
                turns.append({'role': 'user', 'content': clean_c})
            elif t == 'PLANNER_RESPONSE':
                if c.strip():
                    turns.append({'role': 'assistant', 'content': c.strip()})
        except:
            pass

print(json.dumps({
    'id': 'agy_' + ${sessionId},
    'title': title,
    'cwd': os.path.expanduser('~'),
    'model': 'gemini-3.8-flash-med',
    'source': 'antigravity',
    'turns': turns
}))
`;
      const out = this._runPython(pythonScript);
      return JSON.parse(out.trim() || 'null');
    } catch (err) {
      return { error: err.message };
    }
  }
}

module.exports = { NativeSessionBridge, pythonExecutableForPlatform };
