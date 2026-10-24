import type { SessionMessage, TokenCounter } from './types.js';

/** Spec §3.1: primary carry, 8k/20k is a calibration-only cell (not this contract). */
export const SEED_BUDGET_TOKENS = 6000;
export const DENSE_BUDGET_TOKENS = 3000;
/** S4r: reject only near-certain noise; Jev scores otherwise reorder dense candidates. */
export const DENSE_JEV_GATE = 0.1;
/** S4r: additive floor keeps low-scored candidates eligible for the existing greedy ranking. */
export const DENSE_JEV_FLOOR = 0.05;
// The 2026-09-30 S4o replay table reaches native coverage at native-sized seed + tail.
export const TAIL_BUDGET_TOKENS = 7000;
export const TOTAL_BUDGET_TOKENS = 13000;
/**
 * 3.46.0 (S4zt): default total when budgets count real tokens (estimateTokens). The 13000 chars / 4 total held
 * ~25k real tokens on w17 (w60e/w60f); hook replay of those 29 cuts kept all 29 with the plugin at 20000 real
 * (seed + tail ~40k chars instead of ~50k), 28/29 at 18000, 12/29 at 16000.
 */
export const REAL_TOTAL_BUDGET_TOKENS = 20000;

/**
 * Spec v3.3 §3.1.3 (round 17, brief-s4a-fix17.md): key facts get their own fixed budget, carved
 * out of `SEED_BUDGET_TOKENS` up front (like constraints' own overflow budget), not left to
 * compete with the reasoning sections for whatever room the reduction order leaves behind — the
 * brief is explicit that "reasoning budget must account for it".
 */
export const KEY_FACTS_BUDGET_TOKENS = 1500;
export const WORK_STATE_BUDGET_TOKENS = 700;
/** The session map: one line per earlier compaction segment (core/session-map.ts). */
export const SESSION_MAP_BUDGET_TOKENS = 900;

/** Spec §3.1: a tool-result body over this size is rebuilt with a pointer instead. */
export const REBUILD_THRESHOLD_TOKENS = 2000;

/** Spec §5.1 "shrink check counting re-injection": fallback floor on the reduction ratio. */
export const MIN_REDUCTION_RATIO = 0.25;

/** Spec v3.4 §3.3 J: "Jev's request limit is 32k tokens, so the candidate set is sent in batches". */
export const JEV_BATCH_MAX_TOKENS = 32000;

/** Spec v3.4 §3.3 J: "a total budget of 10 s, then D for the rest". */
export const JEV_TOTAL_BUDGET_MS = 10000;

/**
 * Spec v3.4.3 §3.3 J: per-call timeout, one Jev batch request. review-opus-s4b-r2.md F5: 1500ms
 * was sized for a 4k-char prompt; a live batch can approach the 32k-token JEV_BATCH_MAX_TOKENS
 * limit, so 1500ms let a real batch time out and fall back to D for reasons that had nothing to
 * do with Jev's own decisions, making A-J look like A-D. 4000ms stays well inside the 10s hard
 * total (JEV_TOTAL_BUDGET_MS), so one slow call still cannot exhaust a whole run's budget alone.
 */
export const JEV_PER_CALL_TIMEOUT_MS = 4000;

/**
 * Spec v3.4.4 §3.3 J (brief-s4b-fix4.md item 1): fixed per-field token budget applied to each
 * `SelectQuery` field `selectJ` sends to Jev (`contract`, `todo`, and every `lastUserMessages`
 * entry) before building any request. Calibration A-J-0 (real evidence,
 * `/tmp/s4c-A-J-0-CnyNCC/.exovault/s4-capture/.../segment-000001.json`) found the harness's own
 * prompts run ~50KB pastes; `compact.ts:172` passed `lastUserMessages: userHistory.slice(-3)`
 * unbounded, so three such messages alone cost ~37k uncapped tokens -- already over
 * `JEV_BATCH_MAX_TOKENS` (32000) before a single span or any per-question overhead was added, so
 * `planJevBatches`'s own `overhead.queryTokens + cost > maxBatchTokens` check was true for every
 * span regardless of its own size: every real session's J arm silently fell back to D for 100% of
 * spans with zero Jev calls ever made (`compact.jev_units=0`, no fetch, all three real
 * compactions in the repro). 400 tokens keeps even 3 user messages plus contract/todo comfortably
 * under `JEV_QUERY_MAX_TOKENS` below.
 */
export const JEV_QUERY_FIELD_MAX_TOKENS = 400;

/**
 * Spec v3.4.4 §3.3 J (brief-s4b-fix4.md item 1): documents the budget `JEV_QUERY_FIELD_MAX_TOKENS`
 * is sized to stay under once every query field is capped (contract + todo + up to 3
 * `lastUserMessages` entries, JSON overhead included) -- well under `JEV_BATCH_MAX_TOKENS` so a
 * batch with even a single, smallest question still has room to be sent. `selectJ`
 * (core/select-j.ts) checks the actual capped-query overhead against `deps.maxBatchTokens` at call
 * time (item 2, source `'query-too-large'`), not against this constant directly; a gate test
 * proves the two constants' relationship holds.
 */
export const JEV_QUERY_MAX_TOKENS = 4000;

export interface BudgetCheck {
  seedTokens: number;
  tailTokens: number;
  totalTokens: number;
  withinSeedBudget: boolean;
  withinTailBudget: boolean;
  withinTotalBudget: boolean;
  ok: boolean;
}

/**
 * 3.43.0: token estimate for the kept tail. `chars / 4` holds for prose only; tool output (logs, hex
 * ids, JSON, code, paths) runs about 2 chars per token, so a tail sized with it was up to twice its
 * budget (ctxbench 2026-10-02: 27k chars kept against a 7k budget, 24.5k context after each cut vs
 * native 14k; 52 real transcripts on this box: `chars / 4` gave 0.40 of the API's count, this 0.75,
 * the rest being content the messages do not carry). Chars per token falls with the share of digits,
 * punctuation, non-ASCII and whitespace runs, clamped to [2, 4], so prose still costs `chars / 4`
 * and nothing is counted lower than before. 3.46.0 (S4zt): the handler counts every budget with it
 * (seed, tail, total); 3.43.0 used it for the tail only (reverted in 3.43.2).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let dense = 0;
  let previousSpace = false;
  let runStarted = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const space = code === 32 || code === 9 || code === 10 || code === 13;
    if (space) {
      if (previousSpace && !runStarted) { dense += 1; runStarted = true; }
    } else {
      runStarted = false;
      const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
      if (!letter) dense += 1; // digits, punctuation, non-ASCII
    }
    previousSpace = space;
  }
  const charsPerToken = Math.min(4, Math.max(2, 6.5 - 28 * (dense / text.length)));
  return Math.ceil(text.length / charsPerToken);
}

/** Sums `countTokens(text)` over the serialized shape the engine receives, not just `.text`. */
export function serializedTokens(
  messages: readonly SessionMessage[],
  countTokens: TokenCounter,
): number {
  return messages.reduce((sum, message) => sum + countTokens(message.text) + message.toolUses.reduce((n, tool) => n + (tool.input === undefined ? 0 : countTokens(JSON.stringify(tool.input) ?? '')), 0) + (message.toolResults ?? []).reduce((n, result) => n + countTokens(result.text), 0), 0);
}

/**
 * S4q (3.17.0): tail budget the picked tail leaves unused. The tail often stops far below its
 * budget because the next older message is too large to fit (a long Write, a big result), and in
 * the 2026-09-30 replay a quarter of cuts kept under 500 tail tokens. The unused part goes to the
 * dense notes and the seed cap, so the total stays within TOTAL_BUDGET_TOKENS. Replay on agent-used
 * items: 57.8% -> 61.8% (native 56.1%).
 */
export function tailSpillTokens(tailTokens: number, tailBudgetTokens: number = TAIL_BUDGET_TOKENS): number {
  return Math.max(0, tailBudgetTokens - tailTokens);
}

/** 3.32.0: seed, dense and tail budgets scaled from one total (option `totalBudgetTokens`); the default total gives the constants. */
export interface Budgets { seed: number; dense: number; tail: number; total: number }
export function scaledBudgets(totalTokens: number = TOTAL_BUDGET_TOKENS): Budgets {
  const total = Number.isFinite(totalTokens) && totalTokens >= 2000 ? Math.round(totalTokens) : TOTAL_BUDGET_TOKENS;
  const scale = total / TOTAL_BUDGET_TOKENS;
  const tail = Math.round(TAIL_BUDGET_TOKENS * scale);
  return { seed: total - tail, dense: Math.round(DENSE_BUDGET_TOKENS * scale), tail, total };
}

/**
 * Checks the seed against SEED_BUDGET_TOKENS plus the tail spill, the tail against TAIL_BUDGET_TOKENS, and
 * their sum against TOTAL_BUDGET_TOKENS. Must be pure and deterministic: same input,
 * same output, run to run (spec §5.1 "deterministic overflow").
 */
export function checkBudget(seedTokens: number, tailTokens: number, budgets: Budgets = scaledBudgets()): BudgetCheck {
  const totalTokens = seedTokens + tailTokens;
  const withinSeedBudget = seedTokens <= budgets.seed + tailSpillTokens(tailTokens, budgets.tail);
  const withinTailBudget = tailTokens <= budgets.tail;
  const withinTotalBudget = totalTokens <= budgets.total;
  return { seedTokens, tailTokens, totalTokens, withinSeedBudget, withinTailBudget, withinTotalBudget, ok: withinSeedBudget && withinTailBudget && withinTotalBudget };
}

/**
 * When mandatory user values alone exceed SEED_BUDGET_TOKENS, decides what is dropped, in a
 * fixed, reproducible order (spec §5.1 "deterministic overflow when mandatory user values
 * exceed the seed budget"). Returns the ids to drop, oldest-lowest-priority first.
 */
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

/** 4.6.0 (S5f): the "Since the card" seed section, the steps after the task card's horizon (core/since-card.ts). */
export const SINCE_CARD_BUDGET_TOKENS = 500;
/** 4.6.0 (S5f): step lines of the since-card that survive the first shrink; only the final floor drops them. */
export const SINCE_CARD_KEEP = 3;
