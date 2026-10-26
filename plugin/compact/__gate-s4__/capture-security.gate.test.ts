import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from '../compact.js';
import { DIR_MODE, FILE_MODE, hardenCapture as hardenFiles } from '../harden.mjs';
import { hardenArgv, hardenCapture } from '../host/capture-mode.js';
import { assistantText, fakeHost, humanPrompt, withStrippedRuntimeGlobals } from './fixtures/helpers.js';

// 4.9.2 (CONTRACT S5u): owner-only capture permissions and redaction where a capture is first written.
type Handler = (host: unknown, event: unknown, next: (event?: unknown) => Promise<unknown>) => Promise<unknown>;

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const HARDEN = path.join(PLUGIN_ROOT, 'harden.mjs');
const posixOnly = process.platform === 'win32';
const modeOf = (file: string) => fs.lstatSync(file).mode & 0o777;

function handlers(options: Record<string, unknown> = {}): Record<string, Handler> {
  const on: Record<string, Handler> = {};
  register(((name: string, fn: Handler) => { on[name] = fn; return { catch: (caught: unknown) => { (on as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { recallEnabled: false, ...options } as never);
  return on;
}

/** A store laid out the way `$.fs.write` leaves it under a 002 umask: directories 775, files 664. */
function looseStore() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exo-harden-'));
  const root = path.join(tmp, 'project');
  const session = path.join(root, '.exovault', 's4-capture', 's1');
  fs.mkdirSync(path.join(session, 'agent-pressure'), { recursive: true });
  for (const dir of [path.join(root, '.exovault'), path.join(root, '.exovault', 's4-capture'), session, path.join(session, 'agent-pressure')]) fs.chmodSync(dir, 0o775);
  for (const name of ['segment-0001.json', 'task-card.md', 'held-brief.md', 'agent-pressure/a.json']) {
    fs.writeFileSync(path.join(session, name), 'x');
    fs.chmodSync(path.join(session, name), 0o664);
  }
  const outside = path.join(tmp, 'outside.txt');
  fs.writeFileSync(outside, 'not ours');
  fs.chmodSync(outside, 0o644);
  fs.symlinkSync(outside, path.join(session, 'link'));
  return { tmp, root, session, outside };
}

/** Every directory and file under `dir`, links left out. */
function walk(dir: string): { dirs: string[]; files: string[] } {
  const out = { dirs: [dir], files: [] as string[] };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { const sub = walk(file); out.dirs.push(...sub.dirs); out.files.push(...sub.files); }
    else out.files.push(file);
  }
  return out;
}

describe.skipIf(posixOnly)('4.9.2 (S5u) harden.mjs: owner-only capture store', () => {
  it('sets 0700 on .exovault and s4-capture, then 0700 on the session directory and 0600 on every file in it', () => {
    const { tmp, root, session, outside } = looseStore();
    try {
      expect(hardenFiles(root)).toEqual({ store: true, session: false, removed: false });
      expect(modeOf(path.join(root, '.exovault'))).toBe(DIR_MODE);
      expect(modeOf(path.join(root, '.exovault', 's4-capture'))).toBe(DIR_MODE);
      expect(modeOf(session)).toBe(0o775);
      expect(hardenFiles(root, session)).toEqual({ store: true, session: true, removed: false });
      const { dirs, files } = walk(session);
      expect(files).toHaveLength(4);
      for (const dir of dirs) expect(modeOf(dir), dir).toBe(DIR_MODE);
      for (const file of files) expect(modeOf(file), file).toBe(FILE_MODE);
      expect(modeOf(outside)).toBe(0o644);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it('creates a missing store 0700, but never the root itself', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exo-harden-'));
    try {
      expect(hardenFiles(tmp).store).toBe(true);
      expect(modeOf(path.join(tmp, '.exovault'))).toBe(DIR_MODE);
      expect(modeOf(path.join(tmp, '.exovault', 's4-capture'))).toBe(DIR_MODE);
      expect(hardenFiles(path.join(tmp, 'missing')).store).toBe(false);
      expect(fs.existsSync(path.join(tmp, 'missing'))).toBe(false);
      expect(hardenFiles('relative/root').store).toBe(false);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it('touches no directory outside the store and removes only a plain file name of the session directory', () => {
    const { tmp, root, session } = looseStore();
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.chmodSync(elsewhere, 0o755);
    fs.writeFileSync(path.join(tmp, 'keep.txt'), 'x');
    try {
      expect(hardenFiles(root, elsewhere).session).toBe(false);
      expect(hardenFiles(root, path.join(session, '..', '..', '..', '..', 'elsewhere')).session).toBe(false);
      expect(modeOf(elsewhere)).toBe(0o755);
      expect(hardenFiles(root, session, '../../../../keep.txt').removed).toBe(false);
      expect(fs.existsSync(path.join(tmp, 'keep.txt'))).toBe(true);
      expect(hardenFiles(root, session, 'agent-pressure').removed).toBe(false);
      expect(hardenFiles(root, session, 'held-brief.md').removed).toBe(true);
      expect(fs.existsSync(path.join(session, 'held-brief.md'))).toBe(false);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it('the command line the hook runs does the same and always exits 0', () => {
    const { tmp, root, session } = looseStore();
    try {
      execFileSync(process.execPath, hardenArgv(PLUGIN_ROOT, root, session, 'held-brief.md').slice(1));
      expect(fs.existsSync(path.join(session, 'held-brief.md'))).toBe(false);
      expect(modeOf(path.join(session, 'task-card.md'))).toBe(FILE_MODE);
      expect(() => execFileSync(process.execPath, [HARDEN, 'not/absolute'])).not.toThrow();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe.skipIf(posixOnly)('4.9.2 (S5u) setup.cjs writes the flag owner-only', () => {
  it('enable and optout create .exovault 0700 and the flag, opt-out and .gitignore 0600', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exo-setup-'));
    try {
      execFileSync(process.execPath, [path.join(PLUGIN_ROOT, 'setup.cjs'), 'enable', tmp]);
      expect(modeOf(path.join(tmp, '.exovault'))).toBe(DIR_MODE);
      expect(modeOf(path.join(tmp, '.exovault', 's4-compact-active'))).toBe(FILE_MODE);
      expect(modeOf(path.join(tmp, '.exovault', '.gitignore'))).toBe(FILE_MODE);
      execFileSync(process.execPath, [path.join(PLUGIN_ROOT, 'setup.cjs'), 'optout', tmp]);
      expect(modeOf(path.join(tmp, '.exovault', 's4-compact-off'))).toBe(FILE_MODE);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('4.9.2 (S5u) host/capture-mode.ts', () => {
  it('runs harden.mjs from the trusted plugin root and nothing without one; a failed run never throws', async () => {
    const runs: string[][] = [];
    const run = async (argv: string[]) => { runs.push(argv); return {}; };
    expect(await hardenCapture({ pluginRoot: () => '/plugins/exo-compact', run }, '/home/u', '/home/u/.exovault/s4-capture/s1', 'held-brief.md')).toBe(true);
    expect(runs).toEqual([['node', '/plugins/exo-compact/harden.mjs', '/home/u', '/home/u/.exovault/s4-capture/s1', '--remove', 'held-brief.md']]);
    expect(await hardenCapture({ pluginRoot: () => undefined, run }, '/home/u')).toBe(false);
    expect(runs).toHaveLength(1);
    expect(await hardenCapture({ pluginRoot: () => '/p', run: async () => { throw new Error('spawn node ENOENT'); } }, '/home/u')).toBe(false);
  });
});

/**
 * The real hooks against a real directory: `$.fs.write` is modelled with the modes a 002 umask gives, and every
 * `$.process.run` of harden.mjs runs the real script.
 */
function diskHost(home: string, options: { cwd?: string; messages?: unknown[] } = {}) {
  const pending: Promise<unknown>[] = [];
  const runs: string[][] = [];
  const written: { path: string; text: string; storeModeAtWrite?: number; seq: number }[] = [];
  /** Order of writes and harden runs, so a test can tell which files a run could not have seen yet. */
  const clock = { seq: 0, lastHarden: -1 };
  const store = path.join(home, '.exovault', 's4-capture');
  const $ = {
    plugin: { name: 'exo-compact', root: PLUGIN_ROOT },
    session: {
      cwd: async () => options.cwd ?? path.join(home, 'work'),
      root: async () => options.cwd ?? path.join(home, 'work'),
      id: async () => 's1',
      surfaces: async () => ['terminal'],
      version: async () => ({ version: '2.1.292', base: '2.1.292' }),
      messages: async () => options.messages ?? [{ role: 'user', text: 'hello there', toolUses: [] }],
    },
    fs: {
      exists: async (file: string) => fs.existsSync(file),
      read: async (file: string) => fs.readFileSync(file, 'utf8'),
      write: async (file: string, text: string) => {
        written.push({ path: file, text, storeModeAtWrite: fs.existsSync(store) ? modeOf(store) : undefined, seq: clock.seq++ });
        // Like a real write under a 002 umask: what it creates is 775/664, what exists keeps its mode.
        const created = fs.mkdirSync(path.dirname(file), { recursive: true });
        if (created !== undefined) for (let dir = path.dirname(file); dir.length >= created.length; dir = path.dirname(dir)) fs.chmodSync(dir, 0o775);
        const isNew = !fs.existsSync(file);
        fs.writeFileSync(file, text);
        if (isNew) fs.chmodSync(file, 0o664);
      },
      list: async (dir?: string) => fs.readdirSync(dir ?? '.', { withFileTypes: true }).map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file', size: 0 })),
    },
    ui: { log: () => undefined },
    env: { get: async (name: string) => (name === 'HOME' ? home : name === 'CLAUDE_PLUGIN_ROOT' ? '/tmp/evil-env' : undefined) },
    process: {
      run: (argv: string[]) => {
        runs.push(argv);
        if (!String(argv[1]).endsWith('/harden.mjs')) return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        const ran = Promise.resolve().then(() => { clock.lastHarden = clock.seq++; execFileSync(process.execPath, argv.slice(1)); return { exitCode: 0, stdout: '', stderr: '' }; });
        pending.push(ran);
        return ran;
      },
    },
    clock: { sleep: (ms: number) => (ms === 0 ? Promise.resolve() : new Promise(() => undefined)), now: async () => Date.now(), after: () => ({ cancel: () => undefined }) },
  };
  return { $, runs, written, clock, settle: async () => { await new Promise((r) => setTimeout(r, 20)); await Promise.all(pending); } };
}

describe.skipIf(posixOnly)('4.9.2 (S5u) the hooks leave the capture store owner-only', () => {
  it('session start makes the store 0700 before the first capture write; each turn leaves every file it saw 0600', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exo-home-'));
    try {
      const on = handlers();
      const host = diskHost(home);
      await on['session.start']!(host.$, { cwd: path.join(home, 'work'), surface: 'terminal', isInteractive: true }, async (e) => e);
      await host.settle();
      expect(modeOf(path.join(home, '.exovault'))).toBe(DIR_MODE);
      expect(modeOf(path.join(home, '.exovault', 's4-capture'))).toBe(DIR_MODE);
      for (let turn = 0; turn < 2; turn++) {
        await on['turn.complete']!(host.$, { reason: 'answer' }, async () => undefined);
        await host.settle();
      }
      const captures = host.written.filter((w) => w.path.includes('/.exovault/s4-capture/'));
      expect(captures.length).toBeGreaterThan(0);
      for (const write of captures) expect(write.storeModeAtWrite, write.path).toBe(DIR_MODE);
      const { dirs, files } = walk(path.join(home, '.exovault', 's4-capture'));
      expect(files.some((file) => /segment-/.test(file))).toBe(true);
      for (const dir of dirs) expect(modeOf(dir), dir).toBe(DIR_MODE);
      // A file first written after the last run (a late notice line) is 0600 at the next run; until then it sits in a
      // 0700 directory, which the loop above checks.
      const lastWrite = new Map(host.written.map((w) => [path.resolve(w.path), w.seq]));
      const seen = files.filter((file) => (lastWrite.get(file) ?? -1) < host.clock.lastHarden);
      expect(seen.some((file) => /segment-/.test(file))).toBe(true);
      for (const file of seen) expect(modeOf(file), file).toBe(FILE_MODE);
      // A project env block's CLAUDE_PLUGIN_ROOT never picks the script (host/plugin-root.ts).
      for (const argv of host.runs) expect(argv[1].startsWith('/tmp/evil-env')).toBe(false);
      expect(host.runs.filter((argv) => argv[1] === HARDEN.split(path.sep).join('/') || argv[1] === `${PLUGIN_ROOT}/harden.mjs`)).toHaveLength(3);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});

describe('4.9.2 (S5u) redaction where a capture is first written', () => {
  const KEYS = ['sk-AAAAAAAAAAAAAAAAAAAAAAAA', 'ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBB', 'AKIACCCCCCCCCCCCCCCC'];

  it('no capture write carries a key from a prompt, an answer, a tool call or the working directory', async () => {
    const written: { path: string; text: string }[] = [];
    const files = new Map<string, string>();
    const $ = fakeHost({
      sessionCwd: async () => `/work/${KEYS[1]}`,
      envGet: async (name) => (name === 'HOME' ? '/home/u' : undefined),
      fsExists: async (file) => file.endsWith('/.exovault/s4-compact-active') || files.has(file),
      fsRead: async (file) => { const text = files.get(file); if (text === undefined) throw new Error('ENOENT'); return text; },
      fsWrite: async (file, text) => { written.push({ path: file, text }); files.set(file, text); },
      sessionMessages: async () => [
        humanPrompt(`deploy with OPENAI_API_KEY=${KEYS[0]} please`),
        { ...assistantText(`I will use ${KEYS[2]} for the bucket.`), toolUses: [{ tool: 'Bash', tool_use_id: 't1', input: { command: `curl -H "Authorization: Bearer ${KEYS[1]}" https://api.example.com` } }] },
      ] as never,
    });
    await withStrippedRuntimeGlobals(() => handlers({ interactiveOnly: false })['turn.complete']!($, { reason: 'answer' }, async () => ({})));
    const segments = written.filter((w) => /\/segment-[^/]*$/.test(w.path));
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.some((w) => w.text.includes('cwd_snapshot'))).toBe(true);
    for (const write of written) for (const key of KEYS) expect(write.text, `${write.path} keeps ${key}`).not.toContain(key);
  });
});
