#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { recallSession } from '../../plugin/compact/recall/recall.mjs';
import { clean, blocks } from '../../plugin/compact/recall/shared.mjs';

const CORE = fileURLToPath(new URL('../../plugin/compact/core', import.meta.url));
const RECALL = fileURLToPath(new URL('../../plugin/compact/recall', import.meta.url));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const countTokens = (s) => Math.ceil(String(s ?? '').length / 4);

// The production core is TypeScript and uses .js specifiers for its build output.
// Resolve those specifiers to the source .ts modules without copying or changing core.
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(pathToFileURL(`${CORE}/`).href) && specifier.startsWith('./') && specifier.endsWith('.js')) {
    return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
  }
  return nextResolve(specifier, context);
} });
const loadCore = async (name) => import(pathToFileURL(path.join(CORE, `${name}.ts`)));
// 3.13.0 (S4m): mirror compact.ts's condensed user history when the core has it.
const historyCore = fs.existsSync(path.join(CORE, 'history.ts')) ? await loadCore('history') : null;
const historyForSeed = (texts) => {
  if (!historyCore) return { userInstructionsVerbatim: texts };
  const { messages, omittedCount } = historyCore.condenseUserHistory(texts);
  return { userInstructionsVerbatim: messages, ...(omittedCount > 0 ? { userHistoryNote: historyCore.historyOmittedNote(omittedCount) } : {}) };
};
const [seedCore, constraintsCore, factsCore, selectCore, tailCore, extractorCore, denseCore, budgetsCore, labelsCore, workStateCore, denseJevCore, sessionMapCore] = await Promise.all(
  ['seed', 'constraints', 'key-facts', 'select', 'tail', 'extractor', 'dense', 'budgets', 'labels', 'work-state', 'dense-jev', 'session-map'].map(loadCore));
// REPLAY_SESSION_MAP=0 leaves out the session map (one line per earlier compaction segment), as `sessionMap: false` does.
// 3.43.0 mirrors: REPLAY_TAIL_ESTIMATE=1 sizes the tail with estimateTokens (compact.ts), REPLAY_CURRENT_VALUES=1 adds
// the `## Current values` section from user messages (option currentValues).
const stateUpdatesCore = await loadCore('state-updates');
const TAIL_COUNT = ['1', 'pick'].includes(process.env.REPLAY_TAIL_ESTIMATE) ? budgetsCore.estimateTokens : countTokens;
// REPLAY_TAIL_ESTIMATE=pick: the estimate picks the tail, but the unused budget (spill to the seed) is counted at chars / 4.
const SPILL_COUNT = process.env.REPLAY_TAIL_ESTIMATE === 'pick' ? countTokens : TAIL_COUNT;
const CURRENT_VALUES_ENABLED = process.env.REPLAY_CURRENT_VALUES === '1';
const { timelineBuilder } = await import(pathToFileURL(path.join(CORE, '..', 'recall', 'timeline.mjs')));
const SESSION_MAP_ENABLED = process.env.REPLAY_SESSION_MAP !== '0';
const REPLAY_DENSE_JEV_SCORES = process.env.REPLAY_DENSE_JEV_SCORES
  ? fs.readFileSync(process.env.REPLAY_DENSE_JEV_SCORES, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((row) => typeof row.q === 'string' && typeof row.h === 'string' && typeof row.p === 'number' && Number.isFinite(row.p) && row.p >= 0 && row.p <= 1)
  : [];
if (process.env.REPLAY_DENSE_JEV_DUMP) {
  fs.mkdirSync(path.dirname(path.resolve(process.env.REPLAY_DENSE_JEV_DUMP)), { recursive: true });
  fs.writeFileSync(process.env.REPLAY_DENSE_JEV_DUMP, '');
}
// REPLAY_LABELS=<labels.jsonl>: S4n message labels (tools/real-replay/jev-labels.mjs), applied as compact.ts does.
const REPLAY_LABELS = process.env.REPLAY_LABELS ? labelsCore.parseLabels(fs.readFileSync(process.env.REPLAY_LABELS, 'utf8')) : null;
// E20: REPLAY_TOOL_DECISIONS=<decisions.jsonl> (tools/real-replay/jev-tool-outputs.mjs) drops Bash outputs Jev
// judged not needed; REPLAY_TOOL_KEPT_LINES=<n> is how many lines a kept output gives (default 10).
const REPLAY_TOOL_DECISIONS = process.env.REPLAY_TOOL_DECISIONS ? new Map(fs.readFileSync(process.env.REPLAY_TOOL_DECISIONS, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((d) => d.decision === 'keep' || d.decision === 'drop').map((d) => [d.id, d.decision])) : null;
const toolDeps = REPLAY_TOOL_DECISIONS ? { toolOutputDecision: (id) => REPLAY_TOOL_DECISIONS.get(id), toolOutputKeptLines: Number(process.env.REPLAY_TOOL_KEPT_LINES ?? 10) } : {};

async function parseJsonl(file) {
  const events = [];
  let malformed = 0;
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  let pending = '';
  for await (const chunk of input) {
    pending += chunk;
    let nl;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).replace(/\r$/, ''); pending = pending.slice(nl + 1);
      if (!line.trim()) continue;
      try { events.push({ event: JSON.parse(line), line }); } catch { malformed++; }
    }
  }
  if (pending.trim()) { try { events.push({ event: JSON.parse(pending), line: pending }); } catch { malformed++; } }
  return { events, malformed };
}

function eventText(event) { return clean(blocks(event?.message?.content)); }
function sessionMessage(event) {
  const content = event.message?.content;
  const parts = Array.isArray(content) ? content : [];
  const toolUses = parts.filter((x) => x?.type === 'tool_use').map((x) => ({ tool_use_id: x.id, tool: x.name, input: x.input }));
  const toolResults = parts.filter((x) => x?.type === 'tool_result').map((x) => ({ tool_use_id: x.tool_use_id, isError: !!x.is_error, text: blocks(x.content) }));
  return { role: event.type === 'assistant' ? 'assistant' : 'user', text: typeof content === 'string' ? content : parts.filter((x) => x?.type === 'text').map((x) => x.text ?? '').join('\n'), toolUses, ...(toolResults.length ? { toolResults } : {}) };
}
function isSummaryEvent(e) { return e.type === 'user' && (e.isCompactSummary === true || e.message?.isCompactSummary === true); }
function isBoundary(e) { return e.type === 'system' && e.subtype === 'compact_boundary'; }
function toolCalls(event) { return Array.isArray(event.message?.content) ? event.message.content.filter((x) => x?.type === 'tool_use') : []; }

const WORD = /\S+/g;
function contextWithout(text, start, end) {
  const words = [...String(text).matchAll(WORD)];
  const center = words.findIndex((m) => m.index <= start && m.index + m[0].length >= end);
  const from = Math.max(0, center - 8), to = Math.min(words.length, center + 9);
  return words.slice(from, to).filter((m) => m.index + m[0].length <= start || m.index >= end).map((m) => m[0]).join(' ');
}
const CANDIDATE_PATTERNS = [
  /`([^`\n]+)`/g,
  /\b(?:\d+(?:\.\d+)*(?:\s?(?:ms|s|sec|seconds?|minutes?|hours?|days?|%|MB|GB|KB|KiB|MiB|GiB|tokens?))|v\d+(?:\.\d+)+(?:[-+][\w.-]+)?)\b/gi,
  /\b[0-9a-f]{7,40}\b/gi,
  /\b[A-Z][A-Z0-9]*-\d+\b/g,
  /https?:\/\/[^\s\])}>"']+/gi,
  /["']([^"'\n]{3,80})["']/g,
];
function addItems(text, items, userText = false) {
  const source = String(text ?? '');
  for (const pattern of CANDIDATE_PATTERNS) {
    pattern.lastIndex = 0; let m;
    while ((m = pattern.exec(source))) {
      const quoted = pattern.source.startsWith('`') || pattern.source.startsWith('["\']');
      const value = (m[1] && quoted ? m[1] : m[0]).trim();
      if (!value || (!userText && pattern.source.startsWith('["\']'))) continue;
      const start = m.index + (value === m[0] ? 0 : m[0].indexOf(value));
      const key = value.toLocaleLowerCase();
      if (!items.has(key)) items.set(key, { item: value, contexts: [] });
      items.get(key).contexts.push(contextWithout(source, start, start + value.length));
    }
  }
}
function collectCandidateItems(events) {
  const items = new Map();
  for (const e of events) {
    const text = eventText(e);
    if (e.type === 'user') addItems(text, items, true);
    for (const call of toolCalls(e)) {
      if (!['Read', 'Edit', 'Write', 'Grep'].includes(call.name)) continue;
      const file = call.input?.file_path ?? call.input?.path;
      if (typeof file === 'string' && file) {
        const key = file.toLocaleLowerCase();
        if (!items.has(key)) items.set(key, { item: file, contexts: [] });
        items.get(key).contexts.push(contextWithout(JSON.stringify(call), JSON.stringify(call).indexOf(file), JSON.stringify(call).indexOf(file) + file.length));
      }
    }
    addItems(text, items);
  }
  return items;
}
function lowerContains(haystack, needle) { return String(haystack ?? '').toLocaleLowerCase().includes(String(needle).toLocaleLowerCase()); }
function textForEvent(e) {
  const parts = [eventText(e)];
  for (const call of toolCalls(e)) parts.push(JSON.stringify(call.input ?? {}));
  return parts.join('\n');
}
// REPLAY_STRICT_NEEDED=1: an item counts only when the agent wrote it (assistant text or tool input) or
// the user typed it, before any post-cut tool result showed it. Tool output (JSON keys, ls listings) is
// what the environment supplied, not what the agent had to carry across the cut.
function typedText(e) {
  const content = e.message?.content;
  if (typeof content === 'string') return clean(content);
  return Array.isArray(content) ? clean(content.filter((x) => x?.type === 'text').map((x) => x.text ?? '').join('\n')) : '';
}
// REPLAY_STRICT_NEEDED=used keeps items the agent wrote after looking them up again: a re-lookup is
// the cost of forgetting, and the strict mode's filter hides exactly those items.
function collectStrictItems(events, usedOnly = false) {
  const items = new Map();
  let seenInResults = '';
  const add = (text, userText) => {
    const found = new Map();
    addItems(text, found, userText);
    for (const [key, value] of found) if (!items.has(key) && (usedOnly || !seenInResults.includes(key))) items.set(key, value);
  };
  for (const e of events) {
    if (e.type === 'assistant') { add(typedText(e), false); for (const call of toolCalls(e)) add(JSON.stringify(call.input ?? {}), false); }
    else if (e.type === 'user') add(typedText(e), true);
    const results = (Array.isArray(e.message?.content) ? e.message.content : []).filter((x) => x?.type === 'tool_result').map((x) => blocks(x.content)).join('\n');
    if (results) seenInResults += `\n${results.toLocaleLowerCase()}`;
  }
  return items;
}
function neededItems(pre, post) {
  const preText = pre.map(textForEvent).join('\n');
  const candidates = process.env.REPLAY_STRICT_NEEDED === '1' ? collectStrictItems(post) : process.env.REPLAY_STRICT_NEEDED === 'used' ? collectStrictItems(post, true) : collectCandidateItems(post);
  return [...candidates.values()].filter((x) => lowerContains(preText, x.item));
}
function rereads(pre, post) {
  const seen = new Set();
  const results = new Map();
  for (const e of post) for (const part of e.message?.content ?? []) if (part?.type === 'tool_result' && part.tool_use_id) results.set(part.tool_use_id, blocks(part.content));
  const pathOf = (call) => call.input?.file_path ?? call.input?.path;
  for (const e of pre) for (const call of toolCalls(e)) if (call.name === 'Read' && typeof pathOf(call) === 'string') seen.add(pathOf(call).toLowerCase());
  const out = [];
  for (const e of post) for (const call of toolCalls(e)) if (call.name === 'Read' && typeof pathOf(call) === 'string' && seen.has(pathOf(call).toLowerCase())) {
    const result = results.get(call.id) ?? '';
    out.push({ path: pathOf(call), result });
  }
  return out;
}

function seedSections(seedText) {
  return countTokens(seedText);
}
let seedDumpCount = 0;
// Budget overrides let tools/real-replay sweep coverage against kept tokens; defaults match core/budgets.ts.
const envInt = (name, fallback) => { const v = Number(process.env[name]); return Number.isInteger(v) && v > 0 ? v : fallback; };
const SEED_BUDGET = envInt('REPLAY_SEED_BUDGET', budgetsCore.SEED_BUDGET_TOKENS);
const TAIL_BUDGET = envInt('REPLAY_TAIL_BUDGET', budgetsCore.TAIL_BUDGET_TOKENS);
const DENSE_BUDGET = envInt('REPLAY_DENSE_BUDGET', budgetsCore.DENSE_BUDGET_TOKENS);
const KEY_FACTS_BUDGET = envInt('REPLAY_KEY_FACTS_BUDGET', budgetsCore.KEY_FACTS_BUDGET_TOKENS);
const DENSE_NOTES_ENABLED = process.env.REPLAY_DENSE !== '0';
// REPLAY_DENSE_MAX_CANDIDATES=<n>: how many of the newest note lines the dense selector considers (plugin: 4000).
const DENSE_MAX_CANDIDATES = envInt('REPLAY_DENSE_MAX_CANDIDATES', 4000);
const TOOL_OUTPUT_NOTES_ENABLED = process.env.REPLAY_TOOL_OUTPUT !== '0';
const WORK_STATE_ENABLED = process.env.REPLAY_WORK_STATE !== '0';
function buildSeed(preEvents, priorSeedIndex, trigger = 'manual', accumulatedRecords = [], allPreEvents = preEvents) {
  const messages = preEvents.filter((e) => e.type === 'user' || e.type === 'assistant').filter((e) => !e.isSidechain).map(sessionMessage);
  const records = [...accumulatedRecords];
  const known = new Set(records.map((r) => `${r.kind}:${r.sourceHash}:${r.body.key ?? r.body.id ?? ''}`));
  for (const r of extractorCore.reconcile(messages, null, { hash: sha, toolOutputNotes: TOOL_OUTPUT_NOTES_ENABLED, ...toolDeps }).records) {
    const id = `${r.kind}:${r.sourceHash}:${r.body.key ?? r.body.id ?? ''}`;
    if (!known.has(id)) { records.push(r); known.add(id); }
  }
  let previousCwd;
  for (const event of preEvents) {
    const cwd = typeof event.cwd === 'string' ? event.cwd : typeof event.message?.cwd === 'string' ? event.message.cwd : undefined;
    if (cwd && cwd !== previousCwd) {
      records.push({ kind: 'work_event', origin: 'reconcile', producedBy: 's4-capture', sourceHash: `replay-cwd:${sha(`${records.length}:${cwd}`)}`, body: { type: 'cwd_snapshot', path: cwd } });
      previousCwd = cwd;
    }
  }
  // S4q FIX 1: queued completions may arrive outside ordinary user message text.
  const completionKeys = new Set(records.filter((r) => r.kind === 'work_event' && r.body?.type === 'bg_end').map((r) => `${r.body.id}:${r.body.status}`));
  const notificationSources = preEvents.flatMap((event) => [
    event.type === 'user' && typeof event.message?.content === 'string' ? event.message.content : '',
    event.attachment?.type === 'queued_command' && typeof event.attachment.prompt === 'string' ? event.attachment.prompt : '',
    event.type === 'queue-operation' && event.operation === 'enqueue' && typeof event.content === 'string' ? event.content : '',
  ]);
  for (const source of notificationSources) {
    for (const notification of workStateCore.parseTaskNotifications(source)) {
      const key = `${notification.id}:${notification.status}`;
      if (completionKeys.has(key)) continue;
      completionKeys.add(key);
      records.push({ kind: 'work_event', origin: 'reconcile', producedBy: 's4-capture', sourceHash: `replay-notification:${sha(key)}`, body: notification });
    }
  }
  const latest = new Map();
  for (const r of records) latest.set(`${r.kind}:${r.kind === 'work_event' ? r.sourceHash : r.body.key ?? r.body.id ?? r.sourceHash}`, r);
  const userRecords = [...latest.values()].filter((r) => r.kind === 'user');
  // As compact.ts (S4n): chat drops from history except the last three, question/consent keep only
  // hard-rule sentences in Constraints, question/chat stay out of key facts, dense sees the label.
  const labelOf = (r) => (REPLAY_LABELS ? REPLAY_LABELS.get(labelsCore.labelKey(String(r.body.text ?? ''), sha)) : undefined);
  const historyCutoff = Math.max(0, userRecords.length - 3);
  const users = REPLAY_LABELS ? userRecords.filter((r, i) => labelOf(r) !== 'chat' || i >= historyCutoff) : userRecords;
  const constraintRecords = REPLAY_LABELS ? userRecords.flatMap((r) => {
    const label = labelOf(r);
    if (label === 'chat') return [];
    if (label !== 'question' && label !== 'consent') return [r];
    const rules = labelsCore.ruleSentences(String(r.body.text ?? ''));
    return rules ? [{ ...r, body: { ...r.body, text: rules } }] : [];
  }) : userRecords;
  const textList = (kind) => [...latest.values()].filter((r) => r.kind === kind).map((r) => String(r.body.text ?? '')).filter(Boolean);
  const constraints = constraintsCore.applyConstraintOverflow(constraintsCore.extractConstraints(constraintRecords, sha), countTokens, sha);
  const constraintsText = constraintsCore.renderConstraintsSection(constraints.rendered);
  const keyFacts = factsCore.applyKeyFactsOverflow(factsCore.extractKeyFacts([...latest.values()].filter((r) => r.kind === 'file_write' || (r.kind === 'user' && !['question', 'chat'].includes(labelOf(r) ?? ''))), sha), countTokens, sha, KEY_FACTS_BUDGET /* budgets.ts KEY_FACTS_BUDGET_TOKENS */);
  const keyFactsText = factsCore.renderKeyFactsSection(keyFacts.rendered);
  let workStateText;
  if (WORK_STATE_ENABLED) {
    const sessionCwd = String(previousCwd ?? '/');
    const state = workStateCore.foldWorkState([...latest.values()].filter((record) => record.kind === 'work_event').map((record) => record.body), sessionCwd);
    workStateText = workStateCore.renderWorkState(state, undefined, budgetsCore.WORK_STATE_BUDGET_TOKENS, countTokens, sessionCwd);
  }
  const reasoning = [...latest.values()].filter((r) => r.kind === 'assistant_text');
  const candidates = reasoning.map((r, i) => ({ id: String(i), tokens: countTokens(String(r.body.text ?? '')), alwaysKeep: false, valueDensity: 1, recency: i, text: String(r.body.text ?? '') }));
  const selected = new Set(selectCore.select(candidates, { contract: '', todo: textList('todo').join('\n'), lastUserMessages: users.map((r) => String(r.body.text ?? '')).slice(-3) }, Math.max(0, SEED_BUDGET - countTokens(constraintsText) - countTokens(keyFactsText) - countTokens(workStateText ?? ''))));
  const selectedReasoning = reasoning.filter((_, i) => selected.has(String(i))).map((r) => String(r.body.text ?? '')).join('\n');
  const filePointers = textList('file').map((s) => s).join('\n');
  const tail = tailCore.pickTail(messages, { budgetTokens: TAIL_BUDGET, countTokens: TAIL_COUNT, hash: sha, rebuildThresholdTokens: 2000, trigger });
  // As compact.ts (S4q): tail budget the tail did not use goes to the dense notes and the seed cap. REPLAY_SPILL=0 turns it off.
  const tailUsed = SPILL_COUNT(tail.messages.map((m) => [m.text, ...m.toolUses.map((u) => JSON.stringify(u.input ?? {})), ...(m.toolResults ?? []).map((r) => r.text)].join('\n')).join('\n'));
  const spill = process.env.REPLAY_SPILL === '0' ? 0 : Math.max(0, TAIL_BUDGET - tailUsed);
  const denseTailText = tail.messages.map((m) => [m.text, ...m.toolUses.map((u) => JSON.stringify(u.input ?? {})), ...(m.toolResults ?? []).map((r) => r.text)].join('\n')).join('\n');
  const denseCoveredText = `${denseTailText}\n${constraintsText}\n${workStateText ?? ''}\n${historyForSeed(users.map((r) => String(r.body.text ?? ''))).userInstructionsVerbatim.join('\n')}\n${textList('value').join('\n')}\n${textList('todo').join('\n')}\n${[...latest.values()].filter((r) => r.kind === 'gate' || r.kind === 'error').map((r) => JSON.stringify(r.body)).join('\n')}`;
  const denseCandidates = DENSE_NOTES_ENABLED ? denseCore.denseCandidates([...latest.values()].map((r) => { const label = r.kind === 'user' ? labelOf(r) : undefined; return label === undefined ? r : { ...r, body: { ...r.body, label } }; }), DENSE_MAX_CANDIDATES) : [];
  const denseQuery = denseJevCore.denseJevQuery(denseTailText, users.map((r) => String(r.body.text ?? '')).slice(-3));
  const denseQ = sha(denseQuery).slice(0, 16);
  const askableDenseCandidates = DENSE_NOTES_ENABLED ? denseCore.denseJevCandidates(denseCandidates, denseCoveredText, DENSE_MAX_CANDIDATES) : [];
  if (process.env.REPLAY_DENSE_JEV_DUMP) {
    fs.appendFileSync(process.env.REPLAY_DENSE_JEV_DUMP, `${JSON.stringify({ q: denseQ, query: denseQuery, cands: askableDenseCandidates.map((candidate) => ({ h: denseCore.denseCandidateKey(candidate.text, sha), text: candidate.text })) })}\n`);
  }
  const denseScoresForCut = new Map(REPLAY_DENSE_JEV_SCORES.filter((row) => row.q === denseQ).map((row) => [row.h, row.p]));
  const denseText = DENSE_NOTES_ENABLED
    ? denseCore.renderDense(denseCore.selectDense(denseCandidates, denseCoveredText, DENSE_BUDGET + spill, countTokens, denseScoresForCut.size ? denseScoresForCut : undefined, DENSE_MAX_CANDIDATES))
    : undefined;
  let transcriptPointer;
  const prevText = priorSeedIndex >= 0 ? (preEvents.find((e) => typeof e.message?.content === 'string' && e.message.content.startsWith('[[exovault:s4-seed:v1]]'))?.message.content ?? '') : '';
  const pointerMatch = prevText.match(/^## Transcript\n([\s\S]*?)(?=\n\n## |\n\n\[omitted-history:|$)/m);
  if (pointerMatch && pointerMatch[1] !== '(none)') transcriptPointer = pointerMatch[1];
  let sessionMapText = '';
  if (SESSION_MAP_ENABLED) {
    const timeline = timelineBuilder();
    for (const e of allPreEvents) timeline.add(e);
    sessionMapText = sessionMapCore.renderSessionMap(timeline.result(), countTokens);
  }
  const currentValuesText = CURRENT_VALUES_ENABLED ? stateUpdatesCore.renderStateUpdates(stateUpdatesCore.extractStateUpdates(userRecords.map((r) => String(r.body.text ?? ''))), countTokens) : '';
  const rendered = seedCore.renderSeed({ constraints: constraintsText, ...(currentValuesText ? { currentValues: currentValuesText } : {}), ...(workStateText ? { workState: workStateText } : {}), ...(sessionMapText ? { sessionMap: sessionMapText } : {}), ...(DENSE_NOTES_ENABLED ? { denseNotes: denseText } : { keyFacts: keyFactsText }), contract: '', todo: textList('todo').join('\n'), ...historyForSeed(users.map((r) => String(r.body.text ?? ''))), values: textList('value').join('\n'), selectedReasoning: DENSE_NOTES_ENABLED ? '' : selectedReasoning, gatesAndErrors: [...latest.values()].filter((r) => r.kind === 'gate' || r.kind === 'error').map((r) => JSON.stringify(r.body)).join('\n'), filePointers, transcriptPointer }, tail.omittedCount, SEED_BUDGET + spill, countTokens);
  if (process.env.REPLAY_SEED_DUMP) { fs.mkdirSync(process.env.REPLAY_SEED_DUMP, { recursive: true }); fs.writeFileSync(path.join(process.env.REPLAY_SEED_DUMP, `seed-${String(++seedDumpCount).padStart(3, '0')}.txt`), rendered.message.text); }
  const tailText = tail.messages.map((m) => [m.text, ...m.toolUses.map((u) => JSON.stringify(u.input ?? {})), ...(m.toolResults ?? []).map((r) => r.text)].join('\n')).join('\n');
  if (process.env.REPLAY_SEED_DUMP) fs.writeFileSync(path.join(process.env.REPLAY_SEED_DUMP, `tail-${String(seedDumpCount).padStart(3, '0')}.txt`), tailText);
  const constraintLines = constraintsText.split('\n').filter((line) => /^\s*[-*>]/.test(line));
  return { text: rendered.message.text, tailText, tailMessages: tail.messages, records, constraintLines: constraintLines.length, constraintQuestionLines: constraintLines.filter((line) => /\?\s*(?:\[[^\]]*\])?\s*$/.test(line)).length };
}

function nativeSummary(events, start, stop) {
  for (let i = start + 1; i < stop; i++) if (isSummaryEvent(events[i])) {
    const c = events[i].message?.content;
    return typeof c === 'string' ? c : blocks(c);
  }
  return '';
}
// Native compaction keeps more than the summary: a short preserved segment of the last pre-cut
// messages (compactMetadata.preservedSegment.headUuid) and re-attached recent files. Count both.
function nativeKept(events, boundaryIndex, nextBoundary) {
  const meta = events[boundaryIndex].compactMetadata ?? {};
  const head = meta.preservedSegment?.headUuid;
  let headIndex = head ? events.findIndex((e, i) => i < boundaryIndex && e.uuid === head) : -1;
  if (headIndex < 0) headIndex = boundaryIndex;
  const preserved = events.slice(headIndex, boundaryIndex).map(textForEvent).join('\n');
  const attachments = [];
  for (let i = boundaryIndex + 1; i < nextBoundary; i++) {
    const e = events[i];
    if (e.type === 'attachment') { if (['file', 'compact_file_reference'].includes(e.attachment?.type)) attachments.push(JSON.stringify(e.attachment)); continue; }
    if (isSummaryEvent(e)) continue;
    break;
  }
  return { preserved, attachments: attachments.join('\n') };
}
function preservedUuids(meta) { return new Set(meta?.preservedMessages?.allUuids ?? []); }
function buildRecallIndex(preEvents, tempRoot, sessionId) {
  const transcript = path.join(tempRoot, 'prefix.jsonl');
  const lines = preEvents.map((e) => JSON.stringify(e));
  fs.writeFileSync(transcript, lines.length ? `${lines.join('\n')}\n` : '');
  const cutoff = fs.statSync(transcript).size;
  const indexRoot = path.join(tempRoot, 'index');
  const emptyProject = path.join(tempRoot, 'project'); fs.mkdirSync(emptyProject, { recursive: true });
  const result = spawnSync(process.execPath, [path.join(RECALL, 'build-worker.mjs'), transcript, indexRoot, sessionId, String(cutoff), emptyProject], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`recall index build failed: ${result.stderr || result.stdout}`);
  return { indexRoot, cutoff };
}
function scoreRecall(needed, recall, diag) {
  return needed.map((x) => {
    const queries = x.contexts.filter(Boolean);
    let rank = -1;
    for (const q of queries) {
      const hits = recall(q, diag ? 5 : 3).hits ?? [];
      const at = hits.findIndex((hit) => lowerContains(hit.text, x.item));
      if (at >= 0 && (rank < 0 || at < rank)) rank = at;
      if (rank === 0 || (!diag && rank >= 0)) break;
    }
    const covered = rank >= 0 && rank < 3;
    let kwRank = -1, kwQuery = '';
    if (diag) {
      kwQuery = keywordQuery(queries.join(' '), x.item);
      if (kwQuery) kwRank = (recall(kwQuery, 5).hits ?? []).findIndex((hit) => lowerContains(hit.text, x.item));
    }
    // REPLAY_RECALL_DIAG=<file>: per item, whether any indexed chunk holds it at all (the ceiling) and its best rank.
    // Lookups by the value itself and by a variant an agent would type (hash prefix, number written another way).
    let exactRank = -1, variant = '', variantRank = -1;
    if (diag) {
      exactRank = (recall(x.item, 5).hits ?? []).findIndex((hit) => lowerContains(hit.text, x.item));
      variant = valueVariant(x.item);
      if (variant) variantRank = (recall(variant, 5).hits ?? []).findIndex((hit) => lowerContains(hit.text, x.item));
    }
    if (diag) fs.appendFileSync(diag.file, `${JSON.stringify({ cut: diag.cut, item: x.item, inIndex: diag.rows.some((r) => lowerContains(r.text, x.item)), rank, kwRank, kwQuery, query: queries[0] ?? '', exactRank, variant, variantRank })}\n`);
    return { ...x, recall: covered };
  });
}
/** A hex hash cut to 7 characters, or a number of 6+ digits with its separators removed (or added in groups of 3). */
export function valueVariant(item) {
  const v = String(item).trim();
  if (/^[0-9a-f]{8,40}$/i.test(v) && /\d/.test(v) && /[a-f]/i.test(v)) return v.slice(0, 7);
  const digits = v.replace(/\D/g, '');
  if (digits.length < 6 || !/^\+?[\d\s().\/-]+$/.test(v)) return '';
  return digits === v ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : digits;
}
// Agent-style query: up to six specific terms from the context (identifier-like first, then long words), item removed.
function keywordQuery(context, item) {
  const lowerItem = String(item).toLowerCase();
  // The last ten stop words are Polish: the plugin also reads messages written in Polish.
  const words = [...new Set((String(context).replace(/<[^>]{0,80}>/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}_.:/@#-]*/gu) ?? []).map((w) => w.replace(/[.:]+$/, '')))]
    .filter((w) => w.length > 3 && !lowerItem.includes(w.toLowerCase()) && !/^(this|that|with|from|have|will|what|when|there|their|about|which|would|should|could|dla|jest|oraz|przez|jako|tylko|jeszcze|które|który|która)$/i.test(w));
  const specific = words.filter((w) => /\d|[_./:@#-]|[a-z][A-Z]/.test(w));
  const long = words.filter((w) => !specific.includes(w)).sort((a, b) => b.length - a.length);
  return [...specific, ...long].slice(0, 6).join(' ');
}
function indexRows(indexRoot) {
  const [dir] = fs.readdirSync(indexRoot);
  const gen = Number(fs.readFileSync(path.join(indexRoot, dir, 'CURRENT'), 'utf8').trim());
  return JSON.parse(fs.readFileSync(path.join(indexRoot, dir, `generation-${String(gen).padStart(8, '0')}`, 'records.json'), 'utf8'));
}
function summarizeBoundary(events, boundaryIndex, nextBoundary, tempRoot, file, number, priorSeedIndex = -1, accumulatedRecords = []) {
  const allPre = events.slice(0, boundaryIndex).map((x) => x.event);
  const seedPre = events.slice(priorSeedIndex >= 0 ? priorSeedIndex : 0, boundaryIndex).map((x) => x.event);
  const kept = preservedUuids(events[boundaryIndex].event.compactMetadata);
  // The summary, re-attached files and preserved-message copies are what compaction injected, not
  // what the agent did after the cut; counting them as "needed" inflated native coverage.
  const post = events.slice(boundaryIndex, nextBoundary).map((x) => x.event).filter((e) => !isSummaryEvent(e) && e.type !== 'attachment' && !kept.has(e.uuid));
  const native = nativeSummary(events.map((x) => x.event), boundaryIndex, nextBoundary);
  const seedStarted = performance.now();
  const seedReplay = buildSeed(seedPre, priorSeedIndex, events[boundaryIndex].event.compactMetadata?.trigger ?? 'manual', accumulatedRecords, allPre);
  const seedMs = Math.round(performance.now() - seedStarted);
  const seed = seedReplay.text;
  const s4Full = `${seed}\n${seedReplay.tailText}`;
  const nk = nativeKept(events.map((x) => x.event), boundaryIndex, nextBoundary);
  const nativeFull = `${native}\n${nk.preserved}\n${nk.attachments}`;
  const needed = neededItems(allPre, post);
  const reread = rereads(allPre, post);
  // REPLAY_NO_RECALL=1 skips the per-cut index build (the slow part) for budget sweeps; recall columns read 0.
  const noRecall = process.env.REPLAY_NO_RECALL === '1';
  const recall = noRecall ? undefined : buildRecallIndex(allPre, tempRoot, events[0]?.event?.sessionId ?? path.basename(file, '.jsonl'));
  const scored = noRecall ? needed.map((x) => ({ ...x, recall: false })) : scoreRecall(needed, (query, k) => recallSession(recall.indexRoot, events[0]?.event?.sessionId ?? path.basename(file, '.jsonl'), query, k, recall.cutoff) ?? { hits: [] }, process.env.REPLAY_RECALL_DIAG ? { file: process.env.REPLAY_RECALL_DIAG, cut: `${path.basename(file).slice(0, 8)}#${number}`, rows: indexRows(recall.indexRoot) } : undefined);
  // REPLAY_RECALL_DUMP=<dir>: the cut's index rows and the needed items with all their contexts, for offline ranker work.
  if (process.env.REPLAY_RECALL_DUMP && !noRecall) {
    fs.mkdirSync(process.env.REPLAY_RECALL_DUMP, { recursive: true });
    fs.writeFileSync(path.join(process.env.REPLAY_RECALL_DUMP, `${path.basename(file).slice(0, 8)}-${String(number).padStart(2, '0')}.json`), JSON.stringify({ cut: `${path.basename(file).slice(0, 8)}#${number}`, cutoff: recall.cutoff, rows: indexRows(recall.indexRoot), items: needed.map((x) => ({ item: x.item, contexts: x.contexts.filter(Boolean) })) }));
  }
  const nativeCovered = scored.filter((x) => lowerContains(native, x.item)).length;
  const seedCovered = scored.filter((x) => lowerContains(seed, x.item)).length;
  const recallCovered = scored.filter((x) => x.recall).length;
  // REPLAY_PROBE_DUMP=<dir> writes what each side keeps plus the needed items with their masked context,
  // for the model-based fill-in probe (tools/real-replay/cloze.mjs). The dump holds transcript text: keep it outside the repo.
  if (process.env.REPLAY_PROBE_DUMP) {
    fs.mkdirSync(process.env.REPLAY_PROBE_DUMP, { recursive: true });
    const id = `${path.basename(file, '.jsonl').slice(0, 8)}-${String(number).padStart(2, '0')}`;
    // What the native compactor read: everything since the previous boundary (its summary included),
    // tool inputs cut to 600 and results to 2000 characters. Input for a cheap-model summary arm.
    let prev = boundaryIndex - 1;
    while (prev >= 0 && !isBoundary(events[prev].event)) prev--;
    const preText = events.slice(prev + 1, boundaryIndex).map((x) => x.event).filter((e) => (e.type === 'user' || e.type === 'assistant') && !e.isSidechain).map((e) => {
      const m = sessionMessage(e);
      return [m.text ? `${m.role}: ${m.text}` : '', ...m.toolUses.map((u) => `tool ${u.tool}: ${JSON.stringify(u.input ?? {}).slice(0, 600)}`), ...(m.toolResults ?? []).map((r) => `result${r.isError ? ' (error)' : ''}: ${String(r.text).slice(0, 2000)}`)].filter(Boolean).join('\n');
    }).filter(Boolean).join('\n\n');
    fs.writeFileSync(path.join(process.env.REPLAY_PROBE_DUMP, `pre-${id}.txt`), preText);
    fs.writeFileSync(path.join(process.env.REPLAY_PROBE_DUMP, `cut-${id}.json`), JSON.stringify({ id, source: path.resolve(file), boundaryUuid: events[boundaryIndex].event.uuid ?? null, boundaryLine: boundaryIndex, sessionId: events[0]?.event?.sessionId ?? path.basename(file, '.jsonl'), nativeFull, native, preserved: nk.preserved, attachments: nk.attachments, seed, tail: seedReplay.tailText, s4Full, items: scored.map((x) => ({ item: x.item, context: x.contexts?.[0] ?? '' })) }));
  }
  const seedEventIndex = events.findIndex((x, i) => i > boundaryIndex && i < nextBoundary && x.event.type === 'user' && typeof x.event.message?.content === 'string' && x.event.message.content.startsWith('[[exovault:s4-seed:v1]]'));
  return { file, kind: file.includes('/subagents/') ? 'subagent' : 'main', boundary: number, nativeChars: native.length, nativeTokens: countTokens(native), seedTokens: seedSections(seed), needed: scored.length, coverage: { a: nativeCovered, b: seedCovered, c: recallCovered, bOrC: scored.filter((x) => lowerContains(seed, x.item) || x.recall).length, nativeFull: scored.filter((x) => lowerContains(nativeFull, x.item)).length, s4Full: scored.filter((x) => lowerContains(s4Full, x.item)).length, nativeFullRecall: scored.filter((x) => lowerContains(nativeFull, x.item) || x.recall).length, s4FullRecall: scored.filter((x) => lowerContains(s4Full, x.item) || x.recall).length }, nativeFullTokens: countTokens(nativeFull), s4FullTokens: countTokens(s4Full), nativeDurationMs: events[boundaryIndex].event.compactMetadata?.durationMs ?? null, seedMs, nativePreTokens: events[boundaryIndex].event.compactMetadata?.preTokens ?? null, rereads: reread.length, rereadTokens: countTokens(reread.map((x) => x.result).join('\n')), items: scored.map((x) => ({ item: x.item, a: lowerContains(native, x.item), b: lowerContains(seed, x.item), c: x.recall, nativeFull: lowerContains(nativeFull, x.item), s4Full: lowerContains(s4Full, x.item) })), malformedLines: 0, constraintLines: seedReplay.constraintLines, constraintQuestionLines: seedReplay.constraintQuestionLines, seedEventIndex, captureRecords: seedReplay.records };
}

export function extractCandidateItems(events) { return collectCandidateItems(events); }
/**
 * E20: every Bash output that reaches capture, as S4 captures it (redacted, sensitive commands skipped),
 * with `maxLines` lines, its redacted command and the last user messages before it: `{ id, command, text, context }`.
 */
export async function toolOutputTargets(file, maxLines = 30) {
  const { events } = await parseJsonl(file);
  const all = events.map((x) => x.event).filter((e) => (e.type === 'user' || e.type === 'assistant') && !e.isSidechain);
  const ends = [...splitBoundaries(events).map((bd) => bd.start), events.length];
  const out = new Map();
  for (const end of ends) {
    const messages = events.slice(0, end).map((x) => x.event).filter((e) => all.includes(e)).map(sessionMessage);
    const users = [];
    const commands = new Map();
    for (const r of extractorCore.reconcile(messages, null, { hash: sha, toolOutputDecision: () => 'keep', toolOutputKeptLines: maxLines }).records) {
      if (r.kind === 'user') users.push(String(r.body.text ?? ''));
      if (r.kind === 'tool_activity') commands.set(String(r.sourceHash).split(':').pop(), String(r.body.text ?? ''));
      if (r.kind === 'tool_output' && !out.has(r.body.tool_use_id)) out.set(r.body.tool_use_id, { id: r.body.tool_use_id, command: commands.get(r.body.tool_use_id) ?? '', text: String(r.body.text ?? ''), context: users.slice(-3).map((t) => labelsCore.capturedUserText(t).slice(0, 600)) });
    }
  }
  return [...out.values()];
}
/** Unique user capture records of a transcript as S4n labels them: `{ key, text }` (jev-labels.mjs). */
export async function labelTargets(file) {
  const { events } = await parseJsonl(file);
  // Every prefix the replay reconciles (each cut, and the whole file): a later summary can hide
  // earlier messages from one whole-file pass.
  const ends = [...splitBoundaries(events).map((b) => b.start), events.length];
  const out = new Map();
  for (const end of ends) {
    const messages = events.slice(0, end).map((x) => x.event).filter((e) => (e.type === 'user' || e.type === 'assistant') && !e.isSidechain).map(sessionMessage);
    for (const r of extractorCore.reconcile(messages, null, { hash: sha }).records) {
      if (r.kind !== 'user') continue;
      const text = String(r.body.text ?? '');
      const key = labelsCore.labelKey(text, sha);
      if (key !== undefined && !out.has(key)) out.set(key, { key, text });
    }
  }
  return [...out.values()];
}
export { lowerContains as coverageContains, rereads as detectRereads };
export function splitBoundaries(events) {
  const indices = events.map((x, i) => isBoundary(x.event ?? x) ? i : -1).filter((i) => i >= 0);
  return indices.map((index, n) => ({ start: index, end: indices[n + 1] ?? events.length }));
}
export async function main(argv = process.argv.slice(2)) {
  const paths = []; let out;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i]; else paths.push(argv[i]);
  }
  if (!paths.length || !out) throw new Error('Usage: node real-replay.mjs <transcript.jsonl>... --out <report.json>');
  const report = { tokenCounter: 'ceil(chars/4)', files: [], aggregate: null, limits: [
    'The needed-after-cut proxy only counts enumerated paths, backticked identifiers, selected numeric/version/hash/ticket/URL patterns, and quoted user strings that also appear before the cut.',
    'Verbatim coverage does not measure whether a summary preserves the relationship or meaning around an item.',
    'Recall coverage uses one deterministic lexical query made from up to eight surrounding words, with the item removed, and checks the top three results.',
    'Re-read result tokens use chars/4 over available matching Read tool results; transcripts without joined tool results may undercount.',
    'The S4 seed replay uses current pure core modules with a fixed 6000-token seed and 10000-token tail budget; host-specific transient state is not reconstructed.',
    "Native kept = summary + preserved pre-cut segment (compactMetadata.preservedSegment) + re-attached file attachments. S4 kept = seed + picked tail. The summary, attachments and preserved-message copies are excluded from the post-cut needed items."
  ] };
  for (const file of paths) {
    const { events, malformed } = await parseJsonl(file);
    const boundaries = splitBoundaries(events);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'real-replay-'));
    try {
      let priorSeedIndex = -1, captureRecords = [];
      boundaries.forEach((b, i) => {
        const row = summarizeBoundary(events, b.start, b.end, tempRoot, file, i + 1, priorSeedIndex, captureRecords);
        priorSeedIndex = row.seedEventIndex;
        captureRecords = row.captureRecords;
        delete row.seedEventIndex; delete row.captureRecords;
        row.malformedLines = malformed;
        report.files.push(row);
      });
    } finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
  }
  const rows = report.files;
  const sum = (f) => rows.reduce((n, r) => n + r[f], 0);
  report.aggregate = { boundaries: rows.length, nativeTokens: sum('nativeTokens'), seedTokens: sum('seedTokens'), needed: sum('needed'), coverage: { a: rows.reduce((n, r) => n + r.coverage.a, 0), b: rows.reduce((n, r) => n + r.coverage.b, 0), c: rows.reduce((n, r) => n + r.coverage.c, 0), bOrC: rows.reduce((n, r) => n + r.coverage.bOrC, 0), ...Object.fromEntries(['nativeFull', 's4Full', 'nativeFullRecall', 's4FullRecall'].map((k) => [k, rows.reduce((n, r) => n + r.coverage[k], 0)])) }, nativeFullTokens: sum('nativeFullTokens'), s4FullTokens: sum('s4FullTokens'), nativeDurationMs: rows.reduce((n, r) => n + (r.nativeDurationMs ?? 0), 0), nativePreTokens: rows.reduce((n, r) => n + (r.nativePreTokens ?? 0), 0), rereads: sum('rereads'), rereadTokens: sum('rereadTokens'), constraintLines: sum('constraintLines'), constraintQuestionLines: sum('constraintQuestionLines'), malformedLines: [...new Set(rows.map((r) => r.file))].reduce((n, file) => n + (rows.find((r) => r.file === file)?.malformedLines ?? 0), 0) };
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(renderMarkdown(report));
  return report;
}
export function renderMarkdown(report) {
  const lines = ['| Transcript | Boundary | Native ms | Native kept tok | S4 kept tok | Needed | Native summary | Native kept | S4 seed | S4 seed+tail | Recall | Native kept+recall | S4 seed+tail+recall | Re-reads |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  const row = (name, b, r) => `| ${name} | ${b} | ${r.nativeDurationMs ?? ''} | ${r.nativeFullTokens} | ${r.s4FullTokens} | ${r.needed} | ${r.coverage.a} | ${r.coverage.nativeFull} | ${r.coverage.b} | ${r.coverage.s4Full} | ${r.coverage.c} | ${r.coverage.nativeFullRecall} | ${r.coverage.s4FullRecall} | ${r.rereads} |`;
  for (const r of report.files) lines.push(row(path.basename(r.file).slice(0, 8), r.boundary, r));
  lines.push(row('**Aggregate**', report.aggregate.boundaries, report.aggregate));
  return `${lines.join('\n')}\n`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
export { buildSeed, summarizeBoundary };
