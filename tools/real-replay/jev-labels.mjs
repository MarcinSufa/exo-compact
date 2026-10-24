#!/usr/bin/env node
// Labels every user message of the given transcripts with Jev exactly as compact.ts's prompt hook
// does (same question, redacted captured text, same 0.6 floor), for REPLAY_LABELS. Resumable: keys
// already in --out are skipped. --metrics gets one line per call (timing, status, tokens; no text).
// Needs TYPESAFE_API_KEY in the environment. Sends user message text to api.typesafe.ai.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { labelTargets } from './real-replay.mjs';

const CORE = fileURLToPath(new URL('../../plugin/compact/core', import.meta.url));
const HOST = fileURLToPath(new URL('../../plugin/compact/host', import.meta.url));
const labels = await import(pathToFileURL(path.join(CORE, 'labels.ts')));
const jev = await import(pathToFileURL(path.join(HOST, 'jev-client.ts')));

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); if (i < 0) return fallback; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const out = flag('--out');
const metrics = flag('--metrics');
const model = flag('--model', 'jev-latest');
const concurrency = Number(flag('--concurrency', '4'));
const limit = Number(flag('--limit', '0'));
if (!out || !metrics || !argv.length) throw new Error('Usage: node jev-labels.mjs <transcript.jsonl>... --out labels.jsonl --metrics calls.jsonl [--limit N]');
const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set');

const done = new Set(fs.existsSync(out) ? [...labels.parseLabels(fs.readFileSync(out, 'utf8')).keys()] : []);
const tried = new Set(fs.existsSync(metrics) ? fs.readFileSync(metrics, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).key) : []);
const targets = new Map();
for (const file of argv) for (const t of await labelTargets(file)) if (!targets.has(t.key)) targets.set(t.key, t);
let queue = [...targets.values()].filter((t) => !done.has(t.key) && !tried.has(t.key));
if (limit > 0) queue = queue.slice(0, limit);
process.stderr.write(`targets ${targets.size}, already ${done.size}, to ask ${queue.length}\n`);

async function ask(t) {
  const built = labels.buildLabelQuestion(labels.capturedUserText(t.text), (s) => Math.ceil(s.length / 4));
  const body = JSON.stringify({ model, state: built.state, questions: { label: { type: 'choice', options: built.question.options, criteria: built.question.criteria, instructions: built.question.instructions } } });
  const started = Date.now();
  const row = { key: t.key, chars: t.text.length, requestChars: body.length };
  try {
    const response = await fetch(jev.TYPESAFE_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    row.ms = Date.now() - started; row.status = response.status;
    const parsed = jev.parseJevResponse(response.status, response.ok, text);
    row.model = parsed.model; row.inputTokens = parsed.usage?.input_tokens;
    const raw = parsed.answers.label;
    row.choice = raw?.choice; row.p = raw?.probabilities?.[raw?.choice];
    if (!labels.isLabelModel(model, parsed.model)) { row.result = 'model_mismatch'; return row; }
    const answer = labels.parseLabelAnswer(raw);
    if (!answer) { row.result = 'unsure'; return row; }
    row.result = 'label';
    fs.appendFileSync(out, `${JSON.stringify({ key: t.key, label: answer.label, p: answer.probability, model: parsed.model })}\n`);
    return row;
  } catch (error) {
    row.ms = Date.now() - started; row.result = 'error'; row.error = String(error?.name ?? 'Error') + ': ' + String(error?.message ?? '').slice(0, 80);
    return row;
  }
}

let next = 0, finished = 0;
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
  while (next < queue.length) {
    const t = queue[next++];
    const row = await ask(t);
    fs.appendFileSync(metrics, `${JSON.stringify(row)}\n`);
    if (++finished % 25 === 0) process.stderr.write(`${finished}/${queue.length}\n`);
  }
}));
process.stderr.write(`done ${finished}\n`);
