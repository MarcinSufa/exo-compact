import { describe, expect, it } from 'vitest';
import { capturePath } from '../host/capture-path.js';
import { findCaptureRoot } from '../host/capture-flag.js';

type Handler = (host: unknown, event: unknown, next: () => Promise<unknown>) => Promise<unknown>;

const flagAt = (dirs: string[]) => async (path: string) => dirs.some((dir) => path === `${dir}/.exovault/s4-compact-active`);
// 4.8.0: no flag up the tree means active, anchored in the home directory; these tests pin the nearest-flag walk, so home is a fixed fake.
const HOME = '/home/u';
const home = async () => HOME;

describe('capture root', () => {
  it('is the nearest directory holding the flag, else the home directory', async () => {
    expect(await findCaptureRoot({ cwd: async () => '/home/u/work/repo/sub', exists: flagAt(['/home/u']), home })).toBe('/home/u');
    expect(await findCaptureRoot({ cwd: async () => '/home/u/work/repo', exists: flagAt(['/home/u', '/home/u/work/repo']), home })).toBe('/home/u/work/repo');
    expect(await findCaptureRoot({ cwd: async () => '/elsewhere', exists: flagAt(['/home/u/work/repo']), home })).toBe('/home/u');
  });

  it('a project opt-out below the flag turns S4 off there and only there', async () => {
    const at = (active: string[], off: string[]) => async (path: string) =>
      active.some((dir) => path === `${dir}/.exovault/s4-compact-active`) || off.some((dir) => path === `${dir}/.exovault/s4-compact-off`);
    const exists = at(['/home/u'], ['/home/u/work/codex']);
    expect(await findCaptureRoot({ cwd: async () => '/home/u/work/codex/sub', exists, home })).toBeNull();
    expect(await findCaptureRoot({ cwd: async () => '/home/u/work/codex', exists, home })).toBeNull();
    expect(await findCaptureRoot({ cwd: async () => '/home/u/work/other', exists, home })).toBe('/home/u');
    expect(await findCaptureRoot({ cwd: async () => '/home/u/work/codex/inner', exists: at(['/home/u', '/home/u/work/codex/inner'], ['/home/u/work/codex']), home })).toBe('/home/u/work/codex/inner');
    expect(await findCaptureRoot({ cwd: async () => '/home/u', exists: at(['/home/u'], ['/home/u']), home })).toBe('/home/u');
  });

  it('anchors the capture path at the root', () => {
    expect(capturePath('s1', '/home/u')).toBe('/home/u/.exovault/s4-capture/s1');
    expect(capturePath('s1', '/')).toBe('/.exovault/s4-capture/s1');
    expect(capturePath('s1', 'C:\\')).toBe('C:\\.exovault/s4-capture/s1');
    expect(capturePath('s1')).toBe('.exovault/s4-capture/s1');
  });

  it('keeps one session in one capture store when the session changes directory', async () => {
    const { register } = await import('../compact.js');
    const on: Record<string, Handler> = {};
    register(((name: string, fn: Handler) => { on[name] = fn; return { catch: (caught: unknown) => { (on as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, {} as never);
    const writes: string[] = [];
    let cwd = '/home/u';
    const $ = {
      session: {
        cwd: async () => cwd,
        id: async () => 's1',
        surfaces: async () => ['terminal'],
        messages: async () => [{ role: 'user', text: `turn in ${cwd}`, toolUses: [] }],
      },
      fs: {
        exists: flagAt(['/home/u']),
        read: async () => { throw new Error('ENOENT'); },
        write: async (path: string) => { writes.push(path); },
        list: async () => [],
      },
      ui: { log: () => undefined },
      env: { get: () => undefined },
      // Only the zero-ms yields resolve; the capture timeout never fires.
      clock: { sleep: (ms: number) => (ms === 0 ? Promise.resolve() : new Promise(() => undefined)), now: () => 0 },
      // 4.9.2 review: the capture guard runs harden.mjs from the plugin root before any capture write; exit 0 passes.
      plugin: { name: 'exo-compact', root: '/fake-plugin' },
      process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    };
    for (const dir of ['/home/u', '/home/u/work/voice-bench', '/home/u/work/repo']) {
      cwd = dir;
      await on['turn.complete']($, { reason: 'answer' }, async () => undefined);
    }
    expect(writes.length).toBeGreaterThan(0);
    // 4.8.1: the one write outside the session's store is the .gitignore that keeps the store out of git.
    expect(writes.every((path) => path.startsWith('/home/u/.exovault/s4-capture/s1/') || path === '/home/u/.exovault/.gitignore')).toBe(true);
  });
});
