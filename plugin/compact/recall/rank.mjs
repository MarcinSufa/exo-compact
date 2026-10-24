// Hybrid lexical ranking for session recall, in plain JS (no native deps, works offline on any OS).
// Ranked lists fused with reciprocal rank fusion, following ExoVault search (k 60, top-rank bonus):
//   bm25      - Okapi BM25 over content terms;
//   exact     - identifier-like query tokens (numbers, versions, paths, ids, CamelCase) found verbatim as substrings
//               (so a hash prefix finds the full hash), numbers of 6+ digits whatever their separators, and quoted
//               phrases; weighted by how rare the needle is. Scanned over every chunk, not only BM25 hits;
//   proximity - how tightly the matched query terms sit together in the chunk (cover density);
//   dense     - optional: chunks nearest to the query embedding, computed by the caller (`denseList`, see
//               vectors.mjs), so this module stays dependency-free; used only when a caller passes one;
//   graph     - neighbours of the best hits: the other half of a tool call/result pair, other chunks of the same
//               message, the previous and next message (ExoVault's 1-hop expansion, max edge weight per node).
// Then a coverage boost (share of distinct query terms present), a small recency boost (newer value beats a stale
// one) and near-duplicate suppression so the hits are different pieces of evidence.

const STOP = new Set((
  'a an and are as at be because but by can could did do does for from had has have how i if in into is it its ' +
  'me my no not of on or our over so than that the their then there these they this to was we were what when where ' +
  'which who why will with would you your ' +
  // Polish cues: the plugin also reads messages written in Polish.
  'a aby albo ale bo by być czy dla do go ich ja jak jako je jej jest jeszcze już ma mam może mnie mi na nad nam nas ' +
  'nie niż o od po pod przez przy się są ta tak tam te tego tej ten to tu tylko w we więc z za ze że żeby co'
).split(' '));
const TERM = /[\p{L}\p{N}][\p{L}\p{N}_.:/@+#-]*/gu;
const RRF_K = 60;
const DEFAULTS = { parts: 1, bm25: 1, exact: 1.2, proximity: 0.8, dense: 2, graph: 0, seeds: 5, coverage: 0.35, recency: 0.04, latest: 0 };
const EDGE = { call: 0.9, message: 0.8, adjacent: 0.6 };
// Replay-only override for ablations, e.g. EXO_RECALL_RANK='{"graph":0}'.
export const OPTS = (() => { try { return { ...DEFAULTS, ...JSON.parse(process.env.EXO_RECALL_RANK || '{}') }; } catch { return DEFAULTS; } })();

export function terms(text) {
  const out = [];
  for (const raw of String(text).toLowerCase().match(TERM) ?? []) {
    const t = raw.replace(/[.:]+$/, '');
    if (t.length > 1 && !STOP.has(t)) out.push(t);
    // A compound (`r17-host-inbox.test.tsx`, `memory_learned`, `src/ui/x`) also counts as its parts, so a plain
    // question ("host inbox test") finds it; the whole token still matches exactly.
    if (OPTS.parts && /[-_./:@+#]/.test(t)) for (const part of t.split(/[-_./:@+#]+/)) if (part.length > 1 && part !== t && !STOP.has(part)) out.push(part);
  }
  return out;
}
/** Identifier-like terms: a digit (even short: `42`, `v2`), path or id punctuation, or mixed case in the original. */
export function entities(text) {
  const out = new Set();
  for (const raw of String(text).match(TERM) ?? []) {
    const t = raw.replace(/[.:]+$/, '');
    if (t.length < 2 || (t.length < 3 && !/\d/.test(t))) continue;
    if (/\d/.test(t) || /[_./:@#-]/.test(t) || /[a-z][A-Z]|[A-Z]{2,}/.test(t)) out.add(t.toLowerCase());
  }
  return [...out];
}

// One entry per store: the key's part before its last '#' names the store, the rest its version (a generation). A new
// version replaces the old one, so a long-lived server does not keep a copy per compaction (~210 MB each at 18k
// chunks). At most PREPARED_STORES stores; the least recently used one goes first.
const cache = new Map();
const PREPARED_STORES = 8;
/** Per-generation statistics and link maps, cached by key (`<store>#<version>`) so a long-lived server pays once. */
export function prepare(rows, key, latestSegment) {
  const store = key ? key.slice(0, Math.max(0, key.lastIndexOf('#'))) || key : undefined;
  const hit = store !== undefined ? cache.get(store) : undefined;
  if (hit !== undefined && hit.key === key) { cache.delete(store); cache.set(store, hit); return hit.prepared; }
  const docs = rows.map((row) => {
    const seq = terms(row.text), tf = new Map();
    for (const t of seq) tf.set(t, (tf.get(t) ?? 0) + 1);
    const lower = String(row.text).toLowerCase();
    return { tf, len: seq.length, seq, lower, flat: lower.replace(/\s+/g, ' '), digits: digitsJoined(lower) };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const avgLen = docs.reduce((n, d) => n + d.len, 0) / Math.max(1, docs.length);
  const maxPos = rows.reduce((m, r) => Math.max(m, Number(r.position) || 0), 1);
  // Rows carry `segment`: how many compactions happened before them in the session. `latestSegment` names the
  // stretch the newest compaction summarized away, where most follow-up questions point (default: the last one).
  const maxSegment = rows.reduce((m, r) => Math.max(m, Number.isInteger(r.segment) ? r.segment : -1), -1);
  const latest = Number.isInteger(latestSegment) ? latestSegment : maxSegment;
  const byPosition = new Map(), byCall = new Map();
  rows.forEach((r, i) => {
    const p = Number(r.position) || 0;
    if (!byPosition.has(p)) byPosition.set(p, []);
    byPosition.get(p).push(i);
    if (r.callId) { if (!byCall.has(r.callId)) byCall.set(r.callId, []); byCall.get(r.callId).push(i); }
  });
  const positions = [...byPosition.keys()].sort((a, b) => a - b);
  const posIndex = new Map(positions.map((p, i) => [p, i]));
  const prepared = { rows, docs, df, avgLen, maxPos, latestSegment: latest, byPosition, byCall, positions, posIndex };
  if (store !== undefined) {
    cache.delete(store);
    cache.set(store, { key, prepared });
    if (cache.size > PREPARED_STORES) cache.delete(cache.keys().next().value);
  }
  return prepared;
}

/** Linked chunks of chunk `i` with their relation: the tool call/result pair, same message, previous/next message. */
export function neighbours(prepared, i) {
  const { rows, byPosition, byCall, positions, posIndex } = prepared;
  const out = new Map();
  const add = (j, rel) => { if (j !== i && (!out.has(j) || EDGE[rel] > EDGE[out.get(j)])) out.set(j, rel); };
  const r = rows[i];
  const p = Number(r.position) || 0;
  // Call and result are different messages; chunks of one long call are linked as parts of the same message.
  if (r.callId) for (const j of byCall.get(r.callId) ?? []) if ((Number(rows[j].position) || 0) !== p) add(j, 'call');
  for (const j of byPosition.get(p) ?? []) add(j, 'message');
  const at = posIndex.get(p);
  for (const q of [positions[at - 1], positions[at + 1]]) if (q !== undefined) {
    const list = byPosition.get(q);
    // The nearest chunk of the adjacent message: its last chunk before us, its first after us.
    add(q < p ? list[list.length - 1] : list[0], 'adjacent');
  }
  return out;
}

/** Separators inside a number removed, so `+48 600-123-456` and `48600123456` compare equal. */
function digitsJoined(lower) { return lower.replace(/(\d)[\s().\/-]+(?=\d)/g, '$1'); }

/**
 * What the query asks for verbatim: identifier-like tokens, numbers of 6+ digits (separators dropped) and quoted
 * phrases. Each needle names the field of a prepared doc it is looked up in.
 */
export function needles(query) {
  const out = new Map();
  const raw = new Map((String(query).match(TERM) ?? []).map((t) => [t.replace(/[.:]+$/, '').toLowerCase(), t.replace(/[.:]+$/, '')]));
  for (const t of entities(query)) out.set(t, { text: t, field: 'lower', shown: raw.get(t) ?? t });
  for (const m of String(query).matchAll(/\+?\d[\d\s().\/-]*\d/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 6) out.set(`#${digits}`, { text: digits, field: 'digits', shown: m[0].trim() });
  }
  for (const m of String(query).matchAll(/"([^"]{3,})"|\u201c([^\u201d]{3,})\u201d|\u201e([^\u201d"]{3,})[\u201d"]|`([^`]{3,})`/g)) {
    const phrase = (m[1] ?? m[2] ?? m[3] ?? m[4]).toLowerCase().replace(/\s+/g, ' ').trim();
    if (phrase.length >= 3) out.set(`"${phrase}"`, { text: phrase, field: 'flat', shown: phrase });
  }
  return [...out.values()];
}

export function rank(prepared, query, limit = 5, opts = OPTS, denseList) { return search(prepared, query, limit, opts, denseList).hits; }

/** Ranked hits plus the verbatim needles no chunk contains (`missing`), so a caller can say so instead of guessing. */
export function search(prepared, query, limit = 5, opts = OPTS, denseList) {
  const { rows, docs, df, avgLen, maxPos } = prepared;
  const N = docs.length;
  const qTerms = [...new Set(terms(query))];
  const qNeedles = needles(query);
  const dense = opts.dense && denseList?.length ? denseList : undefined;
  if ((!qTerms.length && !qNeedles.length && !dense) || !N) return { hits: [], missing: [] };
  const idf = (t) => Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
  const qSet = new Set(qTerms);

  // Needles are matched as substrings over every chunk, so their rarity is counted the same way.
  const found = qNeedles.map((n) => docs.reduce((list, d, i) => (d[n.field].includes(n.text) ? (list.push(i), list) : list), []));
  const exactScore = new Map(), exactTerms = new Map();
  found.forEach((list, k) => {
    const w = Math.log(1 + (N - list.length + 0.5) / (list.length + 0.5));
    for (const i of list) {
      exactScore.set(i, (exactScore.get(i) ?? 0) + w);
      if (qNeedles[k].field === 'lower') { if (!exactTerms.has(i)) exactTerms.set(i, new Set()); exactTerms.get(i).add(qNeedles[k].text); }
    }
  });
  const missing = qNeedles.filter((_, k) => !found[k].length).map((n) => n.shown ?? n.text);

  const lists = { bm25: [], exact: [], proximity: [] }, cover = new Map();
  docs.forEach((d, i) => {
    let s = 0, hit = 0;
    for (const t of qTerms) {
      const f = d.tf.get(t);
      if (!f) { if (exactTerms.get(i)?.has(t)) hit++; continue; }
      hit++;
      s += idf(t) * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.len / avgLen));
    }
    const e = exactScore.get(i) ?? 0;
    if (!hit && !e) return;
    cover.set(i, qTerms.length ? hit / qTerms.length : 1);
    if (s) lists.bm25.push([i, s]);
    if (e) lists.exact.push([i, e]);
    if (hit >= 2) lists.proximity.push([i, proximity(d.seq, qSet, hit)]);
  });
  if (dense) for (const [i] of dense) if (!cover.has(i)) cover.set(i, 0);
  if (!cover.size) return { hits: [], missing };
  const fused = new Map();
  const addList = (weight, list) => {
    list.slice(0, 200).forEach(([i], r) => {
      // ExoVault top-rank bonus: a chunk ranked first by any signal is not diluted by the others.
      const bonus = r === 0 ? 0.05 : r <= 2 ? 0.02 : 0;
      fused.set(i, (fused.get(i) ?? 0) + weight / (RRF_K + r + 1) + (weight ? bonus : 0));
    });
  };
  // Equal scores go to the newer chunk, so a corrected value takes the first-rank bonus over the stale one.
  const byScore = (a, b) => b[1] - a[1] || (Number(rows[b[0]].position) || 0) - (Number(rows[a[0]].position) || 0);
  for (const name of ['bm25', 'exact', 'proximity']) {
    lists[name].sort(byScore);
    addList(opts[name], lists[name]);
  }
  // Nearest chunks by embedding, best first ([row index, cosine]); fused like any other ranked list.
  if (dense) addList(opts.dense, dense);
  if (opts.graph && opts.seeds) {
    const seeds = [...fused].sort(byScore).slice(0, opts.seeds).map(([i]) => i);
    const graph = new Map();
    for (const s of seeds) for (const [j, rel] of neighbours(prepared, s)) graph.set(j, Math.max(graph.get(j) ?? 0, EDGE[rel]));
    for (const s of seeds) graph.delete(s);
    addList(opts.graph, [...graph].sort(byScore));
  }
  const top = Math.max(...fused.values());
  const scored = [...fused].map(([i, s]) => {
    const recency = (Number(rows[i].position) || 0) / maxPos;
    const latest = prepared.latestSegment >= 0 && rows[i].segment === prepared.latestSegment ? opts.latest : 0;
    return [i, s / top + opts.coverage * (cover.get(i) ?? 0) ** 2 + opts.recency * recency + latest];
  }).sort((a, b) => b[1] - a[1] || (rows[b[0]].position ?? 0) - (rows[a[0]].position ?? 0));

  const out = [], picked = [];
  for (const [i, score] of scored) {
    const set = docs[i].tf;
    if (picked.some((j) => jaccard(set, docs[j].tf) > 0.8)) continue;
    const matched = [...qTerms.filter((t) => set.has(t) || exactTerms.get(i)?.has(t)),
      ...qNeedles.filter((n, k) => n.field !== 'lower' && found[k].includes(i)).map((n) => n.shown ?? n.text)];
    picked.push(i); out.push({ ...rows[i], index: i, score, matched });
    if (out.length >= limit) break;
  }
  return { hits: out, missing };
}

/** Cover density: matched distinct terms over the smallest window holding all of them (1 when adjacent). */
function proximity(seq, qSet, matched) {
  const need = matched, count = new Map();
  let have = 0, best = Infinity, left = 0;
  for (let right = 0; right < seq.length; right++) {
    const t = seq[right];
    if (!qSet.has(t)) continue;
    count.set(t, (count.get(t) ?? 0) + 1);
    if (count.get(t) === 1) have++;
    while (have === need) {
      best = Math.min(best, right - left + 1);
      const l = seq[left++];
      if (qSet.has(l)) { count.set(l, count.get(l) - 1); if (count.get(l) === 0) have--; }
    }
  }
  return best === Infinity ? 0 : matched * matched / best;
}

function jaccard(a, b) {
  let inter = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const k of small.keys()) if (big.has(k)) inter++;
  return inter / Math.max(1, a.size + b.size - inter);
}
