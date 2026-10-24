import { isSeedMessage } from './sentinel.js';
import type { SessionMessage } from './types.js';

/**
 * Refusal guard (3.11.0). On real sessions the API safety classifier sometimes rejects the
 * context an S4 cut leaves behind: the first reply after the seed is stopped, the agent retries
 * the same call, and every later request with that seed in context is refused too (replayed
 * 2/2 on a fork of the flagged session, 2026-09-29). Native compaction never showed this. So a
 * refusal of the main loop's first reply after an S4 cut, with that seed still in context, turns
 * S4 off for the rest of the session: the next cut, the one `/compact` starts, goes to native
 * compaction and replaces the seed.
 */
export const REFUSAL_GUARD_FILE = 's4-disabled.json';

/** The harness's text for a refused request, the answer of a turn that ended on it. */
const REFUSAL_TEXT = /safeguards flagged this message/i;

/**
 * Written `open` by a successful S4 cut and `answered` by the main loop's next answered turn:
 * the guard only acts while it reads `open`, so a refusal many turns after a cut (caused by the
 * conversation, not the seed) never turns S4 off.
 */
export const FRESH_CUT_FILE = 's4-cut-fresh.json';
export const FRESH_CUT_OPEN = 'open';
export const FRESH_CUT_ANSWERED = 'answered';

export interface TurnEnd {
  reason: string;
  answer?: string;
  refusal?: { category: string | null; explanation: string | null };
}

export function isClassifierRefusal(turn: TurnEnd): boolean {
  if (turn.reason === 'refusal') return true;
  return turn.reason === 'error' && REFUSAL_TEXT.test(turn.answer ?? '');
}

/** True when the conversation as it reads now still carries an S4 seed. */
export function hasLiveSeed(messages: readonly Pick<SessionMessage, 'role' | 'text'>[]): boolean {
  return messages.some((message) => isSeedMessage(message));
}

export interface RefusalGuardState {
  reason: 'classifier_refusal';
  category: string | null;
  at: string;
}

export function renderRefusalGuardState(turn: TurnEnd, at: string): string {
  const state: RefusalGuardState = { reason: 'classifier_refusal', category: turn.refusal?.category ?? null, at };
  return JSON.stringify(state);
}

/** Shown beneath the refused turn's answer, once, when the guard trips. */
export const REFUSAL_GUARD_NOTICE = 'exo-compact: the API refused this context after an S4 cut. S4 is now off for this session. Run /compact to replace the seed with a native summary; if that is refused too, start a new session.';
