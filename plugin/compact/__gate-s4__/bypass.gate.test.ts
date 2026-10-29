// CONTRACT S5y: a plugin seated before the user tier ("cc-plugin-sec-default") sends exo-compact's hook events on past
// it. Doctor names it and the fixes, auto-compact leaves the window alone, and `doctor.mjs digest` prints the
// pluginDigests entry managed settings need. Every file here is under a temporary directory.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { derivedTranscriptPath } from '../host/transcript-path.js';
// @ts-expect-error plain ESM module without types
import { findBypass, pluginDigest } from '../bypass.mjs';
// @ts-expect-error plain ESM module without types
import * as doctor from '../doctor.mjs';
import { claudeProjectDir } from '../recall/paths.mjs';

type Found = { by: string; events: string[]; file: string };
type Check = { id: string; status: string; message: string };

const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/sec-default-skip.jsonl', import.meta.url));
const DOCTOR = path.join(pluginRoot, 'doctor.mjs');
const AUTO = path.join(pluginRoot, 'auto-compact.mjs');

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), 'exo-sdb-')); dirs.push(dir); return dir; };
const write = (file: string, data: string | Buffer) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, data); };
const age = (file: string, secondsAgo: number) => { const at = new Date(Date.now() - secondsAgo * 1000); utimesSync(file, at, at); };

const baseEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || /^(CLAUDE_CONFIG_DIR|CLAUDE_CODE_AUTO_COMPACT_WINDOW|DISABLE_AUTO_COMPACT|DISABLE_COMPACT|TYPESAFE_API_KEY|EXO_JEV_URL)$/.test(name)) continue;
    env[name] = value;
  }
  return env;
};

/** A home with a config dir and a project whose transcript dir holds `transcripts` (name -> source file). */
function machine(transcripts: Record<string, string> = {}) {
  const base = temp();
  const config = path.join(base, 'config');
  const cwd = path.join(base, 'work', 'my repo');
  mkdirSync(cwd, { recursive: true });
  const project = claudeProjectDir(cwd, { CLAUDE_CONFIG_DIR: config }, base);
  for (const [name, source] of Object.entries(transcripts)) write(path.join(project, name), readFileSync(source));
  return { base, config, cwd, project };
}

describe('S5y the skip line in the project transcripts', () => {
  it('the real line, in the plain and the escaped-quote form, names the plugin and the events; quotes, tool output and other plugins do not count', () => {
    const m = machine({ 's1.jsonl': FIXTURE });
    const found: Found[] = findBypass(m.project);
    expect(found).toEqual([{ by: 'cc-plugin-sec-default', events: ['session.compact', 'classic.Stop', 'classic.PreToolUse'], file: path.join(m.project, 's1.jsonl') }]);
  });

  it('only the newest three transcripts are read', () => {
    const m = machine({ 'old.jsonl': FIXTURE });
    age(path.join(m.project, 'old.jsonl'), 3600);
    for (const name of ['a', 'b', 'c']) write(path.join(m.project, `${name}.jsonl`), `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`);
    expect(findBypass(m.project)).toEqual([]);
    age(path.join(m.project, 'a.jsonl'), 7200);
    expect(findBypass(m.project).map((entry: Found) => entry.by)).toEqual(['cc-plugin-sec-default']);
  });

  it('no transcript dir, a file in its place, or an empty dir: nothing found, nothing thrown', () => {
    const base = temp();
    expect(findBypass(path.join(base, 'missing'))).toEqual([]);
    write(path.join(base, 'file'), 'x');
    expect(findBypass(path.join(base, 'file'))).toEqual([]);
    mkdirSync(path.join(base, 'empty'));
    expect(findBypass(path.join(base, 'empty'))).toEqual([]);
  });

  it.each([
    ['/home/u/work/repo', { HOME: '/home/u' }],
    ['C:\\Users\\u\\work\\my repo.v2', { HOME: 'C:\\Users\\u' }],
    ['/home/u/work/repo', { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/cfg' }],
  ])('the node side derives the same project dir as host/transcript-path.ts for %s', async (cwd, env) => {
    const hook = await derivedTranscriptPath({ cwd: async () => cwd, home: async () => env.HOME, configDir: async () => env.CLAUDE_CONFIG_DIR }, 'sid');
    const slashes = (file: string) => file.replace(/\\/g, '/');
    expect(slashes(path.join(claudeProjectDir(cwd, env, env.HOME), 'sid.jsonl'))).toBe(slashes(hook!));
  });
});

function doctorDeps(overrides: Record<string, unknown> = {}) {
  return {
    env: {}, nodeVersion: '22.23.2', claudeVersion: async () => '2.1.312 (Claude Code)', fileExists: () => true,
    fetch: async () => { throw new Error('no network in this test'); }, jev: false, pluginRoot: '/plugin',
    cwd: '/work/proj', home: '/users/me', readFile: () => { throw new Error('ENOENT'); }, ...overrides,
  };
}
const run = async (overrides: Record<string, unknown> = {}) => (await doctor.runDoctor(doctorDeps(overrides))) as { checks: Check[] };

describe('S5y doctor reports the bypass', () => {
  const found: Found[] = [{ by: 'cc-plugin-sec-default', events: ['session.compact', 'classic.Stop'], file: '/users/me/.claude/projects/-work-proj/s1.jsonl' }];

  it('names the plugin, the events and the transcript, and prints both fixes', async () => {
    const result = await run({ bypass: () => found });
    const check = result.checks.find((entry) => entry.id === 'bypass')!;
    expect(check.status).toBe('warn');
    expect(check.message).toContain('"cc-plugin-sec-default"');
    expect(check.message).toContain('session.compact, classic.Stop');
    expect(check.message).toContain('/users/me/.claude/projects/-work-proj/s1.jsonl');
    expect(check.message).toContain('"appendPlugins": ["exo-compact@exo-compact"]');
    expect(check.message).toContain(path.join('/users/me', '.claude', 'settings.json'));
    expect(check.message).toContain('exo-compact@exo-compact in user settings ignored');
    expect(check.message).toContain('README, "Hooks skipped by another plugin"');
    expect(check.message).toContain(`node "${path.join('/plugin', 'doctor.mjs')}" digest`);
    expect(doctor.exitCode(result)).toBe(0);
  });

  it('nothing found or a scan that throws: the report is the same as without the scan', async () => {
    const without = await run();
    expect((await run({ bypass: () => [] })).checks).toEqual(without.checks);
    expect((await run({ bypass: () => { throw new Error('EACCES'); } })).checks).toEqual(without.checks);
  });

  it('the CLI scans the transcript dir of the folder it runs in', () => {
    const m = machine({ 's1.jsonl': FIXTURE });
    const ran = spawnSync(process.execPath, [DOCTOR], { cwd: m.cwd, encoding: 'utf8', env: { ...baseEnv(), HOME: m.base, USERPROFILE: m.base, CLAUDE_CONFIG_DIR: m.config }, timeout: 60_000 });
    const line = ran.stdout.split('\n').find((text) => text.includes('cc-plugin-sec-default'));
    expect(line).toMatch(/^exo-compact doctor WARN /);
    expect(ran.stdout).toContain('session.compact, classic.Stop, classic.PreToolUse');
  }, 60_000);
});

/**
 * Claude Code 2.1.312's digest, as its binary has it: every regular file, sorted by UTF-16 code units of its path,
 * hashed as "f PATH" NUL decimal-byte-length NUL BYTES, with five names left out at the root only.
 */
function expectedDigest(files: [string, Buffer][]) {
  const hash = createHash('sha256');
  for (const [name, bytes] of files) {
    hash.update(Buffer.from(`f ${name}\u0000${bytes.length}\u0000`, 'utf8'));
    hash.update(bytes);
  }
  return `sha256-${hash.digest('base64')}`;
}

function pluginFolder() {
  const dir = temp();
  const files: Record<string, string | Buffer> = {
    '.claude-plugin/plugin.json': '{"name":"p","version":"1.0.0"}\n',
    'hooks/hooks.json': '{"modules":["../mod.ts"]}\n',
    'mod.ts': 'export {};\n',
    'B.txt': 'upper',
    'a.txt': 'é',
    'z/\uFF5E.txt': 'fullwidth tilde',
    'z/\u{1F600}.txt': 'astral',
    'sub/.git/kept': 'only the root .git is left out',
    'bin.dat': Buffer.from([0, 13, 10, 255]),
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.in_use/1234': '',
    '.orphaned_at': '1',
    '.claude-plugin-link': 'x',
    '.links_materialized': 'x',
  };
  for (const [name, data] of Object.entries(files)) write(path.join(dir, name), data);
  return dir;
}

const LAYOUT: [string, Buffer][] = [
  ['.claude-plugin/plugin.json', Buffer.from('{"name":"p","version":"1.0.0"}\n')],
  ['B.txt', Buffer.from('upper')],
  ['a.txt', Buffer.from('é', 'utf8')],
  ['bin.dat', Buffer.from([0, 13, 10, 255])],
  ['hooks/hooks.json', Buffer.from('{"modules":["../mod.ts"]}\n')],
  ['mod.ts', Buffer.from('export {};\n')],
  ['sub/.git/kept', Buffer.from('only the root .git is left out')],
  ['z/\u{1F600}.txt', Buffer.from('astral')],
  ['z/\uFF5E.txt', Buffer.from('fullwidth tilde')],
];

describe('S5y the pluginDigests digest', () => {
  it('matches the byte layout: UTF-16 path order, decimal byte length, root-only exclusions', () => {
    const result = pluginDigest(pluginFolder());
    expect(result).toEqual({ digest: expectedDigest(LAYOUT), files: LAYOUT.length, notes: [] });
    expect(result.digest).toBe('sha256-2+p/Wz102t4lOKxiR2tH59I+6EdybR/TzeXm9rq7ejQ=');
  });

  it('a symbolic link anywhere in the folder: no digest, the link named', () => {
    const dir = pluginFolder();
    const outside = temp();
    symlinkSync(outside, path.join(dir, 'z', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(pluginDigest(dir)).toEqual({ problem: 'z/linked is not a regular file or folder (a symbolic link?), so Claude Code would refuse this folder' });
  });

  it('a text file with CRLF line endings: no digest, the file named', () => {
    const dir = pluginFolder();
    write(path.join(dir, 'hooks', 'win.ts'), 'a\r\nb\r\n');
    expect(pluginDigest(dir)).toEqual({ problem: 'hooks/win.ts has CRLF line endings (a checkout that converted them), so its digest would not match a copy with the published bytes' });
  });

  it('files Claude Code writes into a folder it loads (.claude-plugin/types) are counted and named in a note', () => {
    const dir = pluginFolder();
    write(path.join(dir, '.claude-plugin', 'types', 'p', 'index.d.ts'), 'export {};\n');
    const result = pluginDigest(dir);
    expect(result.files).toBe(LAYOUT.length + 1);
    expect(result.notes).toEqual(['.claude-plugin/types/ is in the folder and in the digest: Claude Code writes it when it loads a plugin from a folder you own, so a fresh copy has another digest']);
  });

  it('a missing folder is a problem, not a throw', () => {
    expect(pluginDigest(path.join(temp(), 'missing')).problem).toMatch(/^cannot read /);
  });

  it('`doctor.mjs digest <folder>` prints the digest first, then where it goes', () => {
    const dir = pluginFolder();
    const ran = spawnSync(process.execPath, [DOCTOR, 'digest', dir], { encoding: 'utf8', env: baseEnv() });
    expect(ran.status).toBe(0);
    const [first, second] = ran.stdout.split('\n');
    expect(first).toBe(expectedDigest(LAYOUT));
    expect(second).toBe(`exo-compact digest: ${dir}, ${LAYOUT.length} files. Managed settings name it under extraKnownMarketplaces["exo-compact"].pluginDigests["exo-compact"] (README, "Hooks skipped by another plugin").`);
  });

  it('`doctor.mjs digest` without a folder hashes the copy Claude Code loads; a refused folder exits 1', () => {
    const base = temp();
    const config = path.join(base, 'config');
    const dir = pluginFolder();
    write(path.join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'exo-compact@exo-compact': [{ scope: 'user', installPath: dir, version: '4.10.1' }] } }));
    const env = { ...baseEnv(), HOME: base, USERPROFILE: base, CLAUDE_CONFIG_DIR: config };
    const ran = spawnSync(process.execPath, [DOCTOR, 'digest'], { cwd: base, encoding: 'utf8', env });
    expect(ran.stdout.split('\n')[0]).toBe(expectedDigest(LAYOUT));
    write(path.join(dir, 'mod.ts'), 'a\r\n');
    const refused = spawnSync(process.execPath, [DOCTOR, 'digest'], { cwd: base, encoding: 'utf8', env });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe(`exo-compact digest: no digest for ${dir}: mod.ts has CRLF line endings (a checkout that converted them), so its digest would not match a copy with the published bytes.\n`);
  });

  it('the shipped plugin folder is one Claude Code can digest: no links, no CRLF', () => {
    const result = pluginDigest(pluginRoot);
    expect(result.problem).toBeUndefined();
    expect(result.digest).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);
  });
});

describe('S5y auto-compact leaves the window alone while the hooks are skipped', () => {
  const apply = (m: ReturnType<typeof machine>, extra: string[] = ['--cwd', m.cwd]) =>
    spawnSync(process.execPath, [AUTO, 'apply', '200000', 'true', '--home', m.base, '--config-dir', m.config, ...extra], { encoding: 'utf8', env: baseEnv() });
  const settings = (m: ReturnType<typeof machine>) => path.join(m.config, 'settings.json');
  const markerFile = (m: ReturnType<typeof machine>) => path.join(m.config, 'exovault', 'auto-compact.json');

  it('no settings write, no marker, one line that says why (shown in quiet mode)', () => {
    const m = machine({ 's1.jsonl': FIXTURE });
    const ran = apply(m);
    expect(ran.status).toBe(0);
    expect(existsSync(settings(m))).toBe(false);
    expect(existsSync(markerFile(m))).toBe(false);
    expect(ran.stdout).toBe(`exo-compact: auto-compact settings left alone: "cc-plugin-sec-default" runs first and sends exo-compact's hook events on past it (session.compact, classic.Stop, classic.PreToolUse), so every compaction is native and a smaller window would only bring it sooner. Run node "${path.join(pluginRoot, 'doctor.mjs')}" for the fix; the settings are applied at the first session start after it.\n`);
    expect(ran.stdout).toMatch(/^exo-compact: .*\bauto-compact\b/);
  });

  it('once the skip line is gone from the newest transcripts, the next start applies the answer', () => {
    const m = machine({ 's1.jsonl': FIXTURE });
    apply(m);
    rmSync(path.join(m.project, 's1.jsonl'));
    const ran = apply(m);
    expect(JSON.parse(readFileSync(settings(m), 'utf8'))).toEqual({ autoCompactWindow: 200000 });
    expect(JSON.parse(readFileSync(markerFile(m), 'utf8'))).toEqual({ window: 200000, enabled: true });
    expect(ran.stdout).toMatch(/^exo-compact: set Claude Code's auto-compact window to 200k tokens/);
  });

  it('an answer already applied is not looked at again, so no scan and no line', () => {
    const m = machine();
    apply(m);
    write(path.join(m.project, 's1.jsonl'), readFileSync(FIXTURE));
    const ran = apply(m);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe('');
  });

  it('without --cwd (an installer, a run by hand) it does not scan', () => {
    const m = machine({ 's1.jsonl': FIXTURE });
    const ran = apply(m, []);
    expect(ran.status).toBe(0);
    expect(JSON.parse(readFileSync(settings(m), 'utf8'))).toEqual({ autoCompactWindow: 200000 });
  });

  it('a relative --cwd is a bad argument', () => {
    const m = machine();
    const ran = apply(m, ['--cwd', 'work/repo']);
    expect(ran.status).toBe(2);
    expect(existsSync(settings(m))).toBe(false);
  });
});
