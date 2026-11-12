#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isSummaryEvent, parseJsonl, sessionMessage, splitBoundaries, toolUses } from './transcript-parser.mjs';
import { assistantCalls as seedAssistantCalls, findInjectedCut, SEED_SENTINEL, ASSISTANT_CALL_WINDOW, tailContext } from './seed-sections.mjs';

const INJECTION_GRACE_MS = 2000;
const DEFAULT_OUT = '/tmp/exo-compact-recalluse/run1.json';
const CATEGORIES = ['recall', 'rederive', 'user', 'none'];
const ITEM_RULES = ['path', 'sha', 'uuid', 'issueNumber', 'jobId'];
const SHORT_ISSUE_PATTERN = /^#\d{1,2}$/u;

// This allowlist covers common source, data, documentation, and transcript files. It avoids
// treating arbitrary dotted prose and common web domains as file paths.
const FILE_EXTENSIONS = [
  'bash', 'c', 'cc', 'cfg', 'conf', 'cpp', 'cs', 'css', 'csv', 'diff', 'go', 'h', 'hpp', 'html', 'ini', 'ipynb',
  'java', 'js', 'json', 'json5', 'jsonl', 'jsx', 'kt', 'lock', 'log', 'md', 'mdx', 'mjs', 'mts', 'patch', 'pdf',
  'php', 'py', 'rb', 'rs', 'sass', 'scss', 'sh', 'sql', 'svg', 'svelte', 'toml', 'ts', 'tsx', 'txt', 'vue', 'wasm',
  'xml', 'yaml', 'yml', 'zsh',
];
const EXTENSION_PATTERN = `(?:${FILE_EXTENSIONS.join('|')})`;
const PATH_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:(?:/|~/|\\.\\.?/)(?:[A-Za-z0-9_.@+-]+/)*|(?:[A-Za-z0-9_.@+-]+/)+)?[A-Za-z0-9_@+-][A-Za-z0-9_.@+-]*\\.${EXTENSION_PATTERN}(?![A-Za-z0-9_.-])`,
  'gu',
);
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/giu;
const UUID_PATTERN = /(?<![A-Za-z0-9_-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![A-Za-z0-9_-])/giu;
const SHA_PATTERN = /(?<![#A-Za-z0-9_-])(?=[0-9a-f]{0,39}[a-f])[0-9a-f]{7,40}(?![A-Za-z0-9_-])/giu;
const ISSUE_PATTERN = /(?<![\p{L}\p{N}_])#\d+(?!\d)/gu;
const JOBQ_PATTERN = /(?<![\p{L}\p{N}_-])jobq[-_:][A-Za-z0-9][A-Za-z0-9_-]*(?![\p{L}\p{N}_-])/giu;
const JOB_PATTERN = /(?<![\p{L}\p{N}_-])job-\d+(?![\p{L}\p{N}_-])/giu;
const BASH_SEARCH_COMMAND = /(?:^|[;&|()]\s*)(?:(?:sudo|command)\s+)*(?:grep|find|ls)\b/i;
const BASH_GIT_LOG = /(?:^|[;&|()]\s*)(?:(?:sudo|command)\s+)*git\s+(?:-[^\s]+\s+)*log\b/i;
const READ_TOOL_NAME = /^(?:Read|NotebookRead)$/i;
const READ_WRAPPER_NAME = /(?:^|[_/])(?:read|read_file)$/i;

function regexMatches(text, pattern) {
  pattern.lastIndex = 0;
  return [...String(text).matchAll(pattern)];
}

function pathMatches(text) {
  const withoutUrls = String(text).replace(URL_PATTERN, ' ');
  return regexMatches(withoutUrls, PATH_PATTERN);
}

export function extractItems(text) {
  const source = String(text ?? '');
  const found = new Set();
  const filePaths = pathMatches(source);
  for (const match of filePaths) found.add(match[0]);

  const uuidMatches = regexMatches(source, UUID_PATTERN);
  for (const match of uuidMatches) found.add(match[0]);

  const pathSpans = [...filePaths.map((match) => [match.index, match.index + match[0].length])];
  const uuidSpans = uuidMatches.map((match) => [match.index, match.index + match[0].length]);
  for (const match of regexMatches(source, SHA_PATTERN)) {
    const start = match.index, end = start + match[0].length;
    if (pathSpans.some(([a, b]) => start >= a && end <= b) || uuidSpans.some(([a, b]) => start >= a && end <= b)) continue;
    found.add(match[0]);
  }
  for (const pattern of [ISSUE_PATTERN, JOBQ_PATTERN, JOB_PATTERN]) {
    for (const match of regexMatches(source, pattern)) found.add(match[0]);
  }
  return found;
}

function timeOf(event) {
  return Date.parse(event?.timestamp ?? '') || 0;
}

function rawText(event) {
  const content = event?.message?.content;
  if (typeof content === 'string') return content;
  return sessionMessage(event).text;
}

function eventMaterial(event) {
  const message = sessionMessage(event);
  return [
    message.text,
    ...message.toolUses.map((use) => JSON.stringify(use.input ?? {})),
    ...(message.toolResults ?? []).map((result) => result.text),
  ].filter(Boolean).join('\n');
}

function addMaterialItems(target, material) {
  for (const item of extractItems(material)) target.add(item);
}

function isFilePathItem(item) {
  return !String(item).includes('/') && extractItems(item).has(item);
}

function itemRule(item) {
  const value = String(item);
  if (pathMatches(value).some((match) => match[0] === value)) return 'path';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) return 'uuid';
  if (/^#\d+$/u.test(value)) return 'issueNumber';
  if (/^(?:jobq[-_:][A-Za-z0-9][A-Za-z0-9_-]*|job-\d+)$/iu.test(value)) return 'jobId';
  if (/^(?=[0-9a-f]{0,39}[a-f])[0-9a-f]{7,40}$/iu.test(value)) return 'sha';
  throw new Error(`Extracted item has no item rule: ${value}`);
}

function initToolName(tool) {
  if (typeof tool === 'string') return tool;
  return String(tool?.name ?? tool?.tool_name ?? tool?.tool ?? '');
}

function searchSessionToolOffered(events) {
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init' && Array.isArray(event.tools));
  return init;
}

function oldSessionWideSearchProxy(events) {
  const init = searchSessionToolOffered(events);
  if (init) return init.tools.some((tool) => isSearchSession({ name: initToolName(tool) }));
  return events.some((event) => toolUses(event).some(isSearchSession));
}

function searchSessionAvailability(events, boundaryIndex, injection) {
  const init = searchSessionToolOffered(events);
  if (init) return {
    available: init.tools.some((tool) => isSearchSession({ name: initToolName(tool) })),
    evidence: 'system_init_tool_list',
  };
  if (injection.arm === 'plugin' && /\bsearch_session\b/iu.test(injection.seedText)) {
    return { available: true, evidence: 'plugin_seed_mentions_search_session' };
  }
  if (events.slice(0, boundaryIndex).some((event) => toolUses(event).some(isSearchSession))) {
    return { available: true, evidence: 'pre_boundary_search_session_tool_use' };
  }
  return { available: false, evidence: 'unavailable' };
}

function normalizedObservedItems(material) {
  const observed = extractItems(material);
  for (const item of [...observed]) {
    if (item.includes('/')) {
      const basename = item.slice(item.lastIndexOf('/') + 1);
      if (isFilePathItem(basename)) observed.add(basename);
    }
  }
  return observed;
}

function itemsInMaterial(material) {
  return normalizedObservedItems(material);
}

function firstInjection(events, start, stop) {
  const cut = findInjectedCut(events, start, stop);
  return cut ? { arm: cut.arm, event: cut.seedEvent, seedText: cut.seedText, injectionTime: cut.injectionTime } : undefined;
}

function retainedTailItems(events, seedEvent, stop, injectionTime) {
  return itemsInMaterial(tailContext(events, seedEvent, stop, injectionTime).material);
}

function assistantCalls(events, start, stop, injectionTime) {
  return seedAssistantCalls(events, start, stop, injectionTime);
}

function isSearchSession(use) {
  return /(?:^|[_/])search_session$/i.test(String(use?.name ?? ''));
}

function isReadTool(use) {
  return READ_TOOL_NAME.test(String(use?.name ?? '')) || READ_WRAPPER_NAME.test(String(use?.name ?? ''));
}

function queryText(input) {
  if (typeof input === 'string') return input;
  if (typeof input?.query === 'string') return input.query;
  if (typeof input?.arguments?.query === 'string') return input.arguments.query;
  return '';
}

function isRederiveSearch(use) {
  if (use.name === 'Grep' || use.name === 'Glob') return true;
  if (use.name !== 'Bash') return false;
  const command = String(use.input?.command ?? '');
  return BASH_SEARCH_COMMAND.test(command) || BASH_GIT_LOG.test(command);
}

function isHumanMessage(event) {
  if (event.type !== 'user' || event.isMeta || isSummaryEvent(event)) return false;
  const content = event.message?.content;
  if (Array.isArray(content) && content.some((block) => block?.type === 'tool_result')) return false;
  const text = rawText(event).trim();
  return Boolean(text) && !text.startsWith(SEED_SENTINEL);
}

function exactItems(text) {
  return itemsInMaterial(text);
}

function findNeeds(candidates, calls) {
  const uses = new Map();
  for (const call of calls) {
    for (const part of call.parts) {
      const found = exactItems(part.material);
      for (const item of found) {
        if (!candidates.has(item)) continue;
        if (!uses.has(item)) uses.set(item, { callId: call.id, callNumber: calls.indexOf(call) + 1, useIndex: part.index });
      }
    }
  }
  return uses;
}

function sourceSignals(events, start, stop, injectionTime, candidateItems) {
  const searchCalls = [];
  const strictRecall = new Map();
  const rederive = new Map();
  const userSources = new Map();
  const pendingTools = new Map();
  const add = (map, item, signal) => {
    if (!map.has(item)) map.set(item, []);
    map.get(item).push(signal);
  };

  for (let index = start + 1; index < stop; index++) {
    const event = events[index];
    if (timeOf(event) <= injectionTime + INJECTION_GRACE_MS) continue;
    if (event.type === 'assistant') {
      for (const use of toolUses(event)) {
        const id = String(use.id ?? '');
        if (isSearchSession(use)) {
          const queried = exactItems(queryText(use.input));
          const queriedCandidates = new Set([...queried].filter((item) => candidateItems.has(item)));
          searchCalls.push({ index, queried: queriedCandidates });
          for (const item of queriedCandidates) add(strictRecall, item, { index, sameUse: true });
          pendingTools.set(id, { search: true, index });
        } else if (isReadTool(use)) {
          const material = JSON.stringify(use.input ?? {});
          for (const item of exactItems(material)) if (candidateItems.has(item)) add(rederive, item, { index, sameUse: true });
          pendingTools.set(id, { read: true, index });
        } else if (isRederiveSearch(use)) {
          pendingTools.set(id, { rederiveSearch: true, index });
        } else {
          pendingTools.set(id, {});
        }
      }
      continue;
    }
    if (event.type !== 'user') continue;

    const message = sessionMessage(event);
    if (message.toolResults?.length) {
      for (const result of message.toolResults) {
        const sourceTool = pendingTools.get(String(result.tool_use_id ?? '')) ?? {};
        const found = exactItems(result.text);
        for (const item of found) {
          if (!candidateItems.has(item)) continue;
          if (sourceTool.search) add(strictRecall, item, { index, sameUse: false });
          if (sourceTool.rederiveSearch) add(rederive, item, { index: sourceTool.index, sameUse: true });
          if (sourceTool.read) add(rederive, item, { index, sameUse: false });
        }
      }
    } else if (isHumanMessage(event)) {
      for (const item of exactItems(message.text)) if (candidateItems.has(item)) add(userSources, item, { index, sameUse: false });
    }
  }
  return { searchCalls, strictRecall, rederive, userSources };
}

const PRIORITY = Object.freeze({ recall: 0, rederive: 1, user: 2 });

function firstSource(item, useIndex, signals, strict) {
  const candidates = [];
  if (strict) {
    for (const signal of signals.strictRecall.get(item) ?? []) {
      if (signal.index < useIndex || (signal.index === useIndex && signal.sameUse)) candidates.push({ index: signal.index, category: 'recall' });
    }
  } else {
    for (const call of signals.searchCalls) {
      const sameUseQuery = call.index === useIndex && call.queried.has(item);
      if (call.index < useIndex || sameUseQuery) candidates.push({ index: call.index, category: 'recall' });
    }
  }
  for (const signal of signals.rederive.get(item) ?? []) {
    if (signal.index < useIndex || (signal.index === useIndex && signal.sameUse)) candidates.push({ index: signal.index, category: 'rederive' });
  }
  for (const signal of signals.userSources.get(item) ?? []) {
    if (signal.index < useIndex) candidates.push({ index: signal.index, category: 'user' });
  }
  candidates.sort((a, b) => a.index - b.index || PRIORITY[a.category] - PRIORITY[b.category]);
  return candidates[0]?.category ?? 'none';
}

export function analyzeTranscript(events, transcriptKey = 'synthetic', { sessionKind = 'unknown' } = {}) {
  const windows = splitBoundaries(events);
  const cuts = [];
  const preCutHistoryItems = new Set();
  const oldProxyAvailable = oldSessionWideSearchProxy(events);
  let historyIndex = 0;
  for (let cutIndex = 0; cutIndex < windows.length; cutIndex++) {
    const window = windows[cutIndex];
    while (historyIndex < window.start) {
      addMaterialItems(preCutHistoryItems, eventMaterial(events[historyIndex]));
      historyIndex++;
    }
    const injection = firstInjection(events, window.start, window.end);
    if (!injection) continue;
    const availability = searchSessionAvailability(events, window.start, injection);
    const seedText = injection.seedText;
    const seedItems = itemsInMaterial(seedText);
    const tailItems = retainedTailItems(events, injection.event, window.end, injection.injectionTime);
    const preCutItems = new Set(preCutHistoryItems);
    const candidates = new Set([...preCutItems].filter((item) => !seedItems.has(item) && !tailItems.has(item)));
    const calls = assistantCalls(events, window.start, window.end, injection.injectionTime);
    const needs = findNeeds(candidates, calls);
    const signals = sourceSignals(events, window.start, window.end, injection.injectionTime, candidates);
    const needRows = [...needs.entries()].map(([item, use]) => ({
      item,
      itemRule: itemRule(item),
      strict: firstSource(item, use.useIndex, signals, true),
      loose: firstSource(item, use.useIndex, signals, false),
      callNumber: use.callNumber,
    }));
    const sessionKey = String(events[0]?.sessionId ?? transcriptKey);
    const cutTime = timeOf(events[window.start]);
    cuts.push({
      arm: injection.arm,
      transcriptKey,
      sessionKey,
      sessionKind,
      date: cutTime ? new Date(cutTime).toISOString().slice(0, 10) : null,
      cutNumber: cutIndex + 1,
      searchSessionAvailable: availability.available,
      searchSessionAvailabilityEvidence: availability.evidence,
      searchSessionOldProxyAvailable: oldProxyAvailable,
      preCutItems: preCutItems.size,
      eligibleItems: candidates.size,
      assistantCallsObserved: calls.length,
      needs: needRows,
    });
  }
  return cuts;
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position), upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function spread(values) {
  return { n: values.length, median: percentile(values, 0.5), p25: percentile(values, 0.25), p75: percentile(values, 0.75) };
}

function emptyCounts() {
  return Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
}

function needCounts(needs, mode) {
  const counts = emptyCounts();
  for (const need of needs) counts[need[mode]]++;
  return counts;
}

function summarizeItemRules(cuts, totalNeeds) {
  const needs = cuts.flatMap((cut) => cut.needs);
  return Object.fromEntries(ITEM_RULES.map((rule) => {
    const ruleNeeds = needs.filter((need) => need.itemRule === rule);
    const byMode = Object.fromEntries(['strict', 'loose'].map((mode) => {
      const counts = needCounts(ruleNeeds, mode);
      const categories = Object.fromEntries(CATEGORIES.map((category) => [category, {
        needs: counts[category],
        share: ruleNeeds.length ? counts[category] / ruleNeeds.length : 0,
      }]));
      return [mode, { categories }];
    }));
    return [rule, {
      needs: ruleNeeds.length,
      shareOfAllNeeds: totalNeeds ? ruleNeeds.length / totalNeeds : 0,
      strict: byMode.strict,
      loose: byMode.loose,
    }];
  }));
}

export function summarizeArm(cuts) {
  const sessions = new Map();
  for (const cut of cuts) {
    if (!sessions.has(cut.sessionKey)) sessions.set(cut.sessionKey, { needs: 0, strict: emptyCounts(), loose: emptyCounts() });
    const session = sessions.get(cut.sessionKey);
    session.needs += cut.needs.length;
    for (const mode of ['strict', 'loose']) {
      for (const [category, count] of Object.entries(needCounts(cut.needs, mode))) session[mode][category] += count;
    }
  }
  const totalNeeds = cuts.reduce((sum, cut) => sum + cut.needs.length, 0);
  const needsByMode = Object.fromEntries(['strict', 'loose'].map((mode) => {
    const counts = emptyCounts();
    for (const cut of cuts) for (const [category, count] of Object.entries(needCounts(cut.needs, mode))) counts[category] += count;
    const allNeedSessions = [...sessions.values()].filter((session) => session.needs > 0);
    const eligibleSessions = allNeedSessions.filter((session) => session.needs >= 3);
    const categories = Object.fromEntries(CATEGORIES.map((category) => {
      const allShares = allNeedSessions.map((session) => session[mode][category] / session.needs);
      const eligibleShares = eligibleSessions.map((session) => session[mode][category] / session.needs);
      return [category, {
        needs: counts[category],
        share: totalNeeds ? counts[category] / totalNeeds : 0,
        perSessionShare: spread(allShares),
        perSessionShareInSessionsWith3PlusNeeds: spread(eligibleShares),
      }];
    }));
    return [mode, { categories, sessionsWithNeeds: allNeedSessions.length, sessionsWithAtLeast3Needs: eligibleSessions.length }];
  }));
  const sessionsWithNeeds = [...sessions.values()].filter((session) => session.needs > 0).length;
  return {
    cuts: cuts.length,
    needs: totalNeeds,
    cutsWithAtLeastOneNeed: cuts.filter((cut) => cut.needs.length > 0).length,
    sessionsWithNeeds,
    sessionsWithAtLeast3Needs: [...sessions.values()].filter((session) => session.needs >= 3).length,
    preCutItemsAcrossCuts: cuts.reduce((sum, cut) => sum + cut.preCutItems, 0),
    eligibleItemsAcrossCuts: cuts.reduce((sum, cut) => sum + cut.eligibleItems, 0),
    assistantCallsObserved: spread(cuts.map((cut) => cut.assistantCallsObserved)),
    strict: needsByMode.strict,
    loose: needsByMode.loose,
    needsByItemRule: summarizeItemRules(cuts, totalNeeds),
  };
}

function safeCut(cut) {
  const session = crypto.createHash('sha256').update(cut.sessionKey).digest('hex').slice(0, 12);
  return {
    session,
    cut: cut.cutNumber,
    arm: cut.arm,
    sessionKind: cut.sessionKind,
    date: cut.date,
    searchSessionAvailable: cut.searchSessionAvailable,
    searchSessionAvailabilityEvidence: cut.searchSessionAvailabilityEvidence,
    searchSessionOldProxyAvailable: cut.searchSessionOldProxyAvailable,
    preCutItems: cut.preCutItems,
    eligibleItems: cut.eligibleItems,
    assistantCallsObserved: cut.assistantCallsObserved,
    needs: cut.needs.length,
    strict: needCounts(cut.needs, 'strict'),
    loose: needCounts(cut.needs, 'loose'),
  };
}

function summarizeCutContext(cuts) {
  const sessionKinds = {};
  for (const cut of cuts) sessionKinds[cut.sessionKind] = (sessionKinds[cut.sessionKind] ?? 0) + 1;
  const dates = cuts.map((cut) => cut.date).filter(Boolean).sort();
  return {
    sessionKinds,
    dateRange: dates.length ? { first: dates[0], last: dates.at(-1) } : null,
  };
}

function summarizeAvailability(cuts) {
  return {
    cuts: cuts.length,
    available: cuts.filter((cut) => cut.searchSessionAvailable).length,
    unavailable: cuts.filter((cut) => !cut.searchSessionAvailable).length,
    evidence: {
      systemInitToolList: cuts.filter((cut) => cut.searchSessionAvailabilityEvidence === 'system_init_tool_list').length,
      pluginSeedMentionsSearchSession: cuts.filter((cut) => cut.searchSessionAvailabilityEvidence === 'plugin_seed_mentions_search_session').length,
      preBoundarySearchSessionToolUse: cuts.filter((cut) => cut.searchSessionAvailabilityEvidence === 'pre_boundary_search_session_tool_use').length,
      unavailable: cuts.filter((cut) => cut.searchSessionAvailabilityEvidence === 'unavailable').length,
    },
  };
}

function summarizeOldProxySensitivity(cuts) {
  const oldProxyCuts = cuts.filter((cut) => cut.searchSessionOldProxyAvailable);
  const oldProxy = summarizeArm(oldProxyCuts);
  const allCuts = summarizeArm(cuts);
  return {
    cuts: oldProxy.cuts,
    needs: oldProxy.needs,
    strict: {
      needs: oldProxy.strict.categories.recall.needs,
      share: oldProxy.strict.categories.recall.share,
      differenceFromAllCuts: oldProxy.strict.categories.recall.share - allCuts.strict.categories.recall.share,
    },
    loose: {
      needs: oldProxy.loose.categories.recall.needs,
      share: oldProxy.loose.categories.recall.share,
      differenceFromAllCuts: oldProxy.loose.categories.recall.share - allCuts.loose.categories.recall.share,
    },
  };
}

function sensitivityWithoutShortIssueNumbers(cuts) {
  const baseline = summarizeArm(cuts);
  const filteredCuts = cuts.map((cut) => ({
    ...cut,
    needs: cut.needs.filter((need) => !(need.itemRule === 'issueNumber' && SHORT_ISSUE_PATTERN.test(need.item))),
  }));
  const filtered = summarizeArm(filteredCuts);
  const byMode = Object.fromEntries(['strict', 'loose'].map((mode) => {
    const categories = Object.fromEntries(CATEGORIES.map((category) => {
      const before = baseline[mode].categories[category];
      const after = filtered[mode].categories[category];
      return [category, {
        needsBefore: before.needs,
        shareBefore: before.share,
        needsAfter: after.needs,
        shareAfter: after.share,
        shareChange: after.share - before.share,
      }];
    }));
    return [mode, { categories }];
  }));
  return {
    needsBefore: baseline.needs,
    needsDropped: baseline.needs - filtered.needs,
    needsAfter: filtered.needs,
    byMode,
  };
}

function makeReport(cuts, { transcriptFiles, compactBoundaries, sourceRoot, outputPath }) {
  const plugin = cuts.filter((cut) => cut.arm === 'plugin');
  const native = cuts.filter((cut) => cut.arm === 'native');
  const available = cuts.filter((cut) => cut.searchSessionAvailable);
  const pluginAvailable = available.filter((cut) => cut.arm === 'plugin');
  const nativeAvailable = available.filter((cut) => cut.arm === 'native');
  const sessions = new Set(cuts.map((cut) => cut.sessionKey));
  return {
    method: {
      sourceRoot,
      includesSubagentTranscripts: true,
      parser: 'tools/real-replay/transcript-parser.mjs; cut and plugin-seed recognition reuse tools/real-replay/seed-sections.mjs',
      cutRecognition: {
        plugin: `compact_boundary followed by a user message with ${SEED_SENTINEL} in the same first-user/two-second injection window used by seed-sections.mjs`,
        native: 'compact_boundary followed by an isCompactSummary user event in that same injection window, with no plugin seed selected',
        nextCut: 'each compact_boundary closes the previous measurement window',
      },
      searchSessionAvailability: 'In order, use the first system/init event with a tools array (including explicit absence), a plugin seed that names search_session, or a search_session tool_use strictly before this cut boundary; otherwise mark unavailable. The pre-boundary-use rule still correlates with session habits. The old any-use-anywhere session proxy is reported only as a sensitivity.',
      items: {
        path: `POSIX absolute or relative file-path tokens, including basename-only tokens, with one of these extensions: ${FILE_EXTENSIONS.join(', ')}. URLs are removed before matching; a narrow allowlist avoids treating dotted prose and common domains as files. Paths are host/project locators that a Read or search can resolve.`,
        gitSha: '7 to 40 hexadecimal characters with token boundaries and at least one a-f letter; exclude all-digit tokens, hash-prefixed issue numbers, and SHA substrings inside UUIDs or file paths. The length covers abbreviated and full Git object names.',
        uuid: 'whole 8-4-4-4-12 hexadecimal UUID-shaped tokens; kept whole so UUID groups do not become SHA items.',
        issueOrPr: 'a hash sign followed by one or more digits, such as #7 or #123; the hash distinguishes an issue/PR reference from an ordinary number.',
        job: 'jobq followed by -, _ or : and an identifier token, plus numeric job-<digits> background IDs used by this project.',
        sourceAndExclusion: 'extract distinct exact items from user/assistant transcript text, tool inputs, and tool results before the boundary; exclude exact items also extracted from the injected seed/summary or retained tail.',
        perNeedRule: 'Each need is assigned one extraction rule: path, sha, uuid, issueNumber (# plus digits), or jobId.',
      },
      need: {
        definition: `an eligible item used exactly in assistant text or a serialized tool input in the first ${ASSISTANT_CALL_WINDOW} unique assistant message IDs after the two-second injection grace period, stopping at the next compact_boundary or transcript end; duplicate streaming entries with the same message ID are one call`,
        strictRecall: 'A search_session query or its paired tool result contains the exact item; a query containing the item counts at the call itself.',
        looseRecall: 'Any search_session call before the first use counts, even if its query/result omits the item.',
        rederive: 'A Grep/Glob or Bash grep/find/ls/git log tool result contains the item, or a Read/NotebookRead/read_file call reads the named item or returns it.',
        user: 'a non-summary human user message after the cut contains the item; tool-result messages do not count as user sources.',
        none: 'no qualifying visible source before the first use.',
        firstSource: 'classify the earliest source by transcript event order; if multiple sources first appear in one event, tie order is recall, rederive, user. Strict and loose classifications are computed independently.',
        sessionSpread: 'global class share is class needs / all needs. Per-session shares divide each class count by all needs in that session. Report spread across sessions with at least one need and separately across sessions with at least three needs.',
        percentileMethod: 'R-7 linear interpolation across session-level shares.',
      },
      gaps: [
        'The transcript records the whole conversation log; after an earlier compaction, items in old transcript entries may not have remained in the model context at this later cut.',
        'Exact lexical matching misses paraphrased needs and may count incidental exact mentions; items correctly recalled from model memory without a visible source are classified none.',
        'A visible search_session call is not proof that the result was relevant, read, or relied on; strict recall only checks whether the query or returned text contains the exact item.',
        'The pre-boundary search_session evidence rule still correlates with session habits: a model that searched before is likelier to search again, so available-only shares remain an upper-leaning estimate.',
        'All-digit abbreviated SHAs are missed by design because SHA tokens must contain at least one a-f letter.',
        'The file-path allowlist omits uncommon extensions, Windows-style paths, and paths containing spaces; identifiers outside the stated forms are not measured.',
        'Shell/tool activity is visible only when represented in the JSONL. Bash aliases, unrecognized wrappers, hidden tool state, and sources outside the transcript are not attributed.',
        'Retained tail uses the seed-sections convention: user/assistant messages after the injected seed/summary within two seconds, excluding synthetic entries and a repeated plugin sentinel. Unusual timestamp ordering can misclassify a tail entry.',
        'Cuts without a qualifying injected plugin seed or native summary are excluded; a final window ending at transcript end is right-censored.',
      ],
    },
    sample: {
      transcriptFiles,
      compactBoundaries,
      recognizedPluginCuts: plugin.length,
      recognizedNativeCuts: native.length,
      unrecognizedBoundaries: compactBoundaries - plugin.length - native.length,
      sessions: sessions.size,
      itemRules: Object.keys({ path: 1, gitSha: 1, uuid: 1, issueOrPr: 1, job: 1 }).length,
      availabilityByArm: { plugin: summarizeAvailability(plugin), native: summarizeAvailability(native) },
      cutContextByArm: { plugin: summarizeCutContext(plugin), native: summarizeCutContext(native) },
    },
    arms: {
      allCuts: { plugin: summarizeArm(plugin), native: summarizeArm(native) },
      searchSessionAvailable: { plugin: summarizeArm(pluginAvailable), native: summarizeArm(nativeAvailable) },
      oldSessionWideProxySensitivity: {
        plugin: summarizeOldProxySensitivity(plugin),
        native: summarizeOldProxySensitivity(native),
      },
    },
    pluginAvailableOnlyWithoutShortIssueNumbers: sensitivityWithoutShortIssueNumbers(pluginAvailable),
    cuts: cuts.map(safeCut),
    outputPath,
  };
}

function percent(value, digits = 1) {
  return `${(100 * (value ?? 0)).toFixed(digits)}%`;
}

function percentagePoints(value) {
  const points = 100 * (value ?? 0);
  return `${points > 0 ? '+' : ''}${points.toFixed(2)} pp`;
}

function fmtSpread(stats) {
  if (!stats.n) return 'n=0, no sessions';
  return `median ${percent(stats.median)}, p25 ${percent(stats.p25)}, p75 ${percent(stats.p75)} (n=${stats.n})`;
}

function renderMarkdown(report) {
  const renderArmTables = (title, arms) => {
    const lines = [
      `## ${title}`,
      '',
      '| Arm | n cuts | n needs | Cuts with at least one need | Sessions with at least 3 needs |',
      '|---|---:|---:|---:|---:|',
    ];
    for (const armName of ['plugin', 'native']) {
      const arm = arms[armName];
      lines.push(`| ${armName} | ${arm.cuts} | ${arm.needs} | ${arm.cutsWithAtLeastOneNeed} (${percent(arm.cuts ? arm.cutsWithAtLeastOneNeed / arm.cuts : 0)}) | ${arm.sessionsWithAtLeast3Needs} |`);
    }
    lines.push(
      '',
      'Each cell gives global share of needs, then the per-session share median and p25/p75 across sessions with at least one need. The final field repeats the spread only for sessions with at least three needs.',
      '',
      '| Arm | Recall rule | Class | Needs / share | Per-session share | Sessions with 3+ needs: per-session share |',
      '|---|---|---|---:|---|---|',
    );
    for (const armName of ['plugin', 'native']) {
      const arm = arms[armName];
      for (const mode of ['strict', 'loose']) {
        for (const category of CATEGORIES) {
          const stats = arm[mode].categories[category];
          lines.push(`| ${armName} | ${mode} | ${category} | ${stats.needs} / ${percent(stats.share)} | ${fmtSpread(stats.perSessionShare)} | ${fmtSpread(stats.perSessionShareInSessionsWith3PlusNeeds)} |`);
        }
      }
    }
    return lines;
  };
  const fmtSessionKinds = (counts) => Object.entries(counts).map(([kind, count]) => `${kind}: ${count}`).join(', ') || 'none';
  const fmtRecallShare = (stats) => `${stats.needs} / ${percent(stats.share)}`;
  const pluginAvailableSummary = report.arms.searchSessionAvailable.plugin;
  const sensitivity = report.pluginAvailableOnlyWithoutShortIssueNumbers;
  const oldProxySensitivity = report.arms.oldSessionWideProxySensitivity;
  const lines = [
    '# Recall when needed: real transcript measurement',
    '',
    `Scanned ${report.sample.transcriptFiles} JSONL files under ${report.method.sourceRoot}, including subagent transcripts; found ${report.sample.compactBoundaries} compact boundaries across ${report.sample.sessions} distinct sessions. Recognized ${report.sample.recognizedPluginCuts} plugin cuts and ${report.sample.recognizedNativeCuts} native-summary cuts; ${report.sample.unrecognizedBoundaries} boundaries had neither selected seed form.`,
    `The scan ran on ${new Date().toISOString().slice(0, 10)}. Transcripts were read only; it made no model calls or network requests. Aggregate JSON is \`${report.outputPath}\` and stores hashed session keys and counts, not item values or transcript text.`,
    `The need window is the first ${ASSISTANT_CALL_WINDOW} unique assistant calls after the two-second injection grace, ending at the next compact boundary. Items and classes follow the definitions in the JSON method record.`,
    'The plugin and native arms differ in more than the seed: search_session availability, session kinds, and dates also differ. The comparison is descriptive, not causal.',
    '',
    '## Definitions and implementation',
    '',
    'The analyzer reuses transcript parsing, plugin-seed/native-summary recognition, the two-second injection window, retained-tail handling, and assistant-call grouping from `tools/real-replay/seed-sections.mjs`.',
    'A need is one distinct eligible item per cut. It appears before the boundary, is absent from the injected seed or summary and retained tail, and is used exactly in assistant text or a serialized assistant tool input in the 20-call window. Only its first assistant use in that window counts.',
    '',
    '| Item rule | Exact extraction rule |',
    '|---|---|',
    '| Path | POSIX absolute or relative path token, including basename-only tokens, with one of 51 extensions. URLs are removed before matching. |',
    '| SHA | 7 to 40 hexadecimal characters with token boundaries and at least one a-f letter. All-digit tokens are not counted as SHAs. |',
    '| UUID | Whole hexadecimal `8-4-4-4-12` UUID-shaped token, kept whole so its groups are not counted as SHAs. |',
    '| `#digits` | A `#` followed by one or more digits, including `#7`; the hash distinguishes the token from an ordinary number. |',
    '| Job ID | `jobq` followed by `-`, `_`, or `:` and an identifier token, plus numeric `job-<digits>` background IDs. |',
    '',
    'Strict recall requires the exact item in a `search_session` query or its paired result; an item in the query counts at the call. Loose recall counts any `search_session` call before first use, even if the query and result omit the item. Rederive requires an item-bearing `Grep`/`Glob` or Bash `grep`/`find`/`ls`/`git log` result, or a `Read`, `NotebookRead`, or `read_file` that reads or returns the item. User means a non-summary human message after the cut contains the item. None means no qualifying visible source appears before first use. The earliest source by event order wins; same-event ties go recall, rederive, then user. Strict and loose are independent.',
    'The global class share is class needs divided by all needs in that arm. Per-session shares divide each class count by the session\'s needs; the reported spreads use R-7 linear interpolation.',
    '',
    '## Tool availability and cut context',
    '',
    '| Arm | All cuts | search_session available | Unavailable | system/init list | plugin seed names tool | pre-boundary call | no evidence | Session kinds | Boundary date range |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---|---|',
  ];
  for (const armName of ['plugin', 'native']) {
    const availability = report.sample.availabilityByArm[armName];
    const context = report.sample.cutContextByArm[armName];
    const dateRange = context.dateRange ? `${context.dateRange.first} to ${context.dateRange.last}` : 'no dates';
    lines.push(`| ${armName} | ${availability.cuts} | ${availability.available} | ${availability.unavailable} | ${availability.evidence.systemInitToolList} | ${availability.evidence.pluginSeedMentionsSearchSession} | ${availability.evidence.preBoundarySearchSessionToolUse} | ${availability.evidence.unavailable} | ${fmtSessionKinds(context.sessionKinds)} | ${dateRange} |`);
  }
  lines.push(
    '',
    'Each JSON cut record includes `searchSessionAvailable` and `searchSessionAvailabilityEvidence`. The evidence order is: the first system/init tool list (including explicit absence), the injected plugin seed naming `search_session`, then a `search_session` tool_use strictly before that cut boundary. Cuts with none of these are unavailable. The old session-wide tool-use proxy appears only in the sensitivity table below.',
    'Rule 3 still correlates with session habits: a model that searched before is likelier to search again, so available-only shares remain an upper-leaning estimate.',
    '',
    ...renderArmTables('All recognized cuts', report.arms.allCuts),
    '',
    ...renderArmTables('Only cuts with search_session available', report.arms.searchSessionAvailable),
    '',
    '## Old session-wide proxy sensitivity',
    '',
    'These rows reapply the round 2 filter, which marked a cut available if any `search_session` call appeared anywhere in its transcript. Changes are old-proxy recall share minus the all-cuts share, showing the uplift from the outcome-correlated filter.',
    '',
    '| Arm | Cuts selected | Needs | Strict recall under old proxy | Change vs all cuts | Loose recall under old proxy | Change vs all cuts |',
    '|---|---:|---:|---:|---:|---:|---:|',
  );
  for (const armName of ['plugin', 'native']) {
    const stats = oldProxySensitivity[armName];
    lines.push(`| ${armName} | ${stats.cuts} | ${stats.needs} | ${fmtRecallShare(stats.strict)} | ${percentagePoints(stats.strict.differenceFromAllCuts)} | ${fmtRecallShare(stats.loose)} | ${percentagePoints(stats.loose.differenceFromAllCuts)} |`);
  }
  lines.push(
    '',
    '## Plugin item rules, available sessions only',
    '',
    'Each need is counted once under its extraction rule. `Needs / share of all` uses all available plugin needs as the denominator; class shares use the needs for that item rule as the denominator.',
    '',
    '| Recall rule | Item rule | Needs / share of all | Class | Class needs / share within item rule |',
    '|---|---|---:|---|---:|',
  );
  const itemRuleLabels = { path: 'path', sha: 'sha', uuid: 'uuid', issueNumber: '#digits', jobId: 'job id' };
  for (const mode of ['strict', 'loose']) {
    for (const rule of ITEM_RULES) {
      const ruleStats = pluginAvailableSummary.needsByItemRule[rule];
      for (const category of CATEGORIES) {
        const classStats = ruleStats[mode].categories[category];
        lines.push(`| ${mode} | ${itemRuleLabels[rule]} | ${ruleStats.needs} / ${percent(ruleStats.shareOfAllNeeds)} | ${category} | ${classStats.needs} / ${percent(classStats.share)} |`);
      }
    }
  }
  lines.push(
    '',
    '## Short issue-number sensitivity, available plugin cuts',
    '',
    `Dropping needs matching \`#\\d{1,2}\` removes ${sensitivity.needsDropped} of ${sensitivity.needsBefore} needs, leaving ${sensitivity.needsAfter}. Strict recall moves from ${percent(sensitivity.byMode.strict.categories.recall.shareBefore, 2)} to ${percent(sensitivity.byMode.strict.categories.recall.shareAfter, 2)} (${percentagePoints(sensitivity.byMode.strict.categories.recall.shareChange)}); loose recall moves from ${percent(sensitivity.byMode.loose.categories.recall.shareBefore, 2)} to ${percent(sensitivity.byMode.loose.categories.recall.shareAfter, 2)} (${percentagePoints(sensitivity.byMode.loose.categories.recall.shareChange)}).`,
    '',
    '| Recall rule | Class | Needs before | Share before | Needs after | Share after | Change in share (pp) |',
    '|---|---|---:|---:|---:|---:|---:|',
  );
  for (const mode of ['strict', 'loose']) {
    for (const category of CATEGORIES) {
      const stats = sensitivity.byMode[mode].categories[category];
      lines.push(`| ${mode} | ${category} | ${stats.needsBefore} | ${percent(stats.shareBefore)} | ${stats.needsAfter} | ${percent(stats.shareAfter)} | ${(100 * stats.shareChange).toFixed(2)} |`);
    }
  }
  lines.push('', '## Method notes', '',
    `Item rules: paths use a ${FILE_EXTENSIONS.length}-extension allowlist; Git SHAs are 7-40 hex with at least one a-f letter; UUIDs are whole 8-4-4-4-12 forms; issue/PR IDs are # plus digits; job IDs are jobq-prefixed tokens and numeric job-<digits>.`,
    'Strict recall requires the exact item in a search_session query or paired result. Loose recall counts any earlier search_session call. Rederive requires an item-bearing grep/find/ls/git log result or a read of the item. The item appears in neither the seed/summary nor the retained tail.',
    'Per-session percentiles use R-7 linear interpolation. The JSON stores aggregate counts, hashed session keys, per-cut availability/evidence, dates, and session kinds; it does not store item strings or transcript text.',
    '', '## Limits', '', ...report.method.gaps.map((gap) => `- ${gap}`), '');
  return `${lines.join('\n')}\n`;
}

async function walkJsonl(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full);
    }
  }
  return files.sort();
}

export async function main(argv = process.argv.slice(2)) {
  const defaultRoot = path.resolve(os.homedir(), '.claude', 'projects');
  let dataRoot = defaultRoot;
  let outputPath = DEFAULT_OUT;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--root') dataRoot = path.resolve(argv[++index]);
    else if (argv[index] === '--out') outputPath = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  const files = await walkJsonl(dataRoot);
  const cuts = [];
  let compactBoundaries = 0;
  for (const file of files) {
    const { events: parsed } = await parseJsonl(file);
    const events = parsed.map((row) => row.event);
    compactBoundaries += splitBoundaries(events).length;
    const transcriptKey = crypto.createHash('sha256').update(path.relative(dataRoot, file)).digest('hex').slice(0, 12);
    const sessionKind = file.split(path.sep).includes('subagents') ? 'subagent' : 'main';
    cuts.push(...analyzeTranscript(events, transcriptKey, { sessionKind }));
  }
  const sourceRoot = dataRoot === defaultRoot ? '~/.claude/projects' : path.basename(dataRoot);
  const report = makeReport(cuts, { transcriptFiles: files.length, compactBoundaries, sourceRoot, outputPath });
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(renderMarkdown(report));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
}
