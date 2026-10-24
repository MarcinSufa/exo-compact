// 4.8.1: one command for the data an older version left on disk, plus the retention the build worker applies.
//   node cleanup.mjs [--apply] [--days N] [--capture-root DIR]... [--json]
// Without --apply it is a dry run: it prints what would change and touches nothing. With --apply it first writes every
// file it will change or delete to <home>/.exovault/backup-<date>.tar.gz (owner-only; it still holds the keys, so delete
// it once the result looks right), then
//   - redacts again, with today's patterns, every stored generation of every session index (records.json), the session
//     map (timeline.json), the search log (search-calls.jsonl) and the saved briefs, their checklists and briefs.json;
//     an index built by an older redactor keeps the keys the current patterns catch, and only rows carried into a new
//     build were redacted again;
//   - redacts the text files of every capture directory it keeps (segments, the work log, the task card, notices,
//     adopted files). Capture writes take no lock, so a capture written in the last hour is left for a later run, a
//     capture that changed or gained a file since the plan is left whole, and each file is read again right before
//     its rename; a symlinked capture root is not followed, and the session running the command
//     (CLAUDE_CODE_SESSION_ID) keeps its capture and index;
//   - deletes the index (<home>/.claude/exovault/recall/<sha>) and the capture directory (<root>/.exovault/s4-capture/<id>)
//     of every session untouched for more than N days (default 30, Claude Code's own default for keeping transcripts;
//     0 keeps everything). --capture-root adds a project that holds its own .exovault (an enable flag there).
// A session whose build holds BUILD_LOCK is skipped; the lock is taken for every index the run changes. A session counts
// as touched by its newest file in either store, so an old index stays while its session still writes captures.
// Redaction here never shortens a file (redactAll): a brief or checklist keeps every line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hash, redactAll } from './shared.mjs';
import { homeDir, recallRootDir } from './paths.mjs';

export const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_DIR = /^[0-9a-f]{64}$/;
const GENERATION_DIR = /^generation-\d+$/;
const STAMP = '.retention-stamp';
/** A capture written more recently than this may belong to a live session (capture writes take no lock): not redacted. */
const CAPTURE_QUIET_MS = 60 * 60 * 1000;
const CAPTURE_KINDS = { '.json': 'json', '.jsonl': 'jsonl', '.md': 'text', '.brief': 'text', '.log': 'text', '.txt': 'text' };

/** The capture directory name of a session, as host/capture-path.ts builds it. */
const captureName = (sessionId) => {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'session';
  return safe === '.' || safe === '..' ? `session-${safe}` : safe;
};

const listDir = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };

/**
 * The newest mtime of the files below `dir` (symlinks are not followed); a directory without files counts by its own.
 * Directory mtimes and BUILD_LOCK do not count: taking the lock to prune must not make the session look touched.
 */
function newestMtime(dir) {
  let newest = -1;
  const walk = (current) => {
    for (const entry of listDir(current)) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name !== 'BUILD_LOCK') try { newest = Math.max(newest, fs.lstatSync(full).mtimeMs); } catch {}
    }
  };
  walk(dir);
  if (newest >= 0) return newest;
  try { return fs.lstatSync(dir).mtimeMs; } catch { return 0; }
}

function sizeOf(dir) {
  let total = 0;
  for (const entry of listDir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += sizeOf(full);
    else try { total += fs.lstatSync(full).size; } catch {}
  }
  return total;
}

/** The same lock protocol as build-worker.mjs: a pid in BUILD_LOCK, dropped once when that process is gone. */
function lockOwnerAlive(lock) {
  try { const pid = Number(fs.readFileSync(lock, 'utf8').trim()); if (!pid) return false; process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
/** A live build holds the lock; a lock this process took (an --apply run) is not a build. */
const busy = (dir) => {
  const lock = path.join(dir, 'BUILD_LOCK');
  try { if (fs.readFileSync(lock, 'utf8').trim() === String(process.pid)) return false; } catch { return false; }
  return lockOwnerAlive(lock);
};
function takeLock(dir) {
  const lock = path.join(dir, 'BUILD_LOCK');
  const take = () => { try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); return true; } catch { return false; } };
  if (!take() && (lockOwnerAlive(lock) || (() => { try { fs.unlinkSync(lock); } catch {} return !take(); })())) return null;
  return () => { try { if (fs.readFileSync(lock, 'utf8').trim() === String(process.pid)) fs.unlinkSync(lock); } catch {} };
}

/**
 * One property of a parsed JSON object, redacted. The name too: a captured tool input can name an env variable or
 * header by its value. redactAll finds a named secret (`"apiKey":"..."`, a header) only with its name next to it, so
 * a string value is tested in that pair form and replaced whole when the pair would be redacted. A list or object under
 * such a name (`"apiKey":["..."]`) has every string below it replaced, since the name sits next to none of them.
 */
const redactPair = (key, inner) => {
  const name = redactAll(key);
  const named = (value) => {
    const pair = JSON.stringify({ [key]: value });
    return redactAll(pair) !== pair && redactAll(pair) !== JSON.stringify({ [name]: redactAll(value) });
  };
  if (typeof inner !== 'string') return [name, inner && typeof inner === 'object' && named('value123') ? blank(inner) : redactStrings(inner)];
  return [name, named(inner) ? '[redacted]' : redactAll(inner)];
};
/** Every string in a value replaced, keys redacted as usual; numbers, booleans and null stay. */
const blank = (value) => {
  if (typeof value === 'string') return '[redacted]';
  if (Array.isArray(value)) return value.map(blank);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [redactAll(key), blank(inner)]));
  return value;
};
const redactStrings = (value) => {
  if (typeof value === 'string') return redactAll(value);
  if (Array.isArray(value)) return value.map(redactStrings);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => redactPair(key, inner)));
  return value;
};
/**
 * Fields a file is looked up by, kept as they are: adopted.json names each copy by the hash of its original path, so a
 * redacted path would lose the copy. isSecretLikePath only looks at names (.env, keys/), so a rules file under a
 * key-shaped directory is adopted too: an entry whose kept field holds a key, or is no string, is dropped, since a
 * redacted path would match nothing anyway (its copy is redacted as a file of its own).
 */
const KEEP_FIELDS = { 'adopted.json': ['path', 'savedPath'] };
const DROP = Symbol('drop');
const redactJson = (value, keep) => {
  if (!keep) return redactStrings(value);
  const entry = (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return redactStrings(item);
    // A kept field that is no string is not an entry the hook reads either, and could hide a key from this check.
    if (keep.some((key) => key in item && (typeof item[key] !== 'string' || redactAll(item[key]) !== item[key]))) return DROP;
    return Object.fromEntries(Object.entries(item).map(([key, inner]) => (keep.includes(key) ? [key, inner] : redactPair(key, inner))));
  };
  if (Array.isArray(value)) return value.map(entry).filter((item) => item !== DROP);
  const one = entry(value);
  return one === DROP ? redactStrings(value) : one;
};
/** JSON lines, each redacted field by field (a line that does not parse, as text); undefined when nothing changes. */
function redactLines(raw, keep) {
  const lines = raw.split('\n').map((line) => {
    if (!line.trim()) return [line, line];
    try { const value = JSON.parse(line); return [JSON.stringify(value), JSON.stringify(redactJson(value, keep))]; } catch { return [line, redactAll(line)]; }
  });
  if (lines.every(([before, after]) => before === after)) return undefined;
  return lines.map(([, after]) => after).join('\n');
}

/**
 * The redacted form of one stored file: { text, rows, raw } when it changes, undefined when it does not (or is
 * unreadable). `raw` is the text it was made from; given, it is used instead of reading the file.
 */
function redactFile(file, kind, raw) {
  if (raw === undefined) try { raw = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
  let text, rows = 0;
  const keep = KEEP_FIELDS[path.basename(file)];
  if (kind === 'records') {
    let records;
    try { records = JSON.parse(raw); } catch { return undefined; }
    if (!Array.isArray(records)) return undefined;
    // The text and the tool path: a path can name a key too (a token in a directory or query).
    text = JSON.stringify(records.map((row) => {
      const fields = ['text', 'filePath'].filter((field) => typeof row?.[field] === 'string' && redactAll(row[field]) !== row[field]);
      if (!fields.length) return row;
      rows += 1;
      return { ...row, ...Object.fromEntries(fields.map((field) => [field, redactAll(row[field])])) };
    }));
    if (!rows) return undefined;
  } else if (kind === 'json') {
    let value;
    // A capture segment is named .json but holds one record per line (host/fs-adapter.ts): read it as JSON lines.
    try { value = JSON.parse(raw); } catch { text = redactLines(raw, keep); if (text === undefined) return undefined; return { text, rows, raw }; }
    text = JSON.stringify(redactJson(value, keep));
    if (text === JSON.stringify(value)) return undefined;
  } else if (kind === 'jsonl') {
    text = redactLines(raw, keep);
    if (text === undefined) return undefined;
  } else {
    text = redactAll(raw);
    if (text === raw) return undefined;
  }
  return { text, rows, raw };
}

/**
 * A file the run would rewrite, or undefined: its rows and a hash of the text the plan read, not the text, so a plan over
 * many large captures stays small. --apply redacts each file again from what it reads then.
 */
function planFile(item) {
  const found = redactFile(item.file, item.kind);
  return found ? { ...item, rows: found.rows, rawHash: hash(found.raw) } : undefined;
}

/** Every file of one session index that may hold session text, with how to redact it. */
function indexFiles(dir) {
  const files = [];
  for (const entry of listDir(dir)) {
    if (entry.isDirectory() && GENERATION_DIR.test(entry.name)) files.push({ file: path.join(dir, entry.name, 'records.json'), kind: 'records' });
  }
  files.push({ file: path.join(dir, 'timeline.json'), kind: 'json' }, { file: path.join(dir, 'search-calls.jsonl'), kind: 'jsonl' });
  const briefs = path.join(dir, 'briefs');
  for (const entry of listDir(briefs)) {
    if (!entry.isFile()) continue;
    if (entry.name === 'briefs.json') files.push({ file: path.join(briefs, entry.name), kind: 'json' });
    else if (entry.name.endsWith('.md')) files.push({ file: path.join(briefs, entry.name), kind: 'text', brief: !entry.name.endsWith('.digest.md') });
  }
  return files;
}

/** Every text file below a capture directory (symlinks are not followed), with how to redact it and its stat now. */
function captureFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of listDir(current)) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && CAPTURE_KINDS[path.extname(entry.name)]) {
        try { const stat = fs.statSync(full); files.push({ file: full, kind: CAPTURE_KINDS[path.extname(entry.name)], mtimeMs: stat.mtimeMs, size: stat.size }); } catch {}
      }
    }
  };
  walk(dir);
  return files;
}

/** Whether `item` (a planned capture file) is still the file the plan read: same size and mtime. */
const unchanged = (item) => {
  try { const stat = fs.statSync(item.file); return stat.size === item.size && stat.mtimeMs === item.mtimeMs; } catch { return false; }
};

/** Every file below `dir` (symlinks not followed), with its size and mtime, as one comparable string. */
function treeState(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of listDir(current)) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else try { const stat = fs.lstatSync(full); out.push(`${full}\0${stat.size}\0${stat.mtimeMs}`); } catch {}
    }
  };
  walk(dir);
  return out.sort().join('\n');
}

/** A capture root the run may read: a real directory, and not reached through a symlinked .exovault either. */
const realCaptureDir = (dir) => [dir, path.dirname(dir)].every((part) => { try { return !fs.lstatSync(part).isSymbolicLink(); } catch { return false; } });

/**
 * The raw session id of an index, from its ACTIVE marker (every turn writes it) or its manifests, or undefined: only an
 * id that hashes to the index directory's name counts.
 */
function indexSessionId(dir) {
  const name = path.basename(dir);
  try { const id = fs.readFileSync(path.join(dir, 'ACTIVE'), 'utf8'); if (id && hash(id) === name) return id; } catch {}
  for (const entry of listDir(dir)) {
    if (!entry.isDirectory() || !GENERATION_DIR.test(entry.name)) continue;
    try { const id = JSON.parse(fs.readFileSync(path.join(dir, entry.name, 'manifest.json'), 'utf8')).sessionId; if (typeof id === 'string' && hash(id) === name) return id; } catch {}
  }
  return undefined;
}

/**
 * Whether `item` must stay after all, checked right before removing it: a turn can mark its index (ACTIVE comes before
 * the lock) or write a capture after the plan, and then every planned item of that session stays. An index with no known
 * session id could own any capture, so once it is fresh every capture stays.
 */
function freshCheck(prune, cutoff) {
  const bySession = new Map();
  for (const item of prune) for (const session of item.sessions) bySession.set(session, [...(bySession.get(session) ?? []), item]);
  const unlinked = prune.filter((item) => item.unlinked);
  return (item) => item.sessions.some((session) => bySession.get(session).some((other) => newestMtime(other.dir) >= cutoff))
    || (item.kind === 'capture' && unlinked.some((other) => newestMtime(other.dir) >= cutoff));
}

/**
 * What a run would do: { redact: [{ dir, files: [{ file, kind, brief, rows, text }] }], prune: [{ dir, kind, bytes, sessions, unlinked }], busy }.
 * `sessions` are the index directory names the item belongs to (a capture name two session ids share belongs to both).
 * `captureDirs` are .exovault/s4-capture directories; `sessionId` (the session running this) is never pruned. With
 * `locked` (the index directory names this process holds the lock of), every other index counts as busy.
 */
export function plan({ recallRoot, captureDirs = [], days, now = Date.now(), sessionId, redactData = true, locked }) {
  const result = { redact: [], prune: [], busy: 0, recentCaptures: 0 };
  const cutoff = days > 0 ? now - days * DAY_MS : -Infinity;
  const own = sessionId === undefined ? undefined : hash(String(sessionId));
  // Newest file per session in each store, by index directory name (a capture is named by its session id).
  const touched = new Map();
  const touch = (name, ms) => touched.set(name, Math.max(touched.get(name) ?? -Infinity, ms));
  // A capture is named by its sanitized session id, so it belongs to hash(name) and to every index whose raw id
  // sanitizes to that name.
  const captures = captureDirs.filter(realCaptureDir).flatMap((captureDir) => listDir(captureDir).filter((entry) => entry.isDirectory())
    .map((entry) => ({ dir: path.join(captureDir, entry.name), name: entry.name, sessions: [hash(entry.name)] })));
  // Index directory names whose raw session id is known: a busy index outside it could own any capture.
  const linked = new Set();
  if (days > 0) {
    const byName = new Map();
    for (const capture of captures) byName.set(capture.name, [...(byName.get(capture.name) ?? []), capture]);
    for (const entry of listDir(recallRoot)) {
      if (!entry.isDirectory() || !SESSION_DIR.test(entry.name)) continue;
      const id = indexSessionId(path.join(recallRoot, entry.name));
      if (id !== undefined) linked.add(entry.name);
      if (id !== undefined) for (const capture of byName.get(captureName(id)) ?? []) if (!capture.sessions.includes(entry.name)) capture.sessions.push(entry.name);
    }
    for (const capture of captures) for (const session of capture.sessions) touch(session, newestMtime(capture.dir));
    for (const entry of listDir(recallRoot)) if (entry.isDirectory() && SESSION_DIR.test(entry.name)) touch(entry.name, newestMtime(path.join(recallRoot, entry.name)));
  }
  const busySessions = new Set();
  for (const entry of listDir(recallRoot)) {
    if (!entry.isDirectory() || !SESSION_DIR.test(entry.name)) continue;
    const dir = path.join(recallRoot, entry.name);
    if (locked ? !locked.has(entry.name) : busy(dir)) { result.busy += 1; busySessions.add(entry.name); continue; }
    if (entry.name !== own && touched.get(entry.name) < cutoff) { result.prune.push({ dir, kind: 'index', bytes: sizeOf(dir), sessions: [entry.name], unlinked: !linked.has(entry.name) }); continue; }
    if (!redactData) continue;
    const files = indexFiles(dir).map(planFile).filter(Boolean);
    if (files.length) result.redact.push({ dir, files });
  }
  const ownCapture = sessionId === undefined ? undefined : captureName(sessionId);
  // An older worker leaves ACTIVE empty, so before its first manifest a live build cannot be paired with its capture.
  if ([...busySessions].some((session) => !linked.has(session))) return result;
  for (const capture of captures) {
    // A build holding the lock means the session is live: its capture stays with its index.
    if (capture.name === ownCapture || capture.sessions.some((session) => busySessions.has(session))) continue;
    if (!capture.sessions.some((session) => !(touched.get(session) < cutoff))) {
      result.prune.push({ dir: capture.dir, kind: 'capture', bytes: sizeOf(capture.dir), sessions: capture.sessions });
      continue;
    }
    if (!redactData) continue;
    const files = captureFiles(capture.dir).map(planFile).filter(Boolean);
    if (!files.length) continue;
    if (newestMtime(capture.dir) >= now - CAPTURE_QUIET_MS) result.recentCaptures += 1;
    else result.redact.push({ dir: capture.dir, files, capture: true, state: treeState(capture.dir) });
  }
  return result;
}

function writeAtomic(file, text, stillRaw) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  // Capture writes take no lock: the file is read once more right before the rename, and a write that landed since the
  // redaction keeps its text (the rename would replace it). What is left is the gap between this read and the rename.
  if (stillRaw !== undefined) {
    let now;
    try { now = fs.readFileSync(file, 'utf8'); } catch { now = undefined; }
    if (now !== stillRaw) { fs.rmSync(temp, { force: true }); return false; }
  }
  fs.renameSync(temp, file);
  return true;
}

/** A backup path for today that does not exist yet. */
function backupPath(home, now) {
  const dir = path.join(home, '.exovault');
  const date = new Date(now).toISOString().slice(0, 10);
  let file = path.join(dir, `backup-${date}.tar.gz`);
  for (let n = 2; fs.existsSync(file); n += 1) file = path.join(dir, `backup-${date}-${n}.tar.gz`);
  return file;
}

/**
 * Writes `entries` (absolute files and directories) to a new owner-only tar.gz and checks the archive lists each one.
 * Paths under `home` are stored relative to it, others relative to their filesystem root. Throws when tar fails.
 */
function writeBackup(file, entries, home) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const groups = new Map();
  for (const entry of entries) {
    const inside = !path.relative(home, entry).startsWith('..') && !path.isAbsolute(path.relative(home, entry));
    const base = inside ? home : path.parse(entry).root;
    if (!groups.has(base)) groups.set(base, []);
    // ./ first, so a name that starts with a dash is never read as a tar option.
    groups.get(base).push(`./${path.relative(base, entry).split(path.sep).join('/')}`);
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'exo-backup-'));
  try {
    const args = ['-czf', file];
    [...groups].forEach(([base, names], i) => {
      const list = path.join(temp, `list-${i}.txt`);
      // NUL-separated (GNU tar and bsdtar both read --null), so a newline in a name cannot split it.
      fs.writeFileSync(list, `${names.join('\0')}\0`);
      args.push('-C', base, '--null', '-T', list);
    });
    fs.writeFileSync(file, '', { mode: 0o600 });
    const made = spawnSync('tar', args, { encoding: 'utf8' });
    fs.chmodSync(file, 0o600);
    if (made.error || made.status !== 0) throw new Error(`tar failed: ${made.error?.message ?? made.stderr.trim()}`);
    const listed = spawnSync('tar', ['-tzf', file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const names = new Set(String(listed.stdout).split(/\r?\n/).map((name) => name.replace(/\/$/, '')));
    const missing = [...groups.values()].flat().filter((name) => !names.has(name));
    if (listed.status !== 0 || missing.length) throw new Error(`backup check failed: ${missing.length} entries missing from ${file}`);
  } catch (error) {
    fs.rmSync(file, { force: true });
    throw error;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const summarize = (planned, { apply, days }) => ({
  apply,
  days,
  redact: {
    files: planned.redact.reduce((sum, index) => sum + index.files.length, 0),
    rows: planned.redact.reduce((sum, index) => sum + index.files.reduce((rows, item) => rows + (item.rows ?? 0), 0), 0),
    briefs: planned.redact.reduce((sum, index) => sum + index.files.filter((item) => item.brief).length, 0),
    indexes: planned.redact.filter((item) => !item.capture).length,
    captures: planned.redact.filter((item) => item.capture).length,
    skipped: 0,
  },
  recentCaptures: planned.recentCaptures,
  prune: {
    indexes: planned.prune.filter((item) => item.kind === 'index').length,
    captures: planned.prune.filter((item) => item.kind === 'capture').length,
    bytes: planned.prune.reduce((sum, item) => sum + item.bytes, 0),
  },
  busy: planned.busy,
  backup: null,
});

/** The cleanup run: a dry run unless `apply`. Returns the summary. */
export function cleanup({ home = homeDir(), recallRoot = recallRootDir(process.env, home), captureDirs, days = DEFAULT_RETENTION_DAYS, apply = false, now = Date.now(), sessionId, afterBackup, beforeRewrite } = {}) {
  const captures = captureDirs ?? [path.join(home, '.exovault', 's4-capture')];
  if (!apply) return summarize(plan({ recallRoot, captureDirs: captures, days, now, sessionId }), { apply, days });
  // Locks first, so nothing a build writes lands between the plan, the backup and the rewrite.
  const releases = [], locked = new Set();
  for (const entry of listDir(recallRoot)) {
    if (!entry.isDirectory() || !SESSION_DIR.test(entry.name)) continue;
    const release = takeLock(path.join(recallRoot, entry.name));
    if (release) { releases.push(release); locked.add(entry.name); }
  }
  try {
    const planned = plan({ recallRoot, captureDirs: captures, days, now, sessionId, locked });
    const summary = summarize(planned, { apply, days });
    const entries = [...planned.redact.flatMap((index) => index.files.map((item) => item.file)), ...planned.prune.map((item) => item.dir)];
    if (!entries.length) return summary;
    const file = backupPath(home, now);
    writeBackup(file, entries, home);
    summary.backup = { file, files: entries.length };
    afterBackup?.();
    const skip = (count) => { summary.redact.skipped += count; summary.redact.files -= count; };
    for (const index of planned.redact) {
      // A capture a session wrote to since the plan (a changed or a new file) is live again: none of its files is
      // rewritten, and the next run redacts it.
      if (index.capture && treeState(index.dir) !== index.state) { skip(index.files.length); summary.redact.captures -= 1; continue; }
      let rewritten = 0;
      for (const item of index.files) {
        if (index.capture && !unchanged(item)) { skip(1); continue; }
        let raw;
        try { raw = fs.readFileSync(item.file, 'utf8'); } catch { skip(1); continue; }
        if (index.capture && hash(raw) !== item.rawHash) { skip(1); continue; }
        const fresh = redactFile(item.file, item.kind, raw);
        if (!fresh) continue;
        beforeRewrite?.(item.file);
        if (writeAtomic(item.file, fresh.text, index.capture ? raw : undefined)) rewritten += 1; else skip(1);
      }
      if (index.capture && !rewritten) summary.redact.captures -= 1;
    }
    const fresh = freshCheck(planned.prune, now - days * DAY_MS);
    for (const item of planned.prune) {
      if (fresh(item)) {
        summary.prune[item.kind === 'index' ? 'indexes' : 'captures'] -= 1; summary.prune.bytes -= item.bytes;
        continue;
      }
      fs.rmSync(item.dir, { recursive: true, force: true });
    }
    return summary;
  } finally {
    for (const release of releases) release();
  }
}

/**
 * The build worker's retention: at most once a day (a stamp in the recall root), deletes the index and home capture
 * directory of every session untouched for more than `days`, never `sessionId`'s. No backup: this is the policy the
 * user set, not a migration. Returns the counts, or null when it did not run.
 */
export function pruneOld({ recallRoot, captureRoots = [], days, now = Date.now(), sessionId, afterPlan }) {
  if (!(days > 0)) return null;
  const stamp = path.join(recallRoot, STAMP);
  // A stamp in the future (the clock went back) counts as stale, or retention would stop until that date.
  try { const since = now - Number(fs.readFileSync(stamp, 'utf8').trim()); if (since >= 0 && since < DAY_MS) return null; } catch {}
  try { fs.mkdirSync(recallRoot, { recursive: true, mode: 0o700 }); writeAtomic(stamp, String(now)); } catch { return null; }
  const planned = plan({ recallRoot, captureDirs: captureRoots, days, now, sessionId, redactData: false });
  const done = { indexes: 0, captures: 0 };
  afterPlan?.();
  const fresh = freshCheck(planned.prune, now - days * DAY_MS);
  for (const item of planned.prune) {
    if (item.kind === 'index') {
      const release = takeLock(item.dir);
      if (!release) continue;
      if (fresh(item)) { release(); continue; }
      fs.rmSync(item.dir, { recursive: true, force: true });
      done.indexes += 1;
    } else {
      // A session that resumed since the plan: keep it. (Capture writes take no lock.)
      if (fresh(item)) continue;
      fs.rmSync(item.dir, { recursive: true, force: true });
      done.captures += 1;
    }
  }
  return done;
}

const human = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);
const PLURALS = { index: 'indexes', entry: 'entries', directory: 'directories' };
const plural = (n, words) => {
  if (n === 1) return `${n} ${words}`;
  const last = words.split(' ').pop();
  return `${n} ${words.slice(0, -last.length)}${PLURALS[last] ?? `${last}s`}`;
};

function report(summary) {
  const would = summary.apply ? '' : 'would be ';
  const lines = [summary.apply ? 'exo-compact cleanup' : 'exo-compact cleanup (dry run): nothing is changed; run it again with --apply to do it.'];
  const { redact: r, prune: p } = summary;
  lines.push(`redact: ${plural(r.files, 'file')} in ${plural(r.indexes, 'session index')} and ${plural(r.captures, 'capture directory')} ${would}rewritten (${plural(r.rows, 'row')}, ${plural(r.briefs, 'brief')})`);
  if (r.skipped) lines.push(`changed: ${plural(r.skipped, 'capture file')} written to during the run kept as they were; run it again later`);
  if (summary.recentCaptures) lines.push(`recent: ${plural(summary.recentCaptures, 'capture directory')} written in the last hour skipped, a session may still be using it; run it again later`);
  lines.push(summary.days > 0
    ? `retention (${summary.days} days): ${plural(p.indexes, 'session index')} and ${plural(p.captures, 'capture directory')} (${human(p.bytes)}) ${would}deleted`
    : 'retention: off (--days 0)');
  if (summary.busy) lines.push(`busy: ${plural(summary.busy, 'session index')} skipped, a build holds its lock; run it again later`);
  if (summary.backup) lines.push(`backup: ${summary.backup.file} (${plural(summary.backup.files, 'entry')}); it still holds the original text, delete it once the result looks right`);
  if (summary.apply && (r.files || p.indexes)) lines.push('Restart running sessions: a recall server keeps the text it already loaded in memory.');
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const usage = 'Usage: node cleanup.mjs [--apply] [--days N] [--capture-root DIR]... [--json]\n';
  let apply = false, json = false, days = DEFAULT_RETENTION_DAYS;
  const home = homeDir();
  const captureDirs = [path.join(home, '.exovault', 's4-capture')];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--apply') apply = true;
    else if (arg === '--json') json = true;
    else if (arg === '--days' && /^\d+$/.test(args[i + 1] ?? '')) days = Number(args[++i]);
    else if (arg === '--capture-root' && args[i + 1]) captureDirs.push(path.join(path.resolve(args[++i]), '.exovault', 's4-capture'));
    else { process.stderr.write(usage); process.exit(2); }
  }
  try {
    // Run from a session (setup.cjs cleanup in its shell), that session's own capture and index are left alone.
    const summary = cleanup({ home, captureDirs, days, apply, sessionId: process.env.CLAUDE_CODE_SESSION_ID || undefined });
    process.stdout.write(json ? `${JSON.stringify(summary)}\n` : report(summary));
  } catch (error) {
    process.stderr.write(`exo-compact cleanup: ${error?.message ?? error}; nothing was changed\n`);
    process.exitCode = 1;
  }
}
