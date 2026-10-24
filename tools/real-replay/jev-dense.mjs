#!/usr/bin/env node
// E24: asks Jev, per cut, how likely the agent continuing the current work needs each dense note candidate.
// Input is REPLAY_DENSE_JEV_DUMP's file ({ q, query, cands }); the query (tail and last user messages) is the
// state, sent once per request, and every candidate is one Noul question in that request (the re-ranking
// pattern). Writes { q, h, p } rows to --out and per-request metrics to --metrics. Resumable.
// Needs TYPESAFE_API_KEY; sends the captured (redacted) text to api.typesafe.ai.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); if (i < 0) return fallback; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const out = flag('--out');
const metrics = flag('--metrics');
const model = flag('--model', 'jev-latest');
const concurrency = Number(flag('--concurrency', '4'));
const perRequest = Number(flag('--per-request', '150'));
const limitCuts = Number(flag('--limit-cuts', '0'));
const input = argv[0];
if (!out || !metrics || !input) throw new Error('Usage: node jev-dense.mjs cands.jsonl --out scores.jsonl --metrics calls.jsonl [--per-request 150] [--limit-cuts N]');
const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set');

const CORE = fileURLToPath(new URL('../../plugin/compact/core', import.meta.url));
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(pathToFileURL(`${CORE}/`).href) && specifier.startsWith('./') && specifier.endsWith('.js')) return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
  return nextResolve(specifier, context);
} });
const { buildDenseJevRequests } = await import(pathToFileURL(path.join(CORE, 'dense-jev.ts')));
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const countTokens = (text) => Math.ceil(String(text ?? '').length / 4);

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((line) => { const r = JSON.parse(line); return `${r.q}:${r.h}`; }) : []);
const cuts = new Map();
for (const line of fs.readFileSync(input, 'utf8').split('\n').filter(Boolean)) { const c = JSON.parse(line); if (!cuts.has(c.q)) cuts.set(c.q, c); }
let cutList = [...cuts.values()];
if (limitCuts > 0) cutList = cutList.slice(0, limitCuts);
const jobs = [];
for (const cut of cutList) {
  const seen = new Set();
  const todo = cut.cands.filter((c) => !done.has(`${cut.q}:${c.h}`) && !seen.has(c.h) && seen.add(c.h));
  const requests = buildDenseJevRequests(cut.query, todo.map((c) => ({ text: c.text })), model, { perRequest, maxRequestTokens: 48000, countTokens, hash: sha });
  let offset = 0;
  for (const request of requests) {
    const cands = todo.slice(offset, offset + request.keys.length);
    jobs.push({ q: cut.q, query: cut.query, cands, request });
    offset += request.keys.length;
  }
}
process.stderr.write(`cuts ${cutList.length}, candidates ${cutList.reduce((n, c) => n + c.cands.length, 0)}, already ${done.size}, requests ${jobs.length}\n`);

async function ask(job) {
  const body = JSON.stringify(job.request.body);
  const row = { q: job.q, n: job.cands.length, requestChars: body.length };
  const started = Date.now();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(JEV_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(60_000) });
      const text = await response.text();
      row.status = response.status;
      if (response.status === 429 || response.status >= 500) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; }
      if (!response.ok) { row.error = text.slice(0, 200); break; }
      const parsed = JSON.parse(text);
      row.model = parsed.model; row.inputTokens = parsed.usage?.input_tokens;
      const rows = job.cands.map((c, i) => ({ q: job.q, h: c.h, p: parsed.answers?.[`n${i}`]?.noul })).filter((r) => typeof r.p === 'number');
      row.answered = rows.length;
      fs.appendFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
      break;
    } catch (error) {
      row.error = `${error?.name ?? 'Error'}: ${String(error?.message ?? '').slice(0, 80)}`;
    }
  }
  row.ms = Date.now() - started;
  return row;
}

let next = 0, finished = 0;
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
  while (next < jobs.length) {
    const row = await ask(jobs[next++]);
    fs.appendFileSync(metrics, `${JSON.stringify(row)}\n`);
    if (++finished % 20 === 0) process.stderr.write(`${finished}/${jobs.length}\n`);
  }
}));
process.stderr.write(`done ${finished}\n`);
