import type { CompactEvent } from '../../core/types.js';
import type { FallbackDeps, ForceTriggerOverride, SoftTrigger, SoftTriggerDeps, TriggerRoute } from '../../core/handler.js';

/** Correct: kept unmodified, this test-only wiring helper is not part of the seeded defect. */
export function applyForceTriggerOverride(event: CompactEvent, override: ForceTriggerOverride | undefined): CompactEvent {
  if (!override) return event;
  return {
    ...event,
    ...(override.trigger !== undefined ? { trigger: override.trigger } : {}),
    ...(override.agentId !== undefined ? { agentId: override.agentId } : {}),
  };
}

export function forceTriggerOverride(_values: { trigger?: string; agentId?: string }): ForceTriggerOverride | undefined {
  return undefined;
}

/**
 * Mutation-proof defect (brief-s4a-gate.md deliverable 3, "precompute passed to next"):
 * `precompute` is routed to `next` instead of `skip`, which would let core compute a native
 * summary ahead of time (spec §3.4.5 forbids exactly this). `agentId` routing is correct so
 * that assertion still passes.
 */
export function routeTrigger(event: CompactEvent): TriggerRoute {
  if (event.trigger === 'precompute') return { kind: 'next' };
  if (event.agentId) return { kind: 'next' };
  return { kind: 'run' };
}

/** Correct: kept so the concurrency and absent-usage assertions in the same family still pass. */
export function makeSoftTrigger(thresholdPercent: number, deps: SoftTriggerDeps): SoftTrigger {
  let compacting = false;
  return {
    async onTurnComplete(): Promise<void> {
      if (compacting) return;
      compacting = true;
      try {
        const percent = await deps.getUsagePercent();
        if (percent === undefined || percent < thresholdPercent) return;
        await deps.compact();
      } finally {
        compacting = false;
      }
    },
  };
}

/**
 * Mutation-proof defect (brief-s4a-gate.md deliverable 3, "no fallback"): always returns
 * `run()`'s result, ignoring a throw, a timeout, or an insufficient shrink; `deps.next()` and
 * `deps.log` are never called.
 */
export async function withFallback<T>(deps: FallbackDeps<T>): Promise<T> {
  return deps.run();
}
