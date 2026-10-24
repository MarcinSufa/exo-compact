#!/usr/bin/env node
// Measures noise in an exo-compact seed: lines that cost tokens but tell the model nothing.
// Prints counts only, never seed text, so it is safe to run over private transcripts.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SENTINEL = '[[exovault:s4-seed:v1]]';
const tokens = (s) => Math.ceil(s.length / 4);

// Order matters: the first matching class wins.
export const CLASSES = [
  ['pointer', (l) => /^\[pointer [^\]]*\]$/.test(l.trim())],
  ['omitted_marker', (l) => /^\[\d+ (older constraints|key facts) omitted/.test(l.trim()) || /^\[… \d+ messages omitted/.test(l.trim())],
  ['harness', (l) => /<\/?(summary|task-notification|system-reminder|task-id|tool-use-id|output-file|status|result|usage|note)>|Monitor event:|Background command "|^\s*>?\s*<\w[\w-]*>/.test(l)],
  ['none_section', (l) => l.trim() === '(none)'],
  ['fragment', (l) => {
    const t = l.replace(/^>\s*/, '').replace(/\s*\[seq=\d+\](\s*\(updated, seq \d+\))?\s*$/, '').trim();
    if (!t || /^#/.test(t) || !/^>/.test(l.trim())) return false;
    const words = t.split(/\s+/).filter((w) => /\p{L}/u.test(w));
    return words.length < 4 || /^[\p{Ll}(),.;:\-–]/u.test(t) && words.length < 8;
  }],
];

export function measure(text) {
  const lines = text.split('\n');
  const out = { lines: 0, tokens: tokens(text), seqTagTokens: 0, byClass: {}, bySection: {} };
  let section = '(preamble)';
  for (const [name] of CLASSES) out.byClass[name] = { lines: 0, tokens: 0 };
  for (const line of lines) {
    if (!line.trim()) continue;
    const head = line.match(/^## (.+)$/);
    if (head) section = head[1].replace(/\s*\(.*$/, '');
    const sec = (out.bySection[section] ??= { lines: 0, tokens: 0, noise: 0 });
    sec.lines += 1; sec.tokens += tokens(line) + 1;
    out.lines += 1;
    for (const m of line.matchAll(/\s*\[seq=\d+\](\s*\(updated, seq \d+\))?/g)) out.seqTagTokens += tokens(m[0]);
    const hit = CLASSES.find(([, test]) => test(line));
    if (hit) { out.byClass[hit[0]].lines += 1; out.byClass[hit[0]].tokens += tokens(line); sec.noise += tokens(line); }
  }
  const noise = Object.values(out.byClass).reduce((n, c) => n + c.tokens, 0) + out.seqTagTokens;
  out.noiseTokens = noise;
  out.noiseShare = out.tokens ? +(noise / out.tokens).toFixed(3) : 0;
  return out;
}

function* seedsIn(file) {
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!raw.includes('s4-seed:v1')) continue;
    let e; try { e = JSON.parse(raw); } catch { continue; }
    if (e.type !== 'user') continue;
    const c = e.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
    if (text.startsWith(SENTINEL)) yield { uuid: e.uuid, timestamp: e.timestamp, text };
  }
}

export function main(argv = process.argv.slice(2)) {
  if (!argv.length) throw new Error('Usage: node seed-noise.mjs <transcript.jsonl | seed.txt>...');
  const rows = [];
  for (const file of argv) {
    if (file.endsWith('.jsonl')) for (const s of seedsIn(file)) rows.push({ file: path.basename(file).slice(0, 8), at: s.timestamp, ...measure(s.text) });
    else rows.push({ file: path.basename(file), ...measure(fs.readFileSync(file, 'utf8')) });
  }
  const sum = (f) => rows.reduce((n, r) => n + f(r), 0);
  const agg = { seeds: rows.length, tokens: sum((r) => r.tokens), noiseTokens: sum((r) => r.noiseTokens), seqTagTokens: sum((r) => r.seqTagTokens), byClass: {} };
  for (const [name] of CLASSES) agg.byClass[name] = { lines: sum((r) => r.byClass[name].lines), tokens: sum((r) => r.byClass[name].tokens) };
  agg.bySection = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.bySection)) { const a = (agg.bySection[k] ??= { lines: 0, tokens: 0, noise: 0 }); a.lines += v.lines; a.tokens += v.tokens; a.noise += v.noise; }
  agg.noiseShare = agg.tokens ? +(agg.noiseTokens / agg.tokens).toFixed(3) : 0;
  process.stdout.write(`${JSON.stringify({ rows: rows.map(({ byClass, bySection, ...r }) => r), aggregate: agg }, null, 2)}\n`);
  return agg;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
