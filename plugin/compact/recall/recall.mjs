#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { clean, contentTerms, hash } from './shared.mjs';
import { recallRootDir } from './paths.mjs';
import { neighbours, prepare, search } from './rank.mjs';
import { nearest, readVectors, vectorFile } from './vectors.mjs';

/** `queryVector` (optional): the query's embedding, fused as a dense list over the chunks that have vectors. */
/** `segment` (optional): search only the excerpts written after that many compactions (0 = before the first). */
export function recallSession(root, sessionId, query, k = 5, currentCutoff = Infinity, { queryVector, segment } = {}) {
  return recallGeneration(path.join(root, hash(sessionId)), query, Math.max(1, Math.min(5, k)), currentCutoff, queryVector, segment);
}

/** Whether the session has any chunk vectors yet (the caller then embeds the query). */
export function sessionHasVectors(root, sessionId) {
  try { return fs.statSync(vectorFile(path.join(root, hash(sessionId)))).size > 0; } catch { return false; }
}

/** The chunk a `ref` from an earlier hit names, plus its linked chunks (ExoVault-style 1-hop navigation). */
export function recallAround(root, sessionId, ref, k = 5, currentCutoff = Infinity) {
  return aroundGeneration(path.join(root, hash(sessionId)), ref, Math.max(1, Math.min(5, k)), currentCutoff);
}

export function transcriptFallback(file, query, k = 5, cutoff = Infinity) { return fallback(file, query, Math.max(1, Math.min(5, k)), cutoff); }

function main() {
  const [query, ...args] = process.argv.slice(2);
  if (!query || query === '--help') {
    process.stdout.write('Usage: node recall.mjs "query" [--session ID] [--transcript PATH] [--k 1..5] [--root PATH]\n');
    process.exit(query ? 0 : 2);
  }
  const opts = Object.fromEntries(args.reduce((pairs, arg, i) => {
    if (arg.startsWith('--') && args[i + 1] && !args[i + 1].startsWith('--')) pairs.push([arg.slice(2), args[i + 1]]);
    return pairs;
  }, []));
  const sessionId = opts.session ?? process.env.CLAUDE_SESSION_ID ?? '';
  const root = opts.root ?? recallRootDir();
  const k = Math.max(1, Math.min(5, Number(opts.k ?? 5) || 5));
  const currentCutoff = opts.transcript ? safeSize(opts.transcript) : Infinity;
  let result;
  if (sessionId) result = recallSession(root, sessionId, query, k, currentCutoff);
  if (!result && opts.transcript) result = transcriptFallback(opts.transcript, query, k);
  if (!result) result = { source: 'no-index', message: 'No published recall index is available. Use the current transcript pointer as fallback.', hits: [] };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

// Prepared-cache keys (rank.mjs): `<store>#<generation>`, so a new generation replaces the entry of the same store.
export const generationKey = (dir, generation) => `${dir}#${generation}`;
export const segmentKey = (dir, segment, generation) => `${dir}#s${segment}#${generation}`;

// The last parsed generation per index dir, so a search does not parse records.json again (~130 ms at 18k chunks).
// The prepared cache (rank.mjs) holds these same rows, so this costs no extra memory.
const published = new Map();
const PUBLISHED_DIRS = 8;
export function readPublished(dir) {
  const current = Number(fs.readFileSync(path.join(dir, 'CURRENT'), 'utf8').trim());
  const gen = path.join(dir, `generation-${String(current).padStart(8, '0')}`);
  const records = path.join(gen, 'records.json');
  const stat = fs.statSync(records);
  const version = `${current}:${stat.size}:${stat.mtimeMs}`;
  const hit = published.get(dir);
  if (hit?.version === version) { published.delete(dir); published.set(dir, hit); return hit.value; }
  published.delete(dir);
  const manifest = JSON.parse(fs.readFileSync(path.join(gen, 'manifest.json'), 'utf8'));
  const rows = JSON.parse(fs.readFileSync(records, 'utf8'));
  if (!Array.isArray(rows) || rows.length !== manifest.chunkCount || !Number.isFinite(manifest.cutoffPosition)) throw new Error('corrupt generation');
  const value = { manifest, rows };
  published.set(dir, { version, value });
  if (published.size > PUBLISHED_DIRS) published.delete(published.keys().next().value);
  return value;
}
function safeSize(file) { try { return fs.statSync(file).size; } catch { return -1; } }
function recallGeneration(dir, text, limit, currentCutoff = Infinity, queryVector, segment) {
  const found = candidatesIn(dir, text, limit, currentCutoff, queryVector, segment);
  return found && finishRecall(found);
}
function candidatesIn(dir, text, limit, currentCutoff = Infinity, queryVector, segment) {
  try {
    const { manifest, rows } = readPublished(dir);
    if (manifest.cutoffPosition > currentCutoff) throw new Error('generation cutoff is in the future');
    const prepared = prepare(rows, generationKey(dir, manifest.generation));
    // A segment filter ranks only that segment's rows; hits keep their whole-index refs and links.
    const filtered = Number.isInteger(segment);
    const indices = filtered ? rows.map((row, i) => (row.segment === segment ? i : -1)).filter((i) => i >= 0) : undefined;
    if (filtered && !indices.length) {
      const last = rows.reduce((m, row) => Math.max(m, Number.isInteger(row.segment) ? row.segment : -1), -1);
      return { docs: [], missing: [], note: last < 0 ? 'This index has no segment numbers yet; search without segment.' : `Segment ${segment} has no excerpts; this session has segments 0 to ${last}.` };
    }
    const scope = filtered ? indices.map((i) => rows[i]) : rows;
    const ranked = filtered ? prepare(scope, segmentKey(dir, segment, manifest.generation)) : prepared;
    const vectors = queryVector ? readVectors(vectorFile(dir)) : undefined;
    const dense = vectors?.size ? nearest(scope, vectors, queryVector) : undefined;
    const found = search(ranked, text, limit, undefined, dense?.list);
    const docs = found.hits.map((doc) => ({ ...withLinks(prepared, manifest.generation, filtered ? indices[doc.index] : doc.index), matched: doc.matched }));
    return { docs, missing: found.missing, ...(dense ? { vectors: `${dense.covered}/${scope.length}` } : {}) };
  } catch { return undefined; }
}

/** Up to `limit` uncapped candidates in search order, for a reranker; undefined when no index is usable. */
export function recallCandidates(root, sessionId, query, limit = 20, currentCutoff = Infinity, { queryVector, segment } = {}) {
  return candidatesIn(path.join(root, hash(sessionId)), query, Math.max(1, Math.min(50, limit)), currentCutoff, queryVector, segment);
}

/** The reply for `found` (from recallCandidates), keeping the docs at `order` (default: search order) up to `k`. */
export function finishRecall(found, order, k = found.docs.length, extra = {}) {
  // The same text logged twice (a summary repeated, a status file printed again with a line appended) would take
  // two of the few slots: an excerpt whose first 300 characters match a better-ranked one is skipped.
  const seen = new Set(), docs = [];
  for (const i of order ?? found.docs.map((_, j) => j)) {
    const key = found.docs[i].text.trim().replace(/\s+/g, ' ').slice(0, 300);
    if (seen.has(key)) continue;
    seen.add(key); docs.push(found.docs[i]);
    if (docs.length >= k) break;
  }
  const hits = capPayload(docs, 750);
  return {
    source: 'session-index',
    ...(found.vectors ? { vectors: found.vectors } : {}),
    ...extra,
    ...(found.note ? { note: found.note } : {}),
    // An exact value nobody wrote earlier in the session: say so, so the caller stops searching instead of guessing.
    ...(found.missing.length ? { notFound: found.missing, note: `Nothing earlier in this session contains ${found.missing.map((x) => JSON.stringify(x)).join(', ')}.${hits.length ? ' The hits below match only other words of the query.' : ''}` } : {}),
    hits,
  };
}
function aroundGeneration(dir, ref, limit, currentCutoff) {
  const m = /^g(\d+):(\d+)$/.exec(String(ref).trim());
  if (!m) throw new Error('ref must look like g3:120, as returned in a hit');
  const { manifest, rows } = readPublished(dir);
  if (manifest.cutoffPosition > currentCutoff) throw new Error('generation cutoff is in the future');
  const index = Number(m[2]);
  // The index is refreshed after every answer, so a ref is often a generation or two old. Rows are append-only,
  // so the same index names the same chunk while that older generation is still on disk to prove it.
  if (Number(m[1]) !== manifest.generation && !sameRow(dir, Number(m[1]), index, rows)) throw new Error(`ref ${ref} is from an older index (now generation ${manifest.generation}); search again`);
  if (!rows[index]) throw new Error(`ref ${ref} does not exist`);
  const prepared = prepare(rows, generationKey(dir, manifest.generation));
  const order = { output: 0, command: 0, part: 1, prev: 2, next: 2 };
  const linked = [...neighbours(prepared, index)].map(([j, rel]) => [j, relation(rows, index, j, rel)])
    .sort((a, b) => order[a[1]] - order[b[1]] || rows[a[0]].position - rows[b[0]].position).slice(0, limit - 1);
  const docs = [[index, 'self'], ...linked].map(([j, rel]) => ({ ...withLinks(prepared, manifest.generation, j), relation: rel }));
  return { source: 'session-index', around: ref, hits: capPayload(docs, 750) };
}
function sameRow(dir, generation, index, rows) {
  try {
    const old = JSON.parse(fs.readFileSync(path.join(dir, `generation-${String(generation).padStart(8, '0')}`, 'records.json'), 'utf8'));
    return Boolean(old[index] && rows[index] && old[index].sourceId === rows[index].sourceId);
  } catch { return false; }
}
function relation(rows, from, to, rel) {
  if (rel === 'call') return String(rows[from].tool).endsWith(':call') ? 'output' : 'command';
  if (rel === 'message') return 'part';
  return rows[to].position < rows[from].position ? 'prev' : 'next';
}
function withLinks(prepared, generation, index) {
  const links = {};
  for (const [j, rel] of neighbours(prepared, index)) {
    const name = relation(prepared.rows, index, j, rel);
    if (!links[name]) links[name] = `g${generation}:${j}`;
  }
  return { ...prepared.rows[index], ref: `g${generation}:${index}`, links };
}
function fallback(file, queryText, limit, cutoff = Infinity) {
  try {
    const queryTerms = new Set(contentTerms(queryText));
    const source = fs.readFileSync(file);
    const lines = source.subarray(0, Number.isFinite(cutoff) ? Math.min(source.length, cutoff) : source.length).toString('utf8').split('\n');
    let turn = 0; const candidates = [];
    for (let i = 0; i < lines.length; i++) {
      let event; try { event = JSON.parse(lines[i]); } catch { continue; }
      if (!['user', 'assistant'].includes(event.type)) continue;
      const role = event.message?.role ?? event.type;
      if (role === 'user') turn++;
      const text = clean(blocks(event.message?.content));
      const terms = contentTerms(text); const overlap = terms.filter((term) => queryTerms.has(term)).length;
      if (!overlap) continue;
      candidates.push({ sourceId: hash(`${i}\0${role}\0${text}`), position: i, turn, role, tool: '', filePath: '', text: text.slice(0, 1800), score: overlap });
    }
    candidates.sort((a, b) => b.score - a.score || b.position - a.position);
    return { source: 'bounded-transcript-fallback', message: 'No valid index; these excerpts were searched directly from the current transcript.', hits: capPayload(candidates.slice(0, limit), 750) };
  } catch { return undefined; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
function blocks(content) {
  if (typeof content === 'string') return content;
  return (content ?? []).map((b) => b?.type === 'text' ? b.text ?? '' : b?.type === 'tool_result' ? (typeof b.content === 'string' ? b.content : (b.content ?? []).map((x) => x.text ?? '').join('\n')) : '').filter(Boolean).join('\n');
}
function capPayload(rows, tokens) {
  const out = []; let used = 0;
  for (const row of rows) {
    const overhead = 24, budget = Math.max(0, tokens - used - overhead);
    if (budget <= 0) break;
    const text = row.text.slice(0, budget * 4);
    const cost = Math.ceil(text.length / 4) + overhead;
    out.push({
      ...(row.ref ? { ref: row.ref } : {}), ...(row.relation ? { relation: row.relation } : {}),
      // Only what the agent uses: hashes, session ids and byte positions were 17% of every reply (3.26.0).
      turn: row.turn, ...(Number.isInteger(row.segment) ? { segment: row.segment } : {}), role: row.role, ...(row.tool ? { tool: row.tool } : {}), ...(row.filePath ? { filePath: row.filePath } : {}),
      ...(row.matched?.length ? { matched: row.matched } : {}), text,
      ...(row.links && Object.keys(row.links).length ? { links: row.links } : {}),
    });
    used += cost;
  }
  return out;
}
