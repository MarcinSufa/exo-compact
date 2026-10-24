#!/usr/bin/env node
// Offline tree-of-summaries experiment. Transcript-derived files belong under /tmp/exo-ideas/<idea>/.
//
//   node --experimental-strip-types tools/tree-eval/tree.mjs --dump <real-replay-dump> --out <dir> --dry
//   TREE_MAX_SPEND=2 node --experimental-strip-types tools/tree-eval/tree.mjs --dump <dump> --out <dir> --paid
//   node --experimental-strip-types tools/tree-eval/tree.mjs --tree <tree.json> --zoom <node-id> --depth 3
//
// The dry pass fixes a deterministic merge shape; paid mode hydrates its merge nodes from bottom to top,
// batching independent pairs. Since every model node is at most 512 UTF-8 bytes and the dry placeholder for
// every non-free node is 512 bytes, paid summaries cannot make a planned view larger than its dry budget.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const CORE = fileURLToPath(new URL('../../plugin/compact/core', import.meta.url));
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(pathToFileURL(`${CORE}/`).href) && specifier.startsWith('./') && specifier.endsWith('.js')) {
    return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
  }
  return nextResolve(specifier, context);
} });
const [{ collectSinceCard }, { collectFilePointers }] = await Promise.all([
  import(pathToFileURL(path.join(CORE, 'since-card.ts'))),
  import(pathToFileURL(path.join(CORE, 'file-pointers.ts'))),
]);

export const SUMMARY_MAX_BYTES = 512;
export const DEFAULT_VIEW_BUDGET = 2500;
export const MERGE_BATCH_SIZE = 100;
export const MAX_CALLS_PER_SESSION = 60;
export const MODEL = 'claude-haiku-4-5-20251001';
export const MODEL_PRICE = { inputPerMillion: 1, outputPerMillion: 5 }; // USD, Haiku rates used by quiz.mjs.
const tokens = (s) => Math.ceil(String(s ?? '').length / 4);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const cleanOneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function truncateUtf8(text, maxBytes = SUMMARY_MAX_BYTES) {
  const source = String(text ?? '');
  if (Buffer.byteLength(source, 'utf8') <= maxBytes) return source;
  const suffix = '…';
  const room = Math.max(0, maxBytes - Buffer.byteLength(suffix));
  let out = '';
  let used = 0;
  for (const cp of source) {
    const n = Buffer.byteLength(cp, 'utf8');
    if (used + n > room) break;
    out += cp;
    used += n;
  }
  return out + suffix;
}

function nestedText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text') return String(part.text ?? '');
    if (part?.type === 'tool_result') return nestedText(part.content);
    return '';
  }).filter(Boolean).join('\n');
}

function sessionMessage(event, index) {
  const content = event?.message?.content;
  const parts = Array.isArray(content) ? content : [];
  const toolUses = parts.filter((part) => part?.type === 'tool_use').map((part, n) => ({
    tool_use_id: typeof part.id === 'string' ? part.id : `tree-${index}-${n}`,
    tool: String(part.name ?? 'tool'),
    input: part.input && typeof part.input === 'object' ? part.input : {},
  }));
  const toolResults = parts.filter((part) => part?.type === 'tool_result').map((part) => ({
    tool_use_id: String(part.tool_use_id ?? ''),
    isError: part.is_error === true,
    text: nestedText(part.content),
  }));
  const role = event?.type === 'assistant' ? 'assistant' : 'user';
  const text = typeof content === 'string' ? content : parts.filter((part) => part?.type === 'text').map((part) => String(part.text ?? '')).join('\n');
  return {
    role, text, toolUses, toolResults,
    sidechain: event?.isSidechain === true,
    eventIndex: index,
    original: event,
  };
}

/** Parse a JSONL transcript into user/assistant messages, retaining their original events for zoom. */
export function transcriptMessages(sourceText) {
  const messages = [];
  let eventIndex = 0;
  for (const line of String(sourceText).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'user' || event?.type === 'assistant') messages.push(sessionMessage(event, eventIndex));
    eventIndex += 1;
  }
  return messages;
}

function firstSentence(text) {
  const one = cleanOneLine(text);
  if (!one) return '';
  const match = /[.!?](?:["')\]}]*)?(?=\s|$)/.exec(one);
  return match ? one.slice(0, match.index + match[0].length).trim() : one;
}

function callDescriptions(message) {
  if (!message.toolUses.length) return [];
  const synthetic = {
    role: message.role,
    text: message.text,
    toolUses: message.toolUses,
    toolResults: message.toolResults,
  };
  const horizon = message.toolUses[0].tool_use_id;
  const steps = collectSinceCard([synthetic], horizon, new Set());
  const lines = [...steps.lines];
  if (steps.readOnly) lines.push(steps.readOnly);
  // File pointers are useful when a concise step line names a tool but not the touched path.
  const pointers = collectFilePointers([synthetic], 8);
  if (pointers.length) lines.push(`files: ${pointers.join(', ')}`);
  return lines;
}

function resultDescriptions(message, toolNames) {
  return message.toolResults.map((result) => {
    const name = toolNames.get(result.tool_use_id) ?? 'tool';
    return `${name} result ${result.isError ? 'failed' : 'ok'}`;
  });
}

function summarizeMessage(message, toolNames) {
  const text = message.role === 'assistant' ? firstSentence(message.text) : message.text;
  const isPlainShortUser = message.role === 'user' && !message.toolResults.length && !message.toolUses.length
    && text.length > 0 && !/[\r\n]/.test(text) && Buffer.byteLength(text, 'utf8') <= SUMMARY_MAX_BYTES;
  if (isPlainShortUser) return text; // Keep short, single-line user text verbatim.
  const parts = [];
  if (text) parts.push(cleanOneLine(text));
  if (message.role === 'assistant') parts.push(...callDescriptions(message));
  if (message.role === 'user') parts.push(...resultDescriptions(message, toolNames));
  if (message.sidechain) parts.unshift('sidechain');
  return truncateUtf8(parts.filter(Boolean).join(' · ') || `${message.role} message`, SUMMARY_MAX_BYTES);
}

/** One deterministic <=512-byte summary for each user/assistant transcript message. */
export function level0(messages) {
  const toolNames = new Map();
  for (const message of messages) for (const use of message.toolUses) toolNames.set(use.tool_use_id, use.tool);
  return messages.map((message, index) => ({
    id: `m${String(index).padStart(6, '0')}`,
    kind: 'message', level: 0, start: index, end: index + 1,
    role: message.role, text: summarizeMessage(message, toolNames),
    original: message.original ?? null,
  }));
}

function joinedText(left, right) { return `${left.text} ⟷ ${right.text}`; }
export function canFreeMerge(left, right) {
  return Buffer.byteLength(joinedText(left, right), 'utf8') <= SUMMARY_MAX_BYTES;
}

/** Test/dry merger: join two lines and truncate at the 512-byte node limit. */
export function dryMerge(left, right) {
  return truncateUtf8(joinedText(left, right), SUMMARY_MAX_BYTES);
}

function renderNode(node) { return `[${node.id} L${node.level} ${node.role}] ${node.text}`; }
export function renderView(tree, snapshot) {
  return (snapshot?.nodeIds ?? []).map((id) => renderNode(tree.nodes[id])).join('\n');
}
export function viewTokens(tree, snapshot) { return tokens(renderView(tree, snapshot)); }

export function duePair(visible, totalMessages) {
  const candidates = [];
  for (let i = 0; i + 1 < visible.length; i += 1) {
    const left = visible[i], right = visible[i + 1];
    if (left.level !== right.level || left.end !== right.start) continue;
    // Taelin spec v3 2026-10-08: age from the pair's last message, not its first.
    candidates.push({ i, left, right, due: (totalMessages - (right.end - 1)) / (2 ** left.level) });
  }
  candidates.sort((a, b) => b.due - a.due || a.left.start - b.left.start);
  return candidates[0];
}

function makeParent(left, right) {
  const level = left.level + 1;
  const id = `t${level}-${left.start}-${right.end}`;
  const free = canFreeMerge(left, right);
  return {
    id, kind: 'merge', level, start: left.start, end: right.end,
    role: left.role === right.role ? left.role : 'mixed',
    children: [left.id, right.id],
    text: free ? joinedText(left, right) : dryMerge(left, right),
    free, mergeKind: free ? 'free' : 'dry',
  };
}

function snapshot(nodes, visible, messageIndex) {
  const nodeIds = visible.map((node) => node.id);
  const out = { messageIndex, messageCount: messageIndex + 1, nodeIds };
  out.tokens = viewTokens({ nodes }, out);
  return out;
}

/** Build due-merged views incrementally; appending messages never opens or splits an earlier merged node. */
export function buildTree(messages, { budgetTokens = DEFAULT_VIEW_BUDGET, atMessageIndices } = {}) {
  const leaves = level0(messages);
  return buildTreeFromLeaves(leaves, { budgetTokens, atMessageIndices });
}

function buildTreeFromLeaves(leaves, { budgetTokens = DEFAULT_VIEW_BUDGET, atMessageIndices } = {}) {
  const nodes = Object.create(null);
  const requested = atMessageIndices === undefined ? new Set(leaves.map((leaf) => leaf.start)) : new Set(atMessageIndices);
  const visible = [];
  const snapshots = Object.create(null);
  const mergeOrder = [];
  let freeMerges = 0, paidMerges = 0;
  for (const leaf of leaves) {
    nodes[leaf.id] = leaf;
    visible.push(leaf);
    while (viewTokens({ nodes }, { nodeIds: visible.map((node) => node.id) }) > budgetTokens) {
      const candidate = duePair(visible, leaf.end);
      if (!candidate) break;
      const parent = makeParent(candidate.left, candidate.right);
      nodes[parent.id] = parent;
      visible.splice(candidate.i, 2, parent);
      mergeOrder.push(parent.id);
      if (parent.free) freeMerges += 1; else paidMerges += 1;
    }
    if (requested.has(leaf.start)) snapshots[leaf.start] = snapshot(nodes, visible, leaf.start);
  }
  if (requested.has(-1)) snapshots[-1] = { messageIndex: -1, messageCount: 0, nodeIds: [], tokens: 0 };
  return {
    budgetTokens, messageCount: leaves.length, nodes, snapshots, mergeOrder,
    metrics: { level0: leaves.length, merges: mergeOrder.length, freeMerges, paidMerges },
  };
}

/** Return the view through an inclusive message index. Recomputes only when the requested budget/snapshot differs. */
export function view(tree, budgetTokens, atMessageIndex) {
  if (budgetTokens === tree.budgetTokens && tree.snapshots?.[atMessageIndex]) return tree.snapshots[atMessageIndex];
  const leaves = Object.values(tree.nodes).filter((node) => node.level === 0 && node.start <= atMessageIndex).sort((a, b) => a.start - b.start);
  return buildTreeFromLeaves(leaves, { budgetTokens, atMessageIndices: [atMessageIndex] }).snapshots[atMessageIndex]
    ?? { messageIndex: atMessageIndex, messageCount: atMessageIndex + 1, nodeIds: [], tokens: 0 };
}

/** Expand a tree line by depth; depth 1 returns children and a leaf includes its original transcript message. */
export function zoom(tree, id, depth = 1) {
  const node = tree.nodes[id];
  if (!node) throw new Error(`unknown tree node: ${id}`);
  if (node.level === 0 || depth <= 0) return [node];
  return node.children.flatMap((childId) => zoom(tree, childId, depth - 1));
}

function parseJsonObject(text) {
  const s = String(text ?? '');
  try { const parsed = JSON.parse(s); if (parsed && typeof parsed === 'object') return parsed; } catch {}
  for (let end = s.lastIndexOf('}'); end >= 0; end = s.lastIndexOf('}', end - 1)) {
    for (let start = s.lastIndexOf('{', end); start >= 0; start = s.lastIndexOf('{', start - 1)) {
      try { const parsed = JSON.parse(s.slice(start, end + 1)); if (parsed && typeof parsed === 'object') return parsed; } catch {}
    }
  }
  throw new Error('merger response did not contain a JSON object');
}

function parseClaudeStream(stdout) {
  let result;
  for (const line of String(stdout).split('\n')) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.type === 'result') result = row;
  }
  return result;
}

function mergePrompt(tasks) {
  const pairs = tasks.map((task) => ({ id: task.id, left: task.leftText, right: task.rightText }));
  return [
    'You summarize adjacent chronological session memories for a future assistant. For each pair, preserve concrete names, paths, numbers, decisions, and relationships that matter. Do not invent facts. Return one concise standalone line, at most 512 UTF-8 bytes, for every id.',
    'Reply with JSON only, in the same ids: {"merges":[{"id":"...","text":"..."}]}.',
    JSON.stringify({ merges: pairs }),
  ].join('\n\n');
}

export function validateMergeResponse(raw, tasks) {
  const parsed = parseJsonObject(raw);
  const rows = Array.isArray(parsed.merges) ? parsed.merges : [];
  const out = new Map();
  for (const row of rows) {
    const id = String(row?.id ?? '');
    const text = cleanOneLine(row?.text);
    if (!text) continue;
    out.set(id, truncateUtf8(text, SUMMARY_MAX_BYTES));
  }
  // Missing ids are not an error here: the caller (hydrateTree) retries them once, then falls back to a truncated join.
  return out;
}

function cacheKey(task) { return sha(`${MODEL}\0${task.id}\0${task.leftText}\0${task.rightText}`); }

function estimateBatchUsd(prompt, count) {
  const input = tokens(prompt);
  const output = count * 150; // upper estimate: 512-byte summaries plus JSON framing.
  return (input * MODEL_PRICE.inputPerMillion + output * MODEL_PRICE.outputPerMillion) / 1_000_000;
}

export function runClaude(input, remainingUsd, { badReplyDir } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', '--model', MODEL, '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence', '--setting-sources', 'project', '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--max-turns', '1',
      '--settings', '{"disableAllHooks":true}', '--max-budget-usd', String(Math.max(0.01, remainingUsd)),
    ];
    const child = spawn(process.env.TREE_CLAUDE ?? 'claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 600_000);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const result = parseClaudeStream(out);
      if (code !== 0 || !result || result.is_error) return reject(new Error(`claude merge failed (${code}): ${err.slice(0, 300)}${result?.result ? ` ${String(result.result).slice(0, 200)}` : ''}`));
      let merged;
      try { merged = validateMergeResponse(result.result, JSON.parse(input.slice(input.lastIndexOf('\n') + 1)).merges.map((x) => ({ id: x.id }))); }
      catch (e) {
        // The reply was paid for but holds no JSON object: keep it for diagnosis, and let hydrateTree retry its ids once
        // and then fall back to truncated joins, instead of aborting every remaining session.
        const reply = String(result.result ?? '');
        if (badReplyDir) {
          fs.mkdirSync(badReplyDir, { recursive: true, mode: 0o700 });
          fs.writeFileSync(path.join(badReplyDir, `bad-reply-${Date.now()}-${process.pid}.txt`), reply, { mode: 0o600 });
        }
        console.error(`merger reply unparsable (${e.message}): ${reply.length} chars, stop ${result.stop_reason ?? '?'}, ${result.usage?.output_tokens ?? '?'} output tokens`);
        merged = new Map();
      }
      resolve({ merged, cost: Number(result.total_cost_usd ?? 0), inputTokens: Number(result.usage?.input_tokens ?? 0), outputTokens: Number(result.usage?.output_tokens ?? 0) });
    });
    child.stdin.end(input);
  });
}

/** Inject a pluggable batched merger into a dry plan; each height is independent once its children are ready. */
export async function hydrateTree(tree, { mergeBatch, cache = {}, maxSpend = 2, spentBefore = 0, maxCalls = MAX_CALLS_PER_SESSION, onCacheWrite = () => {} } = {}) {
  if (typeof mergeBatch !== 'function') throw new Error('hydrateTree requires a mergeBatch function');
  let spent = spentBefore, calls = 0, cachedHits = 0, paidMerges = 0, skippedMerges = 0, truncatedMerges = 0;
  const maxLevel = Math.max(0, ...Object.values(tree.nodes).map((node) => node.level));
  for (let level = 1; level <= maxLevel; level += 1) {
    const current = Object.values(tree.nodes).filter((node) => node.level === level).sort((a, b) => a.start - b.start);
    const tasks = [];
    for (const node of current) {
      const left = tree.nodes[node.children[0]], right = tree.nodes[node.children[1]];
      const joined = joinedText(left, right);
      if (Buffer.byteLength(joined, 'utf8') <= SUMMARY_MAX_BYTES) {
        node.text = joined;
        node.free = true;
        node.mergeKind = 'free';
        continue;
      }
      node.free = false;
      const task = { id: node.id, leftText: left.text, rightText: right.text, key: '' };
      task.key = cacheKey(task);
      if (typeof cache[task.key] === 'string' && Buffer.byteLength(cache[task.key], 'utf8') <= SUMMARY_MAX_BYTES) {
        node.text = cache[task.key]; node.mergeKind = 'paid-cache'; cachedHits += 1;
      } else tasks.push(task);
    }
    // Run tasks in batches; returns { missing: tasks that came back without text, skipped: tasks never sent (cap hit) }.
    const runPass = async (list) => {
      const missing = [], skipped = [];
      let start = 0;
      while (start < list.length) {
        if (calls >= maxCalls) { skipped.push(...list.slice(start)); break; }
        let end = Math.min(list.length, start + MERGE_BATCH_SIZE);
        while (end > start && spent + estimateBatchUsd(mergePrompt(list.slice(start, end)), end - start) > maxSpend) end -= 1;
        if (end === start) { skipped.push(...list.slice(start)); break; }
        const batch = list.slice(start, end);
        const finalPrompt = mergePrompt(batch);
        const remaining = Math.max(0.01, maxSpend - spent);
        const response = await mergeBatch(finalPrompt, batch, remaining);
        calls += 1;
        spent += response.cost;
        for (const task of batch) {
          const raw = response.merged.get(task.id);
          const text = typeof raw === 'string' ? truncateUtf8(cleanOneLine(raw), SUMMARY_MAX_BYTES) : '';
          if (!text) { missing.push(task); continue; }
          tree.nodes[task.id].text = text;
          tree.nodes[task.id].mergeKind = 'paid';
          cache[task.key] = text;
          paidMerges += 1;
        }
        onCacheWrite(cache);
        start = end;
      }
      return { missing, skipped };
    };
    const fallback = (task) => {
      const node = tree.nodes[task.id];
      node.text = truncateUtf8(joinedText(tree.nodes[node.children[0]], tree.nodes[node.children[1]]));
      node.mergeKind = 'truncated';
    };
    const first = await runPass(tasks);
    const second = first.missing.length ? await runPass(first.missing) : { missing: [], skipped: [] };
    // Retry tasks the caps prevented from running again were attempted already, so they count as truncated, not skipped.
    for (const task of [...second.missing, ...second.skipped]) { fallback(task); truncatedMerges += 1; }
    for (const task of first.skipped) { fallback(task); skippedMerges += 1; }
  }
  return { spent, calls, cachedHits, paidMerges, skippedMerges, truncatedMerges };
}

function loadCache(file) {
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value && typeof value === 'object' ? value : {}; }
  catch { return {}; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
}

function readTranscript(file) {
  const text = fs.readFileSync(file, 'utf8');
  const messages = [];
  let eventIndex = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'user' || event?.type === 'assistant') messages.push(sessionMessage(event, eventIndex));
    eventIndex += 1;
  }
  return { messages, eventCount: eventIndex, lineCount: text.split('\n').length - (text.endsWith('\n') ? 1 : 0) };
}

export function assertSafeCutId(id) {
  if (typeof id !== 'string' && typeof id !== 'number') throw new Error(`unsafe cut id ${JSON.stringify(id)}: must match /^[\\w.-]+$/`);
  const text = String(id);
  if (!/^[\w.-]+$/.test(text) || text === '.' || text === '..') throw new Error(`unsafe cut id ${JSON.stringify(text)}: must match /^[\\w.-]+$/ (it is joined into output paths)`);
  return text;
}

export function loadDump(dumpDir, selectedCuts) {
  return fs.readdirSync(dumpDir).filter((name) => /^cut-.*\.json$/.test(name)).sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(dumpDir, name), 'utf8')))
    .map((cut) => { assertSafeCutId(cut.id); return cut; })
    .filter((cut) => cut.source && (!selectedCuts || selectedCuts.has(String(cut.id))));
}

function viewAtCut(tree, cut, messages) {
  const messageCount = messages.filter((message) => message.eventIndex < cut.boundaryLine).length;
  const index = messageCount - 1;
  return { messageCount, snapshot: tree.snapshots[index] ?? { messageIndex: index, messageCount: 0, nodeIds: [], tokens: 0 } };
}

function safeKey(file) { return sha(path.resolve(file)).slice(0, 12); }

async function processDump({ dumpDir, outDir, dry, selectedCuts, budgetTokens }) {
  const cuts = loadDump(dumpDir, selectedCuts);
  if (!cuts.length) throw new Error(`no cut json files found in ${dumpDir}`);
  const spendCap = Number(process.env.TREE_MAX_SPEND ?? 2);
  if (!Number.isFinite(spendCap) || spendCap < 0) throw new Error('TREE_MAX_SPEND must be a non-negative USD amount');
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const groups = new Map();
  for (const cut of cuts) groups.set(path.resolve(cut.source), [...(groups.get(path.resolve(cut.source)) ?? []), cut]);
  const cacheFile = process.env.TREE_CACHE ?? path.join(outDir, 'merge-cache.json');
  const cache = dry ? {} : loadCache(cacheFile);
  let totalSpent = 0;
  const allMetrics = [];
  for (const [source, sessionCuts] of groups) {
    const { messages: allMessages, lineCount } = readTranscript(source);
    sessionCuts.sort((a, b) => a.boundaryLine - b.boundaryLine);
    const lastBoundary = Math.max(...sessionCuts.map((cut) => Number(cut.boundaryLine) || 0));
    const messages = allMessages.filter((message) => message.eventIndex < lastBoundary);
    const targetIndices = sessionCuts.map((cut) => messages.filter((message) => message.eventIndex < cut.boundaryLine).length - 1);
    const tree = buildTree(messages, { budgetTokens, atMessageIndices: targetIndices });
    let paid = { spent: 0, calls: 0, cachedHits: 0, paidMerges: 0, skippedMerges: 0, truncatedMerges: 0 };
    if (!dry) {
      paid = await hydrateTree(tree, {
        cache,
        maxSpend: spendCap,
        spentBefore: totalSpent,
        maxCalls: MAX_CALLS_PER_SESSION,
        onCacheWrite: () => writeJson(cacheFile, cache),
        mergeBatch: async (prompt, tasks, remaining) => {
          const response = await runClaude(prompt, remaining, { badReplyDir: path.join(outDir, 'bad-replies') });
          // The ids in the prompt are exact, but validate against this batch to reject partial JSON responses.
          const merged = validateMergeResponse(JSON.stringify({ merges: [...response.merged].map(([id, text]) => ({ id, text })) }), tasks);
          return { ...response, merged };
        },
      });
      totalSpent = paid.spent;
      writeJson(cacheFile, cache);
    }
    for (const snap of Object.values(tree.snapshots)) snap.tokens = viewTokens(tree, snap);
    const treePath = path.join(outDir, `tree-${safeKey(source)}.json`);
    writeJson(treePath, tree);
    const viewRows = [];
    for (const cut of sessionCuts) {
      const { messageCount, snapshot: snap } = viewAtCut(tree, cut, messages);
      const viewText = renderView(tree, snap);
      const viewFile = path.join(outDir, `cut-${cut.id}.view.txt`);
      fs.writeFileSync(viewFile, `${viewText}${viewText ? '\n' : ''}`, { mode: 0o600 });
      viewRows.push({ id: cut.id, boundaryLine: cut.boundaryLine, messageCount, tokens: tokens(viewText), nodes: snap.nodeIds.length, path: viewFile });
    }
    const maxPaidTasks = tree.metrics.paidMerges;
    const leaves = Object.values(tree.nodes).filter((node) => node.level === 0);
    const paidByLevel = new Map();
    for (const id of tree.mergeOrder) {
      const node = tree.nodes[id];
      if (!node.free) paidByLevel.set(node.level, (paidByLevel.get(node.level) ?? 0) + 1);
    }
    const estimatedCalls = [...paidByLevel.values()].reduce((sum, count) => sum + Math.ceil(count / MERGE_BATCH_SIZE), 0);
    const maxEstimatedUsd = tree.mergeOrder.reduce((sum, id) => {
      const node = tree.nodes[id];
      if (node.free) return sum;
      const prompt = mergePrompt([{ id, leftText: tree.nodes[node.children[0]].text, rightText: tree.nodes[node.children[1]].text }]);
      return sum + estimateBatchUsd(prompt, 1);
    }, 0);
    const metrics = {
      transcript: path.basename(source), lineCount,
      level0Messages: tree.metrics.level0,
      level0SizeBytes: leaves.reduce((sum, node) => sum + Buffer.byteLength(node.text, 'utf8'), 0),
      level0Tokens: leaves.reduce((sum, node) => sum + tokens(node.text), 0),
      merges: tree.metrics.merges,
      freeMerges: tree.metrics.freeMerges,
      paidMergeUpperBound: maxPaidTasks,
      estimatedPaidCallsAtBatchSize100: estimatedCalls,
      estimatedPaidUsd: Number(maxEstimatedUsd.toFixed(4)),
      paidCallsMade: paid.calls,
      paidMergesUsed: paid.paidMerges,
      cachedMerges: paid.cachedHits,
      skippedPaidMerges: paid.skippedMerges,
      truncatedMerges: paid.truncatedMerges,
      spentUsd: Number(paid.spent.toFixed(4)),
      views: viewRows,
      treeFile: treePath,
    };
    writeJson(path.join(outDir, `metrics-${safeKey(source)}.json`), metrics);
    allMetrics.push(metrics);
    const mode = dry ? 'dry' : 'paid';
    if (!dry) process.stdout.write(`paid-counts ${path.basename(source)}: ${paid.paidMerges} paid, ${paid.cachedHits} cached, ${paid.truncatedMerges} truncated (fallback), ${paid.skippedMerges} skipped (cap), ${paid.calls} calls\n`);
    process.stdout.write(`${mode} ${path.basename(source)}: ${tree.metrics.level0} messages, ${tree.metrics.merges} merges (${tree.metrics.freeMerges} free, ${tree.metrics.paidMerges} batch candidates), ${viewRows.length} cut views, est ~$${maxEstimatedUsd.toFixed(3)}, calls <=${estimatedCalls}${dry ? '' : `, used ${paid.paidMerges} paid/${paid.cachedHits} cached, ${paid.calls} calls, $${paid.spent.toFixed(3)}`}\n`);
  }
  writeJson(path.join(outDir, 'metrics.json'), { mode: dry ? 'dry' : 'paid', budgetTokens, sessions: allMetrics, totalSpentUsd: Number(totalSpent.toFixed(4)) });
}

function parseArgs(argv) {
  let dumpDir, outDir, treeFile, zoomId, depth = 1, budgetTokens = DEFAULT_VIEW_BUDGET;
  let dry = false, paid = false, selectedCuts;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dump') dumpDir = argv[++i];
    else if (argv[i] === '--out') outDir = argv[++i];
    else if (argv[i] === '--tree') treeFile = argv[++i];
    else if (argv[i] === '--zoom') zoomId = argv[++i];
    else if (argv[i] === '--depth') depth = Number(argv[++i]);
    else if (argv[i] === '--budget') budgetTokens = Number(argv[++i]);
    else if (argv[i] === '--cuts') selectedCuts = new Set(String(argv[++i]).split(',').filter(Boolean));
    else if (argv[i] === '--dry') dry = true;
    else if (argv[i] === '--paid') paid = true;
    else throw new Error(`unknown option: ${argv[i]}`);
  }
  if (treeFile && zoomId) return { treeFile, zoomId, depth };
  if (!dumpDir || !outDir || dry === paid) throw new Error('Usage: tree.mjs --dump <cut-dump> --out <dir> (--dry|--paid) [--cuts ids] [--budget 2500]');
  return { dumpDir, outDir, dry, selectedCuts, budgetTokens };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.treeFile) {
    const tree = JSON.parse(fs.readFileSync(options.treeFile, 'utf8'));
    const expanded = zoom(tree, options.zoomId, options.depth);
    process.stdout.write(`${expanded.map((node) => `${renderNode(node)}${node.level === 0 ? `\n${JSON.stringify(node.original)}` : ''}`).join('\n')}\n`);
    return;
  }
  return processDump(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
