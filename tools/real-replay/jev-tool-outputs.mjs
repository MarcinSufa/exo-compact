#!/usr/bin/env node
// E20: asks Jev, for every Bash output S4 captures from the given transcripts, whether a later agent
// needs it after a cut (keep) or not (drop). Output text is what capture holds (redacted, sensitive
// commands skipped, up to --lines lines); the command is the redacted tool activity; context is the
// last three user messages. Writes { id, decision, p } rows to --out (decision 'unsure' under 0.6)
// and per-call metrics to --metrics. Resumable. Needs TYPESAFE_API_KEY; sends that text to api.typesafe.ai.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { toolOutputTargets } from './real-replay.mjs';

const CORE = fileURLToPath(new URL('../../plugin/compact/core', import.meta.url));
const HOST = fileURLToPath(new URL('../../plugin/compact/host', import.meta.url));
const selectJ = await import(pathToFileURL(path.join(CORE, 'select-j.ts')));
const jev = await import(pathToFileURL(path.join(HOST, 'jev-client.ts')));

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); if (i < 0) return fallback; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const out = flag('--out');
const metrics = flag('--metrics');
const model = flag('--model', 'jev-latest');
const concurrency = Number(flag('--concurrency', '4'));
const limit = Number(flag('--limit', '0'));
const maxLines = Number(flag('--lines', '30'));
if (!out || !metrics || !argv.length) throw new Error('Usage: node jev-tool-outputs.mjs <transcript.jsonl>... --out decisions.jsonl --metrics calls.jsonl [--lines 30] [--limit N]');
const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set');

const countTokens = (s) => Math.ceil(s.length / 4);
const cap = (s, tokens) => selectJ.capQueryField(s, tokens, countTokens);
const OPTIONS = ['keep', 'drop'];
const QUESTION = {
  type: 'choice',
  options: OPTIONS,
  criteria: {
    keep: 'The output holds something the agent may need later without running the command again: a result, number, count, measurement, id, hash, path, version, error message, test or gate outcome, or a fact the user\'s recent request depends on.',
    drop: 'The output is noise for later work: progress or install logs, a listing or file dump nothing asked about, boilerplate, a bare success message with no values, or content that only repeats the command.',
  },
  instructions: 'state.command is a shell command the agent ran and state.output is what it printed (first lines). state.recentUserMessages is what the user asked for most recently, often in Polish. The context will soon be compacted and the output will be gone. Decide whether the agent continuing this work would need these output lines.',
};

const done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).id) : []);
const targets = new Map();
for (const file of argv) for (const t of await toolOutputTargets(file, maxLines)) if (!targets.has(t.id)) targets.set(t.id, t);
let queue = [...targets.values()].filter((t) => !done.has(t.id));
if (limit > 0) queue = queue.slice(0, limit);
process.stderr.write(`targets ${targets.size}, already ${done.size}, to ask ${queue.length}\n`);

async function ask(t) {
  const state = JSON.stringify({ notice: selectJ.JEV_SAFETY_NOTICE, command: cap(t.command, 150), output: cap(t.text, 400), recentUserMessages: t.context.map((m) => cap(m, 120)) });
  const body = JSON.stringify({ model, state, questions: { need: QUESTION } });
  const started = Date.now();
  const row = { id: t.id, chars: t.text.length, requestChars: body.length };
  try {
    const response = await fetch(jev.TYPESAFE_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    row.ms = Date.now() - started; row.status = response.status;
    const parsed = jev.parseJevResponse(response.status, response.ok, text);
    row.model = parsed.model; row.inputTokens = parsed.usage?.input_tokens;
    const raw = parsed.answers.need;
    const p = raw?.probabilities?.[raw?.choice];
    row.choice = raw?.choice; row.p = p;
    const decision = OPTIONS.includes(raw?.choice) && typeof p === 'number' && p >= 0.6 ? raw.choice : 'unsure';
    row.result = decision;
    fs.appendFileSync(out, `${JSON.stringify({ id: t.id, decision, p, model: parsed.model })}\n`);
  } catch (error) {
    row.ms = Date.now() - started; row.result = 'error'; row.error = `${error?.name ?? 'Error'}: ${String(error?.message ?? '').slice(0, 80)}`;
  }
  return row;
}

let next = 0, finished = 0;
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
  while (next < queue.length) {
    const row = await ask(queue[next++]);
    fs.appendFileSync(metrics, `${JSON.stringify(row)}\n`);
    if (++finished % 100 === 0) process.stderr.write(`${finished}/${queue.length}\n`);
  }
}));
process.stderr.write(`done ${finished}\n`);
