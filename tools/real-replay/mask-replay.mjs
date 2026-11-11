#!/usr/bin/env node
// Estimate observation masking headroom from local main-session transcripts. This tool is offline.
// Transcript text, session identifiers, and file paths are never included in its output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import {
  expandInputs,
  isCompactBoundary,
  isSubagentPath,
  parseTranscriptLine,
  readPaths,
  readUsage,
  summarize,
  timestamp,
  transcriptContent,
  weightedUsage,
  windowName,
} from './postcut.mjs';

const DEFAULT_SINCE = '2026-10-01';
const DEFAULT_K = [5, 10, 20];
export const MASK_PLACEHOLDER = '[Earlier tool output masked.]';
const PLACEHOLDER_CONTENT_TOKENS = Math.ceil(JSON.stringify(MASK_PLACEHOLDER).length / 4);
const IMAGE_BLOCK_TOKEN_ESTIMATE = 1_000;
const SEED = '[[exovault:s4-seed:v1]]';
const WINDOW_GROUPS = ['200k', '1M', 'other'];
const KINDS = ['s4', 'native'];
const MAX_COST_CALLS = 200;
const FIDELITY_CALLS = 20;

const contextSize = (usage) => (usage.input_tokens ?? 0)
  + (usage.cache_creation_input_tokens ?? 0)
  + (usage.cache_read_input_tokens ?? 0);

function textOnlyContent(content) {
  let imageBlocks = 0;
  const strip = (value) => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== 'object') return value;
    const visual = value.type === 'image' || value.type === 'document';
    if (visual) imageBlocks++;
    const clean = {};
    for (const [key, child] of Object.entries(value)) {
      if (visual && key === 'data') continue;
      if (visual && key === 'source' && typeof child === 'string') continue;
      if (visual && key === 'source' && child && typeof child === 'object') {
        const source = { ...child };
        delete source.data;
        clean[key] = strip(source);
      } else {
        clean[key] = strip(child);
      }
    }
    return clean;
  };
  let chars = 0;
  try { chars = JSON.stringify(strip(content ?? '')).length; } catch { chars = 0; }
  return {
    textChars: chars,
    textTokens: Math.ceil(chars / 4),
    imageBlocks,
    imageTokens: imageBlocks * IMAGE_BLOCK_TOKEN_ESTIMATE,
    totalTokens: Math.ceil(chars / 4) + imageBlocks * IMAGE_BLOCK_TOKEN_ESTIMATE,
  };
}

export function estimateContextTokens(events) {
  let chars = 0;
  let imageBlocks = 0;
  for (const event of events) {
    if (event.type !== 'assistant' && event.type !== 'user') continue;
    const content = transcriptContent(event);
    if (typeof content === 'string') {
      chars += content.length;
      continue;
    }
    const measured = textOnlyContent(content);
    chars += measured.textChars;
    imageBlocks += measured.imageBlocks;
  }
  return Math.ceil(chars / 4) + imageBlocks * IMAGE_BLOCK_TOKEN_ESTIMATE;
}

function toolUseNames(events, priorNames = new Map()) {
  const names = new Map(priorNames);
  for (const event of events) recordToolUseNames(event, names);
  return names;
}

function recordToolUseNames(event, names) {
  if (event.type !== 'assistant') return;
  const content = transcriptContent(event);
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type === 'tool_use' && block.id) names.set(block.id, {
      name: typeof block.name === 'string' ? block.name : 'unknown',
      input: block.input ?? {},
    });
  }
}

function findResults(events, names) {
  const knownNames = toolUseNames(events, names);
  const results = [];
  for (const event of events) {
    if (event.type !== 'user') continue;
    const content = transcriptContent(event);
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      const info = knownNames.get(block.tool_use_id) ?? { name: 'unknown', input: {} };
      const measured = textOnlyContent(block.content ?? '');
      results.push({
        tool: info.name ?? 'unknown',
        paths: readPaths(info),
        contentTokens: measured.totalTokens,
        textContentTokens: measured.textTokens,
        imageBlocks: measured.imageBlocks,
        imageTokens: measured.imageTokens,
      });
    }
  }
  return results;
}

function callsBeforeCut(events, cutTime) {
  const calls = [];
  const seen = new Set();
  let sequence = 0;
  for (const event of events) {
    sequence++;
    if (event.type !== 'assistant' || event.message?.model === '<synthetic>') continue;
    const time = timestamp(event);
    if (time && cutTime && time > cutTime) continue;
    const id = event.message?.id ?? event.uuid ?? `before-${sequence}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const usage = readUsage(event);
    calls.push({ usage, context: contextSize(usage) });
  }
  return calls;
}

export function medianContextGrowth(contextSizes) {
  const deltas = [];
  for (let index = 1; index < contextSizes.length; index++) deltas.push(contextSizes[index] - contextSizes[index - 1]);
  return summarize(deltas).median;
}

export function estimateDeferral(freedTokens, medianGrowth) {
  if (!Number.isFinite(freedTokens) || !Number.isFinite(medianGrowth) || medianGrowth <= 0) return null;
  return freedTokens / medianGrowth;
}

function rawResultRows(events, toolNames) {
  return findResults(events, toolNames);
}

function makeCut(event, contextEvents, toolNames, sequence) {
  const metadata = event.compactMetadata ?? {};
  return {
    time: timestamp(event),
    preTokens: Number.isFinite(metadata.preTokens) ? metadata.preTokens : null,
    postTokens: Number.isFinite(metadata.postTokens) ? metadata.postTokens : null,
    contextEvents,
    toolNames: new Map(toolNames),
    kind: null,
    injectionTime: 0,
    callsAfter: [],
    callIds: new Set(),
    sequence,
  };
}

function addPostCutEvent(cut, event, sequence) {
  const time = timestamp(event);
  if (event.type === 'user') {
    if (!cut.injectionTime) cut.injectionTime = time || cut.time;
    if (typeof transcriptContent(event) === 'string') {
      const text = transcriptContent(event);
      if (text.includes(SEED)) cut.kind = 's4';
      else if (!cut.kind) cut.kind = 'native';
    }
  }
  if (event.type !== 'assistant' || event.message?.model === '<synthetic>') return;
  const id = event.message?.id ?? event.uuid ?? `assistant-${sequence}`;
  if (time && time > cut.time && (!cut.injectionTime || time >= cut.injectionTime) && !cut.callIds.has(id)) {
    cut.callIds.add(id);
    if (cut.callsAfter.length < MAX_COST_CALLS) {
      const content = transcriptContent(event);
      const paths = Array.isArray(content)
        ? content.filter((block) => block?.type === 'tool_use').flatMap((block) => readPaths({ name: block.name, input: block.input }))
        : [];
      cut.callsAfter.push({ usage: readUsage(event), paths });
    }
  }
}

async function scanTranscript(file, since, until, state) {
  if (isSubagentPath(file)) return;
  let activeEvents = [];
  let currentCut = null;
  let allToolNames = new Map();
  let sequence = 0;
  const stream = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });

  const finalize = (cut) => {
    if (!cut || !cut.time || cut.time < since || cut.time > until || !KINDS.includes(cut.kind)) return;
    const contextEstimate = estimateContextTokens(cut.contextEvents);
    const beforeCalls = callsBeforeCut(cut.contextEvents, cut.time);
    const observedContext = [...beforeCalls].reverse().find((call) => call.context > 0)?.context ?? null;
    const results = rawResultRows(cut.contextEvents, cut.toolNames);
    const medianGrowth = medianContextGrowth(beforeCalls.slice(-20).map((call) => call.context));
    state.cuts.push({
      kind: cut.kind,
      window: windowName(cut.preTokens),
      preTokens: cut.preTokens,
      postTokens: cut.postTokens,
      contextEstimate,
      observedContext,
      results,
      medianGrowth,
      postCutUsages: cut.callsAfter.map((call) => call.usage),
      postCutReadPaths: cut.callsAfter.slice(0, FIDELITY_CALLS).flatMap((call) => call.paths),
      _session: `cut-${state.cuts.length + 1}`,
    });
  };

  for await (const line of stream) {
    const parsed = parseTranscriptLine(line);
    if (parsed.malformed) { state.malformedLines++; continue; }
    if (parsed.event === undefined) continue;
    const event = parsed.event;
    sequence++;
    if (isCompactBoundary(event)) {
      finalize(currentCut);
      currentCut = makeCut(event, activeEvents, allToolNames, sequence);
      activeEvents = [];
      continue;
    }
    if (currentCut) addPostCutEvent(currentCut, event, sequence);
    recordToolUseNames(event, allToolNames);
    activeEvents.push(event);
  }
  finalize(currentCut);
}

function calibrationFor(cuts) {
  const rows = cuts.filter((cut) => cut.observedContext > 0 && cut.contextEstimate > 0);
  const ratios = rows.map((cut) => cut.contextEstimate / cut.observedContext);
  const ratioStats = summarize(ratios);
  const errors = ratios.map((ratio) => ratio - 1);
  return {
    estimateToUsageRatio: ratioStats,
    medianRelativeError: summarize(errors),
    tokensScale: 1,
    tokensScaleApplied: false,
    ratioDefinition: 'text-estimated whole pre-cut context divided by the last assistant call context usage before the cut',
    scaleDecision: 'No scale is applied. The transcript estimate omits system context and request overhead, so multiplying tool result estimates by the whole-context ratio would attribute those missing tokens to tool outputs.',
  };
}

function headroomForCut(cut, keepLast, scale) {
  const oldResults = cut.results.slice(0, Math.max(0, cut.results.length - keepLast));
  const toolRows = new Map();
  let rawToolTokens = 0;
  for (const result of cut.results) rawToolTokens += result.contentTokens;
  let rawOriginal = 0;
  let rawPlaceholder = 0;
  let maskedImageBlocks = 0;
  let maskedImageTokens = 0;
  for (const result of oldResults) {
    rawOriginal += result.contentTokens;
    rawPlaceholder += PLACEHOLDER_CONTENT_TOKENS;
    maskedImageBlocks += result.imageBlocks;
    maskedImageTokens += result.imageTokens;
    const row = toolRows.get(result.tool) ?? {
      maskedResults: 0,
      contentTokens: 0,
      placeholderTokens: 0,
      imageBlocks: 0,
      imageTokens: 0,
    };
    row.maskedResults++;
    row.contentTokens += result.contentTokens;
    row.placeholderTokens += PLACEHOLDER_CONTENT_TOKENS;
    row.imageBlocks += result.imageBlocks;
    row.imageTokens += result.imageTokens;
    toolRows.set(result.tool, row);
  }
  for (const row of toolRows.values()) {
    row.contentTokens *= scale;
    row.placeholderTokens *= scale;
  }
  const freedTokens = (rawOriginal - rawPlaceholder) * scale;
  return {
    n: cut.results.length,
    toolResults: cut.results.length,
    toolResultTokens: rawToolTokens * scale,
    maskedResults: oldResults.length,
    maskedImageBlocks,
    maskedImageTokens,
    maskedContentTokens: rawOriginal * scale,
    placeholderTokens: rawPlaceholder * scale,
    freedTokens,
    rawFreedTokens: rawOriginal - rawPlaceholder,
    freedShareOfPreTokens: cut.preTokens > 0 ? freedTokens / cut.preTokens : null,
    toolRows,
  };
}

function statsForRows(rows, field) {
  return summarize(rows.map((row) => row[field]));
}

function summarizeHeadroom(rows) {
  return {
    n: rows.length,
    cutsWithMaskedImageBlocks: rows.filter((row) => row.maskedImageBlocks > 0).length,
    maskedImageBlockTotal: rows.reduce((sum, row) => sum + row.maskedImageBlocks, 0),
    maskedImageTokenTotal: rows.reduce((sum, row) => sum + row.maskedImageTokens, 0),
    preTokens: statsForRows(rows, 'preTokens'),
    toolResults: statsForRows(rows, 'toolResults'),
    toolResultTokens: statsForRows(rows, 'toolResultTokens'),
    maskedResults: statsForRows(rows, 'maskedResults'),
    maskedImageBlocks: statsForRows(rows, 'maskedImageBlocks'),
    maskedImageTokens: statsForRows(rows, 'maskedImageTokens'),
    maskedContentTokens: statsForRows(rows, 'maskedContentTokens'),
    placeholderTokens: statsForRows(rows, 'placeholderTokens'),
    freedTokens: statsForRows(rows, 'freedTokens'),
    rawFreedTokens: statsForRows(rows, 'rawFreedTokens'),
    freedShareOfPreTokens: statsForRows(rows, 'freedShareOfPreTokens'),
  };
}

function summarizeToolRows(rows) {
  const tools = new Map();
  for (const row of rows) {
    for (const [name, contribution] of row.toolRows) {
      const values = tools.get(name) ?? [];
      values.push(contribution);
      tools.set(name, values);
    }
  }
  return Object.fromEntries([...tools.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, values]) => [name, {
    n: values.length,
    maskedResults: summarize(values.map((value) => value.maskedResults)),
    maskedImageBlocks: summarize(values.map((value) => value.imageBlocks)),
    maskedImageTokens: summarize(values.map((value) => value.imageTokens)),
    maskedContentTokens: summarize(values.map((value) => value.contentTokens)),
    placeholderTokens: summarize(values.map((value) => value.placeholderTokens)),
    freedTokens: summarize(values.map((value) => (value.contentTokens - value.placeholderTokens))),
  }]));
}

function normalizedReadPaths(paths) {
  return new Set(paths.map((value) => path.normalize(value)));
}

function readFidelityForCut(cut, keepLast) {
  const split = Math.max(0, cut.results.length - keepLast);
  const maskedPaths = cut.results.slice(0, split).flatMap((result) => result.paths);
  const keptPaths = cut.results.slice(split).flatMap((result) => result.paths);
  const postCutPaths = normalizedReadPaths(cut.postCutReadPaths ?? []);
  const replayed = (paths) => paths.filter((filePath) => postCutPaths.has(path.normalize(filePath))).length;
  return {
    masked: { n: maskedPaths.length, repeated: replayed(maskedPaths) },
    kept: { n: keptPaths.length, repeated: replayed(keptPaths) },
  };
}

function summarizeFidelity(cuts, keepLast) {
  const rows = cuts.map((cut) => readFidelityForCut(cut, keepLast));
  const summarizeSide = (side) => {
    const n = rows.reduce((sum, row) => sum + row[side].n, 0);
    const repeated = rows.reduce((sum, row) => sum + row[side].repeated, 0);
    return {
      cuts: rows.filter((row) => row[side].n > 0).length,
      n,
      repeated,
      share: n ? repeated / n : null,
    };
  };
  return { masked: summarizeSide('masked'), kept: summarizeSide('kept') };
}

function summarizeDeferral(rows) {
  const eligible = rows.filter((row) => row.estimatedExtraCalls != null);
  return {
    n: eligible.length,
    medianPerCallContextGrowthTokens: summarize(rows.map((row) => row.medianGrowth)),
    estimatedExtraCalls: summarize(eligible.map((row) => row.estimatedExtraCalls)),
  };
}

function costHorizonCalls(cut, keepLast, horizon) {
  if (horizon === 20) return 20;
  const freed = headroomForCut(cut, keepLast, 1).freedTokens;
  if (!Number.isFinite(freed) || !Number.isFinite(cut.medianGrowth) || cut.medianGrowth <= 0) return null;
  return Math.min(MAX_COST_CALLS, Math.max(0, Math.ceil(freed / cut.medianGrowth)));
}

function compareCostAtHorizon(cut, keepLast, calls) {
  if (!Number.isFinite(cut.preTokens) || !Number.isFinite(cut.medianGrowth) || cut.medianGrowth <= 0) return null;
  const usages = cut.postCutUsages ?? [];
  if (calls > 0 && !usages.length) return null;
  const headroom = headroomForCut(cut, keepLast, 1);
  const maskedContext = Math.max(0, cut.preTokens - headroom.freedTokens);
  const measuredCount = Math.min(calls, usages.length);
  const measuredUsages = usages.slice(0, measuredCount);
  const measuredOutputs = measuredUsages.map((usage) => usage.output_tokens ?? 0);
  const extensionOutputTokens = summarize(measuredOutputs).median ?? 0;
  const outputAt = (index) => index < measuredCount ? measuredOutputs[index] : extensionOutputTokens;

  let maskedPathCost = 0;
  if (calls > 0) maskedPathCost = maskedContext * 1.25 + 5 * outputAt(0);
  for (let index = 1; index < calls; index++) {
    const priorContext = maskedContext + (index - 1) * cut.medianGrowth;
    maskedPathCost += 0.1 * priorContext + 1.25 * cut.medianGrowth + 5 * outputAt(index);
  }

  let realPathCost = measuredUsages.reduce((sum, usage) => sum + weightedUsage(usage), 0);
  for (let index = measuredCount; index < calls; index++) {
    const lastContext = contextSize(usages[measuredCount - 1]);
    const context = lastContext + (index - measuredCount + 1) * cut.medianGrowth;
    realPathCost += 0.1 * context + 5 * extensionOutputTokens;
  }
  return {
    calls,
    measuredCalls: measuredCount,
    extendedCalls: calls - measuredCount,
    maskedPathCost,
    realPathCost,
    difference: maskedPathCost - realPathCost,
  };
}

function summarizePairedCosts(cuts, keepLast, kind, horizon) {
  const rows = cuts.filter((cut) => cut.kind === kind).flatMap((cut) => {
    const calls = costHorizonCalls(cut, keepLast, horizon);
    if (calls == null) return [];
    const compared = compareCostAtHorizon(cut, keepLast, calls);
    return compared ? [compared] : [];
  });
  const cheaperCount = rows.filter((row) => row.difference < 0).length;
  return {
    n: rows.length,
    calls: summarize(rows.map((row) => row.calls)),
    measuredCalls: summarize(rows.map((row) => row.measuredCalls)),
    extendedCalls: summarize(rows.map((row) => row.extendedCalls)),
    maskedPathCost: summarize(rows.map((row) => row.maskedPathCost)),
    realPathCost: summarize(rows.map((row) => row.realPathCost)),
    maskedMinusReal: summarize(rows.map((row) => row.difference)),
    maskingCheaper: {
      count: cheaperCount,
      share: rows.length ? cheaperCount / rows.length : null,
    },
  };
}

function aggregateHeadroom(cuts, kValues, scale) {
  const out = {};
  for (const keepLast of kValues) {
    const rows = cuts.map((cut) => ({
      ...headroomForCut(cut, keepLast, scale),
      kind: cut.kind,
      window: cut.window,
      preTokens: cut.preTokens,
    }));
    const byKind = Object.fromEntries(KINDS.map((kind) => [kind, summarizeHeadroom(rows.filter((row) => row.kind === kind))]));
    const byWindow = Object.fromEntries(WINDOW_GROUPS.map((group) => [group, summarizeHeadroom(rows.filter((row) => row.window === group))]));
    const byWindowAndKind = Object.fromEntries(WINDOW_GROUPS.map((group) => [group, Object.fromEntries(KINDS.map((kind) => [kind,
      summarizeHeadroom(rows.filter((row) => row.window === group && row.kind === kind)),
    ]))]));
    const perCut = new Map(cuts.map((cut, index) => [cut, rows[index]]));
    const deferralRows = cuts.map((cut) => ({
      kind: cut.kind,
      window: cut.window,
      medianGrowth: cut.medianGrowth,
      estimatedExtraCalls: estimateDeferral(perCut.get(cut).freedTokens, cut.medianGrowth),
    }));
    const deferral = {
      all: summarizeDeferral(deferralRows),
      byKind: Object.fromEntries(KINDS.map((kind) => [kind, summarizeDeferral(deferralRows.filter((row) => row.kind === kind))])),
      byWindow: Object.fromEntries(WINDOW_GROUPS.map((group) => [group, summarizeDeferral(deferralRows.filter((row) => row.window === group))])),
    };
    out[String(keepLast)] = {
      all: summarizeHeadroom(rows),
      byKind,
      byWindow,
      byWindowAndKind,
      byTool: summarizeToolRows(rows),
      deferral,
      readReplayProxy: summarizeFidelity(cuts, keepLast),
    };
  }
  return out;
}

function aggregateCosts(cuts, kValues) {
  const out = {};
  for (const keepLast of kValues) {
    out[String(keepLast)] = {};
    for (const kind of KINDS) {
      const selected = cuts.filter((cut) => cut.kind === kind);
      const growthEligible = selected.map((cut) => costHorizonCalls(cut, keepLast, 'deferral'))
        .filter((calls) => calls != null);
      out[String(keepLast)][kind] = {
        paired: {
          fixed20: summarizePairedCosts(cuts, keepLast, kind, 20),
          deferral: summarizePairedCosts(cuts, keepLast, kind, 'deferral'),
        },
        cutAgainAfterDeferral: {
          seedEvents: growthEligible.length,
          callsToNextCut: summarize(growthEligible),
          includedInPairedHorizonCost: false,
        },
      };
    }
  }
  return out;
}

function parseDay(value, isEnd = false) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('date options must be non-empty');
  const text = value.trim();
  const instant = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? Date.parse(`${text}T${isEnd ? '23:59:59.999' : '00:00:00.000'}Z`)
    : Date.parse(text);
  if (!Number.isFinite(instant)) throw new Error('date options must be valid dates or timestamps');
  return instant;
}

function parseArgs(argv) {
  let root = path.join(os.homedir(), '.claude', 'projects');
  let sinceText = DEFAULT_SINCE;
  let untilText = new Date().toISOString().slice(0, 10);
  let kValues = [...DEFAULT_K];
  let jsonOut;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--root') root = argv[++index];
    else if (arg === '--since') sinceText = argv[++index];
    else if (arg === '--until') untilText = argv[++index];
    else if (arg === '--k') {
      const value = argv[++index];
      kValues = String(value ?? '').split(',').map((entry) => Number(entry.trim()));
      if (!kValues.length || kValues.some((value) => !Number.isSafeInteger(value) || value < 1)) throw new Error('--k must be a comma-separated list of positive integers');
      kValues = [...new Set(kValues)];
    } else if (arg === '--json') jsonOut = argv[++index];
    else throw new Error('Usage: node tools/real-replay/mask-replay.mjs [--root path] [--since date] [--until date] [--k 5,10,20] [--json report.json]');
  }
  if (!root) throw new Error('--root requires a path');
  if (root === '~') root = os.homedir();
  else if (root.startsWith('~/')) root = path.join(os.homedir(), root.slice(2));
  const since = parseDay(sinceText);
  const until = parseDay(untilText, true);
  if (until < since) throw new Error('--until must be on or after --since');
  return { root, since, until, sinceText, untilText, kValues, jsonOut };
}

function number(value, digits = 0) {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function formatStats(stats, digits = 0) {
  if (!stats?.n) return 'n=0';
  return `n=${stats.n}, median ${number(stats.median, digits)}, IQR ${number(stats.q1, digits)}..${number(stats.q3, digits)}`;
}

function percentage(value, digits = 1) {
  return value == null || !Number.isFinite(value) ? 'n/a' : `${number(value * 100, digits)}%`;
}

function printReport(report) {
  console.log(`Run ${report.runAt}; cut range ${report.since} through ${report.until}; main transcripts ${report.transcriptsScanned}; cuts ${report.cuts.n} (exo ${report.cuts.s4}, native ${report.cuts.native}); malformed lines skipped ${report.malformedLines}`);
  console.log(`Calibration estimate/usage ratio: ${formatStats(report.calibration.estimateToUsageRatio, 3)}; scale applied ${report.calibration.tokensScaleApplied ? number(report.calibration.tokensScale, 3) : 'no'}`);
  console.log(`Masked image blocks use ${number(IMAGE_BLOCK_TOKEN_ESTIMATE)} estimated tokens each; base64 excluded from text estimates.`);
  for (const keepLast of report.kValues) {
    const row = report.headroom[String(keepLast)];
    console.log(`K=${keepLast}: freed ${formatStats(row.all.freedTokens)} tokens; freed/preTokens ${formatStats(row.all.freedShareOfPreTokens, 4)}; masked results ${formatStats(row.all.maskedResults)}`);
    console.log(`  masked image blocks: ${row.all.cutsWithMaskedImageBlocks} cuts; ${number(row.all.maskedImageBlockTotal)} blocks; ${number(row.all.maskedImageTokenTotal)} estimated tokens`);
    for (const group of WINDOW_GROUPS) console.log(`  window ${group}: ${formatStats(row.byWindow[group].freedTokens)} tokens; share ${formatStats(row.byWindow[group].freedShareOfPreTokens, 4)}`);
    for (const kind of KINDS) console.log(`  ${kind}: ${formatStats(row.byKind[kind].freedTokens)} tokens; share ${formatStats(row.byKind[kind].freedShareOfPreTokens, 4)}`);
    const topTools = Object.entries(row.byTool)
      .sort((a, b) => (b[1].freedTokens.median ?? -Infinity) - (a[1].freedTokens.median ?? -Infinity))
      .slice(0, 8);
    for (const [tool, stats] of topTools) console.log(`  tool ${tool}: ${formatStats(stats.freedTokens)} tokens; masked results ${formatStats(stats.maskedResults)}`);
    const deferral = report.deferral.byK[String(keepLast)];
    console.log(`  deferral estimate: ${formatStats(deferral.all.estimatedExtraCalls, 2)} calls; median per-call growth ${formatStats(deferral.all.medianPerCallContextGrowthTokens)} tokens`);
    for (const side of ['masked', 'kept']) {
      const fidelity = row.readReplayProxy[side];
      console.log(`  Read replay proxy ${side}: ${fidelity.repeated}/${fidelity.n} paths (${percentage(fidelity.share)}), ${fidelity.cuts} cuts`);
    }
    for (const kind of KINDS) {
      const cost = report.cost[String(keepLast)][kind];
      console.log(`  ${kind} paired cost:`);
      for (const horizon of ['fixed20', 'deferral']) {
        const paired = cost.paired[horizon];
        console.log(`    ${horizon}: n=${paired.n}; median N ${number(paired.calls.median, 1)}; masked minus real median ${number(paired.maskedMinusReal.median)} (IQR ${number(paired.maskedMinusReal.q1)}..${number(paired.maskedMinusReal.q3)}); mask cheaper ${percentage(paired.maskingCheaper.share)}; median extended calls ${number(paired.extendedCalls.median)}`);
      }
      console.log(`    masked path reaches cut again and pays a seed after deferral: ${cost.cutAgainAfterDeferral.seedEvents} cuts`);
    }
  }
  console.log(report.deferral.assumption);
}

export function aggregateMaskReplay(cuts, options, transcriptsScanned, malformedLines = 0) {
  const calibration = calibrationFor(cuts);
  const headroom = aggregateHeadroom(cuts, options.kValues, calibration.tokensScale);
  const costs = aggregateCosts(cuts, options.kValues);
  const deferral = {
    assumption: 'This is an estimate, not a replay past the cut: text-estimated freed tokens divided by the median context growth across adjacent assistant calls among the last 20 calls before the cut.',
  };
  return {
    runAt: new Date().toISOString(),
    since: options.sinceText,
    until: options.untilText,
    transcriptsScanned,
    malformedLines,
    kValues: options.kValues,
    placeholder: {
      text: MASK_PLACEHOLDER,
      tokenEstimate: PLACEHOLDER_CONTENT_TOKENS,
      tokenRule: 'ceil(JSON.stringify(placeholder text).length / 4), matching the tool_result content estimator',
    },
    imageTokenEstimate: {
      tokensPerBlock: IMAGE_BLOCK_TOKEN_ESTIMATE,
      blockTypes: ['image', 'document'],
      rule: 'Assumption: each image or document block is 1,000 tokens; base64 payload bytes are removed before the text estimate.',
    },
    cuts: {
      n: cuts.length,
      s4: cuts.filter((cut) => cut.kind === 's4').length,
      native: cuts.filter((cut) => cut.kind === 'native').length,
      byWindow: Object.fromEntries(WINDOW_GROUPS.map((group) => [group, {
        s4: cuts.filter((cut) => cut.window === group && cut.kind === 's4').length,
        native: cuts.filter((cut) => cut.window === group && cut.kind === 'native').length,
      }])),
    },
    calibration,
    headroom: Object.fromEntries(options.kValues.map((keepLast) => [String(keepLast), {
      all: headroom[String(keepLast)].all,
      byKind: headroom[String(keepLast)].byKind,
      byWindow: headroom[String(keepLast)].byWindow,
      byWindowAndKind: headroom[String(keepLast)].byWindowAndKind,
      byTool: headroom[String(keepLast)].byTool,
      readReplayProxy: headroom[String(keepLast)].readReplayProxy,
    }])),
    deferral: {
      assumption: deferral.assumption,
      byK: Object.fromEntries(options.kValues.map((keepLast) => [String(keepLast), headroom[String(keepLast)].deferral])),
    },
    cost: costs,
    costAssumption: 'Paired horizons compare a first-call batch cache write of the masked context plus output, then cache reads of the prior context, cache writes of new tokens at measured median per-call growth, and the same observed output against measured post-cut weightedUsage. Horizons are 20 calls and ceil(freed tokens / median growth), capped at 200. Where fewer measured calls exist, the real path is extended with cache reads from its last measured context at the same growth and median observed output. A deferred seed at the next cut is counted separately and is outside the paired horizon cost.',
    fidelityAssumption: 'Read replay is an exact normalized file-path proxy: masked or retained Read, NotebookRead, or READ_BASH-derived paths are checked against reads in the first 20 assistant calls after the real cut. It is not a quality measure.',
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const files = expandInputs([options.root]).filter((file) => !isSubagentPath(file));
  const state = { cuts: [], malformedLines: 0 };
  for (const file of files) await scanTranscript(file, options.since, options.until, state);
  const report = aggregateMaskReplay(state.cuts, options, files.length, state.malformedLines);
  if (options.jsonOut) fs.writeFileSync(options.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  printReport(report);
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  main().catch((error) => {
    const candidate = error instanceof Error ? error.message : '';
    const isOptionError = /^(date options|--since|--until|--root|--k|Usage:)/.test(candidate);
    const message = isOptionError ? candidate : 'Replay failed due to an input or report file error.';
    console.error(message);
    process.exitCode = 1;
  });
}
