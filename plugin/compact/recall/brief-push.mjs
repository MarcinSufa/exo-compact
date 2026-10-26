// 3.40.0 (CONTRACT S4zl): brief push. After a cut the agent does not search for what it has forgotten: 0 of ~10
// long w17 runs called search_session, and r17 shipped tests without three strings its saved brief listed. Memory
// plugins that work (supermemory 74d0ed0, claude-engram, claude-mem) search in the hook and hand the result over
// with the call, so this does the same: before a post-cut write it finds the newest brief's lines for the files
// being written (a line that names the file, then the best ranked lines for the file's name words and the names,
// selectors and strings in the new text) and returns the ones not shown before; on a user prompt it does the same
// for the prompt's text. The hook (compact.ts) hands them to the model as additionalContext.
// usage: node brief-push.mjs <recallRoot> <sessionId> <stateFile>  (stdin: JSON { files, text } or { prompt })
//        -> JSON { brief, path, lines: [{ line, text }], text } or null
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { briefDir } from './brief.mjs';
import { briefLines, listBriefs, searchBriefs } from './brief-search.mjs';
import { QUERY, loadEmbedder, runtimeDir, runtimeReady, vectorFile } from './vectors.mjs';

export const PUSH_MAX_CHARS = 8000;
export const PUSH_MAX_LINES = 14;
export const PUSH_RANKED = 4;
const QUERY_TERMS = 40;
const PROMPT_MIN_CHARS = 12;

const NAMES_FILE = /[\w-]+\.(?:tsx?|jsx?|mjs|cjs|css|json|md|ya?ml|sh|py|html)\b/;
const STEM_SKIP = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'css', 'json', 'md', 'src', 'test', 'spec']);

/** What a write is about: its files' names and name words, and the names, selectors and short strings in its text. */
export function pushQuery({ files = [], text = '', prompt } = {}) {
  if (typeof prompt === 'string') return prompt.replace(/\s+/g, ' ').trim().slice(0, 600);
  const bases = [...new Set(files.map((file) => path.basename(String(file))).filter(Boolean))];
  const words = bases.flatMap((base) => base.split(/[-_.]+/)).filter((w) => w.length > 1 && !STEM_SKIP.has(w.toLowerCase()));
  const body = String(text);
  const names = body.match(/\b(?:const|let|function|class|interface|type|describe|it)\s*\(?\s*["'`]?([A-Za-z_$][\w$]*)/g)?.map((m) => m.match(/([A-Za-z_$][\w$]*)$/)[1]) ?? [];
  const selectors = body.match(/(?:^|\s)\.[a-z][\w-]*(?:\s+\.[a-z][\w-]*)*/gm)?.map((s) => s.trim()) ?? [];
  const strings = body.match(/["'`]([^"'`\n]{3,40})["'`]/g)?.map((s) => s.slice(1, -1)).filter((s) => /[A-Za-z]/.test(s) && !s.includes('/')) ?? [];
  const terms = [...new Set([...bases, ...words, ...names, ...selectors, ...strings])];
  return terms.slice(0, QUERY_TERMS).join(' ');
}

// A line-length limit as briefs state it: "no line over 160 characters", "lines of at most 120 chars".
const LINE_LIMIT = /\b(?:no|any)\s+lines?\s+(?:is\s+)?(?:over|longer than|above|exceeding|more than)\s+(\d{2,4})\s+(?:characters|chars)\b|\blines?\s+(?:of\s+)?at\s+most\s+(\d{2,4})\s+(?:characters|chars)\b/i;
const LIMIT_FILES = 6;

/** The line-length limits a brief states: [{ line (brief line), max }], one per distinct max. */
export function briefLineLimits(raw) {
  const out = [];
  String(raw).replace(/\r/g, '').split('\n').forEach((text, i) => {
    const m = text.match(LINE_LIMIT);
    const max = m ? Number(m[1] ?? m[2]) : 0;
    if (max && !out.some((l) => l.max === max)) out.push({ line: i + 1, max });
  });
  return out;
}

/** Added lines per changed file ({ file, lines: [{ n, text }], before: longest line at HEAD }): `git diff -U0 HEAD` hunks, an untracked file whole. */
export function addedLines(cwd, files) {
  // Porcelain paths are the repo root's, so everything below runs there, whatever directory the session is in.
  const repo = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const git = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 3000, maxBuffer: 8 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
  const status = git(['status', '--porcelain', '-uall', '--no-renames']).split('\n').filter(Boolean).map((l) => ({ code: l.slice(0, 2), file: l.slice(3) }));
  const wanted = files.map((f) => String(f).replace(/^(?:\.\.?\/)+/, '')).filter(Boolean);
  const out = [];
  for (const { code, file } of status) {
    if (out.length >= LIMIT_FILES || code.includes('D') || !wanted.some((w) => file === w || file.endsWith(`/${w}`) || w.endsWith(`/${file}`))) continue;
    if (code === '??') {
      let text = '';
      try { text = fs.readFileSync(path.join(repo, file), 'utf8'); } catch { continue; }
      if (text.includes('\0')) continue;
      out.push({ file, lines: text.split('\n').map((t, i) => ({ n: i + 1, text: t })) });
      continue;
    }
    // A tracked file that already had lines over the limit keeps its own style (w17 r17: memory-vault.css holds one
    // rule a line, 17 of them over 160 before the task): `before` is its longest line at HEAD.
    let before = 0;
    try { before = Math.max(0, ...git(['show', `HEAD:${file}`]).split('\n').map((l) => l.length)); } catch {}
    const lines = [];
    let n = 0;
    for (const l of git(['diff', '-U0', 'HEAD', '--', file]).split('\n')) {
      const hunk = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (hunk) { n = Number(hunk[1]); continue; }
      if (l.startsWith('+') && !l.startsWith('+++')) lines.push({ n: n++, text: l.slice(1) });
    }
    out.push({ file, lines, before });
  }
  return out;
}

/**
 * The brief's line-length limits that the lines this call added break, one sentence per file, or [] (also with no
 * brief, no limit, no repo). Run after a write: the model breaks a limit it has been shown (w17 r17, 161 > 160).
 */
export function limitWarnings(root, sessionId, repo, files) {
  const newest = listBriefs(root, sessionId).at(-1);
  if (!newest) return [];
  let limits;
  try { limits = briefLineLimits(fs.readFileSync(newest.file, 'utf8')); } catch { return []; }
  if (!limits.length) return [];
  const max = Math.min(...limits.map((l) => l.max));
  const ruleLine = limits.find((l) => l.max === max).line;
  let changed;
  try { changed = addedLines(repo, files); } catch { return []; }
  return changed.flatMap(({ file, lines, before = 0 }) => {
    if (before > max) return [];
    const over = lines.filter((l) => l.text.length > max);
    if (!over.length) return [];
    const shown = over.slice(0, 4).map((l) => `${l.n} (${l.text.length})`).join(', ');
    return [`${file}: ${over.length} added line${over.length > 1 ? 's' : ''} over ${max} characters, the brief's limit (${newest.path} line ${ruleLine}): line ${shown}${over.length > 4 ? ', ...' : ''}.`];
  });
}

/**
 * The newest brief's lines for a write ({ files, text }) or a prompt ({ prompt }), skipping `shown` line numbers:
 * lines that name a written file first, then ranked hits, whole items, capped, in brief order.
 */
export function briefPush(root, sessionId, input, { shown = [], maxChars = PUSH_MAX_CHARS, maxLines = PUSH_MAX_LINES, ranked = PUSH_RANKED, queryVector, upTo } = {}) {
  let briefs = listBriefs(root, sessionId);
  if (upTo) briefs = briefs.slice(0, briefs.findIndex((b) => b.id === upTo) + 1);
  const newest = briefs.at(-1);
  if (!newest) return undefined;
  const query = pushQuery(input);
  if (!query || (typeof input.prompt === 'string' && query.length < PROMPT_MIN_CHARS)) return undefined;
  let raw;
  try { raw = fs.readFileSync(newest.file, 'utf8'); } catch { return undefined; }
  // Paragraph number of each line: a file's requirement is its line plus the lines under it up to a blank line,
  // a heading or a line naming another file (w17 r12: the strings to pin sit two lines below the test's name).
  const para = [];
  raw.replace(/\r/g, '').split('\n').forEach((line, i) => { para[i + 1] = (para[i] ?? 0) + (line.trim() && !/^#{1,6}\s/.test(line) ? 0 : 1); });
  const items = briefLines(raw).filter((item) => !/^#{1,6}\s/.test(item.body));
  const byLine = new Map(items.map((item) => [item.line, item.body]));
  const skip = new Set(shown.map(Number));
  const picked = new Map();
  let used = 0;
  // `via`: 'file' for a line that names a written file (or sits under one), 'ranked' for a ranker hit.
  const take = (line, via) => {
    const text = byLine.get(line);
    if (text === undefined || skip.has(line) || picked.has(line) || picked.size >= maxLines || used + text.length > maxChars) return;
    picked.set(line, { line, text, via });
    used += text.length;
  };
  // A line that names the file being written is that file's requirement, whatever the ranker thinks of it.
  const bases = [...new Set((input.files ?? []).map((file) => path.basename(String(file))).filter((base) => base.length > 3))];
  items.forEach((item, i) => {
    if (!bases.some((base) => item.body.includes(base))) return;
    take(item.line, 'file');
    for (let j = i + 1; j < items.length && para[items[j].line] === para[item.line] && !NAMES_FILE.test(items[j].body); j++) take(items[j].line, 'file');
  });
  const found = searchBriefs(root, sessionId, query, ranked * 3, { ...(queryVector ? { queryVector } : {}), ...(upTo ? { upTo } : {}) });
  let rankedTaken = 0;
  for (const hit of found.hits) {
    if (!hit.newest || rankedTaken >= ranked) continue;
    const line = Number(hit.filePath.slice(hit.filePath.lastIndexOf(':') + 1));
    const before = picked.size;
    take(line, 'ranked');
    if (picked.size > before) rankedTaken++;
  }
  if (!picked.size) return undefined;
  const lines = [...picked.values()].sort((a, b) => a.line - b.line);
  return { brief: newest.id, path: newest.path, query, lines, text: lines.map((l) => `${l.line}: ${l.text}`).join('\n') };
}

function readState(file) { try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value && typeof value === 'object' ? value : {}; } catch { return {}; } }

async function main() {
  if (process.argv[2] === 'limits') {
    // usage: node brief-push.mjs limits <recallRoot> <sessionId> <repo>  (stdin: JSON { files }) -> JSON [sentence]
    const [, root, sessionId, repo] = process.argv.slice(2);
    let files = [];
    try { files = JSON.parse(fs.readFileSync(0, 'utf8')).files ?? []; } catch {}
    process.stdout.write(JSON.stringify(limitWarnings(root, sessionId, repo, files)));
    return;
  }
  const [root, sessionId, stateFile] = process.argv.slice(2);
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.stdout.write('null'); return; }
  const state = stateFile ? readState(stateFile) : {};
  const newest = listBriefs(root, sessionId).at(-1);
  // Lines already shown for this brief are not repeated; a new brief starts a new list.
  const shown = newest && state.brief === newest.id && Array.isArray(state.shown) ? state.shown : [];
  let queryVector;
  try {
    const runtime = runtimeDir(root);
    if (process.env.EXO_BRIEF_PUSH_VECTORS === '1' && runtimeReady(runtime) && fs.statSync(vectorFile(briefDir(root, sessionId))).size > 0) {
      const embed = await loadEmbedder(runtime, { threads: 1 });
      [queryVector] = await embed([QUERY + pushQuery(input)]);
    }
  } catch { queryVector = undefined; }
  const found = briefPush(root, sessionId, input, { shown, queryVector });
  if (found && stateFile) {
    try { fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile, JSON.stringify({ brief: found.brief, shown: [...shown, ...found.lines.map((l) => l.line)] }), { mode: 0o600 }); } catch {}
  }
  process.stdout.write(JSON.stringify(found ?? null));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
