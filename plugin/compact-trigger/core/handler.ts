/**
 * Round 10: this is a self-contained copy of `makeSoftTrigger` and its supporting types from
 * `../compact/core/handler.ts` (CONTRACT.md's Handler section is the source of truth for both
 * copies; keep them in sync by hand). `compact.ts` only ever imports `./core/*` from inside its
 * own plugin directory, and nothing in this repo has verified that the hook runtime's module
 * loader bundles a relative import that escapes a plugin's own directory (cc.d.ts:1-25: "a hooks
 * module runs in an environment of its own: no DOM, no Node", so there is no ordinary Node
 * module resolution to fall back on if it does not). Rather than have `trigger.ts` reach across
 * into `../compact/core/handler.js` on an unverified assumption, `exovault-s4-trigger` carries
 * its own copy, exactly like `compact.ts` only ever imports `./core/handler.js` relative to
 * itself. `routeTrigger`, `withFallback` and `withTimeout` (the other exports of the original
 * file, used only by `compact.ts`'s `session.compact`/`turn.complete` capture path) are not
 * needed here and are not duplicated.
 */

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
  /**
   * Bound to `turn.complete`. Round 11 (hook compiler's `$` spelling rule, CONTRACT.md): takes
   * `deps` per call instead of once at construction time. `trigger.ts` used to stash that turn's
   * `$` in an outer `currentHost` variable at registration time so a single, once-built
   * `SoftTriggerDeps` closure could read it on every later turn; the compiler refuses `$` stored
   * in an outer variable at all (only `$.noun.event(...)` at the call site is allowed), so
   * `trigger.ts` now builds a fresh `SoftTriggerDeps` from that turn's own `$` and passes it here
   * every time. `running`/`armed`/`tokensAtFire` below stay closed over across calls exactly as
   * before; only the usage/compact functions travel with each call instead of being fixed at
   * construction. This diverges from `../../compact/core/handler.ts`'s own `makeSoftTrigger`
   * (construction-time deps, `onTurnComplete(): Promise<void>`), which stays as-is: that copy is
   * never wired to any `register()` in the `compact` plugin (CONTRACT.md: "unit-tested here, no
   * longer wired to any register() in this plugin"), so it never receives a real `$` and is not
   * subject to the hook compiler's rule at all. Only this plugin's own copy, the one `trigger.ts`
   * actually calls with a real `$`, needed the shape change.
   */
  onTurnComplete: (deps: SoftTriggerDeps) => Promise<void>;
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
export function makeSoftTrigger(thresholdPercent: number, compactWindowTokens: number): SoftTrigger {
  let running = false;
  let armed = true;
  let tokensAtFire: number | undefined;
  return { async onTurnComplete(deps: SoftTriggerDeps) {
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
