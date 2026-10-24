#!/usr/bin/env node
// exo-compact status: which recent Claude Code sessions run S4, and how their compactions went.
// Reads local transcripts only ($CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects) and prints metadata, never message content.
//   node tools/status.mjs [--days N] [--all] [--headless] [--json]
// --all lists sessions without S4 too; --headless includes -p / SDK runs (tests, scripted runs). Extension sessions (claude-vscode) are always listed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { claudeProjectsDir, homeDir } from '../plugin/compact/recall/paths.mjs';

export const SEED_SENTINEL = '[[exovault:s4-seed:v1]]';
const NATIVE_PREFIX = 'This session is being continued';
// Plugin installs prefix the server (mcp__plugin_<plugin>_recall__...; the server was exovault-recall before 4.0); the tool was `recall` before 3.20.
const RECALL_TOOL = /"name":"mcp__(?:plugin_[^"]*_)?(?:exovault-)?recall__(?:recall|search_session)"/;
const PRESSURE_HEADING = '## Compaction pressure';

function firstText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.find((part) => typeof part?.text === 'string')?.text ?? '';
  return '';
}

// One pass over a transcript. Only lines that can matter are parsed.
export async function scanTranscript(file) {
  const result = { cwd: null, entrypoint: null, first: null, last: null, compactions: [], recallCalls: 0, pressureNotes: 0 };
  let pending = null;
  const lines = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (RECALL_TOOL.test(line) && line.includes('"tool_use"')) result.recallCalls += 1;
    if (line.includes(PRESSURE_HEADING)) result.pressureNotes += 1;
    const wanted = pending || line.includes('"compact_boundary"') || result.cwd === null || line.includes('"timestamp"');
    if (!wanted) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.timestamp) {
      result.first ??= record.timestamp;
      result.last = record.timestamp;
    }
    if (result.cwd === null && record.cwd) {
      result.cwd = record.cwd;
      result.entrypoint = record.entrypoint ?? null;
    }
    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      const meta = record.compactMetadata ?? {};
      pending = {
        at: record.timestamp,
        trigger: meta.trigger ?? null,
        preTokens: meta.preTokens ?? null,
        postTokens: meta.postTokens ?? null,
        durationMs: meta.durationMs ?? null,
        kind: 'unknown',
      };
      result.compactions.push(pending);
      continue;
    }
    if (pending && record.type === 'user') {
      const text = firstText(record.message);
      if (text.startsWith(SEED_SENTINEL)) pending.kind = 's4';
      else if (record.isCompactSummary || text.startsWith(NATIVE_PREFIX)) pending.kind = 'native';
      pending = null;
    }
  }
  return result;
}

// Windows paths ignore case: a VS Code session records its cwd as c:\..., while HOME says C:\....
const pathKey = (dir, platform) => (platform === 'win32' ? dir.toLowerCase() : dir);

/** `file` with a leading `home` replaced by ~, ignoring case on Windows. */
function tildify(file, home, platform) {
  const rest = file.slice(home.length);
  return pathKey(file, platform).startsWith(pathKey(home, platform)) && /^([\\/]|$)/.test(rest) ? `~${rest}` : file;
}

function captureDirs(sessionId, cwd, home, platform) {
  const candidates = new Map();
  const add = (dir) => { const file = path.join(dir, '.exovault', 's4-capture', sessionId); if (!candidates.has(pathKey(file, platform))) candidates.set(pathKey(file, platform), file); };
  add(home);
  for (let dir = cwd; dir; dir = path.dirname(dir)) {
    add(dir);
    if (path.dirname(dir) === dir) break;
  }
  return [...candidates.values()].filter((dir) => fs.existsSync(dir));
}

const FALLBACK_LINE = /^(\S+) compact\.fallback=(\S+) origin=compact\b(?:.*\bsizeAfter=(\d+))?/;
const SIZE_BEFORE_LINE = /^\S+ compact\.sizeBefore=(\d+)/;

// 4.7.4: the `compact.fallback=<reason> origin=compact` lines the quiet notice policy records, across every capture dir,
// ordered by stamp (ISO strings, so string order is time order).
function fallbackLines(dirs) {
  const lines = [];
  for (const dir of dirs) {
    const file = path.join(dir, 'notices.log');
    if (!fs.existsSync(file)) continue;
    // 4.8.0: the message tokens S4 counted (the last compact.sizeBefore before the fallback) and, from 4.8.0 lines,
    // what its seed and tail would have left, so a too-short session shows why it fell back.
    let sizeBefore;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const size = SIZE_BEFORE_LINE.exec(line);
      if (size) sizeBefore = Number(size[1]);
      const match = FALLBACK_LINE.exec(line);
      if (!match) continue;
      lines.push({ at: match[1], reason: match[2], ...(sizeBefore !== undefined ? { sizeBefore } : {}), ...(match[3] ? { sizeAfter: Number(match[3]) } : {}) });
      sizeBefore = undefined;
    }
  }
  return lines.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// The last fallback line stamped after the previous compaction and not after this one.
function withReasons(compactions, lines) {
  return compactions.map((c, index) => {
    const previous = index > 0 ? compactions[index - 1].at : null;
    const match = lines.filter((line) => line.at <= c.at && (previous === null || line.at > previous)).at(-1);
    if (!match) return c;
    const { at: _at, ...fields } = match;
    return { ...c, ...fields };
  });
}

function lastCapture(dirs) {
  let latest = null;
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir)) {
      const mtime = fs.statSync(path.join(dir, name)).mtime;
      if (!latest || mtime > latest) latest = mtime;
    }
  }
  return latest;
}

/** The plugin's home chain (HOME, USERPROFILE, HOMEDRIVE+HOMEPATH); os.homedir() when none is set. */
const defaultHome = (env) => { const home = homeDir(env); return home === '.' ? os.homedir() : home; };

export async function collect({ env = process.env, home = defaultHome(env), days = 2, all = false, headless = false, now = Date.now(), platform = process.platform } = {}) {
  const root = claudeProjectsDir(env, home);
  const since = now - days * 86_400_000;
  const sessions = [];
  if (!fs.existsSync(root)) return sessions;
  for (const project of fs.readdirSync(root)) {
    const projectDir = path.join(root, project);
    if (!fs.statSync(projectDir).isDirectory()) continue;
    for (const name of fs.readdirSync(projectDir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(projectDir, name);
      if (fs.statSync(file).mtimeMs < since) continue;
      const id = name.slice(0, -'.jsonl'.length);
      const scan = await scanTranscript(file);
      const dirs = captureDirs(id, scan.cwd, home, platform);
      const subagents = { compactions: 0, s4: 0, pressureNotes: 0 };
      const subDir = path.join(projectDir, id, 'subagents');
      if (fs.existsSync(subDir)) {
        for (const sub of fs.readdirSync(subDir).filter((n) => n.endsWith('.jsonl'))) {
          const s = await scanTranscript(path.join(subDir, sub));
          subagents.compactions += s.compactions.length;
          subagents.s4 += s.compactions.filter((c) => c.kind === 's4').length;
          subagents.pressureNotes += s.pressureNotes;
        }
      }
      const s4 = dirs.length > 0;
      if (!s4 && !all) continue;
      if (!headless && scan.entrypoint && scan.entrypoint !== 'cli' && scan.entrypoint !== 'claude-vscode') continue;
      const compactions = withReasons(scan.compactions, fallbackLines(dirs));
      sessions.push({ id, ...scan, compactions, s4, captureDirs: dirs, lastCapture: lastCapture(dirs)?.toISOString() ?? null, subagents });
    }
  }
  return sessions.sort((a, b) => String(b.last).localeCompare(String(a.last)));
}

const hhmm = (iso) => (iso ? new Date(iso).toLocaleString('sv-SE', { hour12: false }).slice(5, 16) : '-');
const k = (n) => (typeof n === 'number' ? `${Math.round(n / 1000)}k` : '?');
// One decimal below 10k: a too-short session's 7510 message tokens would otherwise read as 8k.
const kk = (n) => (n < 10_000 ? `${(n / 1000).toFixed(1)}k` : k(n));

// Claude Code's preTokens include the system prompt and tools; S4 counts the messages only, so both are shown.
function reasonText(c) {
  if (!c.reason) return '';
  if (c.reason !== 'insufficient_reduction' || c.sizeBefore === undefined) return `  reason=${c.reason}`;
  const after = c.sizeAfter !== undefined ? ` -> ${kk(c.sizeAfter)}` : '';
  return `  reason=${c.reason} (S4: ${kk(c.sizeBefore)} message tokens${after}, under the 25% cut; too short a session, expected)`;
}
const secs = (ms) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s` : '?');

export function render(sessions, home = defaultHome(process.env), { all = false, headless = false, platform = process.platform } = {}) {
  if (sessions.length === 0) {
    const hints = [];
    if (!all) hints.push('--all to list every session');
    if (!headless) hints.push('--headless to include -p / SDK runs');
    hints.push('--days N to look further back');
    return `No ${all ? '' : 'S4 '}sessions in this window (use ${hints.join(', ')}).`;
  }
  const out = [];
  let s4Cuts = 0;
  let fallbacks = 0;
  let nativeInS4 = 0;
  for (const s of sessions) {
    // A native cut only counts as a fallback once S4 has cut this session at least once; before
    // that the session may simply not have loaded the plugin yet (started before the install).
    const firstS4 = s.compactions.findIndex((c) => c.kind === 's4');
    const cwd = tildify(s.cwd ?? '?', home, platform);
    const mode = s.s4 ? 'S4' : 'native';
    out.push(`${s.id.slice(0, 8)}  ${mode.padEnd(6)} ${cwd}  active ${hhmm(s.first)} -> ${hhmm(s.last)}${s.entrypoint && s.entrypoint !== 'cli' ? `  (${s.entrypoint})` : ''}`);
    if (s.s4) {
      const where = s.captureDirs.map((d) => tildify(d, home, platform)).join(', ');
      out.push(`          capture ${hhmm(s.lastCapture)} in ${where}${s.captureDirs.length > 1 ? '  WARN: split across dirs' : ''}`);
    }
    for (const [index, c] of s.compactions.entries()) {
      const fellBack = s.s4 && c.kind === 'native' && firstS4 !== -1 && index > firstS4;
      const reason = c.kind === 'native' ? reasonText(c) : '';
      const flag = `${reason}${fellBack ? '  <- S4 fell back to native' : ''}`;
      if (c.kind === 's4') s4Cuts += 1;
      if (fellBack) nativeInS4 += 1;
      // S4 declined this cut (notices.log gave a reason) or had cut before: either way native ran instead of S4.
      if (fellBack || (s.s4 && c.kind === 'native' && c.reason)) fallbacks += 1;
      out.push(`          compact ${hhmm(c.at)} ${c.kind.padEnd(7)} ${c.trigger ?? '?'}  ${k(c.preTokens)} -> ${k(c.postTokens)}  ${secs(c.durationMs)}${flag}`);
    }
    if (s.compactions.length === 0) out.push('          no compaction yet');
    const extras = [];
    if (s.recallCalls) extras.push(`recall used ${s.recallCalls}x`);
    if (s.subagents.compactions) extras.push(`subagent compactions ${s.subagents.compactions}`);
    if (s.subagents.pressureNotes) extras.push(`subagent brake notes ${s.subagents.pressureNotes}`);
    if (extras.length) out.push(`          ${extras.join(', ')}`);
  }
  out.push('');
  out.push(`S4 sessions: ${sessions.filter((s) => s.s4).length}, S4 compactions: ${s4Cuts}, native fallbacks: ${fallbacks} (${nativeInS4} after an S4 cut)`);
  return out.join('\n');
}

async function main(argv) {
  const daysAt = argv.indexOf('--days');
  const sessions = await collect({ days: daysAt >= 0 ? Number(argv[daysAt + 1]) : 2, all: argv.includes('--all'), headless: argv.includes('--headless') });
  process.stdout.write(`${argv.includes('--json') ? JSON.stringify(sessions, null, 2) : render(sessions, undefined, { all: argv.includes('--all'), headless: argv.includes('--headless') })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
