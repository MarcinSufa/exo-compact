
/**
 * One item competing for a slot in the seed (spec §3.3, same interface as v2 §3.3, two
 * interchangeable selectors behind `select(candidates, query, budget) -> ordered ids`; this is
 * selector D, deterministic).
 */
export interface SelectCandidate {
  id: string;
  tokens: number;
  /**
   * True for a `user`-origin record, or any record carrying a captured `value` (spec §3.3
   * "always kept by both selectors, whatever the score"). Never dropped for budget.
   */
  alwaysKeep: boolean;
  /** Ranking key for everything not `alwaysKeep` (spec §3.3 D: "ranked by user origin, then value density, then recency"). */
  valueDensity: number;
  /** Higher is more recent; breaks a `valueDensity` tie (spec §5.1 "ties broken by recency"). */
  recency: number;
}

export interface SelectQuery {
  contract: string;
  todo: string;
  lastUserMessages: readonly string[];
}

/**
 * The ranking order every non-mandatory candidate competes in (spec §3.3 D: "ranked by user
 * origin, then value density, then recency"; spec §5.1 "ties broken by recency"), exported so
 * selector J (`core/select-j.ts`) can fill its own `keep_verbatim` budget in the exact same order
 * D uses (review-opus-s4b.md B3: the two selectors must be directly comparable in an A-D vs A-J
 * run, which requires more than sharing D's own keep/drop decision as J's fallback -- the order
 * spans are packed into the shared budget must match too, or an over-budget keep set silently
 * favors whichever selector fills oldest-first while the other fills by rank).
 */
export function compareBySelectOrder(a: SelectCandidate, b: SelectCandidate): number {
  return b.valueDensity - a.valueDensity || b.recency - a.recency || a.id.localeCompare(b.id);
}

/**
 * Deterministic selector D (spec §3.3, v2 §3.3 D unchanged): every `alwaysKeep` candidate is
 * kept regardless of score or budget; the rest is ranked by `valueDensity` descending, ties
 * broken by `recency` descending, and taken in that order until `budgetTokens` (counting every
 * kept candidate's `tokens`, always-kept ones included) is spent. Same input, same output,
 * every run (spec §5.1 "deterministic order for equal input").
 */
export function select(
  candidates: readonly SelectCandidate[],
  _query: SelectQuery,
  budgetTokens: number,
): string[] {
  const mandatory = candidates.filter((candidate) => candidate.alwaysKeep);
  const ranked = candidates.filter((candidate) => !candidate.alwaysKeep).sort(compareBySelectOrder);
  const picked = mandatory.map((candidate) => candidate.id);
  let used = mandatory.reduce((sum, candidate) => sum + candidate.tokens, 0);
  for (const candidate of ranked) {
    if (used + candidate.tokens <= budgetTokens) { picked.push(candidate.id); used += candidate.tokens; }
  }
  return picked;
}
