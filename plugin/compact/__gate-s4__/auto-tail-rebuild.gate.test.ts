import { describe, it, expect, beforeAll } from 'vitest';
import { loadImpl } from './impl.js';
import { assistantCall, assistantText, countTokens, humanPrompt, resetFixtureIds, sha256, toolResultsMessage } from './fixtures/helpers.js';
import type { CompactTrigger, SessionMessage } from '../core/types.js';
import type { pickTail as PickTail, TailOptions } from '../core/tail.js';

/**
 * Resume cache fix (2026-10-15): no tail message keeps its engine handle, under any trigger, and the
 * adjacent assistant fragments of one turn are rebuilt as one message.
 *
 * Why no handle under `auto` either: a handled message keeps its original `message.id`, so the
 * transcript holds that id on both sides of the compact boundary. On `--resume` the engine
 * regroups every fragment with that id, which replays pre-cut content (a duplicated text block,
 * or a thinking block the kept copy no longer has). The resumed request then differs from the
 * live one, so the prompt cache misses down to system + tools (A/B: 17 of 18 resumes after a
 * mid-loop auto cut missed, 1 of 26 after no cut; ~123k extra cache-write tokens per chain).
 *
 * Why merge fragments: the engine hands one API message over as one `SessionMessage` per content
 * block. Rebuilt one by one, three parallel calls become three assistant messages followed by a
 * single results message, and the engine's tool_result pairing check inserts synthetic results
 * for the first two (seen live: "repaired missing tool_result blocks (9 -> 11 messages)").
 */

let pickTail: typeof PickTail;

beforeAll(async () => {
  ({ pickTail } = await loadImpl<{ pickTail: typeof PickTail }>('tail'));
});

function options(overrides: Partial<TailOptions> = {}): TailOptions {
  return { budgetTokens: 100000, countTokens, hash: sha256, rebuildThresholdTokens: 2000, trigger: 'auto', ...overrides };
}

function thinkingOnly(handle: string): SessionMessage {
  return { role: 'assistant', text: '', toolUses: [], handle };
}

function textFragment(text: string): SessionMessage {
  return assistantText(text);
}

/** The shape the engine's pairing check wants: every assistant message with tool calls is
 * immediately followed by a user message holding a result for each of them, unless it is the
 * last message (a call still running at the cut). */
function assertPairedLikeTheEngine(tail: SessionMessage[]): void {
  tail.forEach((message, index) => {
    if (message.role !== 'assistant' || message.toolUses.length === 0) return;
    const next = tail[index + 1];
    if (next === undefined) return;
    const results = new Set((next.toolResults ?? []).map((result) => result.tool_use_id));
    for (const use of message.toolUses) {
      expect(results.has(use.tool_use_id), `call ${use.tool_use_id} at tail[${index}] must be answered by tail[${index + 1}], got ${JSON.stringify(next)}`).toBe(true);
    }
  });
}

/** No two adjacent messages share a role: one API turn is one rebuilt message. */
function assertAlternates(tail: SessionMessage[]): void {
  tail.forEach((message, index) => {
    if (index === 0) return;
    expect(message.role === 'assistant' && tail[index - 1].role === 'assistant', `tail[${index - 1}] and tail[${index}] are both assistant messages: ${JSON.stringify(tail)}`).toBe(false);
  });
}

describe('auto tail rebuild: no handle under any trigger', () => {
  it.each<CompactTrigger>(['auto', 'manual', 'plugin'])('%s: a mid-tool-loop open turn (thinking, text, a running call) comes back with no handle', (trigger) => {
    resetFixtureIds();
    const call = assistantCall('Read');
    const messages: SessionMessage[] = [humanPrompt('read the files'), thinkingOnly('h_think'), textFragment('Reading the first file.'), call];
    const tail = pickTail(messages, options({ trigger })).messages;
    for (const message of tail) expect(message.handle, `${trigger}: ${JSON.stringify(message)}`).toBeUndefined();
    expect(tail.some((message) => message.toolUses.some((use) => use.tool_use_id === call.toolUses[0].tool_use_id)), 'the running call stays in the tail').toBe(true);
  });

  it('auto: the answered last turn and its trailing result also lose their handles', () => {
    resetFixtureIds();
    const call = assistantCall('Bash');
    const result = toolResultsMessage([{ toolUseId: call.toolUses[0].tool_use_id, options: { text: 'small' } }]);
    const tail = pickTail([humanPrompt('go'), thinkingOnly('h_t'), call, result, assistantText('done')], options()).messages;
    expect(tail.filter((message) => message.handle !== undefined)).toEqual([]);
  });
});

describe('auto tail rebuild: the fragments of one assistant turn become one message', () => {
  it('thinking, text and a call become one assistant message with that text and that call; no empty thinking message is left', () => {
    resetFixtureIds();
    const call = assistantCall('Read');
    const tail = pickTail([humanPrompt('go'), thinkingOnly('h_t'), textFragment('I will read it.'), call], options()).messages;
    const assistants = tail.filter((message) => message.role === 'assistant');
    expect(assistants.length).toBe(1);
    expect(assistants[0].text).toBe('I will read it.');
    expect(assistants[0].toolUses.map((use) => use.tool_use_id)).toEqual([call.toolUses[0].tool_use_id]);
  });

  it('three parallel calls handed over as three fragments come back as one message, answered by the next one', () => {
    resetFixtureIds();
    const a = assistantCall('Read');
    const b = assistantCall('Read');
    const c = assistantCall('Grep');
    const ids = [a, b, c].map((message) => message.toolUses[0].tool_use_id);
    const results = toolResultsMessage(ids.map((toolUseId) => ({ toolUseId, options: { text: 'small' } })));
    const tail = pickTail([humanPrompt('look around'), thinkingOnly('h_t'), a, b, c, results, assistantText('found it')], options()).messages;
    assertAlternates(tail);
    assertPairedLikeTheEngine(tail);
    const caller = tail.find((message) => message.toolUses.length > 0);
    expect(caller?.toolUses.map((use) => use.tool_use_id)).toEqual(ids);
  });

  it('several text fragments keep their order, joined by a blank line', () => {
    resetFixtureIds();
    const tail = pickTail([humanPrompt('go'), textFragment('first'), thinkingOnly('h_t'), textFragment('second')], options()).messages;
    expect(tail.filter((message) => message.role === 'assistant').map((message) => message.text)).toEqual(['first\n\nsecond']);
  });

  it('two turns split by a tool result stay two messages', () => {
    resetFixtureIds();
    const call = assistantCall('Bash');
    const result = toolResultsMessage([{ toolUseId: call.toolUses[0].tool_use_id, options: { text: 'small' } }]);
    const tail = pickTail([humanPrompt('go'), textFragment('running it'), call, result, textFragment('it passed')], options()).messages;
    expect(tail.map((message) => `${message.role}:${message.text}:${message.toolUses.length}`)).toEqual(['user:go:0', 'assistant:running it:1', 'user::0', 'assistant:it passed:0']);
  });

  it('a turn that is nothing but thinking is still dropped', () => {
    resetFixtureIds();
    const tail = pickTail([humanPrompt('go'), assistantText('ok'), humanPrompt('continue'), thinkingOnly('h_a'), thinkingOnly('h_b')], options()).messages;
    expect(tail.some((message) => message.role === 'assistant' && message.text === '' && message.toolUses.length === 0)).toBe(false);
    expect(tail.at(-1)?.text).toBe('continue');
  });

  it('an oversized result next to a merged turn is still replaced by a pointer', () => {
    resetFixtureIds();
    const a = assistantCall('Read');
    const b = assistantCall('Read');
    const results = toolResultsMessage([
      { toolUseId: a.toolUses[0].tool_use_id, options: { text: 'x'.repeat(40000) } },
      { toolUseId: b.toolUses[0].tool_use_id, options: { text: 'small' } },
    ]);
    const tail = pickTail([humanPrompt('go'), a, b, results], options()).messages;
    const rebuilt = tail.find((message) => (message.toolResults ?? []).length > 0)!;
    expect(rebuilt.toolResults![0].text).toMatch(/^\[pointer tool_use_id=/);
    expect(rebuilt.toolResults![1].text).toBe('small');
    assertPairedLikeTheEngine(tail);
  });

  it('omittedCount still counts the messages the engine handed over, not the merged ones', () => {
    resetFixtureIds();
    const big = 'y'.repeat(4000 * 4);
    const messages: SessionMessage[] = [humanPrompt(big), textFragment('a'), thinkingOnly('h_t'), textFragment('b'), humanPrompt('now this'), textFragment('c'), textFragment('d')];
    const result = pickTail(messages, options({ budgetTokens: 6 }));
    expect(result.messages.map((message) => message.text)).toEqual(['now this', 'c\n\nd']);
    expect(result.omittedCount, 'four messages before the kept prompt: the big prompt and the three fragments of its answer').toBe(4);
  });
});
