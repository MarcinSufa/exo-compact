import { describe, it, expect, beforeAll } from 'vitest';
import { loadImpl } from './impl.js';
import type { select as Select, SelectCandidate, SelectQuery } from '../core/select.js';

let select: typeof Select;

beforeAll(async () => {
  ({ select } = await loadImpl<{ select: typeof Select }>('select'));
});

function query(overrides: Partial<SelectQuery> = {}): SelectQuery {
  return { contract: 'contract text', todo: 'todo text', lastUserMessages: [], ...overrides };
}

function candidate(overrides: Partial<SelectCandidate> = {}): SelectCandidate {
  return { id: 'c', tokens: 100, alwaysKeep: false, valueDensity: 1, recency: 1, ...overrides };
}

describe('selector D: deterministic order for equal input', () => {
  it('same candidates, query and budget yield the same order on every call', () => {
    const candidates: SelectCandidate[] = [
      candidate({ id: 'a', valueDensity: 3, recency: 1 }),
      candidate({ id: 'b', valueDensity: 5, recency: 2 }),
      candidate({ id: 'c', valueDensity: 1, recency: 3 }),
    ];
    const first = select(candidates, query(), 1000);
    const second = select(candidates, query(), 1000);
    expect(second).toEqual(first);
  });
});

describe('selector D: always-kept candidates', () => {
  it('a user-origin/value-carrying candidate is kept even with the lowest score and a tight budget', () => {
    const candidates: SelectCandidate[] = [
      candidate({ id: 'high-score', tokens: 90, valueDensity: 100, recency: 10, alwaysKeep: false }),
      candidate({ id: 'always-keep-low-score', tokens: 90, valueDensity: 0, recency: 0, alwaysKeep: true }),
    ];
    const picked = select(candidates, query(), 90);
    expect(picked, 'an always-keep candidate must never be dropped for budget').toContain('always-keep-low-score');
  });
});

describe('selector D: budget respected', () => {
  it('never returns more tokens of non-always-keep candidates than the budget allows', () => {
    const candidates: SelectCandidate[] = [
      candidate({ id: 'a', tokens: 400, valueDensity: 3, recency: 1 }),
      candidate({ id: 'b', tokens: 400, valueDensity: 2, recency: 1 }),
      candidate({ id: 'c', tokens: 400, valueDensity: 1, recency: 1 }),
    ];
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const picked = select(candidates, query(), 900);
    const totalTokens = picked.reduce((sum, id) => sum + (byId.get(id)?.tokens ?? 0), 0);
    expect(totalTokens).toBeLessThanOrEqual(900);
  });
});

describe('selector D: ties broken by recency', () => {
  it('given equal valueDensity, the more recent candidate is kept when only one fits', () => {
    const candidates: SelectCandidate[] = [
      candidate({ id: 'older', tokens: 100, valueDensity: 5, recency: 1 }),
      candidate({ id: 'newer', tokens: 100, valueDensity: 5, recency: 2 }),
    ];
    const picked = select(candidates, query(), 100);
    expect(picked).toEqual(['newer']);
  });
});
