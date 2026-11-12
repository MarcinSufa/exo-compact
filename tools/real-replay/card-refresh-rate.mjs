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
const MAX_NOTICE_LOG_LINES = 1500;
const CUT_NOTICE_RE = /\bcompacted\s+\S+\s+->\s+\S+\s+tokens\s+in\s+\S+\s+s\b/;
const CUT_NOTICE_SOURCE = 'plugin/compact/host/notices.ts:formatCutSummary';
const READER_KINDS = ['rule_check', 'card_check', 's4_seed_fell_back'];

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

export function findNoticeFiles(root) {
  let stat;
  try { stat = fs.statSync(root); } catch { throw new Error('Capture root does not exist'); }
  if (!stat.isDirectory()) throw new Error('Capture root must be a directory');
  const files = [];
  let readErrors = 0;
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      readErrors += 1;
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name === 'notices.log') files.push(file);
    }
  };
  visit(root);
  return { files, readErrors };
}

function parseNoticeLine(line, order) {
  const match = /^(\S+)\s+(.+)$/.exec(line);
  if (!line.trim()) return undefined;
  if (!match) return { type: 'unparseable', order };
  const time = Date.parse(match[1]);
  if (!Number.isFinite(time)) return { type: 'unparseable', order };
  const text = match[2];
  const start = /task_card\.refresh=start\b/.test(text);
  if (start) {
    const context = /\bctx=(\d+)\b/.exec(text);
    if (!context) return { type: 'unparseable', order, time };
    return {
      type: 'start', time, order, context: Number(context[1]),
      late: /(?:^|\s)late=1(?:\s|$)/.test(text),
    };
  }
  const written = /task_card\.refresh=written\s+size=(\d+)\b/.exec(text);
  if (written) return { type: 'written', time, order, size: Number(written[1]) };
  const failed = /task_card\.refresh=(unparsed|no_reply|error)\b/.exec(text);
  if (failed) return { type: 'failed', time, order, result: failed[1] };
  if (/task_card\.refresh=/.test(text)) return { type: 'unparseable', order, time };
  if (CUT_NOTICE_RE.test(text)) return { type: 'cut', time, order };
  if (/\bcompacted\b/.test(text)) return { type: 'unparseable', order, time };
  const taskCardPresent = /\bseed\.task_card=([01])(?:\s|$)/.exec(text);
  const taskCardSize = /\bseed\.task_card_size=(\d+)\b/.exec(text);
  const taskCardShrunk = /\bseed\.task_card_shrunk=(\d+)\b/.exec(text);
  const taskCardDropped = /\bseed\.task_card_dropped=1\b/.test(text);
  if (taskCardPresent || taskCardSize || taskCardShrunk || taskCardDropped) {
    const seedCardNotice = {
      present: taskCardPresent ? taskCardPresent[1] === '1' : undefined,
      size: taskCardSize ? Number(taskCardSize[1]) : undefined,
      shrunk: Boolean(taskCardShrunk),
      dropped: taskCardDropped,
    };
    if (taskCardPresent?.[1] === '1') return { type: 'reader', time, order, readerKind: 's4_seed_fell_back', seedCardNotice };
    return { type: 'seed_card_notice', time, order, seedCardNotice };
  }
  if (/^rule_check\.fired=[01]\s+broken=\d+\b/.test(text)) return { type: 'reader', time, order, readerKind: 'rule_check' };
  if (/^brief_check\.fired=1\s+source=card(?:\s|$)/.test(text)) return { type: 'reader', time, order, readerKind: 'card_check' };
  return undefined;
}

export function readSession(file, since) {
  let contents;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch {
    return {
      events: [], starts: [], writes: [], allWrites: [], failures: [], cutsSince: [],
      dropped: { orphan_starts: 0, writes_without_start: 0, unparseable_lines: 0 },
      unreadable: true, atLineCap: false,
    };
  }
  const lines = contents.split(/\r?\n/).filter(Boolean);
  const events = lines.map((line, order) => parseNoticeLine(line, order))
    .filter(Boolean)
    .sort((a, b) => (a.time ?? Number.NEGATIVE_INFINITY) - (b.time ?? Number.NEGATIVE_INFINITY) || a.order - b.order);
  let pendingStart;
  const starts = [];
  const writes = [];
  const failures = [];
  const dropped = { orphan_starts: 0, writes_without_start: 0, unparseable_lines: 0 };
  for (const event of events) {
    if (event.type === 'unparseable') {
      dropped.unparseable_lines += 1;
      continue;
    }
    if (event.type === 'start') {
      if (pendingStart) dropped.orphan_starts += 1;
      const start = { time: event.time, context: event.context, late: event.late, order: event.order, inScope: event.time >= since };
      pendingStart = start;
      starts.push(start);
      continue;
    }
    if (event.type !== 'written' && event.type !== 'failed') continue;
    if (!pendingStart) {
      if (event.type === 'written') dropped.writes_without_start += 1;
      continue;
    }
    const start = pendingStart;
    pendingStart = undefined;
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
      readers: new Set(),
    };
    event.refresh = refresh;
    writes.push(refresh);
  }
  if (pendingStart) dropped.orphan_starts += 1;
  return {
    events,
    starts: starts.filter((start) => start.inScope),
    writes: writes.filter((refresh) => refresh.inScope),
    allWrites: writes,
    failures,
    cutsSince: events.filter((event) => event.type === 'cut' && event.time >= since),
    dropped,
    unreadable: false,
    atLineCap: lines.length === MAX_NOTICE_LOG_LINES,
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
      } else if (event.type === 'reader' && latestWrite) {
        latestWrite.readers.add(event.readerKind);
      } else if (event.type === 'written' && event.refresh) {
        if (latestWrite?.inScope) superseded.push(latestWrite);
        latestWrite = event.refresh;
      }
    }
  }
  const allEquivalents = sum(writes.map((refresh) => refresh.equivalents));
  const read = superseded.filter((refresh) => Array.from(refresh.readers).some((kind) => kind !== 's4_seed_fell_back'));
  const neverRead = superseded.filter((refresh) => !Array.from(refresh.readers).some((kind) => kind !== 's4_seed_fell_back'));
  const categoryMetric = (refreshes) => ({
    count: refreshes.length,
    percent_of_written_refreshes: percent(refreshes.length, writes.length),
    percent_of_superseded_refreshes: percent(refreshes.length, superseded.length),
    equivalents: {
      sum: sum(refreshes.map((refresh) => refresh.equivalents)),
      percent_of_written_refresh_equivalents: percent(sum(refreshes.map((refresh) => refresh.equivalents)), allEquivalents),
    },
  });
  const readerKinds = Object.fromEntries(READER_KINDS.map((kind) => {
    const refreshes = read.filter((refresh) => refresh.readers.has(kind));
    return [kind, {
      ...categoryMetric(refreshes),
      percent_of_read_before_replacement: percent(refreshes.length, read.length),
    }];
  }));
  return {
    n_sessions: new Set(writes.map((write) => write.session)).size,
    n_refreshes: writes.length,
    superseded_count: superseded.length,
    read_before_replacement: { ...categoryMetric(read), reader_kinds: readerKinds },
    never_read_before_replacement: categoryMetric(neverRead),
    reader_kind_counts_overlap: true,
    definition: 'A written card is superseded when another card is written before the next recorded cut summary. A seed.task_card=1 notice without a cut summary before replacement is classified as s4_seed_fell_back and does not count as a read unless another reader notice exists.',
  };
}

export function analyzeCardRefreshRate(root, sinceText = DEFAULT_SINCE) {
  const since = Date.parse(sinceText);
  if (!Number.isFinite(since)) throw new Error('--since must be a valid ISO date or timestamp');
  const { files, readErrors: directoryReadErrors } = findNoticeFiles(root);
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
  const dropped = sessions.reduce((total, session) => ({
    orphan_starts: total.orphan_starts + session.dropped.orphan_starts,
    writes_without_start: total.writes_without_start + session.dropped.writes_without_start,
    unparseable_lines: total.unparseable_lines + session.dropped.unparseable_lines,
  }), { orphan_starts: 0, writes_without_start: 0, unparseable_lines: 0 });
  const readErrors = directoryReadErrors + sessions.filter((session) => session.unreadable).length;
  const lineCapFiles = sessions.filter((session) => session.atLineCap).length;
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
    run_at: new Date().toISOString(),
    since: sinceText,
    sessions_scanned: files.length,
    notices_files_at_line_cap: lineCapFiles,
    notices_line_cap: MAX_NOTICE_LOG_LINES,
    file_read_errors: readErrors,
    dropped: { ...dropped, count: sum(Object.values(dropped)), scope: 'all scanned notices.log files' },
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
  process.stdout.write(`Run at: ${report.run_at}\n`);
  for (const [name, metric] of [['normal', gaps.normal], ['late', gaps.late]]) {
    process.stdout.write(`${name} gaps: ${metric.gap_minutes.n} gaps in ${metric.n_sessions} sessions; median ${formatNumber(metric.gap_minutes.median)} minutes; IQR ${formatNumber(metric.gap_minutes.q1)} to ${formatNumber(metric.gap_minutes.q3)}\n`);
  }
  for (const interval of report.metrics.interval_skipping) {
    process.stdout.write(`${interval.interval_minutes} minute interval: skip ${interval.refreshes_skipped.count}/${interval.n_refreshes} (${formatPercent(interval.refreshes_skipped.percent)}); equivalents ${formatNumber(interval.equivalents_skipped.sum)} of ${formatNumber(interval.total_equivalents)} (${formatPercent(interval.equivalents_skipped.percent)})\n`);
  }
  if (report.metrics.superseded_refreshes) {
    const metric = report.metrics.superseded_refreshes;
    const read = metric.read_before_replacement;
    const neverRead = metric.never_read_before_replacement;
    process.stdout.write(`Superseded, read before replacement: ${read.count}/${metric.superseded_count} superseded (${formatPercent(read.percent_of_superseded_refreshes)}); ${formatNumber(read.equivalents.sum)} equivalents (${formatPercent(read.equivalents.percent_of_written_refresh_equivalents)})\n`);
    for (const [kind, value] of Object.entries(read.reader_kinds)) {
      process.stdout.write(`  ${kind}: ${value.count}/${metric.superseded_count} superseded (${formatPercent(value.percent_of_superseded_refreshes)}); ${formatNumber(value.equivalents.sum)} equivalents (${formatPercent(value.equivalents.percent_of_written_refresh_equivalents)})\n`);
    }
    process.stdout.write(`Superseded, never read before replacement: ${neverRead.count}/${metric.superseded_count} superseded (${formatPercent(neverRead.percent_of_superseded_refreshes)}); ${formatNumber(neverRead.equivalents.sum)} equivalents (${formatPercent(neverRead.equivalents.percent_of_written_refresh_equivalents)})\n`);
  } else process.stdout.write('Superseded metric omitted: no recorded cut summary notice in the selected range.\n');
  process.stdout.write('Skipping a refresh means the rule check and the next cut see an older card.\n');
  const failed = report.metrics.failed_refreshes;
  process.stdout.write(`Failed: ${failed.count}/${failed.n_starts} starts (${formatPercent(failed.percent)})\n`);
  process.stdout.write(`Dropped: ${report.dropped.count} total; ${report.dropped.orphan_starts} orphan starts, ${report.dropped.writes_without_start} writes without a start, ${report.dropped.unparseable_lines} unparseable lines\n`);
  process.stdout.write(`notices.log files at 1500-line cap: ${report.notices_files_at_line_cap}; read errors: ${report.file_read_errors}\n`);
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
