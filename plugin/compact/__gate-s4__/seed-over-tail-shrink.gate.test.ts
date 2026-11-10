import { describe, it, expect, vi } from 'vitest';
import { register } from '../compact.js';
import { BRIEF_MIN_TAIL_SHARE } from '../core/briefs.js';
import { REBUILD_THRESHOLD_TOKENS, serializedTokens } from '../core/budgets.js';
import { pickTail } from '../core/tail.js';
import { countTokens, fakeHost, humanPrompt, assistantText, withStrippedRuntimeGlobals, LEGACY_OPTIONS, sha256 } from './fixtures/helpers.js';
import type { SessionMessage } from '../core/types.js';

/**
 * 4.6.0 (w65b): a seed a few tokens over its budget after every shrink step takes the room from the tail instead of
 * handing the whole cut to the native summary. `event.instructions` is the one seed section nothing shrinks, so it
 * sets how far over the seed is (24800 chars: ~100 tokens over with a 13000 total in chars/4 counting).
 */
describe('compact.ts: a seed slightly over its budget takes the room from the tail (w65b)', () => {
  const conversation = (smallMessages = false): SessionMessage[] => {
    const messages: SessionMessage[] = [];
    for (let i = 0; i < (smallMessages ? 260 : 40); i += 1) {
      messages.push(humanPrompt(`Rule ${i}: always keep module-${i}.ts under ${i + 50} lines. ${'filler text '.repeat(smallMessages ? 12 : 60)}`));
      messages.push(assistantText(`reply ${i} ${'ok done '.repeat(smallMessages ? 12 : 180)}`));
    }
    return messages;
  };

  async function cut(instructionChars: number, messages = conversation()) {
    const lines: string[] = [];
    const $ = fakeHost({ sessionId: async () => 'session-seed-over-tail', uiLog: (line: string) => lines.push(line) });
    const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    register(((name: string, handler: never) => { handlers[name] = handler; return { catch: (caught: unknown) => { (handlers as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS, denseNotes: true, totalBudgetTokens: 13000, realTokenCount: false } as never);
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const instructions = `${'keep the build green '.repeat(Math.floor(instructionChars / 21))}${'x'.repeat(instructionChars % 21)}`;
    const event = { trigger: 'auto', messages, ...(instructionChars ? { instructions } : {}) };
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next))) as { messages?: SessionMessage[] };
    const kept = result.messages ?? [];
    return { lines, next, seed: kept[0]?.text ?? '', tailMessages: kept.slice(1), tailChars: kept.slice(1).reduce((sum, message) => sum + message.text.length, 0) };
  }

  function boundary(lines: string[], keptTailTokens: number) {
    const split = lines.join('\n').match(/seed\.budget_split seed=(\d+) tail=(\d+) dense=(\d+)/);
    const total = lines.join('\n').match(/seed\.budget_total=(\d+)/);
    expect(split).not.toBeNull();
    expect(total).not.toBeNull();
    const floor = Math.round(Number(split?.[2]) * BRIEF_MIN_TAIL_SHARE);
    const shrink = lines.join('\n').match(/seed\.tail_shrunk_for_seed=(\d+)/);
    const overLine = lines.join('\n').match(/seed\.budget_over seed=(\d+)\/(\d+) tail=(\d+)\/(\d+) total=(\d+)/);
    const over = shrink ? Number(shrink[1]) : overLine
      ? Math.max(Number(overLine[1]) - Number(overLine[2]), Number(overLine[1]) + keptTailTokens - Number(overLine[5]), 0)
      : Number.NaN;
    if (overLine) {
      expect(Number(overLine[3])).toBe(keptTailTokens);
      expect(Number(overLine[5])).toBe(Number(total?.[1]));
    }
    return { floor, over, remaining: keptTailTokens - over };
  }

  it('moves the missing tokens from the tail budget to the seed and keeps the plugin cut', async () => {
    const baseline = await cut(0);
    const { lines, next, seed, tailChars } = await cut(24800);
    expect(lines.join('\n')).not.toContain('compact.fallback=budget');
    expect(lines.some((line) => /^seed\.tail_shrunk_for_seed=[1-9]/.test(line))).toBe(true);
    expect(next).not.toHaveBeenCalled();
    expect(seed).toContain('keep the build green');
    expect(tailChars).toBeGreaterThan(0);
    expect(tailChars).toBeLessThan(baseline.tailChars);
  });

  it('leaves the tail alone when the seed fits', async () => {
    const { lines, next } = await cut(0);
    expect(next).not.toHaveBeenCalled();
    expect(lines.some((line) => line.startsWith('seed.tail_shrunk_for_seed='))).toBe(false);
  });

  it('still falls back when the seed is so far over that the tail would go below its floor', async () => {
    const { lines } = await cut(60000);
    expect(lines.some((line) => line.startsWith('seed.tail_shrunk_for_seed='))).toBe(false);
    expect(lines.some((line) => line.startsWith('seed.budget_over '))).toBe(true);
    expect(lines.join('\n')).toContain('compact.fallback=budget');
  });

  it('keeps the tail floor when the reachable remainder is about half the floor', async () => {
    const messages = conversation(true);
    const baseline = await cut(0, messages);
    const keptTailTokens = serializedTokens(baseline.tailMessages, countTokens);
    const { lines, next } = await cut(47450, messages);
    const { floor, over, remaining } = boundary(lines, keptTailTokens);
    const reachable = pickTail(messages, { budgetTokens: remaining, countTokens, hash: sha256, rebuildThresholdTokens: REBUILD_THRESHOLD_TOKENS, trigger: 'auto' });

    expect(keptTailTokens).toBeGreaterThan(floor);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(floor);
    expect(remaining).toBeGreaterThan(floor * 0.4);
    expect(remaining).toBeLessThan(floor * 0.6);
    expect(over).toBeGreaterThan(0);
    expect(serializedTokens(reachable.messages, countTokens)).toBeLessThanOrEqual(remaining);
    expect(lines.some((line) => line.startsWith('seed.tail_shrunk_for_seed='))).toBe(false);
    expect(lines.join('\n')).toContain('compact.fallback=budget');
    expect(next).toHaveBeenCalled();
  });

  it('shrinks the tail when the reachable remainder is well above the floor', async () => {
    const messages = conversation(true);
    const baseline = await cut(0, messages);
    const keptTailTokens = serializedTokens(baseline.tailMessages, countTokens);
    const { lines, next, tailMessages } = await cut(40400, messages);
    const { floor, over, remaining } = boundary(lines, keptTailTokens);
    const reachable = pickTail(messages, { budgetTokens: remaining, countTokens, hash: sha256, rebuildThresholdTokens: REBUILD_THRESHOLD_TOKENS, trigger: 'auto' });
    const actualTailTokens = serializedTokens(tailMessages, countTokens);

    expect(keptTailTokens).toBeGreaterThan(floor);
    expect(remaining).toBeGreaterThan(floor + 500);
    expect(over).toBeGreaterThan(0);
    expect(serializedTokens(reachable.messages, countTokens)).toBeLessThanOrEqual(remaining);
    expect(lines.some((line) => /^seed\.tail_shrunk_for_seed=[1-9]/.test(line))).toBe(true);
    expect(lines.join('\n')).not.toContain('compact.fallback=budget');
    expect(next).not.toHaveBeenCalled();
    expect(actualTailTokens).toBe(serializedTokens(reachable.messages, countTokens));
  });
});
