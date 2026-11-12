import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
// @ts-expect-error plain ESM module without types
import * as doctor from '../doctor.mjs';

const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const WINDOW = 7 * 24 * 60 * 60 * 1000;

function captureRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'exo-doctor-hooks-'));
}

function writeNotice(root: string, session: string, notices: string[], mtime = NOW, timestamps: string[] = []) {
  const dir = path.join(root, session);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'notices.log');
  fs.writeFileSync(file, notices.map((notice, index) => `${timestamps[index] ?? '2026-11-12T11:59:00.000Z'} ${notice}`).join('\n') + '\n');
  fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

async function hooks(root: string, installedVersion = '2.1.300') {
  const result = await doctor.runDoctor({
    env: {},
    nodeVersion: '22.23.2',
    claudeVersion: async () => `${installedVersion} (Claude Code)`,
    fileExists: () => true,
    fetch: async () => ({ status: 200, ok: true, text: async () => '{"model":"jev-1","answers":{}}' }),
    jev: false,
    pluginRoot: '/private-plugin-path',
    captureRoot: root,
    now: () => NOW,
  });
  return {
    row: result.checks.find((check: { id: string }) => check.id === 'hooks'),
    report: doctor.formatReport(result),
    exitCode: doctor.exitCode(result),
  };
}

describe('doctor hook health', () => {
  it('[M1 seed-cut-classified-as-fallback] a recent seed cut is ok', async () => {
    const root = captureRoot();
    writeNotice(root, 'session-a', ['compacted 218k -> 45k tokens in 0.4 s']);
    const result = await hooks(root);
    assert.equal(result.row.status, 'ok');
    assert.match(result.row.message, /seed cuts=1/);
    assert.match(result.row.message, /native fallbacks=0/);
    assert.match(result.row.message, /version comparison unavailable/i);
  });

  it('[M2 fallback-cut-missed] all recent cuts fell back, with reasons', async () => {
    const root = captureRoot();
    writeNotice(root, 'session-b', [
      'compact.fallback=budget origin=compact',
      'compact.fallback=budget origin=compact',
    ]);
    const result = await hooks(root);
    assert.equal(result.row.status, 'warn');
    assert.equal(result.exitCode, 0);
    assert.match(result.row.message, /native fallbacks=2 \(budget=2\)/);
  });

  it('[M3-error-share-not-warned] error notices above five percent warn by kind', async () => {
    const root = captureRoot();
    writeNotice(root, 'session-c', [
      'compacted 218k -> 45k tokens in 0.4 s',
      'task_card.refresh=no_reply reason=error',
      'seed.work_state_probe=error',
      'seed.current_values=0',
      'seed.current_values=0',
      'seed.current_values=0',
      'seed.current_values=0',
      'seed.current_values=0',
      'seed.current_values=0',
      'seed.current_values=0',
      'seed.current_values=0',
    ]);
    const result = await hooks(root);
    assert.equal(result.row.status, 'warn');
    assert.match(result.row.message, /error notices=2\/11 \(18\.2%, warn above 5%; by kind:/);
    assert.match(result.row.message, /task_card\.refresh=1/);
    assert.match(result.row.message, /seed\.work_state_probe=1/);
  });

  it('[M4-empty-capture-is-failure] a missing capture directory is ok and says no sessions yet', async () => {
    const root = path.join(os.tmpdir(), 'exo-doctor-hooks-missing');
    const result = await hooks(root);
    assert.equal(result.row.status, 'ok');
    assert.match(result.row.message, /no sessions yet/i);
    assert.equal(result.exitCode, 0);
  });

  it('[M5-old-notices-enter-window] logs older than seven days are ignored', async () => {
    const root = captureRoot();
    const old = NOW - WINDOW - 1000;
    writeNotice(root, 'old-session', [
      'compact.fallback=budget origin=compact',
      'task_card.refresh=no_reply reason=error',
    ], old);
    const result = await hooks(root);
    assert.equal(result.row.status, 'ok');
    assert.match(result.row.message, /no sessions yet/i);
    assert.doesNotMatch(result.row.message, /budget|task_card/);
  });

  it('[M6-capture-file-cap-ignored] only the 50 newest notice files count', async () => {
    const root = captureRoot();
    for (let index = 0; index < 51; index += 1) {
      const notice = index === 50
        ? 'compact.fallback=budget origin=compact'
        : 'compacted 218k -> 45k tokens in 0.4 s';
      writeNotice(root, `session-${index}`, [notice], NOW - index * 1000);
    }
    const result = await hooks(root);
    assert.equal(result.row.status, 'ok');
    assert.match(result.row.message, /seed cuts=50/);
    assert.match(result.row.message, /native fallbacks=0/);
  });

  it('[M7-whole-log-read] only each log tail is considered', async () => {
    const root = captureRoot();
    const oldError = 'task_card.refresh=no_reply reason=error';
    const tail = Array.from({ length: 1500 }, () => 'seed.current_values=0');
    writeNotice(root, 'session-tail', [oldError, ...tail, 'compacted 218k -> 45k tokens in 0.4 s']);
    const result = await hooks(root);
    assert.equal(result.row.status, 'ok');
    assert.match(result.row.message, /seed cuts=1/);
    assert.match(result.row.message, /error notices=0\//);
  });

  it('[M8-sensitive-capture-details-printed] report does not print paths, ids, or notice text', async () => {
    const root = path.join(captureRoot(), 'private-capture-root');
    writeNotice(root, 'private-session-id', [
      'compacted 218k -> 45k tokens in 0.4 s',
      'compact.fallback=private-session-id origin=compact',
      'agent.compaction_pressure=0 agent=private-notice-text',
    ]);
    const result = await hooks(root);
    assert.equal(result.row.status, 'ok');
    assert.match(result.row.message, /native fallbacks=1 \(other=1\)/);
    for (const secret of [root, 'private-capture-root', 'private-session-id', 'private-notice-text', '/private-plugin-path']) {
      assert.equal(result.report.includes(secret), false, `doctor report exposed ${secret}`);
    }
  });

  it('[M9-error-count-positive-warns] a 4.8% error share stays ok; the rule is warn above 5%', async () => {
    const root = captureRoot();
    writeNotice(root, 'below-five-percent', [
      'task_card.refresh=no_reply reason=error',
      ...Array.from({ length: 20 }, () => 'seed.current_values=0'),
    ]);
    const result = await hooks(root);
    assert.equal(result.row.status, 'ok');
    assert.match(result.row.message, /error notices=1\/21 \(4\.8%, warn above 5%;/);
  });

  it('[M10-error-share-cutoff-inclusive] an exact 5% error share stays ok because warnings are above 5%', async () => {
    const root = captureRoot();
    writeNotice(root, 'exactly-five-percent', [
      'task_card.refresh=no_reply reason=error',
      ...Array.from({ length: 19 }, () => 'seed.current_values=0'),
    ]);
    const result = await hooks(root);
    assert.equal(result.row.status, 'ok');
    assert.match(result.row.message, /error notices=1\/20 \(5%, warn above 5%;/);
  });

  it('[M11-error-share-threshold-raised] a 5.1% error share warns', async () => {
    const root = captureRoot();
    writeNotice(root, 'above-five-percent', [
      'task_card.refresh=no_reply reason=error',
      'task_card.refresh=no_reply reason=error',
      ...Array.from({ length: 37 }, () => 'seed.current_values=0'),
    ]);
    const result = await hooks(root);
    assert.equal(result.row.status, 'warn');
    assert.match(result.row.message, /error notices=2\/39 \(5\.1%, warn above 5%;/);
  });

  it('[M12-any-fallback-warns] a seed cut means many native fallbacks do not warn by themselves', async () => {
    const root = captureRoot();
    writeNotice(root, 'cut-and-fallbacks', [
      'compacted 218k -> 45k tokens in 0.4 s',
      ...Array.from({ length: 20 }, () => 'compact.fallback=budget origin=compact'),
    ]);
    const result = await hooks(root);
    assert.equal(result.row.status, 'ok');
    assert.match(result.row.message, /seed cuts=1/);
    assert.match(result.row.message, /native fallbacks=20/);
  });

  it('[M13-no-cut-without-fallback-omits-state] other notices with no cuts or fallbacks say no cuts in window and stay ok', async () => {
    const root = captureRoot();
    writeNotice(root, 'notices-with-no-cuts', ['seed.current_values=0', 'agent.compaction_pressure=0']);
    const result = await hooks(root);
    assert.equal(result.row.status, 'ok');
    assert.match(result.row.message, /seed cuts=0 \(no cuts in window\)/);
    assert.match(result.row.message, /native fallbacks=0/);
  });

  it('[M14-window-includes-6_9-days] a notice file 6.9 days old remains in the seven-day window', async () => {
    const root = captureRoot();
    writeNotice(root, 'inside-window', ['compacted 218k -> 45k tokens in 0.4 s'], NOW - 6.9 * 24 * 60 * 60 * 1000);
    const result = await hooks(root);
    assert.equal(result.row.status, 'ok');
    assert.match(result.row.message, /seed cuts=1/);
  });

  it('[M15-window-excludes-7_1-days] a notice file 7.1 days old is outside the seven-day window', async () => {
    const root = captureRoot();
    writeNotice(root, 'outside-window', ['compact.fallback=budget origin=compact'], NOW - 7.1 * 24 * 60 * 60 * 1000);
    const result = await hooks(root);
    assert.equal(result.row.status, 'ok');
    assert.match(result.row.message, /no sessions yet/);
    assert.doesNotMatch(result.row.message, /budget/);
  });

  it('[M25-notice-timestamps-filtered-within-recent-file] old notices in a recent file do not affect cuts, fallbacks, or error share', async () => {
    const root = captureRoot();
    const oldTimestamp = new Date(NOW - WINDOW - 0.1 * 24 * 60 * 60 * 1000).toISOString();
    const insideTimestamp = new Date(NOW - WINDOW + 0.1 * 24 * 60 * 60 * 1000).toISOString();
    writeNotice(root, 'recent-file-with-old-notices', [
      'compacted 218k -> 45k tokens in 0.4 s',
      'compact.fallback=budget origin=compact',
      'task_card.refresh=no_reply reason=error',
      'seed.current_values=0',
    ], NOW, [oldTimestamp, oldTimestamp, oldTimestamp, insideTimestamp]);
    const result = await hooks(root);
    assert.equal(result.row.status, 'ok');
    assert.match(result.row.message, /seed cuts=0 \(no cuts in window\)/);
    assert.match(result.row.message, /native fallbacks=0 \(none\)/);
    assert.match(result.row.message, /error notices=0\/1 \(0%, warn above 5%; by kind: none\)/);
  });

  it('[M16-file-cap-drops-50th] all 50 files at the cap are inspected', async () => {
    const root = captureRoot();
    for (let index = 0; index < 50; index += 1) {
      writeNotice(root, `cap-${index}`, ['compacted 218k -> 45k tokens in 0.4 s'], NOW - index * 1000);
    }
    const result = await hooks(root);
    assert.equal(result.row.status, 'ok');
    assert.match(result.row.message, /seed cuts=50/);
  });

  it('[M17-file-cap-includes-51st] the 51st newest file is excluded', async () => {
    const root = captureRoot();
    for (let index = 0; index < 51; index += 1) {
      writeNotice(root, `cap-${index}`, [index === 50 ? 'compact.fallback=budget origin=compact' : 'compacted 218k -> 45k tokens in 0.4 s'], NOW - index * 1000);
    }
    const result = await hooks(root);
    assert.equal(result.row.status, 'ok');
    assert.match(result.row.message, /seed cuts=50/);
    assert.match(result.row.message, /native fallbacks=0/);
  });

  it('[M18-latest-version-without-cut-counts] a newer installed version without a seed cut warns against the newest cut version', async () => {
    const root = captureRoot();
    writeNotice(root, 'seed-version', [
      'claude_code.version=2.1.300',
      'compacted 218k -> 45k tokens in 0.4 s',
    ]);
    writeNotice(root, 'version-without-cut', ['claude_code.version=2.1.301']);
    const result = await hooks(root, '2.1.301');
    assert.equal(result.row.status, 'warn');
    assert.match(result.row.message, /Claude Code 2\.1\.301 has no seed cut yet; run one \/compact and check \(newest seed cut: 2\.1\.300\)/);
  });

  it('[M19-equal-version-warns] an installed version with a seed cut stays ok', async () => {
    const root = captureRoot();
    writeNotice(root, 'same-version', [
      'claude_code.version=2.1.300',
      'compacted 218k -> 45k tokens in 0.4 s',
    ]);
    const result = await hooks(root, '2.1.300');
    assert.equal(result.row.status, 'ok');
    assert.match(result.row.message, /installed=2\.1\.300, newest with seed cut=2\.1\.300/);
  });

  it('[M22-version-timestamp-clipped] uses a session version recorded over seven days ago when its file has a recent seed cut', async () => {
    const root = captureRoot();
    writeNotice(root, 'long-session', [
      'claude_code.version=2.1.300',
      'compacted 218k -> 45k tokens in 0.4 s',
    ], NOW, ['2026-11-04T11:00:00.000Z', '2026-11-12T11:59:00.000Z']);
    const result = await hooks(root, '2.1.301');
    assert.equal(result.row.status, 'warn');
    assert.match(result.row.message, /Claude Code 2\.1\.301 has no seed cut yet/);
  });

  it('[M24-per-file-last-version-credited-to-old-cut] a cut before an upgrade stays credited to the earlier version', async () => {
    const root = captureRoot();
    writeNotice(root, 'resumed-session', [
      'claude_code.version=2.1.300',
      'compacted 218k -> 45k tokens in 0.4 s',
      'claude_code.version=2.1.301',
    ]);
    const result = await hooks(root, '2.1.301');
    assert.equal(result.row.status, 'warn');
    assert.match(result.row.message, /Claude Code 2\.1\.301 has no seed cut yet; run one \/compact and check \(newest seed cut: 2\.1\.300\)/);
  });
});
