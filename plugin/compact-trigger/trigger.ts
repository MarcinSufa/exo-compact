import type { On, PluginOptions, Register } from 'claude-code';
import { makeSoftTrigger } from './core/handler.js';
import { isCaptureEnabled } from './host/capture-flag.js';

function optionNumber(options: PluginOptions, name: string, fallback: number): number {
  const value = options[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export const register: Register = (on: On, options: PluginOptions) => {
  // Round 11 (hook compiler's `$` spelling rule, CONTRACT.md): `makeSoftTrigger` no longer takes
  // its deps at construction time (that required stashing a since-registration `currentHost = $`
  // in an outer variable so the once-built deps closure could reach a later turn's `$`, which the
  // compiler refuses outright: `$` may never be assigned to a variable, only followed as
  // `$.noun.event(...)` at the call site). `onTurnComplete` now takes a fresh `SoftTriggerDeps`
  // built from that turn's own `$` on every call; `running`/`armed`/`tokensAtFire` still persist
  // across turns inside `softTrigger` itself.
  const softTrigger = makeSoftTrigger(optionNumber(options, 'softThresholdPercent', 60), optionNumber(options, 'compactWindowTokens', 200000));
  on('turn.complete', async ($, event, next) => {
    const result = await next(event);
    try {
      const flagHost = { cwd: () => $.session.cwd(), exists: (path: string) => $.fs.exists(path), root: () => $.session.root(), home: async () => (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) };
      if (!(await isCaptureEnabled(flagHost)) || event.agentId || event.reason !== 'answer') return result;
      await softTrigger.onTurnComplete({
        getUsage: async () => (await $.session.usage()).context,
        compact: async () => (await $.session.compact()) as { skip?: unknown } | void,
      });
    } catch {
      // Round 9 finding 7: the soft-trigger's own background session.compact() call failing here
      // is logged after next(event) already returned this turn's own result; it does not mean
      // core ran. Tagged `origin=trigger` so lib.mjs's coreRan() does not count it as core running.
      $.ui.log('compact.fallback=error origin=trigger');
    }
    return result;
  });
};
