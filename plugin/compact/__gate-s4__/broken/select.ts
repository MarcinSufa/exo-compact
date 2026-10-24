import type { SelectCandidate, SelectQuery } from '../../core/select.js';

/**
 * Mutation-proof defect (spec §3.3 "always kept by both selectors, whatever the score"):
 * `alwaysKeep` is never honored, every candidate competes for the budget on rank alone, so a
 * low-value-density always-keep candidate is dropped exactly like any other candidate once the
 * budget runs out. Determinism, budget respect and recency tie-break are otherwise correct, so
 * the family still discriminates on this one defect instead of failing wholesale.
 */
export function select(
  candidates: readonly SelectCandidate[],
  _query: SelectQuery,
  budgetTokens: number,
): string[] {
  const ranked = [...candidates].sort((a, b) => b.valueDensity - a.valueDensity || b.recency - a.recency);
  const picked: string[] = [];
  let used = 0;
  for (const candidate of ranked) {
    if (used + candidate.tokens > budgetTokens) continue;
    picked.push(candidate.id);
    used += candidate.tokens;
  }
  return picked;
}
