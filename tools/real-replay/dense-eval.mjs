// Offline: lexical vs dense vs fused recall on replay dumps (REPLAY_RECALL_DUMP). Embeddings cached per model.
// usage: node dense-eval.mjs <REPLAY_RECALL_DUMP dir> <model> [passagePrefix] [queryPrefix]. Needs @huggingface/transformers (npm i --no-save); EMB_CACHE keeps vectors.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline, env } from '@huggingface/transformers';
import { OPTS, prepare, search } from '../../plugin/compact/recall/rank.mjs';

env.cacheDir = process.env.HOME + '/.cache/exo-emb';
const [dumpDir, model, pPre = '', qPre = ''] = process.argv.slice(2);
const MAX_CTX = Number(process.env.MAX_CTX ?? 3);
const sha = (t) => crypto.createHash('sha1').update(t).digest('hex');
const cacheDir = path.join(process.env.EMB_CACHE ?? path.join(os.tmpdir(), 'exo-emb-cache'), model.replace(/\W+/g, '_'));
fs.mkdirSync(cacheDir, { recursive: true });

const cuts = fs.readdirSync(dumpDir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dumpDir, f), 'utf8')));
const queryText = (q) => q.replace(/\s+/g, ' ').trim().slice(0, 600);

// --- embedding cache: key -> Float32Array (normalized) ---
const vec = new Map();
const idxFile = path.join(cacheDir, 'keys.json'), binFile = path.join(cacheDir, 'vecs.f32');
let dim = 0;
if (fs.existsSync(idxFile)) {
  const keys = JSON.parse(fs.readFileSync(idxFile, 'utf8')); const buf = fs.readFileSync(binFile);
  dim = buf.length / 4 / keys.length;
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  keys.forEach((k, i) => vec.set(k, all.subarray(i * dim, (i + 1) * dim)));
}
const need = new Map();
for (const c of cuts) {
  for (const r of c.rows) { const k = 'p' + sha(r.text); if (!vec.has(k)) need.set(k, pPre + r.text); }
  for (const it of c.items) for (const q of it.contexts.slice(0, MAX_CTX)) { const k = 'q' + sha(queryText(q)); if (!vec.has(k)) need.set(k, qPre + queryText(q)); }
  for (const it of c.items) { const k = 'q' + sha(it.item); if (!vec.has(k)) need.set(k, qPre + it.item); }
}
console.error(`cuts ${cuts.length}, cached ${vec.size}, to embed ${need.size}`);
if (need.size) {
  const ext = await pipeline('feature-extraction', model, { dtype: process.env.DTYPE ?? 'q8' });
  const entries = [...need]; const t0 = performance.now();
  for (let i = 0; i < entries.length; i += 32) {
    const batch = entries.slice(i, i + 32);
    const out = await ext(batch.map(([, t]) => t), { pooling: process.env.POOL ?? 'mean', normalize: true });
    dim = out.dims[1];
    batch.forEach(([k], j) => vec.set(k, Float32Array.from(out.data.subarray(j * dim, (j + 1) * dim))));
    if (i % 3200 === 0) console.error(`  ${i}/${entries.length} ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  }
  console.error(`embedded ${entries.length} in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  const keys = [...vec.keys()]; const all = new Float32Array(keys.length * dim);
  keys.forEach((k, i) => all.set(vec.get(k), i * dim));
  fs.writeFileSync(binFile, Buffer.from(all.buffer)); fs.writeFileSync(idxFile, JSON.stringify(keys));
}

// --- evaluation ---
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const weights = (process.env.WEIGHTS ?? '0,0.5,1,1.5,2').split(',').map(Number);
const arms = process.env.ARMS ? JSON.parse(process.env.ARMS) : [...weights.map((w) => ({ name: `fused w=${w}`, w })), { name: 'dense only', only: true }];
let union = 0, lexOnly = 0, denseOnly = 0;
const lower = (s) => String(s).toLowerCase();
const stats = Object.fromEntries(arms.map((a) => [a.name, { ctx: 0, value: 0 }]));
let nItems = 0;
for (const c of cuts) {
  const prepared = prepare(c.rows);
  const pv = c.rows.map((r) => vec.get('p' + sha(r.text)));
  const denseFor = (q) => {
    const qv = vec.get('q' + sha(q));
    return pv.map((v, i) => [i, dot(qv, v)]).sort((a, b) => b[1] - a[1]).slice(0, 200);
  };
  for (const it of c.items) {
    nItems++;
    const item = lower(it.item);
    const ctxs = it.contexts.slice(0, MAX_CTX).map(queryText);
    const dl = ctxs.map(denseFor), dv = denseFor(it.item);
    {
      const top3 = (hits) => hits.slice(0, 3).some((h) => lower(h.text).includes(item));
      const L = ctxs.some((q) => top3(search(prepared, q, 5, defaults(), undefined).hits));
      const D = dl.some((d) => top3(d.slice(0, 3).map(([i]) => c.rows[i])));
      if (L || D) union++; if (L && !D) lexOnly++; if (D && !L) denseOnly++;
    }
    for (const a of arms) {
      const hitAt = (hits) => hits.findIndex((h) => lower(h.text).includes(item));
      let best = -1;
      ctxs.forEach((q, j) => {
        const hits = a.only ? dl[j].slice(0, 5).map(([i]) => c.rows[i]) : search(prepared, q, 5, { ...defaults(), ...(a.opts ?? {}), dense: a.w }, dl[j]).hits;
        const r = hitAt(hits); if (r >= 0 && (best < 0 || r < best)) best = r;
      });
      if (best >= 0 && best < 3) stats[a.name].ctx++;
      const vh = a.only ? dv.slice(0, 5).map(([i]) => c.rows[i]) : search(prepared, it.item, 5, { ...defaults(), ...(a.opts ?? {}), dense: a.w }, dv).hits;
      if (hitAt(vh) === 0) stats[a.name].value++;
    }
  }
}
function defaults() { return { ...OPTS, bm25: 1, exact: 1.2, proximity: 0.8, graph: 0, seeds: 5, coverage: 0.35, recency: 0.04 }; }
console.log(`${model} | items ${nItems} | contexts per item <= ${MAX_CTX}`);
console.log(`oracle union ctx top3 ${(100 * union / nItems).toFixed(1)}% | lexical-only ${lexOnly} | dense-only ${denseOnly}`);
for (const a of arms) console.log(`${a.name.padEnd(14)} ctx top3 ${(100 * stats[a.name].ctx / nItems).toFixed(1)}% | value top1 ${(100 * stats[a.name].value / nItems).toFixed(1)}%`);
