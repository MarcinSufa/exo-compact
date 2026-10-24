import { describe, it, expect, vi } from 'vitest';
import { register } from '../compact.js';
import { fakeHost, humanPrompt, assistantText, withStrippedRuntimeGlobals, LEGACY_OPTIONS } from './fixtures/helpers.js';
import type { SessionMessage } from '../core/types.js';

/**
 * 4.6.0 (w65b): a seed a few tokens over its budget after every shrink step takes the room from the tail instead of
 * handing the whole cut to the native summary. `event.instructions` is the one seed section nothing shrinks, so it
 * sets how far over the seed is (24800 chars: ~100 tokens over with a 13000 total in chars/4 counting).
 */
describe('compact.ts: a seed slightly over its budget takes the room from the tail (w65b)', () => {
  const conversation = (): SessionMessage[] => {
    const messages: SessionMessage[] = [];
    for (let i = 0; i < 40; i += 1) {
      messages.push(humanPrompt(`Rule ${i}: always keep module-${i}.ts under ${i + 50} lines. ${'filler text '.repeat(60)}`));
      messages.push(assistantText(`reply ${i} ${'ok done '.repeat(180)}`));
    }
    return messages;
  };

  async function cut(instructionChars: number) {
    const lines: string[] = [];
    const $ = fakeHost({ sessionId: async () => 'session-seed-over-tail', uiLog: (line: string) => lines.push(line) });
    const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    register(((name: string, handler: never) => { handlers[name] = handler; return { catch: (caught: unknown) => { (handlers as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS, denseNotes: true, totalBudgetTokens: 13000, realTokenCount: false } as never);
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event = { trigger: 'auto', messages: conversation(), ...(instructionChars ? { instructions: 'keep the build green '.repeat(Math.ceil(instructionChars / 21)) } : {}) };
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next))) as { messages?: SessionMessage[] };
    const kept = result.messages ?? [];
    return { lines, next, seed: kept[0]?.text ?? '', tailChars: kept.slice(1).reduce((sum, message) => sum + message.text.length, 0) };
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
});
