import { describe, it, expect, beforeAll } from 'vitest';
import { loadImpl } from './impl.js';
import {
  assistantCall,
  assistantParallelCalls,
  assistantText,
  countTokens,
  humanPrompt,
  resetFixtureIds,
  sha256,
  toolResultsMessage,
} from './fixtures/helpers.js';
import { SEED_SENTINEL, omittedHistoryMarker } from '../core/sentinel.js';
import type { CompactTrigger, SessionMessage } from '../core/types.js';
import type { pickTail as PickTail, isHumanPrompt as IsHumanPrompt, TailOptions } from '../core/tail.js';

let pickTail: typeof PickTail;
let isHumanPrompt: typeof IsHumanPrompt;

beforeAll(async () => {
  ({ pickTail, isHumanPrompt } = await loadImpl<{ pickTail: typeof PickTail; isHumanPrompt: typeof IsHumanPrompt }>('tail'));
});

// Round 14 (spec v3.2.2): most tests below exercise the pair-atomic cut/cost-accounting logic,
// which is orthogonal to which trigger drove the compaction. Default to 'auto'; since the resume cache fix (2026-10-15) no
// trigger keeps a handle (auto-tail-rebuild.gate.test.ts). Tests that are actually about the
// rebuild-without-handle rule itself pass `trigger` explicitly.
function options(overrides: Partial<TailOptions> = {}): TailOptions {
  return {
    budgetTokens: 10000,
    countTokens,
    hash: sha256,
    rebuildThresholdTokens: 2000,
    trigger: 'auto',
    ...overrides,
  };
}

function toolUseIdsIn(message: SessionMessage): string[] {
  return message.toolUses.map((t) => t.tool_use_id);
}
function toolResultIdsIn(message: SessionMessage): string[] {
  return (message.toolResults ?? []).map((r) => r.tool_use_id);
}

/** True if some message in `tail` carries a `toolUses`/`toolResults` entry for `id`. */
function tailHasToolUse(tail: SessionMessage[], id: string): boolean {
  return tail.some((message) => toolUseIdsIn(message).includes(id));
}
function tailHasToolResult(tail: SessionMessage[], id: string): boolean {
  return tail.some((message) => toolResultIdsIn(message).includes(id));
}

/** Spec §3.1 pair-atomic invariant, checked against the picked tail alone. */
function assertPairAtomic(tail: SessionMessage[]): void {
  const usesInTail = new Set(tail.flatMap(toolUseIdsIn));
  const resultsInTail = new Set(tail.flatMap(toolResultIdsIn));
  for (const message of tail) {
    for (const id of toolResultIdsIn(message)) {
      expect(usesInTail.has(id), `pair-atomic: tail has a tool_result (${id}) whose tool_use is outside the tail`).toBe(true);
    }
  }
  const lastMessage = tail[tail.length - 1];
  const isLastAssistantWithCalls = lastMessage?.role === 'assistant' && lastMessage.toolUses.length > 0;
  for (const message of tail) {
    for (const id of toolUseIdsIn(message)) {
      const resolvedAnywhere = resultsInTail.has(id);
      const isUnresolvedLastCall = isLastAssistantWithCalls && message === lastMessage;
      expect(
        resolvedAnywhere || isUnresolvedLastCall,
        `pair-atomic: tail has a tool_use (${id}) whose result is outside the tail and it is not the trailing unresolved call`,
      ).toBe(true);
    }
  }
}

describe('tail picker: human-prompt definition', () => {
  it('role user, non-empty text, no toolResults is a human prompt', () => {
    expect(isHumanPrompt(humanPrompt('hello'))).toBe(true);
  });
  it('role user with toolResults is not a human prompt even with text', () => {
    expect(isHumanPrompt({ ...toolResultsMessage([{ toolUseId: 'toolu_x' }]), text: 'hi' })).toBe(false);
  });
  it('empty text is not a human prompt', () => {
    expect(isHumanPrompt(humanPrompt(''))).toBe(false);
  });
  it('assistant role is never a human prompt', () => {
    expect(isHumanPrompt(assistantText('hello'))).toBe(false);
  });
});

describe('tail picker: pair-atomic cut', () => {
  it('never contains an orphan tool_result or an orphan resolved tool_use', () => {
    resetFixtureIds();
    const call = assistantCall('Bash');
    const result = toolResultsMessage([{ toolUseId: call.toolUses[0].tool_use_id }]);
    const messages: SessionMessage[] = [
      humanPrompt('do the first thing'),
      assistantText('ok, done'),
      humanPrompt('do the second thing'),
      call,
      result,
      assistantText('done with the second thing too'),
    ];
    const budgetForHalfTheExchange = countTokens(messages[2].text) + countTokens(call.text) + 1;
    const tail = pickTail(messages, options({ budgetTokens: budgetForHalfTheExchange })).messages;
    assertPairAtomic(tail);
  });

  it('parallel tool calls move as one unit', () => {
    resetFixtureIds();
    const calls = assistantParallelCalls([{ tool: 'Read' }, { tool: 'Grep' }, { tool: 'Bash' }]);
    const results = toolResultsMessage(calls.toolUses.map((t) => ({ toolUseId: t.tool_use_id })));
    const messages: SessionMessage[] = [humanPrompt('go'), calls, results, assistantText('wrapped up')];
    const tail = pickTail(messages, options({ budgetTokens: countTokens(calls.text) + 1 })).messages;
    assertPairAtomic(tail);
    // Round 14: every message but the trailing assistant turn is rebuilt into a fresh object, so
    // "is the call group in the tail" must be checked by tool_use_id, not by object identity.
    const callIds = calls.toolUses.map((t) => t.tool_use_id);
    const hasAnyCall = callIds.some((id) => tailHasToolUse(tail, id));
    if (hasAnyCall) {
      expect(callIds.every((id) => tailHasToolResult(tail, id)), 'a parallel-call group must move with all its results, not partially').toBe(true);
    }
  });

  it('an unresolved call (no result anywhere) stays with its assistant message when it is the last message', () => {
    resetFixtureIds();
    const call = assistantCall('Bash');
    const messages: SessionMessage[] = [humanPrompt('go'), call];
    const tail = pickTail(messages, options({ budgetTokens: 10000 })).messages;
    // Resume cache fix (2026-10-15): rebuilt without its handle like every other tail message, even as the last turn.
    expect(tail[tail.length - 1]).toEqual({ role: 'assistant', text: '', toolUses: call.toolUses });
    assertPairAtomic(tail);
  });

  it('error results are kept intact, not split from their call', () => {
    resetFixtureIds();
    const call = assistantCall('Bash');
    const result = toolResultsMessage([{ toolUseId: call.toolUses[0].tool_use_id, options: { isError: true, text: 'boom' } }]);
    const messages: SessionMessage[] = [humanPrompt('go'), call, result, assistantText('recovered')];
    const tail = pickTail(messages, options({ budgetTokens: 10000 })).messages;
    assertPairAtomic(tail);
    const callId = call.toolUses[0].tool_use_id;
    // The budget is generous (10000) so the whole exchange must be in the tail; check by id since
    // `call` itself is rebuilt (it is not the trailing assistant turn here).
    expect(tailHasToolUse(tail, callId), 'the call must be in the tail').toBe(true);
    expect(tailHasToolResult(tail, callId), 'its result must travel with it, never split off').toBe(true);
  });

  it('prefers to start at a human prompt', () => {
    resetFixtureIds();
    const messages: SessionMessage[] = [
      humanPrompt('older'),
      assistantText('older reply'),
      humanPrompt('newest prompt'),
      assistantText('newest reply'),
    ];
    const budget = countTokens(messages[2].text) + countTokens(messages[3].text) + 1;
    const tail = pickTail(messages, options({ budgetTokens: budget })).messages;
    // Round 14: `tail[0]` is rebuilt (it is not the trailing assistant turn), so identity is
    // gone; its role/text content is not.
    expect(tail[0].role).toBe('user');
    expect(tail[0].text).toBe(messages[2].text);
  });

  it('does not shrink to the newest prompt alone when the work before it fits (auto-compaction fires right after a prompt)', () => {
    resetFixtureIds();
    const call = assistantCall('Bash');
    const result = toolResultsMessage([{ toolUseId: call.toolUses[0].tool_use_id, options: { text: 'r'.repeat(1500) } }]);
    const messages: SessionMessage[] = [
      humanPrompt(`older ask ${'o'.repeat(8000)}`),
      call,
      result,
      assistantText(`findings ${'f'.repeat(1500)}`),
      humanPrompt('newest prompt'),
    ];
    const tail = pickTail(messages, options({ budgetTokens: 2000 })).messages;
    assertPairAtomic(tail);
    expect(tail.at(-1)!.text).toBe('newest prompt');
    expect(tail.some((message) => message.text.startsWith('findings')), 'the work just before the cut stays in the tail').toBe(true);
    expect(tail.some((message) => message.text.startsWith('older ask')), 'the over-budget older prompt is not forced in').toBe(false);
  });

  it('one giant exchange over budget starts at the newest pair-atomic boundary inside it, never mid-pair', () => {
    resetFixtureIds();
    const call = assistantCall('Bash');
    const hugeResult = toolResultsMessage([{ toolUseId: call.toolUses[0].tool_use_id, options: { text: 'x'.repeat(80000) } }]);
    const messages: SessionMessage[] = [humanPrompt('one giant ask'), call, hugeResult, assistantText('final answer')];
    const tail = pickTail(messages, options({ budgetTokens: 500 })).messages;
    assertPairAtomic(tail);
  });
});

describe('tail picker: cost accounting must not double-count tool output (finding 6)', () => {
  it('a mirrored tool result (present on both the call\'s toolUses[].text and the paired toolResults[].text) is counted once, so content that truly fits is not dropped', () => {
    resetFixtureIds();
    const mirroredText = 'x'.repeat(4000);
    const call = assistantCall('Read', { text: mirroredText });
    const result = toolResultsMessage([{ toolUseId: call.toolUses[0].tool_use_id, options: { text: mirroredText } }]);
    const messages: SessionMessage[] = [humanPrompt('go'), call, result, assistantText('done')];
    const trueCost = countTokens(messages[0].text) + countTokens(mirroredText) + countTokens(messages[3].text);
    const tail = pickTail(messages, options({ budgetTokens: trueCost + 50 })).messages;
    const callId = call.toolUses[0].tool_use_id;
    expect(tailHasToolUse(tail, callId), 'the call/result pair fits once its shared content is counted once, must stay in the tail').toBe(true);
    expect(tailHasToolResult(tail, callId)).toBe(true);
  });

  it('a start fits once an oversized-but-rebuildable result is rebuilt to a pointer; fit must be checked after rebuild, not on raw pre-rebuild sizes', () => {
    resetFixtureIds();
    const call = assistantCall('Read');
    const oversized = 'x'.repeat(3000 * 4);
    const result = toolResultsMessage([{ toolUseId: call.toolUses[0].tool_use_id, options: { text: oversized } }]);
    const messages: SessionMessage[] = [
      humanPrompt('first ask'),
      call,
      result,
      assistantText('summarized it'),
      humanPrompt('second ask'),
      assistantText('short reply'),
    ];
    const tail = pickTail(messages, options({ budgetTokens: 3000, rebuildThresholdTokens: 2000 })).messages;
    expect(
      tail[0].role,
      'the first exchange fits under budget once its oversized result is rebuilt to a small pointer; excluding it from `fitting` on raw pre-rebuild size wrongly drops the first exchange',
    ).toBe('user');
    expect(tail[0].text).toBe(messages[0].text);
  });
});

describe('tail picker: never includes a seed message (finding 14)', () => {
  it('a leading seed message is excluded even when the whole transcript fits at index 0', () => {
    resetFixtureIds();
    const seed = humanPrompt(`${SEED_SENTINEL}\ncontract...\n${omittedHistoryMarker(12)}`);
    const messages: SessionMessage[] = [seed, humanPrompt('continue please'), assistantText('ok, continuing')];
    const tail = pickTail(messages, options({ budgetTokens: 100000 })).messages;
    expect(tail.some((message) => message === seed || message.text.startsWith(SEED_SENTINEL))).toBe(false);
  });
});

it('processes 1600 large tool-result messages in under one second', () => {
  resetFixtureIds();
  const messages: SessionMessage[] = [humanPrompt('inspect all tools')];
  for (let index = 0; index < 799; index += 1) {
    const call = assistantCall('Read');
    messages.push(call, toolResultsMessage([{ toolUseId: call.toolUses[0].tool_use_id, options: { text: 'x'.repeat(10000) } }]));
  }
  messages.push(assistantText('all reads complete'));
  const start = performance.now();
  let hashes = 0;
  const result = pickTail(messages, options({ budgetTokens: 100000000, hash: (text) => { hashes += 1; return sha256(text); } }));
  const elapsed = performance.now() - start;
  expect(result.messages.length).toBeGreaterThan(0);
  expect(hashes, 'each oversized result selected for rebuilding must be hashed at most once').toBeLessThanOrEqual(799);
  expect(elapsed, `1600-message tail took ${elapsed.toFixed(1)}ms`).toBeLessThan(1000);
});

/**
 * Round 14 (spec v3.2.2 §3.1, "tail messages are rebuilt without handle"; review-opus-r10.md's B2
 * investigation): a handled tail message keeps its original engine `message.id`. On `--resume`/
 * `--resume --fork-session`, the engine regroups assistant fragments by that id across the whole
 * transcript file, not only along the post-boundary parentUuid chain, which pulls the
 * pre-compaction fragments (and their full tool results) back into the resumed request and can
 * trigger `ensureToolResultPairing` plus a "thinking cannot be modified" 400. The proven fix
 * (review's scratch one-line change, `compact.ts:106` at the time): hand back every tail message
 * without `handle` for `manual`/`plugin` triggers, so the engine always writes a fresh id. The resume cache
 * fix (2026-10-15) extends this to `auto`: the last assistant turn used to keep its handle there, and that one
 * id on both sides of the boundary cost a prompt-cache miss on resume
 * (auto-tail-rebuild.gate.test.ts).
 */
describe('tail picker: v3.2.2 rebuild-without-handle', () => {
  it.each<CompactTrigger>(['manual', 'plugin'])('%s: every tail message loses its handle, oversized or not, including the trailing assistant turn', (trigger) => {
    resetFixtureIds();
    const call = assistantCall('Read');
    const result = toolResultsMessage([{ toolUseId: call.toolUses[0].tool_use_id, options: { text: 'small, well under the rebuild threshold' } }]);
    const messages: SessionMessage[] = [humanPrompt('read the file'), call, result, assistantText('done')];
    const tail = pickTail(messages, options({ budgetTokens: 100000, trigger })).messages;
    expect(tail.length).toBeGreaterThan(0);
    for (const message of tail) {
      expect(message.handle, `${trigger}: every tail message must lose its handle, got ${JSON.stringify(message)}`).toBeUndefined();
    }
    assertPairAtomic(tail);
  });

  it('auto (resume cache fix): no message keeps its handle, the last assistant turn included', () => {
    resetFixtureIds();
    const call = assistantCall('Read');
    const result = toolResultsMessage([{ toolUseId: call.toolUses[0].tool_use_id, options: { text: 'small' } }]);
    const messages: SessionMessage[] = [humanPrompt('read the file'), call, result, assistantText('final answer')];
    const tail = pickTail(messages, options({ budgetTokens: 100000, trigger: 'auto' })).messages;
    expect(tail.filter((message) => message.handle !== undefined)).toEqual([]);
    expect(tail.at(-1)).toEqual({ role: 'assistant', text: 'final answer', toolUses: [] });
  });

  it('auto (resume cache fix): an open call and its oversized result both lose their handles; the result still becomes a pointer', () => {
    resetFixtureIds();
    const call = assistantCall('Read');
    const oversized = 'x'.repeat(3000 * 4);
    const result = toolResultsMessage([{ toolUseId: call.toolUses[0].tool_use_id, options: { text: oversized } }]);
    const messages: SessionMessage[] = [humanPrompt('read the big file'), call, result];
    const tail = pickTail(messages, options({ budgetTokens: 100000, rebuildThresholdTokens: 2000, trigger: 'auto' })).messages;
    const callId = call.toolUses[0].tool_use_id;
    const callInTail = tail.find((message) => toolUseIdsIn(message).includes(callId));
    expect(callInTail?.handle).toBeUndefined();
    const resultInTail = tail.find((message) => toolResultIdsIn(message).includes(callId));
    expect(resultInTail?.handle).toBeUndefined();
    expect(resultInTail!.toolResults!.find((r) => r.tool_use_id === callId)!.text, 'oversized, so rebuilt to a pointer').toContain(`tool_use_id=${callId}`);
  });

  it('a tool-result body over the threshold is rebuilt to a pointer naming tool_use_id, not a line number', () => {
    resetFixtureIds();
    const call = assistantCall('Read');
    const oversized = 'x'.repeat(3000 * 4);
    const result = toolResultsMessage([{ toolUseId: call.toolUses[0].tool_use_id, options: { text: oversized } }]);
    const messages: SessionMessage[] = [
      humanPrompt('read the big file'),
      call,
      result,
      assistantText('summarized it'),
      humanPrompt('what next'),
      assistantText('next step'),
    ];
    const tail = pickTail(messages, options({ budgetTokens: 100000, rebuildThresholdTokens: 2000, trigger: 'manual' })).messages;
    const callId = call.toolUses[0].tool_use_id;
    const rebuiltResult = tail.find((message) => toolResultIdsIn(message).includes(callId));
    expect(rebuiltResult, 'the oversized result must still be present, rebuilt').toBeDefined();
    expect(rebuiltResult!.handle).toBeUndefined();
    const rebuiltText = rebuiltResult!.toolResults!.find((r) => r.tool_use_id === callId)!.text;
    expect(rebuiltText).toContain(`tool_use_id=${callId}`);
    expect(rebuiltText).not.toMatch(/pointer line=/);
  });

  it('a plain, small (well within budget) tail is still returned intact under manual, only stripped of its handle', () => {
    resetFixtureIds();
    const messages: SessionMessage[] = [humanPrompt('hi'), assistantText('hello')];
    const result = pickTail(messages, options({ budgetTokens: 100000, trigger: 'manual' }));
    expect(result.messages.map((m) => ({ role: m.role, text: m.text }))).toEqual([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hello' },
    ]);
    expect(result.messages.every((m) => m.handle === undefined)).toBe(true);
  });
});

describe('tail picker: v3.2.2 thinking-only fragments are dropped, never emitted as empty assistant messages', () => {
  it('an assistant message with no text and no tool calls (all it held was a thinking block) is dropped from the tail', () => {
    resetFixtureIds();
    const thinkingOnly: SessionMessage = { role: 'assistant', text: '', toolUses: [], handle: 'h_thinking_1' };
    const messages: SessionMessage[] = [humanPrompt('go'), thinkingOnly, assistantText('final answer')];
    const tail = pickTail(messages, options({ budgetTokens: 100000, trigger: 'manual' })).messages;
    expect(tail.some((m) => m.role === 'assistant' && m.text === '' && m.toolUses.length === 0), 'a thinking-only fragment must never appear in the returned tail').toBe(false);
    assertPairAtomic(tail);
  });

  it('dropping a thinking-only fragment does not orphan a neighboring tool_use/tool_result pair', () => {
    resetFixtureIds();
    const call = assistantCall('Bash');
    const result = toolResultsMessage([{ toolUseId: call.toolUses[0].tool_use_id }]);
    const thinkingOnly: SessionMessage = { role: 'assistant', text: '', toolUses: [], handle: 'h_thinking_2' };
    const messages: SessionMessage[] = [humanPrompt('go'), thinkingOnly, call, result, assistantText('done')];
    const tail = pickTail(messages, options({ budgetTokens: 100000, trigger: 'plugin' })).messages;
    expect(tail.some((m) => m.role === 'assistant' && m.text === '' && m.toolUses.length === 0)).toBe(false);
    assertPairAtomic(tail);
  });

  it('an assistant message with empty text but a real tool call is kept, not treated as thinking-only', () => {
    resetFixtureIds();
    const call = assistantCall('Bash');
    const result = toolResultsMessage([{ toolUseId: call.toolUses[0].tool_use_id }]);
    const messages: SessionMessage[] = [humanPrompt('go'), call, result];
    const tail = pickTail(messages, options({ budgetTokens: 100000, trigger: 'manual' })).messages;
    expect(tailHasToolUse(tail, call.toolUses[0].tool_use_id)).toBe(true);
  });

  it('this rule applies under auto too, to the last assistant turn', () => {
    resetFixtureIds();
    const thinkingOnly: SessionMessage = { role: 'assistant', text: '', toolUses: [], handle: 'h_thinking_3' };
    const messages: SessionMessage[] = [humanPrompt('go'), assistantText('ok'), humanPrompt('continue'), thinkingOnly];
    const tail = pickTail(messages, options({ budgetTokens: 100000, trigger: 'auto' })).messages;
    expect(tail.some((m) => m.role === 'assistant' && m.text === '' && m.toolUses.length === 0)).toBe(false);
  });

  it('round 16 (spec v3.2.3 F5, brief-s4a-fix16.md): omittedCount does NOT count a thinking-only fragment dropped from inside the tail window (it never held anything a Grep of the transcript could find)', () => {
    resetFixtureIds();
    const thinkingOnly: SessionMessage = { role: 'assistant', text: '', toolUses: [], handle: 'h_thinking_4' };
    const messages: SessionMessage[] = [humanPrompt('go'), thinkingOnly, assistantText('final answer')];
    const result = pickTail(messages, options({ budgetTokens: 100000, trigger: 'manual' }));
    expect(result.messages.length).toBe(2);
    expect(result.omittedCount, 'a dropped thinking-only fragment must NOT inflate omittedCount past round 16 (superseded round-14/15 behavior: it used to)').toBe(0);
  });
});

describe('tail picker: v3.2.3 F4 (round 16, brief-s4a-fix16.md), an empty (image/non-text-only) user fragment is dropped, never rebuilt as an empty user turn', () => {
  it('a user message with no text and no toolResults (image-only) is dropped from the tail, not returned as { role: "user", text: "" }', () => {
    resetFixtureIds();
    const imageOnly: SessionMessage = { role: 'user', text: '', toolUses: [] };
    const messages: SessionMessage[] = [humanPrompt('go'), assistantText('ok'), imageOnly, assistantText('thanks')];
    const tail = pickTail(messages, options({ budgetTokens: 100000, trigger: 'manual' })).messages;
    expect(tail.some((m) => m.role === 'user' && m.text === '' && (m.toolResults ?? []).length === 0), 'an empty user turn must never be emitted').toBe(false);
    assertPairAtomic(tail);
  });

  it('dropping the empty user fragment IS counted in omittedCount, unlike a dropped thinking-only fragment (F4 vs F5): it is a real prompt whose content genuinely could not be carried', () => {
    resetFixtureIds();
    const imageOnly: SessionMessage = { role: 'user', text: '', toolUses: [] };
    const messages: SessionMessage[] = [humanPrompt('go'), imageOnly, assistantText('thanks')];
    const result = pickTail(messages, options({ budgetTokens: 100000, trigger: 'manual' }));
    expect(result.messages.length).toBe(2);
    expect(result.omittedCount).toBe(1);
  });

  it('a user message with no text but a real toolResults entry is kept, not treated as empty', () => {
    resetFixtureIds();
    const call = assistantCall('Bash');
    const result = toolResultsMessage([{ toolUseId: call.toolUses[0].tool_use_id }]);
    const messages: SessionMessage[] = [humanPrompt('go'), call, result];
    const tail = pickTail(messages, options({ budgetTokens: 100000, trigger: 'manual' })).messages;
    expect(tailHasToolResult(tail, call.toolUses[0].tool_use_id)).toBe(true);
  });
});

describe('tail picker: the last assistant turn split into fragments (v3.2.3 F1, superseded by the resume cache fix)', () => {
  it('a mid-tool-loop turn split into a thinking-only fragment then a tool_use fragment (a pending call, no result yet) comes back as one message with the call, no handle', () => {
    resetFixtureIds();
    const call = assistantCall('Bash');
    const thinkingSibling: SessionMessage = { role: 'assistant', text: '', toolUses: [], handle: 'h_thinking_mid_loop' };
    const messages: SessionMessage[] = [humanPrompt('go'), thinkingSibling, call];
    const tail = pickTail(messages, options({ budgetTokens: 100000, trigger: 'auto' })).messages;
    expect(tail.filter((m) => m.role === 'assistant')).toEqual([{ role: 'assistant', text: '', toolUses: call.toolUses }]);
    assertPairAtomic(tail);
  });

  it('the same mid-tool-loop turn, once its call is answered: one assistant message, then its result, no handles', () => {
    resetFixtureIds();
    const call = assistantCall('Bash');
    const result = toolResultsMessage([{ toolUseId: call.toolUses[0].tool_use_id, options: { text: 'small' } }]);
    const thinkingSibling: SessionMessage = { role: 'assistant', text: '', toolUses: [], handle: 'h_thinking_mid_loop_2' };
    const messages: SessionMessage[] = [humanPrompt('go'), thinkingSibling, call, result];
    const tail = pickTail(messages, options({ budgetTokens: 100000, trigger: 'auto' })).messages;
    expect(tail.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(tail.filter((m) => m.handle !== undefined)).toEqual([]);
    assertPairAtomic(tail);
  });

  it('if the whole last turn is thinking-only (no fragment has text or a tool call), it is dropped', () => {
    resetFixtureIds();
    const thinkingOnlyA: SessionMessage = { role: 'assistant', text: '', toolUses: [], handle: 'h_thinking_run_a' };
    const thinkingOnlyB: SessionMessage = { role: 'assistant', text: '', toolUses: [], handle: 'h_thinking_run_b' };
    const messages: SessionMessage[] = [humanPrompt('go'), assistantText('ok'), humanPrompt('continue'), thinkingOnlyA, thinkingOnlyB];
    const tail = pickTail(messages, options({ budgetTokens: 100000, trigger: 'auto' })).messages;
    expect(tail.some((m) => m.role === 'assistant' && m.text === '' && m.toolUses.length === 0)).toBe(false);
  });
});
