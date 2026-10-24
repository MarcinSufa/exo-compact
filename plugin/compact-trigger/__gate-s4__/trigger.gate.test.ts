import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { register } from '../trigger.js';
import { fakeHost, withStrippedRuntimeGlobals } from '../../compact/__gate-s4__/fixtures/helpers.js';
import type { FakeHost } from '../../compact/__gate-s4__/fixtures/helpers.js';

/**
 * Round 7 D10: `trigger.ts` (the separate `turn.complete` module that owns soft-trigger arming,
 * since `$.session.compact()` skips the calling module) had no test of its own at all; only
 * `core/handler.ts`'s `makeSoftTrigger` was unit-tested. These are behavioral tests of the actual
 * `register()` wiring: call order relative to `next`, the agentId/non-answer skip, the S3/S4
 * flag gate, and the concurrency guard, all exercised through `trigger.ts` itself.
 *
 * Round 10: this file moved from `../../compact/__gate-s4__/trigger.gate.test.ts` to here,
 * alongside `trigger.ts`'s new home in its own plugin, `exovault-s4-trigger` (CONTRACT.md: split
 * out because Claude Code 2.1.280 refuses a second module in one plugin's `hooks.json`). It still
 * imports `fakeHost`/`withStrippedRuntimeGlobals` from `compact`'s fixtures rather than a
 * duplicate copy: that import is resolved by Node/vitest at test time, not by the sandboxed hook
 * runtime `trigger.ts` itself runs under, so the cross-plugin-directory caution that applies to
 * `trigger.ts`'s own runtime imports (see `../core/handler.ts`'s header comment) does not apply
 * to test-only tooling.
 */
const FLAG_PATH = '.exovault/s4-compact-active';

type Handler = ($: FakeHost, event: unknown, next: (event: unknown) => Promise<unknown>) => Promise<unknown>;

function harness(options: Record<string, unknown> = {}): Handler {
  let handler: Handler | undefined;
  const catches: Record<string, unknown> = {};
  const on = (name: string, h: Handler) => { handler = h; return { catch: (caught: unknown) => { catches[name + '.catch'] = caught; } }; };
  register(on as never, options as never);
  if (!handler) throw new Error('trigger.ts did not register a turn.complete handler');
  return handler;
}

describe('trigger.ts: turn.complete soft-trigger registration (round 7 D10)', () => {
  it('calls next(event) and returns its result before arming the soft trigger', async () => {
    const order: string[] = [];
    const next = vi.fn(async () => { order.push('next'); return { fromNext: true }; });
    const sessionCompact = vi.fn(async () => { order.push('compact'); });
    const fsRead = vi.fn(async (path: string) => (path === FLAG_PATH ? '1' : ''));
    const $ = fakeHost({ fsRead, sessionUsage: async () => ({ context: { percent: 90 } }), sessionCompact });
    const handler = harness({ softThresholdPercent: 50 });
    const result = await withStrippedRuntimeGlobals(() => handler($, { reason: 'answer' }, next));
    expect(result).toEqual({ fromNext: true });
    expect(order).toEqual(['next', 'compact']);
  });

  it('never compacts when agentId is present, even above threshold', async () => {
    const sessionCompact = vi.fn(async () => {});
    const fsRead = vi.fn(async (path: string) => (path === FLAG_PATH ? '1' : ''));
    const $ = fakeHost({ fsRead, sessionUsage: async () => ({ context: { percent: 99 } }), sessionCompact });
    const handler = harness({ softThresholdPercent: 10 });
    const next = vi.fn(async () => ({ ok: true }) as unknown);
    const result = await withStrippedRuntimeGlobals(() => handler($, { reason: 'answer', agentId: 'sub-1' }, next));
    expect(sessionCompact).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it('never compacts on a non-answer turn, even above threshold', async () => {
    const sessionCompact = vi.fn(async () => {});
    const fsRead = vi.fn(async (path: string) => (path === FLAG_PATH ? '1' : ''));
    const $ = fakeHost({ fsRead, sessionUsage: async () => ({ context: { percent: 99 } }), sessionCompact });
    const handler = harness({ softThresholdPercent: 10 });
    const next = vi.fn(async () => ({ ok: true }) as unknown);
    await withStrippedRuntimeGlobals(() => handler($, { reason: 'tool' }, next));
    expect(sessionCompact).not.toHaveBeenCalled();
  });

  it('is inert without the S3/S4 exclusion flag, even above threshold', async () => {
    const sessionCompact = vi.fn(async () => {});
    const fsRead = vi.fn(async () => { throw new Error('ENOENT'); });
    const $ = fakeHost({ fsRead, sessionUsage: async () => ({ context: { percent: 99 } }), sessionCompact });
    const handler = harness({ softThresholdPercent: 10 });
    const next = vi.fn(async () => ({ ok: true }) as unknown);
    const result = await withStrippedRuntimeGlobals(() => handler($, { reason: 'answer' }, next));
    expect(sessionCompact).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it('round 8 finding 3: compares tokens against compactWindowTokens, not percent against the model window', async () => {
    const sessionCompact = vi.fn(async () => {});
    const fsRead = vi.fn(async (path: string) => (path === FLAG_PATH ? '1' : ''));
    // tokens (130000) is above 60% of compactWindowTokens (200000 * 0.6 = 120000); percent (13,
    // as a 1M-window model would report it) is nowhere near softThresholdPercent (60). Tokens
    // must decide it.
    const $ = fakeHost({ fsRead, sessionUsage: async () => ({ context: { tokens: 130000, percent: 13 } }), sessionCompact });
    const handler = harness({ softThresholdPercent: 60, compactWindowTokens: 200000 });
    const next = vi.fn(async () => ({ ok: true }) as unknown);
    await withStrippedRuntimeGlobals(() => handler($, { reason: 'answer' }, next));
    expect(sessionCompact).toHaveBeenCalledTimes(1);
  });

  it('round 9 finding 9: compactWindowTokens defaults to 200000 (not some other constant) when the option is omitted', async () => {
    const sessionCompact = vi.fn(async () => {});
    const fsRead = vi.fn(async (path: string) => (path === FLAG_PATH ? '1' : ''));
    // 130000 tokens is above 60% of the documented 200000 default (120000). If the default were
    // ever changed to something far larger (e.g. 1000000, 60% = 600000), this would wrongly stay
    // silent.
    const $ = fakeHost({ fsRead, sessionUsage: async () => ({ context: { tokens: 130000 } }), sessionCompact });
    const handler = harness({ softThresholdPercent: 60 });
    const next = vi.fn(async () => ({ ok: true }) as unknown);
    await withStrippedRuntimeGlobals(() => handler($, { reason: 'answer' }, next));
    expect(sessionCompact, 'compactWindowTokens must default to 200000; 130000 tokens is above 60% of that default').toHaveBeenCalledTimes(1);
  });

  it('round 8 finding 10: does not re-compact on a second above-threshold turn, then fires again after a below-threshold turn re-arms it', async () => {
    const sessionCompact = vi.fn(async () => {});
    const fsRead = vi.fn(async (path: string) => (path === FLAG_PATH ? '1' : ''));
    let tokens = 150000;
    const $ = fakeHost({ fsRead, sessionUsage: async () => ({ context: { tokens } }), sessionCompact });
    const handler = harness({ softThresholdPercent: 60, compactWindowTokens: 200000 });
    const next = vi.fn(async () => ({ ok: true }) as unknown);
    await withStrippedRuntimeGlobals(() => handler($, { reason: 'answer' }, next));
    await withStrippedRuntimeGlobals(() => handler($, { reason: 'answer' }, next));
    expect(sessionCompact, 'usage stayed above threshold on the 2nd turn; it must not re-compact until a reading drops below threshold').toHaveBeenCalledTimes(1);
    tokens = 50000;
    await withStrippedRuntimeGlobals(() => handler($, { reason: 'answer' }, next));
    tokens = 150000;
    await withStrippedRuntimeGlobals(() => handler($, { reason: 'answer' }, next));
    expect(sessionCompact).toHaveBeenCalledTimes(2);
  });

  it('compacts exactly once for two turn.complete events issued back to back above threshold (concurrency)', async () => {
    // Not wrapped in withStrippedRuntimeGlobals: that helper strips/restores the same
    // globalThis properties per call and is not reentrant, so two overlapping calls to it can
    // corrupt each other; this test's own concurrency (two overlapping handler calls) is what is
    // under test here, not runtime-global isolation (already covered by the other tests above).
    let resolveCompact: () => void = () => {};
    const compactGate = new Promise<void>((resolve) => { resolveCompact = resolve; });
    const sessionCompact = vi.fn(() => compactGate);
    const fsRead = vi.fn(async (path: string) => (path === FLAG_PATH ? '1' : ''));
    const $ = fakeHost({ fsRead, sessionUsage: async () => ({ context: { percent: 90 } }), sessionCompact });
    const handler = harness({ softThresholdPercent: 10 });
    const next = vi.fn(async () => ({ ok: true }) as unknown);
    const first = handler($, { reason: 'answer' }, next);
    const second = handler($, { reason: 'answer' }, next);
    resolveCompact();
    await Promise.all([first, second]);
    expect(sessionCompact).toHaveBeenCalledTimes(1);
  });

  it('round 10: plugin manifest declares each trigger option with the matching option type', () => {
    const manifest = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')) as { userConfig?: Record<string, { type?: string }> };
    const source = readFileSync(new URL('../trigger.ts', import.meta.url), 'utf8');
    const readNames = new Set([...source.matchAll(/optionNumber\(options,\s*'([^']+)'/g)].map((match) => match[1]));
    const types: Record<string, string> = { softThresholdPercent: 'number', compactWindowTokens: 'number' };
    expect([...readNames].sort()).toEqual(Object.keys(types).sort());
    for (const name of readNames) expect(manifest.userConfig?.[name]?.type, `${name} must be declared with type ${types[name]}`).toBe(types[name]);
  });
});
