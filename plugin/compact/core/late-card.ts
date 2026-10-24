import { isSeedMessage } from './extractor.js';
import type { SinceCardSteps } from './since-card.js';
import type { TaskCardState } from './task-card.js';
import type { SessionMessage } from './types.js';

/**
 * 4.7.0 (CONTRACT S5j): a second, late task-card refresh and the card's age line in the seed. The once-per-stretch
 * refresh fires at CARD_CUT_SHARE (60%, about 150k of a 250k window); the cut comes at about 218k. In an audit of 21
 * judged cuts the card's "Next step" was 1-5 rounds behind in 12, with a median card age of 53 minutes and 40 tool
 * calls at the cut, and the sessions then spent 3-7 search calls to find the current step. A refresh at 85% is a second
 * background fork per cut cycle (same model and prompt cache) that brings the card within a few calls of the cut.
 */

/** The late refresh opens at this share of the compaction window (212k of 250k; the cut follows within a few turns). */
export const CARD_LATE_SHARE = 0.85;
/**
 * The card must be older than this many tool calls. The since-card list covers a median 4 calls (it lists them anyway), so
 * a card 15 calls old is well past that and stale in Done and Next step; the audit's median was 40. A fork on a 210k
 * context costs about what the 60% one does, so a fresher card is not worth a fork.
 */
export const CARD_LATE_MIN_CALLS = 15;

/**
 * The late step: due once per stretch, after the stretch's own refresh ran, past CARD_LATE_SHARE of the window, when the
 * card is more than CARD_LATE_MIN_CALLS tool calls old. `callsSince` is the number of calls after the card's horizon.
 * The caller runs this after `cardRefreshDue` said nothing was due (that one also detects a cut and resets `lateDone`).
 */
export function lateRefreshDue(state: TaskCardState, tokens: number, windowTokens: number, callsSince: number): { due: boolean; state: TaskCardState } {
  if (!(tokens > 0) || !(windowTokens > 0) || state.stretchDone !== true || state.lateDone === true) return { due: false, state };
  if (tokens < windowTokens * CARD_LATE_SHARE || callsSince < CARD_LATE_MIN_CALLS) return { due: false, state };
  return { due: true, state: { ...state, lastTokens: tokens, refreshes: state.refreshes + 1, lateDone: true } };
}

/**
 * How many tool calls came after the card's horizon call (the horizon itself excluded: its result may be the card's last
 * input). A horizon that is not in `messages` (none, or one from before an earlier cut) counts every call after the last
 * seed message.
 */
export function countToolCallsSince(messages: readonly SessionMessage[], horizonId: string | undefined): number {
  let start = 0;
  let skip = 0;
  const horizonIndex = horizonId === undefined ? -1 : messages.findIndex((message) => message.toolUses.some((use) => use.tool_use_id === horizonId));
  if (horizonIndex >= 0) {
    start = horizonIndex;
    skip = messages[horizonIndex].toolUses.findIndex((use) => use.tool_use_id === horizonId) + 1;
  } else messages.forEach((message, index) => { if (isSeedMessage(message)) start = index + 1; });
  let count = 0;
  for (let index = start; index < messages.length; index += 1) {
    if (isSeedMessage(messages[index])) continue;
    count += messages[index].toolUses.length - (index === start ? skip : 0);
  }
  return count;
}

/**
 * The one age line for the task card section: how many tool calls (the calls the tail shows left out) lie between the card's
 * horizon and the kept messages. '' when the "Since the card" section is in the seed (it says the same, step by step), when the
 * card has no horizon, or when no call lies between.
 */
export function cardAgeLine(steps: SinceCardSteps, sinceSectionShown: boolean): string {
  if (sinceSectionShown || steps.horizon === 'missing' || steps.total === 0) return '';
  if (steps.predates) return '(card written before the last cut; the messages below are newer)';
  return `(card written ${steps.total} tool call${steps.total === 1 ? '' : 's'} before the kept messages; the messages below are newer)`;
}
