import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTree, hydrateTree, runClaude, validateMergeResponse, SUMMARY_MAX_BYTES } from './tree.mjs';

const message = (role, text, index) => ({
  role, text, toolUses: [], toolResults: [], sidechain: false, eventIndex: index,
  original: { role, text, index },
});
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const makeTree = () => {
  const messages = Array.from({ length: 8 }, (_, i) => message(i % 2 ? 'assistant' : 'user', `${i}${'x'.repeat(300)}`, i));
  return buildTree(messages, { budgetTokens: 180, atMessageIndices: [7] });
};
const paidLevel1 = (tree) => Object.values(tree.nodes).filter((n) => n.level === 1 && !n.free).sort((a, b) => a.start - b.start);

describe('validateMergeResponse', () => {
  it('does not throw on missing ids, returns the partial map, and truncates over-long text', () => {
    const long = 'y'.repeat(700);
    const raw = JSON.stringify({ merges: [{ id: 'a', text: 'ok' }, { id: 'b', text: long }, { id: 'c', text: '   ' }] });
    const out = validateMergeResponse(raw, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
    assert.equal(out.get('a'), 'ok');
    assert.ok(bytes(out.get('b')) <= SUMMARY_MAX_BYTES && out.get('b').length > 100);
    assert.equal(out.has('c'), false);
    assert.equal(out.has('d'), false);
  });

  it('still rejects unparsable JSON', () => {
    assert.throws(() => validateMergeResponse('not json', [{ id: 'a' }]));
  });
});

describe('hydrateTree with omitted ids', () => {
  it('retries missing tasks once, truncates over-long text, falls back to truncated joins', async () => {
    const tree = makeTree();
    const ids = paidLevel1(tree).map((n) => n.id);
    assert.ok(ids.length >= 4, `need >=4 paid level-1 nodes, got ${ids.length}`);
    const [okId, longId, retryId, lostId] = ids;
    const batches = [];
    const mergeBatch = async (_prompt, tasks) => {
      batches.push(tasks.map((t) => t.id));
      const merged = new Map();
      for (const task of tasks) {
        if (task.id === okId) merged.set(task.id, 'fine summary');
        else if (task.id === longId) merged.set(task.id, 'z'.repeat(900));
        else if (task.id === retryId) { if (batches.filter((b) => b.includes(retryId)).length > 1) merged.set(task.id, 'second try'); }
        else if (task.id === lostId) { /* always omitted */ }
        else merged.set(task.id, `summary ${task.id}`);
      }
      return { merged, cost: 0.01 };
    };
    const cache = {};
    const stats = await hydrateTree(tree, { mergeBatch, cache, maxSpend: 5 });

    assert.equal(batches.filter((b) => b.includes(retryId)).length, 2);
    assert.equal(batches.filter((b) => b.includes(lostId)).length, 2);
    assert.equal(batches.filter((b) => b.includes(okId)).length, 1);
    assert.equal(batches.filter((b) => b.includes(longId)).length, 1);
    assert.equal(tree.nodes[okId].text, 'fine summary');
    assert.equal(tree.nodes[longId].mergeKind, 'paid');
    assert.ok(bytes(tree.nodes[longId].text) <= SUMMARY_MAX_BYTES);
    assert.equal(tree.nodes[retryId].text, 'second try');
    assert.equal(tree.nodes[retryId].mergeKind, 'paid');
    const lost = tree.nodes[lostId];
    assert.equal(lost.mergeKind, 'truncated');
    assert.ok(bytes(lost.text) <= SUMMARY_MAX_BYTES);
    assert.ok(lost.text.startsWith(tree.nodes[lost.children[0]].text.slice(0, 50)));
    assert.equal(stats.truncatedMerges, 1);
    assert.equal(stats.skippedMerges, 0);
    assert.equal(Object.keys(cache).length, stats.paidMerges);
    assert.ok(!Object.values(cache).includes(lost.text));
    assert.ok(Object.values(tree.nodes).every((n) => n.mergeKind !== 'dry'));
    assert.equal(stats.calls, batches.length);
  });

  it('gives cap-skipped tasks the truncated fallback and counts them as skipped', async () => {
    const tree = makeTree();
    const stats = await hydrateTree(tree, { mergeBatch: async () => { throw new Error('no call expected'); }, maxCalls: 0 });
    assert.equal(stats.calls, 0);
    assert.ok(stats.skippedMerges >= 4);
    assert.equal(stats.truncatedMerges, 0);
    assert.ok(Object.values(tree.nodes).every((n) => n.mergeKind !== 'dry'));
    for (const n of paidLevel1(tree)) assert.equal(n.mergeKind, 'truncated');
  });
});

describe('runClaude with an unparsable reply', () => {
  it('resolves with no merges and the paid cost, and keeps the reply for diagnosis', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-bad-reply-'));
    const fake = path.join(dir, 'fake-claude.sh');
    const result = { type: 'result', result: 'Here are the merged summaries, one per line.', total_cost_usd: 0.012, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } };
    fs.writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\necho '${JSON.stringify(result)}'\n`, { mode: 0o755 });
    const before = process.env.TREE_CLAUDE;
    process.env.TREE_CLAUDE = fake;
    try {
      const input = `prompt\n${JSON.stringify({ merges: [{ id: 'a', left: 'l', right: 'r' }] })}`;
      const response = await runClaude(input, 1, { badReplyDir: path.join(dir, 'bad') });
      assert.equal(response.merged.size, 0);
      assert.equal(response.cost, 0.012);
      const kept = fs.readdirSync(path.join(dir, 'bad'));
      assert.equal(kept.length, 1);
      assert.equal(fs.readFileSync(path.join(dir, 'bad', kept[0]), 'utf8'), result.result);
    } finally {
      if (before === undefined) delete process.env.TREE_CLAUDE; else process.env.TREE_CLAUDE = before;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
