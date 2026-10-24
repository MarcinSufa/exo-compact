#!/usr/bin/env node
// Post-cut behaviour on real transcripts: what the agent does between the cut and its first edit
// ("recovery"), what that costs and how long it takes, and whether its reads hit files the injected
// seed/summary named (the "index"). Prints aggregate numbers only, no transcript content.
//
//   node tools/real-replay/postcut.mjs [--since 2026-09-29T22:30] [--json rows.json] <transcript.jsonl>...
//
// Cost is in input-token equivalents: input 1, cache write 1.25, cache read 0.1, output 5
// (Anthropic list-price ratios); PRICE_PER_MTOK (default 5) turns it into dollars. Time to the first edit
// is active time (gaps capped at 120 s) and only counts cuts with no user message before that edit.
import fs from 'node:fs';
import path from 'node:path';

const SEED = '[[exovault:s4-seed:v1]]';
const WRITE = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SEARCH = new Set(['Grep', 'Glob']);
const SEARCH_BASH = /(^|[;&|(]\s*)(grep|rg|find|ls|git (log|grep|ls-files))\b/;
const READ_BASH = /(?:^|[;&|(]\s*)(?:cat|head|tail|sed -n \S+|less|wc -l)(?:\s+-\S+)*\s+([^\s|;&<>]+)/g;
const PRICE = Number(process.env.PRICE_PER_MTOK ?? 5);
const WINDOW = 20;
const IDLE_S = 120;

const args = process.argv.slice(2);
let since = 0, jsonOut;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--since') since = Date.parse(args[++i]);
  else if (args[i] === '--json') jsonOut = args[++i];
  else files.push(args[i]);
}

const ts = (e) => Date.parse(e.timestamp ?? '') || 0;
const content = (e) => (e.message && typeof e.message === 'object' ? e.message.content : undefined);
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.text ?? (typeof b.content === 'string' ? b.content : '')).join('\n') : '');
const toolUses = (e) => (e.type === 'assistant' && Array.isArray(content(e)) ? content(e).filter((b) => b.type === 'tool_use') : []);
const isRealUser = (e) => e.type === 'user' && !e.isMeta && !e.isCompactSummary && typeof content(e) === 'string' && !content(e).startsWith(SEED) && !content(e).startsWith('<');
const weighted = (u) => (u.input_tokens ?? 0) + 1.25 * (u.cache_creation_input_tokens ?? 0) + 0.1 * (u.cache_read_input_tokens ?? 0) + 5 * (u.output_tokens ?? 0);

function readPaths(u) {
  const i = u.input ?? {};
  if (u.name === 'Read' || u.name === 'NotebookRead') return [String(i.file_path ?? '')].filter(Boolean);
  if (u.name === 'Bash') return [...String(i.command ?? '').matchAll(READ_BASH)].map((m) => m[1]).filter((p) => /[/.]/.test(p));
  return [];
}
const isSearch = (u) => SEARCH.has(u.name) || (u.name === 'Bash' && SEARCH_BASH.test(String(u.input?.command ?? '')));
// A path counts as named by the seed if the seed has the full path, the repo-relative tail, or a distinctive basename.
function named(seed, p) {
  if (seed.includes(p)) return true;
  const parts = p.split('/').filter(Boolean);
  for (let k = Math.min(parts.length, 3); k >= 2; k--) if (seed.includes(parts.slice(-k).join('/'))) return true;
  const base = parts.at(-1) ?? '';
  return base.length >= 8 && seed.includes(base);
}

const rows = [];
for (const file of files) {
  const ev = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const bIdx = ev.map((e, i) => (e.type === 'system' && e.subtype === 'compact_boundary' ? i : -1)).filter((i) => i >= 0);
  bIdx.forEach((b, n) => {
    if (ts(ev[b]) < since) return;
    const end = bIdx[n + 1] ?? ev.length;
    const meta = ev[b].compactMetadata ?? {};
    const firstInj = ev.slice(b + 1, b + 6).find((e) => e.type === 'user');
    const injT = firstInj ? ts(firstInj) : ts(ev[b]);
    const injected = ev.slice(b + 1, end).filter((e) => ts(e) <= injT + 2000 && e.type === 'user');
    const seed = injected.map((e) => textOf(content(e))).join('\n');
    const kind = seed.includes(SEED) ? 's4' : 'native';
    const post = ev.slice(b + 1, end).filter((e) => ts(e) > injT + 2000 && e.message?.model !== '<synthetic>');
    // Continuation = the agent resumed work without a new user message first (comparable across arms).
    const firstUser = post.findIndex(isRealUser), firstAsst = post.findIndex((e) => e.type === 'assistant');
    const continuation = firstAsst >= 0 && (firstUser < 0 || firstAsst < firstUser);
    const tools = post.flatMap((e) => toolUses(e).map((u) => ({ u, t: ts(e), id: e.message?.id })));
    const fw = tools.findIndex((x) => WRITE.has(x.u.name));
    const win = tools.slice(0, fw >= 0 ? Math.min(fw, WINDOW) : WINDOW);
    const winIds = new Set(win.map((x) => x.u.id));
    const lastT = win.length ? win.at(-1).t : injT;
    // Cost of the window: every assistant message up to the last windowed tool call, deduplicated by message id.
    const seen = new Set(); let cost = 0, calls = 0, ctxFirst = 0;
    for (const e of post) {
      if (e.type !== 'assistant' || ts(e) > lastT) continue;
      const id = e.message?.id; if (!id || seen.has(id)) continue; seen.add(id);
      const u = e.message.usage ?? {};
      if (!calls) ctxFirst = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      cost += weighted(u); calls++;
    }
    let pulled = 0;
    for (const e of post) {
      const c = content(e);
      if (e.type === 'user' && Array.isArray(c)) for (const r of c) if (r.type === 'tool_result' && winIds.has(r.tool_use_id)) pulled += Math.ceil(JSON.stringify(r.content ?? '').length / 4);
    }
    const reads = win.flatMap((x) => readPaths(x.u));
    // Active seconds to the first edit: gaps over IDLE_S (the user away, a long build) count as IDLE_S.
    let activeS = null, userBeforeWrite = false;
    if (fw >= 0) {
      const until = tools[fw].t; let prev = injT; activeS = 0;
      for (const e of post) { const t = ts(e); if (t > until) break; if (isRealUser(e)) userBeforeWrite = true; activeS += Math.min(IDLE_S, Math.max(0, t - prev) / 1000); prev = t; }
      activeS = Math.round(activeS);
    }
    rows.push({
      file: path.basename(file).slice(0, 8), n: n + 1, at: ev[b].timestamp?.slice(0, 16), kind, trigger: meta.trigger, continuation,
      preTok: meta.preTokens ?? 0, ctxFirst, seedTok: Math.ceil(seed.length / 4),
      window: win.length, reachedWrite: fw >= 0 && fw < 60, toFirstWrite: fw,
      secToFirstWrite: fw >= 0 ? Math.round((tools[fw].t - injT) / 1000) : null, activeS, userBeforeWrite,
      calls, costTok: Math.round(cost), pulledTok: pulled,
      reads: reads.length, readsNamed: reads.filter((p) => named(seed, p)).length,
      searches: win.filter((x) => isSearch(x.u)).length,
      recall: win.filter((x) => /exovault-recall__/.test(x.u.name)).length,
    });
  });
}

const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const k = (n) => (n == null ? '-' : `${(n / 1000).toFixed(1)}k`);
function report(label, rs) {
  // Cuts where the agent did nothing afterwards (probes, closed sessions) say nothing about recovery.
  rs = rs.filter((r) => r.window > 0);
  if (!rs.length) return;
  const w = rs.filter((r) => r.reachedWrite && !r.userBeforeWrite);
  const reads = rs.reduce((a, r) => a + r.reads, 0), namedReads = rs.reduce((a, r) => a + r.readsNamed, 0);
  console.log(`${label.padEnd(26)} cuts ${String(rs.length).padStart(3)} | seed ${k(median(rs.map((r) => r.seedTok)))} ctx ${k(median(rs.map((r) => r.ctxFirst)))}`
    + ` | to edit: ${w.length}/${rs.length} reach, med ${median(w.map((r) => r.toFirstWrite)) ?? '-'} tools, ${median(w.map((r) => r.activeS)) ?? '-'} s active`
    + ` | recovery med cost ${k(median(rs.map((r) => r.costTok)))} tok (~$${(median(rs.map((r) => r.costTok)) * PRICE / 1e6).toFixed(2)}), mean $${(mean(rs.map((r) => r.costTok)) * PRICE / 1e6).toFixed(2)}`
    + ` | pulled ${k(median(rs.map((r) => r.pulledTok)))} | searches ${mean(rs.map((r) => r.searches)).toFixed(1)} | reads ${mean(rs.map((r) => r.reads)).toFixed(1)}, named by seed ${reads ? Math.round(100 * namedReads / reads) : 0}% | recall ${rs.reduce((a, r) => a + r.recall, 0)}`);
}
for (const kind of ['native', 's4']) {
  const rs = rows.filter((r) => r.kind === kind);
  report(kind, rs);
  report(`  ${kind} continuation`, rs.filter((r) => r.continuation));
  report(`  ${kind} auto`, rs.filter((r) => r.trigger === 'auto'));
  for (const [label, lo, hi] of [['<150k', 0, 150e3], ['150-250k', 150e3, 250e3], ['>250k', 250e3, Infinity]]) report(`  ${kind} pre ${label}`, rs.filter((r) => r.preTok >= lo && r.preTok < hi));
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
