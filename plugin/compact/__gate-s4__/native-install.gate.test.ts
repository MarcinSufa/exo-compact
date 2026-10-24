// A native `claude plugin install exo-compact@exo-compact` must be enough: installed means enabled, the project
// opt-out and `setup.cjs disable` still turn it off, the shipped defaults match what the installer used to set,
// and a Node or Claude Code below the minimum gives one warning and leaves the session on native compaction.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findCaptureRoot, isCaptureEnabled, type FlagHost } from '../host/capture-flag.js';
import { runPreflight } from '../host/preflight.js';
// @ts-expect-error plain ESM module without types
import * as doctor from '../doctor.mjs';

type Handler = (host: unknown, event: unknown, next: () => Promise<unknown>) => Promise<unknown>;

const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const setup = path.join(pluginRoot, 'setup.cjs');

const marks = (files: string[]) => async (file: string) => files.includes(file);
const host = (cwd: string, files: string[], home: string = '/home/u'): FlagHost => ({
  cwd: async () => cwd,
  exists: marks(files),
  home: async () => home,
});

describe('installed means enabled', () => {
  it('no flag anywhere up the tree: active, anchored in the home directory', async () => {
    const h = host('/srv/work/repo/sub', []);
    expect(await findCaptureRoot(h)).toBe('/home/u');
    expect(await isCaptureEnabled(h)).toBe(true);
  });

  it('a flag still wins and is the root, nearest first', async () => {
    expect(await findCaptureRoot(host('/home/u/work/repo', ['/home/u/.exovault/s4-compact-active']))).toBe('/home/u');
    expect(await findCaptureRoot(host('/home/u/work/repo', ['/home/u/.exovault/s4-compact-active', '/home/u/work/repo/.exovault/s4-compact-active']))).toBe('/home/u/work/repo');
  });

  it('the opt-out file turns it off for that directory and below, and only there', async () => {
    const off = ['/home/u/work/codex/.exovault/s4-compact-off'];
    expect(await findCaptureRoot(host('/home/u/work/codex/sub', off))).toBeNull();
    expect(await findCaptureRoot(host('/home/u/work/other', off))).toBe('/home/u');
  });

  it('an opt-out in the home directory also covers a project outside it', async () => {
    expect(await findCaptureRoot(host('/srv/work/repo', ['/home/u/.exovault/s4-compact-off']))).toBeNull();
    expect(await isCaptureEnabled(host('/home/u/work/x', ['/home/u/.exovault/s4-compact-off']))).toBe(false);
  });

  it('without a resolvable home directory and no flag it stays off instead of guessing a root', async () => {
    expect(await findCaptureRoot(host('/srv/work/repo', [], ''))).toBeNull();
  });
});

describe('setup.cjs enable and disable', () => {
  const real = (cwd: string, home: string): FlagHost => ({ cwd: async () => cwd, exists: async (file) => existsSync(file), home: async () => home });
  const run = (...args: string[]) => expect(spawnSync(process.execPath, [setup, ...args], { encoding: 'utf8' }).status).toBe(0);

  it('disable turns a directory off even with no flag to remove; enable turns it back on', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'exo-native-home-'));
    const project = path.join(home, 'work', 'repo');
    mkdirSync(project, { recursive: true });
    try {
      expect(await isCaptureEnabled(real(project, home))).toBe(true);
      run('disable', project);
      expect(await isCaptureEnabled(real(project, home))).toBe(false);
      expect(await isCaptureEnabled(real(path.join(home, 'work', 'other'), home))).toBe(true);
      run('enable', project);
      expect(await isCaptureEnabled(real(project, home))).toBe(true);
      run('enable', home);
      run('disable', home);
      expect(await isCaptureEnabled(real(path.join(home, 'x'), home))).toBe(false);
      expect(existsSync(path.join(home, '.exovault', 's4-compact-active'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('optout and optin keep working', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'exo-native-home-'));
    try {
      run('optout', home);
      expect(await isCaptureEnabled(real(home, home))).toBe(false);
      run('optin', home);
      expect(await isCaptureEnabled(real(home, home))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('each action says in one line what it did', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'exo-native-home-'));
    const say = (...args: string[]) => {
      const result = spawnSync(process.execPath, [setup, ...args], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      return result.stdout.trim();
    };
    try {
      expect(say('enable', home)).toBe(`exo-compact: on for ${home} and below (flag written)`);
      expect(say('optout', home)).toBe(`exo-compact: off for ${home} and below (opt-out file written, flag removed)`);
      expect(say('disable', home)).toBe(`exo-compact: off for ${home} and below (opt-out file written)`);
      expect(say('optin', home)).toBe(`exo-compact: opt-out file removed in ${home}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('optout after enable turns the directory off: a flag left in the same directory would win over it', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'exo-native-home-'));
    const project = path.join(home, 'repo');
    mkdirSync(project, { recursive: true });
    try {
      run('enable', project);
      run('optout', project);
      expect(await isCaptureEnabled(real(project, home))).toBe(false);
      expect(existsSync(path.join(project, '.exovault', 's4-compact-active'))).toBe(false);
      const report = spawnSync(process.execPath, [path.join(pluginRoot, 'doctor.mjs'), '--json'], { cwd: project, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
      const flagCheck = JSON.parse(report.stdout).checks.find((c: { id: string }) => c.id === 'capture-flag');
      expect(flagCheck.status).toBe('warn');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('shipped defaults', () => {
  const manifest = JSON.parse(readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')) as { userConfig: Record<string, { default: unknown }> };
  it('recall and interactiveOnly are on; the two brief nudges are off', () => {
    expect(manifest.userConfig.recallEnabled.default).toBe(true);
    expect(manifest.userConfig.interactiveOnly.default).toBe(true);
    expect(manifest.userConfig.briefPush.default).toBe(false);
    expect(manifest.userConfig.briefCheck.default).toBe(false);
  });
});

describe('doctor --versions', () => {
  it('names a Node below the minimum and a Claude Code below the minimum, nothing when both are fine', () => {
    expect(doctor.versionProblems({ nodeVersion: '22.15.0', claudeVersion: '2.1.280' })).toEqual([]);
    expect(doctor.versionProblems({ nodeVersion: '20.11.1', claudeVersion: '2.1.280' }).join(' ')).toContain('Node 20.11.1');
    expect(doctor.versionProblems({ nodeVersion: '22.15.0', claudeVersion: '2.1.200' }).join(' ')).toContain('Claude Code 2.1.200');
    expect(doctor.versionProblems({ nodeVersion: '22.15.0', claudeVersion: undefined })).toEqual([]);
  });

  it('the CLI prints one line and exits 1 for an old Claude Code, and is silent with exit 0 otherwise', () => {
    const old = spawnSync(process.execPath, [path.join(pluginRoot, 'doctor.mjs'), '--versions', '--claude', '2.1.1'], { encoding: 'utf8' });
    expect(old.status).toBe(1);
    expect(old.stdout.trim().split('\n')).toHaveLength(1);
    expect(old.stdout).toContain('Claude Code 2.1.1');
    const fine = spawnSync(process.execPath, [path.join(pluginRoot, 'doctor.mjs'), '--versions', '--claude', '2.1.292'], { encoding: 'utf8' });
    expect(fine.status).toBe(0);
    expect(fine.stdout).toBe('');
  });
});

describe('SessionStart preflight', () => {
  it('runs the doctor with the session Claude Code version and reports its single line', async () => {
    const calls: string[][] = [];
    const result = await runPreflight({
      claudeVersion: async () => '2.1.280-dev',
      pluginRoot: async () => '/plugin',
      run: async (argv) => { calls.push([...argv]); return { exitCode: 1, stdout: 'exo-compact: Node 20.1.0 is too old\n' }; },
    });
    expect(result).toEqual({ ok: false, warning: 'exo-compact: Node 20.1.0 is too old' });
    expect(calls).toEqual([['node', '/plugin/doctor.mjs', '--versions', '--claude', '2.1.280-dev']]);
  });

  it('fails open when the check cannot run or answers fine', async () => {
    const base = { claudeVersion: async () => '2.1.292', pluginRoot: async () => '/plugin' };
    expect((await runPreflight({ ...base, run: async () => ({ exitCode: 0, stdout: '' }) })).ok).toBe(true);
    expect((await runPreflight({ ...base, run: async () => { throw new Error('spawn node ENOENT'); } })).ok).toBe(true);
    expect((await runPreflight({ ...base, pluginRoot: async () => undefined, run: async () => ({ exitCode: 1, stdout: 'x' }) })).ok).toBe(true);
  });

  it('with an old Node the register hooks warn once per session and capture nothing', async () => {
    const { register } = await import('../compact.js');
    const on: Record<string, Handler> = {};
    register(((name: string, fn: Handler) => { on[name] = fn; return { catch: (caught: unknown) => { (on as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { recallEnabled: false } as never);
    const writes: string[] = [];
    const logs: string[] = [];
    const runs: string[][] = [];
    const $ = {
      session: {
        cwd: async () => '/home/u/work/repo',
        id: async () => 's1',
        surfaces: async () => ['terminal'],
        version: async () => ({ version: '2.1.292', base: '2.1.292' }),
        messages: async () => [{ role: 'user', text: 'hello there', toolUses: [] }],
      },
      fs: {
        exists: async () => false,
        read: async () => { throw new Error('ENOENT'); },
        write: async (file: string) => { writes.push(file); },
        list: async () => [],
      },
      ui: { log: (line: string) => { logs.push(line); } },
      env: { get: (name: string) => ({ HOME: '/home/u', CLAUDE_PLUGIN_ROOT: '/plugin' } as Record<string, string>)[name] },
      process: { run: async (argv: string[]) => { runs.push(argv); return { exitCode: 1, stdout: 'exo-compact: Node 20.1.0 is too old, need a newer one; exo-compact stays off.\n', stderr: '' }; } },
      clock: { sleep: (ms: number) => (ms === 0 ? Promise.resolve() : new Promise(() => undefined)), now: () => 0 },
    };
    await on['session.start']($, { cwd: '/home/u/work/repo', surface: 'terminal', isInteractive: true }, async () => ({ cwd: '/home/u/work/repo' }));
    await on['session.start']($, { cwd: '/home/u/work/repo', surface: 'terminal', isInteractive: true }, async () => ({ cwd: '/home/u/work/repo' }));
    await on['turn.complete']($, { reason: 'answer' }, async () => undefined);
    expect(logs.filter((line) => line.includes('too old'))).toHaveLength(1);
    expect(runs).toHaveLength(1);
    expect(writes).toEqual([]);
  });

  it('with a good Node the same hooks capture with no flag file at all', async () => {
    const { register } = await import('../compact.js');
    const on: Record<string, Handler> = {};
    register(((name: string, fn: Handler) => { on[name] = fn; return { catch: (caught: unknown) => { (on as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, {} as never);
    const writes: string[] = [];
    const logs: string[] = [];
    const $ = {
      session: {
        cwd: async () => '/home/u/work/repo',
        id: async () => 's1',
        surfaces: async () => ['terminal'],
        version: async () => ({ version: '2.1.292', base: '2.1.292' }),
        messages: async () => [{ role: 'user', text: 'hello there', toolUses: [] }],
      },
      fs: {
        exists: async () => false,
        read: async () => { throw new Error('ENOENT'); },
        write: async (file: string) => { writes.push(file); },
        list: async () => [],
      },
      ui: { log: (line: string) => { logs.push(line); } },
      env: { get: (name: string) => ({ HOME: '/home/u', CLAUDE_PLUGIN_ROOT: '/plugin' } as Record<string, string>)[name] },
      process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
      clock: { sleep: (ms: number) => (ms === 0 ? Promise.resolve() : new Promise(() => undefined)), now: () => 0 },
    };
    await on['session.start']($, { cwd: '/home/u/work/repo', surface: 'terminal', isInteractive: true }, async () => ({ cwd: '/home/u/work/repo' }));
    await on['turn.complete']($, { reason: 'answer' }, async () => undefined);
    expect(logs).toEqual([]);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((file) => file.startsWith('/home/u/.exovault/s4-capture/s1/') || file === '/home/u/.exovault/.gitignore')).toBe(true);
  });
});
