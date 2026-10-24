import { describe, expect, it, vi } from 'vitest';
import { register } from '../compact.js';
import { DENSE_BUDGET_TOKENS, SEED_BUDGET_TOKENS, TOTAL_BUDGET_TOKENS, estimateTokens, serializedTokens } from '../core/budgets.js';
import { fakeHost, withStrippedRuntimeGlobals, LEGACY_OPTIONS } from './fixtures/helpers.js';
import type { SessionMessage } from '../core/types.js';

// 3.46.0 (S4zt): the handler sizes every budget with estimateTokens, so the test measures with it too.
const countTokens = estimateTokens;

async function compact(messages: SessionMessage[]): Promise<SessionMessage[]> {
  const files = new Map<string, string>();
  const host = fakeHost({
    fsRead: async (path) => path === '.exovault/s4-compact-active' ? '1' : files.get(path) ?? '',
    fsWrite: async (path, text) => { files.set(path, text); },
    fsList: async (path = '') => [...files.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => ({ name: key.slice(path.length + 1), kind: 'file', size: files.get(key)!.length })),
    fsExists: async (path) => path.endsWith('/.exovault/s4-compact-active') || files.has(path),
  });
  const handlers: Record<string, (host: never, event: never, next: () => Promise<unknown>) => Promise<unknown>> = {};
  register(((name: string, handler: never) => { handlers[name] = handler; return { catch: (caught: unknown) => { (handlers as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS, denseNotes: true, totalBudgetTokens: 13000 } as never);
  const result = await withStrippedRuntimeGlobals(() => handlers['session.compact'](host as never, { trigger: 'manual', messages } as never, vi.fn(async () => ({ fellBack: true }))));
  return (result as { messages?: SessionMessage[] }).messages ?? [];
}

function workingNotes(seed: string): string {
  const start = seed.indexOf('## Working notes');
  const end = seed.indexOf('\n## ', start + 1);
  return start < 0 ? '' : seed.slice(start, end < 0 ? undefined : end);
}

describe('S4q: tail budget the tail leaves unused goes to the dense notes', () => {
  // 400 assistant notes, each with its own identifiers, give the dense selector far more than it can keep.
  const history: SessionMessage[] = Array.from({ length: 400 }, (_, i) => [
    { role: 'user' as const, text: `step ${i}: continue with module ${i}`, toolUses: [] },
    { role: 'assistant' as const, text: `Updated src/mod${i}/handler${i}.ts: renamed parseItem${i} to readItem${i}, test count ${1000 + i} in commit c0ffee${String(i).padStart(4, '0')}.`, toolUses: [] },
  ]).flat();

  it('a short tail lets the notes grow past DENSE_BUDGET_TOKENS while the total stays in budget', async () => {
    // The newest prompt is too large to fit the tail, so only the short reply after it is kept.
    const messages = [...history, { role: 'user' as const, text: `please review ${'x '.repeat(20_000)}`, toolUses: [] }, { role: 'assistant' as const, text: 'Reviewed.', toolUses: [] }];
    const out = await compact(messages);
    const seed = out[0]?.text ?? '';
    const tail = out.slice(1);
    expect(serializedTokens(tail, countTokens)).toBeLessThan(100);
    expect(countTokens(workingNotes(seed))).toBeGreaterThan(DENSE_BUDGET_TOKENS + 1000);
    expect(countTokens(seed)).toBeGreaterThan(SEED_BUDGET_TOKENS);
    expect(countTokens(seed) + serializedTokens(tail, countTokens)).toBeLessThanOrEqual(TOTAL_BUDGET_TOKENS);
    // The seed cap grows with the spill too, so the reducible sections are not emptied to make room.
    expect(seed).toContain('step 399: continue with module 399');
  });

  it('a full tail leaves the notes at DENSE_BUDGET_TOKENS', async () => {
    const out = await compact(history);
    const seed = out[0]?.text ?? '';
    expect(countTokens(workingNotes(seed))).toBeLessThanOrEqual(DENSE_BUDGET_TOKENS + 200);
    expect(countTokens(seed)).toBeLessThanOrEqual(SEED_BUDGET_TOKENS + Math.max(0, 7000 - serializedTokens(out.slice(1), countTokens)));
  });
});
