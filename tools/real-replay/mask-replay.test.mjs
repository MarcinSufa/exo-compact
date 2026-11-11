import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { weightedUsage } from './postcut.mjs';

const script = process.env.MASK_REPLAY_SCRIPT ?? path.join(import.meta.dirname, 'mask-replay.mjs');
const placeholder = '[Earlier tool output masked.]';
const baseTime = (day, seconds = 0) => new Date(Date.parse(`2026-10-${day}T10:00:00.000Z`) + seconds * 1000).toISOString();
const usage = (input, write = 0, read = 0, output = 0) => ({
  input_tokens: input,
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read,
  output_tokens: output,
});
const event = (type, extra = {}) => ({ type, ...extra });

function assistant(id, day, seconds, callUsage, content = [{ type: 'text', text: 'call' }]) {
  return event('assistant', {
    timestamp: baseTime(day, seconds),
    message: { id, model: 'claude-sonnet-5-5', usage: callUsage, content },
  });
}

function user(content, day, seconds) {
  return event('user', { timestamp: baseTime(day, seconds), message: { content } });
}

function resultEvents(id, name, text, day, seconds) {
  return [
    assistant(`tool-${id}`, day, seconds, usage(100 + seconds, 0, 0, 0), [
      { type: 'tool_use', id, name, input: name === 'Read' ? { file_path: `/repo/file-${id}.js` } : {} },
    ]),
    user([{ type: 'tool_result', tool_use_id: id, content: text }], day, seconds + 1),
  ];
}

function estimateContext(events) {
  let chars = 0;
  for (const row of events) {
    if (row.type !== 'assistant' && row.type !== 'user') continue;
    const content = row.message?.content;
    chars += typeof content === 'string' ? content.length : JSON.stringify(content ?? '').length;
  }
  return Math.ceil(chars / 4);
}

function transcript(day = '02', { toolCount = 7, callsBefore = 20, resultAfterCut = false, kind = 's4', preTokens = 200_000, postCutCalls = 20 } = {}) {
  const before = [user('work request', day, 1)];
  for (let index = 0; index < toolCount; index++) {
    const name = index < 2 || index === toolCount - 1 ? 'Read' : 'Bash';
    before.push(...resultEvents(`r${index}`, name, String(index).repeat(400), day, 10 + index * 3));
  }
  for (let index = 0; index < callsBefore; index++) {
    before.push(assistant(`before-${index}`, day, 100 + index, usage(1_000 + index * 10), [{ type: 'text', text: 'work' }]));
  }
  const finalPriorCall = assistant('last-before-cut', day, 130, usage(0), [{ type: 'text', text: 'last prior call' }]);
  before.push(finalPriorCall);
  finalPriorCall.message.usage.input_tokens = estimateContext(before);

  const boundary = event('system', {
    subtype: 'compact_boundary',
    timestamp: baseTime(day, 600),
    compactMetadata: { preTokens: preTokens === 'estimate' ? estimateContext(before) : preTokens, postTokens: 10_000, trigger: 'auto' },
  });
  const injection = kind === 's4'
    ? '[[exovault:s4-seed:v1]] compacted state'
    : 'This session is being continued from a previous conversation.';
  const after = [user(injection, day, 601)];
  if (resultAfterCut) after.push(...resultEvents('after-cut', 'Glob', 'late result '.repeat(80), day, 602));
  for (let index = 0; index < postCutCalls; index++) {
    after.push(assistant(`after-${index}`, day, 610 + index, usage(10, 20, 30, 4)));
  }
  return { events: [...before, boundary, ...after], before, boundary };
}

function writeTranscript(file, rows, malformed = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = rows.map((row) => JSON.stringify(row));
  if (malformed) lines.splice(1, 0, '{not json');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

function runReport(root, args = []) {
  const reportPath = path.join(root, 'aggregate.json');
  const result = spawnSync(process.execPath, [script, '--root', root, '--since', '2026-10-01', '--until', '2026-10-31', '--k', '5,10,20', '--json', reportPath, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return { report: JSON.parse(fs.readFileSync(reportPath, 'utf8')), stdout: result.stdout };
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mask-replay-'));
}

test('keeps the last K tool results and masks only older outputs', () => {
  const root = tempRoot();
  try {
    const fixture = transcript();
    writeTranscript(path.join(root, 'project', 'session.jsonl'), fixture.events);
    const { report } = runReport(root);
    const row = report.headroom['5'].all;
    assert.equal(row.n, 1);
    assert.equal(row.maskedResults.median, 2);
    assert.equal(row.toolResults.median, 7);
    assert.equal(report.headroom['5'].byTool.Read.maskedResults.median, 2);
    assert.equal(Object.hasOwn(report.headroom['5'].byTool, 'Bash'), false);
    assert.equal(report.headroom['10'].all.maskedResults.median, 0);
    assert.equal(report.cuts.byWindow['200k'].s4, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('counts the placeholder token size when calculating freed tokens', () => {
  const root = tempRoot();
  try {
    writeTranscript(path.join(root, 'project', 'session.jsonl'), transcript().events);
    const { report } = runReport(root);
    const original = Math.ceil(JSON.stringify('0'.repeat(400)).length / 4);
    const replacement = Math.ceil(JSON.stringify(placeholder).length / 4);
    const scale = report.calibration.tokensScale;
    assert.equal(report.headroom['5'].all.freedTokens.median, 2 * (original - replacement) * scale);
    assert.equal(report.headroom['5'].all.placeholderTokens.median, 2 * replacement * scale);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reports zero headroom for a cut with no tool results', () => {
  const root = tempRoot();
  try {
    writeTranscript(path.join(root, 'project', 'session.jsonl'), transcript('02', { toolCount: 0 }).events);
    const { report } = runReport(root);
    assert.equal(report.cuts.n, 1);
    assert.equal(report.headroom['5'].all.n, 1);
    assert.equal(report.headroom['5'].all.toolResults.median, 0);
    assert.equal(report.headroom['5'].all.freedTokens.median, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not count tool results that appear after the cut boundary', () => {
  const root = tempRoot();
  try {
    writeTranscript(path.join(root, 'project', 'session.jsonl'), transcript('02', { toolCount: 0, resultAfterCut: true }).events);
    const { report } = runReport(root);
    assert.equal(report.headroom['5'].all.toolResults.median, 0);
    assert.equal(report.headroom['5'].all.maskedResults.median, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('filters cut dates inclusively with since and until', () => {
  const root = tempRoot();
  try {
    for (const day of ['01', '02', '03']) {
      writeTranscript(path.join(root, 'project', `${day}.jsonl`), transcript(day, { toolCount: 0 }).events);
    }
    const reportPath = path.join(root, 'filtered.json');
    const result = spawnSync(process.execPath, [script, '--root', root, '--since', '2026-10-02', '--until', '2026-10-02', '--json', reportPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(fs.readFileSync(reportPath, 'utf8')).cuts.n, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('estimates deferral from freed tokens divided by median growth over the last 20 calls', () => {
  const root = tempRoot();
  try {
    writeTranscript(path.join(root, 'project', 'session.jsonl'), transcript().events);
    const { report } = runReport(root);
    const growth = report.deferral.byK['5'].all.medianPerCallContextGrowthTokens.median;
    const freed = report.headroom['5'].all.freedTokens.median;
    assert.equal(growth, 10);
    assert.equal(report.deferral.byK['5'].all.estimatedExtraCalls.median, freed / growth);
    assert.match(report.deferral.assumption, /estimate/i);
    assert.match(report.deferral.assumption, /not a replay/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('compares masked and real paths on paired call horizons and counts the deferred seed', () => {
  const root = tempRoot();
  try {
    writeTranscript(path.join(root, 'project', 'session.jsonl'), transcript('02', { preTokens: 'estimate' }).events);
    const { report } = runReport(root);
    const cost = report.cost['5'].s4;
    const freed = report.headroom['5'].all.freedTokens.median;
    assert.equal(cost.paired.fixed20.n, 1);
    assert.equal(cost.paired.fixed20.calls.median, 20);
    assert.equal(cost.paired.deferral.n, 1);
    const maskedContext = report.headroom['5'].all.preTokens.median - freed;
    const growth = report.deferral.byK['5'].all.medianPerCallContextGrowthTokens.median;
    const expectedMaskedPathCost = maskedContext * 1.25 + 5 * 4
      + Array.from({ length: 19 }, (_, index) => 0.1 * (maskedContext + index * growth)
        + 1.25 * growth + 5 * 4).reduce((sum, costPart) => sum + costPart, 0);
    assert.ok(Math.abs(cost.paired.fixed20.maskedPathCost.median - expectedMaskedPathCost) < 1e-8);
    assert.equal(cost.paired.fixed20.realPathCost.median, 20 * weightedUsage(usage(10, 20, 30, 4)));
    assert.ok(cost.paired.fixed20.maskedMinusReal.median > 0);
    assert.equal(cost.paired.fixed20.maskingCheaper.share, 0);
    assert.equal(cost.cutAgainAfterDeferral.seedEvents, 1);
    assert.equal(cost.cutAgainAfterDeferral.includedInPairedHorizonCost, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('classifies native summaries with the postcut classifier', () => {
  const root = tempRoot();
  try {
    writeTranscript(path.join(root, 'project', 'native.jsonl'), transcript('02', { kind: 'native', toolCount: 0 }).events);
    const { report } = runReport(root);
    assert.equal(report.cuts.native, 1);
    assert.equal(report.cuts.s4, 0);
    assert.equal(report.cost['5'].native.paired.fixed20.n, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('calibrates whole-context text estimates against the last assistant call before the cut', () => {
  const root = tempRoot();
  try {
    const fixture = transcript('02', { toolCount: 0, callsBefore: 0 });
    writeTranscript(path.join(root, 'project', 'session.jsonl'), fixture.events);
    const { report } = runReport(root);
    assert.equal(report.calibration.estimateToUsageRatio.n, 1);
    assert.equal(report.calibration.estimateToUsageRatio.median, 1);
    assert.equal(report.calibration.tokensScale, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('skips unparseable lines and reports their count without echoing content', () => {
  const root = tempRoot();
  try {
    writeTranscript(path.join(root, 'project', 'session.jsonl'), transcript('02', { toolCount: 0 }).events, true);
    const { report, stdout } = runReport(root);
    assert.equal(report.malformedLines, 1);
    assert.equal(report.cuts.n, 1);
    assert.doesNotMatch(stdout, /not json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('excludes subagent transcript files from main-session totals', () => {
  const root = tempRoot();
  try {
    writeTranscript(path.join(root, 'project', 'main.jsonl'), transcript('02', { toolCount: 0 }).events);
    writeTranscript(path.join(root, 'project', 'subagents', 'agent.jsonl'), transcript('02').events);
    const { report } = runReport(root);
    assert.equal(report.transcriptsScanned, 1);
    assert.equal(report.cuts.n, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('strips image and document base64 and estimates masked visual blocks separately', () => {
  const root = tempRoot();
  const runWithPayloadSize = (payloadSize) => {
    const fixture = transcript();
    const firstResult = fixture.before.find((row) => row.type === 'user' && Array.isArray(row.message?.content))
      .message.content[0];
    firstResult.content = [
      { type: 'text', text: 'image and page summary' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(payloadSize) } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'B'.repeat(payloadSize) } },
    ];
    writeTranscript(path.join(root, `visual-${payloadSize}.jsonl`), fixture.events);
    const reportPath = path.join(root, `visual-${payloadSize}.json`);
    const result = spawnSync(process.execPath, [script, '--root', root, '--since', '2026-10-01', '--until', '2026-10-31', '--k', '5,10,20', '--json', reportPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  };
  try {
    const short = runWithPayloadSize(10);
    fs.rmSync(path.join(root, 'visual-10.jsonl'));
    const long = runWithPayloadSize(100_000);
    for (const k of ['5', '10', '20']) {
      assert.equal(long.headroom[k].all.toolResultTokens.median, short.headroom[k].all.toolResultTokens.median);
      assert.equal(long.headroom[k].all.freedTokens.median, short.headroom[k].all.freedTokens.median);
    }
    assert.equal(long.headroom['5'].all.cutsWithMaskedImageBlocks, 1);
    assert.equal(long.headroom['5'].all.maskedImageBlockTotal, 2);
    assert.equal(long.headroom['5'].all.maskedImageTokenTotal, 2_000);
    assert.equal(long.headroom['5'].all.maskedImageBlocks.median, 2);
    assert.equal(long.headroom['5'].all.maskedImageTokens.median, 2_000);
    assert.equal(long.headroom['10'].all.cutsWithMaskedImageBlocks, 0);
    assert.equal(long.imageTokenEstimate.tokensPerBlock, 1_000);
    assert.match(long.imageTokenEstimate.rule, /Assumption/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reports exact file-path replay for masked and retained Read results', () => {
  const root = tempRoot();
  try {
    const fixture = transcript();
    const firstCall = fixture.events.find((row) => row.type === 'assistant' && row.message?.id === 'after-0');
    firstCall.message.content = [{ type: 'tool_use', id: 'post-read-masked', name: 'Read', input: { file_path: '/repo/file-r0.js' } }];
    const secondCall = fixture.events.find((row) => row.type === 'assistant' && row.message?.id === 'after-1');
    secondCall.message.content = [{ type: 'tool_use', id: 'post-read-kept', name: 'Bash', input: { command: 'cat /repo/file-r6.js' } }];
    writeTranscript(path.join(root, 'project', 'session.jsonl'), fixture.events);
    const { report } = runReport(root);
    assert.deepEqual(report.headroom['5'].readReplayProxy.masked, { cuts: 1, n: 2, repeated: 1, share: 0.5 });
    assert.deepEqual(report.headroom['5'].readReplayProxy.kept, { cuts: 1, n: 1, repeated: 1, share: 1 });
    assert.deepEqual(report.headroom['10'].readReplayProxy.masked, { cuts: 0, n: 0, repeated: 0, share: null });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('caps the deferral cost horizon at 200 and extends missing post-cut calls', () => {
  const root = tempRoot();
  try {
    writeTranscript(path.join(root, 'project', 'session.jsonl'), transcript('02', { toolCount: 30, postCutCalls: 2 }).events);
    const { report } = runReport(root);
    const cost = report.cost['5'].s4.paired.deferral;
    assert.equal(cost.n, 1);
    assert.equal(cost.calls.median, 200);
    assert.equal(cost.measuredCalls.median, 2);
    assert.equal(cost.extendedCalls.median, 198);
    assert.match(report.costAssumption, /capped at 200/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('extends real-path cost from the last measured context for missing calls', () => {
  const root = tempRoot();
  try {
    writeTranscript(path.join(root, 'project', 'session.jsonl'), transcript('02', { toolCount: 0, postCutCalls: 2 }).events);
    const { report } = runReport(root);
    const cost = report.cost['5'].s4.paired.fixed20;
    assert.equal(cost.measuredCalls.median, 2);
    assert.equal(cost.extendedCalls.median, 18);
    assert.equal(cost.realPathCost.median, 755);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
