#!/usr/bin/env node
// Task A/B: does the agent do real work better after a compaction with the plugin (s4) than without it (native)?
//
// A task is a real request from a long session, asked after at least one compaction, that ended in a commit with
// tests (tasks.json; `selfCheck` in verify.mjs fixes which test cases it must turn green). Each run rebuilds the
// moment of the request: the memory one arm had right after the last compaction before it (native: the session's
// native summary and kept messages; s4: the seed, tail and the recall tool over the session so far), the
// conversation since that compaction, and the request itself. The agent works in a copy of the repository at the
// commit's parent, holding no later commit, inside a bubblewrap jail that hides the real home, /work and /tmp.
// Afterwards the commit's test files are copied over its work and run outside the jail. The gate in
// ../eval/gate.mjs compares arms with the task as the unit.
//
// usage: node task-ab.mjs <tasks.json> --dump <replay dump dir> --out <dir> [--plan|--run|--report]
//          [--arms native,s4] [--reps 3] [--only id,id]
// env:   TASKAB_MODEL (default: the session's main model) TASKAB_EFFORT (low..max; default: the CLI's) TASKAB_MAX_TURNS (80) TASKAB_MAX_SPEND (USD, 20)
//        TASKAB_JOBS (2) TASKAB_SANDBOX (/tmp/taskab) TASKAB_CLAUDE (claude) TASKAB_SINCE_TOKENS (20000)
//        TASKAB_JAIL (1; 0 only for tests)
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { armMemory, jailArgs, parseStream, prepareSandbox, RECALL_TOOL, sandboxPaths, split } from '../real-replay/quiz.mjs';
import { build, install, isolatedCheckout, runHidden, score } from './verify.mjs';
import { gateTable } from '../eval/gate.mjs';

const RECALL = fileURLToPath(new URL('../../plugin/compact/recall', import.meta.url));
const env = (k, d) => process.env[k] ?? d;
const tokens = (s) => Math.ceil(String(s).length / 4);
const parse = (l) => { try { return JSON.parse(l); } catch { return undefined; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const textOf = (content) => (typeof content === 'string' ? content : (content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n'));

/** Line (0-based) of the request in the transcript: the human message with the task's timestamp. */
export function askLine(lines, task) {
  const i = lines.findIndex((l) => { const e = parse(l); return e?.type === 'user' && e.timestamp === task.askTs; });
  if (i < 0) throw new Error(`request of ${task.id} not found at ${task.askTs}`);
  return i;
}

/** The last compaction before the request: the dump cut of that session with the greatest boundary line below it. */
export function cutFor(cuts, sessionId, line) {
  const before = cuts.filter((c) => c.sessionId === sessionId && c.boundaryLine < line).sort((a, b) => b.boundaryLine - a.boundaryLine);
  return before[0];
}

const isInjected = (e) => e?.isCompactSummary === true || e?.message?.isCompactSummary === true || e?.type === 'attachment'
  || JSON.stringify(e?.message?.content ?? '').includes('[[exovault:s4-seed:v1]]');

/**
 * The conversation between the compaction and the request, as text, the same for both arms. Newest events are kept
 * within `budget` tokens; older ones are counted in a note.
 */
export function sinceCut(lines, boundaryLine, ask, budget = Number(env('TASKAB_SINCE_TOKENS', 20000))) {
  const out = [];
  for (const l of lines.slice(boundaryLine + 1, ask)) {
    const e = parse(l);
    if (!e || isInjected(e) || e.isMeta || (e.type !== 'user' && e.type !== 'assistant')) continue;
    const content = e.message?.content;
    if (e.type === 'user' && typeof content === 'string') { out.push(`User: ${content}`); continue; }
    for (const b of Array.isArray(content) ? content : []) {
      if (b?.type === 'text' && b.text.trim()) out.push(`${e.type === 'user' ? 'User' : 'Assistant'}: ${b.text}`);
      if (b?.type === 'tool_use') out.push(`Assistant called ${b.name}: ${JSON.stringify(b.input ?? {}).slice(0, 300)}`);
      if (b?.type === 'tool_result') out.push(`Tool result: ${textOf(b.content).slice(0, 600)}`);
    }
  }
  const kept = [];
  let used = 0;
  for (let i = out.length - 1; i >= 0 && used + tokens(out[i]) <= budget; i--) { kept.unshift(out[i]); used += tokens(out[i]); }
  const dropped = out.length - kept.length;
  return `${dropped ? `[${dropped} earlier events since the compaction are not shown]\n` : ''}${kept.join('\n')}`;
}

export function taskPrompt(memory, since, ask) {
  return [
    'This is a Claude Code session that continues after a context compaction. Below is the context the session kept at the compaction, then the conversation since then, then the user\'s new message.',
    'Continue the session: do what the user asks, working in the repository of your current directory. Work on your own until it is done; do not ask questions, nobody will answer. Committing is optional.',
    'This is a sandboxed copy of the project: the services, database, deployed apps and other sessions of the original machine are not available here, so do not contact them, and do not start Claude, other agents or tmux sessions. Do the work in the code and check it with the repository\'s own tests and build.',
    '', memory, '', '## Conversation since the compaction', since || '(nothing yet)', '', '## The user now says', ask,
  ].join('\n');
}

/** The main model of a transcript: the one most assistant messages used. */
export function sessionModel(lines) {
  const c = new Map();
  for (const l of lines) { const m = parse(l)?.message?.model; if (parse(l)?.type === 'assistant' && m && !m.startsWith('<')) c.set(m, (c.get(m) ?? 0) + 1); }
  return [...c].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'opus';
}

export function claudeArgs({ arm, model, home }) {
  const tools = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob'];
  const mcp = { mcpServers: {} };
  if (arm === 's4') mcp.mcpServers['exovault-recall'] = { command: process.execPath, args: [path.join(RECALL, 'mcp-server.mjs')], env: { HOME: home } };
  const allow = [...tools, ...(arm === 's4' ? [RECALL_TOOL] : [])];
  // The jail shares the host network (the model API needs it), so live services on this machine stay reachable;
  // these rules and the prompt keep the agent off them and off nested agents (seen in the first cold run).
  const deny = ['claude', 'tmux', 'curl', 'wget', 'ssh', 'psql', 'herdr', 'codex'].map((c) => `Bash(${c}:*)`);
  return ['-p', '--model', model, ...(env('TASKAB_EFFORT', '') ? ['--effort', env('TASKAB_EFFORT')] : []), '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--setting-sources', 'project', '--strict-mcp-config',
    '--tools', tools.join(','), '--allowedTools', ...allow, '--max-turns', String(env('TASKAB_MAX_TURNS', 80)),
    '--mcp-config', JSON.stringify(mcp), '--disallowedTools', ...deny, '--settings', JSON.stringify({ disableAllHooks: true, permissions: { allow, deny } }), '--max-budget-usd', String(env('TASKAB_RUN_USD', 10))];
}

function runClaude(args, input, cwd, jail) {
  return new Promise((resolve) => {
    const bin = env('TASKAB_CLAUDE', 'claude');
    const resolved = spawnSync('bash', ['-lc', `command -v ${JSON.stringify(bin)}`], { encoding: 'utf8' }).stdout.trim() || bin;
    const [cmd, argv] = jail ? ['bwrap', [...jail, '--', resolved, ...args]] : [resolved, args];
    const child = spawn(cmd, argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), Number(env('TASKAB_TIMEOUT_MS', 3_600_000)));
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    child.stdin.end(input);
  });
}

function loadTasks(file, only) {
  return readJson(file, []).filter((t) => t.usable && t.target?.length && (!only || only.includes(t.id)));
}

function loadCuts(dump) {
  return fs.readdirSync(dump).filter((f) => /^cut-.*\.json$/.test(f)).map((f) => readJson(path.join(dump, f))).filter((c) => c?.source);
}

/** Everything a run of `task` needs except the model: the cut, both arms' memory, the conversation since, the request. */
export function prepare(task, cuts, root) {
  const lines = fs.readFileSync(task.transcript, 'utf8').split('\n');
  const ask = askLine(lines, task);
  const sessionId = path.basename(task.transcript, '.jsonl');
  const cut = cutFor(cuts, sessionId, ask);
  if (!cut) throw new Error(`no dumped compaction before the request of ${task.id}`);
  // A cut the plugin made has no native summary; the native arm then needs one generated first (native-compact).
  if (!String(cut.native ?? '').trim()) throw new Error(`cut ${cut.id} before the request of ${task.id} has no native summary`);
  const sb = prepareSandbox(root, cut);
  return { cut, sandbox: sb, since: sinceCut(lines, cut.boundaryLine, ask), model: env('TASKAB_MODEL', sessionModel(lines.slice(0, ask))), split: split(sessionId), memory: (arm) => armMemory(cut, arm, sb.transcript) };
}

const recordFile = (out, task, arm, rep) => path.join(out, `${task.id}.${arm}.${rep}.json`);

async function runOne(task, arm, rep, prep, root, out) {
  const dir = path.join(root, 'runs', `${task.id}-${arm}-${rep}`);
  const repo = path.join(dir, 'repo');
  isolatedCheckout(task.repo, task.base, repo);
  install(repo);
  const cwd = task.cwd && task.cwd.startsWith(task.repo) ? task.cwd : task.repo;
  const jailed = env('TASKAB_JAIL', '1') !== '0';
  // In the jail the copy sits at the original path, so paths in the memory and the conversation still hold.
  const jail = jailed ? [...jailArgs(prep.sandbox.dir, cwd), '--bind', repo, task.repo] : null;
  const runCwd = jailed ? (fs.existsSync(cwd.replace(task.repo, repo)) ? cwd.replace(task.repo, repo) : repo) : cwd.replace(task.repo, repo);
  const t0 = Date.now();
  const r = await runClaude(claudeArgs({ arm, model: prep.model, home: prep.sandbox.home }), taskPrompt(prep.memory(arm), prep.since, task.ask), fs.existsSync(runCwd) ? runCwd : repo, jail);
  const seconds = Math.round((Date.now() - t0) / 1000);
  fs.writeFileSync(path.join(out, `${task.id}.${arm}.${rep}.raw.jsonl`), r.out);
  const run = parseStream(r.out);
  const changed = spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).length
    + Number(spawnSync('git', ['-C', repo, 'rev-list', '--count', `${task.base}..HEAD`], { encoding: 'utf8' }).stdout.trim() || 0);
  const built = build(repo);
  const s = score(task, runHidden(task, repo));
  const record = { task: task.id, arm, rep, split: prep.split, cut: prep.cut.id, model: prep.model, ...s, built: built.built, changed, seconds,
    ok: run.ok, exit: r.code, cost: run.cost, turns: run.turns, toolCalls: run.toolCalls, recallCalls: run.tools[RECALL_TOOL] ?? 0,
    inputTokens: run.inputTokens, outputTokens: run.outputTokens, ...(run.ok ? {} : { error: r.err.slice(-300) }) };
  fs.writeFileSync(recordFile(out, task, arm, rep), JSON.stringify(record, null, 1));
  if (env('TASKAB_KEEP', '0') !== '1') fs.rmSync(dir, { recursive: true, force: true });
  return record;
}

export function report(records) {
  const pct = (x) => `${(100 * x).toFixed(1)}%`;
  const lines = ['| arm | runs | tasks | solved | mean reward | regressions/run | tokens in/run | $/run | min/run | recall calls/run |', '|---|---|---|---|---|---|---|---|---|---|'];
  for (const arm of [...new Set(records.map((r) => r.arm))].sort()) {
    const rs = records.filter((r) => r.arm === arm), n = rs.length, avg = (f) => rs.reduce((t, r) => t + f(r), 0) / n;
    lines.push(`| ${arm} | ${n} | ${new Set(rs.map((r) => r.task)).size} | ${pct(avg((r) => (r.solved ? 1 : 0)))} | ${pct(avg((r) => r.reward))} | ${avg((r) => r.regressions).toFixed(2)} | ${(avg((r) => r.inputTokens) / 1000).toFixed(0)}k | ${avg((r) => r.cost).toFixed(2)} | ${(avg((r) => r.seconds) / 60).toFixed(1)} | ${avg((r) => r.recallCalls).toFixed(1)} |`);
  }
  const rows = records.map((r) => ({ arm: r.arm, split: r.split, unit: r.task, reward: r.reward, cost: r.inputTokens }));
  const solvedRows = records.map((r) => ({ arm: r.arm, split: r.split, unit: r.task, reward: r.solved ? 1 : 0, cost: r.inputTokens }));
  const fmt = { costLabel: 'tokens in per run', costFormat: (x) => `${(x / 1000).toFixed(0)}k` };
  const perTask = ['| task | ' + [...new Set(records.map((r) => r.arm))].sort().join(' | ') + ' |', '|---|' + [...new Set(records.map((r) => r.arm))].map(() => '---|').join('')];
  for (const t of [...new Set(records.map((r) => r.task))].sort()) perTask.push(`| ${t} | ${[...new Set(records.map((r) => r.arm))].sort().map((a) => { const rs = records.filter((r) => r.task === t && r.arm === a); return rs.length ? `${rs.filter((r) => r.solved).length}/${rs.length} solved, reward ${pct(rs.reduce((x, r) => x + r.reward, 0) / rs.length)}` : '-'; }).join(' | ')} |`);
  return ['# Task A/B after compaction', '', ...lines, '', '## Gate on mean reward (share of target test cases passing)', '', gateTable(rows, 'native', fmt), '', '## Gate on solved (all target cases pass, no regression)', '', gateTable(solvedRows, 'native', fmt), '', '## Per task', '', ...perTask, ''].join('\n');
}

async function main(argv) {
  const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const [tasksFile] = argv;
  const dump = flag('--dump'), out = flag('--out');
  if (!tasksFile || !dump || !out) throw new Error('usage: task-ab.mjs <tasks.json> --dump <dir> --out <dir> [--plan|--run|--report] [--arms native,s4] [--reps 3] [--only id,id]');
  const arms = flag('--arms', 'native,s4').split(','), reps = Number(flag('--reps', 3)), only = flag('--only')?.split(',');
  const root = env('TASKAB_SANDBOX', '/tmp/taskab');
  fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const tasks = loadTasks(tasksFile, only);
  if (argv.includes('--report')) {
    const records = fs.readdirSync(out).filter((f) => /\.\d+\.json$/.test(f)).map((f) => readJson(path.join(out, f))).filter(Boolean);
    const md = report(records);
    fs.writeFileSync(path.join(out, 'report.md'), md);
    console.log(md);
    return;
  }
  const cuts = loadCuts(dump);
  const preps = new Map();
  for (const t of [...tasks]) {
    let p;
    try { p = prepare(t, cuts, root); } catch (e) { console.log(`${t.id} SKIPPED: ${e.message}`); tasks.splice(tasks.indexOf(t), 1); continue; }
    preps.set(t.id, p);
    console.log(`${t.id} cut ${p.cut.id} (${t.cutsBefore} before) model ${p.model} split ${p.split} | memory ${arms.map((a) => `${a} ${(tokens(p.memory(a)) / 1000).toFixed(1)}k`).join(', ')} | since ${(tokens(p.since) / 1000).toFixed(1)}k | target ${t.target.length} keep ${t.keep.length}`);
  }
  const jobs = [];
  for (let rep = 1; rep <= reps; rep++) for (const t of tasks) for (const arm of arms) if (!fs.existsSync(recordFile(out, t, arm, rep))) jobs.push({ t, arm, rep });
  console.log(`${tasks.length} tasks, ${jobs.length} runs to do`);
  if (!argv.includes('--run')) return;
  const spend = { total: 0, max: Number(env('TASKAB_MAX_SPEND', 20)) };
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const { t, arm, rep } = jobs[i++];
      if (spend.total >= spend.max) { console.error(`spend cap $${spend.max} reached, skipping ${t.id} ${arm} ${rep}`); continue; }
      try {
        const r = await runOne(t, arm, rep, preps.get(t.id), root, out);
        spend.total += r.cost;
        console.log(`${t.id} ${arm} #${rep}: ${r.solved ? 'SOLVED' : `reward ${(100 * r.reward).toFixed(0)}%`} regressions ${r.regressions} $${r.cost.toFixed(2)} ${r.seconds}s turns ${r.turns} recall ${r.recallCalls}${r.ok ? '' : ` FAILED ${r.error}`}`);
      } catch (e) { console.error(`${t.id} ${arm} #${rep}: ERROR ${e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: Number(env('TASKAB_JOBS', 2)) }, worker));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
