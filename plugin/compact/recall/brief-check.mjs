// 3.37.0 (CONTRACT S4zj): the brief check the plugin runs itself when the agent first tries to stop after a cut.
// Dry probes from real post-cut states (w17 cold run 4, 2026-10-02): 0 of 8 agents called search_session or opened
// the saved brief after the cut, though the seed told them to; the seed's checklist looked complete to them. Four
// exact strings the brief listed were then missing from the tests (r17, 31/33). So the plugin asks the questions:
// a few generic queries about the newest brief (files, tests, final checks, exact strings, what stays untouched),
// merged in rank order, then the most specific remaining lines (most code spans), up to a size cap, printed in
// brief order with their line numbers.
// usage: node brief-check.mjs <recallRoot> <sessionId> [maxChars]  -> JSON { brief, path, lines: [{ line, text }], text }
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { briefDir } from './brief.mjs';
import { briefLines, listBriefs, searchBriefs } from './brief-search.mjs';
import { QUERY, loadEmbedder, runtimeDir, runtimeReady, vectorFile } from './vectors.mjs';

export const CHECK_QUERIES = [
  'files to create or change: their names and size limits',
  'tests to write: test file names, how many tests and what they must contain',
  'final checks and commands to run before finishing',
  'exact strings, names and values that must appear',
  'what must not be changed: frozen files, rules and limits',
];
export const CHECK_MAX_CHARS = 9000;
/** A brief up to this size goes whole: a picked subset missed the line that mattered (w17 r4, D5). About 7.5k tokens. */
export const CHECK_FULL_MAX_CHARS = 30000;
const PER_QUERY = 25;
const FILL_MIN_SPANS = 2;
const codeSpans = (text) => (text.match(/`[^`\n]+`/g) ?? []).length;

/** The newest brief's lines that answer CHECK_QUERIES, best first per query, interleaved, capped, then in brief order. */
export function briefCheck(root, sessionId, { maxChars = CHECK_MAX_CHARS, fullMaxChars = CHECK_FULL_MAX_CHARS, queryVectors } = {}) {
  const briefs = listBriefs(root, sessionId);
  const newest = briefs.at(-1);
  if (!newest) return undefined;
  const lists = CHECK_QUERIES.map((query, i) => searchBriefs(root, sessionId, query, PER_QUERY, queryVectors?.[i] ? { queryVector: queryVectors[i] } : {})
    .hits.filter((hit) => hit.newest));
  // A hit is one part of a line; the check prints the whole item (a long line's later part names the strings the
  // gate wants), so it picks by line number and measures the cap on the full item.
  let items;
  try { items = new Map(briefLines(fs.readFileSync(newest.file, 'utf8')).map((item) => [item.line, item.body])); } catch { return undefined; }
  const all = [...items].map(([line, text]) => ({ line, text }));
  if (all.reduce((sum, item) => sum + item.text.length, 0) <= fullMaxChars) return render(newest, all, true);
  const picked = new Map();
  let used = 0;
  const take = (line, text) => {
    if (text === undefined || picked.has(line) || used + text.length > maxChars) return;
    picked.set(line, { line, text });
    used += text.length;
  };
  const hitLines = [];
  for (let rank = 0; rank < PER_QUERY; rank++) {
    for (const list of lists) {
      const hit = list[rank];
      if (hit) hitLines.push(Number(hit.filePath.slice(hit.filePath.lastIndexOf(':') + 1)));
    }
  }
  // Order: the questions' hits that name something exactly (a code span), then the most specific remaining lines
  // (most code spans: a requirement written under a heading of its own, r4 "Goal" D5, which no question finds),
  // then the questions' plain hits (an acceptance command list without backticks).
  for (const line of hitLines) if (codeSpans(items.get(line) ?? '') > 0) take(line, items.get(line));
  const fill = [...items].filter(([line]) => !picked.has(line)).map(([line, text]) => ({ line, text, spans: codeSpans(text) }))
    .filter((item) => item.spans >= FILL_MIN_SPANS).sort((a, b) => b.spans - a.spans || a.line - b.line);
  for (const { line, text } of fill) take(line, text);
  for (const line of hitLines) take(line, items.get(line));
  return render(newest, [...picked.values()].sort((a, b) => a.line - b.line), false);
}

const render = (brief, lines, whole) => ({ brief: brief.id, path: brief.path, whole, lines, text: lines.map((l) => `${l.line}: ${l.text}`).join('\n') });

async function main() {
  const [root, sessionId, maxChars] = process.argv.slice(2);
  let queryVectors;
  try {
    const runtime = runtimeDir(root);
    if (runtimeReady(runtime) && fs.statSync(vectorFile(briefDir(root, sessionId))).size > 0) {
      const embed = await loadEmbedder(runtime, { threads: 2 });
      queryVectors = await embed(CHECK_QUERIES.map((query) => QUERY + query));
    }
  } catch { queryVectors = undefined; }
  const found = briefCheck(root, sessionId, { ...(maxChars ? { maxChars: Number(maxChars) } : {}), queryVectors });
  process.stdout.write(JSON.stringify(found ?? null));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
