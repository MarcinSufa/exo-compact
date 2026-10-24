import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadImpl } from './impl.js';
import { withStrippedRuntimeGlobals } from './fixtures/helpers.js';
import type { CompactEvent } from '../core/types.js';
import type {
  routeTrigger as RouteTrigger,
  makeSoftTrigger as MakeSoftTrigger,
  withFallback as WithFallback,
  withTimeout as WithTimeout,
  applyForceTriggerOverride as ApplyForceTriggerOverride,
} from '../core/handler.js';

type DepsWithSleep<T> = Parameters<typeof WithFallback<T>>[0] & {
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};

function pendingSleep(_ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
}

let routeTrigger: typeof RouteTrigger;
let makeSoftTrigger: typeof MakeSoftTrigger;
let withFallback: typeof WithFallback;
let withTimeout: typeof WithTimeout;
let applyForceTriggerOverride: typeof ApplyForceTriggerOverride;
let forceTriggerOverride: (values: { trigger?: string; agentId?: string }) => { trigger?: string; agentId?: string } | undefined;

beforeAll(async () => {
  const impl = await loadImpl<{
    routeTrigger: typeof RouteTrigger;
    makeSoftTrigger: typeof MakeSoftTrigger;
    withFallback: typeof WithFallback;
    withTimeout: typeof WithTimeout;
    applyForceTriggerOverride: typeof ApplyForceTriggerOverride;
    forceTriggerOverride: typeof forceTriggerOverride;
  }>('handler');
  ({ routeTrigger, makeSoftTrigger, withFallback, withTimeout, applyForceTriggerOverride, forceTriggerOverride } = impl);
});

function event(overrides: Partial<CompactEvent> = {}): CompactEvent {
  return { trigger: 'auto', messages: [], ...overrides };
}

describe('handler: routeTrigger', () => {
  it('precompute is routed to skip, before anything that would write', () => {
    const route = routeTrigger(event({ trigger: 'precompute' }));
    expect(route.kind).toBe('skip');
    if (route.kind === 'skip') expect(route.reason.length).toBeGreaterThan(0);
  });

  it('precompute is skip even when agentId is also present (skip takes priority, spec §3.4.5)', () => {
    const route = routeTrigger(event({ trigger: 'precompute', agentId: 'sub_1' }));
    expect(route.kind).toBe('skip');
  });

  it('agentId present (non-precompute) is routed to next', () => {
    const route = routeTrigger(event({ trigger: 'auto', agentId: 'sub_1' }));
    expect(route.kind).toBe('next');
  });

  it('a plain manual/auto/plugin trigger with no agentId is routed to run', () => {
    for (const trigger of ['manual', 'auto', 'plugin'] as const) {
      expect(routeTrigger(event({ trigger })).kind).toBe('run');
    }
  });
});

describe('handler: soft trigger', () => {
  it('absent usage never triggers a compaction', async () => {
    const compact = vi.fn(async () => {});
    const trigger = makeSoftTrigger(80, 200000, { getUsage: async () => undefined, compact });
    await trigger.onTurnComplete();
    expect(compact).not.toHaveBeenCalled();
  });

  it('below threshold (percent-only usage, no tokens reported) never triggers', async () => {
    const compact = vi.fn(async () => {});
    const trigger = makeSoftTrigger(80, 200000, { getUsage: async () => ({ percent: 79 }), compact });
    await trigger.onTurnComplete();
    expect(compact).not.toHaveBeenCalled();
  });

  it('at or above threshold (percent-only usage) triggers exactly once', async () => {
    const compact = vi.fn(async () => {});
    const trigger = makeSoftTrigger(66.5, 200000, { getUsage: async () => ({ percent: 70 }), compact });
    await trigger.onTurnComplete();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('two turn.complete events issued back to back cause exactly one compaction (concurrency)', async () => {
    let resolveUsage: (v: { percent: number }) => void;
    const usagePromise = new Promise<{ percent: number }>((resolve) => {
      resolveUsage = resolve;
    });
    const compact = vi.fn(async () => {});
    const trigger = makeSoftTrigger(50, 200000, { getUsage: () => usagePromise, compact });
    const first = trigger.onTurnComplete();
    const second = trigger.onTurnComplete();
    resolveUsage!({ percent: 90 });
    await Promise.all([first, second]);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('round 8 finding 3: {tokens:130000, window:1000000, percent:13} compacts at the default 60% threshold (60% of compactWindowTokens=200000 is 120000)', async () => {
    const compact = vi.fn(async () => {});
    const trigger = makeSoftTrigger(60, 200000, { getUsage: async () => ({ tokens: 130000, percent: 13 }), compact });
    await trigger.onTurnComplete();
    expect(compact, 'percent (13) is far below softThresholdPercent (60), but tokens (130000) is above 60% of compactWindowTokens (120000); tokens must win over percent whenever it is present').toHaveBeenCalledTimes(1);
  });

  it('round 8 finding 3: {tokens:100000, window:1000000, percent:10} does not compact at the default 60% threshold', async () => {
    const compact = vi.fn(async () => {});
    const trigger = makeSoftTrigger(60, 200000, { getUsage: async () => ({ tokens: 100000, percent: 10 }), compact });
    await trigger.onTurnComplete();
    expect(compact).not.toHaveBeenCalled();
  });

  it('round 8 finding 3: on a 1M-window model, percent is never consulted while tokens is present, so a stale unit mismatch cannot fire 5x late or never', async () => {
    const compact = vi.fn(async () => {});
    // At 600000 tokens on a 1000000 window, percent is 60: the OLD bug (compare percent to
    // softThresholdPercent against the model's window) would only just be firing here. The
    // fixed trigger must already have fired 4x earlier, at 120000 tokens (60% of the 200000
    // compactWindowTokens), not here.
    const trigger = makeSoftTrigger(60, 200000, { getUsage: async () => ({ tokens: 120000, percent: 12 }), compact });
    await trigger.onTurnComplete();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('round 8 finding 10: one compact per crossing, does not re-fire on a second turn that is still above threshold', async () => {
    const compact = vi.fn(async () => {});
    const trigger = makeSoftTrigger(60, 200000, { getUsage: async () => ({ tokens: 150000 }), compact });
    await trigger.onTurnComplete();
    await trigger.onTurnComplete();
    await trigger.onTurnComplete();
    expect(compact, 'usage stayed above threshold on every turn; re-firing each time would pay for a fallback core summary every turn for no gain').toHaveBeenCalledTimes(1);
  });

  it('round 8 finding 10: re-arms once a reading comes in below the threshold, then fires again on the next crossing', async () => {
    const compact = vi.fn(async () => {});
    let tokens = 150000;
    const trigger = makeSoftTrigger(60, 200000, { getUsage: async () => ({ tokens }), compact });
    await trigger.onTurnComplete();
    expect(compact).toHaveBeenCalledTimes(1);
    tokens = 50000;
    await trigger.onTurnComplete();
    expect(compact, 'a below-threshold reading must not itself trigger').toHaveBeenCalledTimes(1);
    tokens = 150000;
    await trigger.onTurnComplete();
    expect(compact, 'a fresh crossing after a below-threshold reading must fire again').toHaveBeenCalledTimes(2);
  });

  it('round 9 finding 4: re-arms when compact() rejects, instead of disabling the soft trigger for the rest of the crossing', async () => {
    let shouldReject = true;
    const compact = vi.fn(async () => {
      if (shouldReject) throw new Error('rejects while a turn runs');
    });
    const trigger = makeSoftTrigger(60, 200000, { getUsage: async () => ({ tokens: 150000 }), compact });
    await expect(trigger.onTurnComplete()).rejects.toThrow('rejects while a turn runs');
    expect(compact).toHaveBeenCalledTimes(1);
    shouldReject = false;
    await trigger.onTurnComplete();
    expect(compact, 'a rejected compact() must not have actually compacted anything, so the very next reading (still above threshold) must fire again, not stay disarmed').toHaveBeenCalledTimes(2);
  });

  it('round 9 finding 4: re-arms when compact() resolves with {skip}, instead of disabling the soft trigger for the rest of the crossing', async () => {
    const compact = vi.fn(async () => ({ skip: 'a hook vetoed it' }) as unknown as void);
    const trigger = makeSoftTrigger(60, 200000, { getUsage: async () => ({ tokens: 150000 }), compact });
    await trigger.onTurnComplete();
    expect(compact).toHaveBeenCalledTimes(1);
    await trigger.onTurnComplete();
    expect(compact, 'a skipped compact() did not compact anything either, so the trigger must not stay disarmed').toHaveBeenCalledTimes(2);
  });

  it('round 9 finding 4: re-arms once tokens drop below the level they were at when the trigger last fired, even while still above the raw threshold (a single long tool turn after compaction)', async () => {
    const compact = vi.fn(async () => {});
    let tokens = 150000;
    // threshold = 60% of 200000 = 120000
    const trigger = makeSoftTrigger(60, 200000, { getUsage: async () => ({ tokens }), compact });
    await trigger.onTurnComplete();
    expect(compact).toHaveBeenCalledTimes(1);
    // A compaction happened and tokens fell to 130000: still above the raw 120000 threshold, so
    // the "re-arm only below threshold" rule alone would leave this disarmed forever, but a real
    // compaction did take effect (130000 < 150000 tokensAtFire).
    tokens = 130000;
    await trigger.onTurnComplete();
    expect(compact, 'tokens dropped compared to the last fire, so a compaction must have taken effect; the trigger must re-arm even though still above the raw threshold').toHaveBeenCalledTimes(2);
  });
});

describe('handler: G4 force-trigger override is inert when unset', () => {
  it('leaves unset or empty values inert', () => {
    expect(forceTriggerOverride({})).toBeUndefined();
    expect(forceTriggerOverride({ trigger: '', agentId: '' })).toBeUndefined();
    expect(forceTriggerOverride({ trigger: 'precompute' })).toEqual({ trigger: 'precompute' });
    expect(forceTriggerOverride({ agentId: 'sub_1' })).toEqual({ agentId: 'sub_1' });
  });

  it('compact.ts takes the override from the live gate environment variables, not from plugin options', () => {
    const source = readFileSync(new URL('../compact.ts', import.meta.url), 'utf8');
    expect(source).toContain("forceTriggerOverride({ trigger: await $.env.get('EXO_COMPACT_GATE_FORCE_TRIGGER'), agentId: await $.env.get('EXO_COMPACT_GATE_FORCE_AGENT_ID') })");
    expect(source).not.toMatch(/gateForce/);
  });

  it('returns the event unchanged when no override is supplied', () => {
    const original = event({ trigger: 'auto', agentId: 'sub_1' });
    const result = applyForceTriggerOverride(original, undefined);
    expect(result).toEqual(original);
  });

  it('overrides only the trigger when only the trigger is forced', () => {
    const original = event({ trigger: 'auto' });
    const result = applyForceTriggerOverride(original, { trigger: 'precompute' });
    expect(result.trigger).toBe('precompute');
    expect(result.agentId).toBeUndefined();
  });

  it('overrides only agentId when only the agent id is forced', () => {
    const original = event({ trigger: 'auto' });
    const result = applyForceTriggerOverride(original, { agentId: 'sub_1' });
    expect(result.trigger).toBe('auto');
    expect(result.agentId).toBe('sub_1');
  });
});

describe('handler: fallback', () => {
  it('a throw falls back to next() exactly once, logging compact.fallback', async () => {
    const log = vi.fn();
    const next = vi.fn(async () => 'native-summary');
    await withFallback({
      run: async () => {
        throw new Error('boom');
      },
      next,
      minReductionRatio: 0.25,
      timeoutMs: 5000,
      log,
      tokensBefore: 100000,
      tokensAfterOf: () => 0,
      sleep: pendingSleep,
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.some((call) => String(call[0]).startsWith('compact.fallback'))).toBe(true);
  });

  it('a run that never settles within timeoutMs falls back to next() once', { timeout: 1000 }, async () => {
    const log = vi.fn();
    const next = vi.fn(async () => 'native-summary');
    const result = await withFallback({
      run: () => new Promise(() => {}),
      next,
      minReductionRatio: 0.25,
      timeoutMs: 20,
      log,
      tokensBefore: 100000,
      tokensAfterOf: () => 0,
      sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
      }),
    });
    expect(result).toBe('native-summary');
    expect(next).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.some(([line]) => String(line) === 'compact.fallback=timeout origin=compact')).toBe(true);
  });

  it('a shrink under 25% falls back to next() once', async () => {
    const log = vi.fn();
    const next = vi.fn(async () => 'native-summary');
    const result = await withFallback({
      run: async () => 'ours',
      next,
      minReductionRatio: 0.25,
      timeoutMs: 5000,
      log,
      tokensBefore: 100000,
      tokensAfterOf: () => 90000,
      sleep: pendingSleep,
    });
    expect(result).toBe('native-summary');
    expect(next).toHaveBeenCalledTimes(1);
    // The size S4 would have left goes on the line, so status.mjs can show both numbers.
    expect(log).toHaveBeenCalledWith('compact.fallback=insufficient_reduction origin=compact sizeAfter=90000');
  });

  it('a shrink at or above 25% keeps our own result, never calling next()', async () => {
    const log = vi.fn();
    const next = vi.fn(async () => 'native-summary');
    const result = await withFallback({
      run: async () => 'ours',
      next,
      minReductionRatio: 0.25,
      timeoutMs: 5000,
      log,
      tokensBefore: 100000,
      tokensAfterOf: () => 70000,
      sleep: pendingSleep,
    });
    expect(result).toBe('ours');
    expect(next).not.toHaveBeenCalled();
  });

  it('uses an injected sleep for the timeout race and logs reason "timeout", not "error" (finding 1: the hook runtime has no global setTimeout)', async () => {
    const log = vi.fn();
    const next = vi.fn(async () => 'native-summary');
    const sleep = vi.fn(async () => {});
    const deps: DepsWithSleep<string> = {
      run: () => new Promise(() => {}),
      next,
      minReductionRatio: 0.25,
      timeoutMs: 20,
      log,
      tokensBefore: 100000,
      tokensAfterOf: () => 0,
      sleep,
    };
    const result = await withStrippedRuntimeGlobals(() => withFallback(deps));
    expect(result).toBe('native-summary');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(20, expect.anything());
    expect(log.mock.calls.some((call) => String(call[0]) === 'compact.fallback=timeout origin=compact')).toBe(true);
  });

  it('aborts the injected sleep once run() wins, leaving no dangling timer (finding 1)', async () => {
    const log = vi.fn();
    const next = vi.fn(async () => 'native-summary');
    let capturedSignal: AbortSignal | undefined;
    const sleep = vi.fn(
      (_ms: number, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          capturedSignal = signal;
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const deps: DepsWithSleep<string> = {
      run: async () => 'ours',
      next,
      minReductionRatio: 0.25,
      timeoutMs: 5000,
      log,
      tokensBefore: 100000,
      tokensAfterOf: () => 70000,
      sleep,
    };
    const result = await withFallback(deps);
    expect(result).toBe('ours');
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('passes an abort signal into run() and it is aborted once the timeout has already won the race (round 7 D7)', async () => {
    const log = vi.fn();
    const next = vi.fn(async () => 'native-summary');
    const writes: string[] = [];
    let capturedSignal: AbortSignal | undefined;
    let releaseRun: () => void = () => {};
    const runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
    const run = vi.fn((signal: AbortSignal) => {
      capturedSignal = signal;
      return runGate.then(() => {
        if (!(capturedSignal?.aborted ?? false)) writes.push('write-after-timeout');
        return 'ours';
      });
    });
    const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    });
    const resultPromise = withFallback<string>({
      run,
      next,
      minReductionRatio: 0.25,
      timeoutMs: 10,
      log,
      tokensBefore: 100,
      tokensAfterOf: () => 0,
      sleep,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(next, 'the timeout must already have fired and fallen back before run() is ever released').toHaveBeenCalledTimes(1);
    expect(capturedSignal, 'run() must be called with the AbortSignal argument, not called with none').toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted, 'the signal passed into run() must already be aborted once the timeout has won the race').toBe(true);
    releaseRun();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(writes, 'run() must see its signal aborted and skip its write once the timeout has already won').toEqual([]);
    await resultPromise;
  });
});

describe('handler: withTimeout bounds turn.complete capture work (round 7 D4)', () => {
  it('returns the value when run() settles before the timeout', async () => {
    const sleep = pendingSleep;
    const result = await withTimeout({ run: async () => 'captured', timeoutMs: 5000, sleep });
    expect(result).toEqual({ timedOut: false, value: 'captured' });
  });

  it('reports timedOut when run() never settles within timeoutMs, without throwing', async () => {
    const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    });
    const result = await withTimeout({ run: () => new Promise(() => {}), timeoutMs: 10, sleep });
    expect(result).toEqual({ timedOut: true });
  });

  it('a real error from run() (not a timeout) still propagates, is not swallowed as timedOut', async () => {
    const sleep = pendingSleep;
    await expect(withTimeout({ run: async () => { throw new Error('disk full'); }, timeoutMs: 5000, sleep })).rejects.toThrow('disk full');
  });

  it('aborts the injected sleep once run() wins, leaving no dangling timer', async () => {
    let capturedSignal: AbortSignal | undefined;
    const sleep = (_ms: number, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      capturedSignal = signal;
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    await withTimeout({ run: async () => 'ours', timeoutMs: 5000, sleep });
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('round 8 finding 9: passes an abort signal into run() and it is aborted once the timeout has already won the race, so an orphaned capture does not write after capture.timeout', async () => {
    const writes: string[] = [];
    let capturedSignal: AbortSignal | undefined;
    let releaseRun: () => void = () => {};
    const runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
    const run = vi.fn((signal: AbortSignal) => {
      capturedSignal = signal;
      return runGate.then(() => {
        if (!(capturedSignal?.aborted ?? false)) writes.push('write-after-timeout');
        return 'captured';
      });
    });
    const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    });
    const resultPromise = withTimeout<string>({ run, timeoutMs: 10, sleep });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(capturedSignal, 'run() must be called with the AbortSignal argument, not called with none').toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted, 'the signal passed into run() must already be aborted once the timeout has won the race').toBe(true);
    releaseRun();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(writes, 'run() must see its signal aborted and skip its write once capture.timeout has already fired').toEqual([]);
    expect(await resultPromise).toEqual({ timedOut: true });
  });
});
