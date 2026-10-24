import { LEGACY_OPTIONS } from './fixtures/helpers.js';
import { describe, it, expect, vi } from 'vitest';

/**
 * Round 7 D10: no existing test pins `pickTail` to being called from inside `session.compact`'s
 * `withFallback` `run()`, sequenced after the capture step. A mutant that hoists the `pickTail`
 * call out of `run()` (so it runs unconditionally before the compaction attempt, regardless of
 * whether reconcile/`appendRecords` throws) survives every other test in this suite, because
 * `pickTail` is pure and its result never reaches the caller when the attempt falls back. This
 * file mocks `core/tail.js` (`vi.mock`, hoisted, so it must live in its own file rather than
 * `compact.gate.test.ts`, whose other tests need the real tail content) so `pickTail`'s call
 * count is directly observable.
 */
vi.mock('../core/tail.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/tail.js')>();
  return { ...actual, pickTail: vi.fn(actual.pickTail) };
});

const { register } = await import('../compact.js');
const { pickTail } = await import('../core/tail.js') as unknown as { pickTail: ReturnType<typeof vi.fn> };
const { fakeHost, humanPrompt, assistantText, withStrippedRuntimeGlobals } = await import('./fixtures/helpers.js');
const FLAG_PATH = '.exovault/s4-compact-active';

function harness(options: Record<string, unknown> = {}) {
  const handlers: Record<string, (...args: never[]) => unknown> = {};
  register(((name: string, handler: never) => { handlers[name] = handler; return { catch: (caught: unknown) => { (handlers as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS, ...options } as never);
  return handlers;
}

describe('compact.ts: pickTail runs inside the protected compaction attempt, after the capture step (round 7 D10)', () => {
  it('is not called at all when loadWatermark fails before it would run (round 8: the capture write itself moved past pickTail, see finding 1)', async () => {
    // Round 8 findings 1/2 moved the one appendRecords write to the end of run(), after pickTail
    // and renderSeed, so the watermark can be derived from the exact list this attempt returns
    // (compact.ts's own comment there). The step that must still precede pickTail, and still
    // prove pickTail is sequenced inside run() and not hoisted above the whole withFallback, is
    // now store.loadWatermark() (reconcile's first argument): a read failure there must still
    // throw before pickTail ever runs.
    pickTail.mockClear();
    const fsRead = vi.fn(async (path: string) => {
      if (path === FLAG_PATH) return '1';
      throw new Error('disk full');
    });
    const fsExists = vi.fn(async () => true);
    const $ = fakeHost({ fsRead, fsExists });
    const handlers = harness({ contract: 'the contract' });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event = { trigger: 'auto', messages: [humanPrompt('VALUE key=x: 1'), assistantText('ok')] };
    await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next));
    expect(next).toHaveBeenCalledTimes(1);
    expect(
      pickTail,
      'pickTail must be sequenced inside run(), after loadWatermark; a mutant that hoists it outside run() would call it unconditionally even though the watermark read above it throws first',
    ).not.toHaveBeenCalled();
  });

  it('is called exactly once, from inside the same successful attempt, when capture succeeds', async () => {
    pickTail.mockClear();
    const fsRead = vi.fn(async (path: string) => (path === FLAG_PATH ? '1' : ''));
    const $ = fakeHost({ fsRead });
    const handlers = harness({ contract: 'the contract' });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event = { trigger: 'auto', messages: [humanPrompt('VALUE key=x: 1'), assistantText('ok')] };
    await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next));
    expect(pickTail).toHaveBeenCalledTimes(1);
  });
});
