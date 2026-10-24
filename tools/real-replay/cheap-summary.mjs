#!/usr/bin/env node
// E22: a cheap-model summary arm. For each pre-<id>.txt in a REPLAY_PROBE_DUMP directory (what the native
// compactor read before that cut), asks `claude -p --model haiku` for a continuation summary and scores
// the used items of cut-<id>.json against: the summary alone, summary + S4 tail, and S4 as dumped.
//
//   node tools/real-replay/cheap-summary.mjs <dumpDir> --out <dir> [--run] [--only id,id]   (--run is paid)
//
// Transcript text: keep <dumpDir> and <dir> outside the repo, send only to Anthropic models.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MODEL = process.env.SUMMARY_MODEL ?? 'haiku';
const WORDS = Number(process.env.SUMMARY_WORDS ?? 3500);
const CONCURRENCY = Number(process.env.SUMMARY_CONCURRENCY ?? 3);
const tokens = (s) => Math.ceil(String(s).length / 4);
const has = (text, item) => text.toLowerCase().includes(item.toLowerCase());

export function summaryPrompt(conversation, words = WORDS) {
  return [
    'Below is the conversation so far between a user and an AI coding agent (tool inputs and results are cut short).',
    'The agent\'s context is about to be compacted. Write the summary the agent will continue from.',
    `Keep it under ${words} words. Use these sections: Primary request and intent; Key technical concepts; Files and code sections; Errors and fixes; Problem solving; All user messages (short, in their language); Pending tasks; Current work; Next step.`,
    'Copy exact identifiers: file paths, commands, flags, versions, commit hashes, numbers, ids, URLs and names. Prefer a dense list of exact facts over prose. Never invent anything.',
    '', '<conversation>', conversation, '</conversation>',
  ].join('\n');
}

function claude(prompt, cwd) {
  return new Promise((resolve) => {
    const child = spawn('claude', ['-p', '--model', MODEL, '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--system-prompt', 'You write working-memory summaries for a coding agent.', '--no-session-persistence', '--output-format', 'json'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 600_000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
    child.stdin.end(prompt);
  });
}

async function main(argv) {
  const dump = argv[0];
  const out = argv[argv.indexOf('--out') + 1];
  if (!dump || !argv.includes('--out') || !out) throw new Error('Usage: cheap-summary.mjs <dumpDir> --out <dir> [--run] [--only ids]');
  fs.mkdirSync(out, { recursive: true });
  const only = argv.includes('--only') ? new Set(argv[argv.indexOf('--only') + 1].split(',')) : null;
  const cuts = fs.readdirSync(dump).filter((f) => /^cut-.*\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(dump, f), 'utf8')))
    // Native-only cuts: an S4 cut has no native summary to compare with.
    .filter((c) => tokens(c.native) > 100 && c.items.length && (!only || only.has(c.id)))
    .sort((a, b) => a.id.localeCompare(b.id));
  const jobs = cuts.map((c) => ({ cut: c, prompt: summaryPrompt(fs.readFileSync(path.join(dump, `pre-${c.id}.txt`), 'utf8')), answer: path.join(out, `${c.id}.summary.json`) }));
  console.log(`${jobs.length} cuts, ~${jobs.reduce((n, j) => n + tokens(j.prompt), 0)} input tokens (${MODEL})`);
  if (argv.includes('--run')) {
    const cwd = fs.mkdtempSync(path.join(out, 'cwd-'));
    const queue = jobs.filter((j) => !fs.existsSync(j.answer));
    let next = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (next < queue.length) {
        const job = queue[next++];
        const started = Date.now();
        const r = await claude(job.prompt, cwd);
        if (r.code !== 0) { console.error(`${job.cut.id}: exit ${r.code}`); continue; }
        fs.writeFileSync(job.answer, r.out);
        console.log(`${job.cut.id} done ${Math.round((Date.now() - started) / 1000)} s`);
      }
    }));
  }
  const rows = [];
  let cost = 0;
  for (const job of jobs) {
    if (!fs.existsSync(job.answer)) continue;
    const wrapper = JSON.parse(fs.readFileSync(job.answer, 'utf8'));
    cost += wrapper.total_cost_usd ?? 0;
    const summary = String(wrapper.result ?? '');
    const c = job.cut;
    const arms = { native: c.nativeFull, s4: c.s4Full, haiku: summary, haikuTail: `${summary}\n${c.tail}`, s4Haiku: `${c.s4Full}\n${summary}` };
    const row = { id: c.id, needed: c.items.length, ms: wrapper.duration_ms, tokens: Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, tokens(v)])), covered: {} };
    for (const [arm, text] of Object.entries(arms)) row.covered[arm] = c.items.filter((x) => has(text, x.item)).length;
    rows.push(row);
  }
  if (rows.length) {
    const need = rows.reduce((n, r) => n + r.needed, 0);
    for (const arm of Object.keys(rows[0].covered)) {
      const ok = rows.reduce((n, r) => n + r.covered[arm], 0);
      const tok = rows.reduce((n, r) => n + r.tokens[arm], 0) / rows.length;
      console.log(`${arm.padEnd(10)} ${(100 * ok / need).toFixed(1)}%  ${(tok / 1000).toFixed(1)}k tokens`);
    }
    const ms = rows.map((r) => r.ms).filter(Boolean).sort((a, b) => a - b);
    console.log(`${rows.length} cuts, ${need} used items, haiku median ${Math.round((ms[Math.floor(ms.length / 2)] ?? 0) / 1000)} s, cost $${cost.toFixed(3)}`);
    fs.writeFileSync(path.join(out, 'scores.json'), JSON.stringify(rows, null, 1));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2));
