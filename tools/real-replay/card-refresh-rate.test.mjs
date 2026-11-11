import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = process.env.CARD_REFRESH_RATE_SCRIPT || path.join(import.meta.dirname, 'card-refresh-rate.mjs');
const base = Date.parse('2026-10-10T00:00:00.000Z');
const at = (minutes) => new Date(base + minutes * 60_000).toISOString();
const start = (minutes, { ctx = 100, late = false } = {}) => {
  const lateText = late === true ? ' late=1 calls=8' : typeof late === 'string' ? ` ${late}` : '';
  return `${at(minutes)} task_card.refresh=start ctx=${ctx} window=250000 n=1${lateText}`;
};
const written = (minutes, size = 10) => `${at(minutes)} task_card.refresh=written size=${size}`;
const failed = (minutes, result) => `${at(minutes)} task_card.refresh=${result} reason=test`;
const cut = (minutes) => `${at(minutes)} compacted 200k -> 10k tokens in 1.0 s`;

function fixture(lines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'card-refresh-rate-'));
  writeSession(root, 'session-a', lines);
  return root;
}

function writeSession(root, name, lines) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notices.log'), `${lines.join('\n')}\n`);
  return path.join(dir, 'notices.log');
}

function run(root, since = '2026-10-01') {
  const result = spawnSync(process.execPath, [script, '--root', root, '--since', since, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function runText(root, since = '2026-10-01') {
  const result = spawnSync(process.execPath, [script, '--root', root, '--since', since], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('interval skipping does not reset its clock after a skipped refresh', () => {
  const root = fixture([
    start(0), written(0),
    start(6), written(6),
    start(11), written(11),
  ]);
  try {
    const report = run(root);
    const ten = report.metrics.interval_skipping.find((item) => item.interval_minutes === 10);
    assert.equal(ten.refreshes_skipped.count, 1);
    assert.equal(ten.refreshes_skipped.percent, 100 / 3);
    assert.equal(ten.equivalents_skipped.sum, 60);
    assert.equal(ten.equivalents_skipped.percent, 100 / 3);
  } finally {
    cleanup(root);
  }
});

test('a refresh exactly N minutes after the last kept start is not skipped', () => {
  const root = fixture([start(0), written(0), start(10), written(10)]);
  try {
    const ten = run(root).metrics.interval_skipping.find((item) => item.interval_minutes === 10);
    assert.equal(ten.refreshes_skipped.count, 0);
  } finally {
    cleanup(root);
  }
});

test('a cut protects the written card from being counted as superseded', () => {
  const root = fixture([
    start(0), written(0),
    start(5), written(5),
    cut(7),
    start(10), written(10),
    start(15), written(15),
  ]);
  try {
    const metric = run(root).metrics.superseded_refreshes;
    assert.equal(metric.superseded_count, 2);
    assert.equal(metric.read_before_replacement.count, 0);
    assert.equal(metric.never_read_before_replacement.count, 2);
    assert.equal(metric.never_read_before_replacement.equivalents.sum, 120);
  } finally {
    cleanup(root);
  }
});

test('a failed refresh consumes its start and a failure without a start consumes nothing', () => {
  const root = fixture([
    failed(-2, 'error'),
    start(0, { ctx: 100 }), failed(1, 'no_reply'),
    start(2, { ctx: 200 }), written(3),
  ]);
  try {
    const report = run(root);
    assert.equal(report.written_refreshes, 1);
    assert.equal(report.cost_estimate.formula, '0.1 * ctx + 5 * size');
    assert.equal(report.metrics.failed_refreshes.count, 1);
    assert.equal(report.metrics.failed_refreshes.results.no_reply, 1);
    assert.equal(report.dropped.orphan_starts, 0);
    assert.equal(report.dropped.writes_without_start, 0);
  } finally {
    cleanup(root);
  }
});

test('--since filters starts and writes from interval history', () => {
  const root = fixture([
    start(0), written(0),
    start(20), written(20),
    start(40), written(40),
  ]);
  try {
    const report = run(root, '2026-10-10T00:30:00.000Z');
    assert.equal(report.metrics.interval_skipping[0].n_refreshes, 1);
    assert.equal(report.metrics.interval_skipping[0].refreshes_skipped.count, 0);
    assert.equal(report.metrics.gap_between_written_refreshes_minutes.normal.gap_minutes.n, 0);
    assert.equal(report.metrics.failed_refreshes.n_starts, 1);
  } finally {
    cleanup(root);
  }
});

test('--since excludes pre-since and straddling writes from counts and superseded', () => {
  const root = fixture([
    start(-20), written(-19),
    start(-5), written(2),
    start(5), written(6),
    start(10), written(11),
    cut(12),
  ]);
  try {
    const report = run(root, at(0));
    assert.equal(report.written_refreshes, 2);
    assert.equal(report.metrics.interval_skipping[0].n_refreshes, 2);
    assert.equal(report.metrics.superseded_refreshes.superseded_count, 1);
    assert.equal(report.metrics.superseded_refreshes.never_read_before_replacement.count, 1);
  } finally {
    cleanup(root);
  }
});

test('cut notice counts apply --since', () => {
  const root = fixture([cut(-2), cut(2)]);
  try {
    assert.equal(run(root, at(0)).cut_notice.observed_since, 1);
  } finally {
    cleanup(root);
  }
});

test('all three failure kinds are counted separately and filtered by --since', () => {
  const root = fixture([
    start(-3), failed(-2, 'error'),
    start(1), failed(2, 'unparsed'),
    start(3), failed(4, 'no_reply'),
    start(5), failed(6, 'error'),
  ]);
  try {
    const report = run(root, at(0));
    const failedMetric = report.metrics.failed_refreshes;
    assert.equal(failedMetric.n_starts, 3);
    assert.equal(failedMetric.count, 3);
    assert.deepEqual(failedMetric.results, { unparsed: 1, no_reply: 1, error: 1 });
  } finally {
    cleanup(root);
  }
});

test('written refresh gaps use the later refresh late flag with distinct gap sizes', () => {
  const root = fixture([
    start(0), written(0),
    start(5, { late: true }), written(5),
    start(20), written(20),
    start(30), written(30),
  ]);
  try {
    const gap = run(root).metrics.gap_between_written_refreshes_minutes;
    assert.equal(gap.normal.gap_minutes.n, 2);
    assert.equal(gap.normal.gap_minutes.median, 12.5);
    assert.equal(gap.late.gap_minutes.n, 1);
    assert.equal(gap.late.gap_minutes.median, 5);
  } finally {
    cleanup(root);
  }
});

test('late values other than 1 do not mark a refresh late', () => {
  const root = fixture([
    start(0, { late: 'late=10 calls=8' }), written(0),
    start(5), written(5),
  ]);
  try {
    const gap = run(root).metrics.gap_between_written_refreshes_minutes;
    assert.equal(gap.late.n_refreshes, 0);
    assert.equal(gap.normal.n_refreshes, 2);
    assert.equal(gap.normal.gap_minutes.median, 5);
  } finally {
    cleanup(root);
  }
});

test('a new start orphans an older pending start; later writes do not use it', () => {
  const root = fixture([
    start(0, { ctx: 100 }),
    start(1, { ctx: 200 }),
    written(2),
    written(3),
  ]);
  try {
    const report = run(root);
    assert.equal(report.written_refreshes, 1);
    assert.equal(report.dropped.orphan_starts, 1);
    assert.equal(report.dropped.writes_without_start, 1);
    assert.equal(report.dropped.count, 2);
    assert.equal(report.metrics.interval_skipping[0].n_refreshes, 1);
    assert.equal(report.metrics.interval_skipping[0].total_equivalents, 70);
  } finally {
    cleanup(root);
  }
});

test('events are paired in timestamp order even when file lines are out of order', () => {
  const root = fixture([
    written(3), start(2, { ctx: 200 }),
    written(1), start(0, { ctx: 100 }),
  ]);
  try {
    const report = run(root);
    assert.equal(report.written_refreshes, 2);
    assert.equal(report.dropped.orphan_starts, 0);
    assert.equal(report.dropped.writes_without_start, 0);
    assert.equal(report.metrics.interval_skipping[0].total_equivalents, 130);
  } finally {
    cleanup(root);
  }
});

test('a completed rule check counts as a read before replacement', () => {
  const root = fixture([
    start(0), written(0),
    `${at(1)} rule_check.fired=0 broken=0 units=4 ms=2`,
    start(2), written(2), cut(3),
  ]);
  try {
    const metric = run(root).metrics.superseded_refreshes;
    assert.equal(metric.read_before_replacement.count, 1);
    assert.equal(metric.read_before_replacement.reader_kinds.rule_check.count, 1);
    assert.equal(metric.read_before_replacement.equivalents.sum, 60);
  } finally {
    cleanup(root);
  }
});

test('a card acceptance check counts as a read before replacement', () => {
  const root = fixture([
    start(0), written(0),
    `${at(1)} brief_check.fired=1 source=card chars=90`,
    start(2), written(2), cut(3),
  ]);
  try {
    const metric = run(root).metrics.superseded_refreshes;
    assert.equal(metric.read_before_replacement.count, 1);
    assert.equal(metric.read_before_replacement.reader_kinds.card_check.count, 1);
  } finally {
    cleanup(root);
  }
});

test('an S4 seed counts as a read even when the seed falls back on budget', () => {
  const root = fixture([
    start(0), written(0),
    `${at(1)} seed.task_card=1 seed.task_card_size=90`,
    `${at(1.5)} compact.fallback=budget`,
    start(2), written(2), cut(3),
  ]);
  try {
    const metric = run(root).metrics.superseded_refreshes;
    assert.equal(metric.read_before_replacement.count, 1);
    assert.equal(metric.read_before_replacement.reader_kinds.s4_seed.count, 1);
  } finally {
    cleanup(root);
  }
});

test('a superseded card with no reader notice is counted as never read', () => {
  const root = fixture([
    start(0), written(0),
    `${at(1)} rule_check.fired=0 reason=card_stale`,
    `${at(1)} brief_check.fired=0 reason=not_ready`,
    `${at(1)} seed.task_card=0 seed.task_card_size=0`,
    start(2), written(2), cut(3),
  ]);
  try {
    const metric = run(root).metrics.superseded_refreshes;
    assert.equal(metric.read_before_replacement.count, 0);
    assert.equal(metric.never_read_before_replacement.count, 1);
    assert.equal(metric.never_read_before_replacement.percent_of_superseded_refreshes, 100);
    assert.equal(metric.never_read_before_replacement.equivalents.sum, 60);
  } finally {
    cleanup(root);
  }
});

test('reader kinds are reported individually and can overlap', () => {
  const root = fixture([
    start(0), written(0),
    `${at(0.5)} rule_check.fired=1 broken=1 units=4 ms=2`,
    `${at(0.6)} brief_check.fired=1 source=card chars=90`,
    `${at(0.7)} seed.task_card=1 seed.task_card_size=90`,
    start(2), written(2), cut(3),
  ]);
  try {
    const metric = run(root).metrics.superseded_refreshes;
    const read = metric.read_before_replacement;
    assert.equal(read.count, 1);
    assert.equal(read.reader_kinds.rule_check.count, 1);
    assert.equal(read.reader_kinds.card_check.count, 1);
    assert.equal(read.reader_kinds.s4_seed.count, 1);
    assert.equal(metric.reader_kind_counts_overlap, true);
  } finally {
    cleanup(root);
  }
});

test('text output names read and never-read groups and cites the cut summary source', () => {
  const root = fixture([
    start(0), written(0),
    `${at(1)} rule_check.fired=1 broken=1 units=4 ms=2`,
    start(2), written(2),
    start(3), written(3), cut(4),
  ]);
  try {
    const output = runText(root);
    assert.match(output, /Superseded, read before replacement:/);
    assert.match(output, /Superseded, never read before replacement:/);
    assert.match(output, /Skipping a refresh means the rule check and the next cut see an older card\./);
    assert.match(output, /plugin\/compact\/host\/notices\.ts:formatCutSummary/);
    assert.doesNotMatch(output, /Superseded:\s/);
  } finally {
    cleanup(root);
  }
});

test('dropped aggregates include orphan starts, writes without starts, and unparseable lines', () => {
  const root = fixture([
    start(0), start(1), written(2), written(3),
    `${at(4)} task_card.refresh=written size=bad`,
  ]);
  try {
    const dropped = run(root).dropped;
    assert.equal(dropped.orphan_starts, 1);
    assert.equal(dropped.writes_without_start, 1);
    assert.equal(dropped.unparseable_lines, 1);
    assert.equal(dropped.count, 3);
  } finally {
    cleanup(root);
  }
});

test('notices.log files at the 1500-line cap are counted', () => {
  const root = fixture(Array.from({ length: 1500 }, (_, index) => `${at(index)} session.notice=${index}`));
  try {
    const report = run(root);
    assert.equal(report.notices_line_cap, 1500);
    assert.equal(report.notices_files_at_line_cap, 1);
  } finally {
    cleanup(root);
  }
});

test('per-file read errors are counted without printing the file path', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'card-refresh-rate-'));
  const file = writeSession(root, 'secret-session-name', [start(0), written(1)]);
  try {
    fs.chmodSync(file, 0);
    let canReadModeZeroFile = true;
    try { fs.readFileSync(file); } catch { canReadModeZeroFile = false; }
    if (canReadModeZeroFile) {
      t.skip('the current user can still read mode-000 files');
      return;
    }
    const result = spawnSync(process.execPath, [script, '--root', root, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.file_read_errors, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /secret-session-name/);
  } finally {
    fs.chmodSync(file, 0o600);
    cleanup(root);
  }
});

test('JSON includes an ISO run time', () => {
  const root = fixture([start(0), written(1)]);
  try {
    assert.match(run(root).run_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  } finally {
    cleanup(root);
  }
});
