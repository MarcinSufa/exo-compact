#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finishRecall, recallAround, recallCandidates, recallSession, sessionHasVectors, transcriptFallback } from './recall.mjs';
import { CANDIDATES, RANKED_K, jevConfig, jevEgressAllowed, rerankOrder, scoreWithJev, transcriptCwds } from './jev-rerank.mjs';
import { QUERY, loadEmbedder, runtimeDir, runtimeReady, vectorFile } from './vectors.mjs';
import { briefDir } from './brief.mjs';
import { searchBriefs } from './brief-search.mjs';
import { terms } from './rank.mjs';
import { hash, redact } from './shared.mjs';
import { claudeProjectsDir, homeDir, recallRootDir } from './paths.mjs';
import { startPushServer } from './push-server.mjs';

const SERVER_NAME = 'recall';
export const TOOL_NAME = 'search_session';
const TOOL_DESCRIPTION = 'Search everything earlier in this Claude Code session, including the part a compaction removed from context: '
  + 'files read, commands and their output, edits, user decisions, ids and exact values. After a compaction, call it whenever '
  + 'you need a detail the session memory lacks (a requirement, a value, a file list, an earlier result or decision) instead of '
  + 'guessing or redoing the work. Returns at most 5 short excerpts '
  + '(about 750 tokens in total), much cheaper than re-reading files or grepping the transcript. '
  + 'Ask a short question in plain words, as you would ask a colleague, and include any specific name you know '
  + '(a path, an id, a setting), e.g. "which branch were the round 13 commits pushed to"; any language works. '
  + 'Returns a few excerpts, best first: the ones that answer the question rank on top, so a full question finds more than keywords. '
  + 'Quote an exact phrase in "double quotes". '
  + 'Ids, hashes (a prefix is enough) and numbers (any separators) match verbatim; notFound lists the ones nobody wrote earlier, '
  + 'so do not keep searching for them. Each hit lists the query words it matched. '
  + 'segment is how many compactions came before the excerpt (0 = before the first one): the whole session stays searchable, '
  + 'and when two excerpts disagree, the later segment and turn is the newer value. To look inside one earlier stretch '
  + '(the seed\'s session map lists them as S1, S2, ...), pass segment with that number. '
  + 'Each hit has a ref and links (output of a command, the command behind an output, other parts of the message, '
  + 'previous/next message); call again with around=<ref> instead of query to read those neighbours. '
  + 'With scope "brief" it searches instead the user\'s long requests (task briefs), saved verbatim when they were sent, '
  + 'line by line with the newest brief first: use it for a requirement of the task (a file name, a cap, a count, an exact '
  + 'string, a check to run). Brief hits give filePath "<file>:<line>"; Read with offset there for the lines around it.';
const SERVER_VERSION = '1.8.0';
const SCOPES = ['session', 'brief'];
const MAX_LINE = 1024 * 1024;

export function findSessionTranscript(sessionId, projectsRoot = claudeProjectsDir()) {
  if (!sessionId || !fs.existsSync(projectsRoot)) return undefined;
  const target = `${sessionId}.jsonl`;
  const stack = [projectsRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name === target) return full;
    }
  }
  return undefined;
}

export function recallTool(args, options = {}) {
  const { query, session, k = 5, scope = 'session' } = args ?? {};
  if (!SCOPES.includes(scope)) throw new Error('scope must be "session" or "brief"');
  if (scope === 'brief' && args.around === undefined) {
    if (typeof query !== 'string' || !query.trim()) throw new Error('query must be a non-empty string');
    if (typeof session !== 'string' || !session.trim()) throw new Error('session must be a non-empty string');
    if (!Number.isInteger(k) || k < 1 || k > 5) throw new Error('k must be an integer from 1 to 5');
    return logged(briefOnly(query, session, k, options), args, options);
  }
  return logged(sessionRecall(args ?? {}, options), args, options);
}

function briefOnly(query, session, k, options) {
  const found = searchBriefs(recallRootFor(options), session, query, k, options.queryVector ? { queryVector: options.queryVector } : {});
  if (!found.briefs) return { source: 'briefs', message: 'No long request (task brief) was saved in this session; search without scope.', hits: [] };
  return { source: 'briefs', ...(found.vectors ? { vectors: found.vectors } : {}), hits: capBriefs(found.hits, 750) };
}

function capBriefs(hits, tokens) {
  const out = []; let used = 0;
  for (const hit of hits) {
    const budget = tokens - used - 24;
    if (budget <= 20) break;
    const text = hit.text.slice(0, budget * 4);
    out.push({ source: 'brief', ...(hit.newest ? { newest: true } : {}), filePath: hit.filePath, ...(hit.matched?.length ? { matched: hit.matched } : {}), text });
    used += Math.ceil(text.length / 4) + 24;
  }
  return out;
}

/** One line per call in <root>/<sha(session)>/search-calls.jsonl (query, scope, where the hits came from), for measuring use. */
function logged(result, args, options) {
  try {
    if (typeof args?.session !== 'string' || !args.session.trim()) return result;
    const dir = path.join(recallRootFor(options), hash(args.session));
    if (!fs.existsSync(dir)) return result;
    const hits = (result?.hits ?? []).map((hit) => (hit.source === 'brief' ? `brief:${String(hit.filePath).split(/[\\/]/).pop()}` : `${hit.role ?? ''}:${hit.turn ?? ''}`));
    fs.appendFileSync(path.join(dir, 'search-calls.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...(args.query !== undefined ? { query: redact(String(args.query)).slice(0, 300) } : {}), ...(args.around !== undefined ? { around: args.around } : {}), scope: args.scope ?? 'session', hits })}\n`, { mode: 0o600 });
  } catch { /* measuring must never break a search */ }
  return result;
}

function sessionRecall({ query, around, session, k = 5, segment }, options = {}) {
  if (around !== undefined && (typeof around !== 'string' || !around.trim())) throw new Error('around must be a ref from an earlier hit');
  if (around === undefined && (typeof query !== 'string' || !query.trim())) throw new Error('query must be a non-empty string');
  if (typeof session !== 'string' || !session.trim()) throw new Error('session must be a non-empty string');
  if (!Number.isInteger(k) || k < 1 || k > 5) throw new Error('k must be an integer from 1 to 5');
  if (segment !== undefined && (!Number.isInteger(segment) || segment < 0)) throw new Error('segment must be an integer from 0');
  const env = options.env ?? process.env, home = options.home ?? homeDir(env);
  const root = recallRootFor(options);
  const dense = { ...(options.queryVector ? { queryVector: options.queryVector } : {}), ...(segment !== undefined ? { segment } : {}) };
  const transcript = options.transcript ?? findSessionTranscript(session, options.projectsRoot ?? claudeProjectsDir(env, home));
  if (around !== undefined) {
    let cutoff = Infinity;
    if (transcript) try { cutoff = fs.statSync(transcript).size; } catch { /* keep Infinity */ }
    return recallAround(root, session, around, k, cutoff);
  }
  let result;
  if (transcript) {
    let cutoff = -1;
    try { cutoff = fs.statSync(transcript).size; } catch { /* transcript may disappear between lookup and stat */ }
    if (cutoff >= 0) {
      result = recallSession(root, session, query, k, cutoff, dense);
      if (!result) result = transcriptFallback(transcript, query, k, cutoff);
    }
  } else {
    // A published generation remains usable without the transcript, but there
    // is no live byte boundary to compare against.
    result = recallSession(root, session, query, k, Infinity, dense);
  }
  return result ?? { source: 'no-index', message: 'No published recall index or matching session transcript is available.', hits: [] };
}

function recallRootFor(options) { const env = options.env ?? process.env; return options.recallRoot ?? recallRootDir(env, options.home ?? homeDir(env)); }

let embedder;
const hasFile = (file) => { try { return fs.statSync(file).size > 0; } catch { return false; } };
/** The query's embedding when the searched store (chunks, or brief lines for scope "brief") has vectors and the local model is installed. */
async function queryVector(query, session, options, scope = 'session') {
  const root = recallRootFor(options), runtime = options.runtimeDir ?? runtimeDir(root);
  const has = scope === 'brief' ? hasFile(vectorFile(briefDir(root, session))) : sessionHasVectors(root, session);
  if (!has || !runtimeReady(runtime)) return undefined;
  try {
    embedder ??= loadEmbedder(runtime, { threads: 2 });
    return (await (await embedder)([QUERY + query]))[0];
  } catch { embedder = undefined; return undefined; }
}

/**
 * A search with Jev ranking (jev-rerank.mjs): 20 candidates, one Jev request, the best RANKED_K (or k) returned.
 * Without Jev settings, an index, or a usable answer it is exactly recallTool.
 */
export async function recallToolAsync(args, options = {}) {
  const config = 'jev' in options ? options.jev : jevConfig();
  if ((args?.scope ?? 'session') !== 'session') return recallTool(args ?? {}, options);
  const ranked = await jevRecall(args, options, config);
  return ranked === undefined ? recallTool(args ?? {}, options) : logged(ranked, args, options);
}

/** The Jev-ranked session search, or undefined when it does not apply (the caller then runs recallTool). */
async function jevRecall(args, options, config) {
  const { query, around, session, k, segment } = args ?? {};
  if (around !== undefined || !config || typeof query !== 'string' || !query.trim() || typeof session !== 'string' || !session.trim()
    || (k !== undefined && (!Number.isInteger(k) || k < 1 || k > 5)) || (segment !== undefined && (!Number.isInteger(segment) || segment < 0))) return undefined;
  const env = options.env ?? process.env, home = options.home ?? homeDir(env);
  const transcript = options.transcript ?? findSessionTranscript(session, options.projectsRoot ?? claudeProjectsDir(env, home));
  let cutoff = Infinity;
  if (transcript) try { cutoff = fs.statSync(transcript).size; } catch { return undefined; }
  // #29: the hook's egress rule, for the directory the session works in (a shell `cd` moves it, the server's does not).
  // An unknown working directory, or no home directory (homeDir's '.'), skips Jev rather than guessing.
  const recorded = options.cwd === undefined && transcript ? transcriptCwds(transcript) : {};
  const cwd = options.cwd ?? recorded.last;
  if (!cwd) return undefined;
  const roots = [options.serverCwd ?? process.cwd(), env.CLAUDE_PROJECT_DIR, recorded.start].filter((dir) => typeof dir === 'string' && dir !== '');
  if (!jevEgressAllowed({ cwd, home: home === '.' ? undefined : home, roots, denyList: config.denyList })) return undefined;
  const found = recallCandidates(recallRootFor(options), session, query, CANDIDATES, cutoff, { ...(options.queryVector ? { queryVector: options.queryVector } : {}), ...(segment !== undefined ? { segment } : {}) });
  if (!found?.docs.length) return undefined;
  const scores = await (options.scoreJev ?? scoreWithJev)(query, found.docs.map((doc) => doc.text), config, options.fetch);
  if (!scores) return finishRecall(found, undefined, k ?? 5);
  return finishRecall(found, rerankOrder(scores), k ?? RANKED_K, { ranked: 'jev' });
}

/** handleMessage, plus the query embedding (model load ~1 s once, then ~10 ms) and Jev ranking for a search. */
export async function handleMessageAsync(message, options = {}) {
  const { id, method, params = {} } = message ?? {};
  const args = params.arguments ?? {};
  if (method === 'tools/call' && (params.name === TOOL_NAME || params.name === 'recall') && args.around === undefined
    && typeof args.query === 'string' && args.query.trim() && typeof args.session === 'string' && args.session.trim()) {
    const vector = await queryVector(args.query, args.session, options, args.scope);
    try {
      const data = await recallToolAsync(args, vector ? { ...options, queryVector: vector } : options);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false } };
    } catch (error) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true } };
    }
  }
  return handleMessage(message, options);
}

export function handleMessage(message, options = {}) {
  const { id, method, params = {} } = message ?? {};
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return undefined;
  if (method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } } };
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: [{ name: TOOL_NAME, description: TOOL_DESCRIPTION, _meta: { 'anthropic/alwaysLoad': true }, inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, around: { type: 'string', pattern: '^g\\d+:\\d+$', description: 'A ref from an earlier hit: returns that excerpt and its linked neighbours instead of searching.' }, session: { type: 'string', minLength: 1 }, k: { type: 'integer', minimum: 1, maximum: 5, default: 5 }, segment: { type: 'integer', minimum: 0, description: 'Search only this segment (compactions before the excerpt), e.g. one listed in the seed\'s session map.' }, scope: { type: 'string', enum: SCOPES, default: 'session', description: '"brief": the saved task briefs, line by line (a requirement of the task); "session" (default): the session.' } }, required: ['session'], additionalProperties: false } }] } };
  if (method === 'tools/call') {
    // `recall` was the tool's name up to 3.19; still accepted so older seeds keep working.
    if (params.name !== TOOL_NAME && params.name !== 'recall') return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${String(params.name)}` } };
    try {
      const data = recallTool(params.arguments ?? {}, options);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false } };
    } catch (error) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true } };
    }
  }
  if (typeof method === 'string' && method.startsWith('notifications/')) return undefined;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(method)}` } };
}

/**
 * 4.8.2 (CONTRACT S5s): the session push socket of the session this server runs for, when Claude Code names it. The
 * pointer is written again once the client finishes initializing, since a version probe Claude Code starts first may
 * have written and removed it; it goes when stdin closes or a signal stops the process.
 */
function startPush() {
  let push, stopped = false;
  const stop = () => { stopped = true; push?.closeSync(); };
  startPushServer({ recallRoot: recallRootFor({}), sessionId: process.env.CLAUDE_CODE_SESSION_ID }).then((handle) => {
    push = handle ?? undefined;
    if (stopped) push?.closeSync();
  }, () => {});
  process.stdin.on('end', stop);
  process.on('exit', stop);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { stop(); process.exit(0); });
  return { initialized: () => push?.assert() };
}

function main() {
  let buffer = '', queue = Promise.resolve();
  const push = startPush();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_LINE && !buffer.includes('\n')) { process.stderr.write('MCP input line too large\n'); process.exit(1); }
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      if (line.includes('"notifications/initialized"')) push.initialized();
      // One request at a time, in order: a search may wait for the embedding model.
      queue = queue.then(async () => {
        let response;
        try { response = await handleMessageAsync(JSON.parse(line)); }
        catch (error) { response = { jsonrpc: '2.0', id: null, error: { code: -32700, message: error instanceof Error ? error.message : String(error) } }; }
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      });
    }
  });
}

const isMain = process.argv[1] && path.basename(process.argv[1]) === 'mcp-server.mjs' && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
