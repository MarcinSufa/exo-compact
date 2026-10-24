// Retrieval on quiz questions (quiz.mjs --gen output): lexical vs dense vs fused, question as a sentence vs as keywords.
// usage: node quiz-retrieval.mjs <quizOutDir> <sandboxRoot> <dumpDir>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline, env } from '@huggingface/transformers';
import { OPTS, prepare, search } from '../../plugin/compact/recall/rank.mjs';
import { indexRows, prepareSandbox } from './quiz.mjs';

env.cacheDir = process.env.HOME + '/.cache/exo-emb';
const [quizDir, sbRoot, dumpDir] = process.argv.slice(2);
const MODEL = 'Xenova/multilingual-e5-small', P = 'passage: ', Qp = 'query: ';
const sha = (t) => crypto.createHash('sha1').update(t).digest('hex');
const cacheDir = path.join(process.env.EMB_CACHE ?? path.join(os.tmpdir(), 'exo-emb-cache'), MODEL.replace(/\W+/g, '_'));

// Same shape as real-replay keywordQuery: up to six specific terms, identifier-like first, then long words.
function keywords(q) {
  const words = [...new Set((q.match(/[\p{L}\p{N}][\p{L}\p{N}_.:/@#-]*/gu) ?? []).map((w) => w.replace(/[.:]+$/, '')))]
    .filter((w) => w.length > 3 && !/^(this|that|with|from|have|will|what|when|there|their|about|which|would|should|could|does|were|where|after|before|into|the)$/i.test(w));
  const specific = words.filter((w) => /\d|[_./:@#-]|[a-z][A-Z]/.test(w));
  const long = words.filter((w) => !specific.includes(w)).sort((a, b) => b.length - a.length);
  return [...specific, ...long].slice(0, 6).join(' ');
}

const cuts = [];
for (const f of fs.readdirSync(quizDir).filter((f) => f.endsWith('.questions.json'))) {
  const id = f.replace('.questions.json', '');
  const cut = JSON.parse(fs.readFileSync(path.join(dumpDir, `cut-${id}.json`), 'utf8'));
  const qs = JSON.parse(fs.readFileSync(path.join(quizDir, f), 'utf8')).filter((q) => q.type !== 'none' && q.item);
  if (!qs.length) continue;
  cuts.push({ id, rows: indexRows(prepareSandbox(sbRoot, cut).recallRoot, cut.sessionId), qs: qs.map((q) => ({ ...q, kw: keywords(q.q) })) });
}

// embedding cache shared with dense-eval.mjs
const vec = new Map(); let dim = 0;
fs.mkdirSync(cacheDir, { recursive: true });
const idxFile = path.join(cacheDir, 'keys.json'), binFile = path.join(cacheDir, 'vecs.f32');
if (fs.existsSync(idxFile)) {
  const keys = JSON.parse(fs.readFileSync(idxFile, 'utf8')); const buf = fs.readFileSync(binFile);
  dim = buf.length / 4 / keys.length; const all = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  keys.forEach((k, i) => vec.set(k, all.subarray(i * dim, (i + 1) * dim)));
}
const need = new Map();
for (const c of cuts) {
  for (const r of c.rows) { const k = 'p' + sha(r.text); if (!vec.has(k)) need.set(k, P + r.text); }
  for (const q of c.qs) for (const t of [q.q, q.kw]) { const k = 'q' + sha(t); if (!vec.has(k)) need.set(k, Qp + t); }
}
console.error(`cuts ${cuts.length}, questions ${cuts.reduce((n, c) => n + c.qs.length, 0)}, to embed ${need.size}`);
if (need.size) {
  const ext = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
  const entries = [...need]; const t0 = performance.now();
  for (let i = 0; i < entries.length; i += 32) {
    const batch = entries.slice(i, i + 32);
    const out = await ext(batch.map(([, t]) => t), { pooling: 'mean', normalize: true });
    dim = out.dims[1];
    batch.forEach(([k], j) => vec.set(k, Float32Array.from(out.data.subarray(j * dim, (j + 1) * dim))));
  }
  console.error(`embedded ${entries.length} in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  const keys = [...vec.keys()]; const all = new Float32Array(keys.length * dim);
  keys.forEach((k, i) => all.set(vec.get(k), i * dim));
  fs.writeFileSync(binFile, Buffer.from(all.buffer)); fs.writeFileSync(idxFile, JSON.stringify(keys));
}

const base = { ...OPTS, bm25: 1, exact: 1.2, proximity: 0.8, graph: 0, seeds: 5, coverage: 0.35, recency: 0.04 };
const arms = [
  { name: 'lexical', w: 0 }, { name: 'fused w=0.5', w: 0.5 }, { name: 'fused w=1', w: 1 }, { name: 'fused w=2', w: 2 },
  { name: 'fused w=1 cov0.15', w: 1, opts: { coverage: 0.15 } }, { name: 'dense only', only: true },
];
const res = {}; const types = {}; const per = {};
for (const c of cuts) {
  const prepared = prepare(c.rows);
  const pv = c.rows.map((r) => vec.get('p' + sha(r.text)));
  const dense = (t) => { const qv = vec.get('q' + sha(t)); return pv.map((v, i) => { let s = 0; for (let k = 0; k < dim; k++) s += v[k] * qv[k]; return [i, s]; }).sort((a, b) => b[1] - a[1]).slice(0, 200); };
  for (const q of c.qs) {
    const gold = String(q.item).toLowerCase();
    for (const style of ['sentence', 'keywords']) {
      const text = style === 'sentence' ? q.q : q.kw; const dl = dense(text);
      for (const a of arms) {
        const hits = a.only ? dl.slice(0, 5).map(([i]) => c.rows[i]) : search(prepared, text, 5, { ...base, ...(a.opts ?? {}), dense: a.w }, dl).hits;
        const r = hits.findIndex((h) => h.text.toLowerCase().includes(gold));
        const key = `${style}|${a.name}`; res[key] ??= { n: 0, t1: 0, t3: 0, t5: 0 }; (per[key] ??= []).push(r >= 0 && r < 3);
        const s = res[key]; s.n++; if (r === 0) s.t1++; if (r >= 0 && r < 3) s.t3++; if (r >= 0) s.t5++;
        const tk = `${style}|${a.name}|${q.type}`; types[tk] ??= { n: 0, t3: 0 }; types[tk].n++; if (r >= 0 && r < 3) types[tk].t3++;
      }
    }
  }
}
const pct = (x, n) => `${(100 * x / n).toFixed(1)}%`;
console.log(`| query | ranker | n | top1 | top3 | top5 | top3 value | top3 why | top3 latest | top3 multi |\n|---|---|---|---|---|---|---|---|---|---|`);
for (const [key, s] of Object.entries(res)) {
  const [style, name] = key.split('|');
  const ty = (t) => { const x = types[`${key}|${t}`]; return x ? `${pct(x.t3, x.n)} (${x.n})` : '-'; };
  console.log(`| ${style} | ${name} | ${s.n} | ${pct(s.t1, s.n)} | ${pct(s.t3, s.n)} | ${pct(s.t5, s.n)} | ${ty('value')} | ${ty('why')} | ${ty('latest')} | ${ty('multi')} |`);
}

for (const [a, b] of [['sentence|lexical', 'sentence|fused w=2'], ['sentence|lexical', 'sentence|fused w=1'], ['keywords|lexical', 'sentence|lexical'], ['keywords|lexical', 'sentence|fused w=2']]) {
  let win = 0, loss = 0; per[a].forEach((x, i) => { if (!x && per[b][i]) win++; if (x && !per[b][i]) loss++; });
  // exact two-sided sign test
  const n = win + loss, k = Math.min(win, loss); let p = 0; const C = (n, r) => { let c = 1; for (let i = 0; i < r; i++) c = c * (n - i) / (i + 1); return c; };
  for (let i = 0; i <= k; i++) p += C(n, i) / 2 ** n; p = Math.min(1, 2 * p);
  console.log(`${b} vs ${a}: top3 gained ${win}, lost ${loss}, sign test p=${p.toFixed(3)}`);
}
