// 3.42.0 (CONTRACT S4zn, 3.43.1 S4zp): session push. After a cut the agent does not search for what the cut took away (w17: 0
// search_session calls in ~10 long runs), and a question about it is answered from the seed or not at all. So on a
// user prompt this searches the session index itself, line by line, and hands over the transcript lines a compaction
// removed that share a RARE term with the prompt (an id, a code, a name, a phrase used in at most SESSION_PUSH_RARE
// excerpts). Common words never fire it, and only the matching lines of an excerpt go in, not the excerpt.
// ContextBench-style offline replay (120 turns, 39 questions): answers shown for 20/20 notes and 9/10 keys at
// ~19 chars a plain turn; table state and counts are not a lookup and stay with the seed.
// usage: node session-push.mjs <recallRoot> <sessionId> <stateFile>  (stdin: JSON { prompt })
//        -> JSON { cuts, lines: [{ segment, text }], text } or null
// 4.8.2 (CONTRACT S5s): the recall MCP server answers the same request over a local socket (push-server.mjs), with
// the session index already prepared; the hook runs this script only when no server answers.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepare, search, terms } from './rank.mjs';
import { generationKey, readPublished } from './recall.mjs';
import { hash } from './shared.mjs';

export const SESSION_PUSH_RARE = 4;
export const SESSION_PUSH_MAX_CHARS = 1500;
export const SESSION_PUSH_MAX_QUERIES = 12;
const LINE_MAX = 300;
const PER_HIT = 3;
const norm = (line) => String(line).replace(/\s+/g, ' ').trim().toLowerCase();

const isId = (t) => /\d|[_./:@#-]/.test(t);
/** A query line passes when it has an identifier-like rare term, or two rare terms. */
const strong = (rare) => rare.some(isId) || rare.length >= 2;
/**
 * The terms a hit or line must share with the query: its most id-like rare terms when it has any, since they are
 * what the line asks about. Otherwise two plain rare words would do, and an earlier line with the same wording but
 * another id (a repeated question template, compacted away) would take the slot of the line with the asked-for id.
 */
const needed = (rare) => {
  // A digit or path/code punctuation marks an id more surely than a hyphen alone ("five-word", "cobalt-juniper").
  for (const tier of [(t) => /\d|[_./:@#]/.test(t), isId]) { const ids = rare.filter(tier); if (ids.length) return ids; }
  return rare;
};
const matches = (need, has) => (need.some(isId) ? need.some((t) => has.has(t)) : strong(need.filter((t) => has.has(t))));

/**
 * The compacted-away lines for a prompt, or undefined. `shown` holds keys of lines pushed since the last cut.
 * Only rows of earlier segments are searched: the rows after the newest cut are still in context.
 */
export function sessionPush(root, sessionId, prompt, { shown = [], rare: rareMax = SESSION_PUSH_RARE } = {}) {
  let published;
  const dir = path.join(root, hash(sessionId));
  try { published = readPublished(dir); } catch { return undefined; }
  const { manifest, rows } = published;
  const cuts = Number(manifest.compactions) || 0;
  if (!cuts || !rows.length) return undefined;
  // Session search's key, so a push and a search share one prepared index (rank.mjs keeps one per index).
  const prepared = prepare(rows, generationKey(dir, manifest.generation));
  const seen = new Set(shown), out = [];
  let chars = 0;
  const queries = String(prompt).split(/\n+/).map((l) => l.trim()).filter((l) => l.length > 12).slice(0, SESSION_PUSH_MAX_QUERIES);
  // An earlier copy of a line of this prompt (a question asked again after a cut) tells the agent nothing new.
  const own = new Set(String(prompt).split(/\n+/).map(norm).filter(Boolean));
  const useful = (raw, need) => { const lineTerms = new Set(terms(raw)); return need.some((t) => lineTerms.has(t)) && !own.has(norm(raw)); };
  for (const query of queries) {
    const rare = [...new Set(terms(query))].filter((t) => { const n = prepared.df.get(t) ?? 0; return n > 0 && n <= rareMax; });
    if (!strong(rare)) continue;
    const need = needed(rare);
    const hit = search(prepared, query, 20).hits.find((h) => Number.isInteger(h.segment) && h.segment < cuts && matches(need, prepared.docs[h.index].tf)
      && String(h.text).split('\n').some((raw) => useful(raw, need)));
    if (!hit) continue;
    let taken = 0;
    for (const raw of String(hit.text).split('\n')) {
      if (taken >= PER_HIT) break;
      if (!useful(raw, need)) continue;
      const text = raw.trim().slice(0, LINE_MAX);
      const key = hash(text).slice(0, 16);
      if (seen.has(key) || chars + text.length > SESSION_PUSH_MAX_CHARS) continue;
      seen.add(key); out.push({ segment: hit.segment, text, key }); chars += text.length; taken++;
    }
  }
  if (!out.length) return undefined;
  return { cuts, lines: out, text: out.map((l) => `[segment ${l.segment}] ${l.text}`).join('\n') };
}

function readState(file) { try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value && typeof value === 'object' ? value : {}; } catch { return {}; } }

/**
 * What one prompt gets, as the hook reads it (the CLI's stdout, or the recall server's answer, recall/push-server.mjs):
 * the found lines, or null. What was pushed is kept in `stateFile` and not repeated until the next cut, which takes it
 * out of context again. Past `deadline` (epoch ms; the hook has given up by then) the answer is null and nothing is
 * marked shown.
 */
export function pushForPrompt(root, sessionId, prompt, stateFile, rare = Number(process.env.EXO_SESSION_PUSH_RARE) || SESSION_PUSH_RARE, deadline = Infinity) {
  const state = stateFile ? readState(stateFile) : {};
  let found = sessionPush(root, sessionId, prompt, { rare });
  if (found && state.cuts === found.cuts && Array.isArray(state.shown)) found = sessionPush(root, sessionId, prompt, { rare, shown: state.shown });
  if (Date.now() > deadline) return null;
  if (found && stateFile) {
    const shown = state.cuts === found.cuts && Array.isArray(state.shown) ? state.shown : [];
    try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify({ cuts: found.cuts, shown: [...shown, ...found.lines.map((l) => l.key)] })); } catch {}
  }
  return found ?? null;
}

function main() {
  const [root, sessionId, stateFile] = process.argv.slice(2);
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.stdout.write('null'); return; }
  if (typeof input?.prompt !== 'string') { process.stdout.write('null'); return; }
  process.stdout.write(JSON.stringify(pushForPrompt(root, sessionId, input.prompt, stateFile)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
