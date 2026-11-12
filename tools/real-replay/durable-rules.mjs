#!/usr/bin/env node
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { estimateTokens } from '../../plugin/compact/core/budgets.ts';
import { eventContentText, parseJsonl, splitBoundaries } from './transcript-parser.mjs';
import { SEED_SENTINEL, splitSeedSections } from './seed-sections.mjs';

const SOURCE_SECTIONS = Object.freeze({
  constraintsHistory: 'Constraints (history)',
  taskCardRules: 'Task card / Rules',
  taskCardDecisions: 'Task card / Decisions',
});
const SOURCE_KEYS = [...Object.keys(SOURCE_SECTIONS), 'all'];
const NEAR_MATCH_THRESHOLD = 0.8;

export function normalizeRuleUnit(value) {
  let text = String(value ?? '').trim();
  text = text.replace(/^(?:(?:[-*+]\s+)|(?:\d+[.)]\s+)|(?:>\s+))/u, '');
  text = text.replace(/\s+\[[^\]\r\n]+,\s*[^\]\r\n]+\]\s*$/u, '');
  return text.replace(/\s+/gu, ' ').trim().toLowerCase();
}

function unitFromLine(line, sourceKey) {
  const match = String(line).match(/^\s*(?:(?:[-*+]\s+)|(?:\d+[.)]\s+)|(?:>\s+))(.+?)\s*$/u);
  if (!match) return undefined;
  const normalized = normalizeRuleUnit(line);
  if (!normalized) return undefined;
  return {
    sourceKey,
    sourceSection: SOURCE_SECTIONS[sourceKey],
    normalized,
    lineTokens: estimateTokens(String(line).trim()),
  };
}

function unitsFromLines(lines, sourceKey) {
  return lines.map((line) => unitFromLine(line, sourceKey)).filter(Boolean);
}

function taskCardUnits(body) {
  const result = { taskCardRules: [], taskCardDecisions: [] };
  let current;
  for (const line of String(body ?? '').split(/\r?\n/u)) {
    const heading = line.match(/^\s*###\s+([^\r\n]+?)\s*$/u);
    if (heading) {
      const name = heading[1].trim();
      current = name === 'Rules' ? 'taskCardRules' : name === 'Decisions' ? 'taskCardDecisions' : undefined;
      continue;
    }
    if (current) {
      const unit = unitFromLine(line, current);
      if (unit) result[current].push(unit);
    }
  }
  return result;
}

export function extractRuleUnits(seedText) {
  const split = splitSeedSections(seedText);
  const units = {
    constraintsHistory: [],
    taskCardRules: [],
    taskCardDecisions: [],
  };
  for (const section of split.sections) {
    if (section.name === 'Constraints (history)') {
      units.constraintsHistory.push(...unitsFromLines(String(section.body ?? '').split(/\r?\n/u), 'constraintsHistory'));
    } else if (section.name === 'Task card') {
      const taskUnits = taskCardUnits(section.body);
      units.taskCardRules.push(...taskUnits.taskCardRules);
      units.taskCardDecisions.push(...taskUnits.taskCardDecisions);
    }
  }
  return units;
}

function wordTrigrams(normalized) {
  const words = String(normalized ?? '').match(/[\p{L}\p{N}]+/gu) ?? [];
  const grams = new Set();
  for (let index = 0; index + 3 <= words.length; index++) {
    grams.add(words.slice(index, index + 3).join('\u001f'));
  }
  return grams;
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

function hasNearPrior(normalized, earlierOtherSessionUnits, trigramCache) {
  for (const prior of earlierOtherSessionUnits) {
    if (normalized === prior) return true;
    let left = trigramCache.get(normalized);
    if (!left) { left = wordTrigrams(normalized); trigramCache.set(normalized, left); }
    let right = trigramCache.get(prior);
    if (!right) { right = wordTrigrams(prior); trigramCache.set(prior, right); }
    if (jaccard(left, right) >= NEAR_MATCH_THRESHOLD) return true;
  }
  return false;
}

function timestampValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function emptyMetric() {
  return {
    ruleTokens: 0,
    crossSessionRepeatTokens: 0,
    harnessDeliveredRepeatUnits: 0,
    crossSessionShareOfRuleTokens: 0,
    crossSessionShareOfSeedTokens: 0,
    withinSessionRepeatTokens: 0,
    withinSessionShareOfRuleTokens: 0,
    withinSessionShareOfSeedTokens: 0,
    nearMatchRepeatTokens: 0,
    nearMatchAdditionalTokens: 0,
    nearMatchShareOfRuleTokens: 0,
    nearMatchShareOfSeedTokens: 0,
  };
}

function finishMetric(metric, seedTokens) {
  metric.crossSessionShareOfRuleTokens = metric.ruleTokens ? metric.crossSessionRepeatTokens / metric.ruleTokens : 0;
  metric.crossSessionShareOfSeedTokens = seedTokens ? metric.crossSessionRepeatTokens / seedTokens : 0;
  metric.withinSessionShareOfRuleTokens = metric.ruleTokens ? metric.withinSessionRepeatTokens / metric.ruleTokens : 0;
  metric.withinSessionShareOfSeedTokens = seedTokens ? metric.withinSessionRepeatTokens / seedTokens : 0;
  metric.nearMatchShareOfRuleTokens = metric.ruleTokens ? metric.nearMatchRepeatTokens / metric.ruleTokens : 0;
  metric.nearMatchShareOfSeedTokens = seedTokens ? metric.nearMatchRepeatTokens / seedTokens : 0;
  return metric;
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
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
  };
}

const DISTRIBUTION_FIELDS = Object.freeze([
  'ruleTokens',
  'crossSessionRepeatTokens',
  'harnessDeliveredRepeatUnits',
  'crossSessionShareOfRuleTokens',
  'crossSessionShareOfSeedTokens',
  'withinSessionRepeatTokens',
  'withinSessionShareOfRuleTokens',
  'withinSessionShareOfSeedTokens',
  'nearMatchRepeatTokens',
  'nearMatchAdditionalTokens',
  'nearMatchShareOfRuleTokens',
  'nearMatchShareOfSeedTokens',
]);

function summarizeRows(rows) {
  const sources = {};
  for (const sourceKey of SOURCE_KEYS) {
    const sourceRows = rows.map((row) => row.sources[sourceKey]);
    sources[sourceKey] = Object.fromEntries(DISTRIBUTION_FIELDS.map((field) => [
      field,
      distribution(sourceRows.map((metrics) => metrics[field])),
    ]));
  }
  return sources;
}

function updateTopUnitCounts(rows) {
  const byUnit = new Map();
  for (const row of rows) {
    for (const unit of row.units) {
      let info = byUnit.get(unit.normalized);
      if (!info) {
        info = { sessionsByProject: new Map(), sources: new Set() };
        byUnit.set(unit.normalized, info);
      }
      let sessions = info.sessionsByProject.get(row.projectKey);
      if (!sessions) { sessions = new Set(); info.sessionsByProject.set(row.projectKey, sessions); }
      sessions.add(row.sessionKey);
      info.sources.add(unit.sourceSection);
    }
  }
  const repeated = [];
  for (const [normalized, info] of byUnit) {
    const distinctSessions = [...info.sessionsByProject.values()]
      .filter((sessions) => sessions.size > 1)
      .reduce((total, sessions) => total + sessions.size, 0);
    if (distinctSessions < 2) continue;
    repeated.push({
      distinctSessions,
      lengthTokens: estimateTokens(normalized),
      sourceSections: [...info.sources].sort(),
      sha256: crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12),
    });
  }
  return repeated.sort((left, right) => right.distinctSessions - left.distinctSessions
    || right.lengthTokens - left.lengthTokens
    || left.sha256.localeCompare(right.sha256)).slice(0, 15);
}

function buildCohort(rows, projects = undefined) {
  return {
    cuts: rows.length,
    projects: projects?.size ?? new Set(rows.map((row) => row.projectKey)).size,
    sessions: new Set(rows.map((row) => row.sessionKey)).size,
    cutsWithCrossSessionRepeats: Object.fromEntries(SOURCE_KEYS.map((sourceKey) => [
      sourceKey,
      rows.filter((row) => row.sources[sourceKey].crossSessionRepeatTokens > 0).length,
    ])),
    cutsWithHarnessDeliveredRepeatUnits: Object.fromEntries(SOURCE_KEYS.map((sourceKey) => [
      sourceKey,
      rows.filter((row) => row.sources[sourceKey].harnessDeliveredRepeatUnits > 0).length,
    ])),
    sources: summarizeRows(rows),
  };
}

const SCOPE_NAMES = Object.freeze(['claudeProjectDir', 'gitRepo', 'global']);

function keyHash(scope, value) {
  return crypto.createHash('sha256').update(`${scope}\u0000${String(value)}`).digest('hex');
}

function normalizedHarnessText(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function scopeKeysFor(cut) {
  const sessionKey = String(cut.sessionKey ?? 'unknown-session');
  const projectDir = String(cut.claudeProjectDirKey ?? cut.projectKey ?? `unknown-project:${sessionKey}`);
  const repo = String(cut.gitRepoKey ?? cut.cwd ?? `unavailable-cwd:${sessionKey}`);
  return {
    claudeProjectDir: keyHash('claudeProjectDir', projectDir),
    gitRepo: keyHash('gitRepo', repo),
    global: keyHash('global', 'vault-wide'),
  };
}

function analyzeScope(cuts, scopeName) {
  const scopeCuts = cuts.map((cut) => ({ ...cut, projectKey: cut.scopeKeys[scopeName] }));
  const sessionCounts = new Map();
  const evidenceBySession = new Map();
  for (const cut of scopeCuts) {
    let sessions = sessionCounts.get(cut.projectKey);
    if (!sessions) { sessions = new Set(); sessionCounts.set(cut.projectKey, sessions); }
    sessions.add(cut.sessionKey);
    if (scopeName === 'gitRepo') {
      let kinds = evidenceBySession.get(cut.sessionKey);
      if (!kinds) { kinds = new Set(); evidenceBySession.set(cut.sessionKey, kinds); }
      kinds.add(cut.gitRepoEvidence ?? 'unknown');
    }
  }
  const largeProjects = new Set([...sessionCounts]
    .filter(([, sessions]) => sessions.size >= 3)
    .map(([projectKey]) => projectKey));

  const projectHistory = new Map();
  const sessionHistory = new Map();
  const trigramCache = new Map();
  const cutRows = [];
  let groupStart = 0;
  while (groupStart < scopeCuts.length) {
    let groupEnd = groupStart + 1;
    while (groupEnd < scopeCuts.length && scopeCuts[groupEnd].boundaryTime === scopeCuts[groupStart].boundaryTime) groupEnd++;
    for (let index = groupStart; index < groupEnd; index++) {
      const cut = scopeCuts[index];
      let priorProjectUnits = projectHistory.get(cut.projectKey);
      if (!priorProjectUnits) priorProjectUnits = new Map();
      const withinKey = `${cut.projectKey}\u0000${cut.sessionKey}`;
      let priorSessionUnits = sessionHistory.get(withinKey);
      if (!priorSessionUnits) priorSessionUnits = new Set();
      const sources = Object.fromEntries(SOURCE_KEYS.map((sourceKey) => [sourceKey, emptyMetric()]));
      const deliveredBySource = Object.fromEntries(SOURCE_KEYS.map((sourceKey) => [sourceKey, new Set()]));
      const priorOtherSessionUnits = [...priorProjectUnits]
        .filter(([, sessions]) => [...sessions.keys()].some((sessionKey) => sessionKey !== cut.sessionKey))
        .map(([normalized]) => normalized);
      const harnessTexts = (cut.preCutHarnessTexts ?? []).map(normalizedHarnessText).filter(Boolean);

      for (const unit of cut.units) {
        const exactSessions = priorProjectUnits.get(unit.normalized);
        const exactCrossSession = !!exactSessions && [...exactSessions.keys()].some((sessionKey) => sessionKey !== cut.sessionKey);
        const withinSession = priorSessionUnits.has(unit.normalized);
        const nearMatch = hasNearPrior(unit.normalized, priorOtherSessionUnits, trigramCache);
        const nearAdditional = nearMatch && !exactCrossSession;
        const harnessDelivered = exactCrossSession && harnessTexts.some((text) => text.includes(unit.normalized));
        for (const sourceKey of [unit.sourceKey, 'all']) {
          const metric = sources[sourceKey];
          metric.ruleTokens += unit.lineTokens;
          if (exactCrossSession) metric.crossSessionRepeatTokens += unit.lineTokens;
          if (harnessDelivered) deliveredBySource[sourceKey].add(unit.normalized);
          if (withinSession) metric.withinSessionRepeatTokens += unit.lineTokens;
          if (nearMatch) metric.nearMatchRepeatTokens += unit.lineTokens;
          if (nearAdditional) metric.nearMatchAdditionalTokens += unit.lineTokens;
        }
      }
      for (const sourceKey of SOURCE_KEYS) {
        sources[sourceKey].harnessDeliveredRepeatUnits = deliveredBySource[sourceKey].size;
        finishMetric(sources[sourceKey], cut.seedTokens);
      }
      cutRows.push({ sources });

      let sessionSet = sessionHistory.get(withinKey);
      if (!sessionSet) { sessionSet = new Set(); sessionHistory.set(withinKey, sessionSet); }
      for (const unit of cut.units) sessionSet.add(unit.normalized);
    }
    for (let index = groupStart; index < groupEnd; index++) {
      const cut = scopeCuts[index];
      let unitSessions = projectHistory.get(cut.projectKey);
      if (!unitSessions) { unitSessions = new Map(); projectHistory.set(cut.projectKey, unitSessions); }
      for (const unit of cut.units) {
        let sessions = unitSessions.get(unit.normalized);
        if (!sessions) { sessions = new Map(); unitSessions.set(unit.normalized, sessions); }
        if (!sessions.has(cut.sessionKey)) sessions.set(cut.sessionKey, wordTrigrams(unit.normalized));
      }
    }
    groupStart = groupEnd;
  }

  const allRows = scopeCuts.map((cut, index) => ({
    ...cutRows[index],
    projectKey: cut.projectKey,
    sessionKey: cut.sessionKey,
    units: cut.units,
  }));
  const largeRows = allRows.filter((row) => largeProjects.has(row.projectKey));
  const evidenceKindSessions = {};
  for (const kinds of evidenceBySession.values()) {
    const kind = kinds.size === 1 ? [...kinds][0] : 'mixedEvidence';
    evidenceKindSessions[kind] = (evidenceKindSessions[kind] ?? 0) + 1;
  }
  const fallbackSessions = [...evidenceBySession.values()]
    .filter((kinds) => kinds.has('cwdFallback') || kinds.has('cwdUnavailable'))
    .length;
  return {
    cutMetrics: cutRows,
    sample: {
      cuts: allRows.length,
      projects: sessionCounts.size,
      sessions: new Set(allRows.map((row) => row.sessionKey)).size,
      projectsWithAtLeast3Sessions: largeProjects.size,
      cutsInProjectsWithAtLeast3Sessions: largeRows.length,
      ...(scopeName === 'gitRepo' ? { fallbackSessions, evidenceKindSessions } : {}),
    },
    cohorts: {
      allCuts: buildCohort(allRows),
      projectsWithAtLeast3Sessions: buildCohort(largeRows, largeProjects),
    },
    topRepeatedUnits: updateTopUnitCounts(allRows),
  };
}

export function analyzeCuts(inputCuts, sampleMetadata = {}) {
  const cuts = inputCuts.map((cut, inputIndex) => {
    const seedText = String(cut.seedText ?? '');
    return {
      ...cut,
      inputIndex,
      sessionKey: String(cut.sessionKey ?? `unknown-session-${inputIndex}`),
      boundaryTime: timestampValue(cut.boundaryTimestamp ?? cut.timestamp),
      seedText,
      seedTokens: Number.isFinite(cut.seedTokens) ? cut.seedTokens : estimateTokens(seedText),
      units: Object.values(extractRuleUnits(seedText)).flat(),
      scopeKeys: scopeKeysFor(cut),
      preCutHarnessTexts: Array.isArray(cut.preCutHarnessTexts) ? cut.preCutHarnessTexts : [],
    };
  }).sort((left, right) => left.boundaryTime - right.boundaryTime || left.inputIndex - right.inputIndex);

  const scopeReports = Object.fromEntries(SCOPE_NAMES.map((scopeName) => [scopeName, analyzeScope(cuts, scopeName)]));
  const cutRows = cuts.map((cut, index) => ({
    ordinal: index + 1,
    seedTokens: cut.seedTokens,
    scopes: Object.fromEntries(SCOPE_NAMES.map((scopeName) => [scopeName, scopeReports[scopeName].cutMetrics[index]])),
  }));
  const globalSample = scopeReports.global.sample;
  const gitRepoSample = scopeReports.gitRepo.sample;
  return {
    method: {
      seedIdentifier: SEED_SENTINEL,
      seedSections: 'tools/real-replay/seed-sections.mjs::splitSeedSections and its section names',
      transcriptParser: 'tools/real-replay/transcript-parser.mjs::parseJsonl, eventContentText, and splitBoundaries',
      ruleUnitSources: SOURCE_SECTIONS,
      ruleUnitDefinition: 'A non-empty markdown bullet or quoted line from the named source sections. Task card units are limited to the Rules and Decisions subsections.',
      normalization: 'Strip a bullet or quote prefix and a trailing bracket tag with comma-separated source values, collapse whitespace, then lowercase.',
      tokenEstimator: 'plugin/compact/core/budgets.ts::estimateTokens over each original source line; seed token counts use the full seed',
      exactRepeat: 'Normalized exact match to a unit in an earlier seed from a different session in the selected scope.',
      nearMatch: `Sensitivity only: compare word 3-gram sets against units in earlier sessions in the selected scope; Jaccard >= ${NEAR_MATCH_THRESHOLD}. Near-match tokens include exact matches; additional tokens exclude exact matches.`,
      timestampOrder: 'Cuts are sorted by compact-boundary timestamp. Cross-session comparisons require a strictly earlier timestamp. Tied timestamps do not count as earlier; same-session cuts at a tied timestamp follow stable input order.',
      scopeDefinitions: {
        claudeProjectDir: 'Transcript parent directory directly under the Claude projects root, retained for comparison.',
        gitRepo: 'Git common directory resolved from the session cwd using git rev-parse --path-format=absolute --git-common-dir. If cwd is missing, gone, or not a repository, the unchanged cwd is used as the key.',
        global: 'All sessions share one vault-wide scope.',
      },
      gitRepoEvidenceKinds: ['gitCommonDir', 'cwdFallback', 'cwdUnavailable', 'mixedEvidence'],
      harnessDeliveredRepeatUnits: 'Distinct exact cross-session repeat units in a cut whose normalized text occurs in non-seed user or system text from the same transcript before its boundary.',
      sessionIdentityRule: 'The transcript sessionId. Claude subagent transcripts use their parent sessionId when available.',
      cohortRule: 'Each scope has a second cohort containing cuts from keys with at least three distinct sessions represented by plugin seed cuts.',
      topRepeatedUnits: 'Top 15 normalized units by distinct sessions within a scope key. Only token length, source section, session count, and a 12-character SHA-256 prefix are emitted.',
      privacy: 'Scope keys are SHA-256 hashed before comparison. Raw and normalized rule text, scope keys, session IDs, and transcript paths are excluded from the report.',
      percentileMethod: 'Linear interpolation over sorted per-cut values.',
    },
    sample: {
      transcriptFiles: sampleMetadata.transcriptFiles ?? 0,
      compactBoundaries: sampleMetadata.compactBoundaries ?? 0,
      pluginCuts: cutRows.length,
      sessions: globalSample.sessions,
      projectsByScope: Object.fromEntries(SCOPE_NAMES.map((scopeName) => [scopeName, scopeReports[scopeName].sample.projects])),
      gitRepoFallbackSessions: gitRepoSample.fallbackSessions,
      gitRepoEvidenceKindSessions: gitRepoSample.evidenceKindSessions,
      subagentTranscriptFiles: sampleMetadata.subagentTranscriptFiles ?? 0,
    },
    scopes: Object.fromEntries(SCOPE_NAMES.map((scopeName) => [scopeName, {
      sample: scopeReports[scopeName].sample,
      cohorts: scopeReports[scopeName].cohorts,
      topRepeatedUnits: scopeReports[scopeName].topRepeatedUnits,
    }])),
    cuts: cutRows,
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

function eventTimestamp(event) {
  const value = Date.parse(String(event?.timestamp ?? ''));
  return Number.isFinite(value) ? value : 0;
}

function pluginSeedForBoundary(events, window) {
  const firstUser = events.slice(window.start + 1, Math.min(window.end, window.start + 6)).find((event) => event.type === 'user');
  if (!firstUser) return undefined;
  const injectionTime = eventTimestamp(firstUser);
  return events.slice(window.start + 1, window.end)
    .filter((event) => event.type === 'user' && eventTimestamp(event) <= injectionTime + 2000)
    .find((event) => eventContentText(event).includes(SEED_SENTINEL));
}

function fallbackSessionKey(file, root) {
  const parts = path.relative(root, file).split(path.sep);
  const subagentIndex = parts.indexOf('subagents');
  if (subagentIndex > 0) return parts[subagentIndex - 1];
  return path.basename(file, '.jsonl');
}

export function resolveGitCommonDir(cwd) {
  if (!cwd) return undefined;
  try {
    if (!fs.statSync(cwd).isDirectory()) return undefined;
    const result = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return result ? path.resolve(result) : undefined;
  } catch {
    return undefined;
  }
}

function transcriptCwd(events) {
  for (const event of events) {
    if (typeof event?.cwd === 'string' && event.cwd.length) return event.cwd;
  }
  return undefined;
}

function preBoundaryHarnessTexts(events, boundaryIndex) {
  return events.slice(0, boundaryIndex)
    .filter((event) => (event.type === 'user' || event.type === 'system') && !eventContentText(event).includes(SEED_SENTINEL))
    .map((event) => eventContentText(event))
    .filter(Boolean);
}

export async function collectTranscriptCuts(root, { resolveGitCommonDir: resolveRepo = resolveGitCommonDir } = {}) {
  const files = await walkJsonl(root);
  const cuts = [];
  const gitRepoCache = new Map();
  let compactBoundaries = 0;
  let subagentTranscriptFiles = 0;
  for (const file of files) {
    const { events: parsed } = await parseJsonl(file);
    const events = parsed.map((row) => row.event);
    const windows = splitBoundaries(events);
    compactBoundaries += windows.length;
    const relativePath = path.relative(root, file);
    const pathParts = relativePath.split(path.sep);
    if (pathParts.includes('subagents')) subagentTranscriptFiles++;
    const claudeProjectDirKey = pathParts[0] ?? '.';
    const sessionKey = String(events.find((event) => typeof event.sessionId === 'string')?.sessionId ?? fallbackSessionKey(file, root));
    const cwd = transcriptCwd(events);
    let gitRepoKey;
    let gitRepoEvidence;
    if (cwd === undefined) {
      gitRepoKey = `unavailable-cwd:${claudeProjectDirKey}:${sessionKey}`;
      gitRepoEvidence = 'cwdUnavailable';
    } else {
      if (!gitRepoCache.has(cwd)) {
        let commonDir;
        try { commonDir = resolveRepo(cwd); } catch { commonDir = undefined; }
        gitRepoCache.set(cwd, typeof commonDir === 'string' && commonDir.trim() ? path.resolve(commonDir.trim()) : undefined);
      }
      const commonDir = gitRepoCache.get(cwd);
      if (commonDir) {
        gitRepoKey = commonDir;
        gitRepoEvidence = 'gitCommonDir';
      } else {
        gitRepoKey = cwd;
        gitRepoEvidence = 'cwdFallback';
      }
    }
    for (const window of windows) {
      const seedEvent = pluginSeedForBoundary(events, window);
      if (!seedEvent) continue;
      cuts.push({
        claudeProjectDirKey,
        gitRepoKey,
        gitRepoEvidence,
        sessionKey,
        boundaryTimestamp: events[window.start]?.timestamp,
        seedText: eventContentText(seedEvent),
        preCutHarnessTexts: preBoundaryHarnessTexts(events, window.start),
      });
    }
  }
  return {
    cuts,
    sampleMetadata: { transcriptFiles: files.length, compactBoundaries, subagentTranscriptFiles },
  };
}

function fmt(value, digits = 1) {
  if (value == null) return '-';
  return Number(value).toFixed(digits);
}

function fmtDistribution(stats, digits, percent = false) {
  const format = (value) => `${fmt(percent && value != null ? value * 100 : value, digits)}${percent ? '%' : ''}`;
  return `n=${stats.n}; median ${format(stats.median)} / p25 ${format(stats.p25)} / p75 ${format(stats.p75)} / p90 ${format(stats.p90)}`;
}

const REPORT_METRICS = Object.freeze([
  ['ruleTokens', 'Rule tokens', 1, false],
  ['crossSessionRepeatTokens', 'Exact cross-session repeat tokens', 1, false],
  ['harnessDeliveredRepeatUnits', 'Harness-delivered exact repeat units', 1, false],
  ['crossSessionShareOfRuleTokens', 'Exact repeats as share of rule tokens', 1, true],
  ['crossSessionShareOfSeedTokens', 'Exact repeats as share of whole seed', 2, true],
  ['withinSessionRepeatTokens', 'Within-session repeat tokens', 1, false],
  ['nearMatchRepeatTokens', 'Near-match repeat tokens, inclusive', 1, false],
  ['nearMatchAdditionalTokens', 'Near-match tokens beyond exact repeats', 1, false],
  ['nearMatchShareOfRuleTokens', 'Near matches as share of rule tokens', 1, true],
  ['nearMatchShareOfSeedTokens', 'Near matches as share of whole seed', 2, true],
]);

export function renderMarkdown(report) {
  const evidence = report.sample.gitRepoEvidenceKindSessions;
  const countLabel = (count, singular, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;
  const lines = [
    '# Cross-session durable rules measurement',
    '',
    '## Question',
    '',
    'How many rule tokens in a plugin seed already appeared in a seed from an earlier, different session, under three candidate reuse scopes?',
    '',
    '## Sample',
    '',
    `Scanned ${report.sample.transcriptFiles} JSONL transcripts, including ${report.sample.subagentTranscriptFiles} subagent transcripts. Found ${report.sample.compactBoundaries} compact boundaries and ${report.sample.pluginCuts} plugin seed cuts in ${report.sample.sessions} sessions.`,
    `Git scope evidence covers ${countLabel(evidence.gitCommonDir ?? 0, 'session')} resolved to a git common directory, ${countLabel(evidence.cwdFallback ?? 0, 'session')} using the unchanged cwd fallback, ${countLabel(evidence.cwdUnavailable ?? 0, 'session')} without a cwd value, and ${countLabel(evidence.mixedEvidence ?? 0, 'session')} with mixed evidence. Total sessions with any fallback evidence: ${report.sample.gitRepoFallbackSessions}.`,
    `Rule token counts use ${report.method.tokenEstimator}.`,
    '',
    '## Reading the scopes',
    '',
    '- `claudeProjectDir` keeps the original transcript-directory key for comparison. Worktrees and clones commonly split into separate keys under this scope.',
    '- `gitRepo` joins sessions whose cwd resolves to the same git common directory, including linked worktrees. If cwd is gone or not a repository, its exact cwd string remains the fallback key. Missing cwd values are isolated by session.',
    '- `global` treats any earlier different session as a possible repeat and is the vault-wide upper bound.',
    '- ExoVault is vault-wide, so `global` best matches the lookup scope issue #8 would actually use. `gitRepo` is a repository-aware sensitivity check; `claudeProjectDir` is only a comparison.',
  ];
  const sourceLabels = [
    ['constraintsHistory', 'Constraints (history)'],
    ['taskCardRules', 'Task card / Rules'],
    ['taskCardDecisions', 'Task card / Decisions'],
    ['all', 'Together'],
  ];
  const scopeLabels = {
    claudeProjectDir: 'Claude project directory',
    gitRepo: 'Git common directory',
    global: 'Vault-wide global',
  };
  for (const scopeName of SCOPE_NAMES) {
    const scope = report.scopes[scopeName];
    const all = scope.cohorts.allCuts;
    const large = scope.cohorts.projectsWithAtLeast3Sessions;
    lines.push(
      '',
      `## ${scopeLabels[scopeName]} scope`,
      '',
      `${scope.sample.cuts} cuts in ${scope.sample.sessions} sessions across ${countLabel(scope.sample.projects, 'scope key')}. The cohort with at least three sessions contains ${countLabel(scope.sample.projectsWithAtLeast3Sessions, 'key')}, ${large.sessions} sessions, and ${scope.sample.cutsInProjectsWithAtLeast3Sessions} cuts.`,
      '',
      'Exact-repeat hit cuts, meaning cuts with one or more exact repeat tokens:',
      '',
      '| Source | Exact repeat cuts, all | Exact repeat cuts, cohort | Cuts with harness-delivered repeat units, all | Cuts with harness-delivered repeat units, cohort |',
      '|---|---:|---:|---:|---:|',
    );
    for (const [sourceKey, label] of sourceLabels) {
      lines.push(`| ${label} | ${all.cutsWithCrossSessionRepeats[sourceKey]}/${all.cuts} | ${large.cutsWithCrossSessionRepeats[sourceKey]}/${large.cuts} | ${all.cutsWithHarnessDeliveredRepeatUnits[sourceKey]}/${all.cuts} | ${large.cutsWithHarnessDeliveredRepeatUnits[sourceKey]}/${large.cuts} |`);
    }
    lines.push(
      '',
      '### Per-cut distributions',
      '',
      'Values are median, p25, p75, and p90. Each cell includes its n. Token counts are estimated tokens, shares are percentages, and harness-delivered counts are distinct repeat units per cut.',
      '',
      '| Source | Measure | All cuts | Keys with at least 3 sessions |',
      '|---|---|---:|---:|',
    );
    for (const [sourceKey, sourceLabel] of sourceLabels) {
      for (const [field, label, digits, percent] of REPORT_METRICS) {
        lines.push(`| ${sourceLabel} | ${label} | ${fmtDistribution(all.sources[sourceKey][field], digits, percent)} | ${fmtDistribution(large.sources[sourceKey][field], digits, percent)} |`);
      }
    }
    lines.push(
      '',
      '### Most repeated units',
      '',
      'The table ranks normalized units by distinct sessions within a key in this scope. Unit text and scope keys are omitted.',
      '',
      '| Distinct sessions | Length in tokens | Source section | SHA-256 prefix |',
      '|---:|---:|---|---|',
    );
    if (scope.topRepeatedUnits.length) {
      for (const unit of scope.topRepeatedUnits) {
        lines.push(`| ${unit.distinctSessions} | ${unit.lengthTokens} | ${unit.sourceSections.join(', ')} | ${unit.sha256} |`);
      }
    } else {
      lines.push('| 0 | - | - | - |');
    }
  }
  lines.push(
    '',
    '## Options for issue #8',
    '',
    'Savings are gross measured seed tokens in the `global` scope, which matches ExoVault’s vault-wide lookup. A pointer has overhead. Exact repeats already present in earlier non-seed user or system text save seed tokens if moved behind a bridge, but add no new recall.',
    '',
    '| Option | Expected seed token saving from this measurement | Risk | Effort |',
    '|---|---|---|---|',
  );
  const globalAll = report.scopes.global.cohorts.allCuts;
  const globalLarge = report.scopes.global.cohorts.projectsWithAtLeast3Sessions;
  const allRepeat = globalAll.sources.all.crossSessionRepeatTokens;
  const largeRepeat = globalLarge.sources.all.crossSessionRepeatTokens;
  const allHarness = globalAll.sources.all.harnessDeliveredRepeatUnits;
  const largeHarness = globalLarge.sources.all.harnessDeliveredRepeatUnits;
  const allRepeatCuts = globalAll.cutsWithCrossSessionRepeats.all;
  const allHarnessRepeatCuts = globalAll.cutsWithHarnessDeliveredRepeatUnits.all;
  const allRules = globalAll.sources.all.ruleTokens;
  const largeRules = globalLarge.sources.all.ruleTokens;
  const globalScope = report.scopes.global.sample;
  lines.push(
    `| A. No bridge | 0 tokens from a new bridge. | Repeated constraints continue to use seed space. | None |`,
    `| B. Pointer for exact cross-session repeats only | ${allRepeatCuts}/${globalAll.cuts} global cuts had an exact repeat. Per-cut repeat-token distribution: ${fmtDistribution(allRepeat, 1)}. In the three-session cohort: ${globalLarge.cutsWithCrossSessionRepeats.all}/${globalLarge.cuts} cuts; ${fmtDistribution(largeRepeat, 1)}. Harness-delivered repeat-unit distribution: ${fmtDistribution(allHarness, 1)} overall and ${fmtDistribution(largeHarness, 1)} in the cohort. ${allHarnessRepeatCuts} of ${allRepeatCuts} exact-repeat hit cuts had at least one such unit. Subtract pointer overhead. | A stale or wrong pointer can hide a needed rule. Harness-delivered repeats save seed tokens but add no recall for those units. | Medium |`,
    `| C. Full bridge with pointers and hot rules kept verbatim | Gross ceiling is total extracted rule tokens: ${fmtDistribution(allRules, 1)} overall and ${fmtDistribution(largeRules, 1)} in the three-session cohort. Actual savings are lower after keeping hot rules and adding pointers. | Temporary, superseded, or context-specific rules could be promoted as durable. A missed or stale pointer could remove needed instructions. | High |`,
    '',
    '## Recommendation for issue #8',
    '',
    `${globalScope.sessions} sessions are represented in the vault-wide scope. Exact repeats should be judged from the global cohort because that is the runtime lookup boundary. The updated scope changes the reading: ${allRepeatCuts} of ${globalAll.cuts} cuts have an exact cross-session repeat, while ${allHarnessRepeatCuts} of those repeat-hit cuts already contain at least one repeated unit in same-session user or system text. Those harness-delivered units can save seed tokens if moved behind a bridge, but the bridge adds no recall for them. Keep A as the default. Test B only as a narrow token-saving experiment with a freshness check; its gross median is ${fmt(allRepeat.median)} tokens per cut and its p75 is ${fmt(allRepeat.p75)} before pointer overhead. Do not pursue C yet: its total-rule-token ceiling includes session-specific material and rules that may no longer apply.`,
    '',
    '## Method',
    '',
    `- Seed detection uses \`${report.method.seedIdentifier}\` inside the boundary window recognized by \`${report.method.transcriptParser}\`.`,
    `- Rule units are non-empty bullet or quoted lines from Constraints (history), Task card / Rules, and Task card / Decisions. ${report.method.normalization}`,
    '- A cross-session exact repeat requires the same normalized unit in a seed from a different session in the selected scope at a strictly earlier boundary timestamp. Same-session repeats from an earlier cut are reported separately.',
    `- ${report.method.scopeDefinitions.claudeProjectDir} ${report.method.scopeDefinitions.gitRepo} ${report.method.scopeDefinitions.global}`,
    `- Git common directory resolution is cached per cwd. Evidence counts include sessions with plugin seed cuts only. Fallback cwd strings are kept intact, including worktree-like suffixes.`,
    `- The harness-delivered metric counts distinct exact repeat units also found verbatim after whitespace and case normalization in non-seed user or system text from that transcript before the boundary.`,
    `- Near-match sensitivity compares word 3-gram sets against earlier sessions in the selected scope using Jaccard >= ${NEAR_MATCH_THRESHOLD}. The inclusive near-match count includes exact matches; the additional count excludes them.`,
    '- Each scope cohort includes keys with at least three distinct sessions represented by plugin seed cuts. Subagent transcripts use their parent session ID when available.',
    "- Per-cut token shares divide repeat tokens by that cut source's rule tokens or full seed tokens. Empty rule sections contribute zero shares.",
    '- Percentiles use linear interpolation over sorted per-cut values.',
    '- The JSON and this report omit rule text, project names, session IDs, cwd values, git paths, and transcript paths. Scope keys are SHA-256 hashed before comparison.',
    '',
    '## Limits',
    '',
    '- Exact matching misses paraphrases and treats any normalized line match as equivalent even if its meaning changed.',
    '- The near-match sensitivity can overcount boilerplate and remains a lexical measure, not evidence that the rule was needed in the later session.',
    '- A three-session cohort can still be small within the Claude project directory or git repository scopes. The global cohort can be much broader and should not be read as proof that every rule applies everywhere.',
    '- Token estimates are an approximation of model tokenizer costs. Pointer overhead and hot rules retained verbatim are not deducted from the gross repeated-token measurement.',
    '- A rule that appeared in an earlier seed may have been temporary, project-specific, or superseded. This measurement does not establish that it is safe to move.',
    '',
  );
  return `${lines.join('\n').trimEnd()}\n`;
}

export async function main(argv = process.argv.slice(2)) {
  const defaultRoot = path.resolve(os.homedir(), '.claude', 'projects');
  let root = defaultRoot;
  let outDir = '/tmp/exo-compact-durable';
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--root') root = path.resolve(argv[++index]);
    else if (argv[index] === '--out') outDir = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  const collected = await collectTranscriptCuts(root);
  const report = analyzeCuts(collected.cuts, collected.sampleMetadata);
  await fs.promises.mkdir(outDir, { recursive: true });
  await fs.promises.writeFile(path.join(outDir, 'run1.json'), `${JSON.stringify(report, null, 2)}\n`);
  const markdown = renderMarkdown(report);
  await fs.promises.writeFile(path.join(outDir, 'run1.md'), markdown);
  process.stdout.write(markdown);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
}
