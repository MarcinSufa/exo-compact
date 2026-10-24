#!/usr/bin/env node
// Model-based fill-in probe over a REPLAY_PROBE_DUMP directory: for each cut, the model sees only what
// one side kept (native: summary + preserved segment + re-attached files; S4: seed + tail) and fills
// masked items taken from what the agent actually wrote after the cut.
//
//   node tools/real-replay/cloze.mjs <dumpDir> --out <dir>            build prompts, print cost estimate
//   node tools/real-replay/cloze.mjs <dumpDir> --out <dir> --run      call `claude -p --model haiku` (paid)
//   node tools/real-replay/cloze.mjs <dumpDir> --out <dir> --score    score answers already in <dir>
//
// The dump and the prompts hold transcript text: keep <dumpDir> and <dir> outside the repo, and send them
// only to Anthropic models.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PER_CUT = Number(process.env.CLOZE_PER_CUT ?? 8);
const MODEL = process.env.CLOZE_MODEL ?? 'haiku';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tokens = (s) => Math.ceil(String(s).length / 4);

export function pickItems(items, perCut = PER_CUT) {
  // Specific items only (a path, flag, number, hash or mixed-case name), so a blank has one right answer.
  const specific = (item) => item.length >= 4 && item.split(/\s+/).length <= 6 && /[\/._\-\d]|[a-z][A-Z]/.test(item);
  const usable = items.filter((x) => specific(x.item) && x.context.split(/\s+/).length >= 6 && !x.context.toLowerCase().includes(x.item.toLowerCase()) && !/^Another Claude session sent a message/.test(x.context));
  return usable.map((x) => ({ ...x, rank: sha(x.item) })).sort((a, b) => a.rank.localeCompare(b.rank)).slice(0, perCut);
}

export function buildPrompt(memory, questions) {
  const list = questions.map((q, i) => `${i + 1}. ...${q.context.replace(/\s+/g, ' ').slice(0, 300)}...  -> blank: ____`).join('\n');
  return [
    'Below is the working memory an AI coding agent had right after its context was compacted, followed by excerpts of what it wrote next with one item removed from each.',
    'Using only the memory, give the exact removed item (identifier, path, number, hash, command or phrase) for each excerpt. If the memory does not contain it, answer UNKNOWN.',
    'Reply with JSON only: {"1": "...", "2": "..."}.',
    '', '<memory>', memory, '</memory>', '', 'Excerpts:', list,
  ].join('\n');
}

export function isCorrect(answer, item) {
  const a = String(answer ?? '').trim().toLowerCase().replace(/^[`'"]|[`'"]$/g, '');
  const b = item.trim().toLowerCase();
  return a !== '' && a !== 'unknown' && (a === b || (a.length >= 4 && (a.includes(b) || b.includes(a))));
}

function main(argv) {
  const dump = argv[0];
  const out = argv[argv.indexOf('--out') + 1];
  if (!dump || !argv.includes('--out') || !out) throw new Error('Usage: cloze.mjs <dumpDir> --out <dir> [--run|--score]');
  fs.mkdirSync(out, { recursive: true });
  const cuts = fs.readdirSync(dump).filter((f) => f.startsWith('cut-') && f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dump, f), 'utf8')));
  const jobs = [];
  for (const cut of cuts) {
    const questions = pickItems(cut.items);
    if (!questions.length) continue;
    fs.writeFileSync(path.join(out, `${cut.id}.questions.json`), JSON.stringify(questions.map((q) => ({ item: q.item, context: q.context }))));
    for (const [arm, memory] of [['native', cut.nativeFull], ['s4', cut.s4Full]]) {
      const prompt = buildPrompt(memory, questions);
      const file = path.join(out, `${cut.id}.${arm}.prompt.txt`);
      fs.writeFileSync(file, prompt);
      jobs.push({ id: cut.id, arm, file, answer: path.join(out, `${cut.id}.${arm}.answer.json`), promptTokens: tokens(prompt) });
    }
  }
  const total = jobs.reduce((n, j) => n + j.promptTokens, 0);
  console.log(`${jobs.length} calls, ~${total} input tokens (${MODEL}); questions per cut <= ${PER_CUT}`);
  if (argv.includes('--run')) {
    const empty = fs.mkdtempSync(path.join(out, 'cwd-'));
    for (const job of jobs) {
      if (fs.existsSync(job.answer)) continue;
      const r = spawnSync('claude', ['-p', '--model', MODEL, '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--system-prompt', 'You answer with JSON only.', '--no-session-persistence', '--output-format', 'json'], { cwd: empty, input: fs.readFileSync(job.file, 'utf8'), encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
      if (r.status !== 0) { console.error(`${job.id} ${job.arm}: exit ${r.status}`); continue; }
      fs.writeFileSync(job.answer, r.stdout);
      console.log(`${job.id} ${job.arm} done`);
    }
  }
  if (argv.includes('--score') || argv.includes('--run')) {
    const totals = { native: [0, 0], s4: [0, 0] };
    let cost = 0;
    for (const job of jobs) {
      if (!fs.existsSync(job.answer)) continue;
      const wrapper = JSON.parse(fs.readFileSync(job.answer, 'utf8'));
      cost += wrapper.total_cost_usd ?? 0;
      const text = String(wrapper.result ?? '');
      let answers = {};
      try { answers = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { /* scored as all wrong */ }
      const questions = JSON.parse(fs.readFileSync(path.join(out, `${job.id}.questions.json`), 'utf8'));
      questions.forEach((q, i) => { totals[job.arm][1] += 1; if (isCorrect(answers[String(i + 1)], q.item)) totals[job.arm][0] += 1; });
    }
    for (const [arm, [ok, n]] of Object.entries(totals)) console.log(`${arm}: ${ok}/${n} = ${n ? (100 * ok / n).toFixed(1) : '0'}%`);
    console.log(`cost $${cost.toFixed(3)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
