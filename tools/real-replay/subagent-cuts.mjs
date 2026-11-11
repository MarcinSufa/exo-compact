#!/usr/bin/env node
// Aggregate subagent compaction frequency and post-cut token usage from local transcripts.
// Output contains counts and distributions only, never transcript text or paths.
//
//   node tools/real-replay/subagent-cuts.mjs [--root ~/.claude/projects] [--since 2026-10-01] [--json report.json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCompactBoundary, parseTranscript, readUsage, timestamp, weightedUsage } from './postcut.mjs';

const DEFAULT_SINCE = '2026-10-01';
const CALL_COUNTS = [1, 5, 20];
const PROXY_MIN = 100_000;
const PROXY_MAX = 350_000;

function referenceStats(n, median, q1, q3) {
  return { n, median, q1, q3, iqr: q3 - q1 };
}

// Parent-session values copied from docs/benchmarks.md, "Post-cut size and cost per turn".
const MAIN_SESSION_REFERENCE = {
  source: 'docs/benchmarks.md: Post-cut size and cost per turn',
  since: '2026-10-01',
  postCut: {
    exoCompact: {
      sessions: 122,
      cuts: 623,
      firstCallContextTokens: referenceStats(617, 44_985, 41_608, 52_047),
      preTokens: referenceStats(623, 217_509, 217_006, 218_180),
      postTokens: referenceStats(623, 5_016, 4_232, 5_321),
    },
    native: {
      sessions: 25,
      cuts: 160,
      firstCallContextTokens: referenceStats(156, 65_484, 56_651, 77_523),
      preTokens: referenceStats(160, 217_387, 216_893, 218_573),
      postTokens: referenceStats(160, 18_018, 13_702, 22_550),
    },
  },
  costProxyBand: {
    preTokens: [PROXY_MIN, PROXY_MAX],
    exoCompact: {
      firstCallContextTokens: referenceStats(580, 45_657, 42_303, 52_634),
      nextCallCostTokenEquivalents: {
        next1: referenceStats(580, 44_574, 34_419, 57_854),
        next5: referenceStats(578, 109_298, 91_153, 126_100),
        next20: referenceStats(568, 319_744, 280_194, 373_137),
      },
    },
    native: {
      firstCallContextTokens: referenceStats(152, 65_675, 57_117, 77_589),
      nextCallCostTokenEquivalents: {
        next1: referenceStats(152, 93_470, 74_240, 108_544),
        next5: referenceStats(152, 153_370, 122_853, 180_083),
        next20: referenceStats(150, 391_920, 333_101, 454_890),
      },
    },
  },
};

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position), upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function cleanNumber(value) {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function distribution(values) {
  const sorted = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  const median = percentile(sorted, 0.5), q1 = percentile(sorted, 0.25), q3 = percentile(sorted, 0.75);
  return { n: sorted.length, median: cleanNumber(median), q1: cleanNumber(q1), q3: cleanNumber(q3), iqr: cleanNumber(q1 === null || q3 === null ? null : q3 - q1) };
}

function listEntries(directory) {
  try { return fs.readdirSync(directory, { withFileTypes: true }); } catch { return []; }
}

function discoverFiles(root) {
  const main = [], subagents = [];
  for (const project of listEntries(root)) {
    if (!project.isDirectory()) continue;
    const projectPath = path.join(root, project.name);
    for (const entry of listEntries(projectPath)) {
      const entryPath = path.join(projectPath, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) main.push(entryPath);
      if (!entry.isDirectory()) continue;
      const subagentPath = path.join(entryPath, 'subagents');
      for (const agent of listEntries(subagentPath)) {
        if (agent.isFile() && agent.name.endsWith('.jsonl')) subagents.push(path.join(subagentPath, agent.name));
      }
    }
  }
  return { main, subagents };
}

function readTranscript(file) {
  try { return parseTranscript(fs.readFileSync(file, 'utf8')); }
  catch { return { events: [], malformed: 0, unreadable: true }; }
}

function metricForCut(events, boundaryIndex, nextBoundaryIndex) {
  const boundary = events[boundaryIndex];
  const end = nextBoundaryIndex ?? events.length;
  const metadata = boundary.compactMetadata ?? {};
  const firstInjectedUser = events.slice(boundaryIndex + 1, boundaryIndex + 6).find((event) => event.type === 'user');
  const injectionTime = firstInjectedUser ? timestamp(firstInjectedUser) : timestamp(boundary);
  const post = events.slice(boundaryIndex + 1, end)
    .filter((event) => timestamp(event) > injectionTime + 2000 && event.message?.model !== '<synthetic>');
  const seen = new Set(), calls = [];
  for (const event of post) {
    if (event.type !== 'assistant') continue;
    const id = event.message?.id;
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    const usage = readUsage(event);
    const context = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    calls.push({ context, cost: weightedUsage(usage) });
  }
  return {
    preTokens: Number.isFinite(metadata.preTokens) ? metadata.preTokens : null,
    postTokens: Number.isFinite(metadata.postTokens) ? metadata.postTokens : null,
    firstCallContextTokens: calls.length ? calls[0].context : null,
    nextCallCostTokenEquivalents: Object.fromEntries(CALL_COUNTS.map((count) => [count, calls.length ? calls.slice(0, count).reduce((sum, call) => sum + call.cost, 0) : null])),
    completeNextCallCostTokenEquivalents: Object.fromEntries(CALL_COUNTS.map((count) => [count, calls.length >= count ? calls.slice(0, count).reduce((sum, call) => sum + call.cost, 0) : null])),
  };
}

function analyzeTranscript(file, sinceTime) {
  const parsed = readTranscript(file);
  const events = parsed.events;
  const boundaryIndexes = events.map((event, index) => isCompactBoundary(event) ? index : -1).filter((index) => index >= 0);
  const sessionIds = [...new Set(events.map((event) => event.sessionId).filter((value) => typeof value === 'string' && value.length > 0))];
  const timed = boundaryIndexes.map((index) => ({ index, at: timestamp(events[index]) }));
  const windowed = timed.filter((item) => item.at >= sinceTime);
  const cuts = windowed.map((item) => {
    const position = timed.findIndex((candidate) => candidate.index === item.index);
    return metricForCut(events, item.index, timed[position + 1]?.index);
  });
  let agentType;
  for (const event of events) {
    const value = event.agentType ?? event.agent_type;
    if (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(value.trim())) {
      agentType = value.trim();
      break;
    }
  }
  return { allCompactions: boundaryIndexes.length, windowCompactions: windowed.length, cuts, malformed: parsed.malformed, unreadable: parsed.unreadable === true, agentType, sessionIds };
}

function ratio(part, total) {
  return total ? Math.round((part / total) * 10000) / 10000 : null;
}

function summarize(root, since) {
  const sinceTime = Date.parse(since);
  const { main, subagents } = discoverFiles(root);
  const mainResults = main.map((file) => analyzeTranscript(file, sinceTime));
  const subagentResults = subagents.map((file) => analyzeTranscript(file, sinceTime));
  const allSubagentCuts = subagentResults.reduce((sum, item) => sum + item.allCompactions, 0);
  const allMainCuts = mainResults.reduce((sum, item) => sum + item.allCompactions, 0);
  const windowSubagentCuts = subagentResults.reduce((sum, item) => sum + item.windowCompactions, 0);
  const windowMainCuts = mainResults.reduce((sum, item) => sum + item.windowCompactions, 0);
  const windowCuts = subagentResults.flatMap((item) => item.cuts);
  const proxyCuts = windowCuts.filter((cut) => Number.isFinite(cut.preTokens) && cut.preTokens >= PROXY_MIN && cut.preTokens < PROXY_MAX);
  const typeCounts = {};
  for (const item of subagentResults) if (item.agentType) typeCounts[item.agentType] = (typeCounts[item.agentType] ?? 0) + 1;
  const malformedLines = [...mainResults, ...subagentResults].reduce((sum, item) => sum + item.malformed, 0);
  const unreadableFiles = [...mainResults, ...subagentResults].filter((item) => item.unreadable).length;
  const cutMetric = (key) => distribution(windowCuts.map((cut) => cut[key]));
  const nextCosts = Object.fromEntries(CALL_COUNTS.map((count) => [
    `next${count}`,
    distribution(windowCuts.map((cut) => cut.nextCallCostTokenEquivalents[count])),
  ]));
  const comparisonNextCosts = Object.fromEntries(CALL_COUNTS.map((count) => [
    `next${count}`,
    distribution(proxyCuts.map((cut) => cut.completeNextCallCostTokenEquivalents[count])),
  ]));
  const allSubagentTotal = allMainCuts + allSubagentCuts;
  const windowTotal = windowMainCuts + windowSubagentCuts;
  return {
    source: 'tools/real-replay/postcut.mjs shared parser, usage normalization, and weights',
    runDate: new Date().toISOString().slice(0, 10),
    since,
    inventory: {
      subagentTranscripts: subagents.length,
      subagentTranscriptsWithCompactions: subagentResults.filter((item) => item.allCompactions > 0).length,
      subagentCompactions: allSubagentCuts,
      allCompactions: allSubagentTotal,
      subagentShare: ratio(allSubagentCuts, allSubagentTotal),
      subagentSessionIds: {
        transcriptsWithId: subagentResults.filter((item) => item.sessionIds.length > 0).length,
        uniqueIds: new Set(subagentResults.flatMap((item) => item.sessionIds)).size,
      },
    },
    window: {
      subagentTranscripts: subagents.length,
      subagentTranscriptsWithCompactions: subagentResults.filter((item) => item.windowCompactions > 0).length,
      subagentCompactions: windowSubagentCuts,
      mainCompactions: windowMainCuts,
      allCompactions: windowTotal,
      subagentShare: ratio(windowSubagentCuts, windowTotal),
      compactionsPerTranscript: distribution(subagentResults.map((item) => item.windowCompactions)),
      compactionsPerCompactingTranscript: distribution(subagentResults.filter((item) => item.windowCompactions > 0).map((item) => item.windowCompactions)),
      preTokens: cutMetric('preTokens'),
      postTokens: cutMetric('postTokens'),
      firstCallContextTokens: cutMetric('firstCallContextTokens'),
      nextCallCostTokenEquivalents: nextCosts,
      agentTypes: { transcripts: Object.values(typeCounts).reduce((sum, count) => sum + count, 0), counts: typeCounts },
      malformedLines,
      unreadableFiles,
    },
    comparison: {
      source: MAIN_SESSION_REFERENCE.source,
      since,
      weightsSource: 'readUsage and weightedUsage imported from tools/real-replay/postcut.mjs',
      design: 'Observational transcript cohorts; unpaired and not an A/B.',
      mainSession: since === MAIN_SESSION_REFERENCE.since ? MAIN_SESSION_REFERENCE : null,
      mainSessionReferenceNote: since === MAIN_SESSION_REFERENCE.since
        ? 'Reference uses the same --since date.'
        : `No parent-session reference for --since ${since}; stored reference uses ${MAIN_SESSION_REFERENCE.since}.`,
      subagent: {
        allCuts: {
          cuts: windowCuts.length,
          preTokens: cutMetric('preTokens'),
          postTokens: cutMetric('postTokens'),
          firstCallContextTokens: cutMetric('firstCallContextTokens'),
          nextCallCostTokenEquivalents: nextCosts,
        },
        costProxyBand: {
          preTokens: [PROXY_MIN, PROXY_MAX],
          cuts: proxyCuts.length,
          firstCallContextTokens: distribution(proxyCuts.map((cut) => cut.firstCallContextTokens)),
          nextCallCostTokenEquivalents: comparisonNextCosts,
        },
      },
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  let root = path.join(os.homedir(), '.claude', 'projects');
  let since = DEFAULT_SINCE, jsonOut;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--root' && args[index + 1]) root = args[++index];
    else if (args[index] === '--since' && args[index + 1]) since = args[++index];
    else if (args[index] === '--json' && args[index + 1]) jsonOut = args[++index];
    else {
      process.stderr.write('usage: subagent-cuts.mjs [--root directory] [--since YYYY-MM-DD] [--json output.json]\n');
      process.exitCode = 2;
      return;
    }
  }
  if (!Number.isFinite(Date.parse(since))) {
    process.stderr.write('invalid --since date\n');
    process.exitCode = 2;
    return;
  }
  const report = summarize(root, since);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (jsonOut) fs.writeFileSync(jsonOut, json);
  process.stdout.write(json);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
