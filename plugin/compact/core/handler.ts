import type { CompactEvent } from './types.js';

export type TriggerRoute =
  | { kind: 'skip'; reason: string }
  | { kind: 'next' }
  | { kind: 'run' };

/**
 * First thing a `session.compact` handler must do (spec §3.4.5, §5.1 G4):
 * - `precompute` -> `{ skip }`, before any extraction or write;
 * - `agentId` present -> pass to `next(e)` (subagents/forks are out of scope, spec §3.4.4);
 * - otherwise -> run the S4a compaction.
 */
export function routeTrigger(event: CompactEvent): TriggerRoute {
  if (event.trigger === 'precompute') return { kind: 'skip', reason: 'precompute' };
  if (event.agentId !== undefined) return { kind: 'next' };
  return { kind: 'run' };
}

export interface ForceTriggerOverride {
  trigger?: CompactEvent['trigger'];
  agentId?: string;
}

/**
 * The live gate's test-only override, from `EXO_COMPACT_GATE_FORCE_TRIGGER` and `EXO_COMPACT_GATE_FORCE_AGENT_ID` (compact.ts
 * reads them: `$.env.get` takes literal names only). Unset or empty values are inert.
 */
export function forceTriggerOverride({ trigger, agentId }: { trigger?: string; agentId?: string }): ForceTriggerOverride | undefined {
  const override: ForceTriggerOverride = {};
  if (trigger) override.trigger = trigger as CompactEvent['trigger'];
  if (agentId) override.agentId = agentId;
  return Object.keys(override).length > 0 ? override : undefined;
}

export function applyForceTriggerOverride(
  event: CompactEvent,
  override: ForceTriggerOverride | undefined,
): CompactEvent {
  if (!override) return event;
  return {
    ...event,
    ...(override.trigger !== undefined ? { trigger: override.trigger } : {}),
    ...(override.agentId !== undefined ? { agentId: override.agentId } : {}),
  };
}

/** `$.session.usage().context`, the slice the soft trigger reads (round 8 finding 3). */
export interface UsageSnapshot {
  tokens?: number;
  percent?: number;
}

export interface SoftTriggerDeps {
  /** `(await $.session.usage()).context`; absent means no trigger (spec §3.4.1). */
  getUsage: () => Promise<UsageSnapshot | undefined>;
  /**
   * `$.session.compact()`. May reject (cc.d.ts ~2349: "rejects while a turn runs", the G2 stream
   * race) or resolve `{ skip }` (a hook vetoed it, round 9 finding 4); either way no compaction
   * happened, which `onTurnComplete` below uses to re-arm instead of disarming for the rest of
   * the crossing.
   */
  compact: () => Promise<{ skip?: unknown } | void>;
}

export interface SoftTrigger {
  /** Bound to `turn.complete`. */
  onTurnComplete: () => Promise<void>;
}

/**
 * Soft trigger (spec §3.4.1, round 8 finding 3).
 *
 * `thresholdPercent` is 0-100, but it is no longer compared against `context.percent` (which
 * cc.d.ts:7372-7391 defines against the *model's* context window): on a 1M-window model that
 * fires 5x too late, and with a smaller configured compaction window (e.g. `autoCompactWindow`)
 * it can fail to fire at all. Instead the threshold is applied to `compactWindowTokens` (the
 * fixed 200000-token compaction-window constant the spec was written against, not the model's
 * actual window): fires when `usage.tokens >= thresholdPercent / 100 * compactWindowTokens`.
 * `usage.percent` is used only when `usage.tokens` is absent (a host that cannot report raw
 * tokens), in which case it is compared to `thresholdPercent` directly as before. Absent usage
 * never triggers.
 *
 * One compact per crossing (round 7 D10 item 8 / round 8 finding 10): once fired, the trigger
 * will not fire again until a later reading comes in *below* the threshold (the compaction that
 * just ran should have brought usage back down; if it did not, or usage climbed straight back up
 * before the next reading, re-firing every single turn would each pay for a fallback core summary
 * for no gain). `armed` starts `true` so the very first crossing still fires.
 *
 * Round 9 finding 4: never re-arming has two gaps the above rule alone leaves open, both of which
 * would otherwise disable the soft trigger for the rest of a crossing even though a compaction
 * either did not happen or did happen and helped:
 * - `deps.compact()` rejects or resolves `{ skip }`: nothing compacted, so the next reading, even
 *   though still above threshold, must be treated as a fresh chance to fire, not a re-crossing
 *   already handled.
 * - a single long tool turn right after a real S4 compaction can add enough tokens that the very
 *   next reading is already back above the raw threshold; `tokensAtFire` records the reading the
 *   trigger last fired at, and a later reading *below that* re-arms even while still above
 *   threshold, since it proves a compaction did take effect.
 *
 * The re-entry guard is set synchronously before the first `await`, so two `turn.complete`
 * events that land before either has awaited still call `deps.compact()` at most once between
 * them.
 */
export function makeSoftTrigger(thresholdPercent: number, compactWindowTokens: number, deps: SoftTriggerDeps): SoftTrigger {
  let running = false;
  let armed = true;
  let tokensAtFire: number | undefined;
  return { async onTurnComplete() {
    if (running) return;
    running = true;
    try {
      const usage = await deps.getUsage();
      if (!usage) return;
      const thresholdTokens = (thresholdPercent / 100) * compactWindowTokens;
      const above = usage.tokens !== undefined ? usage.tokens >= thresholdTokens : usage.percent !== undefined ? usage.percent >= thresholdPercent : false;
      if (!above) { armed = true; return; }
      if (!armed && usage.tokens !== undefined && tokensAtFire !== undefined && usage.tokens < tokensAtFire) armed = true;
      if (!armed) return;
      armed = false;
      tokensAtFire = usage.tokens;
      try {
        const result = await deps.compact();
        if (result && typeof result === 'object' && 'skip' in result && result.skip !== undefined) armed = true;
      } catch (error) {
        armed = true;
        throw error;
      }
    } finally { running = false; }
  } };
}

export interface FallbackDeps<T> {
  /**
   * Round 7 D7: receives the same `AbortSignal` `withFallback` aborts once a result is in hand
   * (a win by `run()` itself, a timeout, or an insufficient-reduction result). `run()` must
   * check `signal.aborted` before any write, because losing the race does not cancel it: a slow
   * `run()` keeps executing as an orphaned promise after `next()` has already been called, and
   * without this check it could still `appendRecords` and move the watermark after core
   * compaction has started beneath it.
   */
  run: (signal: AbortSignal) => Promise<T>;
  next: () => Promise<T>;
  minReductionRatio: number;
  timeoutMs: number;
  log: (line: string) => void;
  tokensBefore: number;
  tokensAfterOf: (result: T) => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Wraps a compaction attempt (spec §3.5): a throw, a timeout, or a result that does not
 * shrink the context by at least `minReductionRatio` all fall back to `deps.next()`,
 * exactly once, logging `compact.fallback=<reason>` first.
 *
 * Round 9 finding 7: this is the only `compact.fallback=` writer for which the string genuinely
 * means "core ran" (`deps.next()` below is `compact.ts`'s own `next(input)`, i.e. core). Every
 * line therefore carries `origin=compact` so `lib.mjs`'s live-probe `coreRan()` can tell it apart
 * from `compact.ts`'s `turn.complete` handler and `trigger.ts`, which log the same prefix for
 * failures that have nothing to do with core having run.
 */
export async function withFallback<T>(deps: FallbackDeps<T>): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = deps.sleep(deps.timeoutMs, controller.signal).then(() => {
    timedOut = true;
    throw new Error('timeout');
  });
  try {
    const result = await Promise.race([deps.run(controller.signal), timeout]);
    controller.abort();
    const tokensAfter = deps.tokensAfterOf(result);
    if (deps.tokensBefore > 0 && 1 - tokensAfter / deps.tokensBefore >= deps.minReductionRatio) return result;
    // 4.8.0: sizeAfter (what the seed and tail would have left) goes after origin=compact, so tools/status.mjs can show both sizes.
    deps.log(`compact.fallback=insufficient_reduction origin=compact sizeAfter=${tokensAfter}`);
  } catch (error) {
    controller.abort();
    const reason = timedOut ? 'timeout' : error instanceof Error && error.message === 'budget' ? 'budget' : 'error';
    deps.log(`compact.fallback=${reason} origin=compact`);
  }
  return deps.next();
}

export interface TimeoutBoundDeps<T> {
  /**
   * Round 8 finding 9: receives the same `AbortSignal` `withTimeout` aborts once a result is in
   * hand, exactly like `FallbackDeps.run` above. `run()` must check `signal.aborted` before any
   * write: losing the race does not cancel it, and an orphaned `run()` that keeps executing after
   * `capture.timeout` was already logged can otherwise still `appendRecords`, landing concurrently
   * with the next turn's read-modify-write of the same segment or moving the watermark backwards
   * under it.
   */
  run: (signal: AbortSignal) => Promise<T>;
  timeoutMs: number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type TimeoutBoundResult<T> = { timedOut: false; value: T } | { timedOut: true };

/**
 * Bounds `turn.complete` capture work in a `$.clock`-based timeout (round 7 D4). Unlike
 * `withFallback` there is no `next()` result to prefer and no reduction check: the caller either
 * gets `run()`'s value, or, if the timer wins, `{ timedOut: true }` and skips capture for that
 * turn without advancing the watermark. Same non-cancelling caveat as `withFallback`: the signal
 * is only a request, `run()` must still check it before writing.
 */
export async function withTimeout<T>(deps: TimeoutBoundDeps<T>): Promise<TimeoutBoundResult<T>> {
  const controller = new AbortController();
  const timeout = deps.sleep(deps.timeoutMs, controller.signal).then(() => {
    throw new Error('timeout');
  });
  try {
    const value = await Promise.race([deps.run(controller.signal), timeout]);
    controller.abort();
    return { timedOut: false, value };
  } catch (error) {
    controller.abort();
    if (error instanceof Error && error.message === 'timeout') return { timedOut: true };
    throw error;
  }
}
