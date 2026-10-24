import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { extractCandidateItems, coverageContains, detectRereads, splitBoundaries, buildSeed } from './real-replay.mjs';

const fixture = path.join(import.meta.dirname, 'fixtures/synthetic.jsonl');
const synthetic = fs.readFileSync(fixture, 'utf8').trim().split('\n').map(JSON.parse);

test('extracts paths, backticked ids, numeric values, and quoted user phrases', () => {
  const found = extractCandidateItems(synthetic);
  for (const expected of ['src/harbor.ts', '4 seconds', 'blue lantern']) assert.ok(found.has(expected.toLowerCase()), expected);
});

test('coverage matching is verbatim and case-insensitive', () => {
  assert.equal(coverageContains('S4 uses RETRY_MS and src/Harbor.ts', 'src/harbor.ts'), true);
  assert.equal(coverageContains('unrelated details', 'RETRY'), false);
});

test('detects post-cut reads of pre-cut paths and joins tool result text', () => {
  const pre = synthetic.slice(0, 3);
  const post = synthetic.slice(4);
  assert.deepEqual(detectRereads(pre, post), [{ path: 'src/harbor.ts', result: 'export const RETRY_MS = 4000;' }]);
});

test('splits transcript at compaction boundaries', () => {
  assert.deepEqual(splitBoundaries(synthetic), [{ start: 3, end: 7 }]);
  const two = [...synthetic, { type: 'system', subtype: 'compact_boundary' }];
  assert.deepEqual(splitBoundaries(two), [{ start: 3, end: 7 }, { start: 7, end: 8 }]);
});

test('replays accumulated work events with transcript cwd', () => {
  const record = { kind: 'work_event', origin: 'reconcile', producedBy: 's4-capture', sourceHash: 'ws-1', body: { type: 'branch', name: 'feat/replay' } };
  const result = buildSeed([{ type: 'user', cwd: '/repo', message: { content: 'hello' } }], -1, 'manual', [record]);
  assert.match(result.text, /Directory: \/repo/);
  assert.match(result.text, /Branches: created feat\/replay in \/repo/);
});

test('replay records cwd transitions and uses the last pre-cut cwd as Directory', () => {
  const records = [
    { kind: 'work_event', sourceHash: 'snap-1', body: { type: 'cwd_snapshot', path: '/p' } },
    { kind: 'work_event', sourceHash: 'cd-sub', body: { type: 'cd', path: 'sub' } },
    { kind: 'work_event', sourceHash: 'snap-2', body: { type: 'cwd_snapshot', path: '/p/sub' } },
    { kind: 'work_event', sourceHash: 'wt', body: { type: 'worktree_add', path: '../wt', repo: '/srv/repo', branch: 'feat/x' } },
  ];
  const events = [{ type: 'user', cwd: '/p', message: { content: 'hello' } }, { type: 'assistant', cwd: '/p/sub', message: { content: 'working' } }];
  const result = buildSeed(events, -1, 'manual', records);
  assert.match(result.text, /Directory: \/p\/sub \(session started in \/p\)/);
  assert.match(result.text, /Worktrees: \/srv\/wt \[feat\/x\]/);
  assert.doesNotMatch(result.text, /\/p\/sub\/sub/);
});

test('replay folds queued task notifications from attachments and queue operations once per id/status', () => {
  const notice = (id, status, summary) => `<task-notification><task-id>${id}</task-id><status>${status}</status><summary>${summary}</summary></task-notification>`;
  const events = [
    { type: 'user', cwd: '/repo', message: { content: notice('job-a', 'completed', 'Done A') }, attachment: { type: 'queued_command', prompt: notice('job-a', 'completed', 'Duplicate A') } },
    { type: 'queue-operation', operation: 'enqueue', content: notice('job-a', 'completed', 'Duplicate A') },
    { type: 'queue-operation', operation: 'enqueue', content: notice('job-b', 'failed', 'Done B') },
  ];
  const records = [
    { kind: 'work_event', sourceHash: 'start-a', body: { type: 'bg_start', id: 'job-a', via: 'bash', label: 'Probe A' } },
    { kind: 'work_event', sourceHash: 'start-b', body: { type: 'bg_start', id: 'job-b', via: 'agent', label: 'Probe B' } },
  ];
  const result = buildSeed(events, -1, 'manual', records);
  assert.match(result.text, /Background: completed job-a "Probe A"; failed job-b "Probe B"/);
  assert.equal((result.text.match(/job-a/g) ?? []).length, 1);
});

test('REPLAY_DENSE_JEV_SCORES reranks dense notes and an absent score file preserves the baseline seed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dense-jev-replay-'));
  const dump = path.join(dir, 'candidates.jsonl');
  const scores = path.join(dir, 'scores.jsonl');
  const replayUrl = pathToFileURL(path.join(import.meta.dirname, 'real-replay.mjs')).href;
  const events = [
    { type: 'user', cwd: '/repo', message: { content: 'Continue the implementation and finish the remaining edits.' } },
    { type: 'assistant', message: { content: 'Read src/alpha.ts and kept --alpha-mode for item 417.' } },
    { type: 'assistant', message: { content: 'Read src/bravo.ts and kept --bravo-mode for item 829.' } },
    { type: 'user', message: { content: 'Proceed with the two remaining edits.' } },
  ];
  const run = (extraEnv = {}) => spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `const replay = await import(${JSON.stringify(replayUrl)}); const result = replay.buildSeed(${JSON.stringify(events)}, -1, 'manual'); console.log(result.text);`], { encoding: 'utf8', env: { ...process.env, REPLAY_TAIL_BUDGET: '1', ...extraEnv } });
  try {
    const baseline = run({ REPLAY_DENSE_JEV_DUMP: dump });
    assert.equal(baseline.status, 0, baseline.stderr);
    const cuts = fs.readFileSync(dump, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(cuts.length > 0);
    const rows = cuts.flatMap((cut) => cut.cands.map((candidate, i) => ({ q: cut.q, h: candidate.h, p: i === 0 ? 1 : 0.05 })));
    assert.ok(rows.length > 0);
    fs.writeFileSync(scores, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    const reranked = run({ REPLAY_DENSE_JEV_SCORES: scores });
    assert.equal(reranked.status, 0, reranked.stderr);
    assert.notEqual(reranked.stdout.trim(), baseline.stdout.trim());
    const noScoresAgain = run();
    assert.equal(noScoresAgain.status, 0, noScoresAgain.stderr);
    assert.equal(noScoresAgain.stdout.trim(), baseline.stdout.trim());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('REPLAY_WORK_STATE=0 omits the replay section', () => {
  const replayUrl = pathToFileURL(path.join(import.meta.dirname, 'real-replay.mjs')).href;
  const source = `const replay = await import(${JSON.stringify(replayUrl)}); const result = replay.buildSeed([{ type: 'user', cwd: '/repo', message: { content: 'hello' } }], -1, 'manual', [{ kind: 'work_event', sourceHash: 'ws-1', body: { type: 'branch', name: 'feat/replay' } }]); console.log(result.text);`;
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], { encoding: 'utf8', env: { ...process.env, REPLAY_WORK_STATE: '0' } });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /## Work state/);
});

// Fictional A/B eval transcripts (project "Harbor Relay"); they exist only on the machine that ran the eval.
const fictionalFixtures = [
  '/home/u/.claude/projects/-tmp-s4c-B133-0-Hxf0gr/337c73ac-b7e5-46ae-aa4e-eb4ffa6513a0.jsonl',
  '/home/u/.claude/projects/-tmp-s4c-A-R-0-cyURVL/658e5fde-1b0e-420b-95fb-ca54b73ac1b8.jsonl',
];
test('runs the replay over both named fictional transcripts', { skip: !fictionalFixtures.every((f) => fs.existsSync(f)) && 'fictional eval transcripts not present on this machine' }, () => {
    const fixtures = fictionalFixtures;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-replay-test-'));
  const report = path.join(dir, 'report.json');
  try {
    const run = spawnSync(process.execPath, ['--experimental-strip-types', path.join(import.meta.dirname, 'real-replay.mjs'), ...fixtures, '--out', report], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const data = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(data.files.length, 4);
    assert.equal(data.aggregate.boundaries, 4);
    assert.ok(data.files.every((row) => row.seedTokens > 0));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
