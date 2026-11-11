#!/usr/bin/env node
// Estimate task card refresh frequency and cost from local notices.log files.
// No session content or session identifiers are emitted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { estimateCardRefreshEquivalent } from './postcut.mjs';

const DEFAULT_SINCE = '2026-10-01';
const INTERVALS_MINUTES = [5, 10, 20, 30];
const CUT_NOTICE_RE = /\bcompacted\s+\S+\s+->\s+\S+\s+tokens\s+in\s+\S+\s+s\b/;
const CUT_NOTICE_SOURCE = 'plugin/compact/compact.ts:1484';

function parseArgs(argv) {
  let root = path.join(os.homedir(), '.exovault', 's4-capture');
  let sinceText = DEFAULT_SINCE;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      root = argv[index + 1];
      if (!root) throw new Error('--root requires a directory');
      index += 1;
    } else if (arg === '--since') {
      sinceText = argv[index + 1];
      if (!sinceText || !Number.isFinite(Date.parse(sinceText))) throw new Error('--since must be a valid ISO date or timestamp');
      index += 1;
    } else if (arg === '--json') json = true;
    else throw new Error('Usage: card-refresh-rate.mjs [--root <dir>] [--since <ISO>] [--json]');
  }
  return { root, sinceText, since: Date.parse(sinceText), json };
}

function findNoticeFiles(root) {
  let stat;
  try { stat = fs.statSync(root); } catch { throw new Error('Capture root does not exist'); }
  if (!stat.isDirectory()) throw new Error('Capture root must be a directory');
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name === 'notices.log') files.push(file);
    }
  };
  visit(root);
  return files;
}

function parseNoticeLine(line, order) {
  const match = /^(\S+)\s+(.+)$/.exec(line);
  if (!match) return undefined;
  const time = Date.parse(match[1]);
  if (!Number.isFinite(time)) return undefined;
  const text = match[2];
  const start = /task_card\.refresh=start\b/.test(text);
  if (start) {
    const context = /\bctx=(\d+)\b/.exec(text);
    if (!context) return undefined;
    return {
      type: 'start', time, order, context: Number(context[1]),
      late: /(?:^|\s)late=1(?:\s|$)/.test(text),
    };
  }
  const written = /task_card\.refresh=written\s+size=(\d+)\b/.exec(text);
  if (written) return { type: 'written', time, order, size: Number(written[1]) };
  const failed = /task_card\.refresh=(unparsed|no_reply|error)\b/.exec(text);
  if (failed) return { type: 'failed', time, order, result: failed[1] };
  if (CUT_NOTICE_RE.test(text)) return { type: 'cut', time, order };
  return undefined;
}

function readSession(file, since) {
  const events = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map((line, order) => parseNoticeLine(line, order))
    .filter(Boolean)
    .sort((a, b) => a.time - b.time || a.order - b.order);
  const pendingStarts = [];
  const starts = [];
  const writes = [];
  const failures = [];
  for (const event of events) {
    if (event.type === 'start') {
      const start = { time: event.time, context: event.context, late: event.late, order: event.order, inScope: event.time >= since };
      pendingStarts.push(start);
      starts.push(start);
      continue;
    }
    if (event.type !== 'written' && event.type !== 'failed') continue;
    const start = pendingStarts.shift();
    if (!start) continue;
    if (event.type === 'failed') {
      if (start.inScope) failures.push({ start, result: event.result });
      continue;
    }
    const refresh = {
      startTime: start.time,
      writtenTime: event.time,
      context: start.context,
      size: event.size,
      late: start.late,
      order: event.order,
      inScope: start.inScope && event.time >= since,
      equivalents: estimateCardRefreshEquivalent(start.context, event.size),
    };
    event.refresh = refresh;
    writes.push(refresh);
  }
  return {
    events,
    starts: starts.filter((start) => start.inScope),
    writes: writes.filter((refresh) => refresh.inScope),
    allWrites: writes,
    failures,
    cutsSince: events.filter((event) => event.type === 'cut' && event.time >= since),
  };
}

function quantile(sorted, p) {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  return {
    n: sorted.length,
    median: quantile(sorted, 0.5),
    q1,
    q3,
    iqr: q1 === null ? null : q3 - q1,
  };
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function percent(part, total) {
  return total ? (100 * part) / total : null;
}

function gapMetric(sessions, late) {
  const refreshes = sessions.flatMap((session) => session.writes.filter((write) => write.late === late));
  const gaps = [];
  const sessionsWithGaps = new Set();
  for (const session of sessions) {
    const ordered = session.writes.slice().sort((a, b) => a.writtenTime - b.writtenTime || a.order - b.order);
    for (let index = 1; index < ordered.length; index += 1) {
      const current = ordered[index];
      if (current.late !== late) continue;
      gaps.push((current.writtenTime - ordered[index - 1].writtenTime) / 60_000);
      sessionsWithGaps.add(session);
    }
  }
  return {
    n_sessions: sessionsWithGaps.size,
    n_refreshes: refreshes.length,
    gap_minutes: distribution(gaps),
  };
}

function intervalMetrics(sessions, writes) {
  const nSessions = new Set(writes.map((write) => write.session)).size;
  const totalEquivalents = sum(writes.map((write) => write.equivalents));
  return INTERVALS_MINUTES.map((intervalMinutes) => {
    const skipped = [];
    const sessionsWithWrites = new Set();
    for (const session of sessions) {
      const ordered = session.writes.slice().sort((a, b) => a.startTime - b.startTime || a.order - b.order);
      if (ordered.length) sessionsWithWrites.add(session);
      let lastKept;
      for (const refresh of ordered) {
        if (lastKept === undefined) {
          lastKept = refresh.startTime;
          continue;
        }
        if (refresh.startTime - lastKept < intervalMinutes * 60_000) skipped.push(refresh);
        else lastKept = refresh.startTime;
      }
    }
    const skippedEquivalents = sum(skipped.map((refresh) => refresh.equivalents));
    return {
      interval_minutes: intervalMinutes,
      clock: 'refresh start time; a skipped refresh does not reset the last kept start',
      n_sessions: sessionsWithWrites.size,
      n_refreshes: writes.length,
      refreshes_skipped: { count: skipped.length, percent: percent(skipped.length, writes.length) },
      equivalents_skipped: { sum: skippedEquivalents, percent: percent(skippedEquivalents, totalEquivalents) },
      total_equivalents: totalEquivalents,
    };
  });
}

function supersededMetric(sessions, writes, cutNoticeCount) {
  if (!cutNoticeCount) return undefined;
  const superseded = [];
  for (const session of sessions) {
    let latestWrite;
    for (const event of session.events) {
      if (event.type === 'cut') {
        latestWrite = undefined;
      } else if (event.type === 'written' && event.refresh) {
        if (latestWrite?.inScope) superseded.push(latestWrite);
        latestWrite = event.refresh;
      }
    }
  }
  const equivalents = sum(superseded.map((refresh) => refresh.equivalents));
  const allEquivalents = sum(writes.map((refresh) => refresh.equivalents));
  return {
    n_sessions: new Set(writes.map((write) => write.session)).size,
    n_refreshes: writes.length,
    count: superseded.length,
    percent: percent(superseded.length, writes.length),
    equivalents: { sum: equivalents, percent: percent(equivalents, allEquivalents) },
    definition: 'A written card is superseded when another card is written before the next recorded cut summary.',
  };
}

export function analyzeCardRefreshRate(root, sinceText = DEFAULT_SINCE) {
  const since = Date.parse(sinceText);
  if (!Number.isFinite(since)) throw new Error('--since must be a valid ISO date or timestamp');
  const files = findNoticeFiles(root);
  const sessions = files.map((file) => readSession(file, since));
  for (const session of sessions) {
    for (const start of session.starts) start.session = session;
    for (const failure of session.failures) failure.start.session = session;
  }
  const writes = sessions.flatMap((session) => session.writes);
  for (const session of sessions) for (const write of session.writes) write.session = session;
  const starts = sessions.flatMap((session) => session.starts);
  const failures = sessions.flatMap((session) => session.failures);
  const cutNoticeCount = sessions.reduce((total, session) => total + session.cutsSince.length, 0);
  const superseded = supersededMetric(sessions, writes, cutNoticeCount);
  const metrics = {
    gap_between_written_refreshes_minutes: {
      classified_by: 'late=1 on the later written refresh',
      normal: gapMetric(sessions, false),
      late: gapMetric(sessions, true),
    },
    interval_skipping: intervalMetrics(sessions, writes),
    failed_refreshes: {
      n_sessions: new Set(starts.map((start) => start.session)).size,
      n_starts: starts.length,
      count: failures.length,
      percent: percent(failures.length, starts.length),
      results: Object.fromEntries(['unparsed', 'no_reply', 'error'].map((result) => [result, failures.filter((failure) => failure.result === result).length])),
    },
  };
  if (superseded) metrics.superseded_refreshes = superseded;
  return {
    since: sinceText,
    sessions_scanned: files.length,
    sessions_with_starts: new Set(starts.map((start) => start.session)).size,
    starts: starts.length,
    written_refreshes: writes.length,
    cost_estimate: {
      unit: 'input-token equivalents',
      formula: '0.1 * ctx + 5 * size',
      source: 'tools/real-replay/postcut.mjs:94',
      basis: 'successful written refreshes paired to their start notices',
    },
    cut_notice: {
      pattern: 'compacted <before> -> <after> tokens in <seconds> s',
      source: CUT_NOTICE_SOURCE,
      observed_since: cutNoticeCount,
    },
    ...(superseded ? {} : { metric_exclusions: [{ metric: 'superseded_refreshes', reason: 'No recorded cut summary notice was found since the selected date.' }] }),
    metrics,
  };
}

const formatPercent = (value) => value === null ? 'n/a' : `${value.toFixed(1)}%`;
const formatNumber = (value) => value === null ? 'n/a' : Number(value.toFixed(2)).toLocaleString('en-US');

function printReport(report) {
  const gaps = report.metrics.gap_between_written_refreshes_minutes;
  process.stdout.write(`Since ${report.since}; ${report.sessions_scanned} sessions scanned; ${report.starts} starts; ${report.written_refreshes} written refreshes\n`);
  for (const [name, metric] of [['normal', gaps.normal], ['late', gaps.late]]) {
    process.stdout.write(`${name} gaps: ${metric.gap_minutes.n} gaps in ${metric.n_sessions} sessions; median ${formatNumber(metric.gap_minutes.median)} minutes; IQR ${formatNumber(metric.gap_minutes.q1)} to ${formatNumber(metric.gap_minutes.q3)}\n`);
  }
  for (const interval of report.metrics.interval_skipping) {
    process.stdout.write(`${interval.interval_minutes} minute interval: skip ${interval.refreshes_skipped.count}/${interval.n_refreshes} (${formatPercent(interval.refreshes_skipped.percent)}); equivalents ${formatNumber(interval.equivalents_skipped.sum)} of ${formatNumber(interval.total_equivalents)} (${formatPercent(interval.equivalents_skipped.percent)})\n`);
  }
  if (report.metrics.superseded_refreshes) {
    const metric = report.metrics.superseded_refreshes;
    process.stdout.write(`Superseded: ${metric.count}/${metric.n_refreshes} (${formatPercent(metric.percent)}); equivalents ${formatNumber(metric.equivalents.sum)} (${formatPercent(metric.equivalents.percent)})\n`);
  } else process.stdout.write('Superseded metric omitted: no recorded cut summary notice in the selected range.\n');
  const failed = report.metrics.failed_refreshes;
  process.stdout.write(`Failed: ${failed.count}/${failed.n_starts} starts (${formatPercent(failed.percent)})\n`);
  process.stdout.write(`Cut notice: ${report.cut_notice.pattern}; source ${report.cut_notice.source}; ${report.cut_notice.observed_since} observed\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = analyzeCardRefreshRate(args.root, args.sinceText);
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report);
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  try { main(); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
