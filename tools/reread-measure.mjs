#!/usr/bin/env node
// Measures file re-reads after compactions, and how many a "re-attach recent files" rule would
// have covered. Reads local transcripts only; prints paths and numbers, never file content.
//   node tools/reread-measure.mjs <transcript.jsonl>... [--json]
// A read is a Read call, or a Bash cat/head/tail/nl/sed -n on a path. Edits (Edit/Write/
// MultiEdit) count as touching a file. Records the host copies after a cut (same tool_use id as
// before the cut) are skipped, so the kept tail is not counted as new work.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const POST_WINDOW_TOOL_USES = 40;
export const POLICIES = [
  { name: '8k/3k', totalTokens: 8000, perFileTokens: 3000 },
  { name: '16k/5k', totalTokens: 16000, perFileTokens: 5000 },
  { name: 'edited 8k/3k', totalTokens: 8000, perFileTokens: 3000, editedOnly: true },
];
const tokensOf = (chars) => Math.ceil(chars / 4);
const READ_CMD = /(?:^|[;&|(]\s*|\s)(cat|head|tail|nl|less|bat|sed\s+-n\s+(?:'[^']*'|"[^"]*"|\S+))\s+((?:-\S+\s+)*)([^\s;&|<>]+(?:\s+[^\s;&|<>-][^\s;&|<>]*)*)/g;
const PATHISH = /^[~./\w-][\w./~-]*\.[A-Za-z0-9]{1,8}$/;

// Paths in a Bash command are POSIX on every platform (Git Bash on Windows too).
function resolve(file, cwd) {
  if (!file) return null;
  if (file.startsWith('~/')) file = path.posix.join(process.env.HOME ?? '/', file.slice(2));
  return path.posix.normalize(path.posix.isAbsolute(file) ? file : path.posix.join(cwd ?? '/', file));
}

/** Files a Bash command reads, resolved against a leading `cd DIR &&` when present. */
export function bashReads(command, cwd) {
  const cd = /^\s*cd\s+([^\s;&|]+)\s*&&/.exec(command);
  const base = cd ? resolve(cd[1], cwd) : cwd;
  const files = new Set();
  for (const match of command.matchAll(READ_CMD)) {
    for (const arg of match[3].split(/\s+/)) if (PATHISH.test(arg) && !/\.log$/.test(arg)) files.add(resolve(arg, base));
  }
  return [...files];
}

function toolUses(record) {
  const content = record.message?.content;
  return Array.isArray(content) ? content.filter((part) => part?.type === 'tool_use') : [];
}

function resultChars(part) {
  const c = part.content;
  if (typeof c === 'string') return c.length;
  if (Array.isArray(c)) return c.reduce((n, x) => n + (typeof x?.text === 'string' ? x.text.length : 0), 0);
  return 0;
}

/** Linear event list: cuts, and reads/edits with their result size. */
export function events(lines) {
  const seen = new Set();
  const pending = new Map();
  const out = [];
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      out.push({ type: 'cut', at: record.timestamp, trigger: record.compactMetadata?.trigger, kind: 'unknown' });
      continue;
    }
    const lastCut = out.findLast?.((e) => e.type === 'cut');
    if (record.type === 'user' && lastCut && lastCut.kind === 'unknown') {
      const c = record.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((x) => typeof x?.text === 'string')?.text ?? '') : '';
      if (text.startsWith('[[exovault:s4-seed:v1]]')) lastCut.kind = 's4';
      else if (record.isCompactSummary || text.startsWith('This session is being continued')) lastCut.kind = 'native';
    }
    if (record.type === 'user' && Array.isArray(record.message?.content)) {
      for (const part of record.message.content) {
        if (part?.type !== 'tool_result') continue;
        const event = pending.get(part.tool_use_id);
        if (event) { event.tokens = tokensOf(resultChars(part)); pending.delete(part.tool_use_id); }
      }
    }
    for (const use of toolUses(record)) {
      if (seen.has(use.id)) continue;
      seen.add(use.id);
      const input = use.input ?? {};
      let files = [];
      let kind = 'read';
      if (use.name === 'Read') files = [resolve(input.file_path, record.cwd)];
      else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(use.name)) { files = [resolve(input.file_path ?? input.notebook_path, record.cwd)]; kind = 'edit'; }
      else if (use.name === 'Bash' && typeof input.command === 'string') files = bashReads(input.command, record.cwd);
      out.push({ type: 'tool', id: use.id, name: use.name, files: files.filter(Boolean), kind, tokens: 0 });
      pending.set(use.id, out.at(-1));
    }
  }
  return out;
}

/** Recency-ordered selection under a policy; a file larger than the per-file cap is partial. */
export function select(segmentFiles, policy) {
  const picked = new Map();
  let used = 0;
  for (const [file, info] of [...segmentFiles].sort((a, b) => b[1].last - a[1].last)) {
    if (policy.editedOnly && !info.edited) continue;
    const size = Math.min(info.tokens || policy.perFileTokens, policy.perFileTokens);
    if (used + size > policy.totalTokens) continue;
    used += size;
    picked.set(file, { full: (info.tokens || 0) <= policy.perFileTokens });
  }
  return { picked, used };
}

export function measure(lines) {
  const list = events(lines);
  const cuts = [];
  let segment = new Map();
  let order = 0;
  for (let i = 0; i < list.length; i += 1) {
    const event = list[i];
    if (event.type === 'tool') {
      for (const file of event.files) {
        const info = segment.get(file) ?? { tokens: 0, last: 0 };
        info.last = ++order;
        if (event.kind === 'edit') info.edited = true;
        if (event.kind === 'read') info.tokens = Math.max(info.tokens, event.files.length === 1 ? event.tokens : Math.ceil(event.tokens / event.files.length));
        segment.set(file, info);
      }
      continue;
    }
    const post = [];
    for (let j = i + 1; j < list.length && list[j].type === 'tool' && post.length < POST_WINDOW_TOOL_USES; j += 1) post.push(list[j]);
    const rereads = new Map();
    for (const use of post) {
      if (use.kind !== 'read') continue;
      for (const file of use.files) if (segment.has(file)) rereads.set(file, (rereads.get(file) ?? 0) + (use.files.length === 1 ? use.tokens : Math.ceil(use.tokens / use.files.length)));
    }
    const policies = {};
    for (const policy of POLICIES) {
      const { picked, used } = select(segment, policy);
      let hitFiles = 0, fullHitFiles = 0, savedTokens = 0;
      for (const [file, tokens] of rereads) {
        const hit = picked.get(file);
        if (!hit) continue;
        hitFiles += 1;
        if (hit.full) { fullHitFiles += 1; savedTokens += tokens; }
      }
      policies[policy.name] = { injectedTokens: used, hitFiles, fullHitFiles, savedTokens };
    }
    cuts.push({
      at: event.at, kind: event.kind, trigger: event.trigger,
      segmentFiles: segment.size, postToolUses: post.length,
      rereadFiles: rereads.size, rereadTokens: [...rereads.values()].reduce((a, b) => a + b, 0),
      rereads: [...rereads.keys()], policies,
    });
    segment = new Map();
  }
  return cuts;
}

function main(argv) {
  const files = argv.filter((a) => !a.startsWith('--'));
  const report = files.map((file) => ({ session: path.basename(file, '.jsonl').slice(0, 8), cuts: measure(fs.readFileSync(file, 'utf8').split('\n')) }));
  if (argv.includes('--json')) { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return; }
  const rows = [];
  const total = { cuts: 0, withRereads: 0, rereadFiles: 0, rereadTokens: 0 };
  const perPolicy = Object.fromEntries(POLICIES.map((p) => [p.name, { injected: 0, hitFiles: 0, fullHitFiles: 0, saved: 0 }]));
  for (const { session, cuts } of report) for (const cut of cuts) {
    total.cuts += 1; total.rereadFiles += cut.rereadFiles; total.rereadTokens += cut.rereadTokens;
    if (cut.rereadFiles) total.withRereads += 1;
    for (const p of POLICIES) {
      const r = cut.policies[p.name];
      perPolicy[p.name].injected += r.injectedTokens; perPolicy[p.name].hitFiles += r.hitFiles; perPolicy[p.name].fullHitFiles += r.fullHitFiles; perPolicy[p.name].saved += r.savedTokens;
    }
    const pol = POLICIES.map((p) => { const r = cut.policies[p.name]; return `${p.name}: hit ${r.hitFiles} (full ${r.fullHitFiles}) inj ${Math.round(r.injectedTokens / 1000)}k saved ${Math.round(r.savedTokens / 1000)}k`; }).join(' | ');
    rows.push(`${session} ${String(cut.at).slice(5, 16)} ${cut.kind.padEnd(6)} seg ${String(cut.segmentFiles).padStart(3)} files, post ${String(cut.postToolUses).padStart(2)} tools, reread ${cut.rereadFiles} (${Math.round(cut.rereadTokens / 1000)}k) | ${pol}`);
  }
  rows.push('');
  rows.push(`cuts ${total.cuts}, with re-reads ${total.withRereads}, re-read files ${total.rereadFiles}, re-read tokens ${Math.round(total.rereadTokens / 1000)}k`);
  for (const p of POLICIES) {
    const r = perPolicy[p.name];
    rows.push(`${p.name}: covers ${r.hitFiles}/${total.rereadFiles} files (${r.fullHitFiles} fully), saves ${Math.round(r.saved / 1000)}k of ${Math.round(total.rereadTokens / 1000)}k, costs ${Math.round(r.injected / 1000)}k injected over ${total.cuts} cuts`);
  }
  process.stdout.write(`${rows.join('\n')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2));
