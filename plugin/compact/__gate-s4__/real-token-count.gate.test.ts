import { describe, it, expect, vi } from 'vitest';
import { register } from '../compact.js';
import { estimateTokens, serializedTokens, REAL_TOTAL_BUDGET_TOKENS, TOTAL_BUDGET_TOKENS } from '../core/budgets.js';
import { fakeHost, humanPrompt, assistantText, withStrippedRuntimeGlobals, LEGACY_OPTIONS } from './fixtures/helpers.js';
import type { SessionMessage } from '../core/types.js';

const FLAG_PATH = '.exovault/s4-compact-active';

/** 3.46.0 (CONTRACT S4zt): every budget counts real tokens (estimateTokens), with a 20000 default total. */
describe('compact.ts: budgets count real tokens (S4zt)', () => {
  // Code-like turns: paths, numbers and punctuation run well under 4 characters per token.
  function conversation(): SessionMessage[] {
    const messages: SessionMessage[] = [];
    for (let i = 0; i < 60; i += 1) {
      messages.push(humanPrompt(`turn ${i}: check packages/app/src/part-${i}.ts`));
      messages.push(assistantText(`Updated packages/app/src/part-${i}.ts:${i * 7} {"id":${i},"sha":"c0ffee${String(i).padStart(4, '0')}"} ${'x[1]=2; '.repeat(300)}`));
    }
    return messages;
  }

  async function cut(options: Record<string, unknown>) {
    const lines: string[] = [];
    const $ = fakeHost({
      fsExists: async (path) => path.endsWith(`/${FLAG_PATH}`),
      fsRead: async (path) => { if (path.endsWith(`/${FLAG_PATH}`)) return '1'; throw new Error(`ENOENT: ${path}`); },
      uiLog: (line: string) => lines.push(line),
    });
    const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    register(((name: string, handler: never) => { handlers[name] = handler; return { catch: (caught: unknown) => { (handlers as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS, denseNotes: true, ...options } as never);
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, { trigger: 'auto', messages: conversation() }, next))) as { messages?: SessionMessage[] };
    return { lines, next, messages: result.messages ?? [] };
  }

  it('defaults to a 20000 real-token total and keeps the result inside it', async () => {
    const { lines, next, messages } = await cut({});
    expect(lines).toContain(`seed.budget_total=${REAL_TOTAL_BUDGET_TOKENS} seed.budget_count=real`);
    expect(next).not.toHaveBeenCalled();
    expect(serializedTokens(messages, estimateTokens)).toBeLessThanOrEqual(REAL_TOTAL_BUDGET_TOKENS);
  });

  it('realTokenCount=false restores chars / 4 and the 13000 total', async () => {
    const { lines, next } = await cut({ realTokenCount: false });
    expect(lines).toContain(`seed.budget_total=${TOTAL_BUDGET_TOKENS} seed.budget_count=chars4`);
    expect(next).not.toHaveBeenCalled();
  });

  it('an explicit totalBudgetTokens wins over the default', async () => {
    const { lines } = await cut({ totalBudgetTokens: 16000 });
    expect(lines).toContain('seed.budget_total=16000 seed.budget_count=real');
  });
});
