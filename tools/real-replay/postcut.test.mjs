import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { aggregatePostCuts, weightedUsage } from './postcut.mjs';

const script = path.join(import.meta.dirname, 'postcut.mjs');
const stamp = (day, second = 0) => `2026-10-${day}T12:00:${String(second).padStart(2, '0')}.000Z`;
const event = (type, extra = {}) => ({ type, ...extra });

function assistant(id, usage, at, model = 'claude-sonnet-5-5', content = [{ type: 'text', text: 'synthetic fixture' }]) {
  return event('assistant', { timestamp: at, message: { id, model, usage, content } });
}

function usage(input, write, read, output) {
  return { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output };
}

function boundary(at, preTokens = 205000, postTokens = 10000) {
  return event('system', {
    subtype: 'compact_boundary',
    timestamp: at,
    compactMetadata: { trigger: 'auto', preTokens, postTokens },
  });
}

function writeEvents(file, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${events.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

function writeCut(dir, name, kind, day, preTokens, postTokens, perCall, useIterations = false) {
  const events = [boundary(stamp(day), preTokens, postTokens)];
  events.push(event('user', {
    timestamp: stamp(day, 1),
    message: { content: kind === 's4' ? '[[exovault:s4-seed:v1]] fixture seed' : 'This session is being continued from a previous conversation.' },
    ...(kind === 'native' ? { isCompactSummary: true } : {}),
  }));
  // Transcript order can place the compaction-triggering response after the boundary even though
  // its timestamp predates the boundary. It is not a post-cut call.
  events.push(assistant(`${name}-precut`, usage(99999, 0, 0, 0), stamp(day)));
  const apiUsage = useIterations
    ? { ...usage(0, 0, 0, 0), iterations: [usage(...perCall)] }
    : usage(...perCall);
  events.push(assistant(`${name}-call-1`, apiUsage, stamp(day, 2)));
  // This duplicate has deliberately different usage so removing ID dedup changes the totals.
  if (useIterations) {
    const duplicateUsage = { ...usage(0, 0, 0, 0), iterations: [usage(900, 900, 900, 900)] };
    events.push(assistant(`${name}-call-1`, duplicateUsage, stamp(day, 2)));
  }
  for (let n = 2; n <= 20; n++) events.push(assistant(`${name}-call-${n}`, usage(...perCall), stamp(day, n)));
  writeEvents(path.join(dir, `${name}.jsonl`), events);
}

function analyze(root, reportPath, since = '2026-10-01') {
  return spawnSync(process.execPath, [script, '--since', since, '--json', reportPath, root], { encoding: 'utf8' });
}

test('cache writes use their TTL weights and fall back when splits are absent', () => {
  assert.equal(weightedUsage({
    input_tokens: 2,
    cache_creation_input_tokens: 100,
    cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 80 },
    cache_read_input_tokens: 10,
    output_tokens: 3,
  }), 203);
  assert.equal(weightedUsage({
    input_tokens: 2,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 10,
    output_tokens: 3,
  }), 143);
});

test('postcut reads TTL splits from transcript usage when iterations carry only aggregate writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postcut-ttl-'));
  const reportPath = path.join(root, 'aggregate.json');
  const usageWithSplit = {
    ...usage(0, 0, 0, 0),
    cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 80 },
    iterations: [usage(2, 100, 10, 3)],
  };
  writeEvents(path.join(root, 'ttl.jsonl'), [
    boundary(stamp('02')),
    event('user', { timestamp: stamp('02', 1), message: { content: '[[exovault:s4-seed:v1]] fixture' } }),
    assistant('ttl-call', usageWithSplit, stamp('02', 2)),
  ]);
  try {
    const run = analyze(root, reportPath);
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.cuts.s4.costByCalls['1'].median, 203);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('card-refresh allowance uses the native bound plus the native and exo medians at 1, 5, and 20 calls', () => {
  const cuts = [
    ...[0, 0, 10, 100].map((cost, index) => ({ kind: 's4', window: '200k', _session: `s4-${index}`, callCosts: Array(20).fill(cost) })),
    ...[0, 50, 100, 100].map((cost, index) => ({ kind: 'native', window: '200k', _session: `native-${index}`, callCosts: Array(20).fill(cost) })),
  ];
  const report = aggregatePostCuts(cuts, {
    nativeSummaryOutput: [],
    nativeSummaryLowerBounds: [40, 60],
  }, cuts.length, '2026-10-01');

  assert.deepEqual(report.breakEven.extraExoCutCostAllowanceByCalls, [
    { calls: 1, median: 120, n: { summaryBound: 2, native: 4, s4: 4 } },
    { calls: 5, median: 400, n: { summaryBound: 2, native: 4, s4: 4 } },
    { calls: 20, median: 1450, n: { summaryBound: 2, native: 4, s4: 4 } },
  ]);
});

test('allowance exceedance is strict and scoped to refreshed s4 cuts in notice-bearing sessions', () => {
  const proxyCuts = [
    ...[0, 0, 10, 100].map((cost, index) => ({ kind: 's4', window: '200k', _session: `s4-${index}`, callCosts: Array(20).fill(cost) })),
    ...[0, 50, 100, 100].map((cost, index) => ({ kind: 'native', window: '200k', _session: `native-${index}`, callCosts: Array(20).fill(cost) })),
  ];
  const refreshedEstimates = [119, 120, 121, 400, 401, 1450, 1451];
  const noticeSessionCuts = [
    ...refreshedEstimates.map((estimate) => ({
      kind: 's4', window: 'other', _session: 'notice-session', callCosts: [],
      cardRefreshCount: 1, cardRefreshEstimate: estimate,
    })),
    ...[0, 0].map(() => ({
      kind: 's4', window: 'other', _session: 'notice-session', callCosts: [],
      cardRefreshCount: 0, cardRefreshEstimate: 0,
    })),
    {
      kind: 'native', window: 'other', _session: 'notice-session', callCosts: [],
      cardRefreshCount: 1, cardRefreshEstimate: 10_000,
    },
    {
      kind: 's4', window: 'other', _session: 'session-without-notices', callCosts: [],
      cardRefreshCount: 0, cardRefreshEstimate: 0,
    },
  ];
  const report = aggregatePostCuts([...proxyCuts, ...noticeSessionCuts], {
    nativeSummaryOutput: [],
    nativeSummaryLowerBounds: [40, 60],
    cardRefreshNotices: [
      ...refreshedEstimates.map((estimate) => ({ session: 'notice-session', estimate })),
      { session: 'notice-session', estimate: 10_000 },
    ],
  }, proxyCuts.length + noticeSessionCuts.length, '2026-10-01');

  assert.equal(report.cardRefreshByCut.cutsInNoticeSessions, 9);
  assert.equal(report.cardRefreshByCut.cutsWithRecordedRefreshes, 7);
  assert.equal(report.cardRefreshByCut.refreshesAssignedToNativeCuts, 1);
  assert.deepEqual(report.cardRefreshByCut.allowanceExceedance, [
    { calls: 1, allowance: 120, n: 5, denominator: 7, share: 5 / 7 },
    { calls: 5, allowance: 400, n: 3, denominator: 7, share: 3 / 7 },
    { calls: 20, allowance: 1450, n: 1, denominator: 7, share: 1 / 7 },
  ]);
});

test('postcut comparison subtracts interpolated medians from unpaired cohorts', () => {
  const cuts = [
    ...[0, 0, 10, 100].map((cost, index) => ({ kind: 's4', window: '200k', _session: `s4-${index}`, callCosts: [cost] })),
    ...[0, 50, 100, 100].map((cost, index) => ({ kind: 'native', window: '200k', _session: `native-${index}`, callCosts: [cost] })),
  ];
  const report = aggregatePostCuts(cuts, {
    nativeSummaryOutput: [],
    nativeSummaryLowerBounds: [40, 60],
  }, cuts.length, '2026-10-01');
  const firstCall = report.breakEven.cumulativeMedianSavings[0];

  assert.equal(firstCall.s4.median, 5);
  assert.equal(firstCall.native.median, 75);
  assert.equal(firstCall.medianGap, 70);
  assert.notEqual(firstCall.medianGap, 25); // paired per-row gaps would give a different result.
  assert.equal(report.nativeSummaryLowerBound.median, 50);
});

test('recovery summaries preserve the upper median for even samples', () => {
  const report = aggregatePostCuts([], {
    nativeSummaryOutput: [],
    nativeSummaryLowerBounds: [],
  }, 0, '2026-10-01', [
    { kind: 'native', session: 'native-a', window: 1, seedTokens: 10, firstContext: 100, reachedWrite: true, userBeforeWrite: false, toFirstWrite: 2, activeSeconds: 20, cost: 30, pulledTokens: 40, reads: 1, readsNamed: 1, searches: 1, recalls: 0 },
    { kind: 'native', session: 'native-b', window: 1, seedTokens: 20, firstContext: 200, reachedWrite: true, userBeforeWrite: false, toFirstWrite: 4, activeSeconds: 40, cost: 60, pulledTokens: 80, reads: 2, readsNamed: 0, searches: 2, recalls: 0 },
  ]);

  assert.equal(report.recovery.native.all.seedTokens.median, 20);
  assert.equal(report.recovery.native.all.firstContext.median, 200);
  assert.equal(report.recovery.native.all.costTokens.median, 60);
});

test('card-refresh approximate estimate uses paired local context and written-size notices', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postcut-card-notices-'));
  const reportPath = path.join(root, 'aggregate.json');
  writeEvents(path.join(root, 'capture-notices.jsonl'), [
    boundary(stamp('10')),
    event('system', { subtype: 'informational', timestamp: stamp('10', 1), content: 'exo-compact: task_card.refresh=start ctx=10000 window=250000 n=1' }),
    event('system', { subtype: 'informational', timestamp: stamp('10', 2), content: 'exo-compact: task_card.refresh=written size=200' }),
  ]);
  try {
    const run = analyze(root, reportPath);
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.cardRefreshApproximateEstimate.n, 1);
    assert.equal(report.cardRefreshApproximateEstimate.median, 2000);
    assert.match(report.cardRefreshApproximateEstimate.source, /task_card\.refresh=start ctx.*task_card\.refresh=written size/);
    assert.match(report.cardRefreshApproximateEstimate.assumption, /not a strict lower bound/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed refresh notices clear the pending start before a later write', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postcut-card-failure-'));
  const reportPath = path.join(root, 'aggregate.json');
  writeEvents(path.join(root, 'capture-notices.jsonl'), [
    boundary(stamp('10')),
    event('system', { subtype: 'informational', timestamp: stamp('10', 1), content: 'exo-compact: task_card.refresh=start ctx=10000 window=250000 n=1' }),
    event('system', { subtype: 'informational', timestamp: stamp('10', 2), content: 'exo-compact: task_card.refresh=unparsed size=0' }),
    event('system', { subtype: 'informational', timestamp: stamp('10', 3), content: 'exo-compact: task_card.refresh=written size=200' }),
    event('system', { subtype: 'informational', timestamp: stamp('10', 4), content: 'exo-compact: task_card.refresh=start ctx=20000 window=250000 n=2' }),
    event('system', { subtype: 'informational', timestamp: stamp('10', 5), content: 'exo-compact: task_card.refresh=written size=200' }),
  ]);
  try {
    const run = analyze(root, reportPath);
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.cardRefreshApproximateEstimate.n, 1);
    assert.equal(report.cardRefreshApproximateEstimate.median, 3000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--since filters both the refresh start and written notice', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postcut-card-since-'));
  const reportPath = path.join(root, 'aggregate.json');
  writeEvents(path.join(root, 'capture-notices.jsonl'), [
    event('system', { subtype: 'informational', timestamp: '2026-09-30T23:59:59.000Z', content: 'exo-compact: task_card.refresh=start ctx=10000 window=250000 n=1' }),
    event('system', { subtype: 'informational', timestamp: '2026-10-01T00:00:01.000Z', content: 'exo-compact: task_card.refresh=written size=200' }),
    event('system', { subtype: 'informational', timestamp: '2026-10-01T00:00:02.000Z', content: 'exo-compact: task_card.refresh=start ctx=20000 window=250000 n=2' }),
    event('system', { subtype: 'informational', timestamp: '2026-10-01T00:00:03.000Z', content: 'exo-compact: task_card.refresh=written size=300' }),
    boundary('2026-10-01T00:00:04.000Z'),
  ]);
  try {
    const run = analyze(root, reportPath, '2026-10-01');
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.cardRefreshApproximateEstimate.n, 1);
    assert.equal(report.cardRefreshApproximateEstimate.median, 3500);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refreshes go to the next cut and a notice after the final boundary is unassigned', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postcut-card-sum-'));
  const reportPath = path.join(root, 'aggregate.json');
  writeEvents(path.join(root, 'parent.jsonl'), [
    boundary('2026-10-10T12:00:00.000Z'),
    event('user', { timestamp: '2026-10-10T12:00:01.000Z', message: { content: '[[exovault:s4-seed:v1]] first' } }),
    event('system', { subtype: 'informational', timestamp: '2026-10-10T12:00:10.000Z', content: 'exo-compact: task_card.refresh=start ctx=10000 window=250000 n=1' }),
    event('system', { subtype: 'informational', timestamp: '2026-10-10T12:00:11.000Z', content: 'exo-compact: task_card.refresh=written size=200' }),
    boundary('2026-10-10T12:01:00.000Z'),
    event('user', {
      timestamp: '2026-10-10T12:01:01.000Z',
      isCompactSummary: true,
      message: { content: 'This session is being continued from a previous conversation.' },
    }),
    event('system', { subtype: 'informational', timestamp: '2026-10-10T12:01:10.000Z', content: 'exo-compact: task_card.refresh=start ctx=20000 window=250000 n=2' }),
    event('system', { subtype: 'informational', timestamp: '2026-10-10T12:01:11.000Z', content: 'exo-compact: task_card.refresh=written size=200' }),
    boundary('2026-10-10T12:02:00.000Z'),
    event('user', { timestamp: '2026-10-10T12:02:01.000Z', message: { content: '[[exovault:s4-seed:v1]] third' } }),
    event('system', { subtype: 'informational', timestamp: '2026-10-10T12:02:10.000Z', content: 'exo-compact: task_card.refresh=start ctx=30000 window=250000 n=3' }),
    event('system', { subtype: 'informational', timestamp: '2026-10-10T12:02:11.000Z', content: 'exo-compact: task_card.refresh=written size=200' }),
  ]);
  try {
    const run = analyze(root, reportPath);
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.cardRefreshApproximateEstimate.n, 3);
    assert.equal(report.cardRefreshApproximateEstimate.sessionsWithNotices, 1);
    assert.equal(report.cardRefreshByCut.cutsInNoticeSessions, 2);
    assert.equal(report.cardRefreshByCut.cutsWithRecordedRefreshes, 1);
    assert.equal(report.cardRefreshByCut.refreshesAssignedToNativeCuts, 1);
    assert.deepEqual(report.cardRefreshByCut.refreshesPerCut, {
      n: 2, median: 0.5, q1: 0.25, q3: 0.75, min: 0, max: 1,
    });
    assert.deepEqual(report.cardRefreshByCut.approximateEstimatePerCut, {
      n: 2, median: 1500, q1: 750, q3: 2250, min: 0, max: 3000,
    });
    assert.deepEqual(report.cardRefreshByCut.approximateEstimatePerRefreshedCut, {
      n: 1, median: 3000, q1: 3000, q3: 3000, min: 3000, max: 3000,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('first post-cut assistant call must not predate the injected message', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postcut-injection-time-'));
  const reportPath = path.join(root, 'aggregate.json');
  writeEvents(path.join(root, 'seed-cut.jsonl'), [
    boundary(stamp('10')),
    event('user', { timestamp: stamp('10', 2), message: { content: '[[exovault:s4-seed:v1]] fixture' } }),
    assistant('before-injection', usage(900, 800, 700, 600), stamp('10', 1)),
    assistant('after-injection', usage(10, 20, 30, 4), stamp('10', 3)),
  ]);
  try {
    const run = analyze(root, reportPath);
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.cuts.s4.firstContext.median, 60);
    assert.equal(report.cuts.s4.costByCalls['1'].median, 58);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('postcut reports aggregate usage, metadata, window costs, and no transcript-derived card cost', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postcut-fixture-'));
  const children = path.join(root, 'subagents');
  fs.mkdirSync(children);
  writeCut(root, 'fixture-s4-a', 's4', '03', 198000, 8000, [2, 100, 1000, 10], true);
  writeCut(root, 'fixture-s4-b', 's4', '04', 210000, 9000, [1, 200, 900, 2]);
  writeCut(root, 'fixture-native-a', 'native', '05', 205000, 18000, [10, 80, 500, 20]);
  writeCut(root, 'fixture-native-b', 'native', '06', 220000, 20000, [100, 200, 1000, 10]);

  const prompt = 'The conversation context will be compacted soon. Write the task card that the compacted context will keep.';
  writeEvents(path.join(children, 'fixture-card-refresh.jsonl'), [
    event('user', {
      timestamp: stamp('03', 9),
      message: { content: [{ type: 'tool_result', tool_use_id: 'read-source', content: prompt }] },
    }),
    assistant('card-fork-call-1', usage(100, 200, 300, 40), stamp('03', 10)),
    assistant('card-fork-call-2', usage(100, 200, 300, 40), stamp('03', 11)),
  ]);

  const reportPath = path.join(root, 'aggregate.json');
  try {
    const run = analyze(root, reportPath);
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

    assert.equal(report.cuts.s4.n, 2);
    assert.equal(report.cuts.native.n, 2);
    assert.deepEqual(report.cuts.s4.firstContext, { n: 2, median: 1101.5, q1: 1101.25, q3: 1101.75, min: 1101, max: 1102 });
    assert.equal(report.cuts.s4.costByCalls['1'].median, 314);
    assert.equal(report.cuts.s4.costByCalls['5'].median, 1570);
    assert.equal(report.cuts.s4.costByCalls['20'].median, 6280);
    assert.equal(report.cuts.native.costByCalls['1'].median, 380);
    assert.equal(report.cuts.native.costByCalls['5'].median, 1900);
    assert.equal(report.cuts.native.costByCalls['20'].median, 7600);
    assert.equal(report.cuts.s4.preTokens.n, 2);
    assert.equal(report.cuts.native.postTokens.n, 2);
    assert.equal(report.windows['200k'].s4.n, 2);
    assert.equal(report.windows['200k'].native.n, 2);
    assert.equal(report.windows['1M'].s4.n, 0);
    assert.equal(report.breakEven.cumulativeMedianSavings.length, 20);
    assert.equal('cutCosts' in report, false);

    const output = `${run.stdout}\n${fs.readFileSync(reportPath, 'utf8')}`;
    assert.doesNotMatch(output, /fixture-s4|fixture-native|fixture-card-refresh|postcut-fixture-/);
    assert.doesNotMatch(output, /synthetic fixture|The conversation context|card-refresh fork cost/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retained pre-boundary records are excluded from post-cut and recovery metrics', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postcut-boundary-'));
  const reportPath = path.join(root, 'aggregate.json');
  const cutAt = '2026-10-07T12:00:00.000Z';
  const events = [
    boundary(cutAt),
    event('user', {
      timestamp: '2026-10-07T11:59:30.000Z',
      isCompactSummary: true,
      message: { content: 'Retained summary text.' },
    }),
    assistant('retained-precut', {
      ...usage(0, 0, 0, 0),
      iterations: [usage(99999, 90000, 80000, 70000)],
    }, '2026-10-07T11:59:50.000Z', 'claude-sonnet-5-5', [
      { type: 'tool_use', id: 'retained-read', name: 'Read', input: { file_path: '/retained.mjs' } },
    ]),
    assistant('valid-postcut', { ...usage(0, 0, 0, 0), iterations: [usage(2, 100, 1000, 10)] }, '2026-10-07T12:00:01.000Z'),
  ];
  writeEvents(path.join(root, 'native.jsonl'), events);
  try {
    const run = analyze(root, reportPath);
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.cuts.native.n, 1);
    assert.equal(report.cuts.native.firstContext.median, 1102);
    assert.equal(report.cuts.native.costByCalls['1'].median, 277);
    assert.equal(report.recovery.native.all.n, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recovery metrics include injected tool-result text when matching reads to the seed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postcut-recovery-'));
  const reportPath = path.join(root, 'aggregate.json');
  const target = '/repo/src/recovery-target.mjs';
  const summary = 'Please continue the previous task.';
  const toolResult = `The retained context named ${target}.`;
  const events = [
    boundary(stamp('08')),
    event('user', { timestamp: stamp('08', 1), isCompactSummary: true, message: { content: summary } }),
    event('user', {
      timestamp: '2026-10-08T12:00:01.500Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'read-target', content: toolResult }] },
    }),
    assistant('recovery-read', usage(10, 20, 30, 4), '2026-10-08T12:00:04.000Z', 'claude-sonnet-5-5', [
      { type: 'tool_use', id: 'read-target', name: 'Read', input: { file_path: target } },
    ]),
  ];
  writeEvents(path.join(root, 'native-recovery.jsonl'), events);
  try {
    const run = analyze(root, reportPath);
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const recovery = report.recovery.native.all;
    assert.equal(recovery.n, 1);
    assert.equal(recovery.seedTokens.median, Math.ceil(`${summary}\n${toolResult}`.length / 4));
    assert.equal(recovery.namedReadPercent, 100);
    assert.equal(recovery.costTokens.median, 58);
    assert.equal(report.nativeSummaryOutputTokensEstimate.n, 1);
    assert.equal(report.nativeSummaryOutputTokensEstimate.median, Math.ceil(summary.length / 4));
    assert.equal(report.nativeSummaryLowerBound.n, 1);
    assert.equal(report.nativeSummaryLowerBound.median, 0.1 * 205000 + 5 * Math.ceil(summary.length / 4));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--since excludes earlier boundaries in the same transcript', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postcut-since-'));
  const reportPath = path.join(root, 'aggregate.json');
  const events = [
    boundary('2026-09-30T23:59:59.000Z', 200000, 8000),
    event('user', { timestamp: '2026-09-30T23:59:59.500Z', message: { content: '[[exovault:s4-seed:v1]] old' } }),
    assistant('old-call', usage(1, 2, 3, 4), '2026-09-30T23:59:59.750Z'),
    boundary('2026-10-01T00:00:00.000Z', 205000, 9000),
    event('user', { timestamp: '2026-10-01T00:00:00.500Z', message: { content: '[[exovault:s4-seed:v1]] new' } }),
    assistant('new-call', usage(2, 3, 4, 5), '2026-10-01T00:00:01.000Z'),
  ];
  writeEvents(path.join(root, 'two-cuts.jsonl'), events);
  try {
    const run = analyze(root, reportPath);
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.cuts.s4.n, 1);
    assert.equal(report.cuts.s4.preTokens.median, 205000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('subagent transcript boundaries are excluded from cut samples', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postcut-subagent-'));
  const reportPath = path.join(root, 'aggregate.json');
  const makeSeedCut = (name, at) => [
    boundary(at),
    event('user', { timestamp: new Date(Date.parse(at) + 1000).toISOString(), message: { content: '[[exovault:s4-seed:v1]] fixture' } }),
    assistant(`${name}-call`, usage(2, 3, 4, 5), new Date(Date.parse(at) + 2000).toISOString()),
  ];
  writeEvents(path.join(root, 'parent.jsonl'), makeSeedCut('parent', '2026-10-09T12:00:00.000Z'));
  writeEvents(path.join(root, 'subagents', 'worker.jsonl'), makeSeedCut('worker', '2026-10-09T12:10:00.000Z'));
  try {
    const run = analyze(root, reportPath);
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.transcriptsScanned, 2);
    assert.equal(report.cuts.s4.n, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
