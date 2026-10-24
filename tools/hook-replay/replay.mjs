#!/usr/bin/env node
// Offline hook replay: runs the REAL exo-compact hook module (plugin/compact/compact.ts, loaded from source)
// over a saved live session sandbox and checks it against what the live run logged.
//
//   node tools/hook-replay/replay.mjs <sandbox dir> [--cut N] [--rev <git rev>] [--options <json>] [--json <file>] [--keep]
//
//   --no-regroup / --no-parallel-group switch off one reconstruction rule (ablation).
//
// The sandbox is an A/B arm directory (e.g. ~/work/sandbox/arm-1): projects/<dir>/<sid>.jsonl (the transcript),
// out/sid, out/chain.txt (run order), out/debug-<run>.txt (CC debug logs), exovault/ (the jail's ~/.claude/exovault)
// and the working copy whose .exovault/s4-compact-active enabled the plugin.
//
// The live session was a chain of `claude -p` runs (one process each, resumed on the same session id). This replays
// the same chain: one register() per run, the run's session.compact dispatches at its compact_boundary records, and
// its single turn.complete at the end. Nothing else is called: no network, no claude/codex, no detached workers.
// See PARITY.md for what is reproduced, how the future is hidden at each event, and what cannot be reproduced.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const REPO = fileURLToPath(new URL('../..', import.meta.url));
// The live arm's userConfig for the plugin (ab harness, s4 arm). --options replaces it.
const LIVE_OPTIONS = { recallEnabled: true, recallPluginRoot: path.join(REPO, 'plugin/compact'), jevEnabled: false, totalBudgetTokens: 13000 };
// Inside the jail HOME was this path ($REPLAY_JAIL_HOME overrides it) and $HOME/.claude/{exovault,projects} were bound to the sandbox.
const JAIL_HOME = process.env.REPLAY_JAIL_HOME ?? '/home/user';
// The sandbox subdirectory that holds the project's working copy ($REPLAY_PROJECT_DIR overrides it).
const PROJECT_DIR = process.env.REPLAY_PROJECT_DIR ?? 'proj';
// Transcript lines CC writes after an event (prompt bookkeeping); a launcher started at the event did not see them.
const TRAILING_META = new Set(['last-prompt', 'mode', 'atis-latch', 'cost-state']);
const TURN_MIN_GROWTH = 32 * 1024; // recall/build-worker.mjs
const SECTION_TOLERANCE = 0.05;

// ---------- arguments ----------
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const bool = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const cutArg = flag('--cut');
const wantCut = cutArg === undefined ? undefined : Number(cutArg);
const rev = flag('--rev');
const optionsArg = flag('--options');
const jsonOut = flag('--json');
const keep = bool('--keep');
// --dump <dir>: per cut, the live seed (or native summary) and the replayed seed plus tail, for content checks.
const DUMP = args.includes('--dump') ? path.resolve(args[args.indexOf('--dump') + 1]) : undefined;
// Ablations, to show what each reconstruction rule is worth (PARITY.md): leave out the resume regroup / the parallel-call grouping.
const noRegroup = bool('--no-regroup');
const noParallel = bool('--no-parallel-group');
// --card-stub: before each cut, a task card at the plugin's cap is put in the capture directory (3.47.0, S4zu), made
// from the newest brief saved by then. Live, the session's model writes it with a fork; this checks the budgets only.
const cardStub = bool('--card-stub');
// --card-stale: the stub is made from the brief before the newest one and records that brief's id, as when a cut comes
// while the refresh fork for a new task is still running (w17 w60m r2, 3.53.0).
const cardStale = bool('--card-stale');
// --card-live: before each cut, the card the live seed carried (its `## Task card` section, turned back into the card
// file) and the horizon the live run's fork had (4.6.0, S5f), so the "Since the card" section can be measured.
const cardLive = bool('--card-live');
const SANDBOX = args[0] ? path.resolve(args[0]) : undefined;
if (!SANDBOX || !fs.existsSync(SANDBOX)) {
  console.error('usage: node tools/hook-replay/replay.mjs <sandbox dir> [--cut N] [--rev <git rev>] [--options <json>] [--json <file>] [--keep] [--card-live]');
  process.exit(2);
}
const OPTIONS = optionsArg ? JSON.parse(optionsArg) : LIVE_OPTIONS;

// ---------- the production plugin, loaded from source ----------
// --rev exports plugin/compact at that commit to a temp dir (git archive), otherwise the working tree is used.
let PLUGIN = process.env.HOOK_REPLAY_PLUGIN ?? path.join(REPO, 'plugin/compact');
let revDir;
if (rev) {
  const dir = revDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-replay-rev-'));
  const archive = spawnSync('git', ['-C', REPO, 'archive', rev, 'plugin/compact'], { maxBuffer: 1 << 28 });
  if (archive.status !== 0) { console.error(String(archive.stderr)); process.exit(2); }
  const untar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout });
  if (untar.status !== 0) { console.error(String(untar.stderr)); process.exit(2); }
  PLUGIN = path.join(dir, 'plugin/compact');
}
// The plugin is TypeScript with .js specifiers for its build output; resolve them to the .ts sources (as real-replay).
const PLUGIN_URL = pathToFileURL(`${PLUGIN}/`).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(PLUGIN_URL) && specifier.startsWith('.') && specifier.endsWith('.js')) {
    const ts = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
    if (fs.existsSync(fileURLToPath(ts))) return nextResolve(ts.href, context);
  }
  return nextResolve(specifier, context);
} });
const loadPlugin = (rel) => import(pathToFileURL(path.join(PLUGIN, rel)).href);
const { register } = await loadPlugin('compact.ts');
const { contentIdentity } = await loadPlugin('core/extractor.ts');
const { timelineBuilder } = await loadPlugin('recall/timeline.mjs');

// ---------- the live session ----------
const SID = fs.readFileSync(path.join(SANDBOX, 'out/sid'), 'utf8').trim();
const projectsDir = path.join(SANDBOX, 'projects');
const transcriptDir = fs.readdirSync(projectsDir).find((d) => fs.existsSync(path.join(projectsDir, d, `${SID}.jsonl`)));
if (!transcriptDir) throw new Error(`no transcript for ${SID} under ${projectsDir}`);
const TRANSCRIPT = path.join(projectsDir, transcriptDir, `${SID}.jsonl`);
const RECALL_DIR = path.join(SANDBOX, 'exovault/recall', sha(SID));

/** Transcript records with their 1-based line number and byte span (the recall launcher's cutoff is a byte offset). */
function readTranscript(file) {
  const buffer = fs.readFileSync(file);
  const records = [];
  let offset = 0, n = 0;
  for (const line of buffer.toString('utf8').split('\n')) {
    const bytes = Buffer.byteLength(line) + 1;
    n += 1;
    if (line.trim()) records.push({ ...JSON.parse(line), _n: n, _offset: offset, _bytes: bytes });
    offset += bytes;
  }
  return { records, size: buffer.length };
}
const { records: RECORDS, size: TRANSCRIPT_SIZE } = readTranscript(TRANSCRIPT);
const byLine = new Map(RECORDS.map((r) => [r._n, r]));
const byUuid = new Map(RECORDS.filter((r) => r.uuid).map((r) => [r.uuid, r]));
const isBoundary = (r) => r.type === 'system' && r.subtype === 'compact_boundary';
const isMessage = (r) => (r.type === 'user' || r.type === 'assistant') && !r.isMeta;
const BOUNDARIES = RECORDS.filter(isBoundary);

const blockText = (content) => typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n') : '';
/** One transcript record as the SessionMessage the CLI hands the hook (no extra fields: the hook hashes them). */
function sessionMessage(record) {
  const content = record.message?.content;
  const parts = Array.isArray(content) ? content : [];
  const toolUses = parts.filter((p) => p?.type === 'tool_use').map((p) => ({ tool_use_id: p.id, tool: p.name, input: p.input }));
  const toolResults = parts.filter((p) => p?.type === 'tool_result').map((p) => ({ tool_use_id: p.tool_use_id, text: blockText(p.content), isError: !!p.is_error }));
  return { role: record.type, text: typeof content === 'string' ? content : parts.filter((p) => p?.type === 'text').map((p) => p.text ?? '').join('\n'), toolUses, ...(toolResults.length ? { toolResults } : {}) };
}
const messageChars = (m) => m.text.length + m.toolUses.reduce((n, t) => n + (t.input === undefined ? 0 : JSON.stringify(t.input).length), 0) + (m.toolResults ?? []).reduce((n, r) => n + r.text.length, 0);

/** Runs in chain order: each starts at a queue-operation group in the transcript; out/chain.txt names them. */
function readRuns() {
  const names = fs.readFileSync(path.join(SANDBOX, 'out/chain.txt'), 'utf8').split('\n').filter(Boolean).flatMap((line) => [`${line.split(/\s+/)[0]}-a`, `${line.split(/\s+/)[0]}-b`]);
  const starts = RECORDS.filter((r, i) => r.type === 'queue-operation' && r.operation === 'enqueue' && RECORDS[i - 1]?.type !== 'queue-operation').map((r) => r._n);
  if (starts.length !== names.length) throw new Error(`${starts.length} run starts in the transcript, ${names.length} runs in chain.txt`);
  return names.map((name, i) => ({ name, start: starts[i], end: (starts[i + 1] ?? Infinity) - 1, live: readDebug(path.join(SANDBOX, 'out', `debug-${name}.txt`)) }));
}

/** The hook's footprint in one run's CC debug log: its session.compact and turn.complete dispatches. */
function readDebug(file) {
  const events = [], regroups = [];
  let open = null, sinceSettle = { logs: [], writes: [] };
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^(\S+) \[(\w+)\] (.*)$/.exec(raw);
    if (!m) continue;
    const at = Date.parse(m[1]), msg = m[3];
    // A resume that repaired duplicated tool_use ids: CC loaded pre-boundary fragments of a split assistant message.
    if (msg.startsWith('ensureToolResultPairing') && !events.some((e) => e.kind === 'compact')) {
      for (const a of msg.matchAll(/assistant\(id=([^,]+), tool_uses=\[([^\]]*)\]\)/g)) {
        const ids = a[2].split(',').filter(Boolean);
        for (const id of new Set(ids.filter((x, i) => ids.indexOf(x) !== i))) if (!regroups.some((g) => g.messageId === a[1] && g.toolId === id)) regroups.push({ messageId: a[1], toolId: id });
      }
    }
    const ui = /^\[(?:exo-compact|exovault-s4-compact)\] \$\.ui\.log: (.*)$/.exec(msg)?.[1];
    const write = /^\$\.fs\.write \((?:exo-compact|exovault-s4-compact)\): (\S+) \((\d+) bytes\)$/.exec(msg);
    const run = /^\$\.process\.run \((?:exo-compact|exovault-s4-compact)\): git with \d+ args in (\S+)/.exec(msg);
    if (ui?.startsWith('compact.sizeBefore=')) { open = { kind: 'compact', at, logs: [], writes: [], cwd: undefined, stand: undefined, late: [] }; events.push(open); }
    const target = open ?? sinceSettle;
    if (ui !== undefined) {
      // Detached-process lines that land after the dispatch settled belong to the last cut.
      const last = events.at(-1);
      if (!open && last?.kind === 'compact' && /^(recall\.build_started|brief_check\.ready)=/.test(ui)) last.late.push(ui);
      else target.logs.push(ui);
    }
    if (write) target.writes.push({ file: path.basename(write[1]), bytes: Number(write[2]) });
    if (run && open && open.cwd === undefined) open.cwd = run[1];
    const stand = /session\.compact \(auto\): a hook's (\d+) messages stand/.exec(msg);
    if (stand && events.at(-1)?.kind === 'compact') events.at(-1).stand = Number(stand[1]);
    if (/hooks module (?:exo-compact|exovault-s4-compact)@inline session\.compact settled/.test(msg) && open) { open.settledAt = at; open = null; }
    if (/hooks module (?:exo-compact|exovault-s4-compact)@inline turn\.complete settled/.test(msg)) events.push({ kind: 'turn', at, logs: sinceSettle.logs, writes: sinceSettle.writes });
    if (/hooks module (?:exo-compact|exovault-s4-compact)@inline \S+ settled/.test(msg)) sinceSettle = { logs: [], writes: [] };
  }
  return { events, regroups };
}

// ---------- the conversation the CLI held at an event ----------
/**
 * The messages the CLI handed the hook at transcript line `line` of `run`: the records after the latest
 * compact_boundary. After a native boundary that is core's summary followed by the messages core kept
 * (compactMetadata.preservedMessages), then everything later; after a plugin cut the seed and tail are records.
 * A run that resumed into this stretch and logged ensureToolResultPairing also held the pre-boundary fragments of
 * that split assistant message (and their tool result), next to the copies the tail kept.
 */
function contextAt(line, run, notes) {
  const bIndex = BOUNDARIES.findLastIndex((b) => b._n < line);
  const boundary = BOUNDARIES[bIndex];
  const from = boundary?._n ?? 0;
  const list = [];
  for (const r of RECORDS) {
    if (r._n <= from || r._n >= line) continue;
    if (!isMessage(r)) continue;
    list.push(r);
    if (r.isCompactSummary) list.push(...nativeKept(boundary));
  }
  if (!noRegroup && run.live.regroups.length && from < run.start) {
    const prevFrom = BOUNDARIES[bIndex - 1]?._n ?? 0;
    const pre = RECORDS.filter((r) => r._n > prevFrom && r._n < from && isMessage(r));
    for (const { messageId, toolId } of run.live.regroups) {
      const fragments = pre.filter((r) => r.type === 'assistant' && r.message?.id === messageId);
      const results = pre.filter((r) => r.type === 'user' && hasResult(r, toolId));
      const at = list.findIndex((r) => r.type === 'assistant' && r.message?.id === messageId);
      if (!fragments.length || at < 0) { notes.push(`regroup ${messageId} not applied`); continue; }
      list.splice(at, 0, ...fragments);
      const resultAt = list.findIndex((r) => r.type === 'user' && hasResult(r, toolId) && !results.includes(r));
      if (resultAt >= 0) list.splice(resultAt, 0, ...results);
      notes.push(`regroup ${messageId.slice(-6)}: +lines ${[...fragments, ...results].map((r) => r._n).join(',')}`);
    }
  }
  return list;
}
/**
 * session.compact's event.messages hold one assistant turn's parallel tool calls together, then their results
 * (a a u u), while the transcript (and turn.complete's $.session.messages()) has them interleaved (a u a u).
 * Evidence: the live segment captured those calls in a a u u order at cuts 5 and 8, and cut 8's tail came back so.
 */
function groupParallelCalls(list, notes) {
  if (noParallel) return list;
  const out = [];
  for (let i = 0; i < list.length;) {
    const head = list[i];
    if (head.type !== 'assistant' || !head.message?.id) { out.push(head); i += 1; continue; }
    const fragments = [], results = [], toolIds = new Set();
    let j = i;
    for (; j < list.length; j += 1) {
      const r = list[j];
      if (r.type === 'assistant' && r.message?.id === head.message.id) {
        fragments.push(r);
        for (const p of r.message.content ?? []) if (p?.type === 'tool_use') toolIds.add(p.id);
      } else if (r.type === 'user' && Array.isArray(r.message?.content) && r.message.content.length && r.message.content.every((p) => p?.type === 'tool_result' && toolIds.has(p.tool_use_id))) results.push(r);
      else break;
    }
    const grouped = [...fragments, ...results];
    if (grouped.some((r, k) => r !== list[i + k])) notes.push(`parallel calls grouped at lines ${grouped.map((r) => r._n).join(',')}`);
    out.push(...grouped);
    i = j;
  }
  return out;
}
const hasResult = (r, toolId) => Array.isArray(r.message?.content) && r.message.content.some((p) => p?.type === 'tool_result' && p.tool_use_id === toolId);
const nativeKept = (boundary) => (boundary?.compactMetadata?.preservedMessages?.uuids ?? []).map((u) => byUuid.get(u)).filter((r) => r && isMessage(r));
/** What core handed back at a native boundary: its summary and the messages it kept. */
function coreResult(boundary) {
  // Only this cut's summary: never one from a later boundary (external review 4, C2).
  const nextBoundary = BOUNDARIES.find((b) => b._n > boundary._n)?._n ?? Infinity;
  const summary = RECORDS.find((r) => r._n > boundary._n && r._n < nextBoundary && r.isCompactSummary);
  return [summary, ...nativeKept(boundary)].filter(Boolean);
}
const lastBefore = (line, field) => { for (let i = RECORDS.findLastIndex((r) => r._n < line); i >= 0; i -= 1) if (RECORDS[i][field]) return RECORDS[i][field]; return undefined; };
/** The transcript size a launcher started at `line` saw: everything before it except CC's trailing bookkeeping lines. */
function cutoffAt(line) {
  let i = RECORDS.findLastIndex((r) => r._n < line);
  while (i >= 0 && TRAILING_META.has(RECORDS[i].type)) i -= 1;
  return i < 0 ? 0 : RECORDS[i]._offset + RECORDS[i]._bytes;
}

// ---------- the recall build, emulated ----------
// recall/launch.mjs + build-worker.mjs run detached; the hook only reads the timeline.json they leave. A build
// started at an event is published before the next event (live builds took about a second; events are minutes apart).
const recall = { generation: 0, cutoff: -1, timeline: null, pending: [], log: [] };
function publishBuilds() {
  for (const build of recall.pending.splice(0)) {
    if (build.trigger === 'turn' && recall.cutoff >= 0 && build.cutoff - recall.cutoff < TURN_MIN_GROWTH) { recall.log.push({ ...build, skipped: 'growth' }); continue; }
    if (recall.cutoff >= 0 && build.cutoff <= recall.cutoff) { recall.log.push({ ...build, skipped: 'not_newer' }); continue; }
    const timeline = timelineBuilder();
    for (const r of RECORDS) if (r._offset + r._bytes <= build.cutoff) timeline.add(r);
    recall.generation += 1;
    recall.cutoff = build.cutoff;
    recall.timeline = JSON.stringify({ cutoffPosition: build.cutoff, segments: timeline.result() });
    recall.log.push({ ...build, generation: recall.generation });
  }
}

// ---------- the time-cut host ----------
const OVERLAY = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-replay-'));
const CAPTURE_MARK = `${path.sep}.exovault${path.sep}s4-capture${path.sep}`;
const audit = { outside: new Set(), future: new Map(), hidden: new Set() };
/** Jail path -> sandbox path; null for anything the jail could not see (refused and recorded). */
function toSandbox(p) {
  const abs = path.resolve(String(p));
  for (const [jail, real] of [[`${JAIL_HOME}/.claude/exovault`, path.join(SANDBOX, 'exovault')], [`${JAIL_HOME}/.claude/projects`, projectsDir]]) {
    if (abs === jail || abs.startsWith(`${jail}/`)) return real + abs.slice(jail.length);
  }
  if (abs === SANDBOX || abs.startsWith(`${SANDBOX}/`)) return abs;
  audit.outside.add(abs);
  return null;
}
const overlayPath = (real) => path.join(OVERLAY, real);
const statOf = (p) => { try { return fs.statSync(p); } catch { return null; } };
/**
 * A sandbox file as it was at time T. The capture directory belongs to the replay (it rebuilds segments, watermark,
 * pressure and flags itself); only the adopted rules copies written by prompt.submit are taken from disk. The recall
 * directory shows the brief files that existed at T, briefs.json cut to the entries saved by T, and the timeline
 * from the emulated build. Anything else in the sandbox is shown as it is now, and a file newer than T is recorded.
 */
function view(real, T) {
  const recallRel = real.startsWith(`${RECALL_DIR}/`) ? real.slice(RECALL_DIR.length + 1) : real === RECALL_DIR ? '' : undefined;
  if (recallRel !== undefined) {
    if (recallRel === '' || recallRel === 'briefs') return statOf(real) ? { kind: 'dir' } : null;
    if (recallRel === 'timeline.json') return recall.timeline === null ? null : { kind: 'file', text: recall.timeline };
    if (recallRel === 'briefs/briefs.json') {
      let entries = [];
      try { entries = JSON.parse(fs.readFileSync(real, 'utf8')).filter((e) => Date.parse(e.at) <= T); } catch { entries = []; }
      return entries.length ? { kind: 'file', text: JSON.stringify(entries) } : null;
    }
    if (recallRel.startsWith('briefs/')) { const st = statOf(real); return st && st.mtimeMs <= T ? fileView(real, st) : null; }
    if (statOf(real)) audit.hidden.add(real);
    return null;
  }
  const capture = real.indexOf(CAPTURE_MARK);
  if (capture >= 0) {
    const rel = real.slice(capture + CAPTURE_MARK.length).split(path.sep).slice(1).join('/');
    if (rel === '') return statOf(real) ? { kind: 'dir' } : null;
    if (rel !== 'adopted.json' && rel !== 'adopted' && !rel.startsWith('adopted/')) { if (statOf(real)) audit.hidden.add(real); return null; }
    const st = statOf(real);
    return st && (st.isDirectory() || st.mtimeMs <= T) ? fileView(real, st) : null;
  }
  const st = statOf(real);
  if (!st) return null;
  // Not time-cut: a file changed after T is read as it is now, and recorded (existence checks are not).
  return fileView(real, st, st.isFile() && st.mtimeMs > T);
}
const fileView = (real, st, future = false) => st.isDirectory() ? { kind: 'dir' } : {
  kind: 'file', size: st.size,
  read: () => { if (future) audit.future.set(real, st.mtime.toISOString()); return fs.readFileSync(real, 'utf8'); },
};

function makeHost(event) {
  const T = event.T;
  const fsApi = {
    async exists(p) {
      const real = toSandbox(p);
      if (!real) return false;
      return fs.existsSync(overlayPath(real)) || view(real, T) !== null;
    },
    async read(p) {
      const real = toSandbox(p);
      if (real && fs.existsSync(overlayPath(real)) && fs.statSync(overlayPath(real)).isFile()) return fs.readFileSync(overlayPath(real), 'utf8');
      const v = real && view(real, T);
      if (!v || v.kind !== 'file') throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return v.text ?? v.read();
    },
    async write(p, text) {
      const real = toSandbox(p);
      if (!real) throw Object.assign(new Error(`EACCES: ${p}`), { code: 'EACCES' });
      fs.mkdirSync(path.dirname(overlayPath(real)), { recursive: true });
      fs.writeFileSync(overlayPath(real), text);
      event.writes.push({ file: path.basename(real), bytes: Buffer.byteLength(text) });
    },
    async list(p) {
      const real = toSandbox(p ?? event.cwd);
      const entries = new Map();
      const over = real && overlayPath(real);
      if (over && statOf(over)?.isDirectory()) for (const d of fs.readdirSync(over, { withFileTypes: true })) entries.set(d.name, { name: d.name, kind: d.isDirectory() ? 'dir' : 'file', size: d.isDirectory() ? 0 : fs.statSync(path.join(over, d.name)).size });
      if (real && view(real, T)?.kind === 'dir' && statOf(real)?.isDirectory()) {
        for (const d of fs.readdirSync(real, { withFileTypes: true })) {
          if (entries.has(d.name)) continue;
          const v = view(path.join(real, d.name), T);
          if (v) entries.set(d.name, { name: d.name, kind: v.kind, size: v.kind === 'file' ? (v.text?.length ?? v.size) : 0 });
        }
        if (real === RECALL_DIR && recall.timeline !== null) entries.set('timeline.json', { name: 'timeline.json', kind: 'file', size: recall.timeline.length });
      } else if (!entries.size && !(over && statOf(over)?.isDirectory())) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return [...entries.values()];
    },
  };
  const processApi = {
    async run(argv, init = {}) {
      event.processes.push(argv.map((a) => path.basename(String(a))).slice(0, 3).join(' '));
      const [cmd, a1] = argv;
      if (cmd === 'git' && argv.includes('status')) {
        // Not on disk: the branch comes from the transcript, the changed-file count from the live seed (see PARITY.md).
        const rows = Array.from({ length: event.git.changed }, (_, i) => ` M changed-${i}\n`).join('');
        return { exitCode: 0, stdout: `## ${event.git.branch}\n${rows}`, stderr: '' };
      }
      if (cmd === 'git' && argv.includes('worktree')) {
        return { exitCode: 0, stdout: `worktree ${event.git.repo}\nHEAD ${'0'.repeat(40)}\nbranch refs/heads/${event.git.branch}\n`, stderr: '' };
      }
      if (cmd === 'node' && String(a1).endsWith('/recall/launch.mjs')) {
        recall.pending.push({ trigger: argv[6] ?? 'cut', cutoff: event.cutoff, at: event.label });
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      // brief-check.mjs, brief.mjs and the like run detached and never finish here (not reproduced).
      if (cmd === 'node') { event.detached.push(path.basename(String(a1))); return new Promise(() => {}); }
      throw new Error(`replay refuses to run ${cmd}`);
    },
  };
  return {
    fs: fsApi,
    ui: { log: (line) => event.logs.push(String(line)), event: () => {} },
    session: { id: async () => SID, cwd: async () => event.cwd, messages: async () => event.messages, surfaces: async () => [] },
    clock: {
      now: async () => T,
      sleep: (ms, { signal } = {}) => new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('aborted'));
        if (ms <= 0) return setImmediate(resolve);
        // A positive sleep is a timeout race the hook must win; it only ends by abort.
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
      after: () => ({ cancel() {} }),
    },
    env: { get: async (name) => (name === 'HOME' ? JAIL_HOME : undefined) },
    http: { fetch: async () => { throw new Error('replay: no network'); } },
    process: processApi,
  };
}

// ---------- comparison helpers ----------
const LOG_IGNORED = /^(dense\.jev_ms|brief_check\.ready)$/;
function logPairs(lines) { return lines.flatMap((line) => line.split(/\s+/).filter((t) => t.includes('=')).map((t) => [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)])); }
/** Deterministic key=value pairs: live values the debug log redacted and wall-clock values are left out. */
function compareLogs(replayLines, liveLines) {
  const live = logPairs(liveLines).filter(([k]) => !LOG_IGNORED.test(k));
  const redacted = new Set(live.filter(([, v]) => v === '[REDACTED]').map(([k]) => k));
  // 4.7.3 (S5m): plugin 4.7.2 and older logged `seed.work_state_tokens` and was redacted; the replay's `_size` keys have no live twin there.
  for (const key of [...redacted]) if (/_tokens$/.test(key)) redacted.add(key.replace(/_tokens$/, '_size'));
  const want = live.filter(([k]) => !redacted.has(k)).map(([k, v]) => `${k}=${v}`).sort();
  const got = logPairs(replayLines).filter(([k]) => !LOG_IGNORED.test(k) && !redacted.has(k)).map(([k, v]) => `${k}=${v}`).sort();
  const missing = want.filter((x, i, a) => got.filter((y) => y === x).length < a.slice(0, i + 1).filter((y) => y === x).length);
  const extra = got.filter((x, i, a) => want.filter((y) => y === x).length < a.slice(0, i + 1).filter((y) => y === x).length);
  return { ok: !missing.length && !extra.length, missing, extra, compared: want.length, redacted: [...redacted] };
}
/** A seed split at its `## ` headings (the first part is what precedes the first heading). */
function sections(text) {
  return text.split(/\n(?=## )/).map((part) => ({ heading: part.startsWith('## ') ? part.split('\n')[0].slice(0, 70) : '(preamble)', chars: part.length, text: part }));
}
function compareSeeds(replay, live) {
  const a = sections(replay), b = sections(live);
  const rows = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const r = a[i], l = b[i];
    const delta = r && l ? (l.chars ? Math.abs(r.chars - l.chars) / l.chars : r.chars ? 1 : 0) : 1;
    rows.push({ heading: r?.heading ?? l?.heading, replay: r?.chars ?? 0, live: l?.chars ?? 0, same: r?.text === l?.text, headingMatch: r?.heading === l?.heading, within: !!(r && l && r.heading === l.heading && delta <= SECTION_TOLERANCE), diff: r && l && r.text !== l.text ? firstDiff(r.text, l.text) : undefined });
  }
  return { exact: replay === live, rows, within: rows.every((x) => x.within), count: [a.length, b.length] };
}
function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  const clip = (s) => JSON.stringify(s.slice(Math.max(0, i - 30), i + 50));
  return `@${i}: replay ${clip(a)} | live ${clip(b)}`;
}
const WRITE_TRACKED = /^(segment-\d+\.json|watermark\.json|compaction-pressure\.json|s4-cut-fresh\.json)$/;
const writeList = (writes) => writes.filter((w) => WRITE_TRACKED.test(w.file)).map((w) => `${w.file}:${w.bytes}`);

// ---------- the replay ----------
const runs = readRuns();
// Claude Code hands the hook every userConfig default from the manifest, under the options set (w17 w60h: the
// manifest's totalBudgetTokens 20000 reached a run that passed none).
const manifestDefaults = (() => {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin/plugin.json'), 'utf8')).userConfig ?? {};
    return Object.fromEntries(Object.entries(config).filter(([, spec]) => spec && 'default' in spec).map(([key, spec]) => [key, spec.default]));
  } catch { return {}; }
})();
const HOOK_OPTIONS = { ...manifestDefaults, ...OPTIONS };
const report = { sandbox: SANDBOX, plugin: PLUGIN, rev: rev ?? 'working tree', options: HOOK_OPTIONS, cuts: [], turns: [], final: {} };
let cutNumber = 0;

outer: for (const run of runs) {
  // One register() per `claude -p` process: the module's per-process caches start empty, as they did live.
  const handlers = {};
  register((name, fn) => { handlers[name] = fn; }, HOOK_OPTIONS);
  const liveCompacts = run.live.events.filter((e) => e.kind === 'compact');
  const liveTurns = run.live.events.filter((e) => e.kind === 'turn');
  const cutsInRun = BOUNDARIES.filter((b) => b._n >= run.start && b._n <= run.end);
  if (cutsInRun.length !== liveCompacts.length) throw new Error(`${run.name}: ${cutsInRun.length} boundaries, ${liveCompacts.length} logged dispatches`);
  for (const [k, boundary] of cutsInRun.entries()) {
    cutNumber += 1;
    const live = liveCompacts[k];
    let entryCardLive;
    publishBuilds();
    const notes = [];
    const context = contextAt(boundary._n, run, notes);
    const seedRecord = RECORDS.find((r) => r._n > boundary._n && r.type === 'user' && !r.isMeta);
    const liveSeedText = typeof seedRecord?.message?.content === 'string' ? seedRecord.message.content : blockText(seedRecord?.message?.content);
    const liveOutcome = live.stand !== undefined ? 'plugin' : `fallback:${/compact\.fallback=(\S+)/.exec(live.logs.join('\n'))?.[1] ?? 'unknown'}`;
    const liveChanged = Number(/Git at the cut: [^\n]*; (\d+) changed file/.exec(liveSeedText)?.[1] ?? NaN);
    const event = {
      label: `cut ${cutNumber}`, T: live.at, cwd: lastBefore(boundary._n, 'cwd'), cutoff: cutoffAt(boundary._n),
      messages: groupParallelCalls(context, notes).map(sessionMessage), logs: [], writes: [], processes: [], detached: [],
      git: { branch: lastBefore(boundary._n, 'gitBranch'), changed: liveOutcome === 'plugin' && Number.isFinite(liveChanged) ? liveChanged : 0, repo: path.join(SANDBOX, PROJECT_DIR), borrowed: liveOutcome === 'plugin' && Number.isFinite(liveChanged) },
    };
    let nextCalled = false;
    const kept = coreResult(boundary);
    const next = async () => { nextCalled = true; return { messages: kept.map(sessionMessage), native: true }; };
    if (cardStub || cardStale) writeCardStub(live.at, cardStale);
    if (cardLive) entryCardLive = writeCardLive(run, boundary, live.at, liveSeedText);
    const result = await handlers['session.compact'](makeHost(event), { trigger: 'auto', messages: event.messages }, next);
    await new Promise((resolve) => setImmediate(resolve));
    const outcome = nextCalled ? `fallback:${/compact\.fallback=(\S+)/.exec(event.logs.join('\n'))?.[1] ?? 'unknown'}` : 'plugin';
    const replaySeed = !nextCalled ? result.messages[0]?.text ?? '' : undefined;
    const tail = !nextCalled ? result.messages.slice(1) : [];
    const liveTail = live.stand !== undefined ? RECORDS.filter((r) => r._n > seedRecord._n && isMessage(r)).slice(0, live.stand - 1).map(sessionMessage) : [];
    if (DUMP) {
      fs.mkdirSync(DUMP, { recursive: true });
      // A native cut also kept its preserved messages (external review 4, D1): the live file has them too.
      const liveKept = liveOutcome === 'plugin' ? [] : nativeKept(boundary).map((r) => JSON.stringify(sessionMessage(r)));
      fs.writeFileSync(path.join(DUMP, `cut-${cutNumber}.live.txt`), [liveSeedText ?? '', ...liveKept].join('\n'));
      if (replaySeed !== undefined) fs.writeFileSync(path.join(DUMP, `cut-${cutNumber}.replay.txt`), [replaySeed, ...tail.map((m) => JSON.stringify(m))].join('\n'));
    }
    const id = (m) => contentIdentity(m, sha);
    const entry = {
      cut: cutNumber, line: boundary._n, run: run.name, at: new Date(live.at).toISOString(), cwd: event.cwd, liveCwd: live.cwd, notes,
      messages: event.messages.length,
      outcome, liveOutcome, outcomeMatch: outcome === liveOutcome,
      logs: event.logs, liveLogs: [...live.logs, ...live.late],
      logCompare: compareLogs(event.logs, [...live.logs, ...live.late.filter((l) => !l.startsWith('brief_check.ready'))]),
      writes: writeList(event.writes), liveWrites: writeList(live.writes),
      git: event.git, detached: event.detached, cutoff: event.cutoff,
    };
    if (cardLive) {
      const num = (key) => Number(new RegExp(`${key}=(\\d+)`).exec(event.logs.join('\n'))?.[1] ?? 0);
      Object.assign(entry, {
        sinceCardSteps: num('seed\\.since_card'), sinceCardTokens: num('seed\\.since_card_size'),
        sinceCardHorizon: /seed\.since_card_horizon=(\S+)/.exec(event.logs.join('\n'))?.[1] ?? 'off',
        fallback: nextCalled ? /compact\.fallback=(\S+)/.exec(event.logs.join('\n'))?.[1] ?? 'unknown' : null,
        cardLive: entryCardLive ?? null,
      });
      entry.sinceCardText = /\n## Since the card\n([\s\S]*?)(?=\n\n## |$)/.exec(replaySeed ?? '')?.[1] ?? null;
    }
    entry.writesMatch = entry.writes.join() === entry.liveWrites.join();
    if (replaySeed !== undefined) {
      entry.seed = { chars: replaySeed.length, liveChars: liveSeedText.length, ...compareSeeds(replaySeed, liveSeedText) };
      entry.tail = { count: tail.length, chars: tail.reduce((n, m) => n + messageChars(m), 0), liveCount: liveTail.length, liveChars: liveTail.reduce((n, m) => n + messageChars(m), 0), sameIdentities: tail.length === liveTail.length && tail.every((m, i) => id(m) === id(liveTail[i])) };
    }
    report.cuts.push(entry);
    if (wantCut !== undefined && cutNumber === wantCut) break outer;
  }
  // The run's one turn.complete, after its last answer.
  publishBuilds();
  const liveTurn = liveTurns[0];
  const endLine = Math.min(run.end + 1, RECORDS.at(-1)._n + 1);
  const notes = [];
  const context = contextAt(endLine, run, notes);
  const event = { label: `${run.name} turn`, T: liveTurn?.at ?? Date.parse(lastBefore(endLine, 'timestamp')), cwd: lastBefore(endLine, 'cwd'), cutoff: cutoffAt(endLine), messages: context.map(sessionMessage), logs: [], writes: [], processes: [], detached: [], git: { branch: lastBefore(endLine, 'gitBranch'), changed: 0, repo: path.join(SANDBOX, PROJECT_DIR) } };
  await handlers['turn.complete'](makeHost(event), { reason: 'answer' }, async () => ({ text: '' }));
  await new Promise((resolve) => setImmediate(resolve));
  const turn = { run: run.name, at: new Date(event.T).toISOString(), messages: event.messages.length, notes, logs: event.logs, liveLogs: liveTurn?.logs ?? [], writes: writeList(event.writes), liveWrites: writeList(liveTurn?.writes ?? []) };
  turn.writesMatch = turn.writes.join() === turn.liveWrites.join();
  report.turns.push(turn);
}
publishBuilds();

// ---------- final state against the sandbox ----------
const captureReal = path.join(SANDBOX, PROJECT_DIR, '.exovault/s4-capture', SID);
const sameFile = (rel) => { const a = overlayPath(path.join(captureReal, rel)); return fs.existsSync(a) && fs.readFileSync(a, 'utf8') === fs.readFileSync(path.join(captureReal, rel), 'utf8'); };
const manifests = fs.readdirSync(RECALL_DIR).filter((d) => d.startsWith('generation-')).map((d) => JSON.parse(fs.readFileSync(path.join(RECALL_DIR, d, 'manifest.json'), 'utf8')));
const fullRun = wantCut === undefined;
/** The session map the last build left: same segments, and the cutoff it was built at. */
function timelineParity(replay, live) {
  const a = JSON.parse(replay ?? '{}'), b = JSON.parse(live);
  return { segments: JSON.stringify(a.segments) === JSON.stringify(b.segments), cutoff: a.cutoffPosition, liveCutoff: b.cutoffPosition };
}
if (fullRun) {
  report.final = {
    segment: sameFile('segment-000001.json'), watermark: sameFile('watermark.json'), pressure: sameFile('compaction-pressure.json'),
    timeline: timelineParity(recall.timeline, fs.readFileSync(path.join(RECALL_DIR, 'timeline.json'), 'utf8')),
    generations: { replay: recall.generation, live: Number(fs.readFileSync(path.join(RECALL_DIR, 'CURRENT'), 'utf8').trim()) },
    liveManifests: manifests.map((m) => ({ generation: m.generation, cutoff: m.cutoffPosition })),
    replayBuilds: recall.log.filter((b) => b.generation >= Math.min(...manifests.map((m) => m.generation))).map((b) => ({ generation: b.generation, cutoff: b.cutoff, at: b.at })),
  };
}
report.audit = { outsideJail: [...audit.outside], newerThanEvent: [...audit.future].map(([p, m]) => `${p} (${m})`), hiddenFromHook: [...audit.hidden] };
report.builds = recall.log;

// ---------- output ----------
const yes = (b) => (b ? 'yes' : 'NO');
for (const c of report.cuts) {
  if (wantCut !== undefined && c.cut !== wantCut) continue;
  console.log(`\n=== cut ${c.cut}  line ${c.line}  ${c.run}  ${c.at}  ${c.messages} messages`);
  console.log(`cwd ${c.cwd}${c.liveCwd && c.liveCwd !== c.cwd ? `  (live git ran in ${c.liveCwd})` : ''}`);
  for (const n of c.notes) console.log(`note: ${n}`);
  console.log(`outcome: replay ${c.outcome} | live ${c.liveOutcome}  match=${yes(c.outcomeMatch)}`);
  console.log('ui.log:'); for (const l of c.logs) console.log(`  ${l}`);
  console.log(`log values: ${c.logCompare.ok ? 'match' : 'DIFF'} (${c.logCompare.compared} compared; redacted live: ${c.logCompare.redacted.join(', ') || 'none'})`);
  if (!c.logCompare.ok) console.log(`  missing ${c.logCompare.missing.join(' ')} | extra ${c.logCompare.extra.join(' ')}`);
  console.log(`writes: ${c.writesMatch ? 'match' : 'DIFF'}  replay ${c.writes.join(' ')}${c.writesMatch ? '' : ` | live ${c.liveWrites.join(' ')}`}`);
  console.log(`git: ## ${c.git.branch}; ${c.git.changed} changed (${c.git.borrowed ? 'from the live seed' : 'not known, 0'})`);
  if (c.seed) {
    console.log(`seed: ${c.seed.chars} chars (live ${c.seed.liveChars}) exact=${yes(c.seed.exact)} sections ${c.seed.count[0]}/${c.seed.count[1]} all within 5%=${yes(c.seed.within)}`);
    for (const s of c.seed.rows) console.log(`  ${s.same ? ' ' : s.within ? '~' : '!'} ${String(s.replay).padStart(6)} ${String(s.live).padStart(6)}  ${s.heading}${s.diff && !s.within ? `\n        ${s.diff}` : ''}`);
    console.log(`tail: ${c.tail.count} messages ${c.tail.chars} chars (live ${c.tail.liveCount}, ${c.tail.liveChars}) same messages=${yes(c.tail.sameIdentities)}`);
  }
}
if (fullRun) {
  console.log('\n=== turn.complete per run');
  for (const t of report.turns) console.log(`${t.run.padEnd(6)} ${t.messages} msgs  writes ${t.writesMatch ? 'match' : 'DIFF'} ${t.writes.join(' ')}${t.writesMatch ? '' : ` | live ${t.liveWrites.join(' ')}`}${t.notes.length ? `  [${t.notes.join('; ')}]` : ''}`);
  console.log('\n=== final state vs sandbox');
  const tl = report.final.timeline;
  console.log(`segment-000001.json ${yes(report.final.segment)}  watermark.json ${yes(report.final.watermark)}  compaction-pressure.json ${yes(report.final.pressure)}  timeline.json segments ${yes(tl.segments)} (cutoff ${tl.cutoff}, live ${tl.liveCutoff})`);
  console.log(`recall generations: replay ${report.final.generations.replay}, live ${report.final.generations.live}`);
  console.log(`live manifests ${report.final.liveManifests.map((m) => `${m.generation}@${m.cutoff}`).join(' ')} | replay ${report.final.replayBuilds.map((m) => `${m.generation}@${m.cutoff}`).join(' ')}`);
  console.log('\n=== summary');
  const cuts = report.cuts;
  console.log('| cut | line | run | live | replay | outcome | log values | writes | seed exact | sections ±5% | tail |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of cuts) console.log(`| ${c.cut} | ${c.line} | ${c.run} | ${c.liveOutcome} | ${c.outcome} | ${yes(c.outcomeMatch)} | ${c.logCompare.ok ? 'yes' : 'NO'} | ${yes(c.writesMatch)} | ${c.seed ? yes(c.seed.exact) : '–'} | ${c.seed ? `${c.seed.rows.filter((r) => r.within).length}/${c.seed.rows.length}` : '–'} | ${c.tail ? `${c.tail.count}/${c.tail.liveCount}${c.tail.sameIdentities ? '' : ' DIFF'}` : '–'} |`);
  const cwdOff = cuts.filter((c) => c.liveCwd && c.liveCwd !== c.cwd).map((c) => c.cut);
  console.log(`\nsession cwd = cwd of the live git probe: ${cuts.length - cwdOff.length}/${cuts.length}${cwdOff.length ? ` (differs at cuts ${cwdOff.join(', ')})` : ''}`);
  console.log(`outcome ${cuts.filter((c) => c.outcomeMatch).length}/${cuts.length}, log values ${cuts.filter((c) => c.logCompare.ok).length}/${cuts.length}, plugin seeds exact ${cuts.filter((c) => c.seed?.exact).length}/${cuts.filter((c) => c.seed).length}, sections within 5% ${cuts.filter((c) => c.seed?.within).length}/${cuts.filter((c) => c.seed).length}`);
}
console.log(`\naudit: outside the jail ${report.audit.outsideJail.length ? report.audit.outsideJail.join(', ') : 'none'}; files newer than the event read ${report.audit.newerThanEvent.length ? report.audit.newerThanEvent.join(', ') : 'none'}; hidden from the hook ${report.audit.hiddenFromHook.length}`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
if (keep) console.log(`overlay kept at ${OVERLAY}`); else fs.rmSync(OVERLAY, { recursive: true, force: true });
if (revDir) fs.rmSync(revDir, { recursive: true, force: true });

/** A worst-case card: the newest brief saved by T (or the cut's user messages), longer than the plugin's cap. */
function writeCardStub(T, stale = false) {
  let source = '';
  let briefId;
  try {
    const entries = JSON.parse(fs.readFileSync(path.join(RECALL_DIR, 'briefs/briefs.json'), 'utf8')).filter((e) => Date.parse(e.at) <= T);
    const newest = entries.at(stale ? -2 : -1);
    if (newest) { source = fs.readFileSync(toSandbox(newest.path), 'utf8'); briefId = newest.id; }
  } catch { source = ''; }
  if (!source) source = RECORDS.filter((r) => r.type === 'user' && typeof r.message?.content === 'string' && Date.parse(r.timestamp) <= T).map((r) => r.message.content).join('\n');
  const rules = source.split('\n').filter((line) => line.trim()).map((line) => `- ${line.trim()}`).join('\n').slice(0, 12000);
  const card = `# Task card\n## Goal\nContinue the current task.\n## Rules\n${rules}\n## Acceptance checks\n- the checks the brief names pass\n`;
  const dir = overlayPath(path.join(SANDBOX, PROJECT_DIR, '.exovault/s4-capture', SID));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task-card.md'), card);
  if (briefId !== undefined) fs.writeFileSync(path.join(dir, 'task-card.brief'), briefId);
}

/**
 * --card-live: the card the live seed carried and the horizon of the refresh that wrote it. The card is the seed's
 * `## Task card` section turned back into the file format (pointer line dropped, `### ` headings back to `## `). The
 * horizon is the last assistant tool_use at or before the `task_card.refresh=start` that precedes the last
 * `task_card.refresh=written` before the cut, from the run's debug log.
 */
function writeCardLive(run, boundary, cutAt, liveSeed) {
  const dir = overlayPath(path.join(SANDBOX, PROJECT_DIR, '.exovault/s4-capture', SID));
  fs.mkdirSync(dir, { recursive: true });
  const section = /(?:^|\n)## Task card\n([\s\S]*?)(?=\n\n## |$)/.exec(liveSeed)?.[1];
  if (section === undefined) return { card: false };
  const body = section.replace(/^\(Kept current by this session's model[^\n]*\)\n?/, '').replace(/^### /gm, '## ');
  fs.writeFileSync(path.join(dir, 'task-card.md'), `# Task card\n${body}\n`);
  let start, written;
  for (const raw of fs.readFileSync(path.join(SANDBOX, 'out', `debug-${run.name}.txt`), 'utf8').split('\n')) {
    const m = /^(\S+) \[\w+\] .*\$\.ui\.log: task_card\.refresh=(start|written)\b/.exec(raw);
    if (!m) continue;
    const at = Date.parse(m[1]);
    if (at > cutAt) break;
    if (m[2] === 'start') start = at; else if (start !== undefined) written = start;
  }
  let toolUseId;
  if (written !== undefined) {
    for (const r of RECORDS) {
      if (r._n >= boundary._n) break;
      if (r.type !== 'assistant' || !(Date.parse(r.timestamp) <= written)) continue;
      for (const b of Array.isArray(r.message?.content) ? r.message.content : []) if (b?.type === 'tool_use' && b.id) toolUseId = b.id;
    }
  }
  fs.writeFileSync(path.join(dir, 'task-card.horizon.json'), toolUseId === undefined ? '{}' : JSON.stringify({ toolUseId, at: new Date(written).toISOString(), tokens: 0 }));
  return { card: true, horizon: toolUseId ?? null };
}
