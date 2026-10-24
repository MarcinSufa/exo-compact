import { describe, it, expect } from 'vitest';
import { cardRefreshDue, parseTaskCardState, type TaskCardState } from '../core/task-card.js';
import { CARD_LATE_MIN_CALLS, CARD_LATE_SHARE, cardAgeLine, countToolCallsSince, lateRefreshDue } from '../core/late-card.js';
import { collectSinceCard } from '../core/since-card.js';
import { SEED_SENTINEL } from '../core/sentinel.js';
import type { SessionMessage } from '../core/types.js';

/** 4.7.0 (CONTRACT S5j): a second, late card refresh near the cut, and the card's age line in the seed. */

const WINDOW = 250_000;
const afterEarly: TaskCardState = { lastTokens: 150_000, refreshes: 3, stretchDone: true };

function call(id: string, tool = 'Bash'): SessionMessage {
  return { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input: { command: 'ls' } }] };
}
const calls = (n: number, from = 0): SessionMessage[] => Array.from({ length: n }, (_, i) => call(`t${from + i}`));

describe('4.7.0 (S5j) lateRefreshDue', () => {
  it('is due past the late share with a card older than the call threshold, and spends the step', () => {
    expect(CARD_LATE_SHARE).toBe(0.85);
    expect(CARD_LATE_MIN_CALLS).toBe(15);
    const step = lateRefreshDue(afterEarly, 0.85 * WINDOW, WINDOW, 15);
    expect(step.due).toBe(true);
    expect(step.state).toEqual({ lastTokens: 0.85 * WINDOW, refreshes: 4, stretchDone: true, lateDone: true });
  });
  it.each([
    ['below the share', 0.85 * WINDOW - 1, 40],
    ['a card with fewer calls than the threshold', 0.9 * WINDOW, 14],
  ])('is not due for %s', (_name, tokens, callsSince) => {
    const step = lateRefreshDue(afterEarly, tokens, WINDOW, callsSince);
    expect(step.due).toBe(false);
    expect(step.state).toBe(afterEarly);
  });
  it('is not due before the stretch refresh ran (the 60% step covers that), or after the late one ran', () => {
    expect(lateRefreshDue({ lastTokens: 0, refreshes: 0 }, 0.9 * WINDOW, WINDOW, 99).due).toBe(false);
    expect(lateRefreshDue({ ...afterEarly, lateDone: true }, 0.9 * WINDOW, WINDOW, 99).due).toBe(false);
  });
  it('is not due without usable numbers', () => {
    expect(lateRefreshDue(afterEarly, 0, WINDOW, 99).due).toBe(false);
    expect(lateRefreshDue(afterEarly, 200_000, 0, 99).due).toBe(false);
  });
  it('a cut opens a new stretch: lateDone is cleared, and the state round-trips', () => {
    const cutState = cardRefreshDue({ ...afterEarly, lateDone: true, lastTokens: 215_000 }, 30_000, WINDOW).state;
    expect(cutState.lateDone).toBeUndefined();
    expect(cutState.stretchDone).toBe(false);
    expect(parseTaskCardState(JSON.stringify({ lastTokens: 1, refreshes: 2, stretchDone: true, lateDone: true }))).toEqual({ lastTokens: 1, refreshes: 2, stretchDone: true, lateDone: true });
    expect(parseTaskCardState(JSON.stringify({ lastTokens: 1, refreshes: 2 }))).toEqual({ lastTokens: 1, refreshes: 2 });
  });
  it('leaves cardRefreshDue as it was: nothing late is ever due from it', () => {
    expect(cardRefreshDue(afterEarly, 0.9 * WINDOW, WINDOW).due).toBe(false);
  });
});

describe('4.7.0 (S5j) countToolCallsSince', () => {
  it('counts the calls after the horizon call, not the horizon itself', () => {
    expect(countToolCallsSince([...calls(3), ...calls(20, 3)], 't2')).toBe(20);
  });
  it('counts every call of the segment when the horizon is not in it or there is none', () => {
    expect(countToolCallsSince(calls(7), 'gone')).toBe(7);
    expect(countToolCallsSince(calls(7), undefined)).toBe(7);
  });
  it('starts after the last seed message when the horizon predates a cut', () => {
    const seed: SessionMessage = { role: 'user', text: `${SEED_SENTINEL}\nx`, toolUses: [] };
    expect(countToolCallsSince([...calls(30), seed, ...calls(5, 30)], 'gone')).toBe(5);
  });
  it('counts calls after the horizon in the same message too', () => {
    const both: SessionMessage = { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: {} }, { tool_use_id: 'b', tool: 'Read', input: {} }, { tool_use_id: 'c', tool: 'Read', input: {} }] };
    expect(countToolCallsSince([both], 'a')).toBe(2);
  });
});

describe('4.7.0 (S5j) cardAgeLine', () => {
  const messages = [...calls(2), ...calls(3, 2)];
  it('says how many tool calls the card is behind the kept messages', () => {
    const steps = collectSinceCard(messages, 't1', new Set());
    expect(cardAgeLine(steps, false)).toBe('(card written 4 tool calls before the kept messages; the messages below are newer)');
    expect(cardAgeLine(collectSinceCard(messages, 't4', new Set()), false)).toBe('(card written 1 tool call before the kept messages; the messages below are newer)');
  });
  it('leaves the calls the tail shows out of the count', () => {
    expect(cardAgeLine(collectSinceCard(messages, 't1', new Set(['t3', 't4'])), false)).toContain('card written 2 tool calls');
  });
  it('is empty when the "Since the card" section already says it, with no horizon, or with nothing between', () => {
    expect(cardAgeLine(collectSinceCard(messages, 't1', new Set()), true)).toBe('');
    expect(cardAgeLine(collectSinceCard(messages, undefined, new Set()), false)).toBe('');
    expect(cardAgeLine(collectSinceCard(messages, 't1', new Set(['t1', 't2', 't3', 't4'])), false)).toBe('');
  });
  it('says the card predates the last cut when its horizon is gone', () => {
    expect(cardAgeLine(collectSinceCard(messages, 'gone', new Set()), false)).toBe('(card written before the last cut; the messages below are newer)');
  });
});
