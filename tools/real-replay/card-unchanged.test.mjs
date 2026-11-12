import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = process.env.CARD_UNCHANGED_SCRIPT || path.join(import.meta.dirname, 'card-unchanged.mjs');
const BASE = Date.parse('2026-10-10T00:00:00.000Z');
const at = (minutes) => new Date(BASE + minutes * 60_000).toISOString();
const card = (goal, rules = 'Keep the checks') => `# Task card\n## Goal\n${goal}\n## Rules\n${rules}`;
const seed = (value) => `[[exovault:s4-seed:v1]]\n## Task card\n(Kept current by this session's model before the cut; file: /capture/session-fixture/task-card.md. The full task brief and the transcript stay on disk.)\n${value.split('\n').slice(1).map((line) => line.replace(/^## /, '### ')).join('\n')}\n## Other seed section\nnot part of the card`;
const writeEvent = (type, minute, extra = {}) => ({
  type,
  timestamp: at(minute),
  ...extra,
});
const seedEvents = (cards, cutMinutes) => cards.flatMap((value, index) => [
  writeEvent('system', cutMinutes[index], { subtype: 'compact_boundary' }),
  writeEvent('user', cutMinutes[index] + 0.001, { message: { content: seed(value) } }),
]);

function fixture({ refreshMinutes, cards = [], cutMinutes = [], extraEvents = [], noticeExtras = [] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'card-unchanged-'));
  const capture = path.join(root, 'capture');
  const projects = path.join(root, 'projects');
  const session = 'session-fixture';
  fs.mkdirSync(path.join(capture, session), { recursive: true });
  fs.mkdirSync(path.join(projects, 'project'), { recursive: true });
  const noticeLines = [];
  refreshMinutes.forEach((minute, index) => {
    noticeLines.push(`${at(minute)} task_card.refresh=start ctx=100 window=250000 n=${index + 1}`);
    noticeLines.push(`${at(minute + 0.01)} task_card.refresh=written size=10`);
  });
  for (const minute of cutMinutes) noticeLines.push(`${at(minute)} compacted 200k -> 10k tokens in 1.0 s`);
  noticeLines.push(...noticeExtras);
  noticeLines.sort((a, b) => Date.parse(a.slice(0, 24)) - Date.parse(b.slice(0, 24)));
  fs.writeFileSync(path.join(capture, session, 'notices.log'), `${noticeLines.join('\n')}\n`);
  const events = [...seedEvents(cards, cutMinutes.slice(0, cards.length)), ...extraEvents]
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  if (events.length) fs.writeFileSync(path.join(projects, 'project', `${session}.jsonl`), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  return { root, capture, projects, session };
}

function run(data, args = []) {
  const result = spawnSync(process.execPath, [script, '--root', data.projects, '--capture', data.capture, '--json', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function cleanup(data) {
  fs.rmSync(data.root, { recursive: true, force: true });
}

function fiveVersionFixture(extraEvents = []) {
  const cards = [card('A'), card('A'), card('B'), card('B'), card('C')];
  return fixture({
    refreshMinutes: [0, 10, 20, 30, 40],
    cards,
    cutMinutes: [1, 11, 21, 31, 41],
    extraEvents,
  });
}

test('whitespace-normalized card pairs count as identical', () => {
  const data = fixture({
    refreshMinutes: [0, 10],
    cards: [card('Keep this'), '#  Task card\n\n## Goal\nKeep   this\n\n## Rules\nKeep the checks'],
    cutMinutes: [1, 11],
  });
  try {
    const report = run(data);
    assert.equal(report.card_pairs.identical.count, 1);
    assert.equal(report.savings.exact_identity.refreshes_skipped, 1);
    assert.equal(report.savings.exact_identity.equivalents_saved, 60);
  } finally { cleanup(data); }
});

test('line-level changed-line share reports the changed line fraction', () => {
  const data = fixture({
    refreshMinutes: [0, 10],
    cards: ['# Task card\n## Goal\nKeep this\n## Rules\nCheck it', '# Task card\n## Goal\nChange this\n## Rules\nCheck it'],
    cutMinutes: [1, 11],
  });
  try {
    const report = run(data);
    assert.equal(report.card_pairs.line_change_share.n, 1);
    assert.equal(report.card_pairs.line_change_share.median, 0.2);
    assert.equal(report.savings.changed_line_thresholds['10%'].refreshes_skipped, 0);
    assert.equal(report.savings.changed_line_thresholds['20%'].refreshes_skipped, 1);
  } finally { cleanup(data); }
});

test('no-new-real-user predictor reports its 2x2 and saved equivalents', () => {
  const data = fiveVersionFixture([
    writeEvent('user', 22, { message: { content: 'A new user request.' } }),
    writeEvent('user', 32, { message: { content: 'Another user request.' } }),
  ]);
  try {
    const predictor = run(data).predictors.no_new_real_user;
    assert.deepEqual(predictor.confusion, { tp: 1, fp: 1, fn: 1, tn: 1 });
    assert.equal(predictor.precision, 0.5);
    assert.equal(predictor.recall, 0.5);
    assert.equal(predictor.n, 4);
    assert.equal(predictor.predicted_skip_equivalents, 120);
    assert.equal(predictor.fidelity_loss.count, 1);
  } finally { cleanup(data); }
});

test('no-edit-tool predictor reports its 2x2 and saved equivalents', () => {
  const editEvents = [22, 32].map((minute, index) => writeEvent('assistant', minute, {
    message: { model: 'test-model', content: [{ type: 'tool_use', id: `edit-${index}`, name: 'Edit', input: { file_path: 'x', old_string: 'a', new_string: 'b' } }] },
  }));
  const data = fiveVersionFixture(editEvents);
  try {
    const predictor = run(data).predictors.no_edit_tool;
    assert.deepEqual(predictor.confusion, { tp: 1, fp: 1, fn: 1, tn: 1 });
    assert.equal(predictor.precision, 0.5);
    assert.equal(predictor.recall, 0.5);
    assert.equal(predictor.n, 4);
    assert.equal(predictor.predicted_skip_equivalents, 120);
    assert.equal(predictor.fidelity_loss.count, 1);
  } finally { cleanup(data); }
});

test('no-git-commit predictor reports its 2x2 and saved equivalents', () => {
  const commitEvents = [22, 32].map((minute, index) => writeEvent('assistant', minute, {
    message: { model: 'test-model', content: [{ type: 'tool_use', id: `bash-${index}`, name: 'Bash', input: { command: 'git status && git commit -m test' } }] },
  }));
  const data = fiveVersionFixture(commitEvents);
  try {
    const predictor = run(data).predictors.no_git_commit;
    assert.deepEqual(predictor.confusion, { tp: 1, fp: 1, fn: 1, tn: 1 });
    assert.equal(predictor.precision, 0.5);
    assert.equal(predictor.recall, 0.5);
    assert.equal(predictor.n, 4);
    assert.equal(predictor.predicted_skip_equivalents, 120);
    assert.equal(predictor.fidelity_loss.count, 1);
  } finally { cleanup(data); }
});

test('fewer-than-N-tool-results predictor reports its 2x2 and saved equivalents', () => {
  const results = [22, 32].flatMap((minute, interval) => Array.from({ length: 10 }, (_, index) => writeEvent('user', minute + index / 100, {
    message: { content: [{ type: 'tool_result', tool_use_id: `result-${interval}-${index}`, content: 'ok' }] },
  })));
  const data = fiveVersionFixture(results);
  try {
    const report = run(data);
    const predictor = report.predictors.fewer_than_n_tool_results;
    assert.equal(report.predictor_parameters.tool_result_threshold_n, 10);
    assert.deepEqual(predictor.confusion, { tp: 1, fp: 1, fn: 1, tn: 1 });
    assert.equal(predictor.precision, 0.5);
    assert.equal(predictor.recall, 0.5);
    assert.equal(predictor.n, 4);
    assert.equal(predictor.predicted_skip_equivalents, 120);
    assert.equal(predictor.fidelity_loss.count, 1);
  } finally { cleanup(data); }
});

test('near-cut windows count assistant calls from notices and transcripts', () => {
  const calls = [1, 11, 12, 13, 14].map((minute, index) => writeEvent('assistant', minute, {
    message: { model: 'test-model', id: `call-${index}`, content: [{ type: 'text', text: 'Working.' }] },
  }));
  const data = fixture({
    refreshMinutes: [0, 10],
    cards: [card('A'), card('B')],
    cutMinutes: [2, 15],
    extraEvents: calls,
  });
  try {
    const metric = run(data).near_cut_coalescing;
    assert.equal(metric.n, 2);
    assert.equal(metric.within_1_assistant_calls.count, 1);
    assert.equal(metric.within_3_assistant_calls.count, 1);
    assert.equal(metric.within_5_assistant_calls.count, 2);
  } finally { cleanup(data); }
});

test('--since excludes earlier refresh rows', () => {
  const data = fixture({ refreshMinutes: [0, 10], cards: [card('A'), card('A')], cutMinutes: [1, 11] });
  try {
    const report = run(data, ['--since', '2026-10-10T00:05:00.000Z']);
    assert.equal(report.scope.written_refreshes, 1);
    assert.equal(report.card_pairs.n, 0);
  } finally { cleanup(data); }
});

test('--until excludes later refresh rows', () => {
  const data = fixture({ refreshMinutes: [0, 10], cards: [card('A'), card('A')], cutMinutes: [1, 11] });
  try {
    const report = run(data, ['--until', '2026-10-10T00:05:30.000Z']);
    assert.equal(report.scope.written_refreshes, 1);
    assert.equal(report.card_pairs.n, 0);
  } finally { cleanup(data); }
});

test('unparseable notice lines are counted', () => {
  const data = fixture({
    refreshMinutes: [0, 10],
    cards: [card('A'), card('A')],
    cutMinutes: [1, 11],
    noticeExtras: ['not-a-timestamp task_card.refresh=start ctx=nope'],
  });
  try {
    assert.equal(run(data).data_quality.unparseable_notice_lines, 1);
  } finally { cleanup(data); }
});

test('sessions without recoverable cards stay in coverage with zero pairs', () => {
  const data = fixture({ refreshMinutes: [0, 10] });
  try {
    const report = run(data);
    assert.equal(report.scope.sessions_with_refreshes, 1);
    assert.equal(report.scope.sessions_with_recoverable_cards, 0);
    assert.equal(report.scope.recoverable_refreshes, 0);
    assert.equal(report.card_pairs.n, 0);
  } finally { cleanup(data); }
});

test('fork replies take precedence over seed card versions', () => {
  const prompt = 'The conversation context will be compacted soon. Write the task card that the compacted context will keep.';
  const forkEvents = [0.02, 10.02].flatMap((minute) => [
    writeEvent('user', minute, { message: { content: prompt } }),
    writeEvent('assistant', minute + 0.001, { message: { model: 'test-model', content: card('Fork card') } }),
  ]);
  const data = fixture({
    refreshMinutes: [0, 10],
    cards: [card('Seed one'), card('Seed two')],
    cutMinutes: [1, 11],
    extraEvents: forkEvents,
  });
  try {
    const report = run(data);
    assert.equal(report.version_sources.selected.fork_reply_sessions, 1, JSON.stringify(report.version_sources));
    assert.equal(report.card_pairs.identical.count, 1);
    assert.equal(report.card_pairs.near_identical.count, 0);
  } finally { cleanup(data); }
});

test('M1-shrink-marker-detection counts seed text and notice markers', () => {
  const data = fixture({
    refreshMinutes: [0, 10],
    cards: [
      '# Task card\n## Goal\nKeep this\n(2 more lines in /capture/task-card.md)\n## Rules\nFollow this\n- (1 more lines cut)',
      '# Task card\n## Goal\nKeep that',
    ],
    cutMinutes: [1, 11],
    noticeExtras: [`${at(11.001)} seed.task_card_shrunk=90`],
  });
  try {
    const shrink = run(data).shrink_detection;
    assert.equal(shrink.recovered_cards, 2);
    assert.equal(shrink.shrunk_cards, 2);
    assert.deepEqual(shrink.detected_by_reason, {
      section_marker_cards: 1,
      notice_shrunk_cards: 1,
      notice_dropped_cards: 0,
    });
    assert.equal(shrink.pairs_with_any_shrunk_card, 1);
  } finally { cleanup(data); }
});

test('M2-section-diff-uses-only-lines-kept-by-both-versions', () => {
  const data = fixture({
    refreshMinutes: [0, 10],
    cards: [
      '# Task card\n## Goal\nKeep this\n- (2 more lines in /capture/task-card.md)\n## Rules\nFollow the checks',
      '# Task card\n## Goal\nKeep this\nAdded line one\nAdded line two\n## Rules\nFollow the checks',
    ],
    cutMinutes: [1, 11],
  });
  try {
    const goal = run(data).corrected_comparisons.per_section_common_kept_lines.Goal;
    assert.equal(goal.n, 1);
    assert.equal(goal.line_change_share.median, 0);
    assert.equal(goal.line_change_share.iqr, 0);
  } finally { cleanup(data); }
});

test('M4-first-line-character-similarity-distinguishes-rewording', () => {
  const data = fixture({
    refreshMinutes: [0, 10, 20],
    cards: [
      card('Keep exact output and verify every change.'),
      card('Keep exact output and verify every change!'),
      card('Start again from scratch.'),
    ],
    cutMinutes: [1, 11, 21],
  });
  try {
    const goal = run(data).corrected_comparisons.per_section_common_kept_lines.Goal;
    assert.equal(goal.common_kept_lines_per_pair.n, 2);
    assert.equal(goal.common_kept_lines_per_pair.median, 1);
    assert.equal(goal.common_kept_lines_per_pair.iqr, 0);
    assert.deepEqual(goal.single_line_comparison, { pairs: 2, share: 1 });
    assert.equal(goal.first_line_character_similarity.n, 2);
    assert.equal(goal.first_line_character_similarity.count_at_least_0_9, 1);
    assert.ok(goal.first_line_character_similarity.median < 0.9);
  } finally { cleanup(data); }
});

test('M3-refreshes-per-cut-stretch resets counts at each cut', () => {
  const data = fixture({
    refreshMinutes: [0, 2, 5, 7],
    cutMinutes: [3, 10],
  });
  try {
    const stretches = run(data).refreshes_per_cut_stretch;
    assert.equal(stretches.n, 2);
    assert.equal(stretches.refreshes_per_stretch.median, 2);
    assert.equal(stretches.refreshes_per_stretch.iqr, 0);
    assert.deepEqual(stretches.with_two_or_more_refreshes, { count: 2, percent: 100 });
    assert.equal(stretches.within_stretch_adjacent_pairs.count, 2);
  } finally { cleanup(data); }
});
