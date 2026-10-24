import type { SessionMessage } from '../../core/types.js';
import type { TailOptions, TailResult } from '../../core/tail.js';

/**
 * Spec §3.1: a human prompt is `role: 'user'`, non-empty `text`, and no `toolResults`.
 */
export function isHumanPrompt(message: Pick<SessionMessage, 'role' | 'text' | 'toolResults'>): boolean {
  return message.role === 'user' && message.text.length > 0 && (message.toolResults ?? []).length === 0;
}

/** Round 14 (spec v3.2.2 §3.1): same fragment core/tail.ts uses to drop a thinking-only
 * assistant message from the tail. Carried over unchanged so this variant does not spuriously
 * fail the round 14 thinking-drop tests, which are not what `S4_GATE_IMPL=broken-pairs` exists to
 * discriminate. */
function isThinkingOnlyFragment(message: SessionMessage): boolean {
  return message.role === 'assistant' && message.text.length === 0 && message.toolUses.length === 0;
}

/** Round 16 (spec v3.2.3 F4, brief-s4a-fix16.md): carried over unchanged from core/tail.ts, same
 * reasoning as `isThinkingOnlyFragment` above -- F4 is not what `broken-pairs` exists to
 * discriminate. */
function isEmptyUserFragment(message: SessionMessage): boolean {
  return message.role === 'user' && message.text.length === 0 && (message.toolResults ?? []).length === 0;
}

/**
 * Mutation-proof defect (brief-s4a-gate.md deliverable 3, "pair split"): a raw suffix budget
 * walk over message indices with no pairing check. It skips (does not stop at) any message
 * that would overflow the remaining budget, so a cheaper older message can still be picked up
 * after a costlier one in between was dropped. A `tool_use` message's own text is normally
 * empty (its real cost lives in `toolUses[].input`, which this accounting never counts), so a
 * call can slip back into the tail for free after its paired result was skipped for being too
 * large, or after only some of a parallel-call group's results fit, producing an orphan.
 *
 * Round 14: the rebuild-without-handle step below is now a straight copy of `core/tail.ts`'s
 * (trigger-aware `keepHandleIndex`, full rebuild of every other message, thinking-only-fragment
 * drop) so this variant's *only* discriminating difference from `core/tail.ts` stays the pairing
 * defect described above, not the round 14 rebuild rule -- GATE.md documents `broken-pairs` as
 * isolating the pairing invariant alone, with every other tail.gate.test.ts assertion staying
 * green against it.
 *
 * Round 16 (brief-s4a-fix16.md F1): deliberately NOT updated to core/tail.ts's multi-fragment
 * `exemptIndices` run (a contiguous scan back from the last assistant index). `keepHandleIndex`
 * below stays the old, single-index rule on purpose, per the brief's own instruction that
 * "broken-pairs must be red against the old behaviour" for the new F1 mid-tool-loop tests -- this
 * is the one round where this file's otherwise-strict "mirror core, isolate only pairing" contract
 * (see the paragraph above) is intentionally not extended to a brand new rule the moment it lands,
 * so the new tests have a real red baseline to prove they discriminate against. F4 and F5 (empty
 * user fragment drop, thinking-only exclusion from `omittedCount`) ARE carried over unchanged
 * below, same as every prior round's fragment-drop rules, since the brief does not ask for those to
 * go red here.
 */
export function pickTail(messages: readonly SessionMessage[], options: TailOptions): TailResult {
  let lastAssistantIndex = -1;
  messages.forEach((message, index) => { if (message.role === 'assistant') lastAssistantIndex = index; });
  const keepHandleIndex = options.trigger === 'auto' ? lastAssistantIndex : -1;

  const picked: { message: SessionMessage; rebuilt: boolean }[] = [];
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const messageTokens = options.countTokens(message.text) + (message.toolResults ?? []).reduce(
      (sum, r) => sum + options.countTokens(r.text),
      0,
    );
    if (tokens + messageTokens > options.budgetTokens) continue;
    tokens += messageTokens;
    picked.unshift(rebuild(message, i, keepHandleIndex, options));
  }
  let droppedEmptyUserCount = 0;
  const kept = picked.filter((entry) => {
    if (isThinkingOnlyFragment(entry.message)) return false; // not counted (F5)
    if (isEmptyUserFragment(entry.message)) { droppedEmptyUserCount += 1; return false; } // counted (F4)
    return true;
  });
  const budgetCutCount = messages.length - picked.length;

  return {
    messages: kept.map((entry) => entry.message),
    rebuiltCount: kept.filter((entry) => entry.rebuilt).length,
    omittedCount: budgetCutCount + droppedEmptyUserCount,
  };
}

function rebuild(
  message: SessionMessage,
  index: number,
  keepHandleIndex: number,
  options: TailOptions,
): { message: SessionMessage; rebuilt: boolean } {
  if (index === keepHandleIndex) return { message, rebuilt: false };
  if (!(message.toolResults ?? []).length) return { message: { role: message.role, text: message.text, toolUses: message.toolUses }, rebuilt: true };
  const toolResults = message.toolResults!.map((r) =>
    options.countTokens(r.text) > options.rebuildThresholdTokens
      ? { tool_use_id: r.tool_use_id, isError: r.isError, text: `[pointer tool_use_id=${r.tool_use_id} sha256=${options.hash(r.text)}]` }
      : r,
  );
  return { message: { role: message.role, text: message.text, toolUses: message.toolUses, toolResults }, rebuilt: true };
}
