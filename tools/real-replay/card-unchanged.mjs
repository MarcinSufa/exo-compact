#!/usr/bin/env node
// Aggregate card-version comparison from local notices and transcripts only.
// Card text, transcript text, session IDs, and paths are never emitted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { estimateCardRefreshEquivalent, isCompactBoundary, parseTranscriptLine, timestamp, transcriptContent } from './postcut.mjs';
import { findNoticeFiles, readSession } from './card-refresh-rate.mjs';

const DEFAULT_SINCE = '2026-10-01';
const SEED = '[[exovault:s4-seed:v1]]';
const FORK_PROMPT = 'The conversation context will be compacted soon. Write the task card that the compacted context will keep.';
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TOOL_RESULT_THRESHOLD = 10;
const NEAR_THRESHOLD = 0.2;
const CUT_MATCH_WINDOW_MS = 10 * 60 * 1000;
const CARD_SECTIONS = ['Goal', 'Rules', 'Decisions', 'Done', 'Acceptance checks', 'Next step'];

function parseBound(value, label, endOfDate = false) {
  if (!value) return undefined;
  const text = endOfDate && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value + 'T23:59:59.999Z' : value;
  const result = Date.parse(text);
  if (!Number.isFinite(result)) throw new Error('--' + label + ' must be a valid ISO date or timestamp');
  return result;
}

function parseArgs(argv) {
  let root = path.join(os.homedir(), '.claude', 'projects');
  let capture = path.join(os.homedir(), '.exovault', 's4-capture');
  let sinceText = DEFAULT_SINCE;
  let untilText;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (['--root', '--capture', '--since', '--until'].includes(arg)) {
      const value = argv[index + 1];
      if (!value) throw new Error(arg + ' requires a value');
      if (arg === '--root') root = value;
      else if (arg === '--capture') capture = value;
      else if (arg === '--since') sinceText = value;
      else untilText = value;
      index += 1;
    } else if (arg === '--json') json = true;
    else throw new Error('Usage: card-unchanged.mjs [--root <dir>] [--capture <dir>] [--since <ISO>] [--until <ISO>] [--json]');
  }
  const since = parseBound(sinceText, 'since');
  const until = parseBound(untilText, 'until', true);
  if (until !== undefined && until < since) throw new Error('--until must be on or after --since');
  return { root, capture, sinceText, untilText, since, until, json };
}

function findMainTranscripts(root) {
  let stat;
  try { stat = fs.statSync(root); } catch { throw new Error('Transcript root does not exist'); }
  if (!stat.isDirectory()) throw new Error('Transcript root must be a directory');
  const bySession = new Map();
  let readErrors = 0;
  const visit = (directory) => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { readErrors += 1; return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && !file.split(path.sep).includes('subagents')) {
        const session = entry.name.slice(0, -'.jsonl'.length);
        if (!bySession.has(session)) bySession.set(session, file);
      }
    }
  };
  visit(root);
  return { bySession, readErrors };
}

function readTranscript(file) {
  let content;
  try { content = fs.readFileSync(file, 'utf8'); } catch { return { events: [], malformed: 0, unreadable: true }; }
  const events = [];
  let malformed = 0;
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseTranscriptLine(line);
    if (parsed.malformed) malformed += 1;
    else if (parsed.event !== undefined) events.push(parsed.event);
  }
  return { events, malformed, unreadable: false };
}

function directSubagentFiles(mainFile, session) {
  const directory = path.join(path.dirname(mainFile), session, 'subagents');
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return []; }
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => path.join(directory, entry.name));
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => typeof part?.text === 'string' ? part.text : typeof part?.content === 'string' ? part.content : '').filter(Boolean).join('\n');
}
function eventText(event) { return contentText(transcriptContent(event) ?? event?.content); }

function collectStrings(value, output = [], depth = 0) {
  if (depth > 12) return output;
  if (typeof value === 'string') { output.push(value); return output; }
  if (Array.isArray(value)) { for (const item of value) collectStrings(item, output, depth + 1); return output; }
  if (!value || typeof value !== 'object') return output;
  for (const [key, item] of Object.entries(value)) {
    if (['cwd', 'sessionId', 'session_id', 'uuid', 'parentUuid', 'agentId', 'file_path', 'path'].includes(key)) continue;
    collectStrings(item, output, depth + 1);
  }
  return output;
}

function extractForkCard(text) {
  const match = /#\s+Task card\b/i.exec(text);
  if (!match) return undefined;
  const card = text.slice(match.index).trim();
  return /\n##\s/.test(card) ? card : undefined;
}

function extractSeedCard(text) {
  const markerAt = text.indexOf(SEED);
  if (markerAt < 0) return undefined;
  const heading = /(?:^|\n)##\s+Task card\s*\n/i.exec(text.slice(markerAt));
  if (!heading) return undefined;
  const bodyStart = markerAt + heading.index + heading[0].length;
  const tail = text.slice(bodyStart);
  const nextSection = /\n## (?!#)[^\n]*(?:\n|$)/.exec(tail);
  let body = (nextSection ? tail.slice(0, nextSection.index) : tail).trim();
  const lines = body.split('\n');
  if (lines[0]?.startsWith("(Kept current by this session's model")) lines.shift();
  body = lines.join('\n').trim();
  return body ? '## Task card\n' + body : undefined;
}

function isShrinkMarker(line) {
  return /^\s*-?\s*\((?:(?:\d+)\s+more\s+lines?\b|.*\bleft\s+out:\s*\d+\s+lines?\b)[^)]*\)\s*$/i.test(line);
}

function detectCardShrink(card, notice = {}) {
  const reasons = [];
  if (String(card).split(/\r?\n/).some(isShrinkMarker)) reasons.push('section_marker');
  if (notice.shrunk) reasons.push('seed_task_card_shrunk_notice');
  if (notice.dropped) reasons.push('seed_task_card_dropped_notice');
  return { shrunk: reasons.length > 0, reasons };
}

function mapSeedCardNoticesToBoundaries(boundaries, notices) {
  const mapped = new Map();
  for (const notice of notices.filter((item) => item.seedCardNotice?.shrunk || item.seedCardNotice?.dropped)) {
    const candidate = boundaries.map((boundary) => ({ boundary, delta: Math.abs(boundary.time - notice.time) }))
      .filter((item) => item.delta <= CUT_MATCH_WINDOW_MS)
      .sort((a, b) => a.delta - b.delta)[0];
    if (!candidate) continue;
    const reasons = mapped.get(candidate.boundary.time) ?? new Set();
    if (notice.seedCardNotice.shrunk) reasons.add('seed_task_card_shrunk_notice');
    if (notice.seedCardNotice.dropped) reasons.add('seed_task_card_dropped_notice');
    mapped.set(candidate.boundary.time, reasons);
  }
  return mapped;
}

function readForkReplies(files) {
  const replies = [];
  let promptEvents = 0, malformed = 0, unreadable = 0;
  for (const file of files) {
    const transcript = readTranscript(file);
    malformed += transcript.malformed;
    if (transcript.unreadable) { unreadable += 1; continue; }
    const pending = [];
    for (const event of transcript.events) {
      if (collectStrings(event).join('\n').includes(FORK_PROMPT)) {
        promptEvents += 1;
        pending.push(timestamp(event));
      }
      if (event?.type !== 'assistant' || pending.length === 0) continue;
      const card = extractForkCard(eventText(event));
      if (!card) continue;
      replies.push({ card, time: timestamp(event), promptTime: pending.shift() });
    }
  }
  return { replies, promptEvents, malformed, unreadable };
}

function readSeedCards(events, refreshes, cutNotices, seedCardNotices) {
  const boundaries = events.filter(isCompactBoundary).map((event) => ({ time: timestamp(event) })).filter((item) => item.time > 0);
  const noticeReasons = mapSeedCardNoticesToBoundaries(boundaries, seedCardNotices);
  const seeds = [];
  for (const event of events) {
    if (event?.type !== 'user' || typeof transcriptContent(event) !== 'string') continue;
    const card = extractSeedCard(eventText(event));
    if (!card) continue;
    const time = timestamp(event);
    const boundary = boundaries.filter((item) => item.time <= time + 1000 && time - item.time <= 10_000)
      .sort((a, b) => Math.abs(time - a.time) - Math.abs(time - b.time))[0];
    if (!boundary) continue;
    const cut = cutNotices.filter((item) => Math.abs(item.time - boundary.time) <= CUT_MATCH_WINDOW_MS)
      .sort((a, b) => Math.abs(a.time - boundary.time) - Math.abs(b.time - boundary.time))[0];
    if (!cut) continue;
    const rowIndex = refreshes.reduce((found, row, index) => row.writtenTime <= boundary.time ? index : found, -1);
    if (rowIndex < 0 || seeds.some((seed) => seed.rowIndex === rowIndex)) continue;
    const detection = detectCardShrink(card, {
      shrunk: noticeReasons.get(boundary.time)?.has('seed_task_card_shrunk_notice'),
      dropped: noticeReasons.get(boundary.time)?.has('seed_task_card_dropped_notice'),
    });
    seeds.push({ rowIndex, card, time, shrunk: detection.shrunk, shrinkReasons: detection.reasons });
  }
  return seeds;
}

function mapForkReplies(replies, refreshes) {
  const mapped = new Map();
  for (const reply of [...replies].sort((a, b) => (a.promptTime || a.time) - (b.promptTime || b.time))) {
    const referenceTime = reply.promptTime || reply.time;
    const available = refreshes.map((row, index) => ({ row, index }))
      .filter(({ index }) => !mapped.has(index))
      .sort((a, b) => referenceTime > 0 ? Math.abs(a.row.startTime - referenceTime) - Math.abs(b.row.startTime - referenceTime) : a.index - b.index);
    if (available[0]) mapped.set(available[0].index, cardVersion(reply.card, 'fork_reply'));
  }
  return mapped;
}

function normalizedWhitespace(text) { return String(text).trim().replace(/\s+/g, ' '); }
function normalizedLines(text) { return String(text).split(/\r?\n/).map((line) => line.trim().replace(/[\t ]+/g, ' ')).filter(Boolean); }

function cardVersion(card, source, notice = {}) {
  const detection = detectCardShrink(card, notice);
  return { card, source, shrunk: detection.shrunk, shrinkReasons: detection.reasons };
}

function cardSections(card) {
  const sections = new Map();
  let current;
  for (const line of String(card).split(/\r?\n/)) {
    const heading = /^#{2,3}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const label = CARD_SECTIONS.find((section) => section.toLowerCase() === heading[1].toLowerCase());
      current = label;
      if (label && !sections.has(label)) sections.set(label, []);
      continue;
    }
    if (current && line.trim() && !isShrinkMarker(line)) sections.get(current).push(line);
  }
  return sections;
}

function commonKeptSectionShare(before, after, section) {
  const left = cardSections(before).get(section) ?? [];
  const right = cardSections(after).get(section) ?? [];
  const commonKeptLines = Math.min(left.length, right.length);
  if (!commonKeptLines) return null;
  return lineChangeShare(left.slice(0, commonKeptLines).join('\n'), right.slice(0, commonKeptLines).join('\n'));
}

function normalizedCharacterLine(text) { return normalizedWhitespace(text); }

function normalizedLevenshteinSimilarity(before, after) {
  const left = Array.from(normalizedCharacterLine(before));
  const right = Array.from(normalizedCharacterLine(after));
  const denominator = Math.max(left.length, right.length);
  if (!denominator) return 1;
  let previous = Uint32Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Uint32Array(right.length + 1);
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return 1 - previous[right.length] / denominator;
}

function lineChangeShare(before, after) {
  const left = normalizedLines(before), right = normalizedLines(after);
  let previous = new Uint32Array(right.length + 1);
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Uint32Array(right.length + 1);
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  const unchanged = previous[right.length];
  const denominator = Math.max(left.length, right.length, 1);
  return Math.max(left.length - unchanged, right.length - unchanged) / denominator;
}

function quantile(sorted, p) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * p, low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}
function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75);
  return { n: sorted.length, median: quantile(sorted, 0.5), q1, q3, iqr: q1 === null ? null : q3 - q1 };
}
function percent(part, total) { return total ? 100 * part / total : null; }

function scopedRows(parsed, since, until) {
  return parsed.allWrites.filter((row) => row.startTime >= since && row.writtenTime >= since
    && (until === undefined || (row.startTime <= until && row.writtenTime <= until)))
    .sort((a, b) => a.startTime - b.startTime || a.order - b.order);
}

function isRealUser(event) {
  const content = transcriptContent(event);
  return event?.type === 'user' && !event.isMeta && !event.isCompactSummary
    && !event.message?.isCompactSummary && !event.message?.compactSummary
    && typeof content === 'string' && !content.startsWith(SEED) && !content.startsWith('<');
}
function toolUses(event) {
  const content = transcriptContent(event);
  return event?.type === 'assistant' && Array.isArray(content) ? content.filter((part) => part?.type === 'tool_use') : [];
}
function toolResultCount(event) {
  const content = transcriptContent(event);
  return event?.type === 'user' && Array.isArray(content) ? content.filter((part) => part?.type === 'tool_result').length : 0;
}
function hasGitCommit(command) {
  return /\bgit\s+(?:(?:-[A-Za-z][\w-]*)(?:\s+\S+)?\s+)*commit(?:\s|$)/m.test(command);
}
function predictorFlags(events, from, to) {
  const between = events.filter((event) => timestamp(event) > from && timestamp(event) < to);
  const uses = between.flatMap(toolUses);
  return {
    noNewUser: !between.some(isRealUser),
    noEdit: !uses.some((use) => WRITE_TOOLS.has(use.name)),
    noCommit: !uses.some((use) => use.name === 'Bash' && hasGitCommit(String(use.input?.command ?? ''))),
    toolResults: between.reduce((total, event) => total + toolResultCount(event), 0),
  };
}

function makePredictor(pairs, definition, matches) {
  const confusion = { tp: 0, fp: 0, fn: 0, tn: 0 };
  let predictedSkipEquivalents = 0, truePositiveEquivalents = 0, fidelityLossEquivalents = 0;
  for (const pair of pairs) {
    const unchanged = pair.identical || pair.share < 0.1, skip = matches(pair.flags);
    if (unchanged && skip) confusion.tp += 1;
    else if (!unchanged && skip) confusion.fp += 1;
    else if (unchanged) confusion.fn += 1;
    else confusion.tn += 1;
    if (skip) {
      predictedSkipEquivalents += pair.equivalents;
      if (unchanged) truePositiveEquivalents += pair.equivalents;
      else fidelityLossEquivalents += pair.equivalents;
    }
  }
  const predicted = confusion.tp + confusion.fp, actual = confusion.tp + confusion.fn;
  return {
    definition, confusion,
    precision: predicted ? confusion.tp / predicted : null,
    recall: actual ? confusion.tp / actual : null,
    n: pairs.length,
    refreshes_predicted_skip: predicted,
    predicted_skip_equivalents: predictedSkipEquivalents,
    true_positive_equivalents: truePositiveEquivalents,
    fidelity_loss: { count: confusion.fp, equivalents: fidelityLossEquivalents },
  };
}

function countAdjacentPairs(sessionRows, thresholdSums) {
  const pairs = [], perSession = [];
  for (const session of sessionRows) {
    const { rows, cards, events } = session;
    const sessionStats = { n: 0, identical: 0, near_identical: 0, changed: 0 };
    for (let index = 1; index < rows.length; index += 1) {
      const beforeVersion = cards.get(index - 1), afterVersion = cards.get(index);
      if (!beforeVersion || !afterVersion) continue;
      const before = beforeVersion.card, after = afterVersion.card;
      const identical = normalizedWhitespace(before) === normalizedWhitespace(after);
      const share = identical ? 0 : lineChangeShare(before, after);
      const pair = {
        identical, share, equivalents: rows[index].equivalents,
        beforeCard: before, afterCard: after,
        beforeShrunk: beforeVersion.shrunk, afterShrunk: afterVersion.shrunk,
        shrunk: beforeVersion.shrunk || afterVersion.shrunk,
        flags: predictorFlags(events, rows[index - 1].startTime, rows[index].startTime),
      };
      pairs.push(pair);
      sessionStats.n += 1;
      if (identical) sessionStats.identical += 1;
      else if (share <= NEAR_THRESHOLD) sessionStats.near_identical += 1;
      else sessionStats.changed += 1;
      if (identical) thresholdSums.exact += pair.equivalents;
      if (share <= 0.1) thresholdSums.ten += pair.equivalents;
      if (share <= 0.2) thresholdSums.twenty += pair.equivalents;
    }
    if (sessionStats.n > 0) perSession.push(sessionStats);
  }
  return { pairs, perSession };
}

function equivalentsFor(pairs) { return pairs.reduce((total, pair) => total + pair.equivalents, 0); }

function wholeCardComparison(pairs) {
  const exact = pairs.filter((pair) => pair.identical);
  const threshold = (limit) => {
    const qualifying = pairs.filter((pair) => pair.share <= limit);
    return { refreshes_skipped: qualifying.length, equivalents_saved: equivalentsFor(qualifying) };
  };
  return {
    n: pairs.length,
    line_change_share: distribution(pairs.map((pair) => pair.share)),
    exact_identity: { refreshes_skipped: exact.length, equivalents_saved: equivalentsFor(exact) },
    changed_line_thresholds: { '10%': threshold(0.1), '20%': threshold(0.2) },
  };
}

function sectionComparison(pairs) {
  return Object.fromEntries(CARD_SECTIONS.map((section) => {
    const comparisons = pairs.flatMap((pair) => {
      const left = cardSections(pair.beforeCard).get(section) ?? [];
      const right = cardSections(pair.afterCard).get(section) ?? [];
      const commonKeptLines = Math.min(left.length, right.length);
      if (!commonKeptLines) return [];
      return [{
        pair,
        commonKeptLines,
        share: commonKeptSectionShare(pair.beforeCard, pair.afterCard, section),
        firstLineSimilarity: normalizedLevenshteinSimilarity(left[0], right[0]),
      }];
    });
    const exact = comparisons.filter((item) => item.share === 0);
    const singleLineCount = comparisons.filter((item) => item.commonKeptLines === 1).length;
    const similarFirstLineCount = comparisons.filter((item) => item.firstLineSimilarity >= 0.9).length;
    const at = (limit) => {
      const qualifying = comparisons.filter((item) => item.share <= limit);
      return {
        pairs_at_threshold: qualifying.length,
        next_refresh_equivalents: qualifying.reduce((total, item) => total + item.pair.equivalents, 0),
      };
    };
    return [section, {
      n: comparisons.length,
      line_change_share: distribution(comparisons.map((item) => item.share)),
      common_kept_lines_per_pair: distribution(comparisons.map((item) => item.commonKeptLines)),
      single_line_comparison: { pairs: singleLineCount, share: comparisons.length ? singleLineCount / comparisons.length : null },
      first_line_character_similarity: {
        ...distribution(comparisons.map((item) => item.firstLineSimilarity)),
        count_at_least_0_9: similarFirstLineCount,
      },
      exact_identity: { pairs: exact.length, next_refresh_equivalents: exact.reduce((total, item) => total + item.pair.equivalents, 0) },
      changed_line_thresholds: { '10%': at(0.1), '20%': at(0.2) },
    }];
  }));
}

function summarizeRefreshStretches(events, rows, since, until) {
  const cuts = events.filter((event) => event.type === 'cut').sort((a, b) => a.time - b.time || a.order - b.order);
  const inScopeCuts = cuts.filter((event) => event.time >= since && (until === undefined || event.time <= until));
  const previousCut = cuts.filter((event) => event.time < since).at(-1)?.time ?? since;
  const stretches = [];
  let after = previousCut;
  for (const cut of inScopeCuts) {
    const refreshes = rows.filter((row) => row.writtenTime > after && row.writtenTime <= cut.time);
    stretches.push({ refreshes: refreshes.length, equivalents: refreshes.reduce((total, row) => total + row.equivalents, 0), closed: true });
    after = cut.time;
  }
  const trailing = rows.filter((row) => row.writtenTime > after);
  if (trailing.length) stretches.push({ refreshes: trailing.length, equivalents: trailing.reduce((total, row) => total + row.equivalents, 0), closed: false });
  return stretches;
}

function matchCuts(noticeCuts, events) {
  const boundaries = events.filter(isCompactBoundary).map(timestamp).filter((time) => time > 0);
  const used = new Set(), matched = [];
  for (const notice of noticeCuts) {
    const candidate = boundaries.map((time, index) => ({ time, index, delta: Math.abs(time - notice.time) }))
      .filter(({ index, delta }) => !used.has(index) && delta <= CUT_MATCH_WINDOW_MS)
      .sort((a, b) => a.delta - b.delta)[0];
    if (!candidate) continue;
    used.add(candidate.index);
    matched.push({ noticeTime: notice.time, time: candidate.time });
  }
  return matched.sort((a, b) => a.time - b.time);
}

function assistantCallCount(events, after, through) {
  const keys = new Set();
  for (const event of events) {
    const time = timestamp(event), model = event?.message?.model;
    if (event?.type !== 'assistant' || !model || model === '<synthetic>' || time <= after || time > through) continue;
    keys.add(event.message.id ?? event.requestId ?? (String(time) + ':' + model));
  }
  return keys.size;
}

function summarizeCoalescing(sessions) {
  let refreshesInScope = 0, sessionsWithTranscript = 0, withFollowingCut = 0, withoutFollowingCut = 0;
  const calls = [];
  for (const session of sessions) {
    refreshesInScope += session.rows.length;
    if (session.hasMainTranscript && session.rows.length) sessionsWithTranscript += 1;
    for (const row of session.rows) {
      const cut = session.matchedCuts.find((candidate) => candidate.time >= row.writtenTime);
      if (!cut) { withoutFollowingCut += 1; continue; }
      withFollowingCut += 1;
      calls.push(assistantCallCount(session.events, row.writtenTime, cut.time));
    }
  }
  const window = (limit) => {
    const count = calls.filter((value) => value <= limit).length;
    return { count, percent: percent(count, calls.length) };
  };
  return {
    refreshes_in_scope: refreshesInScope,
    sessions_with_main_transcript: sessionsWithTranscript,
    n: calls.length,
    with_following_matched_cut: withFollowingCut,
    without_following_matched_cut: withoutFollowingCut,
    assistant_calls_to_next_cut: distribution(calls),
    within_1_assistant_calls: window(1),
    within_3_assistant_calls: window(3),
    within_5_assistant_calls: window(5),
  };
}

function analyzeCardUnchanged({ root, capture, sinceText, untilText, since, until }) {
  const noticeScan = findNoticeFiles(capture), transcriptScan = findMainTranscripts(root);
  const noticeFiles = noticeScan.files;
  let unparseableNoticeLines = 0, noticeReadErrors = 0, noticesAtLineCap = 0;
  let mainTranscriptMissing = 0, transcriptReadErrors = 0, malformedTranscriptLines = 0;
  let subagentTranscriptFiles = 0, forkPromptEvents = 0, forkReplyCards = 0, seedCardsFound = 0;
  let forkRepliesMapped = 0, seedCardsMapped = 0;
  const sessionRows = [], scopedRefreshes = [], refreshStretches = [];

  for (const noticeFile of noticeScan.files) {
    const session = path.basename(path.dirname(noticeFile));
    const parsed = readSession(noticeFile, Number.NEGATIVE_INFINITY);
    unparseableNoticeLines += parsed.dropped.unparseable_lines;
    if (parsed.unreadable) noticeReadErrors += 1;
    if (parsed.atLineCap) noticesAtLineCap += 1;
    const rows = scopedRows(parsed, since, until);
    refreshStretches.push(...summarizeRefreshStretches(parsed.events, rows, since, until));
    if (!rows.length) continue;
    scopedRefreshes.push(...rows);
    const cutNotices = parsed.events.filter((event) => event.type === 'cut' && event.time >= since && (until === undefined || event.time <= until));
    const mainFile = transcriptScan.bySession.get(session);
    const main = mainFile ? readTranscript(mainFile) : { events: [], malformed: 0, unreadable: false };
    if (!mainFile) mainTranscriptMissing += 1;
    if (main.unreadable) transcriptReadErrors += 1;
    malformedTranscriptLines += main.malformed;
    const subagentFiles = mainFile ? directSubagentFiles(mainFile, session) : [];
    subagentTranscriptFiles += subagentFiles.length;
    const fork = readForkReplies(subagentFiles.concat(mainFile ? [mainFile] : []));
    forkPromptEvents += fork.promptEvents;
    forkReplyCards += fork.replies.length;
    malformedTranscriptLines += fork.malformed;
    transcriptReadErrors += fork.unreadable;
    const forkCards = mapForkReplies(fork.replies, rows);
    const seedNotices = parsed.events.filter((event) => event.seedCardNotice);
    const seedCards = readSeedCards(main.events, rows, cutNotices, seedNotices);
    const seedMap = new Map(seedCards.map((item) => [item.rowIndex, {
      card: item.card, source: 'seed_after_cut', shrunk: item.shrunk, shrinkReasons: item.shrinkReasons,
    }]));
    seedCardsFound += seedCards.length;
    forkRepliesMapped += forkCards.size;
    seedCardsMapped += seedMap.size;
    const adjacentCount = (cards) => rows.slice(1).reduce((total, _row, index) => total + (cards.has(index) && cards.has(index + 1) ? 1 : 0), 0);
    let source = 'unavailable', cards = new Map();
    if (adjacentCount(forkCards) > 0) { source = 'fork_reply'; cards = forkCards; }
    else if (adjacentCount(seedMap) > 0) { source = 'seed_after_cut'; cards = seedMap; }
    const events = main.events.sort((a, b) => timestamp(a) - timestamp(b));
    sessionRows.push({ rows, cards, events, hasMainTranscript: Boolean(mainFile), source, matchedCuts: matchCuts(cutNotices, main.events) });
  }

  const sourceCounts = { fork_reply_sessions: 0, seed_sessions: 0, unavailable_sessions: 0, fork_reply_cards: 0, seed_cards: 0 };
  let recoverableRefreshes = 0;
  let shrunkRecoveredCards = 0;
  const shrinkReasonCounts = { section_marker_cards: 0, notice_shrunk_cards: 0, notice_dropped_cards: 0 };
  for (const session of sessionRows) {
    if (session.source === 'fork_reply') sourceCounts.fork_reply_sessions += 1;
    else if (session.source === 'seed_after_cut') sourceCounts.seed_sessions += 1;
    else sourceCounts.unavailable_sessions += 1;
    if (session.source === 'fork_reply') sourceCounts.fork_reply_cards += session.cards.size;
    if (session.source === 'seed_after_cut') sourceCounts.seed_cards += session.cards.size;
    recoverableRefreshes += session.cards.size;
    for (const version of session.cards.values()) {
      if (version.shrunk) shrunkRecoveredCards += 1;
      if (version.shrinkReasons.includes('section_marker')) shrinkReasonCounts.section_marker_cards += 1;
      if (version.shrinkReasons.includes('seed_task_card_shrunk_notice')) shrinkReasonCounts.notice_shrunk_cards += 1;
      if (version.shrinkReasons.includes('seed_task_card_dropped_notice')) shrinkReasonCounts.notice_dropped_cards += 1;
    }
  }

  const thresholdSums = { exact: 0, ten: 0, twenty: 0 };
  const pairResult = countAdjacentPairs(sessionRows, thresholdSums);
  const pairs = pairResult.pairs;
  const shrunkPairs = pairs.filter((pair) => pair.shrunk);
  const unshrunkPairs = pairs.filter((pair) => !pair.shrunk);
  const identical = pairs.filter((pair) => pair.identical).length;
  const nonidenticalShares = pairs.filter((pair) => !pair.identical).map((pair) => pair.share);
  const nearShares = pairs.filter((pair) => !pair.identical && pair.share <= NEAR_THRESHOLD).map((pair) => pair.share);
  const nearCount = nearShares.length, changedCount = pairs.length - identical - nearCount;
  const savingsAt = (threshold, equivalents) => ({
    refreshes_skipped: pairs.filter((pair) => pair.share <= threshold).length,
    equivalents_saved: equivalents,
  });
  const predictors = {
    no_new_real_user: makePredictor(pairs, 'no real user message between consecutive refresh starts', (flags) => flags.noNewUser),
    no_edit_tool: makePredictor(pairs, 'no Edit, Write, MultiEdit, or NotebookEdit tool use between consecutive refresh starts', (flags) => flags.noEdit),
    no_git_commit: makePredictor(pairs, 'no git commit command in Bash between consecutive refresh starts', (flags) => flags.noCommit),
    fewer_than_n_tool_results: makePredictor(pairs, 'fewer than ' + TOOL_RESULT_THRESHOLD + ' tool_result blocks between consecutive refresh starts', (flags) => flags.toolResults < TOOL_RESULT_THRESHOLD),
  };
  const stretchCounts = refreshStretches.map((stretch) => stretch.refreshes);
  const multiRefreshStretches = refreshStretches.filter((stretch) => stretch.refreshes >= 2);
  const refreshEquivalents = scopedRefreshes.reduce((total, row) => total + row.equivalents, 0);
  const refreshesInMultiStretches = multiRefreshStretches.reduce((total, stretch) => total + stretch.refreshes, 0);
  const equivalentsInMultiStretches = multiRefreshStretches.reduce((total, stretch) => total + stretch.equivalents, 0);
  const withinStretchPairs = multiRefreshStretches.reduce((total, stretch) => total + stretch.refreshes - 1, 0);
  const observationDays = Math.max(0, (Date.now() - since) / (24 * 60 * 60 * 1000));
  const withinStretchPairsPerDay = observationDays > 0 ? withinStretchPairs / observationDays : null;
  const report = {
    run_at: new Date().toISOString(),
    since: sinceText,
    until: untilText ?? null,
    scope: {
      notice_files_scanned: noticeFiles.length,
      sessions_with_refreshes: sessionRows.length,
      written_refreshes: scopedRefreshes.length,
      sessions_with_main_transcript: sessionRows.filter((session) => session.hasMainTranscript).length,
      sessions_with_recoverable_cards: sessionRows.filter((session) => session.cards.size > 0).length,
      recoverable_refreshes: recoverableRefreshes,
      recoverable_refresh_percent: percent(recoverableRefreshes, scopedRefreshes.length),
    },
    version_sources: {
      search: 'session JSONL and sibling subagents JSONL for refresh prompt and assistant card reply; main session seed after a compact boundary for embedded task-card sections',
      fork_prompt_signature_found: forkPromptEvents,
      fork_reply_cards_found: forkReplyCards,
      fork_reply_cards_mapped_to_refreshes: forkRepliesMapped,
      seed_cards_found_after_matched_cuts: seedCardsFound,
      seed_cards_mapped_to_refreshes: seedCardsMapped,
      selected: sourceCounts,
      selection_rule: 'per session, use fork replies when they form at least one adjacent refresh pair; otherwise use seed cards when they form an adjacent pair',
    },
    shrink_detection: {
      recovered_cards: recoverableRefreshes,
      shrunk_cards: shrunkRecoveredCards,
      shrunk_card_percent: percent(shrunkRecoveredCards, recoverableRefreshes),
      detected_by_reason: shrinkReasonCounts,
      pairs: pairs.length,
      pairs_with_any_shrunk_card: shrunkPairs.length,
      pairs_with_both_shrunk_cards: pairs.filter((pair) => pair.beforeShrunk && pair.afterShrunk).length,
      definition: 'A recovered card is shrunk when its seed task-card text contains a parenthesized more-lines or left-out-lines marker, or a matched seed.task_card_shrunk/seed.task_card_dropped notice is associated with its compact boundary.',
    },
    card_pairs: {
      n: pairs.length,
      per_session: {
        sessions_with_pairs: pairResult.perSession.length,
        pair_count: distribution(pairResult.perSession.map((session) => session.n)),
        identical_pair_count: distribution(pairResult.perSession.map((session) => session.identical)),
        near_identical_pair_count: distribution(pairResult.perSession.map((session) => session.near_identical)),
        changed_pair_count: distribution(pairResult.perSession.map((session) => session.changed)),
      },
      identical: { count: identical, percent: percent(identical, pairs.length) },
      near_identical: { count: nearCount, percent: percent(nearCount, pairs.length), threshold: NEAR_THRESHOLD, line_change_share: distribution(nearShares) },
      changed: { count: changedCount, percent: percent(changedCount, pairs.length), threshold_above: NEAR_THRESHOLD },
      line_change_share: distribution(nonidenticalShares),
      definition: 'adjacent in-scope successful refresh rows with both cards recovered; exact identity collapses all whitespace; line share is max(insertions, deletions) from an LCS diff divided by the larger nonblank line count',
    },
    savings: {
      exact_identity: { refreshes_skipped: identical, equivalents_saved: thresholdSums.exact },
      changed_line_thresholds: {
        '10%': savingsAt(0.1, thresholdSums.ten),
        '20%': savingsAt(0.2, thresholdSums.twenty),
      },
      equivalents_formula: 'shared estimateCardRefreshEquivalent(ctx, size) applied to paired refresh context and written-card size',
    },
    corrected_comparisons: {
      all_recovered_pairs: wholeCardComparison(pairs),
      unshrunk_pairs: wholeCardComparison(unshrunkPairs),
      per_section_common_kept_lines: sectionComparison(pairs),
      definitions: {
        unshrunk_pairs: 'both recovered card versions have no recognized shrink marker or shrink/drop notice',
        per_section_common_kept_lines: 'omit shrink-marker lines and compare the first min(kept nonblank lines in each version) within each section; omit a section pair when either version kept no body line',
        common_kept_lines_per_pair: 'for each compared section pair, the number of nonblank, non-marker lines available in both versions at the start of the section',
        single_line_comparison: 'fraction of compared section pairs with exactly one common kept line',
        first_line_character_similarity: 'normalized Levenshtein similarity on whitespace-normalized first kept lines, using Unicode code points and 1 - edit distance / longer line length; count is the number at or above 0.9',
        section_thresholds: 'counts are descriptive section-level matches and equivalents attached to the next refresh; an unchanged section alone is not a whole-card skip decision',
      },
    },
    predictor_parameters: {
      target: 'unchanged means identical after whitespace normalization or line-change share < 10%',
      interval: 'main transcript events strictly between consecutive in-scope refresh start times',
      tool_result_threshold_n: TOOL_RESULT_THRESHOLD,
      tool_results_between_refreshes: distribution(pairs.map((pair) => pair.flags.toolResults)),
    },
    predictors,
    near_cut_coalescing: summarizeCoalescing(sessionRows),
    refreshes_per_cut_stretch: {
      n: refreshStretches.length,
      refreshes_per_stretch: distribution(stretchCounts),
      with_two_or_more_refreshes: { count: multiRefreshStretches.length, percent: percent(multiRefreshStretches.length, refreshStretches.length) },
      complete_stretches: refreshStretches.filter((stretch) => stretch.closed).length,
      open_stretches_with_refreshes: refreshStretches.filter((stretch) => !stretch.closed).length,
      refreshes_in_two_or_more_stretches: { count: refreshesInMultiStretches, percent_of_all_refreshes: percent(refreshesInMultiStretches, scopedRefreshes.length) },
      equivalents_in_two_or_more_stretches: { sum: equivalentsInMultiStretches, percent_of_all_refresh_equivalents: percent(equivalentsInMultiStretches, refreshEquivalents) },
      within_stretch_adjacent_pairs: {
        count: withinStretchPairs,
        measured_refresh_rate_per_day: observationDays > 0 ? scopedRefreshes.length / observationDays : null,
        observed_pair_rate_per_day: withinStretchPairsPerDay,
        days_for_100_pairs_at_observed_rate: withinStretchPairsPerDay > 0 ? 100 / withinStretchPairsPerDay : null,
        observation_days: observationDays,
      },
      definition: 'Each recorded cut summary closes a stretch from the preceding cut (exclusive) through that cut (inclusive); a nonempty tail after the last recorded cut is included as open. Refresh counts and equivalent totals reuse scoped successful rows from card-refresh-rate.mjs.',
    },
    data_quality: {
      unparseable_notice_lines: unparseableNoticeLines,
      unreadable_notice_files: noticeReadErrors,
      notices_files_at_1500_line_cap: noticesAtLineCap,
      main_transcripts_missing_for_refresh_sessions: mainTranscriptMissing,
      transcript_read_errors: transcriptReadErrors,
      malformed_transcript_lines: malformedTranscriptLines,
      subagent_transcript_files_searched: subagentTranscriptFiles,
      transcript_root_read_errors: transcriptScan.readErrors,
      capture_root_read_errors: noticeScan.readErrors,
    },
  };
  if (scopedRefreshes.some((row) => row.equivalents !== estimateCardRefreshEquivalent(row.context, row.size))) {
    throw new Error('Refresh-equivalent rows do not match the shared estimator');
  }
  return report;
}

function printReport(report) {
  process.stdout.write('Task-card refresh analysis: ' + report.scope.written_refreshes + ' refreshes, ' + report.scope.recoverable_refreshes + ' recovered cards, ' + report.card_pairs.n + ' adjacent pairs\n');
  process.stdout.write('Identical: ' + report.card_pairs.identical.count + '; near-identical (<=20% line changes): ' + report.card_pairs.near_identical.count + '; changed: ' + report.card_pairs.changed.count + '\n');
  process.stdout.write('Exact skip estimate: ' + report.savings.exact_identity.equivalents_saved + ' equivalents; 10%: ' + report.savings.changed_line_thresholds['10%'].equivalents_saved + '; 20%: ' + report.savings.changed_line_thresholds['20%'].equivalents_saved + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = analyzeCardUnchanged(args);
  if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else printReport(report);
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  try { main(); } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  }
}
