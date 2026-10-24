import { describe, expect, it, vi } from 'vitest';
import { register } from '../trigger.js';
import { fakeHost, withStrippedRuntimeGlobals } from '../../compact/__gate-s4__/fixtures/helpers.js';

type Handler = (host: unknown, event: unknown, next: (event: unknown) => Promise<unknown>) => Promise<unknown>;

function harness(options: Record<string, unknown> = {}): Handler {
  let handler: Handler | undefined;
  const catches: Record<string, unknown> = {};
  register(((name: string, fn: Handler) => { handler = fn; return { catch: (caught: unknown) => { catches[name + '.catch'] = caught; } }; }) as never, options as never);
  if (!handler) throw new Error('trigger.ts did not register a turn.complete handler');
  return handler;
}

function markerFile(dir: string, leaf: 's4-compact-active' | 's4-compact-off'): string {
  const separator = /[\\/]$/.test(dir) ? '' : '/';
  return `${dir}${separator}.exovault/${leaf}`;
}

function markerExists(active: readonly string[], off: readonly string[] = []): (path: string) => Promise<boolean> {
  const on = new Set(active.map((dir) => markerFile(dir, 's4-compact-active')));
  const denied = new Set(off.map((dir) => markerFile(dir, 's4-compact-off')));
  return async (path) => on.has(path) || denied.has(path);
}

function hostFor(cwd: string, root: string | 'absent' | 'reject', exists: (path: string) => Promise<boolean>, sessionCompact: ReturnType<typeof vi.fn>) {
  const base = fakeHost({
    fsExists: exists,
    sessionCwd: async () => cwd,
    sessionUsage: async () => ({ context: { tokens: 150000, percent: 80 } }),
    sessionCompact: sessionCompact as never,
  });
  const session: typeof base.session & { root?: () => Promise<string> } = { ...base.session, cwd: async () => cwd };
  if (root === 'reject') session.root = async () => { throw new Error('root rejected'); };
  else if (root !== 'absent') session.root = async () => root;
  return { ...base, session };
}

const above = { softThresholdPercent: 60, compactWindowTokens: 200000 };

async function fire(cwd: string, root: string | 'absent' | 'reject', exists: (path: string) => Promise<boolean>) {
  const sessionCompact = vi.fn(async () => ({}));
  const handler = harness(above);
  const host = hostFor(cwd, root, exists, sessionCompact);
  await withStrippedRuntimeGlobals(() => handler(host, { reason: 'answer' }, async () => ({ ok: true })));
  return sessionCompact;
}

describe('trigger session root', () => {
  it('B3 reaches session.compact when the shell is outside the flagged project', async () => {
    const sessionCompact = await fire('/tmp/wt', '/proj', markerExists(['/proj']));
    expect(sessionCompact, 'B3 trigger must call session.compact').toHaveBeenCalledTimes(1);
  });

  it('B4 does not compact when the root walk finds the opt-out', async () => {
    const sessionCompact = await fire('/tmp/wt', '/proj', markerExists(['/tmp/wt'], ['/proj']));
    expect(sessionCompact, 'B4 trigger must not call session.compact').not.toHaveBeenCalled();
  });

  it('B5 control stays inert when no marker exists', async () => {
    const sessionCompact = await fire('/tmp/wt', '/proj', markerExists([]));
    expect(sessionCompact).not.toHaveBeenCalled();
  });

  it('B6 control still compacts when session.root is absent and the shell is flagged', async () => {
    const sessionCompact = await fire('/proj', 'absent', markerExists(['/proj']));
    expect(sessionCompact, 'B6 absent root must still call session.compact').toHaveBeenCalledTimes(1);
  });

  it('B6 control still compacts when session.root rejects and the shell is flagged', async () => {
    const sessionCompact = await fire('/proj', 'reject', markerExists(['/proj']));
    expect(sessionCompact, 'B6 rejecting root must still call session.compact').toHaveBeenCalledTimes(1);
  });

  it('B7 control does not compact when the shell directory carries the opt-out', async () => {
    const sessionCompact = await fire('/home/u/q', '/proj', markerExists(['/proj'], ['/home/u/q']));
    expect(sessionCompact).not.toHaveBeenCalled();
  });
});
