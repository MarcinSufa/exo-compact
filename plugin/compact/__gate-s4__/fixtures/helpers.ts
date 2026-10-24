import { createHash } from 'node:crypto';
import type { SessionMessage, ToolResultSummary, ToolUseSummary } from '../../core/types.js';

/**
 * Test-only token counter and hasher. `core/` never imports these; the gate injects them the
 * same way the host adapter would inject the engine's own counter and `node:crypto`'s hash
 * (spec §3.6: hashing/token counting injected, not imported, inside `core/`).
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * CPU time of the fastest of `runs` calls, in milliseconds. Timing guards catch superlinear blow-ups, which cost CPU on
 * every run. Wall time also counts the time this process waits for a core, so it failed when the full suite shared a
 * busy machine (Windows laptop, a loaded server); `process.cpuUsage` does not, and vitest runs each test file in its own
 * process (the default `forks` pool), so it counts only this file's work.
 */
export function fastestCpuMs(work: () => unknown, runs = 3): number {
  let best = Infinity;
  for (let run = 0; run < runs; run++) {
    const start = process.cpuUsage();
    work();
    const used = process.cpuUsage(start);
    best = Math.min(best, (used.user + used.system) / 1000);
  }
  return best;
}

/**
 * How much the CPU time of `work` grows when its input grows 4x: the median of five `work(4 * base)` / `work(base)`
 * pair ratios. Linear work grows about 4x and a backtracking regression 16x or more, whatever the machine's speed or
 * load, so timing guards assert growth instead of an absolute bound that a slow CI runner breaks.
 */
export function cpuGrowth(work: (scale: number) => unknown, measure: (run: () => unknown) => number = cpuMs): number {
  // The base input doubles until its run takes 20 ms (the fastest of three, so one outlier does not pick it), so timer
  // noise on a short run neither reads as growth nor hides it on a fast machine. Each pair times both sizes back to
  // back, so both see the same load, alternating which goes first; the median of five drops a pair a burst skewed.
  const fastest = (scale: number) => Math.min(measure(() => work(scale)), measure(() => work(scale)), measure(() => work(scale)));
  let base = 1;
  while (fastest(base) < 20 && base < 1024) base *= 2;
  const ratios: number[] = [];
  for (let pair = 0; pair < 5; pair++) {
    const first = pair % 2 === 0 ? base : 4 * base;
    const a = measure(() => work(first)), b = measure(() => work(first === base ? 4 * base : base));
    const [small, large] = first === base ? [a, b] : [b, a];
    ratios.push(large / Math.max(small, 1));
  }
  return ratios.sort((a, b) => a - b)[2];
}

/** CPU milliseconds (user + system) of one run of `work`. */
function cpuMs(work: () => unknown): number {
  const start = process.cpuUsage();
  work();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq}`;
}

export function resetFixtureIds(): void {
  seq = 0;
}

export function humanPrompt(text: string): SessionMessage {
  return { role: 'user', text, toolUses: [], handle: `h_${nextId('handle')}` };
}

export function assistantText(text: string): SessionMessage {
  return { role: 'assistant', text, toolUses: [], handle: `h_${nextId('handle')}` };
}

export function toolUse(tool: string, options: Partial<ToolUseSummary> = {}): ToolUseSummary {
  return { tool_use_id: options.tool_use_id ?? nextId('toolu'), tool, ...options };
}

export function toolResult(toolUseId: string, options: Partial<ToolResultSummary> = {}): ToolResultSummary {
  return { tool_use_id: toolUseId, text: options.text ?? 'ok', isError: options.isError ?? false, ...options };
}

/** An assistant message calling one tool, no result yet (an unresolved call). */
export function assistantCall(tool: string, options: Partial<ToolUseSummary> = {}): SessionMessage {
  return { role: 'assistant', text: '', toolUses: [toolUse(tool, options)], handle: `h_${nextId('handle')}` };
}

/** An assistant message calling several tools in parallel. */
export function assistantParallelCalls(tools: { tool: string; options?: Partial<ToolUseSummary> }[]): SessionMessage {
  return {
    role: 'assistant',
    text: '',
    toolUses: tools.map((t) => toolUse(t.tool, t.options)),
    handle: `h_${nextId('handle')}`,
  };
}

/** A user message carrying tool results for the given tool_use ids (never a human prompt). */
export function toolResultsMessage(results: { toolUseId: string; options?: Partial<ToolResultSummary> }[]): SessionMessage {
  return {
    role: 'user',
    text: '',
    toolUses: [],
    toolResults: results.map((r) => toolResult(r.toolUseId, r.options)),
    handle: `h_${nextId('handle')}`,
  };
}

/**
 * The hook runtime has no DOM and no Node (cc.d.ts:1-25): no `setTimeout`/`clearTimeout`/
 * `setInterval`/`clearInterval`, no `process`, no `require`, no `Buffer`. Platform services only
 * arrive through the injected `$` (clock, fs, session). This runs `run` with those globals
 * replaced by a getter that throws the moment anything reads them, so code that reaches for a
 * Node global instead of its `$`-injected equivalent fails loudly instead of silently working
 * only because the gate happens to run inside real Node. Restores the originals in `finally`
 * even if `run` throws, so it never leaks into other tests.
 */
const STRIPPED_RUNTIME_GLOBALS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'process', 'require', 'Buffer'] as const;

/**
 * Purely microtask-driven "never settles" detector: chains this many `.then()` hops on an
 * already-resolved promise. All of them run inside the current macrotask, before Node ever
 * gets a chance to service I/O (including the test runner's own worker IPC, which reaches for
 * `Buffer` internally) — a real `setTimeout`-based safety net would leave the globals stripped
 * across that I/O turn and crash the runner itself the moment anything not under test touches
 * one of them. If `run()` has not settled after this many microtask turns, it is treated as
 * hung and the race is failed while still inside the same synchronous stretch.
 */
const HANG_DETECTION_MICROTASK_TURNS = 10000;

function microtaskHangSignal(): Promise<never> {
  let p: Promise<unknown> = Promise.resolve();
  for (let i = 0; i < HANG_DETECTION_MICROTASK_TURNS; i += 1) p = p.then(() => undefined);
  return p.then(() => {
    throw new Error(
      `withStrippedRuntimeGlobals: run() did not settle within ${HANG_DETECTION_MICROTASK_TURNS} microtask turns; a ` +
        'broken/no-op withFallback that never races against anything would otherwise leave the runtime globals ' +
        'stripped across a real I/O turn and crash the test runner itself instead of failing this test cleanly',
    );
  });
}

export async function withStrippedRuntimeGlobals<T>(run: () => Promise<T> | T): Promise<T> {
  const target = globalThis as Record<string, unknown>;
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const name of STRIPPED_RUNTIME_GLOBALS) {
    originals.set(name, Object.getOwnPropertyDescriptor(target, name));
    Object.defineProperty(target, name, {
      configurable: true,
      get() {
        throw new ReferenceError(`${name} is not defined in the hook runtime (cc.d.ts:1-25, no DOM, no Node)`);
      },
    });
  }
  try {
    return await Promise.race([Promise.resolve().then(run), microtaskHangSignal()]);
  } finally {
    for (const name of STRIPPED_RUNTIME_GLOBALS) {
      const original = originals.get(name);
      if (original) Object.defineProperty(target, name, original);
      else delete target[name];
    }
  }
}

/** The slice of `$` a `session.compact`/`turn.complete` handler gets (cc.d.ts:2600-2631, 2320-2367). */
export interface FakeHost {
  fs: {
    read: (path: string) => Promise<string>;
    write: (path: string, text: string) => Promise<void>;
    list: (path?: string) => Promise<{ name: string; kind: string; size: number }[]>;
    exists: (path: string) => Promise<boolean>;
  };
  ui: { log: (line: string) => void };
  session: {
    id: () => Promise<string>;
    cwd: () => Promise<string>;
    compact: () => Promise<void>;
    usage: () => Promise<{ context?: { tokens?: number; percent?: number } }>;
    messages: () => Promise<SessionMessage[]>;
  };
  clock: {
    sleep: (ms: number, options: { signal: AbortSignal }) => Promise<void>;
    after: (ms: number, fn: () => void) => { cancel: () => void };
    /** cc.d.ts: "resolves milliseconds since the epoch, now". Selector J's total-budget clock (review-opus-s4b.md F2). */
    now: () => Promise<number>;
  };
  /** cc.d.ts:2810-2829, `get`/`set` over the process environment. S4d only ever reads `HOME`. */
  env: { get: (name: string) => Promise<string | undefined>; set: (name: string, value: string | undefined) => Promise<void> };
  /**
   * cc.d.ts:2736-2751, `$.http.fetch`. Selector J (spec v3.4 §3.3) is the only caller
   * (`host/jev-client.ts`); no other S4 slice reaches the network. Defaults to a fetch that
   * throws, so a test that forgets to override it and unexpectedly triggers a real Jev call fails
   * loudly instead of silently resolving with nothing.
   */
  http: { fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; text: string }> };
  process: { run: (argv: readonly string[], init?: { timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }> };
}

/**
 * A fake `$`, for handler-level tests (finding 5) that need `$.fs`/`$.session` to reject on
 * demand without a real host. Every capability defaults to a benign no-op; pass an override to
 * make one specific call fail. `clock.sleep` for a real, positive `ms` (every pre-round-15
 * `timeoutMs` in this suite) defaults to a promise that only settles by rejecting on abort,
 * mirroring the real `$.clock.sleep(ms, { signal })` (CONTRACT.md's timer dependency note): a
 * `withFallback`/`withTimeout` race whose `run()` wins first calls `controller.abort()`, so this
 * never fires spuriously and never leaves a real pending timer across tests.
 *
 * Round 15 (brief-s4a-fix15.md item 3): `compact.ts` now also calls `$.clock.sleep(0, { signal })`
 * bare, between pipeline phases, purely to yield a macrotask back to the hooks worker's heartbeat
 * (not to bound a race against anything). `ms <= 0` is exactly that shape, never the
 * bounded-real-wait shape the "only settles by rejecting on abort" default models, so it resolves
 * at once instead (still rejecting first if `signal` is already aborted, matching cc.d.ts 7847
 * "Aborting it rejects the sleep at once"). No existing call site in this suite passes `ms <= 0`
 * to the default (every `timeoutMs` here is a real positive bound), so this is additive: nothing
 * that already relied on the never-resolves default changes behavior.
 */
export function fakeHost(overrides: {
  fsRead?: FakeHost['fs']['read'];
  fsWrite?: FakeHost['fs']['write'];
  fsList?: FakeHost['fs']['list'];
  fsExists?: FakeHost['fs']['exists'];
  uiLog?: FakeHost['ui']['log'];
  sessionCompact?: FakeHost['session']['compact'];
  sessionUsage?: FakeHost['session']['usage'];
  sessionMessages?: FakeHost['session']['messages'];
  sessionId?: () => Promise<string>;
  sessionCwd?: () => Promise<string>;
  clockSleep?: FakeHost['clock']['sleep'];
  clockAfter?: FakeHost['clock']['after'];
  clockNow?: FakeHost['clock']['now'];
  envGet?: FakeHost['env']['get'];
  envSet?: FakeHost['env']['set'];
  httpFetch?: FakeHost['http']['fetch'];
  processRun?: FakeHost['process']['run'];
} = {}): FakeHost {
  return {
    fs: {
      read: overrides.fsRead ?? (async () => ''),
      write: overrides.fsWrite ?? (async () => {}),
      /**
       * Round 7 D2: a real `$.fs.list` rejects for a directory that does not exist yet (Node
       * `readdir` behavior, cc.d.ts:2618-2624 makes no promise of an empty result for a missing
       * path). Defaulting to `[]` hid the first-turn-of-every-session case where `appendRecords`
       * lists `.exovault/s4-capture/<id>/` before it has ever been created. Production code must
       * check `exists` first and never reach this default for a path it has not created.
       */
      list: overrides.fsList ?? (async (path?: string) => {
        const error = new Error(`ENOENT: no such file or directory, scandir '${path ?? ''}'`) as Error & { code?: string };
        error.code = 'ENOENT';
        throw error;
      }),
      exists: overrides.fsExists ?? (async (path) => {
        if (path.endsWith('/.exovault/s4-compact-active')) {
          try { await (overrides.fsRead ?? (async () => '') )('.exovault/s4-compact-active'); return true; } catch { return false; }
        }
        return false;
      }),
    },
    ui: { log: overrides.uiLog ?? (() => {}) },
    session: {
      id: overrides.sessionId ?? (async () => 'session-default'),
      cwd: overrides.sessionCwd ?? (async () => '/project'),
      compact: overrides.sessionCompact ?? (async () => {}),
      usage: overrides.sessionUsage ?? (async () => ({ context: { percent: 0 } })),
      messages: overrides.sessionMessages ?? (async () => []),
    },
    clock: {
      sleep:
        overrides.clockSleep ??
        ((ms, { signal }) => {
          if (signal.aborted) return Promise.reject(new Error('aborted'));
          if (ms <= 0) return Promise.resolve();
          return new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        }),
      // A real, monotonically-useful clock: selector J's total-budget accounting (F2) reads
      // elapsed = now() - startedAt, so a constant would report zero elapsed time forever and
      // never exercise a real budget-exhaustion path in an end-to-end test. Defaults to the real
      // wall clock; a test asserting exact elapsed-time behavior overrides this explicitly.
      now: overrides.clockNow ?? (async () => Date.now()),
      after: overrides.clockAfter ?? (() => ({ cancel: () => {} })),
    },
    env: {
      // No HOME by default: `derivedTranscriptPath` (host/transcript-path.ts) returns null when
      // HOME is unset, so a test that does not care about the transcript pointer sees it simply
      // omitted (spec §3.1.2's "otherwise omitted, seed.transcript_pointer=missing logged").
      get: overrides.envGet ?? (async () => undefined),
      set: overrides.envSet ?? (async () => {}),
    },
    http: {
      fetch:
        overrides.httpFetch ??
        (async () => { throw new Error('fakeHost: $.http.fetch was not overridden for this test'); }),
    },
    process: { run: overrides.processRun ?? (async () => ({ exitCode: 0, stdout: '', stderr: '' })) },
  };
}

/**
 * 4.8.0: the manifest defaults changed (recallEnabled and interactiveOnly on, briefPush and briefCheck off) and the code
 * fallbacks follow them (option-defaults.gate.test.ts). These wiring tests were written against the old defaults and fake
 * a host with no terminal surface, so they pin those four options explicitly instead of inheriting the fallback.
 */
export const LEGACY_OPTIONS = { interactiveOnly: false, recallEnabled: false, briefPush: true, briefCheck: true } as const;
