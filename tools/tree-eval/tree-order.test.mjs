import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree } from './tree.mjs';

// Pins the Taelin spec v3 merge order through buildTree (due = (T - last) / 2^l), so reverting
// `due` to (T - left.start) / 2^(l+2) fails here and not only in the duePair unit tests.
describe('buildTree merge order (spec v3)', () => {
  it('merges in the exact v3 order for T=10 and keeps spans contiguous from 0', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user', text: `msg ${i} ${'x'.repeat(300)}`, toolUses: [], toolResults: [],
      sidechain: false, eventIndex: i, original: null,
    }));
    const tree = buildTree(messages, { budgetTokens: 400, atMessageIndices: [9] });
    assert.deepEqual(tree.mergeOrder, ['t1-0-2', 't1-2-4', 't2-0-4', 't1-4-6', 't1-6-8', 't2-4-8', 't1-8-10']);
    assert.deepEqual(tree.snapshots[9].nodeIds, ['t2-0-4', 't2-4-8', 't1-8-10']);
    const spans = tree.snapshots[9].nodeIds.map((id) => [tree.nodes[id].start, tree.nodes[id].end]);
    assert.equal(spans[0][0], 0);
    assert.equal(spans.at(-1)[1], 10);
  });
});
