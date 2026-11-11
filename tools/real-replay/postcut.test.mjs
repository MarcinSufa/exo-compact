import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = path.join(import.meta.dirname, 'postcut.mjs');
const stamp = (day, second = 0) => `2026-10-${day}T12:00:${String(second).padStart(2, '0')}.000Z`;
const event = (type, extra = {}) => ({ type, ...extra });

function assistant(id, usage, at, model = 'claude-sonnet-5-5') {
  return event('assistant', { timestamp: at, message: { id, model, usage, content: [{ type: 'text', text: 'synthetic fixture' }] } });
}

function usage(input, write, read, output) {
  return { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output };
}

function writeCut(dir, name, kind, day, preTokens, postTokens, perCall, useIterations = false) {
  const events = [event('system', { subtype: 'compact_boundary', timestamp: stamp(day), compactMetadata: { trigger: 'auto', preTokens, postTokens } })];
  events.push(event('user', {
    timestamp: stamp(day, 1),
    message: { content: kind === 's4' ? '[[exovault:s4-seed:v1]] fixture seed' : 'This session is being continued from a previous conversation.' },
    ...(kind === 'native' ? { isCompactSummary: true } : {}),
  }));
  // Transcript order can place the compaction-triggering response after the boundary even though
  // its timestamp predates the injected seed/summary. It is not a post-cut call.
  events.push(assistant(`${name}-precut`, usage(99999, 0, 0, 0), stamp(day)));
  const apiUsage = useIterations
    ? { ...usage(0, 0, 0, 0), iterations: [usage(...perCall)] }
    : usage(...perCall);
  events.push(assistant(`${name}-call-1`, apiUsage, stamp(day, 2)));
  // Repeated transcript blocks for one API message must not count as a second call.
  if (useIterations) events.push(assistant(`${name}-call-1`, apiUsage, stamp(day, 2)));
  for (let n = 2; n <= 20; n++) events.push(assistant(`${name}-call-${n}`, usage(...perCall), stamp(day, n)));
  fs.writeFileSync(path.join(dir, `${name}.jsonl`), `${events.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

test('postcut reports aggregate usage, costs, metadata, window groups, and tagged card-fork cost', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postcut-fixture-'));
  const children = path.join(root, 'subagents');
  fs.mkdirSync(children);
  writeCut(root, 'fixture-s4-a', 's4', '03', 198000, 8000, [2, 100, 1000, 10], true);
  writeCut(root, 'fixture-s4-b', 's4', '04', 210000, 9000, [1, 200, 900, 2]);
  writeCut(root, 'fixture-native-a', 'native', '05', 205000, 18000, [10, 80, 500, 20]);
  writeCut(root, 'fixture-native-b', 'native', '06', 220000, 20000, [100, 200, 1000, 10]);

  const fork = [
    event('user', { timestamp: stamp('03', 9), message: { content: 'The conversation context will be compacted soon. Write the task card that the compacted context will keep.' } }),
    assistant('card-fork-call-1', usage(100, 200, 300, 40), stamp('03', 10)),
    assistant('card-fork-call-2', usage(100, 200, 300, 40), stamp('03', 11)),
  ];
  fs.writeFileSync(path.join(children, 'fixture-card-refresh.jsonl'), `${fork.map((row) => JSON.stringify(row)).join('\n')}\n`);

  const reportPath = path.join(root, 'aggregate.json');
  try {
    const run = spawnSync(process.execPath, [script, '--since', '2026-10-01', '--json', reportPath, root], { encoding: 'utf8' });
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
    assert.equal(report.cutCosts.cardRefreshForks.n, 1);
    assert.equal(report.cutCosts.cardRefreshForks.cost.median, 1160);
    assert.equal(report.cutCosts.nativeSummaryCalls.n, 0);

    const output = `${run.stdout}\n${fs.readFileSync(reportPath, 'utf8')}`;
    assert.doesNotMatch(output, /fixture-s4|fixture-native|fixture-card-refresh|postcut-fixture-/);
    assert.doesNotMatch(output, /synthetic fixture|The conversation context/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
