import { JEV_BATCH_MAX_TOKENS, JEV_PER_CALL_TIMEOUT_MS, JEV_TOTAL_BUDGET_MS, JEV_QUERY_FIELD_MAX_TOKENS, JEV_QUERY_MAX_TOKENS, KEY_FACTS_BUDGET_TOKENS, REBUILD_THRESHOLD_TOKENS, SEED_BUDGET_TOKENS, TAIL_BUDGET_TOKENS, TOTAL_BUDGET_TOKENS } from '../../core/budgets.js';
import type { BudgetCheck } from '../../core/budgets.js';
import type { SessionMessage, TokenCounter } from '../../core/types.js';

// review-opus-s4b-r2.md: correct, kept unmodified -- these constants carry no seeded defect, so
// this file re-exports the real ones instead of duplicating them. brief-s4b-fix4.md item 1 adds
// JEV_QUERY_FIELD_MAX_TOKENS and JEV_QUERY_MAX_TOKENS to this same re-export list, same reasoning.
export { JEV_BATCH_MAX_TOKENS, JEV_PER_CALL_TIMEOUT_MS, JEV_TOTAL_BUDGET_MS, JEV_QUERY_FIELD_MAX_TOKENS, JEV_QUERY_MAX_TOKENS, KEY_FACTS_BUDGET_TOKENS, REBUILD_THRESHOLD_TOKENS, SEED_BUDGET_TOKENS, TAIL_BUDGET_TOKENS, TOTAL_BUDGET_TOKENS };

/**
 * Mutation-proof defect (finding 6): adds `toolUses[].text` on top of `message.text` and
 * `toolResults[].text`, so a tool result mirrored on both the call and its own result is
 * counted twice.
 */
export function serializedTokens(messages: readonly SessionMessage[], countTokens: TokenCounter): number {
  return messages.reduce((sum, message) => {
    const callText = message.toolUses.reduce((s, t) => s + (t.text === undefined ? 0 : countTokens(t.text)), 0);
    const resultText = (message.toolResults ?? []).reduce((s, r) => s + countTokens(r.text), 0);
    return sum + countTokens(message.text) + callText + resultText;
  }, 0);
}

/**
 * Mutation-proof defect: only checks the total against `TOTAL_BUDGET_TOKENS`, never the seed
 * or the tail against their own budgets, so a seed that alone blows `SEED_BUDGET_TOKENS` is
 * reported `ok` as long as the tail is small enough to keep the sum under 18k.
 */
export function checkBudget(seedTokens: number, tailTokens: number): BudgetCheck {
  const totalTokens = seedTokens + tailTokens;
  const ok = totalTokens <= TOTAL_BUDGET_TOKENS;
  return {
    seedTokens,
    tailTokens,
    totalTokens,
    withinSeedBudget: ok,
    withinTailBudget: ok,
    withinTotalBudget: ok,
    ok,
  };
}

export function resolveOverflow(
  mandatoryIds: readonly string[],
  tokensById: ReadonlyMap<string, number>,
  budgetTokens: number,
): string[] {
  let used = 0;
  const dropped: string[] = [];
  for (const id of mandatoryIds) {
    const tokens = tokensById.get(id) ?? 0;
    if (used + tokens > budgetTokens) dropped.push(id);
    else used += tokens;
  }
  return dropped;
}
