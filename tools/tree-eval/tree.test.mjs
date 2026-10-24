import { describe, expect, it } from 'vitest';
import { buildTree, hydrateTree, level0, transcriptMessages, view, viewTokens, zoom } from './tree.mjs';

const row = (event) => JSON.stringify(event);
const message = (role, text, index, extra = {}) => ({
  role, text, toolUses: [], toolResults: [], sidechain: false, eventIndex: index,
  original: { role, text, index }, ...extra,
});

describe('tree-eval', () => {
  it('makes one deterministic level-0 line per transcript message within 512 UTF-8 bytes', () => {
    const source = [
      row({ type: 'user', message: { content: 'Please check the timeout.' } }),
      row({ type: 'assistant', message: { content: [
        { type: 'text', text: 'I will inspect the gateway. Then I will update the tests.' },
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'grep timeout config.yaml' } },
      ] } }),
      row({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'timeout: 30s' }] } }),
      row({ type: 'assistant', message: { content: `A${'🙂'.repeat(400)}` } }),
    ].join('\n');
    const messages = transcriptMessages(source);
    const leaves = level0(messages);

    expect(leaves).toHaveLength(4);
    expect(leaves[0].text).toBe('Please check the timeout.');
    expect(leaves[1].text).toMatch(/^I will inspect the gateway\./);
    expect(leaves[1].text).toContain('ran');
    expect(leaves[2].text).toContain('Bash result ok');
    expect(leaves.every((leaf) => Buffer.byteLength(leaf.text, 'utf8') <= 512)).toBe(true);
  });

  it('merges a pair for free when both one-line summaries fit together in 512 bytes', () => {
    const messages = [message('user', 'a'.repeat(240), 0), message('assistant', 'b'.repeat(240), 1)];
    const tree = buildTree(messages, { budgetTokens: 120, atMessageIndices: [1] });
    const parents = Object.values(tree.nodes).filter((node) => node.kind === 'merge');

    expect(parents).toHaveLength(1);
    expect(parents[0].free).toBe(true);
    expect(Buffer.byteLength(parents[0].text, 'utf8')).toBeLessThanOrEqual(512);
    expect(tree.metrics.paidMerges).toBe(0);
  });

  it('keeps requested views under budget and gives the same prefix after later messages append', () => {
    const messages = Array.from({ length: 240 }, (_, i) => message(i % 2 ? 'assistant' : 'user', `turn ${i}: ${'detail '.repeat(8)}`, i));
    const budgetTokens = 1200;
    const short = buildTree(messages.slice(0, 80), { budgetTokens, atMessageIndices: [39, 79] });
    const long = buildTree(messages, { budgetTokens, atMessageIndices: [39, 79, 239] });

    expect(viewTokens(short, view(short, budgetTokens, 39))).toBeLessThanOrEqual(budgetTokens);
    expect(viewTokens(long, view(long, budgetTokens, 79))).toBeLessThanOrEqual(budgetTokens);
    expect(long.snapshots[39]).toEqual(short.snapshots[39]);
    expect(long.snapshots[79]).toEqual(short.snapshots[79]);
  });

  it('zooms merged lines back to the original messages in order', () => {
    const messages = Array.from({ length: 13 }, (_, i) => message(i % 2 ? 'assistant' : 'user', `original ${i} ${'x'.repeat(150)}`, i));
    const tree = buildTree(messages, { budgetTokens: 30, atMessageIndices: [12] });
    const roots = tree.snapshots[12].nodeIds.flatMap((id) => zoom(tree, id, 100));

    expect(roots.map((node) => node.level)).toEqual(Array(13).fill(0));
    expect(roots.map((node) => node.original)).toEqual(messages.map((item) => item.original));
  });

  it('hydrates independent paid pairs in one batch and reuses the cache', async () => {
    const messages = Array.from({ length: 4 }, (_, i) => message(i % 2 ? 'assistant' : 'user', `${i}${'x'.repeat(300)}`, i));
    const tree = buildTree(messages, { budgetTokens: 180, atMessageIndices: [3] });
    const cache = {};
    let calls = 0, writes = 0;
    const mergeBatch = async (_prompt, tasks) => {
      calls += 1;
      return { merged: new Map(tasks.map((task) => [task.id, `summary ${task.id}`])), cost: 0.01 };
    };
    const first = await hydrateTree(tree, { mergeBatch, cache, maxSpend: 1, onCacheWrite: () => { writes += 1; } });

    expect(calls).toBe(1);
    expect(first.paidMerges).toBe(2);
    expect(first.cachedHits).toBe(0);
    expect(writes).toBe(1);
    expect(Object.values(tree.nodes).filter((node) => node.level === 2)[0].mergeKind).toBe('free');

    const secondTree = buildTree(messages, { budgetTokens: 180, atMessageIndices: [3] });
    const second = await hydrateTree(secondTree, { mergeBatch: async () => { throw new Error('cache should avoid a call'); }, cache, maxSpend: 1 });
    expect(second.cachedHits).toBe(2);
    expect(second.paidMerges).toBe(0);
  });
});
