import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { blocks, chunk, clean, hash, redact, redactAll } from './shared.mjs';
import { timelineBuilder } from './timeline.mjs';
import { DEFAULT_RETENTION_DAYS, pruneOld } from './cleanup.mjs';
import { homeDir } from './paths.mjs';

const [transcript, root, sessionId, cutoffRaw, projectDir = path.dirname(transcript), mode = 'lexical', trigger = 'cut', retentionRaw = String(DEFAULT_RETENTION_DAYS)] = process.argv.slice(2);
// After an answer the index is refreshed only once the transcript grew by this much, so short turns cost nothing.
const TURN_MIN_GROWTH = 32 * 1024;
const KEEP_GENERATIONS = 3;
const cutoffByte = Number(cutoffRaw);
const dir = path.join(root, hash(sessionId));
fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
// Every turn marks the index as in use, also one too small to rebuild, so retention never ages out a resumed session.
// The raw session id in it links the index to its capture directory (named by the sanitized id) before any manifest.
try { fs.writeFileSync(path.join(dir, 'ACTIVE'), sessionId, { mode: 0o600 }); } catch {}
const lock = path.join(dir, 'BUILD_LOCK'), pending = path.join(dir, 'PENDING_CUTOFF');
const published = trigger === 'turn' ? publishedCutoff(dir) : -1;
if (published >= 0 && cutoffByte - published < TURN_MIN_GROWTH) process.exit(0);
// A lock whose owner pid is gone (killed worker) is stale; drop it once so builds do not stall forever.
function ownerAlive() { try { const pid = Number(fs.readFileSync(lock, 'utf8').trim()); if (!pid) return false; process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } }
function takeLock() { try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); return true; } catch { return false; } }
let locked = takeLock();
if (!locked && !ownerAlive()) { try { fs.unlinkSync(lock); } catch {} locked = takeLock(); }
if (!locked) {
  let existing = 0; try { existing = Number(fs.readFileSync(pending, 'utf8').trim()) || 0; } catch {}
  const temp = `${pending}.${process.pid}.tmp`;
  fs.writeFileSync(temp, String(Math.max(existing, cutoffByte)), { mode: 0o600 }); fs.renameSync(temp, pending);
  process.exit(0);
}
const redactPath = (value) => (typeof value === 'string' ? redactAll(value) : value);
const redactRow = (row) => ({ ...row, text: redact(row.text), ...(row.filePath === undefined ? {} : { filePath: redactPath(row.filePath) }) });
try {
  const own = parseTranscript(transcript, cutoffByte, sessionId);
  const parent = findParentPrefix(transcript, projectDir, own.parentUuid);
  // Rows carried over from a stored index are redacted again: an index built by an older redactor still holds keys
  // that the current patterns catch, and rows are never re-read from the transcript.
  const parentRows = (parent ? loadParentPrefix(root, parent) : []).map(redactRow);
  const rows = own.rows;
  const previous = readLatest(dir);
  if (previous && cutoffByte <= previous.manifest.cutoffPosition) {
    fs.unlinkSync(lock);
    process.exit(0);
  }
  // Rows built before 3.29.0 have no segment; this session's own rows get it from the boundaries parsed now.
  const oldRows = (previous?.rows ?? []).filter((row) => row.sourceSessionId === sessionId)
    .map((row) => ({ ...redactRow(row), segment: own.segmentAt(row.position) }));
  const seenIds = new Set(oldRows.map((row) => row.sourceId));
  const exactText = new Set(parentRows.map((row) => row.text));
  for (const row of oldRows) exactText.add(row.text);
  const appended = rows.filter((row) => {
    if (row.position < (previous?.manifest.cutoffPosition ?? -1) || seenIds.has(row.sourceId) || exactText.has(row.text)) return false;
    seenIds.add(row.sourceId); exactText.add(row.text); return true;
  });
  const all = [], publishedText = new Set();
  for (const row of [...parentRows, ...oldRows, ...appended]) if (!publishedText.has(row.text)) {
    publishedText.add(row.text); all.push(row);
  }
  const existing = fs.readdirSync(dir).map((name) => /^generation-(\d+)$/.exec(name)?.[1]).filter(Boolean).map(Number);
  const generation = Math.max(previous?.manifest.generation ?? 0, ...existing, 0) + 1;
  const staging = path.join(dir, `.generation-${generation}-${process.pid}.tmp`);
  fs.mkdirSync(staging, { mode: 0o700 });
  const manifest = { sessionId, generation, cutoffPosition: cutoffByte, lineage: parent ? [{ sessionId: parent.sessionId, cutoffPosition: parent.cutoffByte }] : [], compactions: own.segments, createdAt: new Date().toISOString(), chunkCount: all.length };
  fs.writeFileSync(path.join(staging, 'records.json'), JSON.stringify(all), { mode: 0o600 });
  fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  fs.renameSync(staging, path.join(dir, `generation-${String(generation).padStart(8, '0')}`));
  const currentTmp = path.join(dir, `.CURRENT-${process.pid}.tmp`);
  fs.writeFileSync(currentTmp, `${generation}\n`, { mode: 0o600 }); fs.renameSync(currentTmp, path.join(dir, 'CURRENT'));
  // The session map the next compaction puts in the seed (one entry per segment); small, read whole by the hook.
  const timelineTmp = path.join(dir, `.timeline-${process.pid}.tmp`);
  fs.writeFileSync(timelineTmp, JSON.stringify({ cutoffPosition: cutoffByte, segments: own.timeline }), { mode: 0o600 }); fs.renameSync(timelineTmp, path.join(dir, 'timeline.json'));
  // Per-turn builds would otherwise pile up generations; a reader holding an older one has just read CURRENT.
  for (const old of existing) if (old <= generation - KEEP_GENERATIONS) fs.rmSync(path.join(dir, `generation-${String(old).padStart(8, '0')}`), { recursive: true, force: true });
} catch (error) {
  fs.writeFileSync(path.join(dir, 'last-build-error'), `${error?.name ?? 'Error'}\n`, { mode: 0o600 });
} finally {
  try { fs.unlinkSync(lock); } catch {}
  try {
    const queuedCutoff = Number(fs.readFileSync(pending, 'utf8').trim());
    fs.unlinkSync(pending);
    if (queuedCutoff > cutoffByte) {
      const child = spawn(process.execPath, [process.argv[1], transcript, root, sessionId, String(queuedCutoff), projectDir, mode, 'cut', retentionRaw], { detached: true, stdio: 'ignore' });
      child.unref();
    }
  } catch {}
  // 4.8.1: retention (userConfig retentionDays, 0 keeps everything): at most once a day, the indexes and home captures
  // of sessions untouched that long go; Claude Code drops their transcripts after 30 days by default.
  try { pruneOld({ recallRoot: root, captureRoots: [path.join(homeDir(), '.exovault', 's4-capture')], days: Number(retentionRaw), sessionId }); } catch {}
  // Vectors are optional and slow (CPU minutes on a long session), so they get their own low-priority worker.
  if (mode === 'vectors' && fs.existsSync(path.join(dir, 'CURRENT'))) try {
    spawn(process.execPath, [fileURLToPath(new URL('./embed-worker.mjs', import.meta.url)), root, sessionId], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

function parseTranscript(file, cutoff, sourceSessionId) {
  const source = fs.readFileSync(file);
  const bounded = source.subarray(0, Math.min(source.length, cutoff));
  const rows = [], toolUses = new Map();
  // Byte offsets of compact_boundary events: a row's segment is how many compactions came before it (0 = none).
  let offset = 0, turn = 0, parentUuid, segment = 0;
  const boundaries = [], timeline = timelineBuilder();
  for (const line of bounded.toString('utf8').split('\n')) {
    const byteLength = Buffer.byteLength(line) + 1;
    if (!line.trim() || offset + byteLength > cutoff) { offset += byteLength; continue; }
    let event; try { event = JSON.parse(line); } catch { offset += byteLength; continue; }
    if (parentUuid === undefined && typeof event.parentUuid === 'string') parentUuid = event.parentUuid;
    if (event.type === 'system' && event.subtype === 'compact_boundary') { boundaries.push(offset); segment++; }
    timeline.add(event);
    if (!['user', 'assistant'].includes(event.type)) { offset += byteLength; continue; }
    const message = event.message ?? {}, role = message.role ?? event.type;
    if (role === 'user') turn++;
    const tools = Array.isArray(message.content) ? message.content : [];
    for (const part of tools) if (part?.type === 'tool_use' && part.id) toolUses.set(part.id, part);
    // The agent's own commands, paths and edits are evidence too (they name files, ids and values).
    for (const part of tools) {
      const callText = part?.type === 'tool_use' ? clean(toolCallText(part)) : '';
      if (!callText) continue;
      const callPath = redactPath(part.input?.file_path ?? part.input?.path ?? '');
      for (const textChunk of chunk(callText)) rows.push({
        sourceId: hash(`${sourceSessionId}\0${offset}\0call\0${part.id ?? ''}\0${textChunk}`), sourceSessionId, position: offset,
        turn, segment, role: 'assistant', tool: `${part.name ?? 'tool'}:call`, filePath: callPath, callId: part.id ?? '', text: textChunk,
      });
    }
    const text = clean(blocks(message.content));
    if (!text) { offset += byteLength; continue; }
    const result = tools.find((part) => part?.type === 'tool_result');
    let tool = '', filePath = '', callId = '';
    if (result) {
      const call = toolUses.get(result.tool_use_id);
      tool = call?.name ?? 'tool_result'; filePath = redactPath(call?.input?.file_path ?? call?.input?.path ?? '');
      callId = result.tool_use_id ?? '';
    }
    for (const textChunk of chunk(text)) rows.push({
      sourceId: hash(`${sourceSessionId}\0${offset}\0${role}\0${textChunk}`), sourceSessionId, position: offset,
      turn, segment, role, tool, filePath, ...(callId ? { callId } : {}), text: textChunk,
    });
    offset += byteLength;
  }
  return { rows, parentUuid, timeline: timeline.result(), segments: boundaries.length, segmentAt: (position) => boundaries.filter((at) => at <= position).length };
}

/** A compact text form of one tool call: name, its target (command, path, pattern) and, for edits, the new text. */
function toolCallText(part) {
  const input = part.input ?? {};
  const head = [input.command, input.file_path ?? input.path, input.pattern, input.query, input.url, input.description]
    .filter((v) => typeof v === 'string' && v.trim()).join(' | ');
  const body = [input.new_string, input.content].find((v) => typeof v === 'string') ?? '';
  const text = `${part.name ?? 'tool'}: ${head}${body ? `\n${body.slice(0, 1500)}` : ''}`;
  return head || body ? text : '';
}

function findParentPrefix(currentTranscript, directory, parentUuid) {
  if (!parentUuid || !fs.existsSync(directory)) return null;
  for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith('.jsonl') && path.join(directory, entry) !== currentTranscript)) {
    const file = path.join(directory, name);
    try {
      let offset = 0, sessionId = '';
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const bytes = Buffer.byteLength(line) + 1;
        if (line.trim()) {
          let event; try { event = JSON.parse(line); } catch { offset += bytes; continue; }
          sessionId ||= event.sessionId ?? '';
          if (event.uuid === parentUuid) return { file, sessionId, cutoffByte: offset + bytes };
        }
        offset += bytes;
      }
    } catch {}
  }
  return null;
}

function loadParentPrefix(indexRoot, parent) {
  const fallbackRows = parseTranscript(parent.file, parent.cutoffByte, parent.sessionId).rows;
  try {
    const dir = path.join(indexRoot, hash(parent.sessionId));
    const current = Number(fs.readFileSync(path.join(dir, 'CURRENT'), 'utf8').trim());
    const generations = fs.readdirSync(dir).map((name) => /^generation-(\d+)$/.exec(name)?.[1]).filter(Boolean).map(Number).filter((n) => n <= current).sort((a, b) => b - a);
    for (const generation of generations) {
      try {
        const folder = path.join(dir, `generation-${String(generation).padStart(8, '0')}`);
        const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
        if (manifest.cutoffPosition > parent.cutoffByte) continue;
        const rows = JSON.parse(fs.readFileSync(path.join(folder, 'records.json'), 'utf8'));
        if (!Array.isArray(rows) || rows.length !== manifest.chunkCount) continue;
        return rows.filter((row) => row.sourceSessionId !== parent.sessionId || row.position < parent.cutoffByte);
      } catch {}
    }
  } catch {}
  return fallbackRows;
}

/** The published generation's cutoff from its manifest alone (no records parse); -1 when none. */
function publishedCutoff(base) {
  try {
    const current = Number(fs.readFileSync(path.join(base, 'CURRENT'), 'utf8').trim());
    return JSON.parse(fs.readFileSync(path.join(base, `generation-${String(current).padStart(8, '0')}`, 'manifest.json'), 'utf8')).cutoffPosition;
  } catch { return -1; }
}

function readLatest(base) {
  try {
    const current = Number(fs.readFileSync(path.join(base, 'CURRENT'), 'utf8').trim());
    const generations = fs.readdirSync(base).map((name) => /^generation-(\d+)$/.exec(name)?.[1]).filter(Boolean).map(Number).filter((n) => n <= current).sort((a, b) => b - a);
    for (const generation of generations) {
      try {
        const folder = path.join(base, `generation-${String(generation).padStart(8, '0')}`);
        const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
        const rows = JSON.parse(fs.readFileSync(path.join(folder, 'records.json'), 'utf8'));
        if (Array.isArray(rows) && rows.length === manifest.chunkCount) return { manifest, rows };
      } catch {}
    }
  } catch {}
  return null;
}
