// CONTRACT S5x: exo-compact sets Claude Code's auto-compact window and turns auto-compact on, once per configured
// value. auto-compact.mjs runs here against a temporary CLAUDE_CONFIG_DIR only, never the real user files.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { AUTO_COMPACT_TIMEOUT_MS } from '../host/auto-compact.js';
import { SCRUBBED_ENV } from '../host/node-run.js';

type Handler = (host: unknown, event: unknown, next: () => Promise<unknown>) => Promise<unknown>;

const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(pluginRoot, 'auto-compact.mjs');
const HINT = 'Change it with /plugin configure exo-compact.';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

/** A config dir that does not exist yet, inside a fresh temp dir that also serves as HOME. */
function box() {
  const base = mkdtempSync(path.join(tmpdir(), 'exo-acw-'));
  dirs.push(base);
  const dir = path.join(base, 'config');
  return { base, dir, settings: path.join(dir, 'settings.json'), legacy: path.join(dir, '.claude.json'), marker: path.join(dir, 'exovault', 'auto-compact.json') };
}

const baseEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || /^(CLAUDE_CONFIG_DIR|CLAUDE_CODE_AUTO_COMPACT_WINDOW|DISABLE_AUTO_COMPACT|DISABLE_COMPACT)$/.test(name)) continue;
    env[name] = value;
  }
  return env;
};

function apply(b: ReturnType<typeof box>, args: string[], env: Record<string, string> = {}) {
  const ran = spawnSync(process.execPath, [SCRIPT, 'apply', ...args], { encoding: 'utf8', env: { ...baseEnv(), HOME: b.base, USERPROFILE: b.base, CLAUDE_CONFIG_DIR: b.dir, ...env } });
  return { code: ran.status, stdout: ran.stdout, stderr: ran.stderr, lines: ran.stdout.split('\n').filter(Boolean) };
}

const write = (file: string, text: string) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const read = (file: string) => readFileSync(file, 'utf8');
const marker = (b: ReturnType<typeof box>) => JSON.parse(read(b.marker)) as Record<string, unknown>;

describe('S5x auto-compact.mjs: the window', () => {
  it('a fresh config dir gets the window, the directory and the marker, with one line', () => {
    const b = box();
    const r = apply(b, ['200000', 'true']);
    expect(r.code).toBe(0);
    expect(read(b.settings)).toBe('{\n  "autoCompactWindow": 200000\n}\n');
    expect(r.stdout).toBe(`exo-compact: set Claude Code's auto-compact window to 200k tokens (it was the model's window). ${HINT}\n`);
    expect(marker(b)).toEqual({ window: 200000, enabled: true });
  });

  it('a larger window is lowered; every other key keeps its value, its place and its bytes', () => {
    const b = box();
    const before = json({ model: 'opus', autoCompactWindow: 1000000, env: { A: '1' }, permissions: { allow: ['Bash(ls)'] }, statusLine: { type: 'command', command: 'x' } });
    write(b.settings, before);
    const r = apply(b, ['200000', 'true']);
    expect(r.code).toBe(0);
    expect(read(b.settings)).toBe(before.replace('1000000', '200000'));
    expect(r.lines).toEqual([`exo-compact: set Claude Code's auto-compact window to 200k tokens (it was 1M tokens). ${HINT}`]);
  });

  it('a smaller window the user chose is left alone before any marker, and replaced once the marker exists', () => {
    const b = box();
    const before = json({ autoCompactWindow: 150000, theme: 'dark' });
    write(b.settings, before);
    const left = apply(b, ['200000', 'true']);
    expect(left.code).toBe(0);
    expect(left.stdout).toBe('');
    expect(read(b.settings)).toBe(before);
    expect(marker(b)).toEqual({ window: 200000, enabled: true });
    const changed = apply(b, ['180000', 'true']);
    expect(read(b.settings)).toBe(json({ autoCompactWindow: 180000, theme: 'dark' }));
    expect(changed.lines).toEqual([`exo-compact: set Claude Code's auto-compact window to 180k tokens (it was 150k tokens). ${HINT}`]);
  });

  it('the same window as the settings writes nothing but records the marker', () => {
    const b = box();
    write(b.settings, json({ autoCompactWindow: 200000 }));
    const r = apply(b, ['200000', 'true']);
    expect(r.stdout).toBe('');
    expect(marker(b)).toEqual({ window: 200000, enabled: true });
  });

  it('a marker equal to the request does nothing and prints nothing, so a later change by hand stays', () => {
    const b = box();
    apply(b, ['200000', 'true']);
    const byHand = json({ autoCompactWindow: 500000, autoCompactEnabled: false });
    write(b.settings, byHand);
    const r = apply(b, ['200000', 'true'], { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000', DISABLE_AUTO_COMPACT: '1' });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(read(b.settings)).toBe(byHand);
  });

  it('a marker that differs only in the window applies the window and leaves auto-compact as the user set it', () => {
    const b = box();
    apply(b, ['200000', 'true']);
    write(b.settings, json({ autoCompactWindow: 200000, autoCompactEnabled: false }));
    const r = apply(b, ['300000', 'true']);
    expect(read(b.settings)).toBe(json({ autoCompactWindow: 300000, autoCompactEnabled: false }));
    expect(r.lines).toEqual([`exo-compact: set Claude Code's auto-compact window to 300k tokens (it was 200k tokens). ${HINT}`]);
    expect(marker(b)).toEqual({ window: 300000, enabled: true });
  });

  it('window 0 leaves the setting alone and creates no settings file', () => {
    const b = box();
    const r = apply(b, ['0', 'true']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(existsSync(b.settings)).toBe(false);
    expect(marker(b)).toEqual({ window: 0, enabled: true });
    const kept = box();
    const before = json({ autoCompactWindow: 1000000 });
    write(kept.settings, before);
    apply(kept, ['0', 'true'], { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' });
    expect(read(kept.settings)).toBe(before);
  });

  it.each(['50000', '1500000', '150000.5', '-200000'])('window %s is outside 100000..1000000: one warning, nothing written, not recorded', (value) => {
    const b = box();
    const r = apply(b, [value, 'true']);
    expect(r.code).toBe(0);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^exo-compact: .*auto-compact window .*100000-1000000/);
    expect(r.lines[0]).toContain(value);
    expect(existsSync(b.settings)).toBe(false);
    expect(existsSync(b.marker) ? marker(b).window : undefined).toBeUndefined();
  });
});

describe('S5x auto-compact.mjs: auto-compact on', () => {
  it('false in the settings is turned on, with the change in the same line as the window', () => {
    const b = box();
    write(b.settings, json({ autoCompactEnabled: false, model: 'opus' }));
    const r = apply(b, ['200000', 'true']);
    expect(read(b.settings)).toBe(json({ autoCompactEnabled: true, model: 'opus', autoCompactWindow: 200000 }));
    expect(r.stdout).toBe(`exo-compact: set Claude Code's auto-compact window to 200k tokens (it was the model's window); turned auto-compact on. ${HINT}\n`);
  });

  it('false only in the legacy global config is turned on in the settings; the legacy file is never written or shown', () => {
    const b = box();
    const legacy = json({ oauthAccount: { emailAddress: 'canary-never-print@example.com' }, autoCompactEnabled: false, primaryApiKey: 'sk-canary-never-print' });
    write(b.legacy, legacy);
    const r = apply(b, ['0', 'true']);
    expect(read(b.settings)).toBe(json({ autoCompactEnabled: true }));
    expect(r.lines).toEqual([`exo-compact: turned auto-compact on. ${HINT}`]);
    expect(read(b.legacy)).toBe(legacy);
    const again = box();
    write(again.legacy, legacy);
    const jsonRun = apply(again, ['200000', 'true', '--json']);
    expect(jsonRun.code).toBe(0);
    expect(JSON.parse(jsonRun.stdout).set).toEqual({ autoCompactWindow: 200000, autoCompactEnabled: true });
    for (const out of [r.stdout, r.stderr, jsonRun.stdout, jsonRun.stderr]) expect(out).not.toMatch(/canary/);
  });

  it('true in the settings wins over false in the legacy config', () => {
    const b = box();
    write(b.settings, json({ autoCompactEnabled: true }));
    write(b.legacy, json({ autoCompactEnabled: false }));
    const r = apply(b, ['0', 'true']);
    expect(r.stdout).toBe('');
    expect(read(b.settings)).toBe(json({ autoCompactEnabled: true }));
  });

  it('undefined everywhere means on: nothing is written', () => {
    const b = box();
    const r = apply(b, ['0', 'true']);
    expect(r.stdout).toBe('');
    expect(existsSync(b.settings)).toBe(false);
  });

  it('false asked leaves the setting alone', () => {
    const b = box();
    const before = json({ autoCompactEnabled: false });
    write(b.settings, before);
    const r = apply(b, ['0', 'false']);
    expect(r.stdout).toBe('');
    expect(read(b.settings)).toBe(before);
    expect(marker(b)).toEqual({ window: 0, enabled: false });
  });

  it('without CLAUDE_CONFIG_DIR the files are ~/.claude/settings.json and ~/.claude.json', () => {
    const b = box();
    write(path.join(b.base, '.claude.json'), json({ autoCompactEnabled: false }));
    const ran = spawnSync(process.execPath, [SCRIPT, 'apply', '200000', 'true'], { encoding: 'utf8', env: { ...baseEnv(), HOME: b.base, USERPROFILE: b.base } });
    expect(ran.status).toBe(0);
    expect(JSON.parse(read(path.join(b.base, '.claude', 'settings.json')))).toEqual({ autoCompactWindow: 200000, autoCompactEnabled: true });
    expect(existsSync(path.join(b.base, '.claude', 'exovault', 'auto-compact.json'))).toBe(true);
  });
});

describe('S5x auto-compact.mjs: files, environment and arguments', () => {
  it('a settings file that is not valid JSON is not touched, the warning names it, exit 1, no marker', () => {
    for (const text of ['{ "model": "opus", ', '[1, 2]', 'null']) {
      const b = box();
      write(b.settings, text);
      const r = apply(b, ['200000', 'true']);
      expect(r.code).toBe(1);
      expect(r.lines).toHaveLength(1);
      expect(r.lines[0]).toMatch(/^exo-compact: .*auto-compact/);
      expect(r.lines[0]).toContain(b.settings);
      expect(read(b.settings)).toBe(text);
      expect(existsSync(b.marker)).toBe(false);
    }
  });

  it('CLAUDE_CODE_AUTO_COMPACT_WINDOW set: a line says the variable wins, with its value', () => {
    const b = box();
    const r = apply(b, ['200000', 'true'], { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' });
    expect(r.lines).toHaveLength(2);
    expect(r.lines[1]).toMatch(/^exo-compact: CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000 is set/);
    expect(r.lines[1]).toContain('auto-compact');
    expect(read(b.settings)).toBe(json({ autoCompactWindow: 200000 }));
  });

  it.each(['DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT'])('%s set: a line says auto-compact stays off because of it', (name) => {
    const b = box();
    const r = apply(b, ['0', 'true'], { [name]: '1' });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(new RegExp(`^exo-compact: ${name} is set, so auto-compact stays off`));
  });

  it('keep skips a field and leaves its marker field alone', () => {
    const b = box();
    write(b.settings, json({ autoCompactEnabled: false }));
    const r = apply(b, ['keep', 'true']);
    expect(read(b.settings)).toBe(json({ autoCompactEnabled: true }));
    expect(r.lines).toEqual([`exo-compact: turned auto-compact on. ${HINT}`]);
    expect(marker(b)).toEqual({ enabled: true });
    expect(apply(b, ['keep', 'keep']).stdout).toBe('');
  });

  it.each([[[]], [['abc', 'true']], [['200000', 'maybe']], [['200000']], [['', 'true']]])('bad arguments %j exit 2 and write nothing', (args) => {
    const b = box();
    const r = apply(b, args as string[]);
    expect(r.code).toBe(2);
    expect(existsSync(b.dir)).toBe(false);
  });

  it('--json prints the plan and the lines', () => {
    const b = box();
    const r = apply(b, ['200000', 'true', '--json']);
    const out = JSON.parse(r.stdout) as { set: Record<string, unknown>; lines: string[] };
    expect(out.set).toEqual({ autoCompactWindow: 200000 });
    expect(out.lines).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('a settings.json that is a link stays a link; its target gets the change', () => {
    const b = box();
    const target = path.join(b.base, 'dotfiles', 'settings.json');
    write(target, json({ model: 'opus' }));
    mkdirSync(b.dir, { recursive: true });
    symlinkSync(target, b.settings);
    expect(apply(b, ['200000', 'true']).code).toBe(0);
    expect(lstatSync(b.settings).isSymbolicLink()).toBe(true);
    expect(read(target)).toBe(json({ model: 'opus', autoCompactWindow: 200000 }));
  });
});

describe('S5x session.start runs auto-compact.mjs once per process, attended and not inert only', () => {
  type Run = { argv: string[]; init: { timeoutMs?: number; env?: Record<string, string> } };
  const start = async (options: Record<string, unknown>, opts: { surfaces?: string[]; entrypoint?: string; doctorExit?: number; env?: Record<string, string>; reply?: (argv: string[], init: Run['init']) => Promise<{ exitCode: number; stdout: string; stderr: string }>; exists?: (file: string) => boolean } = {}) => {
    const { register } = await import('../compact.js');
    const on: Record<string, Handler> = {};
    register(((name: string, fn: Handler) => { on[name] = fn; return { catch: () => undefined }; }) as never, { recallEnabled: false, ...options } as never);
    const logs: string[] = [];
    const runs: Run[] = [];
    let id = 0;
    const env: Record<string, string> = { HOME: '/home/u', ...(opts.entrypoint ? { CLAUDE_CODE_ENTRYPOINT: opts.entrypoint } : {}), ...opts.env };
    const $ = () => ({
      session: { cwd: async () => '/home/u/work/repo', id: async () => `s${id}`, surfaces: async () => opts.surfaces ?? ['terminal'], version: async () => ({ version: '2.1.292', base: '2.1.292' }), root: async () => undefined },
      fs: { exists: async (file: string) => opts.exists?.(file) ?? false, read: async () => { throw new Error('ENOENT'); }, write: async () => undefined, list: async () => [] },
      ui: { log: (line: string, extra?: unknown) => { if (!extra) logs.push(line); } },
      plugin: { name: 'exo-compact', root: '/plugin' },
      env: { get: (name: string) => env[name] },
      process: {
        run: async (argv: string[], init: Run['init']) => {
          runs.push({ argv, init });
          if (String(argv[1]).endsWith('/doctor.mjs')) return { exitCode: opts.doctorExit ?? 0, stdout: opts.doctorExit ? 'exo-compact: Node 20.1.0 is too old; exo-compact stays off.\n' : '', stderr: '' };
          if (String(argv[1]).endsWith('/auto-compact.mjs') && opts.reply) return opts.reply(argv, init);
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
      clock: { sleep: (ms: number) => (ms === 0 ? Promise.resolve() : new Promise(() => undefined)), now: () => 0 },
    });
    const fire = async () => { id += 1; return on['session.start']!($(), { cwd: '/home/u/work/repo' }, async () => ({ cwd: '/home/u/work/repo', passed: true })); };
    const autoRuns = () => runs.filter((run) => String(run.argv[1]).endsWith('/auto-compact.mjs'));
    return { fire, logs, runs, autoRuns };
  };
  const SET_LINE = `exo-compact: set Claude Code's auto-compact window to 200k tokens (it was the model's window). ${HINT}`;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('an attended session runs it with the two options, from the trusted root, scrubbed, within the timeout; its lines show in quiet mode', async () => {
    const s = await start({}, { reply: async () => ({ exitCode: 0, stdout: `${SET_LINE}\n`, stderr: '' }) });
    await s.fire();
    await s.fire();
    await settle();
    expect(s.autoRuns()).toHaveLength(1);
    const run = s.autoRuns()[0]!;
    expect(run.argv).toEqual(['node', '/plugin/auto-compact.mjs', 'apply', '200000', 'true', '--home', '/home/u']);
    expect(run.init.timeoutMs).toBe(AUTO_COMPACT_TIMEOUT_MS);
    expect(AUTO_COMPACT_TIMEOUT_MS).toBeLessThanOrEqual(3000);
    expect(run.init.env).toMatchObject(SCRUBBED_ENV);
    expect(s.logs).toEqual([SET_LINE]);
  });

  it('passes the configured values and the nodePath binary', async () => {
    const s = await start({ autoCompactWindow: 0, autoCompact: false, nodePath: '/opt/node/bin/node' }, { exists: (file) => file === '/opt/node/bin/node' });
    await s.fire();
    expect(s.autoRuns().map((run) => run.argv)).toEqual([['/opt/node/bin/node', '/plugin/auto-compact.mjs', 'apply', '0', 'false', '--home', '/home/u']]);
  });

  it('an unattended session (-p, the SDK, a child run) never runs it', async () => {
    for (const opts of [{ surfaces: [] }, { surfaces: [], entrypoint: 'sdk-ts' }, { surfaces: [], entrypoint: 'cli' }]) {
      const s = await start({}, opts);
      await s.fire();
      expect(s.autoRuns()).toEqual([]);
    }
  });

  it('an inert plugin (the preflight failed) never runs it', async () => {
    const s = await start({}, { doctorExit: 1 });
    await s.fire();
    expect(s.runs.some((run) => String(run.argv[1]).endsWith('/doctor.mjs'))).toBe(true);
    expect(s.autoRuns()).toEqual([]);
  });

  it('a failure or a timeout is one warning line and the session still starts', async () => {
    const thrown = await start({}, { reply: async () => { throw new Error('timed out after 3000 ms'); } });
    await expect(thrown.fire()).resolves.toMatchObject({ passed: true });
    await settle();
    expect(thrown.logs).toHaveLength(1);
    expect(thrown.logs[0]).toMatch(/^exo-compact: .*auto-compact.*timed out after 3000 ms/);

    const failed = await start({}, { reply: async () => ({ exitCode: 1, stdout: '', stderr: 'boom' }) });
    await expect(failed.fire()).resolves.toMatchObject({ passed: true });
    await settle();
    expect(failed.logs).toHaveLength(1);
    expect(failed.logs[0]).toMatch(/^exo-compact: .*auto-compact/);

    const invalid = await start({}, { reply: async () => ({ exitCode: 1, stdout: 'exo-compact: /u/.claude/settings.json is not valid JSON, so the auto-compact settings were left alone.\n', stderr: '' }) });
    await invalid.fire();
    await settle();
    expect(invalid.logs).toEqual(['exo-compact: /u/.claude/settings.json is not valid JSON, so the auto-compact settings were left alone.']);
  });

  it('the hook passes the config dir it resolved itself, so a CLAUDE_CONFIG_DIR or HOME in the child env cannot move the write', async () => {
    const b = box();
    const hostile = box();
    const s = await start({}, {
      env: { HOME: b.base, CLAUDE_CONFIG_DIR: b.dir },
      reply: async (argv, init) => {
        const ran = spawnSync(process.execPath, [SCRIPT, ...argv.slice(2)], { encoding: 'utf8', env: { ...baseEnv(), ...init.env, HOME: hostile.base, USERPROFILE: hostile.base, CLAUDE_CONFIG_DIR: hostile.dir } });
        return { exitCode: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr };
      },
    });
    await s.fire();
    await settle();
    expect(s.autoRuns()[0]!.argv.slice(5)).toEqual(['--home', b.base, '--config-dir', b.dir]);
    expect(JSON.parse(read(b.settings))).toEqual({ autoCompactWindow: 200000 });
    expect(marker(b)).toEqual({ window: 200000, enabled: true });
    expect(existsSync(hostile.dir)).toBe(false);
    expect(existsSync(path.join(hostile.base, '.claude'))).toBe(false);
  });

  it('without a home directory or a config dir the hook does not run the script and says so', async () => {
    const s = await start({}, { env: { HOME: '' } });
    await s.fire();
    await settle();
    expect(s.autoRuns()).toEqual([]);
    expect(s.logs).toEqual(['exo-compact: auto-compact settings not checked (no home directory).']);
  });
});

describe('S5x review round 1: paths from arguments, a concurrent writer, a byte order mark', () => {
  type ApplyResult = { code: number; lines: string[] };
  type ApplyFn = (input: { window: number | 'keep'; enabled: boolean | 'keep'; env: Record<string, string | undefined>; paths: { settings: string; legacy: string; marker: string }; beforeWrite?: (attempt: number) => void }) => ApplyResult;
  const load = async () => (await import(pathToFileURL(SCRIPT).href)) as { applyAutoCompact: ApplyFn };
  const paths = (b: ReturnType<typeof box>) => ({ settings: b.settings, legacy: b.legacy, marker: b.marker });

  it('--home and --config-dir replace the process environment for every path', () => {
    const b = box();
    const hostile = box();
    const env = { ...baseEnv(), HOME: hostile.base, USERPROFILE: hostile.base, CLAUDE_CONFIG_DIR: hostile.dir };
    const home = spawnSync(process.execPath, [SCRIPT, 'apply', '200000', 'true', '--home', b.base], { encoding: 'utf8', env });
    expect(home.status).toBe(0);
    expect(JSON.parse(read(path.join(b.base, '.claude', 'settings.json')))).toEqual({ autoCompactWindow: 200000 });

    const c = box();
    write(c.legacy, json({ autoCompactEnabled: false }));
    const dir = spawnSync(process.execPath, [SCRIPT, 'apply', '0', 'true', '--config-dir', c.dir], { encoding: 'utf8', env });
    expect(dir.status).toBe(0);
    expect(read(c.settings)).toBe(json({ autoCompactEnabled: true }));
    expect(existsSync(hostile.dir)).toBe(false);
    expect(existsSync(path.join(hostile.base, '.claude'))).toBe(false);
  });

  it.each([[['--home', 'relative/home']], [['--config-dir', 'cfg']], [['--home']]])('%j is a bad argument: exit 2, nothing created', (flags) => {
    const b = box();
    const ran = spawnSync(process.execPath, [SCRIPT, 'apply', '200000', 'true', ...flags], { encoding: 'utf8', env: { ...baseEnv(), HOME: b.base, USERPROFILE: b.base, CLAUDE_CONFIG_DIR: b.dir }, cwd: b.base });
    expect(ran.status).toBe(2);
    expect(readdirSync(b.base)).toEqual([]);
  });

  it('with CLAUDE_CONFIG_DIR set the legacy config is the .claude.json inside it, not the one in the home directory', () => {
    const b = box();
    write(path.join(b.base, '.claude.json'), json({ autoCompactEnabled: false }));
    const r = apply(b, ['0', 'true']);
    expect(r.stdout).toBe('');
    expect(existsSync(b.settings)).toBe(false);
    write(b.legacy, json({ autoCompactEnabled: false }));
    rmSync(b.marker);
    const inside = apply(b, ['0', 'true']);
    expect(inside.lines).toEqual([`exo-compact: turned auto-compact on. ${HINT}`]);
  });

  it('a settings file changed between the read and the write is planned again from the new content', async () => {
    const { applyAutoCompact } = await load();
    const b = box();
    write(b.settings, json({ model: 'opus' }));
    const attempts: number[] = [];
    const r = applyAutoCompact({ window: 200000, enabled: true, env: {}, paths: paths(b), beforeWrite: (attempt) => {
      attempts.push(attempt);
      if (attempt === 0) write(b.settings, json({ model: 'opus', theme: 'dark', autoCompactEnabled: false }));
    } });
    expect(attempts).toEqual([0, 1]);
    expect(r.code).toBe(0);
    expect(read(b.settings)).toBe(json({ model: 'opus', theme: 'dark', autoCompactEnabled: true, autoCompactWindow: 200000 }));
    expect(r.lines).toEqual([`exo-compact: set Claude Code's auto-compact window to 200k tokens (it was the model's window); turned auto-compact on. ${HINT}`]);
    expect(marker(b)).toEqual({ window: 200000, enabled: true });
  });

  it('a settings file that keeps changing is left alone: no write, no marker, one warning line', async () => {
    const { applyAutoCompact } = await load();
    const b = box();
    write(b.settings, json({ model: 'opus' }));
    let n = 0;
    const r = applyAutoCompact({ window: 200000, enabled: true, env: {}, paths: paths(b), beforeWrite: () => { n += 1; write(b.settings, json({ model: 'opus', other: n })); } });
    expect(r.code).toBe(1);
    expect(read(b.settings)).toBe(json({ model: 'opus', other: 2 }));
    expect(existsSync(b.marker)).toBe(false);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^exo-compact: .*settings\.json.*changed while.*auto-compact/);
  });

  it('a settings file that starts with a byte order mark is read, and keeps the mark when it is written', () => {
    const b = box();
    write(b.settings, `\uFEFF${json({ model: 'opus' })}`);
    const r = apply(b, ['200000', 'true']);
    expect(r.code).toBe(0);
    expect(read(b.settings)).toBe(`\uFEFF${json({ model: 'opus', autoCompactWindow: 200000 })}`);
    const plain = box();
    write(plain.settings, json({ model: 'opus' }));
    apply(plain, ['200000', 'true']);
    expect(readFileSync(plain.settings)[0]).toBe(0x7b);
  });

  it('a legacy config with a byte order mark is still read', () => {
    const b = box();
    write(b.legacy, `\uFEFF${json({ autoCompactEnabled: false })}`);
    const r = apply(b, ['0', 'true']);
    expect(r.lines).toEqual([`exo-compact: turned auto-compact on. ${HINT}`]);
  });
});
