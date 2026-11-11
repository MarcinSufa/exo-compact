import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = path.join(import.meta.dirname, 'card-refresh-rate.mjs');
const base = Date.parse('2026-10-10T00:00:00.000Z');
const at = (minutes) => new Date(base + minutes * 60_000).toISOString();
const start = (minutes, { ctx = 100, late = false } = {}) => `${at(minutes)} task_card.refresh=start ctx=${ctx} window=250000 n=1${late ? ' late=1 calls=8' : ''}`;
const written = (minutes, size = 10) => `${at(minutes)} task_card.refresh=written size=${size}`;
const cut = (minutes) => `${at(minutes)} compacted 200k -> 10k tokens in 1.0 s`;

function fixture(lines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'card-refresh-rate-'));
  fs.mkdirSync(path.join(root, 'session-a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'session-a', 'notices.log'), `${lines.join('\n')}\n`);
  return root;
}

function run(root, since = '2026-10-01') {
  const result = spawnSync(process.execPath, [script, '--root', root, '--since', since, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
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
    fs.rmSync(root, { recursive: true, force: true });
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
    assert.equal(metric.count, 2);
    assert.equal(metric.percent, 50);
    assert.equal(metric.equivalents.sum, 120);
    assert.equal(metric.equivalents.percent, 50);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a started refresh without a written card stays out of write metrics', () => {
  const root = fixture([
    start(0),
    `${at(1)} task_card.refresh=no_reply reason=null`,
    start(2),
  ]);
  try {
    const report = run(root);
    assert.equal(report.metrics.failed_refreshes.n_starts, 2);
    assert.equal(report.metrics.failed_refreshes.count, 1);
    assert.equal(report.metrics.failed_refreshes.percent, 50);
    assert.equal(report.metrics.gap_between_written_refreshes_minutes.normal.n_refreshes, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--since excludes earlier refreshes from counts and interval history', () => {
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
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('written refresh gaps split by the later refresh late flag', () => {
  const root = fixture([
    start(0), written(0),
    start(10, { late: true }), written(10),
    start(20), written(20),
  ]);
  try {
    const gap = run(root).metrics.gap_between_written_refreshes_minutes;
    assert.equal(gap.normal.n_refreshes, 2);
    assert.equal(gap.normal.gap_minutes.n, 1);
    assert.equal(gap.normal.gap_minutes.median, 10);
    assert.equal(gap.late.n_refreshes, 1);
    assert.equal(gap.late.gap_minutes.n, 1);
    assert.equal(gap.late.gap_minutes.median, 10);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
