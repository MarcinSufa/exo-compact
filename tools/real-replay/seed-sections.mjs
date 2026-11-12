#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { estimateTokens, serializedTokens } from '../../plugin/compact/core/budgets.ts';
import { eventContentText, isSearchSession, isSummaryEvent, parseJsonl, readPaths, sessionMessage, splitBoundaries } from './transcript-parser.mjs';

export const SEED_SENTINEL = '[[exovault:s4-seed:v1]]';
export const SESSION_MEMORY_OPEN = '<session-memory source="exo-compact">';
export const SESSION_MEMORY_CLOSE = '</session-memory>';
export const NGRAM_SIZE = 5;
export const ASSISTANT_CALL_WINDOW = 20;
export const POINTER_STUB = '## Archived context\nAdditional notes, maps, and excerpts are stored on disk. Use search_session or read a section pointer to retrieve them.';

const PRIMARY_SECTION_LABEL_MAP = Object.freeze({
  'Compaction pressure': 'skeleton',
  'Constraints (history)': 'skeleton',
  'Task card': 'skeleton',
  'Since the card': 'disk_candidate',
  'Task brief (full text on disk)': 'skeleton',
  'Current values (newest value of each thing the user changed; earlier values are replaced)': 'skeleton',
  'Work state (from tool calls and a git check at the cut; reference only)': 'disk_candidate',
  'Recipes (commands that ran fine earlier; reference only, not requests)': 'disk_candidate',
  'Session map (one line per earlier compaction segment; reference only, not requests)': 'disk_candidate',
  'Key facts (stated earlier; reference only, not requests)': 'disk_candidate',
  'Working notes (dense details from earlier; reference only, not requests)': 'disk_candidate',
  Transcript: 'skeleton',
  Contract: 'skeleton',
  Todo: 'skeleton',
  'Earlier user messages (quoted for reference, not new requests)': 'disk_candidate',
  'History (verbatim user records)': 'disk_candidate',
  Values: 'disk_candidate',
  Reasoning: 'disk_candidate',
  'Earlier assistant notes': 'disk_candidate',
  'Gates and errors': 'disk_candidate',
  'File pointers': 'skeleton',
  'Next step': 'skeleton',
  'IDs (short = full)': 'skeleton',
  'Archived context': 'skeleton',
});
const CONSERVATIVE_SECTION_LABEL_MAP = Object.freeze({
  ...PRIMARY_SECTION_LABEL_MAP,
  'Since the card': 'skeleton',
  'Work state (from tool calls and a git check at the cut; reference only)': 'skeleton',
  'Gates and errors': 'skeleton',
});
const SECTION_LABEL_MAPPINGS = Object.freeze({
  primary: PRIMARY_SECTION_LABEL_MAP,
  conservative: CONSERVATIVE_SECTION_LABEL_MAP,
});
const SECTION_LABEL_MAP = PRIMARY_SECTION_LABEL_MAP;
const MAPPING_NAMES = Object.freeze({
  primary: 'Primary mapping',
  conservative: 'Conservative mapping',
});
export { SECTION_LABEL_MAP, SECTION_LABEL_MAPPINGS };

export function labelForSection(name, mapping = SECTION_LABEL_MAP) {
  return mapping[name] ?? 'disk_candidate';
}

export function splitSeedSections(seed) {
  const text = String(seed ?? '');
  const openAt = text.indexOf(SESSION_MEMORY_OPEN);
  const contentStart = openAt < 0 ? 0 : openAt + SESSION_MEMORY_OPEN.length;
  const closeAt = text.indexOf(SESSION_MEMORY_CLOSE, contentStart);
  const contentEnd = closeAt < 0 ? text.length : closeAt;
  const content = text.slice(contentStart, contentEnd);
  const headings = [...content.matchAll(/^## ([^\r\n]+)\r?$/gm)];
  if (!headings.length) {
    return {
      prefix: text.slice(0, contentStart).trim(),
      sections: [],
      suffix: text.slice(contentEnd).trim(),
    };
  }
  const sections = headings.map((heading, index) => {
    const start = heading.index;
    const end = headings[index + 1]?.index ?? content.length;
    const raw = content.slice(start, end).trim();
    const newline = raw.indexOf('\n');
    return {
      name: heading[1],
      label: labelForSection(heading[1]),
      raw,
      body: newline < 0 ? '' : raw.slice(newline + 1).trim(),
    };
  });
  return {
    prefix: `${text.slice(0, contentStart)}${content.slice(0, headings[0].index)}`.trim(),
    sections,
    suffix: `${content.slice(headings.at(-1).index + sections.at(-1).raw.length)}${text.slice(contentEnd)}`.trim(),
  };
}

function normalizeWhitespace(text) {
  return String(text ?? '').replace(/\s+/gu, ' ').trim();
}

function tokenNgrams(text, n) {
  const words = normalizeWhitespace(text).split(' ').filter(Boolean);
  const result = [];
  for (let i = 0; i + n <= words.length; i++) result.push(words.slice(i, i + n).join(' '));
  return result;
}

function hasNgram(text, ngram) {
  const words = normalizeWhitespace(text).split(' ').filter(Boolean);
  const target = ngram.split(' ');
  if (target.length > words.length) return false;
  for (let i = 0; i + target.length <= words.length; i++) {
    let matches = true;
    for (let j = 0; j < target.length; j++) if (words[i + j] !== target[j]) { matches = false; break; }
    if (matches) return true;
  }
  return false;
}

export function buildDiskCandidateNgrams(sections, { n = NGRAM_SIZE, excludedTexts = [], mapping = SECTION_LABEL_MAP } = {}) {
  const allCounts = new Map();
  const candidateGrams = new Set();
  for (const section of sections) {
    const grams = tokenNgrams(section.body ?? '', n);
    for (const gram of grams) allCounts.set(gram, (allCounts.get(gram) ?? 0) + 1);
    const label = Object.hasOwn(mapping, section.name) ? mapping[section.name] : (section.label ?? labelForSection(section.name, mapping));
    if (label === 'disk_candidate') for (const gram of grams) candidateGrams.add(gram);
  }
  return new Set([...candidateGrams].filter((gram) => allCounts.get(gram) === 1 && !excludedTexts.some((text) => hasNgram(text, gram))));
}

export function hasExactNgram(material, ngrams) {
  if (!ngrams?.size) return false;
  const words = normalizeWhitespace(material).split(' ').filter(Boolean);
  const size = ngrams.values().next().value.split(' ').length;
  for (let i = 0; i + size <= words.length; i++) if (ngrams.has(words.slice(i, i + size).join(' '))) return true;
  return false;
}

function assembleSeed(prefix, sections, suffix, stub = '') {
  return [prefix, ...sections.map((section) => section.raw), stub, suffix].filter(Boolean).join('\n\n');
}

function timestamp(event) {
  return Date.parse(event.timestamp ?? '') || 0;
}

function seedTextFromEvent(event) {
  const content = event?.message?.content;
  return typeof content === 'string' ? content : '';
}

function boundaryWindows(events) {
  return splitBoundaries(events);
}

export function findInjectedCut(events, start, stop) {
  const firstUser = events.slice(start + 1, Math.min(stop, start + 6)).find((event) => event.type === 'user');
  if (!firstUser) return undefined;
  const injectionTime = timestamp(firstUser);
  const injectedUsers = events.slice(start + 1, stop).filter((event) => event.type === 'user' && timestamp(event) <= injectionTime + 2000);
  const seedEvent = injectedUsers.find((event) => seedTextFromEvent(event).includes(SEED_SENTINEL));
  if (seedEvent) return { arm: 'plugin', seedEvent, seedText: seedTextFromEvent(seedEvent), injectionTime, injectedUsers };
  const nativeSummary = injectedUsers.find(isSummaryEvent);
  if (!nativeSummary) return undefined;
  return { arm: 'native', seedEvent: nativeSummary, seedText: seedTextFromEvent(nativeSummary), injectionTime, injectedUsers };
}

function findPluginSeed(events, start, stop) {
  const cut = findInjectedCut(events, start, stop);
  return cut?.arm === 'plugin' ? cut : undefined;
}

export function tailContext(events, seedEvent, stop, injectionTime) {
  const seedIndex = events.indexOf(seedEvent);
  const messages = [];
  for (let index = seedIndex + 1; index < stop; index++) {
    const event = events[index];
    if (timestamp(event) > injectionTime + 2000) continue;
    if ((event.type !== 'user' && event.type !== 'assistant') || event.message?.model === '<synthetic>') continue;
    const text = eventContentText(event);
    if (text.includes(SEED_SENTINEL)) continue;
    messages.push(sessionMessage(event));
  }
  const tokens = messages.reduce((sum, message) => sum + serializedTokens([message], estimateTokens), 0);
  const material = messages.map((message) => [
    message.text,
    ...message.toolUses.map((use) => JSON.stringify(use.input ?? {})),
    ...(message.toolResults ?? []).map((result) => result.text),
  ].filter(Boolean).join('\n')).filter(Boolean).join('\n');
  return { messages, tokens, material };
}

export function assistantCalls(events, start, stop, injectionTime) {
  const calls = [];
  const byId = new Map();
  for (let index = start + 1; index < stop; index++) {
    const event = events[index];
    if (event.type !== 'assistant' || event.message?.model === '<synthetic>' || timestamp(event) <= injectionTime + 2000) continue;
    const id = String(event.message?.id ?? event.uuid ?? `event-${index}`);
    let call = byId.get(id);
    if (!call) {
      call = { id, tools: [], material: '', parts: [] };
      byId.set(id, call);
      calls.push(call);
    }
    const content = event.message?.content;
    if (typeof content === 'string') {
      call.material += `${content}\n`;
      call.parts.push({ index, material: content });
    }
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          call.material += `${block.text}\n`;
          call.parts.push({ index, material: block.text });
        }
        if (block?.type === 'tool_use') {
          call.tools.push(block);
          call.material += `${JSON.stringify(block.input ?? {})}\n`;
          call.parts.push({ index, material: JSON.stringify(block.input ?? {}) });
        }
      }
    }
  }
  return calls.slice(0, ASSISTANT_CALL_WINDOW);
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position), upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function distribution(values) {
  return {
    n: values.length,
    median: percentile(values, 0.5),
    p25: percentile(values, 0.25),
    p75: percentile(values, 0.75),
    p90: percentile(values, 0.9),
    max: values.length ? Math.max(...values) : null,
  };
}

function firstPostCutContextTokens(events, start, stop, injectionTime) {
  const seen = new Set();
  for (let index = start + 1; index < stop; index++) {
    const event = events[index];
    if (event.type !== 'assistant' || event.message?.model === '<synthetic>' || timestamp(event) <= injectionTime + 2000) continue;
    const id = event.message?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const usage = event.message?.usage;
    if (!usage || typeof usage !== 'object') return null;
    const fields = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
    const hasUsage = fields.some((field) => typeof usage[field] === 'number' && Number.isFinite(usage[field]));
    if (!hasUsage) return null;
    const tokens = fields.reduce((sum, field) => sum + (typeof usage[field] === 'number' && Number.isFinite(usage[field]) ? usage[field] : 0), 0);
    return tokens > 0 ? tokens : null;
  }
  return null;
}

function cutMetrics(events, window, transcriptKey, cutNumber) {
  const found = findPluginSeed(events, window.start, window.end);
  if (!found) return undefined;
  const split = splitSeedSections(found.seedText);
  const sections = split.sections.map((section) => ({ ...section, label: labelForSection(section.name) }));
  const seedTokens = estimateTokens(found.seedText);
  const tail = tailContext(events, found.seedEvent, window.end, found.injectionTime);
  const calls = assistantCalls(events, window.start, window.end, found.injectionTime);
  const mappings = {};
  for (const [mappingName, mapping] of Object.entries(SECTION_LABEL_MAPPINGS)) {
    const skeletonSections = sections.filter((section) => labelForSection(section.name, mapping) === 'skeleton');
    const diskSections = sections.filter((section) => labelForSection(section.name, mapping) === 'disk_candidate');
    const skeletonSeed = assembleSeed(split.prefix, skeletonSections, split.suffix);
    const projectedSeed = diskSections.length
      ? assembleSeed(split.prefix, skeletonSections, split.suffix, POINTER_STUB)
      : skeletonSeed;
    const candidateNgrams = buildDiskCandidateNgrams(sections, { excludedTexts: [tail.material], mapping });
    mappings[mappingName] = {
      skeletonShare: seedTokens ? estimateTokens(skeletonSeed) / seedTokens : 1,
      savedTokens: seedTokens - estimateTokens(projectedSeed),
      candidateMatchCalls: calls.filter((call) => hasExactNgram(call.material, candidateNgrams)).length,
      candidateNgrams: candidateNgrams.size,
    };
  }
  const sectionsByName = {};
  for (const section of sections) sectionsByName[section.name] = (sectionsByName[section.name] ?? 0) + estimateTokens(section.raw);
  sectionsByName['Recent tail (retained messages; outside seed)'] = tail.tokens;
  return {
    transcriptKey,
    cutNumber,
    sessionKey: String(events[0]?.sessionId ?? transcriptKey),
    seedTokens,
    firstPostCutContextTokens: firstPostCutContextTokens(events, window.start, window.end, found.injectionTime),
    mappings,
    sectionTokens: sectionsByName,
    assistantCalls: calls.length,
    searchSessionCalls: calls.reduce((sum, call) => sum + call.tools.filter(isSearchSession).length, 0),
    fileReads: calls.reduce((sum, call) => sum + call.tools.reduce((n, use) => n + readPaths(use).length, 0), 0),
  };
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

function summarizeSections(rows) {
  const byName = new Map();
  for (const row of rows) {
    for (const [name, tokens] of Object.entries(row.sectionTokens)) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(tokens);
    }
  }
  return Object.fromEntries([...byName].map(([name, values]) => [name, {
    labels: Object.fromEntries(Object.entries(SECTION_LABEL_MAPPINGS).map(([mappingName, mapping]) => [
      mappingName,
      name.startsWith('Recent tail') ? 'skeleton' : labelForSection(name, mapping),
    ])),
    ...distribution(values),
  }]));
}

function hitRate(values) {
  const hits = values.filter((value) => value > 0).length;
  return { hits, cuts: values.length, rate: values.length ? hits / values.length : 0 };
}

function round(value, decimals = 1) {
  if (value == null) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function reportData(rows, fileCount, boundaryCount, nativeSummaryCount, otherNoSeedCount, outPath, root) {
  const sessions = new Set(rows.map((row) => row.sessionKey));
  const safeRows = rows.map(({ sessionKey, transcriptKey, ...row }) => ({
    session: crypto.createHash('sha256').update(sessionKey).digest('hex').slice(0, 12),
    transcript: transcriptKey,
    ...row,
  }));
  const sectionStats = summarizeSections(rows);
  const distributions = {
    searchSessionCalls: distribution(rows.map((row) => row.searchSessionCalls)),
    fileReads: distribution(rows.map((row) => row.fileReads)),
    assistantCallsObserved: distribution(rows.map((row) => row.assistantCalls)),
  };
  const mappingSummaries = Object.fromEntries(Object.entries(SECTION_LABEL_MAPPINGS).map(([mappingName, mapping]) => {
    const mappingRows = rows.map((row) => row.mappings[mappingName]);
    const contextShares = rows
      .filter((row) => row.firstPostCutContextTokens != null)
      .map((row) => 100 * row.mappings[mappingName].savedTokens / row.firstPostCutContextTokens);
    return [mappingName, {
      name: MAPPING_NAMES[mappingName],
      skeletonShare: distribution(mappingRows.map((row) => row.skeletonShare)),
      netSavedTokensPerCut: distribution(mappingRows.map((row) => row.savedTokens)),
      netSavedPercentOfFirstPostCutContext: distribution(contextShares),
      ngramMatchRate: hitRate(mappingRows.map((row) => row.candidateMatchCalls)),
      matchingAssistantCallsPerCut: distribution(mappingRows.map((row) => row.candidateMatchCalls)),
    }];
  }));
  return {
    method: {
      sourceRoot: root === path.join(os.homedir(), '.claude', 'projects') ? '~/.claude/projects' : path.basename(root),
      includesSubagentTranscripts: true,
      parser: 'tools/real-replay/transcript-parser.mjs, shared by real-replay.mjs and postcut.mjs',
      seedIdentifier: SEED_SENTINEL,
      nativeSummaryExclusion: 'A cut counts as a plugin seed only when its injected user summary contains the plugin seed sentinel, matching postcut.mjs. Native compact summaries without that marker are excluded.',
      tokenEstimator: 'plugin/compact/core/budgets.ts::estimateTokens; serialized tail messages use serializedTokens with the same estimator',
      percentileMethod: 'R-7 linear interpolation over sorted per-cut values',
      sectionLabelMappings: Object.fromEntries(Object.entries(SECTION_LABEL_MAPPINGS).map(([mappingName, mapping]) => [
        mappingName,
        { ...mapping, 'Recent tail (retained messages; outside seed)': 'skeleton', 'Unlisted heading fallback': 'disk_candidate' },
      ])),
      recentTail: 'Retained user and assistant messages after the seed with timestamp no later than 2 seconds after injection, excluding synthetic messages; outside the seed denominator.',
      pointerStub: { text: POINTER_STUB, tokens: estimateTokens(POINTER_STUB), count: 'one per cut that has at least one disk-candidate section' },
      postCutContext: 'For each cut, the first unique non-synthetic assistant message after the 2-second injection cutoff: input_tokens + cache_creation_input_tokens + cache_read_input_tokens. Context-share percentiles include cuts where those usage fields provide a positive denominator.',
      ngramMatch: {
        n: NGRAM_SIZE,
        rule: 'Case-sensitive exact match of five whitespace-delimited tokens after whitespace normalization. Keep only n-grams that occur once across all seed sections and do not occur in the retained tail.',
        searchedFields: 'Assistant text blocks and serialized assistant tool inputs in the first 20 assistant messages after the existing postcut 2-second injection cutoff, up to the next compact boundary.',
        interpretation: 'An observed textual match is an upper-bound proxy for candidate content that could have prompted a retrieval. It is not proof of need and can overcount irrelevant quotation or coincidental repetition. It can miss paraphrase and therefore is not a bound on all semantic use.',
      },
      toolDetection: {
        searchSession: 'Tool names ending in search_session, case-insensitive.',
        fileReads: 'Read, NotebookRead, read/read_file tool names, and Bash cat/head/tail/sed -n/less/wc -l commands recognized by the postcut parser.',
      },
      gaps: [
        'No actual disk-backed section retrieval exists in these cuts, so search_session and file reads are observed behavior, not counterfactual fetches of moved sections.',
        'File reads through unrecognized shell commands or tools are not counted.',
        'N-gram matching cannot establish whether matching text was necessary, and paraphrases are missed.',
        'Windows with no assistant call before transcript end or the next cut are right-censored and contribute zero calls.',
        'Recent tail token counts use transcript entries in the 2-second injection window, matching postcut cut handling; unusual timestamp ordering may misclassify an entry.',
      ],
    },
    sample: {
      transcriptFiles: fileCount,
      compactBoundaries: boundaryCount,
      nativeSummariesExcluded: nativeSummaryCount,
      otherBoundariesWithoutPluginSeed: otherNoSeedCount,
      pluginCuts: rows.length,
      sessions: sessions.size,
      cutsWithAssistantCalls: rows.filter((row) => row.assistantCalls > 0).length,
      cutsWithFirstPostCutUsage: rows.filter((row) => row.firstPostCutContextTokens != null).length,
    },
    sectionStats,
    mappingSummaries,
    postCut: {
      assistantCallsObserved: distributions.assistantCallsObserved,
      searchSession: { hitRate: hitRate(rows.map((row) => row.searchSessionCalls)), callsPerCut: distributions.searchSessionCalls },
      fileReads: { hitRate: hitRate(rows.map((row) => row.fileReads)), readsPerCut: distributions.fileReads },
    },
    cuts: safeRows,
    outputPath: outPath,
  };
}

function fmt(value, digits = 0) {
  if (value == null) return '-';
  return Number(value).toFixed(digits);
}

function fmtDistribution(stats, digits = 0) {
  return `median ${fmt(stats.median, digits)}, p25 ${fmt(stats.p25, digits)}, p75 ${fmt(stats.p75, digits)}, p90 ${fmt(stats.p90, digits)}, max ${fmt(stats.max, digits)}`;
}

export function renderMarkdown(report) {
  const formatContextDistribution = (stats) => `median ${fmt(stats.median, 1)}%, p25 ${fmt(stats.p25, 1)}%, p75 ${fmt(stats.p75, 1)}%, p90 ${fmt(stats.p90, 1)}%`;
  const lines = [
    '# Seed section measurement',
    '',
    `Cuts: ${report.sample.pluginCuts} across ${report.sample.sessions} sessions. Scanned ${report.sample.transcriptFiles} JSONL transcripts, including subagent transcripts; excluded ${report.sample.nativeSummariesExcluded} native summaries and ${report.sample.otherBoundariesWithoutPluginSeed} other boundaries without a plugin seed.`,
    `Token estimator: ${report.method.tokenEstimator}.`,
    `First post-cut usage available for ${report.sample.cutsWithFirstPostCutUsage}/${report.sample.pluginCuts} cuts.`,
    '',
    '## Section label mappings',
    '',
    '| Section name | Primary | Conservative |',
    '|---|---|---|',
  ];
  const sectionNames = Object.keys(report.method.sectionLabelMappings.primary);
  for (const name of sectionNames) {
    lines.push(`| ${name} | ${report.method.sectionLabelMappings.primary[name]} | ${report.method.sectionLabelMappings.conservative[name]} |`);
  }
  lines.push('', '## Per-section tokens', '', '| Section | Primary | Conservative | n | Median | p25 | p75 | p90 | Max |', '|---|---|---|---:|---:|---:|---:|---:|---:|');
  for (const [name, stats] of Object.entries(report.sectionStats)) {
    lines.push(`| ${name} | ${stats.labels.primary} | ${stats.labels.conservative} | ${stats.n} | ${fmt(stats.median)} | ${fmt(stats.p25)} | ${fmt(stats.p75)} | ${fmt(stats.p90)} | ${fmt(stats.max)} |`);
  }
  lines.push(
    '',
    `Recent tail is counted as skeleton but sits outside the seed share denominator. Its section row reports retained-tail tokens.`,
    '',
    '## Mapping sensitivity and post-cut context',
    '',
    `Net saved tokens subtract one ${report.method.pointerStub.tokens}-token pointer stub when any disk-candidate section remains. Skeleton share includes the seed frame and pointers.`,
    '',
    '| Measure | Primary mapping | Conservative mapping |',
    '|---|---:|---:|',
    `| Skeleton share of seed | ${fmt(report.mappingSummaries.primary.skeletonShare.median * 100, 1)}% median, p25 ${fmt(report.mappingSummaries.primary.skeletonShare.p25 * 100, 1)}%, p75 ${fmt(report.mappingSummaries.primary.skeletonShare.p75 * 100, 1)}%, p90 ${fmt(report.mappingSummaries.primary.skeletonShare.p90 * 100, 1)}%, max ${fmt(report.mappingSummaries.primary.skeletonShare.max * 100, 1)}% | ${fmt(report.mappingSummaries.conservative.skeletonShare.median * 100, 1)}% median, p25 ${fmt(report.mappingSummaries.conservative.skeletonShare.p25 * 100, 1)}%, p75 ${fmt(report.mappingSummaries.conservative.skeletonShare.p75 * 100, 1)}%, p90 ${fmt(report.mappingSummaries.conservative.skeletonShare.p90 * 100, 1)}%, max ${fmt(report.mappingSummaries.conservative.skeletonShare.max * 100, 1)}% |`,
    `| Net saved tokens per cut | ${fmtDistribution(report.mappingSummaries.primary.netSavedTokensPerCut)} | ${fmtDistribution(report.mappingSummaries.conservative.netSavedTokensPerCut)} |`,
    `| Net saved as share of first post-cut context (n usage available: ${report.mappingSummaries.primary.netSavedPercentOfFirstPostCutContext.n}) | ${formatContextDistribution(report.mappingSummaries.primary.netSavedPercentOfFirstPostCutContext)} | ${formatContextDistribution(report.mappingSummaries.conservative.netSavedPercentOfFirstPostCutContext)} |`,
    `| N-gram match rate | ${report.mappingSummaries.primary.ngramMatchRate.hits}/${report.mappingSummaries.primary.ngramMatchRate.cuts} (${fmt(report.mappingSummaries.primary.ngramMatchRate.rate * 100, 1)}%) | ${report.mappingSummaries.conservative.ngramMatchRate.hits}/${report.mappingSummaries.conservative.ngramMatchRate.cuts} (${fmt(report.mappingSummaries.conservative.ngramMatchRate.rate * 100, 1)}%) |`,
    '',
    `Context size is the first unique non-synthetic assistant message after the 2-second injection cutoff: input + cache-creation input + cache-read input. JSON context-share values are percentages.`,
    '',
    '## Post-cut activity',
    '',
    `search_session: ${report.postCut.searchSession.hitRate.hits}/${report.postCut.searchSession.hitRate.cuts} cuts (${fmt(report.postCut.searchSession.hitRate.rate * 100, 1)}%) had a call; calls per cut: ${fmtDistribution(report.postCut.searchSession.callsPerCut)}.`,
    `File reads: ${report.postCut.fileReads.hitRate.hits}/${report.postCut.fileReads.hitRate.cuts} cuts (${fmt(report.postCut.fileReads.hitRate.rate * 100, 1)}%) had a read; reads per cut: ${fmtDistribution(report.postCut.fileReads.readsPerCut)}.`,
    `N-gram rule: ${report.method.ngramMatch.rule}`,
    'This is an upper-bound proxy for exact textual matches, not proof of need. Coincidental repetition and irrelevant quotation can be false positives; paraphrase can be missed.',
    '',
    '## Limits',
    '',
    ...report.method.gaps.map((gap) => `- ${gap}`),
    '',
  );
  return `${lines.join('\n')}\n`;
}

export async function main(argv = process.argv.slice(2)) {
  const root = path.resolve(os.homedir(), '.claude', 'projects');
  let dataRoot = root;
  let outPath = path.join(os.homedir(), 'reports', '2026-11-12', 'exo-compact-seedsplit', 'run1.json');
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--root') dataRoot = path.resolve(argv[++index]);
    else if (argv[index] === '--out') outPath = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  const files = await walkJsonl(dataRoot);
  const rows = [];
  let boundaries = 0, nativeSummaries = 0, otherNoSeed = 0;
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex];
    const { events: parsed } = await parseJsonl(file);
    const events = parsed.map((row) => row.event);
    const windows = boundaryWindows(events);
    boundaries += windows.length;
    const transcriptKey = crypto.createHash('sha256').update(path.relative(dataRoot, file)).digest('hex').slice(0, 12);
    for (let cutIndex = 0; cutIndex < windows.length; cutIndex++) {
      const row = cutMetrics(events, windows[cutIndex], transcriptKey, cutIndex + 1);
      if (row) rows.push(row);
      else if (events.slice(windows[cutIndex].start + 1, windows[cutIndex].end).some(isSummaryEvent)) nativeSummaries++;
      else otherNoSeed++;
    }
  }
  const report = reportData(rows, files.length, boundaries, nativeSummaries, otherNoSeed, outPath, dataRoot);
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await fs.promises.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(renderMarkdown(report));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
}
