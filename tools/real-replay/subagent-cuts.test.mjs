import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const defaultTool = fileURLToPath(new URL('./subagent-cuts.mjs', import.meta.url));
const tool = process.env.SUBAGENT_CUTS_TOOL ?? defaultTool;
const REFERENCE_UNTIL = '2026-11-11T05:14:06Z';

function boundary(timestamp, preTokens, postTokens, sessionId = 'parent-a') {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    timestamp,
    sessionId,
    compactMetadata: { preTokens, postTokens },
  };
}

function call(id, timestamp, usage, model) {
  return { type: 'assistant', timestamp, message: { id, usage, content: [], ...(model ? { model } : {}) } };
}

function writeEvents(file, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${events.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

function writeAgent(root, parentSession, name, events, metadata, source = 'agents') {
  const directory = source === 'workflows'
    ? path.join(root, 'project-a', parentSession, 'subagents', 'workflows', 'wf_fixture')
    : path.join(root, 'project-a', parentSession, 'subagents');
  const file = path.join(directory, `${name}.jsonl`);
  writeEvents(file, events);
  if (metadata !== undefined) fs.writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(metadata));
  return file;
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-cuts-'));
  writeAgent(root, 'parent-a', 'agent-a', [
    boundary('2026-10-02T00:00:00.000Z', 1000, 500),
    call('a1', '2026-10-02T00:00:03.000Z', { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 10 }),
    call('a2', '2026-10-02T00:00:04.000Z', { input_tokens: 40, cache_read_input_tokens: 10, output_tokens: 2 }),
    call('a3', '2026-10-02T00:00:05.000Z', { input_tokens: 10, output_tokens: 4 }),
    boundary('2026-10-03T00:00:00.000Z', 2000, 800),
    call('a4', '2026-10-03T00:00:03.000Z', { input_tokens: 200, cache_creation_input_tokens: 10, cache_read_input_tokens: 50, output_tokens: 20 }),
  ], { agentType: 'Explore', model: 'sonnet' });
  writeAgent(root, 'parent-a', 'agent-empty', [
    { type: 'user', timestamp: '2026-10-02T00:00:00.000Z' },
  ]);
  writeAgent(root, 'parent-a', 'agent-id-only', [
    { type: 'user', timestamp: '2026-10-02T00:00:00.000Z', sessionId: 'parent-a' },
  ]);
  writeAgent(root, 'parent-a', 'agent-old', [
    boundary('2026-09-30T23:59:00.000Z', 900, 400),
  ], { agentType: 'Explore', model: 'opus' });
  writeAgent(root, 'parent-a', 'agent-workflow-a', [
    boundary('2026-10-06T00:00:00.000Z', 1500, 700),
    call('wa1', '2026-10-06T00:00:03.000Z', { input_tokens: 50 }),
  ], { agentType: 'workflow-subagent', model: 'sonnet' }, 'workflows');
  writeAgent(root, 'parent-b', 'agent-workflow-b', [
    boundary('2026-10-07T00:00:00.000Z', 1200, 600, 'parent-b'),
    call('wb1', '2026-10-07T00:00:03.000Z', { input_tokens: 75 }),
  ], { agentType: 'general-purpose', model: 'opus' }, 'workflows');

  const mainFile = path.join(root, 'project-a', 'main.jsonl');
  writeEvents(mainFile, [
    boundary('2026-09-30T23:00:00.000Z', 700, 300, 'main-session'),
    boundary('2026-10-04T00:00:00.000Z', 800, 350, 'main-session'),
    boundary('2026-10-05T00:00:00.000Z', 900, 400, 'main-session'),
  ]);
  return { root, mainFile };
}

function makeOneCutFixture(prefix = 'subagent-cuts-case-') {
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), parentSession: 'parent-one' };
}

function run(root, args = []) {
  const result = spawnSync(process.execPath, [tool, '--root', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || 'tool exited unsuccessfully');
  return JSON.parse(result.stdout);
}

function removeAfter(testContext, root) {
  testContext.after(() => fs.rmSync(root, { recursive: true, force: true }));
}

test('counts direct and workflow transcripts, reads sibling metadata, and measures parent concentration', (t) => {
  const { root } = makeFixture();
  removeAfter(t, root);
  const report = run(root, ['--until', REFERENCE_UNTIL]);

  assert.equal(report.inventory.subagentTranscripts, 6);
  assert.deepEqual(report.inventory.sources.agents, {
    transcripts: 4,
    transcriptsWithCompactions: 2,
    compactions: 3,
    windowTranscriptsWithCompactions: 1,
    windowCompactions: 2,
  });
  assert.deepEqual(report.inventory.sources.workflows, {
    transcripts: 2,
    transcriptsWithCompactions: 2,
    compactions: 2,
    windowTranscriptsWithCompactions: 2,
    windowCompactions: 2,
  });
  assert.deepEqual(report.inventory.subagentSessionIds, { transcriptsWithId: 5, uniqueIds: 2 });
  assert.equal(report.inventory.agentMetadata.transcriptsWithMeta, 4);
  assert.equal(report.inventory.agentMetadata.transcriptsWithoutMeta, 2);
  assert.equal(report.inventory.subagentCompactions, 5);
  assert.equal(report.window.subagentCompactions, 4);
  assert.equal(report.window.mainCompactions, 2);
  assert.equal(report.window.allCompactions, 6);
  assert.equal(report.window.subagentTranscriptsWithCompactions, 3);
  assert.equal(report.window.compactionsPerTranscript.n, 6);
  assert.equal(report.window.compactionsPerCompactingTranscript.n, 3);
  assert.deepEqual(report.window.agentTypes, {
    cuts: 4,
    counts: { Explore: 2, 'workflow-subagent': 1, 'general-purpose': 1 },
  });
  assert.deepEqual(report.window.agentModels, { cuts: 4, counts: { sonnet: 3, opus: 1 } });
  assert.deepEqual(report.window.concentration, {
    parentSessionsWithCuts: 2,
    top1: { cuts: 3, share: 0.75 },
    top5: { cuts: 4, share: 1 },
  });
});

test('filters boundary metrics by --since and filters the main-session row to its exact reference snapshot', (t) => {
  const { root } = makeFixture();
  const output = path.join(root, 'aggregate.json');
  removeAfter(t, root);
  const report = run(root, ['--since', '2026-10-01', '--until', REFERENCE_UNTIL, '--json', output]);

  assert.equal(report.since, '2026-10-01');
  assert.equal(report.until, REFERENCE_UNTIL);
  assert.equal(report.window.subagentCompactions, 4);
  assert.equal(report.window.preTokens.n, 4);
  assert.equal(report.window.mainCompactions, 2);
  assert.equal(report.comparison.mainSession.until, REFERENCE_UNTIL);
  assert.equal(report.comparison.mainSession.postCut.exoCompact.cuts, 623);
  assert.equal(report.comparison.mainSession.postCut.native.cuts, 160);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), report);
});

test('applies --until inclusively to boundaries and their post-cut metrics', (t) => {
  const { root, mainFile } = makeFixture();
  const agentFile = writeAgent(root, 'parent-a', 'agent-cutoff', [
    boundary(REFERENCE_UNTIL, 1700, 750),
    call('too-late', '2026-11-11T05:14:09Z', { input_tokens: 999 }),
    boundary('2026-11-11T05:14:10Z', 1800, 800),
  ], { agentType: 'Explore', model: 'sonnet' });
  fs.appendFileSync(mainFile, `${JSON.stringify(boundary('2026-11-11T05:14:07Z', 1000, 500, 'main-session'))}\n`);
  removeAfter(t, root);

  const report = run(root, ['--until', REFERENCE_UNTIL]);
  assert.equal(report.inventory.subagentCompactions, 7);
  assert.equal(report.window.subagentCompactions, 5);
  assert.equal(report.window.mainCompactions, 2);
  assert.equal(report.window.preTokens.n, 5);
  assert.equal(report.window.nextCallCostTokenEquivalents.next1.n, 4);
  assert.ok(agentFile.endsWith('agent-cutoff.jsonl'));
});

test('deduplicates repeated assistant message IDs before calculating post-cut cost', (t) => {
  const { root, parentSession } = makeOneCutFixture();
  removeAfter(t, root);
  writeAgent(root, parentSession, 'agent-dedupe', [
    boundary('2026-10-02T00:00:00Z', 150_000, 5000),
    call('duplicate-id', '2026-10-02T00:00:03Z', { input_tokens: 1 }),
    call('duplicate-id', '2026-10-02T00:00:04Z', { input_tokens: 1000 }),
    ...[2, 3, 4, 5].map((value, index) => call(`call-${value}`, `2026-10-02T00:00:0${5 + index}Z`, { input_tokens: value })),
  ], { agentType: 'general-purpose', model: 'sonnet' });

  const report = run(root);
  assert.equal(report.window.firstCallContextTokens.median, 1);
  assert.equal(report.window.nextCallCostTokenEquivalents.next5.median, 15);
});

test('requires complete call windows and applies both proxy-band bounds', (t) => {
  const { root, parentSession } = makeOneCutFixture();
  removeAfter(t, root);
  const makeCalls = (count, prefix) => Array.from({ length: count }, (_, index) => (
    call(`${prefix}-${index}`, `2026-10-02T00:00:${String(index + 3).padStart(2, '0')}Z`, { input_tokens: 1 })
  ));
  writeAgent(root, parentSession, 'agent-lower', [boundary('2026-10-02T00:00:00Z', 100_000, 5000), ...makeCalls(2, 'lower')], { agentType: 'general-purpose', model: 'sonnet' });
  writeAgent(root, parentSession, 'agent-middle', [boundary('2026-10-02T00:00:00Z', 200_000, 5000), ...makeCalls(5, 'middle')], { agentType: 'general-purpose', model: 'sonnet' });
  writeAgent(root, parentSession, 'agent-upper', [boundary('2026-10-02T00:00:00Z', 350_000, 5000), ...makeCalls(20, 'upper')], { agentType: 'general-purpose', model: 'sonnet' });

  const report = run(root);
  assert.equal(report.comparison.subagent.costProxyBand.cuts, 2);
  assert.equal(report.comparison.subagent.costProxyBand.nextCallCostTokenEquivalents.next5.n, 1);
  assert.equal(report.comparison.subagent.costProxyBand.nextCallCostTokenEquivalents.next20.n, 0);
  assert.equal(report.window.nextCallCostTokenEquivalents.next5.n, 3);
});

test('waits two seconds after the injected user before measuring calls', (t) => {
  const { root, parentSession } = makeOneCutFixture();
  removeAfter(t, root);
  writeAgent(root, parentSession, 'agent-gap', [
    boundary('2026-10-02T00:00:00Z', 1000, 500),
    { type: 'system', timestamp: '2026-10-02T00:00:00.500Z' },
    { type: 'user', timestamp: '2026-10-02T00:00:01Z' },
    call('too-soon', '2026-10-02T00:00:02Z', { input_tokens: 500 }),
    call('after-gap', '2026-10-02T00:00:04Z', { input_tokens: 5 }),
  ], { agentType: 'general-purpose', model: 'sonnet' });

  const report = run(root);
  assert.equal(report.window.firstCallContextTokens.median, 5);
  assert.equal(report.window.nextCallCostTokenEquivalents.next1.median, 5);
});

test('looks for the injected user in the next five events', (t) => {
  const { root, parentSession } = makeOneCutFixture();
  removeAfter(t, root);
  writeAgent(root, parentSession, 'agent-lookahead', [
    boundary('2026-10-02T00:00:00Z', 1000, 500),
    { type: 'system', timestamp: '2026-10-02T00:00:00.500Z' },
    call('before-injection', '2026-10-02T00:00:03Z', { input_tokens: 300 }),
    { type: 'user', timestamp: '2026-10-02T00:00:04Z' },
    call('after-injection', '2026-10-02T00:00:07Z', { input_tokens: 7 }),
  ], { agentType: 'general-purpose', model: 'sonnet' });

  const report = run(root);
  assert.equal(report.window.firstCallContextTokens.median, 7);
});

test('excludes synthetic assistant calls', (t) => {
  const { root, parentSession } = makeOneCutFixture();
  removeAfter(t, root);
  writeAgent(root, parentSession, 'agent-synthetic', [
    boundary('2026-10-02T00:00:00Z', 1000, 500),
    call('synthetic', '2026-10-02T00:00:03Z', { input_tokens: 1000 }, '<synthetic>'),
    call('real', '2026-10-02T00:00:04Z', { input_tokens: 5 }, 'claude-sonnet'),
  ], { agentType: 'general-purpose', model: 'sonnet' });

  const report = run(root);
  assert.equal(report.window.firstCallContextTokens.median, 5);
});

test('uses shared normalized usage including iteration TTL splits', (t) => {
  const { root, parentSession } = makeOneCutFixture();
  removeAfter(t, root);
  writeAgent(root, parentSession, 'agent-ttl', [
    boundary('2026-10-02T00:00:00Z', 1000, 500),
    call('ttl-call', '2026-10-02T00:00:03Z', {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
      iterations: [{
        input_tokens: 2,
        cache_creation_input_tokens: 100,
        cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 80 },
        cache_read_input_tokens: 10,
        output_tokens: 3,
      }],
    }),
  ], { agentType: 'general-purpose', model: 'sonnet' });

  const report = run(root);
  assert.equal(report.window.firstCallContextTokens.median, 112);
  assert.equal(report.window.nextCallCostTokenEquivalents.next1.median, 203);
});

test('reports model metadata without throwing on null or scalar JSON lines', (t) => {
  const { root, parentSession } = makeOneCutFixture();
  removeAfter(t, root);
  const file = writeAgent(root, parentSession, 'agent-json-values', [
    boundary('2026-10-02T00:00:00Z', 1000, 500),
    call('valid', '2026-10-02T00:00:03Z', { input_tokens: 5 }),
  ], { agentType: 'Plan', model: 'inherit' });
  fs.appendFileSync(file, 'null\n17\n');

  const report = run(root);
  assert.equal(report.window.subagentCompactions, 1);
  assert.deepEqual(report.window.agentTypes, { cuts: 1, counts: { Plan: 1 } });
  assert.deepEqual(report.window.agentModels, { cuts: 1, counts: { inherit: 1 } });
  assert.equal(report.window.malformedLines, 0);
});

test('attaches the main-session comparison only for the reference dates', (t) => {
  const { root } = makeFixture();
  removeAfter(t, root);
  const report = run(root, ['--since', '2026-10-02', '--until', REFERENCE_UNTIL]);
  const unboundedReferenceDate = run(root, ['--since', '2026-10-01']);
  assert.equal(report.comparison.mainSession, null);
  assert.match(report.comparison.mainSessionReferenceNote, /No parent-session reference/);
  assert.equal(unboundedReferenceDate.comparison.mainSession, null);
});

test('rejects an --until timestamp earlier than --since', (t) => {
  const { root } = makeFixture();
  removeAfter(t, root);
  const result = spawnSync(process.execPath, [tool, '--root', root, '--since', '2026-10-02', '--until', '2026-10-01T23:59:59Z'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--until must not be before --since/);
});

test('skips unparseable lines and reports their count without losing valid boundaries', (t) => {
  const { root } = makeFixture();
  const agent = path.join(root, 'project-a', 'parent-a', 'subagents', 'agent-a.jsonl');
  fs.appendFileSync(agent, 'this is not json\n');
  removeAfter(t, root);
  const report = run(root, ['--until', REFERENCE_UNTIL]);
  assert.equal(report.window.subagentCompactions, 4);
  assert.equal(report.window.malformedLines, 1);
});
