#!/usr/bin/env node
// Aggregate the context and API-equivalent cost of the first assistant calls after each cut.
// Transcript contents and identifiers stay out of stdout and the optional JSON report.
//
//   node tools/real-replay/postcut.mjs [--since 2026-10-01] [--json aggregate.json] <transcript-or-directory>...
//
// Cost units: input 1, 5-minute cache write 1.25, 1-hour cache write 2, cache read 0.1,
// output 5. If cache-write TTL splits are absent, cache writes use 1.25. PRICE_PER_MTOK
// (default 5) converts input-token equivalents to dollars. Window groups are inferred from
// preTokens because Claude Code transcript records do not consistently store the configured window.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const SEED = '[[exovault:s4-seed:v1]]';
const PRICE = Number(process.env.PRICE_PER_MTOK ?? 5);
const DEFAULT_SINCE = Date.parse('2026-10-01T00:00:00Z');
const CALL_COUNTS = [1, 5, 20];
const CUMULATIVE_CALL_COUNTS = Array.from({ length: 20 }, (_, index) => index + 1);
const WRITE = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SEARCH = new Set(['Grep', 'Glob']);
const SEARCH_BASH = /(^|[;&|(]\s*)(grep|rg|find|ls|git (log|grep|ls-files))\b/;
const READ_BASH = /(?:^|[;&|(]\s*)(?:cat|head|tail|sed -n \S+|less|wc -l)(?:\s+-\S+)*\s+([^\s|;&<>]+)/g;
const RECOVERY_TOOL_WINDOW = 20;
const IDLE_S = 120;

const eventContent = (e) => (e.message && typeof e.message === 'object' ? e.message.content : e.content);
const eventText = (e) => {
  const c = eventContent(e);
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((part) => part?.text ?? (typeof part?.content === 'string' ? part.content : '')).join('\n');
};
const eventTime = (e) => Date.parse(e.timestamp ?? '') || 0;
const isSubagentPath = (file) => file.split(path.sep).includes('subagents');
const toolUses = (e) => (e.type === 'assistant' && Array.isArray(eventContent(e)) ? eventContent(e).filter((b) => b.type === 'tool_use') : []);
const isRealUser = (e) => e.type === 'user' && !e.isMeta && !e.isCompactSummary && typeof eventContent(e) === 'string' && !eventContent(e).startsWith(SEED) && !eventContent(e).startsWith('<');

function readPaths(tool) {
  const input = tool.input ?? {};
  if (tool.name === 'Read' || tool.name === 'NotebookRead') return [String(input.file_path ?? '')].filter(Boolean);
  if (tool.name === 'Bash') return [...String(input.command ?? '').matchAll(READ_BASH)].map((match) => match[1]).filter((p) => /[/.]/.test(p));
  return [];
}
const isSearch = (tool) => SEARCH.has(tool.name) || (tool.name === 'Bash' && SEARCH_BASH.test(String(tool.input?.command ?? '')));
function named(seed, filePath) {
  if (seed.includes(filePath)) return true;
  const parts = filePath.split('/').filter(Boolean);
  for (let k = Math.min(parts.length, 3); k >= 2; k--) if (seed.includes(parts.slice(-k).join('/'))) return true;
  const base = parts.at(-1) ?? '';
  return base.length >= 8 && seed.includes(base);
}

function readUsage(e) {
  const usage = e.message?.usage ?? {};
  const keys = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];
  const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
  const out = {};
  for (const key of keys) {
    const fromIterations = iterations.reduce((total, iteration) => total + (Number(iteration?.[key]) || 0), 0);
    const hasIterationValue = iterations.some((iteration) => Number.isFinite(Number(iteration?.[key])));
    out[key] = hasIterationValue ? fromIterations : (Number(usage[key]) || 0);
  }
  const iterationCreationSources = iterations.map((iteration) => iteration?.cache_creation);
  const ttlKeys = ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'];
  const hasIterationTtlSplit = iterationCreationSources.some((creation) => ttlKeys.some((key) => creation?.[key] != null
    && Number.isFinite(Number(creation[key]))));
  const creationSources = hasIterationTtlSplit ? iterationCreationSources : [usage.cache_creation];
  const hasTtlSplit = creationSources.some((creation) => ttlKeys.some((key) => creation?.[key] != null
    && Number.isFinite(Number(creation[key]))));
  if (hasTtlSplit) {
    out.cache_creation = Object.fromEntries(ttlKeys.map((key) => [key,
      creationSources.reduce((total, creation) => total + (Number(creation?.[key]) || 0), 0),
    ]));
  }
  return out;
}

export function weightedUsage(usage) {
  const cacheCreation = usage.cache_creation ?? {};
  const hasTtlSplit = [cacheCreation.ephemeral_5m_input_tokens, cacheCreation.ephemeral_1h_input_tokens]
    .some((value) => value != null && Number.isFinite(Number(value)));
  const cacheWriteCost = hasTtlSplit
    ? 1.25 * (Number(cacheCreation.ephemeral_5m_input_tokens) || 0)
      + 2 * (Number(cacheCreation.ephemeral_1h_input_tokens) || 0)
    : 1.25 * (usage.cache_creation_input_tokens ?? 0);
  return (usage.input_tokens ?? 0)
    + cacheWriteCost
    + 0.1 * (usage.cache_read_input_tokens ?? 0)
    + 5 * (usage.output_tokens ?? 0);
}

export function estimateCardRefreshEquivalent(contextTokens, cardSizeTokens) {
  return 0.1 * contextTokens + 5 * cardSizeTokens;
}

function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const quantile = (p) => {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * p;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  };
  return {
    n: sorted.length,
    median: quantile(0.5),
    q1: quantile(0.25),
    q3: quantile(0.75),
    min: sorted.length ? sorted[0] : null,
    max: sorted.length ? sorted.at(-1) : null,
  };
}

function summarizeRecovery(values) {
  const stats = summarize(values);
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  stats.median = sorted.length ? sorted[sorted.length >> 1] : null;
  return stats;
}

function makeCut(e, sequence, session) {
  const metadata = e.compactMetadata ?? {};
  return {
    sequence,
    session,
    time: eventTime(e),
    seed: false,
    kind: null,
    sawUserText: false,
    injectionTime: 0,
    seedTextParts: [],
    summaryTokens: null,
    preTokens: Number.isFinite(metadata.preTokens) ? metadata.preTokens : null,
    postTokens: Number.isFinite(metadata.postTokens) ? metadata.postTokens : null,
    trigger: metadata.trigger,
    calls: [],
    callIds: new Set(),
    recoveryTimeline: [],
    firstRealUserIndex: null,
    firstAssistantIndex: null,
    recoveryAssistantCalls: [],
    recoveryCallIds: new Set(),
    toolCalls: [],
    toolResultTokens: new Map(),
    cardRefreshEstimates: [],
  };
}

function windowName(preTokens) {
  if (!Number.isFinite(preTokens)) return 'other';
  if (preTokens >= 500_000) return '1M';
  if (preTokens >= 100_000 && preTokens < 350_000) return '200k';
  return 'other';
}

function finalizeCut(cut, out) {
  if (!cut || !cut.time || cut.time < out.since) return;
  const kind = cut.kind ?? (cut.seed ? 's4' : (cut.sawUserText ? 'native' : null));
  if (kind !== 's4' && kind !== 'native') return;
  const first = cut.calls[0];
  out.cuts.push({
    kind,
    _session: cut.session,
    window: windowName(cut.preTokens),
    cardRefreshCount: cut.cardRefreshEstimates.length,
    cardRefreshEstimate: cut.cardRefreshEstimates.reduce((sum, estimate) => sum + estimate, 0),
    firstContext: first ? first.input_tokens + first.cache_creation_input_tokens + first.cache_read_input_tokens : null,
    preTokens: cut.preTokens,
    postTokens: cut.postTokens,
    callCosts: cut.calls.map(weightedUsage),
  });

  if (kind === 'native' && cut.summaryTokens != null) {
    out.nativeSummaryOutput.push(cut.summaryTokens);
    if (Number.isFinite(cut.preTokens)) {
      out.nativeSummaryLowerBounds.push(0.1 * cut.preTokens + 5 * cut.summaryTokens);
    }
  }

  const firstWrite = cut.toolCalls.findIndex(({ tool }) => WRITE.has(tool.name));
  const win = cut.toolCalls.slice(0, firstWrite >= 0 ? Math.min(firstWrite, RECOVERY_TOOL_WINDOW) : RECOVERY_TOOL_WINDOW);
  const winIds = new Set(win.map(({ tool }) => tool.id));
  const lastTime = win.length ? win.at(-1).time : (cut.injectionTime || cut.time);
  const seen = new Set();
  let recoveryCost = 0, recoveryCalls = 0, recoveryContext = 0;
  for (const call of cut.recoveryAssistantCalls) {
    if (call.time > lastTime || seen.has(call.id)) continue;
    seen.add(call.id);
    if (!recoveryCalls) recoveryContext = call.usage.input_tokens + call.usage.cache_creation_input_tokens + call.usage.cache_read_input_tokens;
    recoveryCost += weightedUsage(call.usage);
    recoveryCalls++;
  }
  const readList = win.flatMap(({ tool }) => readPaths(tool));
  const pulled = [...winIds].reduce((sum, id) => sum + (cut.toolResultTokens.get(id) ?? 0), 0);
  let activeSeconds = null, userBeforeWrite = false;
  if (firstWrite >= 0) {
    const until = cut.toolCalls[firstWrite].time;
    let previous = cut.injectionTime || cut.time;
    activeSeconds = 0;
    for (const item of cut.recoveryTimeline) {
      if (item.time > until) break;
      if (item.realUser) userBeforeWrite = true;
      activeSeconds += Math.min(IDLE_S, Math.max(0, item.time - previous) / 1000);
      previous = item.time;
    }
    activeSeconds = Math.round(activeSeconds);
  }
  out.recovery.push({
    kind,
    session: cut.session,
    trigger: cut.trigger,
    preTokens: cut.preTokens,
    continuation: cut.firstAssistantIndex != null && (cut.firstRealUserIndex == null || cut.firstAssistantIndex < cut.firstRealUserIndex),
    seedTokens: Math.ceil(cut.seedTextParts.join('\n').length / 4),
    firstContext: recoveryContext,
    window: win.length,
    reachedWrite: firstWrite >= 0 && firstWrite < 60,
    toFirstWrite: firstWrite >= 0 ? firstWrite : null,
    activeSeconds,
    userBeforeWrite,
    calls: recoveryCalls,
    cost: Math.round(recoveryCost),
    pulledTokens: pulled,
    reads: readList.length,
    readsNamed: readList.filter((filePath) => named(cut.seedTextParts.join('\n'), filePath)).length,
    searches: win.filter(({ tool }) => isSearch(tool)).length,
    recalls: win.filter(({ tool }) => /exovault-recall__/.test(tool.name)).length,
  });
}

function compactSummary(e) {
  return e.type === 'user' && (
    e.isCompactSummary === true
    || e.message?.isCompactSummary === true
    || e.message?.compactSummary === true
    || e.subtype === 'compact_summary'
  );
}

async function analyzeTranscript(file, since, output) {
  const subagent = isSubagentPath(file);
  let current = null;
  let pendingCardRefreshContext = null;
  let cardRefreshSpan = [];
  let sequence = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    sequence++;

    const time = eventTime(e);
    if (subagent) continue;
    if (e.type === 'system' && e.subtype === 'informational') {
      const notice = eventText(e);
      const refreshStart = /task_card\.refresh=start ctx=(\d+)/.exec(notice);
      const refreshWritten = /task_card\.refresh=written size=(\d+)/.exec(notice);
      if (refreshStart) {
        pendingCardRefreshContext = { time, context: Number(refreshStart[1]), span: cardRefreshSpan };
      } else if (refreshWritten) {
        if (pendingCardRefreshContext && pendingCardRefreshContext.time >= since && time >= since) {
          const estimate = estimateCardRefreshEquivalent(pendingCardRefreshContext.context, Number(refreshWritten[1]));
          output.cardRefreshNotices.push({ session: file, estimate });
          pendingCardRefreshContext.span.push(estimate);
        }
        pendingCardRefreshContext = null;
      } else if (/task_card\.refresh=(?:unparsed|no_reply|error)\b/.test(notice)) {
        pendingCardRefreshContext = null;
      }
    }
    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      finalizeCut(current, output);
      current = makeCut(e, sequence, file);
      current.cardRefreshEstimates = cardRefreshSpan;
      cardRefreshSpan = [];
      continue;
    }
    if (!current) continue;

    if (e.type === 'user') {
      if (!current.injectionTime) current.injectionTime = time || current.time;
      if (time && time <= current.injectionTime + 2000) {
        current.seedTextParts.push(eventText(e));
        if (compactSummary(e)) current.summaryTokens = Math.ceil(eventText(e).length / 4);
      }
      if (typeof eventContent(e) === 'string') {
        const text = eventText(e);
        if (text.includes(SEED)) {
          current.seed = true;
          current.kind = 's4';
        } else if (!current.kind) {
          current.sawUserText = true;
          current.kind = 'native';
        }
      }
    }

    const recoveryEvent = current.injectionTime && time > current.injectionTime + 2000 && time > current.time;
    if (recoveryEvent) {
      const realUser = isRealUser(e);
      const realAssistant = e.type === 'assistant' && e.message?.model !== '<synthetic>';
      const eventIndex = current.recoveryTimeline.length;
      if (realUser && current.firstRealUserIndex == null) current.firstRealUserIndex = eventIndex;
      if (realAssistant && current.firstAssistantIndex == null) current.firstAssistantIndex = eventIndex;
      current.recoveryTimeline.push({ time, realUser });
      if (e.type === 'user' && Array.isArray(eventContent(e))) {
        for (const result of eventContent(e)) {
          if (result.type !== 'tool_result' || !result.tool_use_id) continue;
          const tokens = Math.ceil(JSON.stringify(result.content ?? '').length / 4);
          current.toolResultTokens.set(result.tool_use_id, (current.toolResultTokens.get(result.tool_use_id) ?? 0) + tokens);
        }
      }
    }

    if (e.type !== 'assistant' || e.message?.model === '<synthetic>') continue;
    const id = e.message?.id ?? e.uuid ?? `assistant-${sequence}`;
    // Retained assistant records can appear after the boundary line but carry an earlier timestamp.
    // They can have zeroed top-level usage with the original values in iterations, so require a
    // timestamp strictly after the boundary before they enter the post-cut call sample.
    if (time && time > current.time && (!current.injectionTime || time >= current.injectionTime) && !current.callIds.has(id)) {
      current.callIds.add(id);
      if (current.calls.length < 20) current.calls.push(readUsage(e));
    }
    if (recoveryEvent) {
      if (!current.recoveryCallIds.has(id)) {
        current.recoveryCallIds.add(id);
        current.recoveryAssistantCalls.push({ id, time, usage: readUsage(e) });
      }
      for (const tool of toolUses(e)) current.toolCalls.push({ tool, time });
    }
  }

  finalizeCut(current, output);
}

function cutStats(cuts) {
  const costByCalls = {};
  for (const n of CALL_COUNTS) {
    costByCalls[String(n)] = summarize(cuts.filter((cut) => cut.callCosts.length >= n)
      .map((cut) => cut.callCosts.slice(0, n).reduce((a, b) => a + b, 0)));
  }
  return {
    n: cuts.length,
    sessions: new Set(cuts.map((cut) => cut._session)).size,
    firstContext: summarize(cuts.map((cut) => cut.firstContext)),
    preTokens: summarize(cuts.map((cut) => cut.preTokens)),
    postTokens: summarize(cuts.map((cut) => cut.postTokens)),
    costByCalls,
  };
}

const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
function recoveryStats(rows) {
  const selected = rows.filter((row) => row.window > 0);
  const edit = selected.filter((row) => row.reachedWrite && !row.userBeforeWrite);
  const totalReads = selected.reduce((sum, row) => sum + row.reads, 0);
  return {
    n: selected.length,
    sessions: new Set(selected.map((row) => row.session)).size,
    seedTokens: summarizeRecovery(selected.map((row) => row.seedTokens)),
    firstContext: summarizeRecovery(selected.map((row) => row.firstContext)),
    reachesEdit: { n: edit.length, denominator: selected.length },
    toolsToEdit: summarizeRecovery(edit.map((row) => row.toFirstWrite)),
    activeSecondsToEdit: summarizeRecovery(edit.map((row) => row.activeSeconds)),
    costTokens: summarizeRecovery(selected.map((row) => row.cost)),
    meanCostTokens: mean(selected.map((row) => row.cost)),
    pulledTokens: summarizeRecovery(selected.map((row) => row.pulledTokens)),
    meanSearches: mean(selected.map((row) => row.searches)),
    meanReads: mean(selected.map((row) => row.reads)),
    namedReadPercent: totalReads ? Math.round(100 * selected.reduce((sum, row) => sum + row.readsNamed, 0) / totalReads) : 0,
    recallCalls: selected.reduce((sum, row) => sum + row.recalls, 0),
  };
}

function recoveryReport(rows) {
  const report = {};
  for (const kind of ['native', 's4']) {
    const selected = rows.filter((row) => row.kind === kind);
    report[kind] = {
      all: recoveryStats(selected),
      continuation: recoveryStats(selected.filter((row) => row.continuation)),
      auto: recoveryStats(selected.filter((row) => row.trigger === 'auto')),
      preTokens: {
        under150k: recoveryStats(selected.filter((row) => row.preTokens >= 0 && row.preTokens < 150_000)),
        from150kTo250k: recoveryStats(selected.filter((row) => row.preTokens >= 150_000 && row.preTokens < 250_000)),
        over250k: recoveryStats(selected.filter((row) => row.preTokens >= 250_000)),
      },
    };
  }
  return report;
}

export function aggregatePostCuts(cuts, summaryMetrics, filesScanned, sinceText, recoveryRows = []) {
  const withSession = cuts;
  const kinds = ['s4', 'native'];
  const byKind = Object.fromEntries(kinds.map((kind) => [kind, cutStats(withSession.filter((cut) => cut.kind === kind))]));
  const windows = {};
  for (const group of ['200k', '1M', 'other']) {
    windows[group] = Object.fromEntries(kinds.map((kind) => [kind, cutStats(withSession.filter((cut) => cut.window === group && cut.kind === kind))]));
  }
  const summaryOutput = summarize(summaryMetrics.nativeSummaryOutput);
  const summaryLowerBound = summarize(summaryMetrics.nativeSummaryLowerBounds);
  const cardRefreshApproximateEstimate = summarize((summaryMetrics.cardRefreshNotices ?? []).map((notice) => notice.estimate));
  const proxyCuts = withSession.filter((cut) => cut.window === '200k');
  const breakEvenRows = CUMULATIVE_CALL_COUNTS.map((n) => {
    const costs = Object.fromEntries(kinds.map((kind) => {
      const selected = proxyCuts.filter((cut) => cut.kind === kind && cut.callCosts.length >= n);
      return [kind, summarize(selected.map((cut) => cut.callCosts.slice(0, n).reduce((sum, value) => sum + value, 0)))];
    }));
    const medianGap = costs.native.median == null || costs.s4.median == null
      ? null : costs.native.median - costs.s4.median;
    return { calls: n, s4: costs.s4, native: costs.native, medianGap };
  });
  const extraExoCutCostAllowanceByCalls = CALL_COUNTS.map((calls) => {
    const row = breakEvenRows.find((candidate) => candidate.calls === calls);
    return {
      calls,
      median: row?.medianGap == null || summaryLowerBound.median == null
        ? null : summaryLowerBound.median + row.medianGap,
      n: {
        summaryBound: summaryLowerBound.n,
        native: row?.native.n ?? 0,
        s4: row?.s4.n ?? 0,
      },
    };
  });
  const cardRefreshNoticeSessions = new Set((summaryMetrics.cardRefreshNotices ?? []).map((notice) => notice.session));
  const cutsInNoticeSessions = withSession.filter((cut) => cut.kind === 's4' && cardRefreshNoticeSessions.has(cut._session));
  const refreshesAssignedToNativeCuts = withSession
    .filter((cut) => cut.kind === 'native' && cardRefreshNoticeSessions.has(cut._session))
    .reduce((sum, cut) => sum + cut.cardRefreshCount, 0);
  const refreshedCuts = cutsInNoticeSessions.filter((cut) => cut.cardRefreshCount > 0);
  const cardRefreshByCut = {
    sessionsWithNotices: cardRefreshNoticeSessions.size,
    cutsInNoticeSessions: cutsInNoticeSessions.length,
    cutsWithRecordedRefreshes: refreshedCuts.length,
    refreshesAssignedToNativeCuts,
    refreshesPerCut: summarize(cutsInNoticeSessions.map((cut) => cut.cardRefreshCount)),
    refreshesPerRefreshedCut: summarize(refreshedCuts.map((cut) => cut.cardRefreshCount)),
    approximateEstimatePerCut: summarize(cutsInNoticeSessions.map((cut) => cut.cardRefreshEstimate)),
    approximateEstimatePerRefreshedCut: summarize(refreshedCuts.map((cut) => cut.cardRefreshEstimate)),
    allowanceExceedance: extraExoCutCostAllowanceByCalls.map((allowance) => {
      const n = refreshedCuts.filter((cut) => cut.cardRefreshEstimate > allowance.median).length;
      return {
        calls: allowance.calls,
        allowance: allowance.median,
        n,
        denominator: refreshedCuts.length,
        share: refreshedCuts.length ? n / refreshedCuts.length : null,
      };
    }),
  };
  return {
    since: sinceText,
    transcriptsScanned: filesScanned,
    pricePerMTok: PRICE,
    windowClassification: 'preTokens proxy bands: 100k-350k => 200k proxy; >=500k => 1M proxy; otherwise other',
    cuts: byKind,
    windows,
    recovery: recoveryReport(recoveryRows),
    nativeSummaryOutputTokensEstimate: summaryOutput,
    nativeSummaryLowerBound: summaryLowerBound,
    cardRefreshApproximateEstimate: {
      source: 'paired local task_card.refresh=start ctx and task_card.refresh=written size notices',
      assumption: 'Approximate estimate: refresh context counted as cache reads and recorded card size counted as output tokens. The plugin token estimate is conservatively high and can exceed actual output, so this is not a strict lower bound.',
      sessionsWithNotices: cardRefreshNoticeSessions.size,
      ...cardRefreshApproximateEstimate,
    },
    cardRefreshByCut,
    breakEven: {
      assumption: 'Indicative extra exo cost allowance per cut from the approximate native summary-call lower bound plus the difference between unpaired 200k proxy cohort cumulative medians.',
      extraExoCutCostAllowanceByCalls,
      cumulativeMedianSavings: breakEvenRows,
    },
  };
}

function expandInputs(inputs) {
  const out = new Set();
  const visit = (input) => {
    let stat;
    try { stat = fs.statSync(input); } catch { return; }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(input, { withFileTypes: true })) {
        if (!entry.isSymbolicLink()) visit(path.join(input, entry.name));
      }
    } else if (stat.isFile() && input.endsWith('.jsonl')) out.add(path.resolve(input));
  };
  for (const input of inputs) visit(input);
  return [...out];
}

function parseArgs(argv) {
  let since = DEFAULT_SINCE;
  let sinceText = new Date(DEFAULT_SINCE).toISOString().slice(0, 10);
  let jsonOut;
  const inputs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--since') {
      sinceText = argv[++i];
      since = Date.parse(sinceText);
      if (!Number.isFinite(since)) throw new Error('--since must be a valid date or timestamp');
    } else if (argv[i] === '--json') jsonOut = argv[++i];
    else inputs.push(argv[i]);
  }
  if (!inputs.length) throw new Error('Usage: node tools/real-replay/postcut.mjs [--since YYYY-MM-DD] [--json aggregate.json] <transcript-or-directory>...');
  return { since, sinceText, jsonOut, inputs };
}

const format = (n) => n == null ? 'n/a' : Math.round(n).toLocaleString('en-US');
function formatStats(stats) {
  if (!stats.n) return 'n=0';
  return `n=${stats.n}, median ${format(stats.median)}, IQR ${format(stats.q1)}-${format(stats.q3)}, range ${format(stats.min)}-${format(stats.max)}`;
}
function printRecovery(label, stats) {
  if (!stats.n) return;
  const edited = stats.reachesEdit;
  const meanCost = stats.meanCostTokens == null ? 0 : stats.meanCostTokens;
  console.log(`${label.padEnd(23)} recovery cuts ${stats.n} | seed ${format(stats.seedTokens.median)} ctx ${format(stats.firstContext.median)}`
    + ` | to edit ${edited.n}/${edited.denominator}, med ${format(stats.toolsToEdit.median)} tools / ${format(stats.activeSecondsToEdit.median)} s active`
    + ` | cost med ${format(stats.costTokens.median)} tok (~$${(stats.costTokens.median * PRICE / 1e6).toFixed(2)}), mean $${(meanCost * PRICE / 1e6).toFixed(2)}`
    + ` | pulled ${format(stats.pulledTokens.median)} | searches ${stats.meanSearches?.toFixed(1) ?? 'n/a'}`
    + ` | reads ${stats.meanReads?.toFixed(1) ?? 'n/a'}, seed-named ${stats.namedReadPercent}% | recall ${stats.recallCalls}`);
}
function printReport(report) {
  console.log(`Transcript files scanned: ${report.transcriptsScanned}; since ${report.since}; price $${report.pricePerMTok}/MTok`);
  for (const kind of ['s4', 'native']) {
    const cut = report.cuts[kind];
    console.log(`${kind}: ${cut.n} cuts in ${cut.sessions} sessions; first-call context ${formatStats(cut.firstContext)}; preTokens ${formatStats(cut.preTokens)}; postTokens ${formatStats(cut.postTokens)}`);
    for (const n of CALL_COUNTS) {
      const stats = cut.costByCalls[String(n)];
      const usd = stats.median == null ? 'n/a' : `$${(stats.median * report.pricePerMTok / 1e6).toFixed(4)}`;
      console.log(`  first ${n} calls, input-token equivalents: ${formatStats(stats)}; median ${usd}`);
    }
  }
  for (const group of ['200k', '1M', 'other']) {
    const label = group === '200k' ? '100k-350k preTokens proxy' : `${group} preTokens proxy`;
    console.log(`${label}: s4 ${report.windows[group].s4.n} cuts; native ${report.windows[group].native.n} cuts`);
    if (group === '200k') {
      for (const kind of ['s4', 'native']) {
        for (const n of CALL_COUNTS) {
          const stats = report.windows[group][kind].costByCalls[String(n)];
          console.log(`  ${kind} first ${n} calls: ${formatStats(stats)}`);
        }
      }
    }
  }
  console.log(`Native compact-summary output estimate (chars / 4): ${formatStats(report.nativeSummaryOutputTokensEstimate)} tokens`);
  console.log(`Native summary-call approximate lower bound (0.1 x preTokens + 5 x summary estimate): ${formatStats(report.nativeSummaryLowerBound)} input-token equivalents`);
  console.log(`Card-refresh approximate estimate (not a strict lower bound; 0.1 x refresh context + 5 x recorded written-card size; ${report.cardRefreshApproximateEstimate.n} paired refresh notices in ${report.cardRefreshApproximateEstimate.sessionsWithNotices} of ${report.cuts.s4.sessions} exo sessions): ${formatStats(report.cardRefreshApproximateEstimate)} input-token equivalents`);
  console.log(`Notice-bearing sessions: ${report.cardRefreshByCut.cutsWithRecordedRefreshes}/${report.cardRefreshByCut.cutsInNoticeSessions} exo cuts have recorded refreshes; refresh count across all cuts ${formatStats(report.cardRefreshByCut.refreshesPerCut)}; among refreshed cuts ${formatStats(report.cardRefreshByCut.refreshesPerRefreshedCut)} and summed estimate ${formatStats(report.cardRefreshByCut.approximateEstimatePerRefreshedCut)} equivalents`);
  console.log(`Refreshes assigned to native cuts in notice-bearing sessions (excluded from exo per-cut comparison): ${format(report.cardRefreshByCut.refreshesAssignedToNativeCuts)}`);
  console.log('Indicative extra exo cost allowance per cut: native summary-call approximate lower bound plus native post-cut median minus exo post-cut median; post-cut medians are from unpaired samples.');
  for (const allowance of report.breakEven.extraExoCutCostAllowanceByCalls) {
    console.log(`  after ${allowance.calls} calls: ${format(allowance.median)} equivalents (n=${allowance.n.summaryBound} summary bounds, ${allowance.n.native} native cuts, ${allowance.n.s4} exo cuts)`);
  }
  for (const exceedance of report.cardRefreshByCut.allowanceExceedance) {
    const share = exceedance.share == null ? 'n/a' : `${(100 * exceedance.share).toFixed(1)}%`;
    console.log(`  recorded estimate above ${exceedance.calls}-call allowance: ${exceedance.n}/${exceedance.denominator} refreshed cuts (${share})`);
  }
  for (const kind of ['native', 's4']) {
    const grouped = report.recovery[kind];
    printRecovery(`${kind} recovery`, grouped.all);
    printRecovery(`  ${kind} continuation`, grouped.continuation);
    printRecovery(`  ${kind} auto`, grouped.auto);
    printRecovery(`  ${kind} pre <150k`, grouped.preTokens.under150k);
    printRecovery(`  ${kind} pre 150-250k`, grouped.preTokens.from150kTo250k);
    printRecovery(`  ${kind} pre >250k`, grouped.preTokens.over250k);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = expandInputs(args.inputs);
  const internal = { since: args.since, cuts: [], recovery: [], nativeSummaryOutput: [], nativeSummaryLowerBounds: [], cardRefreshNotices: [] };
  for (const file of files) await analyzeTranscript(file, args.since, internal);
  const report = aggregatePostCuts(internal.cuts, {
    nativeSummaryOutput: internal.nativeSummaryOutput,
    nativeSummaryLowerBounds: internal.nativeSummaryLowerBounds,
    cardRefreshNotices: internal.cardRefreshNotices,
  }, files.length, args.sinceText, internal.recovery);
  if (args.jsonOut) fs.writeFileSync(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  printReport(report);
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
