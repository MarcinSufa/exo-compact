// 3.36.0 (CONTRACT S4zi): the saved task briefs (brief.mjs) searched line by line through search_session.
// Live runs (w17, 2026-10-02): after a cut in the middle of a task the agent grepped the brief file for a word it
// guessed and missed the line it needed (a test file name), and never called search_session, which did not
// search the briefs. Here every line of every saved brief is one excerpt, prefixed with the brief's first words
// and its section heading, ranked by the same hybrid ranker (rank.mjs). Hits name `<file>:<line>` so the agent
// reads only that part. The newest brief wins ties: it is the task in progress.
import fs from 'node:fs';
import path from 'node:path';
import { chunk } from './shared.mjs';
import { OPTS, prepare, search } from './rank.mjs';
import { briefDir } from './brief.mjs';
import { PASSAGE, appendVectors, nearest, readVectors, storedKeys, textKey, vectorFile } from './vectors.mjs';

const MAX_UNIT_CHARS = 900;
export const NEWEST_BONUS = 0.15;

/** The saved briefs of a session, oldest first: [{ id, path, file, firstLine }], `file` being the local copy. */
export function listBriefs(root, sessionId) {
  const dir = briefDir(root, sessionId);
  let index;
  try { index = JSON.parse(fs.readFileSync(path.join(dir, 'briefs.json'), 'utf8')); } catch { return []; }
  if (!Array.isArray(index)) return [];
  return index.filter((entry) => entry && typeof entry.id === 'string' && /^[0-9a-f]{12}$/.test(entry.id))
    .map((entry) => ({ id: entry.id, path: typeof entry.path === 'string' ? entry.path : path.join(dir, `${entry.id}.md`), file: path.join(dir, `${entry.id}.md`), firstLine: String(entry.firstLine ?? '') }))
    .filter((entry) => fs.existsSync(entry.file));
}

const label = (firstLine) => {
  const words = firstLine.replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' ');
  return words.replace(/[.:,;]+$/, '');
};

/** The brief's items, unsplit: one per non-empty line, indented continuation lines joined, with their heading. */
export function briefLines(text) {
  const units = [];
  let heading = '', current;
  const lines = String(text).replace(/\r/g, '').split('\n');
  const flush = () => { if (current) units.push(current); current = undefined; };
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); return; }
    if (/^#{1,6}\s/.test(line)) { flush(); heading = line.replace(/^#+\s*/, '').trim(); units.push({ line: i + 1, body: line.trim(), heading: '' }); return; }
    if (current && /^\s{2,}\S/.test(raw) && !/^\s*([-*]|\d+[.)])\s/.test(raw)) { current.body += `\n${line.trim()}`; return; }
    flush();
    current = { line: i + 1, body: line.trim(), heading };
  });
  flush();
  return units;
}

/**
 * One excerpt per non-empty line (a line over MAX_UNIT_CHARS split at sentences), indented continuation lines
 * joined to the line above. Each carries `[<brief label> | <heading>]` so a hit says which task and section it is.
 */
export function briefUnits(text, briefLabel = '') {
  const units = briefLines(text);
  return units.flatMap((unit) => {
    const prefix = `[${[briefLabel, unit.heading].filter(Boolean).join(' | ')}] `;
    const parts = unit.body.length > MAX_UNIT_CHARS ? chunk(unit.body, MAX_UNIT_CHARS) : [unit.body];
    // A later part of a split line keeps the line's start (a bullet's file name or item), so it is found by it too.
    const lead = parts.length > 1 ? `${unit.body.slice(0, 80).replace(/\s+\S*$/, '')} … ` : '';
    return parts.map((part, n) => ({ line: unit.line, text: `${prefix === '[] ' ? '' : prefix}${n ? lead : ''}${part}` }));
  });
}

const statKey = (briefs) => briefs.map((b) => { try { return `${b.id}:${fs.statSync(b.file).size}`; } catch { return b.id; } }).join(',');

/** Rows for rank.mjs: position grows with the brief's age rank and its line, so the newest brief is the most recent. */
export function briefRows(briefs) {
  const rows = [];
  briefs.forEach((brief, b) => {
    let text;
    try { text = fs.readFileSync(brief.file, 'utf8'); } catch { return; }
    const newest = b === briefs.length - 1;
    for (const unit of briefUnits(text, label(brief.firstLine))) {
      rows.push({ position: (b + 1) * 1e6 + unit.line, segment: b, turn: undefined, role: 'user', tool: 'brief', filePath: `${brief.path}:${unit.line}`, text: unit.text, brief: brief.id, ...(newest ? { newest: true } : {}) });
    }
  });
  return rows;
}

/** Embeds the brief lines that have no vector yet (`embed`: texts -> unit Float32Arrays); returns how many. */
export async function embedBriefs(root, sessionId, embed, batch = 32) {
  const briefs = listBriefs(root, sessionId);
  if (!briefs.length) return 0;
  const file = vectorFile(briefDir(root, sessionId)), have = storedKeys(file), todo = new Map();
  for (const row of briefRows(briefs)) { const key = textKey(row.text); if (!have.has(key)) todo.set(key, row.text); }
  const entries = [...todo];
  for (let i = 0; i < entries.length; i += batch) {
    const part = entries.slice(i, i + batch);
    const vectors = await embed(part.map(([, text]) => PASSAGE + text));
    appendVectors(file, part.map(([key], j) => ({ key, vector: vectors[j] })));
  }
  return entries.length;
}

/**
 * Ranked brief excerpts for `query`: { hits, missing, briefs }; hits carry `filePath` as `<file>:<line>`.
 * With `queryVector` the lines embedded by embedBriefs are also ranked by cosine (fused like the session search).
 */
export function searchBriefs(root, sessionId, query, limit = 5, { queryVector, upTo } = {}) {
  let briefs = listBriefs(root, sessionId);
  if (upTo) briefs = briefs.slice(0, briefs.findIndex((b) => b.id === upTo) + 1);
  if (!briefs.length) return { hits: [], missing: [], briefs: 0 };
  const rows = briefRows(briefs);
  const prepared = prepare(rows, `briefs#${briefDir(root, sessionId)}#${statKey(briefs)}`);
  const vectors = queryVector ? readVectors(vectorFile(briefDir(root, sessionId))) : undefined;
  const dense = vectors?.size ? nearest(rows, vectors, queryVector) : undefined;
  // The newest brief is the task in progress: its lines get NEWEST_BONUS (rank.mjs `latest`, by segment = brief order).
  const found = search(prepared, query, limit * 3, { ...OPTS, latest: NEWEST_BONUS }, dense?.list);
  // Parts of one split line are one requirement: the best part stands for its line.
  const seen = new Set(), hits = [];
  for (const hit of found.hits) { if (seen.has(hit.filePath)) continue; seen.add(hit.filePath); hits.push(hit); if (hits.length >= limit) break; }
  return { hits, missing: found.missing, briefs: briefs.length, ...(dense ? { vectors: `${dense.covered}/${rows.length}` } : {}) };
}
