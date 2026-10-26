import { LEGACY_OPTIONS } from './fixtures/helpers.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pickHomeDir } from '../host/home-dir.js';
import { findTranscriptPath } from '../host/transcript-path.js';
import { claudeConfigDir, claudeProjectsDir, homeDir, recallRootDir } from '../recall/paths.mjs';
import { findSessionTranscript, recallTool } from '../recall/mcp-server.mjs';

// 4.7.0 (CONTRACT S5i): one home-directory rule for the hook and for every node process it starts.
const CASES: [string, { HOME?: string; USERPROFILE?: string; HOMEDRIVE?: string; HOMEPATH?: string }, string | undefined][] = [
  ['HOME wins', { HOME: '/home/u', USERPROFILE: 'C:\\Users\\u' }, '/home/u'],
  ['USERPROFILE when HOME is unset (Windows)', { USERPROFILE: 'C:\\Users\\u', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\x' }, 'C:\\Users\\u'],
  ['an empty HOME counts as unset', { HOME: '', USERPROFILE: 'C:\\Users\\u' }, 'C:\\Users\\u'],
  ['HOMEDRIVE + HOMEPATH last', { HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\u' }, 'C:\\Users\\u'],
  ['HOMEPATH alone is not a directory', { HOMEPATH: '\\Users\\u' }, undefined],
  ['nothing set', {}, undefined],
];

describe('home directory (4.7.0)', () => {
  for (const [name, env, expected] of CASES) {
    it(`hook side: ${name}`, () => {
      expect(pickHomeDir({ home: env.HOME, userProfile: env.USERPROFILE, homeDrive: env.HOMEDRIVE, homePath: env.HOMEPATH })).toBe(expected);
    });
    it(`node side reads the same env chain (nothing set gives '.', where the hook side gives undefined): ${name}`, () => {
      expect(homeDir(env)).toBe(expected ?? '.');
    });
  }

  it('the recall store is <home>/.claude/exovault/recall for both sides', () => {
    expect(recallRootDir({ USERPROFILE: '/users/u' })).toBe(path.join('/users/u', '.claude/exovault/recall'));
  });

  it('CLAUDE_CONFIG_DIR moves the lookups of Claude Code files, not the recall store', () => {
    const env = { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/cfg' };
    expect(claudeConfigDir(env)).toBe('/cfg');
    expect(claudeProjectsDir(env)).toBe(path.join('/cfg', 'projects'));
    expect(recallRootDir(env)).toBe(path.join('/home/u', '.claude/exovault/recall'));
    expect(claudeProjectsDir({ HOME: '/home/u', CLAUDE_CONFIG_DIR: '' })).toBe(path.join('/home/u', '.claude/projects'));
  });
});

describe('session transcript lookup (4.7.0)', () => {
  const withTree = (rel: string, run: (root: string) => void) => {
    const root = mkdtempSync(path.join(tmpdir(), 'exo-home-'));
    try {
      const file = path.join(root, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'the zebra value is 4417' } })}\n`);
      run(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  };

  it('search_session finds the transcript under USERPROFILE when HOME is unset', () => {
    withTree('.claude/projects/p/s1.jsonl', (root) => {
      const result = recallTool({ query: 'zebra 4417', session: 's1' }, { env: { USERPROFILE: root }, recallRoot: path.join(root, 'none') }) as { source: string };
      expect(result.source).not.toBe('no-index');
    });
  });

  it('search_session honors CLAUDE_CONFIG_DIR', () => {
    withTree('cfg/projects/p/s1.jsonl', (root) => {
      const env = { HOME: path.join(root, 'empty-home'), CLAUDE_CONFIG_DIR: path.join(root, 'cfg') };
      const result = recallTool({ query: 'zebra 4417', session: 's1' }, { env, recallRoot: path.join(root, 'none') }) as { source: string };
      expect(result.source).not.toBe('no-index');
      expect(findSessionTranscript('s1', claudeProjectsDir(env))).toBeDefined();
    });
  });

  it('the hook side looks in CLAUDE_CONFIG_DIR/projects too, with or without a home directory', async () => {
    const real = '/cfg/projects/-h-work/s1.jsonl';
    const fs = { exists: async (p: string) => p === real, list: async (p: string) => (p === '/cfg/projects' ? [{ name: '-h-work', kind: 'dir' }] : []) };
    const host = { cwd: async () => '/h/work/voice', home: async () => undefined, configDir: async () => '/cfg' };
    expect(await findTranscriptPath(host, 's1', fs)).toBe(real);
    expect(await findTranscriptPath({ ...host, home: async () => '/h' }, 's1', fs)).toBe(real);
    expect(await findTranscriptPath({ cwd: host.cwd, home: async () => undefined }, 's1', fs)).toBeNull();
  });
});

type Handler = (host: unknown, event: unknown, next: (event?: unknown) => Promise<unknown>) => Promise<unknown>;

async function hooks(options: Record<string, unknown> = {}) {
  const { register } = await import('../compact.js');
  const on: Record<string, Handler> = {};
  register(((name: string, fn: Handler) => { on[name] = fn; return { catch: (caught: unknown) => { (on as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS, recallPluginRoot: '/plugin', recallEnabled: true, ...options } as never);
  return on;
}

function windowsHost(env: Record<string, string>) {
  const runs: string[][] = [];
  return {
    runs,
    session: { cwd: async () => '/tmp/project', id: async () => 's1', surfaces: async () => [] },
    fs: { exists: async (p: string) => p.endsWith('.exovault/s4-compact-active'), read: async () => { throw new Error('ENOENT'); }, write: async () => undefined, list: async () => [] },
    env: { get: async (name: string) => env[name] },
    clock: { now: async () => 0, after: () => ({ cancel: () => {} }) },
    process: { run: async (argv: string[]) => { runs.push(argv); return { exitCode: 0, stdout: 'null', stderr: '' }; } },
    ui: { log: () => undefined },
  };
}

describe('compact.ts resolves the home directory in one place (4.7.0)', () => {
  it('a brief save passes the recall root under USERPROFILE when HOME is unset', async () => {
    const h = windowsHost({ USERPROFILE: 'C:\\Users\\u' });
    await (await hooks())['prompt.submit']!(h, { text: `Task 3 of 6.\n${'x '.repeat(1500)}`, origin: { kind: 'sdk' } }, async (e) => e);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const save = h.runs.find((argv) => argv[1] === '/plugin/recall/brief.mjs');
    expect(save?.[3]).toBe('C:\\Users\\u/.claude/exovault/recall');
  });

  it('falls back to HOMEDRIVE + HOMEPATH, then to .', async () => {
    const drive = windowsHost({ HOMEDRIVE: 'D:', HOMEPATH: '\\Users\\u' });
    await (await hooks())['prompt.submit']!(drive, { text: `Task 3 of 6.\n${'x '.repeat(1500)}`, origin: { kind: 'sdk' } }, async (e) => e);
    const none = windowsHost({});
    await (await hooks())['prompt.submit']!(none, { text: `Task 3 of 6.\n${'x '.repeat(1500)}`, origin: { kind: 'sdk' } }, async (e) => e);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(drive.runs.find((argv) => argv[1] === '/plugin/recall/brief.mjs')?.[3]).toBe('D:\\Users\\u/.claude/exovault/recall');
    expect(none.runs.find((argv) => argv[1] === '/plugin/recall/brief.mjs')?.[3]).toBe('./.claude/exovault/recall');
  });

  it('no env read of HOME is left outside the one helper', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../compact.ts', import.meta.url), 'utf8');
    expect(source.match(/\$\.env\.get\('HOME'\)/g)?.length ?? 0).toBe(7); // n = the seven handlers that build the one resolveHomeDir closure (4.9.2: session.start too)
    expect(source).not.toMatch(/\(await \$\.env\.get\('HOME'\)\) \?\? '\.'/);
  });
});
