import { LEGACY_OPTIONS } from './fixtures/helpers.js';
import { describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_PUSH_FILE, parseSessionPush, renderSessionPush } from '../core/session-push.js';
import { SESSION_PUSH_MAX_CHARS, sessionPush } from '../recall/session-push.mjs';
import { PUSH_POINTER, PUSH_STATE_FILE, startPushServer } from '../recall/push-server.mjs';
import { generationKey, readPublished } from '../recall/recall.mjs';
import { prepare, terms } from '../recall/rank.mjs';
import { hash } from '../recall/shared.mjs';
import { sha256 } from '../host/sha256.js';

const recallDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'recall');
const SID = '00000000-0000-4000-8000-00000000e5a1';

/** A transcript of turns (a prompt and an ACK), with a compact_boundary before each turn index in `cuts`. */
function indexed(turns: string[], cuts: number[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'session-push-'));
  const rows: string[] = [];
  let parent: string | null = null, n = 0;
  const row = (type: string, content: unknown) => { const uuid = `u${++n}`; rows.push(JSON.stringify({ parentUuid: parent, type, uuid, sessionId: SID, message: { role: type, content } })); parent = uuid; };
  turns.forEach((text, i) => {
    if (cuts.includes(i)) rows.push(JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: `b${i}`, parentUuid: parent, sessionId: SID }));
    row('user', text);
    row('assistant', [{ type: 'text', text: `ACK ${i}` }]);
  });
  const transcript = path.join(dir, `${SID}.jsonl`);
  writeFileSync(transcript, rows.join('\n') + '\n');
  execFileSync(process.execPath, [path.join(recallDir, 'build-worker.mjs'), transcript, path.join(dir, 'recall'), SID, String(statSync(transcript).size), dir, 'lexical', 'cut']);
  return path.join(dir, 'recall');
}

// Distinct per turn, so no two filler rows are near-duplicates (search keeps one of a near-duplicate pair).
const WORDS = ['amber', 'basalt', 'cedar', 'delta', 'ember', 'falcon', 'garnet', 'harbor', 'indigo', 'juniper', 'kestrel'];
const filler = (i: number) => `Turn ${i}: ${WORDS[i]} ${WORDS[(i + 3) % 11]} ${WORDS[(i + 7) % 11]} owners checked. The billing service logs look normal today.`;
const TURNS = [
  'Note: the staging database for ledger is pg-745a.',
  'Note: the auth incident ticket is OPS-5744.',
  ...Array.from({ length: 6 }, (_, i) => filler(i + 2)),
  'Note: the payouts canary runs in zone eu-west-4c.',
  filler(9),
];

describe('3.42.0 (S4zn) session push search', () => {
  it('pushes nothing before the first cut', () => {
    expect(sessionPush(indexed(TURNS, []), SID, 'What is OPS-5744 about?')).toBeUndefined();
  });

  it('returns the compacted-away line for a rare id or two rare words, only the matching line, with its segment', () => {
    const root = indexed(TURNS, [4]);
    const byId = sessionPush(root, SID, 'Is pg-745a still the staging database?')!;
    expect(byId.cuts).toBe(1);
    expect(byId.lines).toEqual([expect.objectContaining({ segment: 0, text: 'Note: the staging database for ledger is pg-745a.' })]);
    expect(byId.text).toBe('[segment 0] Note: the staging database for ledger is pg-745a.');
    expect(sessionPush(root, SID, 'which incident ticket did auth get?')!.text).toContain('OPS-5744');
  });

  it('does not push lines still in context (after the newest cut), common words, or short lines', () => {
    const root = indexed(TURNS, [4]);
    expect(sessionPush(root, SID, 'which zone does the payouts canary run in?')).toBeUndefined();
    expect(sessionPush(root, SID, 'do the billing service logs look normal today?')).toBeUndefined();
    expect(sessionPush(root, SID, 'pg-745a?')).toBeUndefined();
  });

  it('a word in more than SESSION_PUSH_RARE earlier rows is not rare; a higher cap lets it fire', () => {
    const lanes = ['amber', 'basalt', 'cedar', 'delta', 'ember', 'falcon'].map((w, i) => `Shard ${w} moved ${i * 3 + 1} tenants to the canary deploy lane after review number ${i}.`);
    const root = indexed([...lanes, filler(1), filler(2)], [6]);
    expect(sessionPush(root, SID, 'which canary deploy lane got the tenants?')).toBeUndefined();
    expect(sessionPush(root, SID, 'which canary deploy lane got the tenants?', { rare: 8 })!.lines.length).toBeGreaterThan(0);
  });

  it('3.43.1: an asked-for id must be in the pushed line; earlier copies of the prompt and same-wording lines do not count', () => {
    // ctxbench s4p-rh343: a cut inside the quiz indexed earlier questions ("K119: GET K119 (the five-word value)"),
    // whose rare template words (and hyphenated "five-word", read as an id) took the slot of "SET K000 = ...".
    const root = indexed([
      'Key file: SET K000 = sable onyx zephyr tundra juniper',
      ...Array.from({ length: 4 }, (_, i) => filler(i + 1)),
      'K119: GET K119 (the five-word value)',
      'K000: GET K000 (the five-word value)',
      filler(6), filler(7),
    ], [8]);
    expect(sessionPush(root, SID, 'K000: GET K000 (the five-word value)')!.text).toBe('[segment 0] Key file: SET K000 = sable onyx zephyr tundra juniper');
  });

  it('skips lines already shown and stays under the character cap', () => {
    const root = indexed(TURNS, [4]);
    const first = sessionPush(root, SID, 'Is pg-745a still the staging database?')!;
    expect(sessionPush(root, SID, 'Is pg-745a still the staging database?', { shown: first.lines.map((l: { key: string }) => l.key) })).toBeUndefined();
    const many = sessionPush(indexed([...Array.from({ length: 30 }, (_, i) => `Note: key K${100 + i} = ${'value '.repeat(40)}`), filler(1)], [30]), SID,
      Array.from({ length: 12 }, (_, i) => `GET K${100 + i} please`).join('\n'))!;
    expect(many.text.length).toBeLessThanOrEqual(SESSION_PUSH_MAX_CHARS + 20 * many.lines.length);
    expect(many.lines.reduce((n: number, l: { text: string }) => n + l.text.length, 0)).toBeLessThanOrEqual(SESSION_PUSH_MAX_CHARS);
  });

  it('the CLI keeps shown lines in its state file until the next cut', () => {
    const root = indexed(TURNS, [4]);
    const state = path.join(mkdtempSync(path.join(os.tmpdir(), 'session-push-state-')), SESSION_PUSH_FILE);
    const run = (prompt: string) => JSON.parse(execFileSync(process.execPath, [path.join(recallDir, 'session-push.mjs'), root, SID, state], { input: JSON.stringify({ prompt }) }).toString());
    expect(run('Is pg-745a still the staging database?').lines).toHaveLength(1);
    expect(JSON.parse(readFileSync(state, 'utf8'))).toEqual({ cuts: 1, shown: [expect.any(String)] });
    expect(run('Is pg-745a still the staging database?')).toBeNull();
    writeFileSync(state, JSON.stringify({ cuts: 0, shown: JSON.parse(readFileSync(state, 'utf8')).shown }));
    expect(run('Is pg-745a still the staging database?').lines).toHaveLength(1);
  });
});

describe('3.42.0 (S4zn) note and hook', () => {
  it('parses the script output and rejects empty or broken output', () => {
    expect(parseSessionPush(JSON.stringify({ cuts: 2, lines: [{ segment: 0, text: 'x' }], text: '[segment 0] x' }))?.cuts).toBe(2);
    for (const bad of ['null', '{', JSON.stringify({ cuts: 1, lines: [], text: '' })]) expect(parseSessionPush(bad)).toBeUndefined();
    // A 200 that parses but holds no real lines falls back like any other bad answer.
    for (const lines of [[null], [{ segment: 0 }], [{ text: 'x' }], ['x']]) expect(parseSessionPush(JSON.stringify({ cuts: 1, lines, text: 'unexpected content' }))).toBeUndefined();
  });

  it('says where the lines come from and that later lines override them', () => {
    const note = renderSessionPush({ cuts: 1, lines: [{ segment: 0, text: 'x' }], text: '[segment 0] x' });
    expect(note).toMatch(/removed from context by a compaction/);
    expect(note).toContain('\n[segment 0] x\n');
    expect(note).toMatch(/overrides an earlier line/);
  });

  type Handler = (host: unknown, event: unknown, next: (event?: unknown) => Promise<unknown>) => Promise<unknown>;
  const FOUND = JSON.stringify({ cuts: 1, lines: [{ segment: 0, text: 'Note: OPS-5744' }], text: '[segment 0] Note: OPS-5744' });
  type Fetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; socketPath?: string }) => Promise<{ status: number; ok: boolean; headers: Record<string, string>; text: string }>;
  async function promptHook(options: Record<string, unknown>, text: string, stdout = FOUND, server?: { pointer: string; fetch: Fetch; fireTimers?: boolean }) {
    const { register } = await import('../compact.js');
    const on: Record<string, Handler> = {};
    register(((name: string, fn: Handler) => { on[name] = fn; return { catch: (caught: unknown) => { (on as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS, recallPluginRoot: '/plugin', ...options } as never);
    const runs: { argv: string[]; stdin?: string }[] = [], logs: string[] = [], fetches: { url: string; init: Parameters<Fetch>[1] }[] = [];
    const pointerPath = `/home/u/.claude/exovault/recall/${sha256('s1')}/${PUSH_POINTER}`;
    const h = {
      session: { cwd: async () => '/tmp/project', id: async () => 's1', surfaces: async () => [] },
      fs: { exists: async (p: string) => p === '/tmp/project/.exovault/s4-compact-active' || (server !== undefined && p === pointerPath), read: async (p: string) => { if (server && p === pointerPath) return server.pointer; throw new Error('ENOENT'); }, write: async () => {}, list: async () => [] },
      env: { get: async (name: string) => (name === 'HOME' ? '/home/u' : undefined) },
      clock: { now: async () => 0, after: (_ms: number, fn: () => void) => { if (server?.fireTimers) queueMicrotask(fn); return { cancel: () => {} }; } },
      http: { fetch: async (url: string, init: Parameters<Fetch>[1]) => { fetches.push({ url, init }); if (!server) throw new Error('ENOENT'); return server.fetch(url, init); } },
      process: { run: async (argv: string[], init?: { stdin?: string }) => { runs.push({ argv, stdin: init?.stdin }); return { exitCode: 0, stdout, stderr: '' }; } },
      ui: { log: (line: string) => { logs.push(line); } },
    };
    let passed: { context?: string[] } = {};
    await on['prompt.submit']!(h, { text, origin: { kind: 'sdk' } }, async (e) => { passed = e as never; return e; });
    return { runs: runs.filter((r) => r.argv[1]?.endsWith('session-push.mjs')), logs, context: passed.context, fetches };
  }

  const POINTER = JSON.stringify({ socket: '/tmp/exo-recall-1/abc-1.sock', token: 't0k', pid: 1 });
  const answer = (text: string, status = 200) => async () => ({ status, ok: status === 200, headers: {}, text });

  async function realServerFixture() {
    const home = mkdtempSync(path.join(os.tmpdir(), 'session-push-home-'));
    const project = mkdtempSync(path.join(os.tmpdir(), 'session-push-project-'));
    const recallRoot = path.join(home, '.claude', 'exovault', 'recall');
    mkdirSync(path.dirname(recallRoot), { recursive: true });
    renameSync(indexed(TURNS, [4]), recallRoot);
    mkdirSync(path.join(project, '.exovault'), { recursive: true });
    writeFileSync(path.join(project, '.exovault', 's4-compact-active'), '');
    const statePath = path.join(project, '.exovault', 's4-capture', SID, SESSION_PUSH_FILE);
    mkdirSync(path.dirname(statePath), { recursive: true });
    const server = (await startPushServer({ recallRoot, sessionId: SID, socketDir: socketDir() }))!;
    return { home, project, recallRoot, statePath, server };
  }

  async function realPromptHook(home: string, project: string, runtime: { now?: () => Promise<number>; after?: (ms: number, fn: () => void) => { cancel: () => void } } = {}) {
    const { register } = await import('../compact.js');
    const on: Record<string, Handler> = {};
    register(((name: string, fn: Handler) => { on[name] = fn; return { catch: (caught: unknown) => { (on as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS, recallPluginRoot: '/plugin', recallEnabled: true } as never);
    const logs: string[] = [], fetches: Promise<{ status: number; ok: boolean; headers: Record<string, string>; text: string }>[] = [];
    const h = {
      session: { cwd: async () => project, root: async () => project, id: async () => SID, surfaces: async () => [] },
      fs: {
        exists: async (file: string) => existsSync(file),
        read: async (file: string) => readFileSync(file, 'utf8'),
        write: async (file: string, text: string) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); },
        list: async () => [],
      },
      env: { get: async (name: string) => name === 'HOME' ? home : undefined },
      clock: {
        now: runtime.now ?? (async () => Date.now()),
        after: runtime.after ?? ((ms: number, fn: () => void) => { const timer = setTimeout(fn, ms); return { cancel: () => clearTimeout(timer) }; }),
      },
      http: { fetch: async (url: string, init: Parameters<Fetch>[1]) => {
        const request = post(init.socketPath!, JSON.parse(init.body!), init.headers ?? {}).then(({ status, text }) => ({ status, ok: status >= 200 && status < 300, headers: {}, text }));
        fetches.push(request);
        return request;
      } },
      process: { run: async () => { throw new Error('unexpected CLI fallback'); } },
      ui: { log: (line: string) => { logs.push(line); } },
    };
    let passed: { context?: string[] } = {};
    await on['prompt.submit']!(h, { text: 'Is pg-745a still the staging database?', origin: { kind: 'sdk' } }, async (event) => { passed = event as never; return event; });
    return { logs, context: passed.context, fetches };
  }

  it('4.9.1: a slow clock read cannot make the server deadline outlast the hook timer', async () => {
    const fixture = await realServerFixture();
    try {
      const result = await realPromptHook(fixture.home, fixture.project, {
        now: async () => { await new Promise((resolve) => setTimeout(resolve, 1550)); return Date.now(); },
      });
      expect(result.context?.some((context) => context.includes('pg-745a'))).toBe(true);
      expect(result.logs[0]).toMatch(/session_push\.fired=1 lines=1 chars=\d+ cuts=1 via=server/);
      expect(JSON.parse(readFileSync(fixture.statePath, 'utf8'))).toEqual({ cuts: 1, shown: [expect.any(String)] });
    } finally { await fixture.server.close(); }
  });

  it('4.9.1: a timed-out server answer leaves the state file untouched', async () => {
    const fixture = await realServerFixture();
    try {
      const result = await realPromptHook(fixture.home, fixture.project, {
        after: (_ms, fn) => { queueMicrotask(fn); return { cancel: () => {} }; },
      });
      expect(result.context ?? []).toEqual([]);
      expect(result.logs).toContain('session_push.fired=0 via=server reason=timeout');
      await Promise.all(result.fetches);
      expect(existsSync(fixture.statePath)).toBe(false);
    } finally { await fixture.server.close(); }
  });

  it('4.8.2 (S5s): with a recall server for the session, the prompt goes to it over its socket and nothing is spawned', async () => {
    const r = await promptHook({ recallEnabled: true }, 'what was the auth ticket?', FOUND, { pointer: POINTER, fetch: answer(FOUND) });
    expect(r.runs).toHaveLength(0);
    expect(r.fetches).toHaveLength(1);
    expect(r.fetches[0]!.init).toMatchObject({ method: 'POST', socketPath: '/tmp/exo-recall-1/abc-1.sock', headers: { 'x-exo-token': 't0k' } });
    expect(JSON.parse(r.fetches[0]!.init.body!)).toEqual({ session: 's1', prompt: 'what was the auth ticket?', stateFile: expect.stringMatching(new RegExp(`/${SESSION_PUSH_FILE}$`)), deadline: 1300 });
    expect(r.context?.some((c) => c.includes('[segment 0] Note: OPS-5744'))).toBe(true);
    expect(r.logs).toContain('session_push.fired=1 lines=1 chars=26 cuts=1 via=server');
  });

  it('4.8.2 (S5s): a server answer of null adds nothing and spawns nothing', async () => {
    const r = await promptHook({ recallEnabled: true }, 'what was the auth ticket?', FOUND, { pointer: POINTER, fetch: answer('null') });
    expect(r.runs).toHaveLength(0);
    expect(r.context ?? []).toEqual([]);
    expect(r.logs).toContain('session_push.fired=0 via=server');
  });

  it('4.8.2 (S5s): a server that is gone, refuses, or sends a broken pointer falls back to session-push.mjs', async () => {
    const gone = await promptHook({ recallEnabled: true }, 'what was the auth ticket?', FOUND, { pointer: POINTER, fetch: async () => { throw new Error('ECONNREFUSED'); } });
    expect(gone.runs).toHaveLength(1);
    expect(gone.logs).toContain('session_push.fired=1 lines=1 chars=26 cuts=1 via=spawn');
    expect((await promptHook({ recallEnabled: true }, 'what was the auth ticket?', FOUND, { pointer: POINTER, fetch: answer('', 403) })).runs).toHaveLength(1);
    // A 200 whose lines are not lines is no answer either.
    const odd = await promptHook({ recallEnabled: true }, 'what was the auth ticket?', FOUND, { pointer: POINTER, fetch: answer('{"cuts":1,"text":"unexpected content","lines":[null]}') });
    expect(odd.runs).toHaveLength(1);
    expect(odd.logs).toContain('session_push.fired=1 lines=1 chars=26 cuts=1 via=spawn');
    const broken = await promptHook({ recallEnabled: true }, 'what was the auth ticket?', FOUND, { pointer: '{"socket":"relative.sock","token":"x"}', fetch: answer(FOUND) });
    expect(broken.fetches).toHaveLength(0);
    expect(broken.runs).toHaveLength(1);
  });

  it('4.8.2 (S5s): a server that does not answer in time is given up for this prompt, not raced by a second search', async () => {
    const r = await promptHook({ recallEnabled: true }, 'what was the auth ticket?', FOUND, { pointer: POINTER, fetch: () => new Promise(() => {}), fireTimers: true });
    expect(r.runs).toHaveLength(0);
    expect(r.context ?? []).toEqual([]);
    expect(r.logs).toContain('session_push.fired=0 via=server reason=timeout');
  });


  it('with sessionPush on, a prompt runs session-push.mjs and the lines go with it as context', async () => {
    const r = await promptHook({ recallEnabled: true, sessionPush: true }, 'what was the auth ticket?');
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]!.argv.at(-1)).toMatch(new RegExp(`/${SESSION_PUSH_FILE}$`));
    expect(JSON.parse(r.runs[0]!.stdin!)).toEqual({ prompt: 'what was the auth ticket?' });
    expect(r.context?.some((c) => c.includes('[segment 0] Note: OPS-5744'))).toBe(true);
    expect(r.logs).toContain('session_push.fired=1 lines=1 chars=26 cuts=1');
  });

  it('is on by default with recall (3.43.0), runs nothing when turned off or without recall, and adds nothing on null output', async () => {
    expect((await promptHook({ recallEnabled: true }, 'what was the auth ticket?')).runs).toHaveLength(1);
    expect((await promptHook({ recallEnabled: true, sessionPush: false }, 'what was the auth ticket?')).runs).toHaveLength(0);
    expect((await promptHook({ sessionPush: true }, 'what was the auth ticket?')).runs).toHaveLength(0);
    const none = await promptHook({ recallEnabled: true, sessionPush: true }, 'what was the auth ticket?', 'null');
    expect(none.runs).toHaveLength(1);
    expect(none.context ?? []).toEqual([]);
  });
});

/** POST to a push server's socket, as the hook's $.http.fetch does. */
function post(socketPath: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: '/session-push', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const socketDir = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'sp-')); chmodSync(dir, 0o700); return dir; };

describe.skipIf(process.platform === 'win32')('4.8.2 (S5s) the recall server answers session push', () => {
  it('answers with keys but leaves shown state to the hook; needs its token and its own session', async () => {
    const root = indexed(TURNS, [4]);
    const state = path.join(mkdtempSync(path.join(os.tmpdir(), 'session-push-state-')), SESSION_PUSH_FILE);
    const server = (await startPushServer({ recallRoot: root, sessionId: SID, socketDir: socketDir() }))!;
    expect(server).toBeTruthy();
    const pointerFile = path.join(root, hash(SID), PUSH_POINTER);
    const pointer = JSON.parse(readFileSync(pointerFile, 'utf8')) as { socket: string; token: string; pid: number };
    expect(pointer).toMatchObject({ socket: server.socket, pid: process.pid });
    expect(statSync(pointerFile).mode & 0o077).toBe(0);
    const ask = (extra: Record<string, unknown> = {}, token = pointer.token) => post(pointer.socket, { session: SID, prompt: 'Is pg-745a still the staging database?', stateFile: state, ...extra }, { 'x-exo-token': token });
    const first = await ask();
    expect(first.status).toBe(200);
    expect(JSON.parse(first.text).lines).toHaveLength(1);
    expect(JSON.parse(first.text).lines[0].key).toEqual(expect.any(String));
    expect(existsSync(state)).toBe(false);
    expect(JSON.parse((await ask()).text).lines).toHaveLength(1);
    expect((await ask({}, 'wrong')).status).toBe(403);
    expect((await ask({ session: 'someone-else' })).status).toBe(409);
    await server.close();
    expect(existsSync(pointer.socket)).toBe(false);
    expect(existsSync(pointerFile)).toBe(false);
  });

  it('an answer past the request deadline is null and does not mark its lines shown; the state file keeps its name', async () => {
    const root = indexed(TURNS, [4]);
    const state = path.join(mkdtempSync(path.join(os.tmpdir(), 'session-push-state-')), SESSION_PUSH_FILE);
    const server = (await startPushServer({ recallRoot: root, sessionId: SID, socketDir: socketDir() }))!;
    const pointer = JSON.parse(readFileSync(path.join(root, hash(SID), PUSH_POINTER), 'utf8')) as { socket: string; token: string };
    const ask = (extra: Record<string, unknown>) => post(pointer.socket, { session: SID, prompt: 'Is pg-745a still the staging database?', stateFile: state, ...extra }, { 'x-exo-token': pointer.token });
    try {
      expect(await ask({ deadline: Date.now() - 1 })).toEqual({ status: 200, text: 'null' });
      expect(existsSync(state)).toBe(false);
      expect(JSON.parse((await ask({ deadline: Date.now() + 60_000 })).text).lines).toHaveLength(1);
      expect((await ask({ stateFile: path.join(path.dirname(state), 'elsewhere.json') })).status).toBe(400);
      expect(PUSH_STATE_FILE).toBe(SESSION_PUSH_FILE);
    } finally { await server.close(); }
  });

  it('shares the prepared index with session search (one cache entry per index)', () => {
    const root = indexed(TURNS, [4]);
    const dir = path.join(root, hash(SID));
    const { manifest, rows } = readPublished(dir);
    // Session search prepared this generation first; a push must find that entry, here marked by making the asked
    // terms common.
    const prepared = prepare(rows, generationKey(dir, manifest.generation)) as { df: Map<string, number> };
    for (const term of terms('Is pg-745a still the staging database?')) prepared.df.set(term, 999);
    expect(sessionPush(root, SID, 'Is pg-745a still the staging database?')).toBeUndefined();
  });

  it('a server writes its pointer again when an older one took it over and removed it', async () => {
    const root = indexed(TURNS, [4]);
    const dir = socketDir();
    const pointerFile = path.join(root, hash(SID), PUSH_POINTER);
    const newer = (await startPushServer({ recallRoot: root, sessionId: SID, socketDir: dir, instance: 'b', reassertMs: 20 }))!;
    const older = (await startPushServer({ recallRoot: root, sessionId: SID, socketDir: dir, instance: 'a', reassertMs: 60_000 }))!;
    await older.close();
    for (let i = 0; i < 50 && !existsSync(pointerFile); i++) await new Promise((r) => setTimeout(r, 10));
    expect(JSON.parse(readFileSync(pointerFile, 'utf8')).socket).toBe(newer.socket);
    await newer.close();
  });

  it('a server that closes leaves the pointer a newer server of the session wrote', async () => {
    const root = indexed(TURNS, [4]);
    const dir = socketDir();
    const older = (await startPushServer({ recallRoot: root, sessionId: SID, socketDir: dir, instance: 'a' }))!;
    const newer = (await startPushServer({ recallRoot: root, sessionId: SID, socketDir: dir, instance: 'b' }))!;
    const pointerFile = path.join(root, hash(SID), PUSH_POINTER);
    await older.close();
    expect(JSON.parse(readFileSync(pointerFile, 'utf8')).socket).toBe(newer.socket);
    await newer.close();
    expect(existsSync(pointerFile)).toBe(false);
  });

  it('does not start in a socket directory others can enter, or where the socket path would be too long', async () => {
    const root = indexed(TURNS, [4]);
    const open = socketDir();
    chmodSync(open, 0o755);
    expect(await startPushServer({ recallRoot: root, sessionId: SID, socketDir: open })).toBeNull();
    const deep = path.join(socketDir(), 'x'.repeat(120));
    expect(await startPushServer({ recallRoot: root, sessionId: SID, socketDir: deep })).toBeNull();
    expect(existsSync(path.join(root, hash(SID), PUSH_POINTER))).toBe(false);
  });

  it('mcp-server.mjs starts it for CLAUDE_CODE_SESSION_ID and removes it when its stdin closes', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'sp-home-'));
    const tmp = socketDir();
    const child = spawn(process.execPath, [path.join(recallDir, 'mcp-server.mjs')], { env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, CLAUDE_CODE_SESSION_ID: SID }, stdio: ['pipe', 'pipe', 'pipe'] });
    const pointerFile = path.join(home, '.claude', 'exovault', 'recall', hash(SID), PUSH_POINTER);
    try {
      for (let i = 0; i < 100 && !existsSync(pointerFile); i++) await new Promise((r) => setTimeout(r, 50));
      const pointer = JSON.parse(readFileSync(pointerFile, 'utf8')) as { socket: string; token: string };
      expect(pointer.socket.startsWith(tmp)).toBe(true);
      const reply = await post(pointer.socket, { session: SID, prompt: 'anything about pg-745a here', stateFile: path.join(tmp, SESSION_PUSH_FILE) }, { 'x-exo-token': pointer.token });
      expect(reply).toEqual({ status: 200, text: 'null' });
      const exited = new Promise((r) => child.on('exit', r));
      child.stdin.end();
      await exited;
      expect(existsSync(pointerFile)).toBe(false);
      expect(existsSync(pointer.socket)).toBe(false);
    } finally { child.kill(); }
  });
});
