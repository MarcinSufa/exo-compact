import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { hash } from '../recall/shared.mjs';
import { recallToolAsync, recallTool } from '../recall/mcp-server.mjs';
import { JEV_URL, MAX_EXCERPT, jevConfig, rerankOrder, scoreWithJev } from '../recall/jev-rerank.mjs';

const SESSION = 'jev-rerank-session';
const KEY = 'ts_test_planted_secret_0123456789';
const config = { key: KEY, model: 'jev-latest', timeoutMs: 1000 };

function makeIndex(root: string, texts: string[]) {
  const dir = path.join(root, hash(SESSION));
  const generation = path.join(dir, 'generation-00000001');
  mkdirSync(generation, { recursive: true });
  const rows = texts.map((text, i) => ({ sourceId: `row-${i}`, sourceSessionId: SESSION, position: i * 100, turn: i + 1, role: 'user', tool: '', filePath: '', text }));
  writeFileSync(path.join(generation, 'records.json'), JSON.stringify(rows));
  writeFileSync(path.join(generation, 'manifest.json'), JSON.stringify({ sessionId: SESSION, generation: 1, cutoffPosition: 1000, lineage: [], createdAt: new Date(0).toISOString(), chunkCount: rows.length }));
  writeFileSync(path.join(dir, 'CURRENT'), '1\n');
}

const STATUS = `Status file. ${'Round notes about the server rollout and its checks. '.repeat(6)}The server listens on port 7311 now.`;

/** Rows that all mention the port; only the last says which port the server listens on. */
const TEXTS = [
  'We talked about which port the dashboard should use, no decision yet.',
  'The port of the database container is mapped in compose, see the server notes.',
  'Port forwarding on the router is the user problem, not the server.',
  'Does the server listen on IPv6 as well? Unknown so far.',
  'Server logs rotate daily; the port number appears in each line.',
  'A firewall rule blocks every port except ssh on the staging server.',
  'The server must listen only on localhost, said the reviewer.',
  `${STATUS} Next: deploy to staging.`,
  `${STATUS} Next: check the staging logs.`,
  'The server listens on port 7311 after the change.',
];

function withIndex<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(path.join(os.tmpdir(), 's4-recall-jev-'));
  makeIndex(root, TEXTS);
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe('Jev reranking of session search', () => {
  it('is off unless enabled with a key, and honors the deny list and the recall opt-out', () => {
    expect(jevConfig({}, '/w/p')).toBeUndefined();
    expect(jevConfig({ TYPESAFE_API_KEY: KEY }, '/w/p')).toBeUndefined();
    expect(jevConfig({ EXO_JEV_ENABLED: 'true' }, '/w/p')).toBeUndefined();
    expect(jevConfig({ TYPESAFE_API_KEY: KEY, EXO_JEV_ENABLED: 'true' }, '/w/p')).toEqual({ key: KEY, url: JEV_URL, model: 'jev-latest', timeoutMs: 4000, denyList: [] });
    expect(jevConfig({ TYPESAFE_API_KEY: KEY, EXO_JEV_ENABLED: 'true', EXO_JEV_DENY_LIST: 'client-a, p' }, 'C:\\w\\p')).toBeUndefined();
    expect(jevConfig({ TYPESAFE_API_KEY: KEY, EXO_JEV_ENABLED: 'true', EXO_JEV_RECALL: 'false' }, '/w/p')).toBeUndefined();
    expect(jevConfig({ TYPESAFE_API_KEY: KEY, EXO_JEV_ENABLED: 'false' }, '/w/p')).toBeUndefined();
    expect(jevConfig({ TYPESAFE_API_KEY: '${TYPESAFE_API_KEY:-}', EXO_JEV_ENABLED: 'true' }, '/w/p')).toBeUndefined();
    expect(jevConfig({ TYPESAFE_API_KEY: KEY, EXO_JEV_ENABLED: 'true', EXO_JEV_MODEL: '${user_config.jevModel}' }, '/w/p')?.model).toBe('jev-latest');
    // An unresolved ${user_config.*} placeholder is not "true".
    expect(jevConfig({ TYPESAFE_API_KEY: KEY, EXO_JEV_ENABLED: '${user_config.jevEnabled}' }, '/w/p')).toBeUndefined();
  });

  it('sends one Noul question per excerpt, the key only in the header, excerpts capped', async () => {
    const calls: Array<{ url: string; init: { headers: Record<string, string>; body: string } }> = [];
    const fetchImpl = async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ model: 'jev-1.13.0', answers: { c0: { type: 'noul', noul: 0.1 }, c1: { type: 'noul', noul: 0.9 } } }) };
    };
    const scores = await scoreWithJev('which port?', ['a'.repeat(MAX_EXCERPT + 500), 'b'], config, fetchImpl);
    expect(scores).toEqual([0.1, 0.9]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(JEV_URL);
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].init.body).not.toContain(KEY);
    const body = JSON.parse(calls[0].init.body);
    expect(Object.keys(body.questions)).toEqual(['c0', 'c1']);
    expect(body.questions.c0.type).toBe('noul');
    expect(body.questions.c0.instructions.excerpt).toHaveLength(MAX_EXCERPT);
    expect(body.state.question).toBe('which port?');
    expect(body.state.notice).toMatch(/untrusted/);
  });

  it('gives up on an error status, a thrown fetch, or fewer than half usable answers', async () => {
    expect(await scoreWithJev('q', ['a'], config, async () => ({ ok: false, json: async () => ({}) }))).toBeUndefined();
    expect(await scoreWithJev('q', ['a'], config, async () => { throw new Error('network'); })).toBeUndefined();
    const sparse = async () => ({ ok: true, json: async () => ({ answers: { c0: { noul: 0.7 }, c1: { noul: 'high' }, c2: { noul: 3 } } }) });
    expect(await scoreWithJev('q', ['a', 'b', 'c'], config, sparse)).toBeUndefined();
    expect(await scoreWithJev('q', ['a'], undefined, sparse)).toBeUndefined();
  });

  it('orders by score, a missing score as 0.5, ties in search order', () => {
    expect(rerankOrder([0.2, undefined, 0.9, 0.2])).toEqual([2, 1, 0, 3]);
  });

  it('returns the 3 excerpts Jev ranks best, marked ranked=jev', () => withIndex(async (root) => {
    const asked: string[][] = [];
    const scoreJev = async (_q: string, texts: string[]) => { asked.push(texts); return texts.map((t) => (t.includes('7311') ? 0.95 : 0.05)); };
    const out = await recallToolAsync({ query: 'which port does the server listen on', session: SESSION }, { recallRoot: root, transcript: undefined, home: root, cwd: root, serverCwd: root, jev: config, scoreJev });
    expect(asked).toHaveLength(1);
    expect(asked[0].length).toBeGreaterThan(3);
    expect(asked[0]).toContain(TEXTS[TEXTS.length - 1]);
    expect(out.ranked).toBe('jev');
    expect(out.hits).toHaveLength(3);
    expect(out.hits[0].text).toContain('7311');
    // The status file printed twice with different tails shares its first 300 characters: it takes one slot.
    expect(out.hits.filter((h: { text: string }) => h.text.startsWith('Status file.'))).toHaveLength(1);
    expect(out.hits.filter((h: { text: string }) => h.text.includes('7311'))).toHaveLength(2);
    expect(JSON.stringify(out)).not.toContain(KEY);
    const two = await recallToolAsync({ query: 'which port does the server listen on', session: SESSION, k: 2 }, { recallRoot: root, home: root, cwd: root, serverCwd: root, jev: config, scoreJev });
    expect(two.hits).toHaveLength(2);
  }));

  it('falls back to the plain search when Jev is off or fails', () => withIndex(async (root) => {
    const args = { query: 'which port does the server listen on', session: SESSION };
    const plain = recallTool(args, { recallRoot: root, home: root });
    expect(await recallToolAsync(args, { recallRoot: root, home: root, jev: undefined })).toEqual(plain);
    const failed = await recallToolAsync(args, { recallRoot: root, home: root, cwd: root, serverCwd: root, jev: config, scoreJev: async () => undefined });
    expect(failed.ranked).toBeUndefined();
    expect(failed.hits.map((h: { text: string }) => h.text)).toEqual(plain.hits.map((h: { text: string }) => h.text));
    // `around` never goes to Jev.
    let called = false;
    const around = await recallToolAsync({ around: plain.hits[0].ref, session: SESSION }, { recallRoot: root, home: root, jev: config, scoreJev: async () => { called = true; return []; } });
    expect(called).toBe(false);
    expect(around.around).toBe(plain.hits[0].ref);
  }));

  it('passes the key and Jev options to the server explicitly, since Claude Code strips *KEY* variables from MCP servers', () => {
    const mcp = JSON.parse(readFileSync(fileURLToPath(new URL('../.mcp.json', import.meta.url)), 'utf8'));
    const env = mcp.mcpServers['recall'].env;
    expect(env.TYPESAFE_API_KEY).toBe('${TYPESAFE_API_KEY:-}');
    expect(env.EXO_JEV_ENABLED).toBe('${user_config.jevEnabled}');
    expect(env.EXO_JEV_DENY_LIST).toBe('${user_config.jevDenyList}');
    expect(env.EXO_JEV_MODEL).toBe('${user_config.jevModel}');
  });

  it('loads search_session with the turn-1 prompt instead of deferring it behind tool search', () => {
    const mcp = JSON.parse(readFileSync(fileURLToPath(new URL('../.mcp.json', import.meta.url)), 'utf8'));
    expect(mcp.mcpServers['recall'].alwaysLoad).toBe(true);
  });
});

/**
 * #29: the hook gates every Jev call on jevEgressAllowed (the walk from the working directory is on, the working
 * directory and the session root pass the deny list); the search ranking applies the same rule. The session's
 * working directory is the last `cwd` its transcript records; the session root is the server's own directory.
 */
describe('Jev reranking follows the hook egress rule (#29)', () => {
  const args = { query: 'which port does the server listen on', session: SESSION };
  function setup(build: (dirs: { home: string; project: string; work: string }) => void) {
    const base = mkdtempSync(path.join(os.tmpdir(), 's4-recall-egress-'));
    const home = path.join(base, 'home'), project = path.join(home, 'work', 'project'), work = path.join(project, 'sub');
    mkdirSync(work, { recursive: true });
    makeIndex(base, TEXTS);
    build({ home, project, work });
    return { base, home, project, work };
  }
  function transcriptAt(base: string, cwd: string | undefined, start = '/somewhere/else') {
    const file = path.join(base, 'session.jsonl');
    writeFileSync(file, [
      JSON.stringify({ type: 'user', sessionId: SESSION, cwd: start, message: { role: 'user', content: 'hi '.repeat(1000) } }),
      JSON.stringify({ type: 'assistant', sessionId: SESSION, cwd, message: { role: 'assistant', content: 'ok' } }),
    ].join('\n') + '\n');
    return file;
  }
  async function ranked(dirs: { base: string; home: string; work: string }, jev: object, cwd = dirs.work, extra: Record<string, unknown> = { home: dirs.home, transcript: transcriptAt(dirs.base, cwd) }) {
    let called = false;
    const out = await recallToolAsync(args, { recallRoot: dirs.base, serverCwd: dirs.base, env: {}, ...extra, jev, scoreJev: async (_q: string, texts: string[]) => { called = true; return texts.map(() => 0.5); } });
    rmSync(dirs.base, { recursive: true, force: true });
    return { called, out };
  }

  it('ranks with Jev when the session working directory is enabled and passes the deny list', async () => {
    const dirs = setup(() => {});
    expect((await ranked(dirs, { ...config, denyList: ['client-a'] })).called).toBe(true);
  });

  it('skips Jev when the project of the session working directory opted out', async () => {
    const dirs = setup(({ project }) => { mkdirSync(path.join(project, '.exovault')); writeFileSync(path.join(project, '.exovault', 's4-compact-off'), ''); });
    const { called, out } = await ranked(dirs, config);
    expect(called).toBe(false);
    expect(out.ranked).toBeUndefined();
  });

  it('skips Jev when the home directory opted out and no marker sits on the walk', async () => {
    const dirs = setup(({ home }) => { mkdirSync(path.join(home, '.exovault')); writeFileSync(path.join(home, '.exovault', 's4-compact-off'), ''); });
    // The working directory lies outside the home directory, so only the home fallback can see the opt-out.
    const outside = path.join(dirs.base, 'outside');
    mkdirSync(outside);
    expect((await ranked(dirs, config, outside)).called).toBe(false);
  });

  it('ranks with Jev outside the home directory when nothing opted out', async () => {
    const dirs = setup(() => {});
    const outside = path.join(dirs.base, 'outside');
    mkdirSync(outside);
    expect((await ranked(dirs, config, outside)).called).toBe(true);
  });

  it('skips Jev when the session transcript is missing, since its working directory is unknown', async () => {
    const dirs = setup(() => {});
    const projects = path.join(dirs.base, 'projects');
    mkdirSync(projects);
    expect((await ranked(dirs, config, dirs.work, { home: dirs.home, projectsRoot: projects })).called).toBe(false);
  });

  it('skips Jev when the transcript records no working directory', async () => {
    const dirs = setup(() => {});
    const file = path.join(dirs.base, 'session.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'user', sessionId: SESSION, message: { role: 'user', content: 'hi '.repeat(1000) } }) + '\n');
    expect((await ranked(dirs, config, dirs.work, { home: dirs.home, transcript: file })).called).toBe(false);
  });

  it('skips Jev when the directory the session started in is on the deny list', async () => {
    const dirs = setup(() => {});
    expect((await ranked(dirs, { ...config, denyList: ['client-a'] }, dirs.work, { home: dirs.home, transcript: transcriptAt(dirs.base, dirs.work, '/srv/client-a') })).called).toBe(false);
  });

  it('skips Jev when the project the session started in opted out, though it works outside it now', async () => {
    const dirs = setup(({ project }) => { mkdirSync(path.join(project, '.exovault')); writeFileSync(path.join(project, '.exovault', 's4-compact-off'), ''); });
    const outside = path.join(dirs.base, 'outside');
    mkdirSync(outside);
    expect((await ranked(dirs, config, outside, { home: dirs.home, transcript: transcriptAt(dirs.base, outside, dirs.project) })).called).toBe(false);
  });

  it('skips Jev when CLAUDE_PROJECT_DIR is on the deny list', async () => {
    const dirs = setup(() => {});
    expect((await ranked(dirs, { ...config, denyList: ['client-a'] }, dirs.work, { home: dirs.home, transcript: transcriptAt(dirs.base, dirs.work), env: { CLAUDE_PROJECT_DIR: '/srv/client-a' } })).called).toBe(false);
  });

  it('skips Jev when no home directory resolves, as the hook does', async () => {
    const dirs = setup(() => {});
    const outside = path.join(dirs.base, 'outside');
    mkdirSync(outside);
    expect((await ranked(dirs, config, outside, { transcript: transcriptAt(dirs.base, outside) })).called).toBe(false);
  });

  it('a flag below the opt-out keeps Jev on, as in the hook walk', async () => {
    const dirs = setup(({ home, project }) => {
      mkdirSync(path.join(home, '.exovault')); writeFileSync(path.join(home, '.exovault', 's4-compact-off'), '');
      mkdirSync(path.join(project, '.exovault')); writeFileSync(path.join(project, '.exovault', 's4-compact-active'), '');
    });
    expect((await ranked(dirs, config)).called).toBe(true);
  });

  it('skips Jev when the session working directory is on the deny list, though the server directory passes', async () => {
    const dirs = setup(() => {});
    expect((await ranked(dirs, { ...config, denyList: ['project/sub'] })).called).toBe(false);
  });

  it('jevConfig carries the deny list it checked the server directory against', () => {
    expect(jevConfig({ TYPESAFE_API_KEY: KEY, EXO_JEV_ENABLED: 'true', EXO_JEV_DENY_LIST: 'client-a, client-b' }, '/w/p')?.denyList).toEqual(['client-a', 'client-b']);
  });
});
