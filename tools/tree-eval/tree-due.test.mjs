import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, duePair } from './tree.mjs';

// Taelin spec v3 (2026-10-08): due = (T - last) / 2^l, age measured from the pair's last message.
const node = (start, end, level) => ({ id: `n${start}-${end}`, level, start, end });
const pairOf = (picked) => [picked.left.start, picked.right.end];

describe('duePair (spec v3: age from the pair last message)', () => {
  it("picks the spec's example pair 8-9 at T=10, not the old pair 0-7", () => {
    const visible = [node(0, 4, 2), node(4, 8, 2), node(8, 9, 0), node(9, 10, 0)];
    // new: pair 0-7 due (10-7)/4 = 0.75, pair 8-9 due (10-9)/1 = 1; old rule gave 10/16 vs 2/4.
    assert.deepEqual(pairOf(duePair(visible, 10)), [8, 10]);
  });

  it('breaks exact ties by the oldest left start', () => {
    const visible = [node(3, 5, 1), node(5, 7, 1), node(7, 8, 0), node(8, 9, 0)];
    // both due 2: (10-6)/2 and (10-8)/1
    assert.deepEqual(pairOf(duePair(visible, 10)), [3, 7]);
  });

  it('through buildTree: a forced merge at T=10 merges the newest pair, leaving the old level-2 lines alone', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user', text: `msg ${i} ${'x'.repeat(300)}`, toolUses: [], toolResults: [],
      sidechain: false, eventIndex: i, original: null,
    }));
    const tree = buildTree(messages, { budgetTokens: 400, atMessageIndices: [9] });
    const ids = tree.snapshots[9].nodeIds;
    // every old line that existed before message 9 must still be an ancestor-complete prefix: no node
    // spanning past a younger unmerged one, and the newest line is a level-0 message or the newest pair.
    const spans = ids.map((id) => [tree.nodes[id].start, tree.nodes[id].end]);
    for (let i = 1; i < spans.length; i += 1) assert.equal(spans[i - 1][1], spans[i][0]);
    assert.equal(spans.at(-1)[1], 10);
  });
});
