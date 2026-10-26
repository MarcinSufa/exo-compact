// 3.31.0 (CONTRACT S4ze): long user requests saved verbatim, plus a model-written checklist in the background.
//   node brief.mjs save <recallRoot> <sessionId> <digestModel|''>   (the text on stdin; returns at once)
//   node brief.mjs digest <briefFile> <model>                        (detached child of save)
// Files: <recallRoot>/<sha256(session)>/briefs/<id>.md, <id>.digest.md, <id>.digest.err and briefs.json (the index).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hash, redactAll } from './shared.mjs';

export const DIGEST_TIMEOUT_MS = 240_000;
export const DIGEST_MAX_CHARS = 60_000;
const MAX_INDEX = 20;

export const briefId = (text) => hash(text).slice(0, 12);
export const briefDir = (root, sessionId) => path.join(root, hash(sessionId), 'briefs');

export function digestPrompt(text) {
  return [
    'Below is a request a user gave an AI coding agent. The agent\'s context will be compacted: afterwards it keeps your checklist and a pointer to the full text, not the text itself.',
    'Write the checklist of every concrete, checkable requirement in it: files to create or change (exact paths), size or line caps, exact names, signatures, strings and numbers, tests to write (files, minimum counts, rules), commands that must pass and their targets, decisions already made, and anything forbidden.',
    'One requirement per line starting with "- ", under short "### " headings that follow the request\'s own sections; in each section put the requirements easiest to get wrong first. Copy identifiers, paths, numbers and quoted strings exactly. No preamble, no commentary, no advice.',
    '', '<request>', text, '</request>',
  ].join('\n');
}

/** Writes `file` atomically with owner-only permissions. */
function writeAtomic(file, text) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function saveBrief(root, sessionId, original, now = new Date()) {
  const dir = briefDir(root, sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // 4.8.1: stored redacted like the index; the id still comes from the text as sent, so a prompt and a cut that save
  // the same request agree on it.
  const id = briefId(original);
  const text = redactAll(original);
  const file = path.join(dir, `${id}.md`);
  if (!fs.existsSync(file)) writeAtomic(file, text);
  const indexFile = path.join(dir, 'briefs.json');
  let index = [];
  try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); if (!Array.isArray(index)) index = []; } catch { index = []; }
  if (!index.some((entry) => entry?.id === id)) {
    const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
    index.push({ id, path: file, chars: text.length, at: now.toISOString(), firstLine: firstLine.slice(0, 200) });
    // Entries written before 4.8.1 (or by a save that overlapped a cleanup) get their first line redacted here too.
    const safe = index.map((entry) => (typeof entry?.firstLine === 'string' ? { ...entry, firstLine: redactAll(entry.firstLine) } : entry));
    writeAtomic(indexFile, JSON.stringify(safe.slice(-MAX_INDEX)));
  }
  return { id, file, dir };
}

/** One digest per brief: the first save that creates the marker starts it (a prompt and a cut can both save). */
function claimDigest(file) {
  try { fs.writeFileSync(file.replace(/\.md$/, '.digest.started'), String(process.pid), { flag: 'wx', mode: 0o600 }); return true; } catch { return false; }
}

/**
 * 4.9.2 (CONTRACT S5w): the variables a project's settings `env` block could use to run its own code in the child, set
 * empty (read as unset). The same list as host/node-run.ts SCRUBBED_ENV.
 */
export const SCRUBBED_ENV = Object.freeze({
  NODE_OPTIONS: '', NODE_PATH: '', NODE_REPL_EXTERNAL_MODULE: '', NODE_V8_COVERAGE: '', NODE_EXTRA_CA_CERTS: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '', LD_PRELOAD: '', LD_AUDIT: '', LD_LIBRARY_PATH: '', DYLD_INSERT_LIBRARIES: '', DYLD_LIBRARY_PATH: '',
});

/**
 * 4.9.2 (CONTRACT S5w): the native install (~/.local/bin) or the npm one next to the Node running this script, never a
 * name looked up on PATH or taken from the environment: a project's settings `env` block reaches this process and can
 * set both (CLAUDE_CODE_EXECPATH included). undefined when neither exists; the digest is then skipped.
 */
export function claudeBin(home = os.homedir(), execPath = process.execPath, exists = fs.existsSync, platform = process.platform) {
  const name = platform === 'win32' ? 'claude.exe' : 'claude';
  return [path.join(home, '.local', 'bin', name), path.join(path.dirname(execPath), name)].find((file) => exists(file));
}

/** The digest child's environment: this process's, scrubbed, with the marker that keeps this plugin's hook out. */
export function digestEnv(env = process.env) {
  return { ...env, ...SCRUBBED_ENV, EXOVAULT_BRIEF_CHILD: '1' };
}

/** argv of the tool-less, plugin-less, session-less child that writes the checklist. */
export function digestArgs(model) {
  return ['-p', '--model', model, '--effort', 'low', '--tools', '', '--strict-mcp-config', '--no-session-persistence',
    '--setting-sources', '', '--disable-slash-commands', '--max-budget-usd', '0.5', '--output-format', 'json'];
}

function digest(file, model) {
  const out = file.replace(/\.md$/, '.digest.md'), err = file.replace(/\.md$/, '.digest.err');
  if (fs.existsSync(out)) return;
  const text = fs.readFileSync(file, 'utf8');
  // EXOVAULT_BRIEF_CHILD keeps this plugin's prompt hook out of the child, so a brief never digests itself.
  const bin = claudeBin();
  if (bin === undefined) { writeAtomic(err, 'no claude binary in ~/.local/bin or next to node\n'); return; }
  const child = spawn(bin, digestArgs(model), { cwd: os.tmpdir(), env: digestEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const timer = setTimeout(() => child.kill('SIGTERM'), DIGEST_TIMEOUT_MS);
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => { clearTimeout(timer); writeAtomic(err, `spawn failed: ${error.message}\n`); });
  const started = Date.now();
  child.on('close', (code) => {
    clearTimeout(timer);
    // 3.56.0 (external review 5 E1): JSON output, so the child's spend is kept next to the digest
    // (<id>.digest.cost.json); it is billed apart from the session and was missing from every A/B cost sum.
    let parsed;
    try { parsed = JSON.parse(stdout); } catch { parsed = undefined; }
    if (parsed && typeof parsed === 'object') {
      writeAtomic(file.replace(/\.md$/, '.digest.cost.json'), `${JSON.stringify({ model, costUsd: parsed.total_cost_usd ?? null, usage: parsed.usage ?? null, ms: Date.now() - started, exit: code })}\n`);
    }
    const result = String(parsed?.result ?? '').trim();
    if (code === 0 && !parsed?.is_error && result && result.length <= DIGEST_MAX_CHARS) writeAtomic(out, `${result}\n`);
    else writeAtomic(err, `exit ${code}, ${result.length} chars\n${stderr.slice(-2000)}`);
  });
  child.stdin.end(digestPrompt(text));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'save') {
    const [root, sessionId, model = ''] = args;
    try {
      const text = fs.readFileSync(0, 'utf8');
      if (text.trim()) {
        const { file } = saveBrief(root, sessionId, text);
        if (model && !fs.existsSync(file.replace(/\.md$/, '.digest.md')) && claimDigest(file)) {
          spawn(process.execPath, [fileURLToPath(import.meta.url), 'digest', file, model], { detached: true, env: { ...process.env, ...SCRUBBED_ENV }, stdio: 'ignore' }).unref();
        }
      }
    } catch { process.exitCode = 1; }
  } else if (command === 'digest') {
    try { digest(args[0], args[1] || 'sonnet'); } catch { /* the seed falls back to the brief's start */ }
  }
}
