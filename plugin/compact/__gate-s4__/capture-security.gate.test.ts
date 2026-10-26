import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from '../compact.js';
import { DIR_MODE, FILE_MODE, hardenCapture as hardenFiles } from '../harden.mjs';
import { hardenArgv, hardenCapture, hardenCaptureRoot, hardenCaptureSession, makeCaptureGuard } from '../host/capture-mode.js';
import { assistantText, fakeHost, humanPrompt, withStrippedRuntimeGlobals } from './fixtures/helpers.js';
import { nodeRunner, scrubbedInit, SCRUBBED_ENV, trustedNode, type NodeRunInit } from '../host/node-run.js';

// 4.9.2 (CONTRACT S5u): owner-only capture permissions and redaction where a capture is first written.
type Handler = (host: unknown, event: unknown, next: (event?: unknown) => Promise<unknown>) => Promise<unknown>;

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const HARDEN = path.join(PLUGIN_ROOT, 'harden.mjs');
const posixOnly = process.platform === 'win32';
const modeOf = (file: string) => fs.lstatSync(file).mode & 0o777;
/** Runs node with `args`; its exit code. */
const exitOf = (args: string[]) => { try { execFileSync(process.execPath, args, { stdio: 'ignore' }); return 0; } catch (error) { return (error as { status?: number }).status ?? -1; } };

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

  it('the command line the hook runs does the same and exits 0, and 2 for a root it cannot use (review)', () => {
    const { tmp, root, session } = looseStore();
    try {
      execFileSync(process.execPath, hardenArgv(PLUGIN_ROOT, root, session, 'held-brief.md').slice(1));
      expect(fs.existsSync(path.join(session, 'held-brief.md'))).toBe(false);
      expect(modeOf(path.join(session, 'task-card.md'))).toBe(FILE_MODE);
      expect(exitOf([HARDEN, 'not/absolute'])).toBe(2);
      expect(exitOf([HARDEN, root])).toBe(0);
      expect(exitOf([HARDEN, root, path.join(tmp, 'elsewhere', 's1')])).toBe(2);
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
    const run = async (argv: string[]) => { runs.push(argv); return { exitCode: 0 }; };
    expect(await hardenCapture({ pluginRoot: () => '/plugins/exo-compact', run }, '/home/u', '/home/u/.exovault/s4-capture/s1', 'held-brief.md')).toBe(true);
    expect(runs).toEqual([['node', '/plugins/exo-compact/harden.mjs', '/home/u', '/home/u/.exovault/s4-capture/s1', '--remove', 'held-brief.md']]);
    expect(await hardenCapture({ pluginRoot: () => undefined, run }, '/home/u')).toBe(false);
    expect(runs).toHaveLength(1);
    expect(await hardenCapture({ pluginRoot: () => '/p', run: async () => { throw new Error('spawn node ENOENT'); } }, '/home/u')).toBe(false);
    // 4.9.2 review: only exit 0 counts; a run that exits 2 (a link, another user's directory) or reports no code is false.
    expect(await hardenCapture({ pluginRoot: () => '/p', run: async () => ({ exitCode: 2 }) }, '/home/u')).toBe(false);
    expect(await hardenCapture({ pluginRoot: () => '/p', run: async () => ({}) }, '/home/u')).toBe(false);
  });
});

/**
 * The real hooks against a real directory: `$.fs.write` is modelled with the modes a 002 umask gives, and every
 * `$.process.run` of harden.mjs runs the real script.
 */
function diskHost(home: string, options: { cwd?: string | (() => string); messages?: unknown[]; hardenExit?: (argv: string[]) => number | undefined } = {}) {
  const cwdNow = () => (typeof options.cwd === 'function' ? options.cwd() : options.cwd) ?? path.join(home, 'work');
  const pending: Promise<unknown>[] = [];
  const runs: string[][] = [];
  const written: { path: string; text: string; storeModeAtWrite?: number; sessionModeAtWrite?: number; seq: number }[] = [];
  /** Order of writes and harden runs, so a test can tell which files a run could not have seen yet. */
  const clock = { seq: 0, lastHarden: -1 };
  const $ = {
    plugin: { name: 'exo-compact', root: PLUGIN_ROOT },
    session: {
      cwd: async () => cwdNow(),
      root: async () => cwdNow(),
      id: async () => 's1',
      surfaces: async () => ['terminal'],
      version: async () => ({ version: '2.1.292', base: '2.1.292' }),
      messages: async () => options.messages ?? [{ role: 'user', text: 'hello there', toolUses: [] }],
    },
    fs: {
      exists: async (file: string) => fs.existsSync(file),
      read: async (file: string) => fs.readFileSync(file, 'utf8'),
      write: async (file: string, text: string) => {
        // The modes of the write's own store and session directory (lstat: a link reports its own mode, never 0700).
        const at = file.indexOf('/.exovault/s4-capture/');
        const store = at < 0 ? undefined : file.slice(0, at + '/.exovault/s4-capture'.length);
        const session = store === undefined ? undefined : path.join(store, file.slice(store.length + 1).split('/')[0]!);
        written.push({ path: file, text, storeModeAtWrite: store && fs.existsSync(store) ? modeOf(store) : undefined, sessionModeAtWrite: session && fs.existsSync(session) ? modeOf(session) : undefined, seq: clock.seq++ });
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
        const ran = Promise.resolve().then(() => { clock.lastHarden = clock.seq++; return { exitCode: options.hardenExit?.(argv) ?? exitOf(argv.slice(1)), stdout: '', stderr: '' }; });
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

/** A repository that turns the plugin on and commits `.exovault/s4-capture` as a link into its own checkout. */
function linkedRepo(home: string) {
  const repo = path.join(home, 'work', 'repo');
  fs.mkdirSync(path.join(repo, '.exovault'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'public'));
  fs.writeFileSync(path.join(repo, '.exovault', 's4-compact-active'), '');
  fs.symlinkSync(path.join('..', 'public'), path.join(repo, '.exovault', 's4-capture'));
  return repo;
}

const hardenRuns = (runs: string[][], root: string) => runs.filter((argv) => String(argv[1]).endsWith('/harden.mjs') && argv[2] === root);

describe.skipIf(posixOnly)('4.9.2 review (S5u): no capture write under a root harden.mjs did not verify', () => {
  it('a committed .exovault/s4-capture link gets no write through it and its root is never cached', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exo-home-'));
    try {
      const repo = linkedRepo(home);
      const on = handlers({ interactiveOnly: false });
      const host = diskHost(home, { cwd: repo });
      await on['session.start']!(host.$, { cwd: repo, surface: 'terminal', isInteractive: true }, async (e) => e);
      for (let turn = 0; turn < 2; turn++) {
        await on['turn.complete']!(host.$, { reason: 'answer' }, async () => undefined);
        await host.settle();
      }
      const native = { messages: [] };
      expect(await on['session.compact']!(host.$, { trigger: 'auto', messages: [] }, async () => native)).toBe(native);
      await host.settle();
      expect(fs.readdirSync(path.join(repo, 'public'))).toEqual([]);
      expect(host.written.filter((w) => w.path.startsWith(repo))).toEqual([]);
      // Every lookup asked again: a failed root is not remembered (session start, two turns, the cut).
      expect(hardenRuns(host.runs, repo).length).toBeGreaterThanOrEqual(4);
      expect(fs.lstatSync(path.join(repo, '.exovault', 's4-capture')).isSymbolicLink()).toBe(true);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('a harden.mjs run that exits non-zero leaves the root without any capture write; a later 0 lets writes start', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exo-home-'));
    try {
      let exit = 2;
      const on = handlers({ interactiveOnly: false });
      const host = diskHost(home, { hardenExit: () => exit });
      await on['session.start']!(host.$, { cwd: path.join(home, 'work'), surface: 'terminal', isInteractive: true }, async (e) => e);
      await on['turn.complete']!(host.$, { reason: 'answer' }, async () => undefined);
      await host.settle();
      expect(host.written.filter((w) => w.path.includes('/.exovault/'))).toEqual([]);
      exit = 0;
      await on['turn.complete']!(host.$, { reason: 'answer' }, async () => undefined);
      await host.settle();
      expect(host.written.filter((w) => w.path.includes('/.exovault/s4-capture/')).length).toBeGreaterThan(0);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('a root the working directory reaches mid-session is 0700, with its session directory, before its first write', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exo-home-'));
    try {
      const project = path.join(home, 'work', 'project');
      fs.mkdirSync(path.join(project, '.exovault'), { recursive: true, mode: 0o775 });
      fs.chmodSync(path.join(project, '.exovault'), 0o775);
      fs.writeFileSync(path.join(project, '.exovault', 's4-compact-active'), '');
      let cwd = path.join(home, 'work');
      const on = handlers({ interactiveOnly: false });
      const host = diskHost(home, { cwd: () => cwd });
      await on['session.start']!(host.$, { cwd, surface: 'terminal', isInteractive: true }, async (e) => e);
      await on['turn.complete']!(host.$, { reason: 'answer' }, async () => undefined);
      await host.settle();
      expect(host.written.some((w) => w.path.startsWith(path.join(home, '.exovault', 's4-capture')))).toBe(true);
      cwd = project;
      await on['turn.complete']!(host.$, { reason: 'answer' }, async () => undefined);
      await host.settle();
      const projectWrites = host.written.filter((w) => w.path.startsWith(path.join(project, '.exovault', 's4-capture')));
      expect(projectWrites.length).toBeGreaterThan(0);
      for (const write of projectWrites) {
        expect(write.storeModeAtWrite, write.path).toBe(DIR_MODE);
        expect(write.sessionModeAtWrite, write.path).toBe(DIR_MODE);
      }
      expect(modeOf(path.join(project, '.exovault'))).toBe(DIR_MODE);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});

describe('4.9.2 review (S5u): every capture lookup that leads to a write is verified', () => {
  it('each findCaptureRoot call in compact.ts passes secure, except the read-only Jev egress check', () => {
    const source = fs.readFileSync(path.join(PLUGIN_ROOT, 'compact.ts'), 'utf8');
    const calls = source.split('\n').filter((line) => line.includes('findCaptureRoot({'));
    expect(calls.length).toBeGreaterThan(10);
    const unsecured = calls.filter((line) => !/secure: (secureRoot|host\.secure) \}/.test(line));
    expect(unsecured).toHaveLength(1);
    expect(unsecured[0]).toContain('inert: flags.inert })) === null) return false;');
    const flagHosts = source.split('\n').filter((line) => /const flagHost = \{/.test(line));
    expect(flagHosts.length).toBeGreaterThan(0);
    for (const line of flagHosts) expect(line).toContain('secure: secureRoot }');
  });

  it('the guard remembers a verified store and session directory, and retries one that failed', async () => {
    const runs: string[][] = [];
    let exit = 2;
    const host = { pluginRoot: () => '/p', run: async (argv: string[]) => { runs.push(argv); return { exitCode: exit }; } };
    const guard = makeCaptureGuard();
    expect(await guard.secure(host, '/r', '/r/.exovault/s4-capture/s1')).toBe(false);
    expect(await guard.secure(host, '/r', '/r/.exovault/s4-capture/s1')).toBe(false);
    exit = 0;
    expect(await guard.secure(host, '/r', '/r/.exovault/s4-capture/s1')).toBe(true);
    expect(await guard.secure(host, '/r', '/r/.exovault/s4-capture/s1')).toBe(true);
    expect(runs).toHaveLength(3);
    expect(runs[0]).toEqual(['node', '/p/harden.mjs', '/r', '/r/.exovault/s4-capture/s1']);
    expect(await hardenCaptureRoot(host, '/r')).toBe(true);
    expect(await hardenCaptureSession(host, '/r', '/r/.exovault/s4-capture/s2')).toBe(true);
  });
});

describe('4.9.2 review (S5w): a project env block cannot pick the Node the hook runs or load code into it', () => {
  it('nodeRunner uses a safe, existing nodePath, else node, and always lays SCRUBBED_ENV over the child environment', async () => {
    const calls: { argv: string[]; init: NodeRunInit }[] = [];
    const run = async (argv: string[], init: NodeRunInit) => { calls.push({ argv, init }); return { exitCode: 0 }; };
    const exists = async (file: string) => file === '/opt/node/bin/node';
    await nodeRunner(run, '/opt/node/bin/node', exists)(['node', '/p/harden.mjs', '/r'], { timeoutMs: 1, env: { NODE_OPTIONS: '--require=/repo/evil.cjs', EXO_JEV_MODEL: 'm' } });
    expect(calls[0]!.argv).toEqual(['/opt/node/bin/node', '/p/harden.mjs', '/r']);
    expect(calls[0]!.init.env).toEqual({ ...SCRUBBED_ENV, EXO_JEV_MODEL: 'm' });
    for (const option of ['', 'node', 'relative/node', '/opt/../repo/node', '/missing/node']) {
      await nodeRunner(run, option, exists)(['node', 'x.mjs'], { timeoutMs: 1 });
      expect(calls.at(-1)!.argv[0], option).toBe('node');
      expect(calls.at(-1)!.init.env!.NODE_OPTIONS).toBe('');
    }
    expect(await trustedNode('/opt/node/bin/node', async () => { throw new Error('EACCES'); })).toBe('node');
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_EXTRA_CA_CERTS']) expect(SCRUBBED_ENV[name], name).toBe('');
  });

  it('the scrubbed environment really keeps a --require out of a Node child', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exo-env-'));
    try {
      const marker = path.join(tmp, 'evil-ran');
      const evil = path.join(tmp, 'evil.cjs');
      fs.writeFileSync(evil, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');`);
      const hostile = { ...process.env, NODE_OPTIONS: `--require=${evil}` };
      execFileSync(process.execPath, ['-e', '0'], { env: scrubbedInit({ env: hostile as Record<string, string> }).env });
      expect(fs.existsSync(marker)).toBe(false);
      execFileSync(process.execPath, ['-e', '0'], { env: hostile });
      expect(fs.existsSync(marker)).toBe(true);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it('every Node script the hooks start gets the nodePath binary and the scrubbed environment', async () => {
    const runs: { argv: readonly string[]; init?: { env?: Record<string, string> } }[] = [];
    const $ = fakeHost({
      pluginRoot: '/plugins/exo-compact',
      envGet: async (name) => (name === 'HOME' ? '/home/u' : name === 'NODE_OPTIONS' ? '--require=/repo/evil.cjs' : undefined),
      fsExists: async (file) => file.endsWith('/.exovault/s4-compact-active') || file.endsWith('.jsonl') || file === '/opt/node/bin/node',
      processRun: async (argv, init) => { runs.push({ argv, init: init as never }); return { exitCode: 0, stdout: '', stderr: '' }; },
      sessionMessages: async () => [humanPrompt('hello there'), assistantText('hi')] as never,
    });
    const on = handlers({ interactiveOnly: false, recallEnabled: true, nodePath: '/opt/node/bin/node', workStateProbe: false });
    await withStrippedRuntimeGlobals(async () => {
      await on['session.start']!($, { cwd: '/project', surface: 'terminal', isInteractive: true }, async (e) => e);
      await on['turn.complete']!($, { reason: 'answer' }, async () => ({}));
    });
    const scripts = runs.filter((run) => /\.m?js$|\.mjs$/.test(String(run.argv[1])));
    expect(scripts.some((run) => String(run.argv[1]).endsWith('/harden.mjs'))).toBe(true);
    expect(scripts.some((run) => String(run.argv[1]).endsWith('/recall/launch.mjs'))).toBe(true);
    for (const run of scripts) {
      expect(run.argv[0], String(run.argv[1])).toBe('/opt/node/bin/node');
      expect(run.init?.env, String(run.argv[1])).toMatchObject(SCRUBBED_ENV);
    }
  });

  it('brief.mjs starts claude only from ~/.local/bin or next to its own Node, with the scrubbed environment', async () => {
    const brief = await import('../recall/brief.mjs');
    const has = (...files: string[]) => (file: string) => files.includes(file);
    expect(brief.claudeBin('/home/u', '/opt/node/bin/node', has('/home/u/.local/bin/claude', '/opt/node/bin/claude'), 'linux')).toBe('/home/u/.local/bin/claude');
    expect(brief.claudeBin('/home/u', '/opt/node/bin/node', has('/opt/node/bin/claude'), 'linux')).toBe('/opt/node/bin/claude');
    expect(brief.claudeBin('/home/u', '/opt/node/bin/node', has(), 'linux')).toBeUndefined();
    expect(brief.claudeBin(path.join('C:', 'u'), path.join('C:', 'node', 'node.exe'), has(path.join('C:', 'node', 'claude.exe')), 'win32')).toBe(path.join('C:', 'node', 'claude.exe'));
    const env = brief.digestEnv({ PATH: '/repo/bin', NODE_OPTIONS: '--require=/repo/evil.cjs', CLAUDE_CODE_EXECPATH: '/repo/claude', HOME: '/home/u' });
    expect(env).toMatchObject({ ...SCRUBBED_ENV, EXOVAULT_BRIEF_CHILD: '1', HOME: '/home/u' });
    expect({ ...brief.SCRUBBED_ENV }).toEqual({ ...SCRUBBED_ENV });
    const source = fs.readFileSync(path.join(PLUGIN_ROOT, 'recall', 'brief.mjs'), 'utf8');
    expect(source).not.toMatch(/spawn\(\s*['"`]claude/);
    expect(source).toMatch(/const bin = claudeBin\(\);/);
    expect(source).not.toMatch(/\.CLAUDE_CODE_EXECPATH|\[\s*['"]CLAUDE_CODE_EXECPATH/);
  });

  it('the manifest declares nodePath and both installers record the Node that ran them', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(manifest.userConfig.nodePath).toMatchObject({ type: 'string', default: '' });
    const repoRoot = path.join(PLUGIN_ROOT, '..', '..');
    expect(fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8')).toContain('--config "nodePath=$node_bin"');
    expect(fs.readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8')).toContain('--config "nodePath=$nodeBin"');
  });
});
