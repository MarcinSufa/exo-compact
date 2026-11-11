import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const defaultTool = fileURLToPath(new URL('./subagent-cuts.mjs', import.meta.url));
const tool = process.env.SUBAGENT_CUTS_TOOL ?? defaultTool;

function boundary(timestamp, preTokens, postTokens) {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    timestamp,
    sessionId: 'fixture-session',
    compactMetadata: { preTokens, postTokens },
  };
}

function call(id, timestamp, usage) {
  return { type: 'assistant', timestamp, message: { id, usage, content: [] } };
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-cuts-'));
  const agentDir = path.join(root, 'project-a', 'parent-a', 'subagents');
  const mainDir = path.join(root, 'project-a');
  fs.mkdirSync(agentDir, { recursive: true });

  const agentLines = [
    JSON.stringify({ type: 'queue-operation', agentType: 'Explore' }),
    JSON.stringify(boundary('2026-10-02T00:00:00.000Z', 1000, 500)),
    JSON.stringify(call('a1', '2026-10-02T00:00:03.000Z', { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 10 })),
    JSON.stringify(call('a2', '2026-10-02T00:00:04.000Z', { input_tokens: 40, cache_read_input_tokens: 10, output_tokens: 2 })),
    JSON.stringify(call('a3', '2026-10-02T00:00:05.000Z', { input_tokens: 10, output_tokens: 4 })),
    JSON.stringify(boundary('2026-10-03T00:00:00.000Z', 2000, 800)),
    JSON.stringify(call('a4', '2026-10-03T00:00:03.000Z', { input_tokens: 200, cache_creation_input_tokens: 10, cache_read_input_tokens: 50, output_tokens: 20 })),
  ];
  fs.writeFileSync(path.join(agentDir, 'agent-a.jsonl'), `${agentLines.join('\n')}\n`);
  fs.writeFileSync(path.join(agentDir, 'agent-empty.jsonl'), `${JSON.stringify({ type: 'user', timestamp: '2026-10-02T00:00:00.000Z' })}\n`);
  fs.writeFileSync(path.join(mainDir, 'main.jsonl'), [
    JSON.stringify(boundary('2026-10-04T00:00:00.000Z', 700, 300)),
    JSON.stringify(boundary('2026-10-05T00:00:00.000Z', 900, 400)),
  ].join('\n') + '\n');
  return root;
}

function run(root, args = []) {
  const result = spawnSync(process.execPath, [tool, '--root', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || 'tool exited unsuccessfully');
  return JSON.parse(result.stdout);
}

test('counts compact boundaries per subagent transcript', (t) => {
  const root = makeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const report = run(root);
  assert.equal(report.inventory.subagentTranscripts, 2);
  assert.equal(report.inventory.subagentTranscriptsWithCompactions, 1);
  assert.equal(report.inventory.subagentCompactions, 2);
  assert.deepEqual(report.inventory.subagentSessionIds, { transcriptsWithId: 1, uniqueIds: 1 });
  assert.deepEqual(report.window.compactionsPerTranscript, { n: 2, median: 1, q1: 0.5, q3: 1.5, iqr: 1 });
  assert.deepEqual(report.window.compactionsPerCompactingTranscript, { n: 1, median: 2, q1: 2, q3: 2, iqr: 0 });
  assert.deepEqual(report.window.agentTypes, { transcripts: 1, counts: { Explore: 1 } });
});

test('reports boundary pre and post tokens and post-cut context and weighted costs', (t) => {
  const root = makeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const report = run(root);
  assert.deepEqual(report.window.preTokens, { n: 2, median: 1500, q1: 1250, q3: 1750, iqr: 500 });
  assert.deepEqual(report.window.postTokens, { n: 2, median: 650, q1: 575, q3: 725, iqr: 150 });
  assert.deepEqual(report.window.firstCallContextTokens, { n: 2, median: 205, q1: 177.5, q3: 232.5, iqr: 55 });
  assert.equal(report.window.nextCallCostTokenEquivalents.next1.median, 247.75);
  assert.equal(report.window.nextCallCostTokenEquivalents.next5.median, 288.25);
  assert.equal(report.window.nextCallCostTokenEquivalents.next20.median, 288.25);
});

test('uses the shared postcut weight for a 1-hour cache write', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-cuts-ttl-'));
  const agentDir = path.join(root, 'project-a', 'parent-a', 'subagents');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'agent-ttl.jsonl'), [
    JSON.stringify(boundary('2026-10-02T00:00:00.000Z', 1000, 500)),
    JSON.stringify(call('ttl-call', '2026-10-02T00:00:03.000Z', {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 100 },
      cache_read_input_tokens: 0,
      output_tokens: 0,
      iterations: [{
        input_tokens: 0,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      }],
    })),
  ].join('\n') + '\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const report = run(root);
  assert.equal(report.window.nextCallCostTokenEquivalents.next1.median, 200);
});

test('filters boundary metrics by --since and writes aggregate JSON', (t) => {
  const root = makeFixture();
  const output = path.join(root, 'aggregate.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const report = run(root, ['--since', '2026-10-04', '--json', output]);
  assert.equal(report.since, '2026-10-04');
  assert.equal(report.window.subagentCompactions, 0);
  assert.equal(report.window.allCompactions, 2);
  assert.equal(report.window.subagentShare, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), report);
});

test('calculates subagent share against main and subagent boundaries', (t) => {
  const root = makeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const report = run(root);
  assert.equal(report.inventory.allCompactions, 4);
  assert.equal(report.inventory.subagentShare, 0.5);
  assert.equal(report.window.allCompactions, 4);
  assert.equal(report.window.subagentShare, 0.5);
  assert.equal(report.comparison.since, report.since);
  assert.equal(report.comparison.design, 'Observational transcript cohorts; unpaired and not an A/B.');
  assert.equal(report.comparison.mainSession.postCut.exoCompact.cuts, 623);
  assert.equal(report.comparison.mainSession.postCut.native.cuts, 160);
  assert.equal(report.comparison.subagent.costProxyBand.cuts, 0);
});

test('keeps transcripts without compaction in the transcript denominator', (t) => {
  const root = makeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const report = run(root);
  assert.equal(report.inventory.subagentTranscripts, 2);
  assert.deepEqual(report.window.compactionsPerTranscript, { n: 2, median: 1, q1: 0.5, q3: 1.5, iqr: 1 });
});

test('skips unparseable lines and reports their count without losing valid boundaries', (t) => {
  const root = makeFixture();
  const agent = path.join(root, 'project-a', 'parent-a', 'subagents', 'agent-a.jsonl');
  fs.appendFileSync(agent, 'this is not json\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const report = run(root);
  assert.equal(report.window.subagentCompactions, 2);
  assert.equal(report.window.malformedLines, 1);
});
