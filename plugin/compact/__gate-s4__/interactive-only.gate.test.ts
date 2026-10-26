import { LEGACY_OPTIONS } from './fixtures/helpers.js';
import { describe, expect, it } from 'vitest';
import type { CompactEvent } from '../core/types.js';

type Handler = (host: unknown, event: unknown, next: () => Promise<unknown>) => Promise<unknown>;

async function handlers(options: Record<string, unknown>) {
  const { register } = await import('../compact.js');
  const on: Record<string, Handler> = {};
  register(((name: string, fn: Handler) => { on[name] = fn; return { catch: (caught: unknown) => { (on as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS, ...options } as never);
  return on;
}

function fakeHost(surfaces: string[], env: Record<string, string | undefined> = {}, opts: { capture?: boolean } = {}) {
  const calls: string[] = [];
  const logs: { line: string; extra?: unknown }[] = [];
  const capture = opts.capture !== false;
  return {
    calls,
    logs,
    session: {
      cwd: async () => '/tmp/project',
      id: async () => 's1',
      surfaces: async () => surfaces,
      messages: async () => { calls.push('messages'); return []; },
    },
    fs: {
      exists: async (path: string) => { calls.push(`exists ${path}`); return capture && path.endsWith('.exovault/s4-compact-active'); },
      read: async (path: string) => { calls.push(`read ${path}`); throw new Error('ENOENT'); },
      write: async (path: string) => { calls.push(`write ${path}`); },
      list: async (path?: string) => { calls.push(`list ${path}`); return []; },
    },
    ui: {
      log: (line: string, extra?: unknown) => {
        calls.push(`log ${line}`);
        logs.push({ line, extra });
      },
    },
    env: { get: (name: string) => env[name] },
    http: { fetch: async () => ({ ok: false, status: 500, text: '' }) },
    clock: { sleep: async () => undefined, now: () => 0 },
    // 4.9.2 review: the capture guard runs harden.mjs from the plugin root before any capture write; exit 0 passes.
    plugin: { name: 'exo-compact', root: '/fake-plugin' },
    process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
  };
}

const event: CompactEvent = { trigger: 'auto', messages: [] };
const onlyFlagCheck = ['exists /tmp/project/.exovault/s4-compact-active'];

describe('interactiveOnly', () => {
  it('keeps native compaction for a run with no surface (-p or SDK)', async () => {
    const on = await handlers({ interactiveOnly: true });
    const $ = fakeHost([]);
    const native = { messages: [] };
    expect(await on['session.compact']($, event, async () => native)).toBe(native);
    expect($.logs.map((entry) => entry.line)).toEqual(['compact.fallback=interactive_only origin=compact entrypoint=unset']);
  });

  it('names sdk-cli on the interactive_only line', async () => {
    const on = await handlers({ interactiveOnly: true });
    const $ = fakeHost([], { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
    const native = { messages: [] };
    expect(await on['session.compact']($, event, async () => native)).toBe(native);
    expect($.logs.map((entry) => entry.line)).toEqual(['compact.fallback=interactive_only origin=compact entrypoint=sdk-cli']);
  });

  it('skips turn capture for a run with no surface', async () => {
    const on = await handlers({ interactiveOnly: true });
    const $ = fakeHost([]);
    let nextCalled = false;
    await on['turn.complete']($, { reason: 'answer' }, async () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect($.calls).toEqual(onlyFlagCheck);
  });

  it('does not short-circuit a terminal session', async () => {
    const on = await handlers({ interactiveOnly: true, notices: 'all' });
    const $ = fakeHost(['terminal']);
    await on['session.compact']($, event, async () => ({ messages: [] }));
    expect($.calls).toContain('log compact.sizeBefore=0');
  });

  it('is off by default, so a headless run with the flag still uses S4', async () => {
    const on = await handlers({});
    const $ = fakeHost([]);
    await on['session.compact']($, event, async () => ({ messages: [] }));
    expect($.calls).toContain('log compact.sizeBefore=0');
  });

  it('does not short-circuit an extension session', async () => {
    const on = await handlers({ interactiveOnly: true, notices: 'all' });
    const $ = fakeHost([], { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' });
    await on['session.compact']($, event, async () => ({ messages: [] }));
    expect($.calls).toContain('log compact.sizeBefore=0');
  });

  it('keeps native compaction for an extension child session', async () => {
    const on = await handlers({ interactiveOnly: true });
    const $ = fakeHost([], { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', CLAUDE_CODE_CHILD_SESSION: '1' });
    const native = { messages: [] };
    expect(await on['session.compact']($, event, async () => native)).toBe(native);
    expect($.logs.map((entry) => entry.line)).toEqual(['compact.fallback=interactive_only origin=compact entrypoint=claude-vscode']);
  });

  it('keeps native compaction for a brief child of an extension session', async () => {
    const on = await handlers({ interactiveOnly: true });
    const $ = fakeHost([], { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', EXOVAULT_BRIEF_CHILD: '1' });
    const native = { messages: [] };
    expect(await on['session.compact']($, event, async () => native)).toBe(native);
    expect($.logs.map((entry) => entry.line)).toEqual(['compact.fallback=interactive_only origin=compact entrypoint=claude-vscode']);
  });

  it('reads session messages on turn.complete for an extension session', async () => {
    const on = await handlers({ interactiveOnly: true, taskCard: false });
    const $ = fakeHost([], { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' });
    // withTimeout races capture against clock.sleep(timeoutMs). Resolving that sleep immediately reports a timeout before messages() runs.
    $.clock.sleep = (ms?: number) => (ms ? new Promise(() => undefined) : Promise.resolve(undefined));
    await on['turn.complete']($, { reason: 'answer' }, async () => undefined);
    expect($.calls).toContain('messages');
  });

  it.each([
    ['no surface and no entrypoint, interactiveOnly on', [] as string[], {} as Record<string, string | undefined>, { interactiveOnly: true }],
    ['no surface and no entrypoint, interactiveOnly off', [], {}, {}],
    ['a terminal session', ['terminal'], { CLAUDE_CODE_ENTRYPOINT: 'cli' }, { interactiveOnly: true }],
    ['an extension session', [], { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }, { interactiveOnly: true }],
    ['an sdk-cli session', [], { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, {}],
  ])('debug-logs not_enabled when capture is off (%s)', async (_label, surfaces, env, options) => {
    const on = await handlers(options);
    const $ = fakeHost(surfaces, env, { capture: false });
    const native = { messages: [] };
    expect(await on['session.compact']($, event, async () => native)).toBe(native);
    expect($.logs).toEqual([{ line: 'compact.fallback=not_enabled origin=compact', extra: { to: 'debug' } }]);
  });
});
