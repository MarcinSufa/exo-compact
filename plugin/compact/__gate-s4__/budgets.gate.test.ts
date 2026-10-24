import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadImpl } from './impl.js';
import { countTokens, humanPrompt } from './fixtures/helpers.js';
import type { SessionMessage } from '../core/types.js';
import type {
  checkBudget as CheckBudget,
  resolveOverflow as ResolveOverflow,
  serializedTokens as SerializedTokens,
  BudgetCheck,
} from '../core/budgets.js';

let checkBudget: typeof CheckBudget;
let resolveOverflow: typeof ResolveOverflow;
let serializedTokens: typeof SerializedTokens;
let SEED_BUDGET_TOKENS: number;
let TAIL_BUDGET_TOKENS: number;
let TOTAL_BUDGET_TOKENS: number;
let KEY_FACTS_BUDGET_TOKENS: number;
let DENSE_BUDGET_TOKENS: number;
let JEV_PER_CALL_TIMEOUT_MS: number;
let JEV_TOTAL_BUDGET_MS: number;
let JEV_BATCH_MAX_TOKENS: number;
let JEV_QUERY_FIELD_MAX_TOKENS: number;
let JEV_QUERY_MAX_TOKENS: number;

beforeAll(async () => {
  const impl = await loadImpl<{
    checkBudget: typeof CheckBudget;
    resolveOverflow: typeof ResolveOverflow;
    serializedTokens: typeof SerializedTokens;
    SEED_BUDGET_TOKENS: number;
    TAIL_BUDGET_TOKENS: number;
    TOTAL_BUDGET_TOKENS: number;
    KEY_FACTS_BUDGET_TOKENS: number;
    DENSE_BUDGET_TOKENS: number;
    JEV_PER_CALL_TIMEOUT_MS: number;
    JEV_TOTAL_BUDGET_MS: number;
    JEV_BATCH_MAX_TOKENS: number;
    JEV_QUERY_FIELD_MAX_TOKENS: number;
    JEV_QUERY_MAX_TOKENS: number;
  }>('budgets');
  ({ checkBudget, resolveOverflow, serializedTokens, SEED_BUDGET_TOKENS, TAIL_BUDGET_TOKENS, TOTAL_BUDGET_TOKENS, KEY_FACTS_BUDGET_TOKENS, DENSE_BUDGET_TOKENS, JEV_PER_CALL_TIMEOUT_MS, JEV_TOTAL_BUDGET_MS, JEV_BATCH_MAX_TOKENS, JEV_QUERY_FIELD_MAX_TOKENS, JEV_QUERY_MAX_TOKENS } = impl);
});

describe('budgets: fixed constants (spec §3.1)', () => {
  it('seed 6k, dense notes 3k, tail 7k, total cap 13k (S4o replay table)', () => {
    expect(SEED_BUDGET_TOKENS).toBe(6000);
    expect(DENSE_BUDGET_TOKENS).toBe(3000);
    expect(TAIL_BUDGET_TOKENS).toBe(7000);
    expect(TOTAL_BUDGET_TOKENS).toBe(13000);
  });

  it('key facts get their own 1500-token budget, carved out of the seed budget up front (spec v3.3 §3.1.3, round 17)', () => {
    expect(KEY_FACTS_BUDGET_TOKENS).toBe(1500);
    expect(KEY_FACTS_BUDGET_TOKENS).toBeLessThan(SEED_BUDGET_TOKENS);
  });

  /**
   * review-opus-s4b-r2.md F5: the 1500ms default was sized for a 4k-char prompt; a live batch can
   * approach 32k tokens (JEV_BATCH_MAX_TOKENS), so a per-call timeout this tight makes a real
   * batch time out and fall back to D, making the A-J arm look like A-D for reasons that have
   * nothing to do with Jev's own decisions. 4000ms is still comfortably inside the 10s hard total
   * (JEV_TOTAL_BUDGET_MS), so a single slow call cannot on its own exhaust the whole run's budget.
   */
  it('the per-call timeout default is 4000ms, well under the 10s hard total (review-opus-s4b-r2.md F5)', () => {
    expect(JEV_PER_CALL_TIMEOUT_MS).toBe(4000);
    expect(JEV_PER_CALL_TIMEOUT_MS).toBeLessThan(JEV_TOTAL_BUDGET_MS);
  });

  // 4.7.5: the manifest said 1500, the limit the review above had called too short, while the code said 4000.
  it('4.7.5: the manifest and docs/configuration.md give the same per-call default as the code', () => {
    const manifest = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')) as {
      userConfig?: Record<string, { type?: string; default?: unknown }>;
    };
    expect(manifest.userConfig?.jevPerCallTimeoutMs?.type).toBe('number');
    expect(manifest.userConfig?.jevPerCallTimeoutMs?.default).toBe(JEV_PER_CALL_TIMEOUT_MS);
    const docs = readFileSync(new URL('../../../docs/configuration.md', import.meta.url), 'utf8');
    expect(docs).toContain(`| \`jevPerCallTimeoutMs\` | number | \`${JEV_PER_CALL_TIMEOUT_MS}\` |`);
  });

  /**
   * brief-s4b-fix4.md item 1: calibration A-J-0 found the harness's own prompts run ~50KB pastes;
   * three uncapped `lastUserMessages` entries alone cost ~37k tokens, already over
   * JEV_BATCH_MAX_TOKENS (32000) before a single span or any per-question overhead was added. 400
   * tokens per field keeps even 3 capped messages plus contract/todo comfortably under
   * JEV_QUERY_MAX_TOKENS (4000), which itself stays well under JEV_BATCH_MAX_TOKENS so a batch with
   * even one small question still has room to be sent.
   */
  it('the per-field query cap is 400 tokens, and the resulting query stays well under the 4000-token query cap, itself well under the 32k batch cap', () => {
    expect(JEV_QUERY_FIELD_MAX_TOKENS).toBe(400);
    expect(JEV_QUERY_MAX_TOKENS).toBe(4000);
    // contract + todo + up to 3 lastUserMessages entries, each capped at JEV_QUERY_FIELD_MAX_TOKENS,
    // plus JSON overhead, must still fit JEV_QUERY_MAX_TOKENS.
    expect(JEV_QUERY_FIELD_MAX_TOKENS * 5).toBeLessThan(JEV_QUERY_MAX_TOKENS);
    expect(JEV_QUERY_MAX_TOKENS).toBeLessThan(JEV_BATCH_MAX_TOKENS);
  });
});

describe('budgets: checkBudget', () => {
  it('ok when seed, tail and total are all within their own budgets', () => {
    const result: BudgetCheck = checkBudget(5000, 7000);
    expect(result.ok).toBe(true);
    expect(result.withinSeedBudget).toBe(true);
    expect(result.withinTailBudget).toBe(true);
    expect(result.withinTotalBudget).toBe(true);
  });

  // S4q (3.17.0): the seed may use what the tail leaves unused, so with the tail inside its budget a
  // seed over SEED_BUDGET_TOKENS + spill is always also over TOTAL_BUDGET_TOKENS.
  it('not ok when the seed exceeds SEED_BUDGET_TOKENS plus the tail spill', () => {
    const result = checkBudget(SEED_BUDGET_TOKENS + 1001, TAIL_BUDGET_TOKENS - 1000);
    expect(result.withinSeedBudget, 'the seed may only grow by what the tail left unused').toBe(false);
    expect(result.ok).toBe(false);
    expect(checkBudget(SEED_BUDGET_TOKENS + 1, TAIL_BUDGET_TOKENS).ok, 'a full tail leaves no spill').toBe(false);
  });

  it('S4q: ok when the seed uses exactly what the tail left unused', () => {
    const result = checkBudget(SEED_BUDGET_TOKENS + 1000, TAIL_BUDGET_TOKENS - 1000);
    expect(result.ok).toBe(true);
    expect(result.totalTokens).toBe(TOTAL_BUDGET_TOKENS);
  });

  it('not ok when the tail alone exceeds TAIL_BUDGET_TOKENS', () => {
    const result = checkBudget(SEED_BUDGET_TOKENS - 1000, TAIL_BUDGET_TOKENS + 1);
    expect(result.withinTailBudget).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('not ok when the total exceeds TOTAL_BUDGET_TOKENS even with each half individually in range', () => {
    const result = checkBudget(SEED_BUDGET_TOKENS, TAIL_BUDGET_TOKENS + 5000);
    expect(result.ok).toBe(false);
  });
});

describe('budgets: serializedTokens', () => {
  it('counts tool-result text as well as message text', () => {
    const messages: SessionMessage[] = [
      humanPrompt('hi'),
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'x', text: 'result body', isError: false }] },
    ];
    const total = serializedTokens(messages, countTokens);
    expect(total).toBe(countTokens('hi') + countTokens('result body'));
  });
});

describe('budgets: cost accounting must not double-count tool output (finding 6)', () => {
  it('a tool result mirrored on both the call\'s toolUses[].text and its own toolResults[].text is counted once', () => {
    const mirroredText = 'result body';
    const messages: SessionMessage[] = [
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'x', tool: 'Read', text: mirroredText }], handle: 'h1' },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'x', text: mirroredText, isError: false }] },
    ];
    const total = serializedTokens(messages, countTokens);
    expect(total).toBe(countTokens(mirroredText));
  });
});

describe('budgets: deterministic overflow', () => {
  it('drops ids in a fixed order, the same on every run', () => {
    const tokensById = new Map([
      ['a', 3000],
      ['b', 2500],
      ['c', 2000],
    ]);
    const ids = ['a', 'b', 'c'];
    const first = resolveOverflow(ids, tokensById, 4000);
    const second = resolveOverflow(ids, tokensById, 4000);
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
  });

  it('never drops an id whose cumulative cost still fits the budget', () => {
    const tokensById = new Map([
      ['a', 1000],
      ['b', 1000],
    ]);
    const dropped = resolveOverflow(['a', 'b'], tokensById, 5000);
    expect(dropped).toEqual([]);
  });
});
