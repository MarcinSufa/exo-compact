import type { CompactTrigger, Hasher, SessionMessage, TokenCounter } from './types.js';
import { isSeedMessage } from './sentinel.js';

/**
 * Spec §3.1: a human prompt is `role: 'user'`, non-empty `text`, and no `toolResults`.
 * Role alone is not a boundary because tool results also live in user-role messages.
 */
export function isHumanPrompt(message: Pick<SessionMessage, 'role' | 'text' | 'toolResults'>): boolean {
  return message.role === 'user' && message.text.length > 0 && (message.toolResults ?? []).length === 0;
}

export interface TailOptions {
  budgetTokens: number;
  countTokens: TokenCounter;
  hash: Hasher;
  /** Body over this many tokens is rebuilt with a pointer (spec §3.1, `REBUILD_THRESHOLD_TOKENS`). */
  rebuildThresholdTokens: number;
  /**
   * The compaction trigger. Since the resume cache fix (2026-10-15) it no longer changes the
   * tail: every message is rebuilt without a handle under every trigger (see `pickTail`). Kept
   * so callers pass what they know.
   */
  trigger: CompactTrigger;
}

export interface TailResult {
  /** The picked tail, oldest first. */
  messages: SessionMessage[];
  /** How many messages of `messages` were rebuilt (lost their handle) instead of kept whole. */
  rebuiltCount: number;
  /**
   * How many leading messages of the input were cut, plus any dropped empty (image/non-text-only)
   * user fragment (spec v3.2.3 F4, a real, counted loss of history). Round 16 (spec v3.2.3 F5,
   * brief-s4a-fix16.md): a dropped thinking-only fragment is NOT counted here any more -- it never
   * held anything the omitted-history pointer's "search the transcript" instruction could usefully
   * find (the plugin never sees the thinking block itself, so there is nothing to search for), and
   * counting it inflated the marker's `k` past what a Grep over the transcript can account for.
   */
  omittedCount: number;
}

/** True for an assistant fragment whose only content was a thinking block: no visible text and
 * no tool call. The plugin never sees the thinking block itself (cc.d.ts's `SessionMessage` has
 * no such field), so this is exactly how one now presents once rebuilt. Never emitted (spec
 * v3.2.2 §3.1, review-opus-r10.md B2 investigation run 4: "drop assistant messages with empty
 * text and no toolUses in the plugin anyway, to be safe"). */
function isThinkingOnlyFragment(message: SessionMessage): boolean {
  return message.role === 'assistant' && message.text.length === 0 && message.toolUses.length === 0;
}

/**
 * True for a `user` fragment with nothing this type can carry forward: no text and no
 * `toolResults` (spec v3.2.3 F4, round 16, brief-s4a-fix16.md). This is exactly the shape an
 * image-only (or otherwise non-text-only) human prompt takes: `SessionMessage.text` is "its text
 * blocks joined; '' when it has none" (types/cc.d.ts:7470-7496) and the type has no field at all
 * for a non-text content block, so a rebuild of such a message can only ever produce `{ role:
 * 'user', text: '', toolUses: [] }` -- an empty user turn with no indication anything was ever
 * there. Never emitted as a tail message; dropped instead, with a counted omission (unlike a
 * thinking-only fragment, spec v3.2.3 F5): this is a real prompt whose content genuinely could not
 * be carried forward, not an invisible-by-design internal artifact.
 */
function isEmptyUserFragment(message: SessionMessage): boolean {
  return message.role === 'user' && message.text.length === 0 && (message.toolResults ?? []).length === 0;
}

/**
 * Rebuilds `messages` without handles, one message per API turn (resume cache fix, 2026-10-15). The
 * engine hands one API message over as one `SessionMessage` per content block (a thinking-only
 * fragment, a text fragment, one fragment per tool call), with no user message between them, so
 * a run of adjacent assistant fragments is one turn: its texts are joined in order by a blank
 * line and its tool calls concatenated. Rebuilt one by one instead, parallel calls became
 * separate assistant messages followed by one results message, and the engine's pairing check
 * inserted synthetic tool results for all but the last. `starts[i]` is the index in `messages`
 * of the first fragment of turn `i`; `starts[turns.length]` is `messages.length`.
 */
function rebuildTurns(messages: readonly SessionMessage[]): { turns: SessionMessage[]; starts: number[] } {
  const turns: SessionMessage[] = [];
  const starts: number[] = [];
  messages.forEach((message, index) => {
    const previous = turns.at(-1);
    if (message.role === 'assistant' && previous?.role === 'assistant') {
      previous.text = [previous.text, message.text].filter((text) => text.length > 0).join('\n\n');
      previous.toolUses = [...previous.toolUses, ...message.toolUses];
      return;
    }
    starts.push(index);
    turns.push(message.toolResults === undefined ? { role: message.role, text: message.text, toolUses: [...message.toolUses] } : { role: message.role, text: message.text, toolUses: [...message.toolUses], toolResults: message.toolResults });
  });
  starts.push(messages.length);
  return { turns, starts };
}

/**
 * Picks the tail under `options.budgetTokens` (spec §3.1, tail-rebuild rule per v3.2.2):
 * - pair-atomic: never starts on a `toolResults` message whose `tool_use` is outside the
 *   tail, never contains a `tool_use` whose result is outside it; parallel calls move as
 *   one unit; an unresolved call stays with its assistant message;
 * - prefers to start at a human prompt; if the newest exchange alone exceeds the budget,
 *   starts at the newest pair-atomic boundary inside that exchange;
 * - **rebuilt without handle, under every trigger (resume cache fix 2026-10-15, supersedes
 *   v3.2.2's `auto` exception and v3.2.3 F1):** every returned message is rebuilt from `role`, `text` and the
 *   tool blocks, with no `handle`, so the engine writes each one back with a fresh id. A handled
 *   message keeps its original `message.id`, which then sits on both sides of the compact
 *   boundary; on `--resume`/`--resume --fork-session` the engine regroups every fragment with
 *   that id and replays pre-cut content (a duplicated text block, or a thinking block the kept
 *   copy no longer has), so the resumed request no longer matches the live one and the prompt
 *   cache misses down to system + tools. The `auto` exception kept the last assistant turn
 *   handled for the thinking an open tool loop might need; live runs with adaptive thinking
 *   continued an open loop without it (no 400), while the exception cost a cache miss on 17 of
 *   18 resumes after a mid-loop cut in the A/B. Adjacent assistant fragments are merged into one
 *   message per turn first (`rebuildTurns`). A rebuilt tool-result body over
 *   `rebuildThresholdTokens` is further replaced by a pointer.
 * - a turn that is nothing but thinking (no text, no tool blocks once merged) is dropped from
 *   the tail entirely, never returned as an empty-text assistant message; same for an empty
 *   (image/non-text-only) `user` fragment (v3.2.3 F4).
 * - `omittedCount` counts messages of the input, not merged turns.
 */
export function pickTail(input: readonly SessionMessage[], options: TailOptions): TailResult {
  if (!input.length) return { messages: [], rebuiltCount: 0, omittedCount: 0 };
  const { turns: messages, starts: inputStarts } = rebuildTurns(input);
  const usePositions = new Map<string, number>();
  const resultPositions = new Map<string, number>();
  messages.forEach((message, index) => {
    for (const use of message.toolUses) usePositions.set(use.tool_use_id, index);
    for (const result of message.toolResults ?? []) resultPositions.set(result.tool_use_id, index);
  });
  const originalResultCosts = messages.map((message) => (message.toolResults ?? []).map((result) => options.countTokens(result.text)));
  const rebuiltMessages = messages.map((message, index) => {
    if (!(message.toolResults ?? []).length) return message;
    const toolResults = message.toolResults!.map((result, resultIndex) => {
      if (originalResultCosts[index][resultIndex] <= options.rebuildThresholdTokens) return result;
      const digest = options.hash(result.text);
      // S1 (review-opus-r10.md): the pointer names the tool_use_id, which is greppable in the
      // transcript JSONL, instead of a line number in `event.messages` that has no relation to
      // any line in the transcript file (a live example put "line=5" for a result that was
      // actually on line 22).
      return { tool_use_id: result.tool_use_id, isError: result.isError, text: `[pointer tool_use_id=${result.tool_use_id} sha256=${digest}]` };
    });
    return { role: message.role, text: message.text, toolUses: message.toolUses, toolResults };
  });
  const costs = rebuiltMessages.map((message, index) => options.countTokens(message.text) + message.toolUses.reduce((sum, tool) => sum + (tool.input === undefined ? 0 : options.countTokens(JSON.stringify(tool.input) ?? '')), 0) + (message.toolResults ?? []).reduce((sum, result, resultIndex) => sum + (message === messages[index] ? originalResultCosts[index][resultIndex] : options.countTokens(result.text)), 0));
  const suffixCosts = new Array<number>(messages.length + 1).fill(0);
  const valid = new Array<boolean>(messages.length).fill(true);
  let minPairPosition = Number.POSITIVE_INFINITY;
  let invalidResult = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    suffixCosts[index] = suffixCosts[index + 1] + costs[index];
    const message = messages[index];
    for (const result of message.toolResults ?? []) {
      const useIndex = usePositions.get(result.tool_use_id);
      if (useIndex === undefined) invalidResult = true;
      else minPairPosition = Math.min(minPairPosition, useIndex);
    }
    for (const use of message.toolUses) {
      const resultIndex = resultPositions.get(use.tool_use_id);
      if (resultIndex !== undefined) minPairPosition = Math.min(minPairPosition, resultIndex);
    }
    valid[index] = !invalidResult && minPairPosition >= index;
  }
  const starts = messages.map((_, index) => index).filter((index) => !isSeedMessage(messages[index]) && valid[index]);
  const fitting = starts.filter((start) => suffixCosts[start] <= options.budgetTokens);
  // A human-prompt start is preferred only while it still uses at least half the budget. An
  // auto-compaction usually fires right after the user's newest prompt; when the turn before it
  // was over budget, that prompt is the only fitting prompt start, and preferring it would drop
  // all of the work just before the cut (real 14-cut session: tails of 8-700 tokens of 7000).
  const promptStarts = fitting.filter((start) => isHumanPrompt(messages[start]) && suffixCosts[start] * 2 >= options.budgetTokens);
  const chosen = (promptStarts.length ? promptStarts : fitting)[0] ?? starts.at(-1) ?? messages.length;
  let droppedEmptyUserCount = 0;
  const kept = rebuiltMessages.slice(chosen).filter((message) => {
    if (isThinkingOnlyFragment(message)) return false; // not counted in omittedCount (F5)
    if (isEmptyUserFragment(message)) { droppedEmptyUserCount += 1; return false; } // counted (F4)
    return true;
  });
  return { messages: kept, rebuiltCount: kept.length, omittedCount: inputStarts[chosen] + droppedEmptyUserCount };
}
