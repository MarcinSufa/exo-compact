import type { SessionMessage } from '../../core/types.js';
import type { TailOptions, TailResult } from '../../core/tail.js';

/**
 * `core/tail.ts` now stubs this out too (the implementer owns all core logic), so the broken
 * variant carries its own working copy instead of re-exporting a throwing stub.
 * Spec §3.1: a human prompt is `role: 'user'`, non-empty `text`, and no `toolResults`.
 */
export function isHumanPrompt(message: Pick<SessionMessage, 'role' | 'text' | 'toolResults'>): boolean {
  return message.role === 'user' && message.text.length > 0 && (message.toolResults ?? []).length === 0;
}

/**
 * Mutation-proof defect (brief-s4a-gate.md deliverable 3; round 14 / spec v3.2.2 update:
 * "one that keeps handles", brief-s4a-fix14.md's own example of a regression the gate must
 * catch): `options.trigger` is never consulted and a message is only ever rebuilt when it has an
 * oversized tool result, regardless of position. So under `manual`/`plugin` this keeps the handle
 * on every message whose results all fit under `rebuildThresholdTokens` -- exactly the pre-round-14
 * "handled by default" behaviour spec v3.2.2 replaced -- and under `auto` it can leave more than
 * the one exempted last-assistant-turn message handled. It also never drops a thinking-only
 * fragment. Trimming by raw token budget from the newest message backward is otherwise correct
 * (message-atomic, so pair-atomicity holds) so unrelated assertions in the same family still pass.
 */
export function pickTail(messages: readonly SessionMessage[], options: TailOptions): TailResult {
  const lastAssistantIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i].role === 'assistant') return i;
    return -1;
  })();

  const picked: SessionMessage[] = [];
  let tokens = 0;
  let startIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const callTokens = message.toolUses.reduce((sum, t) => sum + (t.text === undefined ? 0 : options.countTokens(t.text)), 0);
    const messageTokens = options.countTokens(message.text) + callTokens + (message.toolResults ?? []).reduce(
      (sum, r) => sum + options.countTokens(r.text),
      0,
    );
    if (tokens + messageTokens > options.budgetTokens && picked.length > 0) break;
    tokens += messageTokens;
    picked.unshift(rebuildIfOversized(message, i, lastAssistantIndex, options));
    startIndex = i;
  }

  return {
    messages: picked,
    rebuiltCount: picked.filter((m, idx) => m.handle === undefined && messages[startIndex + idx]?.handle !== undefined).length,
    omittedCount: startIndex,
  };
}

function rebuildIfOversized(
  message: SessionMessage,
  _index: number,
  _lastAssistantIndex: number,
  options: TailOptions,
): SessionMessage {
  const oversized = (message.toolResults ?? []).some((r) => options.countTokens(r.text) > options.rebuildThresholdTokens);
  if (!oversized) return message;
  return {
    role: message.role,
    text: message.text,
    toolUses: message.toolUses,
    toolResults: message.toolResults?.map((r) =>
      options.countTokens(r.text) > options.rebuildThresholdTokens
      ? { ...r, text: `[pointer tool_use_id=${r.tool_use_id} sha256=${options.hash(options.hash(r.text))}]` }
        : r,
    ),
  };
}
