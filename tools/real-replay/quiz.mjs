#!/usr/bin/env node
// LoCoMo-style quiz over real compaction cuts: what does the agent know right after the cut, and what does it cost
// to find out the rest? Input is a REPLAY_PROBE_DUMP directory (real-replay.mjs). By default, only cuts with a real
// native summary are used; S4-only comparisons can use any real cut with an S4 seed.
//
//   arms:  native = native summary + preserved segment + re-attached files; the summary's transcript pointer
//                   is redirected to a copy of the transcript cut at the boundary
//          s4     = S4 seed + tail, with the transcript pointer and search_session note the plugin adds,
//                   pointing at the same copy and at a recall index built from it
//          s4tree = the same S4 seed + an offline `## Session tree` view (QUIZ_TREE_DIR/cut-<id>.view.txt)
//   modes: closed = memory only, no tools
//          open   = memory + Read/Grep/Glob on the cut transcript (+ search_session for s4), bounded turns
//
// Questions come from items the agent really used after the cut. A generator model writes them with a gold
// answer from the pre-cut evidence; types: value, latest (a value that changed), why, multi, none (not in the
// session: the right answer is to say so). Each is validated mechanically (gold in evidence, not in question;
// `none` terms absent from the WHOLE session, future included).
//
//   node --experimental-strip-types tools/real-replay/quiz.mjs <dumpDir> --out <dir> --plan        free
//   ... --gen | --answer [closed|open] | --judge | --report | --all                                  paid
//   options: --cuts id1,id2  --arms native,s4,s4tree
//   env: QUIZ_GEN_MODEL (sonnet) QUIZ_MODEL (haiku) QUIZ_JUDGE_MODEL (sonnet) QUIZ_PER_CUT (10)
//        QUIZ_MAX_TURNS (30) QUIZ_JOBS (3) QUIZ_MAX_SPEND (USD, 5) QUIZ_SANDBOX (/tmp/s4quiz) QUIZ_CLAUDE (claude)
//        QUIZ_VECTORS (1: embed every cut's index before answering, as the plugin's embed worker would) QUIZ_TREE_DIR
//
// The dump, the sandbox and <out> hold transcript text: keep them outside the repo, send them only to
// Anthropic models, and delete the sandbox (--cleanup) when done.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { renderTranscriptPointer } from '../../plugin/compact/core/transcript-pointer.ts';
import { hash as indexHash } from '../../plugin/compact/recall/shared.mjs';
import { ensureRuntime, runtimeDir, runtimeReady, vectorFile } from '../../plugin/compact/recall/vectors.mjs';
import { gateTable } from '../eval/gate.mjs';

const RECALL = fileURLToPath(new URL('../../plugin/compact/recall', import.meta.url));
const env = (k, d) => process.env[k] ?? d;
const PER_CUT = Number(env('QUIZ_PER_CUT', 10));
const NONE_PER_CUT = 2;
const MODELS = { gen: env('QUIZ_GEN_MODEL', 'sonnet'), answer: env('QUIZ_MODEL', 'haiku'), judge: env('QUIZ_JUDGE_MODEL', 'sonnet') };
const PRICE = { haiku: [1, 5], sonnet: [3, 15], opus: [5, 25] }; // USD per million input / output tokens
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const tokens = (s) => Math.ceil(String(s).length / 4);
const lower = (s) => String(s ?? '').toLowerCase();
const TYPES = ['value', 'latest', 'why', 'multi', 'none'];
export const RECALL_TOOL = 'mcp__exovault-recall__search_session';

// ---------- cut preparation (free) ----------

/** The transcript as it was at the cut: the first `boundaryLine` parsed events, as real-replay counts them. */
export function prefixLines(sourceText, boundaryLine, boundaryUuid) {
  const out = [];
  let boundary;
  for (const raw of sourceText.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (out.length === boundaryLine) { boundary = event; break; }
    out.push(line);
  }
  if (boundaryUuid && boundary?.uuid !== boundaryUuid) throw new Error(`boundary mismatch: expected ${boundaryUuid}, found ${boundary?.uuid ?? 'end of file'}`);
  return out.length ? `${out.join('\n')}\n` : '';
}

/** Memory each arm starts from, with every transcript pointer aimed at the sandbox copy. */
export function armMemory(cut, arm, transcriptPath) {
  if (arm === 'native') return String(cut.nativeFull).replace(/(full transcript at:?\s*)\S+\.jsonl/g, `$1${transcriptPath}`);
  const pointer = renderTranscriptPointer(transcriptPath, { sessionId: cut.sessionId });
  const text = String(cut.s4Full);
  const section = /^## Transcript\n[\s\S]*?(?=\n\n## |\n\n\[omitted-history:|$)/m;
  let memory = section.test(text) ? text.replace(section, `## Transcript\n${pointer}`) : `${text}\n\n## Transcript\n${pointer}`;
  if (arm === 's4tree') {
    const treeDir = env('QUIZ_TREE_DIR', '');
    if (!treeDir) throw new Error('s4tree requires QUIZ_TREE_DIR pointing at tree-eval output');
    const viewFile = path.join(treeDir, `cut-${cut.id}.view.txt`);
    if (!fs.existsSync(viewFile)) throw new Error(`s4tree view is missing: ${viewFile}`);
    memory += `\n\n## Session tree\n${fs.readFileSync(viewFile, 'utf8').trimEnd()}`;
  }
  return memory;
}

export function sandboxPaths(root, cut) {
  const dir = path.join(root, String(cut.id));
  const home = path.join(dir, 'home');
  return { dir, home, transcript: path.join(home, '.claude', 'projects', 'quiz', `${cut.sessionId}.jsonl`), recallRoot: path.join(home, '.claude', 'exovault', 'recall'), work: (arm) => path.join(dir, `work-${arm}`) };
}

/** Writes the cut transcript and builds the recall index from it, exactly as the plugin's worker would. */
export function prepareSandbox(root, cut) {
  const p = sandboxPaths(root, cut);
  if (fs.existsSync(p.transcript) && fs.existsSync(path.join(p.recallRoot, indexHash(cut.sessionId), 'CURRENT'))) return p;
  fs.mkdirSync(path.dirname(p.transcript), { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  fs.writeFileSync(p.transcript, prefixLines(fs.readFileSync(cut.source, 'utf8'), cut.boundaryLine, cut.boundaryUuid), { mode: 0o600 });
  const project = path.join(p.dir, 'project'); fs.mkdirSync(project, { recursive: true });
  for (const arm of ['native', 's4']) fs.mkdirSync(p.work(arm), { recursive: true });
  const r = spawnSync(process.execPath, [path.join(RECALL, 'build-worker.mjs'), p.transcript, p.recallRoot, cut.sessionId, String(fs.statSync(p.transcript).size), project], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`index build failed for ${cut.id}: ${r.stderr || r.stdout}`);
  return p;
}

export function indexRows(recallRoot, sessionId) {
  const dir = path.join(recallRoot, indexHash(sessionId));
  const gen = Number(fs.readFileSync(path.join(dir, 'CURRENT'), 'utf8').trim());
  return JSON.parse(fs.readFileSync(path.join(dir, `generation-${String(gen).padStart(8, '0')}`, 'records.json'), 'utf8'));
}

// Items whose only later use is a message from another session or a task notification were not recalled by the agent.
const NOISE_CONTEXT = /^\s*(Another Claude session sent a message|<task-notification>|\[SYSTEM NOTIFICATION)/;
const NOISE_ITEM = /^(toolu_|msg_|req_)|^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$|^\/tmp\//i;
// A value with one right answer: a path, flag, number, hash or mixed-case name, starting like a token (as cloze.mjs).
export const specific = (item) => item.length >= 4 && item.split(/\s+/).length <= 6 && /[\/._\-\d]|[a-z][A-Z]/.test(item) && /^[\p{L}\p{N}$~\/.\-_@#]/u.test(item);
/** Items used after the cut that the pre-cut session holds, each with its latest evidence (redacted index text). */
export function candidates(cut, rows, limit = PER_CUT * 3) {
  const seen = new Set();
  const out = [];
  for (const x of cut.items) {
    const item = String(x.item ?? '').trim();
    const key = lower(item);
    if (seen.has(key) || NOISE_ITEM.test(item) || NOISE_CONTEXT.test(String(x.context ?? '')) || !specific(item) || lower(cut.sessionId).includes(key)) continue;
    seen.add(key);
    const hits = rows.filter((r) => lower(r.text).includes(key)).sort((a, b) => b.position - a.position);
    if (!hits.length) continue;
    const evidence = hits.slice(0, 3).map((r) => {
      const at = lower(r.text).lastIndexOf(key);
      return `[${r.role}${r.tool ? ` ${r.tool}` : ''}, turn ${r.turn}] ${r.text.slice(Math.max(0, at - 350), at + key.length + 350)}`;
    });
    out.push({ item, usedLater: String(x.context ?? '').slice(0, 400), evidence, rank: sha(`${cut.id}\0${key}`) });
  }
  return out.sort((a, b) => a.rank.localeCompare(b.rank)).slice(0, limit);
}

// ---------- prompts ----------

export function genPrompt(cands, perCut = PER_CUT) {
  const list = cands.map((c, i) => `### Candidate ${i + 1}: ${JSON.stringify(c.item)}\nUsed by the agent after the cut: ${c.usedLater}\nEvidence before the cut (newest first):\n${c.evidence.map((e) => `- ${e}`).join('\n')}`).join('\n\n');
  return [
    'You write a memory quiz for an AI coding agent whose context was just compacted. Below are details the agent',
    'needed later, with the evidence from BEFORE the compaction. Write questions the agent (or its user) would',
    'plausibly ask itself at that moment, each answerable only from the session history before the cut.',
    '',
    `Write ${perCut - NONE_PER_CUT} answerable questions and ${NONE_PER_CUT} questions of type "none". Types:`,
    '- "value": the gold answer is exactly one candidate string (copy it verbatim into "gold" and "item").',
    '- "latest": as value, but the evidence shows the value changed; the gold is the newest one.',
    '- "why": the reason or decision behind something; gold is one short sentence from the evidence; "item" is the candidate it is about.',
    '- "multi": needs two details together; gold is short; "item" is one of the candidates.',
    '- "none": a plausible detail that this session never contained. Give "absent": 1-3 specific terms that would',
    '  have to appear in the session if it existed (a made-up file name, flag, id or number). Gold is "not in session".',
    'Prefer at least half "value". Skip incidental candidates (temporary file names, tool call ids, session ids).',
    'Never put the gold answer or the item string inside the question. Write questions in the language of the evidence.',
    '',
    'Reply with JSON only: {"questions":[{"type":"value","q":"...","gold":"...","item":"...","absent":[]}]}',
    '', list,
  ].join('\n');
}

export function validateQuestions(raw, cands, preText, wholeText, perCut = PER_CUT) {
  const items = new Map(cands.map((c) => [lower(c.item), c]));
  const pre = lower(preText), whole = lower(wholeText);
  const out = [], rejected = [];
  for (const q of Array.isArray(raw) ? raw : []) {
    const type = TYPES.includes(q?.type) ? q.type : '';
    const text = String(q?.q ?? '').trim(), gold = String(q?.gold ?? '').trim();
    const reject = (why) => rejected.push({ ...q, why });
    if (!type || text.length < 8 || !gold) { reject('shape'); continue; }
    if (type === 'none') {
      const absent = (Array.isArray(q.absent) ? q.absent : []).map(String).filter((t) => t.trim().length >= 3);
      if (!absent.length) { reject('no absent terms'); continue; }
      if (absent.some((t) => whole.includes(lower(t)))) { reject('absent term occurs in session'); continue; }
      if (out.filter((x) => x.type === 'none').length >= NONE_PER_CUT) { reject('too many none'); continue; }
      out.push({ type, q: text, gold: 'not in session', absent });
      continue;
    }
    const item = String(q.item ?? '').trim();
    if (!items.has(lower(item))) { reject('item not a candidate'); continue; }
    if (lower(text).includes(lower(item)) || ((type === 'value' || type === 'latest') && lower(text).includes(lower(gold)))) { reject('answer in question'); continue; }
    if ((type === 'value' || type === 'latest') && (lower(gold) !== lower(item) || !pre.includes(lower(gold)))) { reject('gold not the item or not before the cut'); continue; }
    if (out.some((x) => x.q === text)) { reject('duplicate'); continue; }
    out.push({ type, q: text, gold, item });
  }
  return { questions: out.slice(0, perCut), rejected };
}

function questionList(questions) { return questions.map((q, i) => `${i + 1}. ${q.q}`).join('\n'); }

export function answerPrompt(memory, questions, mode) {
  const how = mode === 'open'
    ? 'You may look things up with the tools you have before answering. Look up what you are not sure of; do not guess. '
      + 'The project files are not available here (they have changed since); only the record of this session is.'
    : 'Answer from the context above only.';
  return [
    '<context-after-compaction>', memory, '</context-after-compaction>', '',
    'The block above is everything you still have from earlier in this session after its context was compacted.',
    `Answer these questions about the earlier work. ${how}`,
    'Give exact values (paths, ids, numbers, commands) where asked. If the session never contained the answer, or you',
    'cannot find it, answer UNKNOWN.', '',
    questionList(questions), '',
    'Finish with JSON only, one answer per question: {"1": "...", "2": "..."}',
  ].join('\n');
}

export function judgePrompt(rows) {
  const list = rows.map((r, i) => `${i + 1}. Question: ${r.q}\n   Gold: ${r.gold}\n   Answer: ${r.answer}`).join('\n');
  return [
    'Grade each answer against the gold answer. "correct": it states the gold value or meaning (extra detail is fine).',
    '"wrong": a different value, a contradiction, or a confident claim not supported by the gold. "abstain": it says it',
    'does not know or cannot find it. For gold "not in session", an answer that says so (or UNKNOWN) is "correct" and',
    'any concrete claimed value is "wrong".',
    '', list, '',
    'Reply with JSON only: {"1": "correct", "2": "wrong", ...}',
  ].join('\n');
}

// ---------- scoring (free) ----------

// `nie wiem|brak` are Polish ("I do not know", "none"): the plugin also reads messages written in Polish.
const ABSTAIN = /^(unknown|n\/a|none|not (found|known|available|in (the )?(session|context|memory))|i (do not|don't) know|cannot (find|determine)|nie wiem|brak)\b/i;
/** Deterministic verdict where one exists; undefined means the judge model decides. */
export function quickVerdict(q, answer) {
  const a = String(answer ?? '').trim().replace(/^[`'"]+|[`'"]+$/g, '');
  if (!a || ABSTAIN.test(a)) return q.type === 'none' ? 'correct' : 'abstain';
  if (q.type === 'none') return undefined;
  if (q.type === 'value' || q.type === 'latest') {
    const A = lower(a), G = lower(q.gold);
    if (A === G || A.includes(G)) return 'correct';
    return undefined;
  }
  return undefined;
}

export function parseJsonObject(text, key) {
  // The last JSON object in the text; with `key`, the last one holding that key (an explanation after the
  // answer can quote JSON of its own, e.g. an API error body), else the last one found.
  const s = String(text ?? '');
  let fallback;
  for (let end = s.lastIndexOf('}'); end >= 0; end = s.lastIndexOf('}', end - 1)) {
    for (let start = s.lastIndexOf('{', end); start >= 0; start = s.lastIndexOf('{', start - 1)) {
      let v; try { v = JSON.parse(s.slice(start, end + 1)); } catch { continue; /* widen */ }
      if (!v || typeof v !== 'object') continue;
      if (key === undefined || Object.hasOwn(v, key)) return v;
      fallback ??= v;
      break;
    }
  }
  return fallback;
}

/** Final result, usage and tool calls from a `--output-format stream-json --verbose` run. */
export function parseStream(text) {
  const tools = {}; let result, init;
  for (const line of String(text).split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'system' && e.subtype === 'init') init = { tools: e.tools ?? [], mcp: e.mcp_servers ?? [] };
    if (e.type === 'assistant') for (const b of e.message?.content ?? []) if (b.type === 'tool_use') tools[b.name] = (tools[b.name] ?? 0) + 1;
    if (e.type === 'result') result = e;
  }
  const u = result?.usage ?? {};
  return {
    ok: !!result && !result.is_error, text: String(result?.result ?? ''), cost: Number(result?.total_cost_usd ?? 0), turns: Number(result?.num_turns ?? 0),
    durationMs: Number(result?.duration_ms ?? 0), tools, toolCalls: Object.values(tools).reduce((n, v) => n + v, 0),
    inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), outputTokens: u.output_tokens ?? 0, init,
  };
}

// ---------- model calls ----------

export function claudeArgs({ model, mode, arm, sandbox }) {
  // Open runs also execute inside jailArgs(), where /home, /work and /tmp hold only this cut's sandbox; the deny
  // rules are a second fence for the Read/Grep/Glob tools.
  const allow = [], deny = ['Read(//home/**)', 'Grep(//home/**)', 'Glob(//home/**)', 'Read(//work/**)', 'Read(//root/**)', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch'];
  const mcp = { mcpServers: {} };
  const args = ['-p', '--model', model, '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--setting-sources', 'project', '--strict-mcp-config'];
  if (mode === 'open') {
    for (const t of ['Read', 'Grep', 'Glob']) allow.push(`${t}(/${sandbox.home}/**)`);
    allow.push('Bash');
    if (arm === 's4') {
      // QUIZ_JEV=1: Jev ranks search hits, as with jevEnabled in the plugin (key from this process's environment).
      const jev = env('QUIZ_JEV', '0') === '1' && process.env.TYPESAFE_API_KEY ? { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY, EXO_JEV_ENABLED: 'true' } : {};
      mcp.mcpServers['exovault-recall'] = { command: process.execPath, args: [path.join(RECALL, 'mcp-server.mjs')], env: { HOME: sandbox.home, ...jev } };
      allow.push(RECALL_TOOL);
    }
    args.push('--tools', 'Bash,Read,Grep,Glob', '--allowedTools', ...allow, '--max-turns', String(env('QUIZ_MAX_TURNS', 30)));
  } else {
    args.push('--tools', '', '--max-turns', '1', '--disallowedTools', 'Bash');
  }
  args.push('--mcp-config', JSON.stringify(mcp), '--settings', JSON.stringify({ disableAllHooks: true, permissions: { allow, deny } }), '--max-budget-usd', '1');
  return args;
}

/**
 * bubblewrap jail for runs with tools: the whole home, /work and /tmp are replaced by empty tmpfs, and only the
 * node/claude install, the login files (bound, never read here), the recall code and this cut's sandbox come back.
 * A private PID namespace keeps /proc/<pid>/root of host processes out of reach. Network stays (the API).
 */
export function jailArgs(sandboxDir, cwd, home = os.homedir()) {
  const bind = (flag, p) => (fs.existsSync(p) ? [flag, p, p] : []);
  return [
    '--bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent',
    '--tmpfs', home, '--tmpfs', '/work', '--tmpfs', '/tmp', '--tmpfs', '/var/tmp', '--tmpfs', '/root',
    ...bind('--ro-bind', path.join(home, '.nvm')), ...bind('--ro-bind', path.join(home, '.local')),
    ...bind('--bind', path.join(home, '.claude.json')), ...bind('--bind', path.join(home, '.claude', '.credentials.json')),
    '--ro-bind', RECALL, RECALL, '--bind', sandboxDir, sandboxDir, '--chdir', cwd,
  ];
}

function runClaude(args, input, cwd, jail) {
  return new Promise((resolve) => {
    const bin = env('QUIZ_CLAUDE', 'claude');
    const resolved = jail ? (spawnSync('bash', ['-lc', `command -v ${JSON.stringify(bin)}`], { encoding: 'utf8' }).stdout.trim() || bin) : bin;
    const [cmd, argv] = jail ? ['bwrap', [...jailArgs(jail, cwd), '--', resolved, ...args]] : [bin, args];
    const child = spawn(cmd, argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 600_000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    // A CLI that cannot start (missing binary or cwd) fails this job only; the pool logs it as FAILED.
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, out, err: `${err}${error.message}` }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function pool(jobs, n, spend) {
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const job = jobs[i++];
      if (spend.total >= spend.max) { console.error(`spend cap $${spend.max} reached, skipping ${job.name}`); continue; }
      const r = await runClaude(job.args, job.input, job.cwd, job.jail);
      fs.writeFileSync(job.raw, r.out);
      const parsed = parseStream(r.out);
      spend.total += parsed.cost;
      console.log(`${job.name}: ${parsed.ok ? 'ok' : `FAILED (exit ${r.code}) ${r.err.slice(0, 200)}`} $${parsed.cost.toFixed(3)} turns ${parsed.turns} tools ${parsed.toolCalls}`);
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
}

// ---------- stages ----------

export function assertSafeCutId(id) {
  if (typeof id !== 'string' && typeof id !== 'number') throw new Error(`unsafe cut id ${JSON.stringify(id)}: must match /^[\\w.-]+$/`);
  const text = String(id);
  if (!/^[\w.-]+$/.test(text) || text === '.' || text === '..') throw new Error(`unsafe cut id ${JSON.stringify(text)}: must match /^[\\w.-]+$/ (it is joined into output paths)`);
  return text;
}

export function loadCuts(dump, only, arms = ['native', 's4']) {
  const needNative = arms.includes('native');
  return fs.readdirSync(dump).filter((f) => /^cut-.*\.json$/.test(f)).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dump, f), 'utf8')))
    .map((c) => { assertSafeCutId(c.id); return c; })
    .filter((c) => c.source && String(c.s4Full ?? '').trim() && (!needNative || String(c.native ?? '').trim()) && (!only || only.includes(String(c.id))));
}
const file = (out, cut, ...parts) => path.join(out, `${cut.id}.${parts.join('.')}`);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
export const split = (sessionId) => (parseInt(sha(sessionId)[0], 16) < 8 ? 'dev' : 'heldout');

function plan(cuts, root, arms, modes = ['closed', 'open']) {
  let gen = 0, closed = 0, open = 0, mem = { native: 0, s4: 0 };
  for (const cut of cuts) {
    const p = sandboxPaths(root, cut);
    for (const arm of arms) mem[arm] = (mem[arm] ?? 0) + tokens(armMemory(cut, arm, p.transcript));
    gen += 9000 + PER_CUT * 3 * 450;
  }
  for (const arm of arms) {
    if (modes.includes('closed')) closed += mem[arm] + 25000;
    if (modes.includes('open')) open += (mem[arm] + 25000) * 8;
  }
  const [gi, go] = PRICE[MODELS.gen] ?? PRICE.sonnet, [ai, ao] = PRICE[MODELS.answer] ?? PRICE.haiku;
  // open mode re-sends context each turn; most of it is a cache read (0.1x), so count 8 turns at ~25% effective price.
  const modeCount = modes.length;
  const usd = (gen * gi + cuts.length * 4000 * go) / 1e6 + (closed * ai) / 1e6 + (open * ai * 0.25) / 1e6 + cuts.length * arms.length * modeCount * 3000 * gi / 1e6;
  console.log(`${cuts.length} cuts (${cuts.filter((c) => split(c.sessionId) === 'dev').length} dev), memory per cut: ${arms.map((a) => `${a} ${(mem[a] / Math.max(1, cuts.length) / 1000).toFixed(1)}k`).join(', ')}`);
  console.log(`calls: gen ${cuts.length} (${MODELS.gen}), answer ${cuts.length * arms.length * modeCount} (${MODELS.answer}), judge <= ${cuts.length * arms.length * modeCount} (${MODELS.judge})`);
  console.log(`rough cost: $${usd.toFixed(2)} (estimate only; actual cost is printed per call)`);
}

async function stageGen(cuts, root, out, spend) {
  const jobs = [];
  for (const cut of cuts) {
    if (fs.existsSync(file(out, cut, 'questions.json'))) continue;
    const p = prepareSandbox(root, cut);
    const cands = candidates(cut, indexRows(p.recallRoot, cut.sessionId));
    fs.writeFileSync(file(out, cut, 'candidates.json'), JSON.stringify(cands, null, 1));
    if (cands.length < 3) { console.log(`${cut.id}: only ${cands.length} candidates, skipped`); continue; }
    jobs.push({ name: `${cut.id} gen`, cut, cands, args: ['-p', '--model', MODELS.gen, '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--max-turns', '1', '--settings', '{"disableAllHooks":true}'], input: genPrompt(cands), cwd: p.work('native'), raw: file(out, cut, 'gen.raw.jsonl') });
  }
  await pool(jobs, Number(env('QUIZ_JOBS', 3)), spend);
  for (const job of jobs) {
    const parsed = parseStream(fs.readFileSync(job.raw, 'utf8'));
    const p = sandboxPaths(root, job.cut);
    const whole = fs.readFileSync(job.cut.source, 'utf8');
    const { questions, rejected } = validateQuestions(parseJsonObject(parsed.text, 'questions')?.questions, job.cands, fs.readFileSync(p.transcript, 'utf8'), whole);
    fs.writeFileSync(file(out, job.cut, 'rejected.json'), JSON.stringify(rejected, null, 1));
    if (questions.length) fs.writeFileSync(file(out, job.cut, 'questions.json'), JSON.stringify(questions, null, 1));
    console.log(`${job.cut.id}: ${questions.length} questions (${TYPES.map((t) => `${t} ${questions.filter((q) => q.type === t).length}`).join(', ')}), ${rejected.length} rejected`);
  }
}

/**
 * Vectors for each cut's index, as in a live session: one shared runtime under the sandbox root, hard-linked into
 * every cut's home (the jail only sees that cut's directory), then the plugin's embed worker per cut.
 */
async function prepareVectors(cuts, root) {
  const shared = path.join(root, '.recall-runtime');
  if (!(await ensureRuntime(shared, (line) => console.error(`runtime: ${line}`)))) throw new Error(`vector runtime install failed; see ${shared}/FAILED`);
  const jobs = cuts.map((cut) => {
    const p = prepareSandbox(root, cut);
    const runtime = runtimeDir(p.recallRoot);
    if (!runtimeReady(runtime)) {
      fs.rmSync(runtime, { recursive: true, force: true });
      const cp = spawnSync('cp', ['-al', shared, runtime]);
      if (cp.status !== 0) throw new Error(`cannot link the runtime into ${runtime}: ${cp.stderr}`);
    }
    return { cut, p };
  });
  // Cuts of one session share most of their text: embed them in order, each seeded with the previous cut's vectors,
  // so only the new chunks are computed (a live session gets the same effect from the per-turn worker).
  const bySession = new Map();
  for (const job of jobs) bySession.set(job.cut.sessionId, [...(bySession.get(job.cut.sessionId) ?? []), job]);
  const chains = [...bySession.values()].map((list) => list.sort((a, b) => a.cut.boundaryLine - b.cut.boundaryLine));
  const RECORD = 392;
  const seed = (from, to) => {
    let source; try { source = fs.readFileSync(from); } catch { return; }
    let have = new Set(); try { const t = fs.readFileSync(to); for (let at = 0; at + RECORD <= t.length; at += RECORD) have.add(t.toString('hex', at, at + 8)); } catch {}
    const add = [];
    for (let at = 0; at + RECORD <= source.length; at += RECORD) if (!have.has(source.toString('hex', at, at + 8))) add.push(source.subarray(at, at + RECORD));
    if (add.length) fs.appendFileSync(to, Buffer.concat(add), { mode: 0o600 });
  };
  const runChain = async (chain) => {
    let previous;
    for (const { cut, p } of chain) {
      const started = Date.now();
      const file = vectorFile(path.join(p.recallRoot, indexHash(cut.sessionId)));
      if (previous) seed(previous, file);
      await new Promise((resolve) => spawn(process.execPath, [path.join(RECALL, 'embed-worker.mjs'), p.recallRoot, cut.sessionId], { stdio: 'ignore' }).on('close', resolve));
      const rows = indexRows(p.recallRoot, cut.sessionId).length;
      let vectors = 0; try { vectors = fs.statSync(file).size / RECORD; } catch {}
      console.error(`${cut.id}: vectors ${vectors} for ${rows} rows (${Math.round((Date.now() - started) / 1000)} s)`);
      previous = file;
    }
  };
  await Promise.all(chains.map(runChain));
}

async function stageAnswer(cuts, root, out, arms, modes, spend) {
  if (env('QUIZ_VECTORS', '1') !== '0' && arms.includes('s4') && modes.includes('open')) await prepareVectors(cuts.filter((cut) => readJson(file(out, cut, 'questions.json'))), root);
  const jobs = [];
  for (const cut of cuts) {
    const questions = readJson(file(out, cut, 'questions.json'));
    if (!questions) continue;
    const p = prepareSandbox(root, cut);
    for (const arm of arms) for (const mode of modes) {
      const raw = file(out, cut, arm, mode, 'raw.jsonl');
      if (fs.existsSync(raw) && parseStream(fs.readFileSync(raw, 'utf8')).ok) continue;
      const input = answerPrompt(armMemory(cut, arm, p.transcript), questions, mode);
      // prepareSandbox makes the native and s4 work dirs only, and returns early for a sandbox built before.
      fs.mkdirSync(p.work(arm), { recursive: true });
      fs.writeFileSync(file(out, cut, arm, mode, 'prompt.txt'), input);
      const jail = mode === 'open' && env('QUIZ_JAIL', '1') !== '0' ? p.dir : undefined;
      jobs.push({ name: `${cut.id} ${arm} ${mode}`, args: claudeArgs({ model: MODELS.answer, mode, arm, sandbox: p }), input, cwd: p.work(arm), raw, jail });
    }
  }
  await pool(jobs, Number(env('QUIZ_JOBS', 3)), spend);
}

async function stageJudge(cuts, out, arms, modes, spend) {
  const jobs = [];
  for (const cut of cuts) {
    const questions = readJson(file(out, cut, 'questions.json'));
    if (!questions) continue;
    for (const arm of arms) for (const mode of modes) {
      const raw = file(out, cut, arm, mode, 'raw.jsonl');
      if (!fs.existsSync(raw) || fs.existsSync(file(out, cut, arm, mode, 'verdicts.json'))) continue;
      const answers = parseJsonObject(parseStream(fs.readFileSync(raw, 'utf8')).text, '1') ?? {};
      const rows = questions.map((q, i) => ({ ...q, answer: String(answers[String(i + 1)] ?? '') }));
      const verdicts = rows.map((r) => quickVerdict(r, r.answer));
      const open = rows.map((r, i) => ({ ...r, i })).filter((r) => verdicts[r.i] === undefined);
      const job = { cut, arm, mode, rows, verdicts, open };
      if (open.length) {
        job.name = `${cut.id} ${arm} ${mode} judge`;
        job.raw = file(out, cut, arm, mode, 'judge.raw.jsonl');
        job.input = judgePrompt(open);
        job.cwd = out;
        job.args = ['-p', '--model', MODELS.judge, '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--max-turns', '1', '--settings', '{"disableAllHooks":true}'];
      }
      jobs.push(job);
    }
  }
  await pool(jobs.filter((j) => j.open.length), Number(env('QUIZ_JOBS', 3)), spend);
  for (const job of jobs) {
    if (job.open.length) {
      if (!fs.existsSync(job.raw)) continue;
      const v = parseJsonObject(parseStream(fs.readFileSync(job.raw, 'utf8')).text, '1') ?? {};
      job.open.forEach((r, k) => { job.verdicts[r.i] = ['correct', 'wrong', 'abstain'].includes(v[String(k + 1)]) ? v[String(k + 1)] : 'wrong'; });
    }
    fs.writeFileSync(file(out, job.cut, job.arm, job.mode, 'verdicts.json'), JSON.stringify(job.rows.map((r, i) => ({ type: r.type, q: r.q, gold: r.gold, answer: r.answer, verdict: job.verdicts[i] })), null, 1));
  }
}

/** 95% interval of the correct share, resampling whole cuts (questions of one cut are not independent). Seeded. */
export function bootstrap(records, rounds = 2000) {
  if (records.length < 2) return ['-', '-'];
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const shares = [];
  for (let b = 0; b < rounds; b++) {
    let ok = 0, n = 0;
    for (let i = 0; i < records.length; i++) {
      const r = records[Math.floor(rand() * records.length)];
      ok += r.verdicts.filter((x) => x.verdict === 'correct').length; n += r.verdicts.length;
    }
    shares.push(n ? ok / n : 0);
  }
  shares.sort((x, y) => x - y);
  const at = (q) => `${(100 * shares[Math.min(rounds - 1, Math.floor(q * rounds))]).toFixed(0)}%`;
  return [at(0.025), at(0.975)];
}

export function summarize(records) {
  const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '-');
  const lines = ['| arm | mode | split | questions | correct (95% CI over cuts) | wrong | abstain | none answered wrongly | per cut: tokens in | tool calls | turns | $ |', '|---|---|---|---|---|---|---|---|---|---|---|---|'];
  const groups = new Map();
  for (const r of records) for (const s of [r.split, 'all']) {
    const k = `${r.arm}|${r.mode}|${s}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const [k, rs] of [...groups].sort()) {
    const [arm, mode, s] = k.split('|');
    const v = rs.flatMap((r) => r.verdicts);
    const none = v.filter((x) => x.type === 'none');
    const n = rs.length;
    const avg = (f) => (rs.reduce((t, r) => t + f(r), 0) / n);
    const [lo, hi] = bootstrap(rs);
    lines.push(`| ${arm} | ${mode} | ${s} | ${v.length} | ${pct(v.filter((x) => x.verdict === 'correct').length, v.length)} (${lo}-${hi}) | ${pct(v.filter((x) => x.verdict === 'wrong').length, v.length)} | ${pct(v.filter((x) => x.verdict === 'abstain').length, v.length)} | ${none.filter((x) => x.verdict === 'wrong').length}/${none.length} | ${(avg((r) => r.inputTokens) / 1000).toFixed(1)}k | ${avg((r) => r.toolCalls).toFixed(1)} | ${avg((r) => r.turns).toFixed(1)} | ${avg((r) => r.cost).toFixed(3)} |`);
  }
  const byType = ['', '| arm | mode | ' + TYPES.join(' | ') + ' |', '|---|---|' + TYPES.map(() => '---|').join('')];
  for (const arm of [...new Set(records.map((r) => r.arm))]) for (const mode of [...new Set(records.map((r) => r.mode))]) {
    const v = records.filter((r) => r.arm === arm && r.mode === mode).flatMap((r) => r.verdicts);
    if (v.length) byType.push(`| ${arm} | ${mode} | ${TYPES.map((t) => { const x = v.filter((y) => y.type === t); return `${pct(x.filter((y) => y.verdict === 'correct').length, x.length)} (${x.length})`; }).join(' | ')} |`);
  }
  return [...lines, ...byType].join('\n');
}

/**
 * Gate (tools/eval/gate.mjs): each arm against QUIZ_BASELINE (native) per mode, a cut as the unit, its correct
 * share as the reward and input tokens as the cost. Tune on dev; the heldout row is the one that decides.
 */
export function gateSection(records, baseline = env('QUIZ_BASELINE', 'native')) {
  const modes = [...new Set(records.map((r) => r.mode))].sort();
  const parts = ['## Gate (tune on dev, decide on heldout)'];
  for (const mode of modes) {
    const rows = records.filter((r) => r.mode === mode && r.verdicts.length).map((r) => ({ arm: r.arm, split: r.split, unit: r.cut, reward: r.verdicts.filter((x) => x.verdict === 'correct').length / r.verdicts.length, cost: r.inputTokens ?? 0 }));
    if (rows.some((r) => r.arm === baseline) && rows.some((r) => r.arm !== baseline)) parts.push(`### ${mode}\n\n${gateTable(rows, baseline, { costLabel: 'tokens in per cut', costFormat: (x) => `${(x / 1000).toFixed(1)}k` })}`);
  }
  return parts.length > 1 ? parts.join('\n\n') : '';
}

function stageReport(cuts, root, out, arms, modes) {
  const records = [];
  for (const cut of cuts) for (const arm of arms) for (const mode of modes) {
    const verdicts = readJson(file(out, cut, arm, mode, 'verdicts.json'));
    if (!verdicts) continue;
    const run = parseStream(fs.readFileSync(file(out, cut, arm, mode, 'raw.jsonl'), 'utf8'));
    records.push({ cut: cut.id, arm, mode, split: split(cut.sessionId), verdicts, ...run, memoryTokens: tokens(armMemory(cut, arm, sandboxPaths(root, cut).transcript)) });
  }
  const md = `# Quiz after compaction\n\nmodels: answer ${MODELS.answer}, questions ${MODELS.gen}, judge ${MODELS.judge}; cuts ${new Set(records.map((r) => r.cut)).size}\n\n${summarize(records)}\n\n${gateSection(records)}\n`;
  fs.writeFileSync(path.join(out, 'report.md'), md);
  fs.writeFileSync(path.join(out, 'records.json'), JSON.stringify(records.map(({ init, ...r }) => r), null, 1));
  console.log(md);
}

async function main(argv) {
  const dump = argv[0];
  const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const out = opt('--out');
  if (!dump || !out) throw new Error('Usage: quiz.mjs <dumpDir> --out <dir> [--plan|--gen|--answer [closed|open]|--judge|--report|--all|--cleanup] [--cuts a,b] [--arms native,s4,s4tree]');
  fs.mkdirSync(out, { recursive: true });
  const root = env('QUIZ_SANDBOX', '/tmp/s4quiz');
  if (root.startsWith('/home/')) throw new Error('QUIZ_SANDBOX must be outside /home: the answer runs deny Read(//home/**) so they cannot reach the live transcript');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const arms = (opt('--arms') ?? 'native,s4').split(',');
  const cuts = loadCuts(dump, opt('--cuts')?.split(','), arms);
  const modeArg = opt('--answer');
  const modes = modeArg === 'closed' || modeArg === 'open' ? [modeArg] : ['closed', 'open'];
  const spend = { total: 0, max: Number(env('QUIZ_MAX_SPEND', 5)) };
  const all = argv.includes('--all');
  if (argv.includes('--plan')) plan(cuts, root, arms, modes);
  if (all || argv.includes('--gen')) await stageGen(cuts, root, out, spend);
  if (all || argv.includes('--answer')) await stageAnswer(cuts, root, out, arms, modes, spend);
  if (all || argv.includes('--judge')) await stageJudge(cuts, out, arms, modes, spend);
  if (all || argv.includes('--report')) stageReport(cuts, root, out, arms, modes);
  if (spend.total) console.log(`spent this run: $${spend.total.toFixed(3)}`);
  if (argv.includes('--cleanup')) for (const cut of cuts) fs.rmSync(sandboxPaths(root, cut).dir, { recursive: true, force: true });
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
