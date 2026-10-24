import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { register } from '../compact.js';
import { findCaptureRoot as findCompactRoot, isCaptureEnabled as compactEnabled } from '../host/capture-flag.js';
import { findCaptureRoot as findTriggerRoot, isCaptureEnabled as triggerEnabled } from '../../compact-trigger/host/capture-flag.js';
import { assistantCall, assistantText, fakeHost, humanPrompt, toolResultsMessage, withStrippedRuntimeGlobals } from './fixtures/helpers.js';
import type { FakeHost } from './fixtures/helpers.js';
import { LEGACY_OPTIONS } from './fixtures/helpers.js';
import type { SessionMessage } from '../core/types.js';

type Handler = (host: unknown, event: unknown, next: (event?: unknown) => Promise<unknown>) => Promise<unknown>;
type RootSpec = string | 'absent' | 'throw' | 'reject' | 'empty' | 'nonstring';

interface FlagProbe {
  cwd: () => Promise<string>;
  exists: (path: string) => Promise<boolean>;
  root?: () => Promise<string>;
  home: () => Promise<string | undefined>;
}

interface Row {
  id: string;
  cwd: string;
  root: RootSpec;
  active: string[];
  off?: string[];
  expected: string | null;
}

const HOME = '/home/h';

const copies = [
  { name: 'plugin/compact/host/capture-flag.ts', findCaptureRoot: findCompactRoot, isCaptureEnabled: compactEnabled },
  { name: 'plugin/compact-trigger/host/capture-flag.ts', findCaptureRoot: findTriggerRoot, isCaptureEnabled: triggerEnabled },
];

const rows: Row[] = [
  { id: 'A1', cwd: '/tmp/wt', root: '/proj', active: ['/proj'], expected: '/proj' },
  { id: 'A2', cwd: '/tmp/wt/deep', root: '/proj/pkg', active: ['/proj'], expected: '/proj' },
  { id: 'A3', cwd: '/proj/sub', root: '/elsewhere', active: ['/proj'], expected: '/proj' },
  { id: 'A4', cwd: '/a/x', root: '/b', active: ['/a', '/b'], expected: '/b' },
  { id: 'A5', cwd: '/home/u/on', root: '/home/u/q', active: ['/home/u/on'], off: ['/home/u/q'], expected: null },
  { id: 'A6', cwd: '/home/u/q', root: '/proj', active: ['/proj'], off: ['/home/u/q'], expected: null },
  // 4.8.0: installed means enabled, so a walk that finds no marker at all lands on the home directory instead of off.
  { id: 'A7', cwd: '/tmp/wt', root: '/proj', active: [], expected: HOME },
  { id: 'A8', cwd: '/proj', root: 'absent', active: ['/proj'], expected: '/proj' },
  { id: 'A9', cwd: '/tmp/wt', root: 'absent', active: ['/proj'], expected: HOME },
  { id: 'A11', cwd: '/tmp/wt', root: 'reject', active: ['/proj'], expected: HOME },
  { id: 'A12', cwd: 'C:\\tmp\\wt', root: 'C:\\proj', active: ['C:\\proj'], expected: 'C:\\proj' },
  // 4.8.0 one-project setup (README): opt-out in the home directory, flag in the project. A shell cd elsewhere under the
  // home directory keeps the session on, because the flagged session root sits below that opt-out.
  { id: 'A13', cwd: '/home/u/work', root: '/home/u/work/proj', active: ['/home/u/work/proj'], off: ['/home/u'], expected: '/home/u/work/proj' },
  { id: 'A14', cwd: '/home/u/work/proj-wt/src', root: '/home/u/work/proj', active: ['/home/u/work/proj'], off: ['/home/u'], expected: '/home/u/work/proj' },
  { id: 'A15', cwd: 'C:\\Users\\u\\work', root: 'c:/Users/u/work/proj', active: ['c:/Users/u/work/proj'], off: ['C:\\Users\\u'], expected: 'c:/Users/u/work/proj' },
  { id: 'A19', cwd: '\\\\fileserv\\share\\u\\work', root: '\\\\FILESERV\\share\\u\\work\\proj', active: ['\\\\FILESERV\\share\\u\\work\\proj'], off: ['\\\\fileserv\\share\\u'], expected: '\\\\FILESERV\\share\\u\\work\\proj' },
  // A nearer opt-out that does not cover the session root stays final (A6 too).
  { id: 'A16', cwd: '/home/u/private/x', root: '/home/u/work/proj', active: ['/home/u/work/proj'], off: ['/home/u', '/home/u/private'], expected: null },
  { id: 'A17', cwd: '/home/u/work/proj/vendor', root: '/home/u/work/proj', active: ['/home/u/work/proj'], off: ['/home/u/work/proj/vendor'], expected: null },
  { id: 'A18', cwd: '/home/u/work', root: '/home/u/work-other', active: ['/home/u/work-other'], off: ['/home/u/work'], expected: null },
];

function markerFile(dir: string, leaf: 's4-compact-active' | 's4-compact-off'): string {
  const separator = /[\\/]$/.test(dir) ? '' : '/';
  return `${dir}${separator}.exovault/${leaf}`;
}

function rootFn(root: RootSpec): (() => Promise<string>) | undefined {
  if (root === 'absent') return undefined;
  if (root === 'throw') return () => { throw new Error('root threw'); };
  if (root === 'reject') return async () => { throw new Error('root rejected'); };
  if (root === 'empty') return async () => '';
  if (root === 'nonstring') return async () => 7 as unknown as string;
  return async () => root;
}

function flagProbe(row: Pick<Row, 'cwd' | 'root' | 'active' | 'off'>): FlagProbe {
  const active = new Set(row.active.map((dir) => markerFile(dir, 's4-compact-active')));
  const off = new Set((row.off ?? []).map((dir) => markerFile(dir, 's4-compact-off')));
  const host: FlagProbe = {
    cwd: async () => row.cwd,
    exists: async (file) => active.has(file) || off.has(file),
    home: async () => HOME,
  };
  const root = rootFn(row.root);
  if (root) host.root = root;
  return host;
}

for (const copy of copies) {
  describe(copy.name, () => {
    for (const row of rows) {
      it(`${row.id} findCaptureRoot`, async () => {
        const host = flagProbe(row);
        expect(await copy.findCaptureRoot(host), row.id).toBe(row.expected);
        if (row.id === 'A1') expect(await copy.isCaptureEnabled(host), 'A1 isCaptureEnabled').toBe(true);
        if (row.id === 'A5') expect(await copy.isCaptureEnabled(host), 'A5 isCaptureEnabled').toBe(false);
      });
    }

    it('A10 unusable root keeps the cwd walk and does not throw', async () => {
      for (const root of ['throw', 'reject', 'empty', 'nonstring'] as const) {
        const host = flagProbe({ cwd: '/proj', root, active: ['/proj'] });
        expect(await copy.findCaptureRoot(host), `A10 ${root}`).toBe('/proj');
      }
    });
  });
}

const REASONING = 'Chose Postgres over Mongo because of relational constraints.';
const SEGMENT = `${JSON.stringify({ kind: 'assistant_text', origin: 'reconcile', producedBy: 's4-capture', sourceHash: 'fixture-hash', body: { text: REASONING } })}\n`;
const DENSE_SEGMENT = `${[
  { kind: 'tool_activity', origin: 'reconcile', producedBy: 's4-capture', sourceHash: 'alpha', body: { text: 'Ran node --test on src/alpha-feature.ts with --alpha-mode at 8142ms' } },
  { kind: 'tool_activity', origin: 'reconcile', producedBy: 's4-capture', sourceHash: 'bravo', body: { text: 'Ran node --test on src/bravo-feature.ts with --bravo-mode at 9153ms' } },
].map((record) => JSON.stringify(record)).join('\n')}\n`;
const CARD = '# Task card\n## Rules\n- Stay under 12 lines';
const LABEL_PROMPT = { text: 'Typed request marker S4N_PRIVATE_93817', origin: { kind: 'composer' } };

function bulkyToolConversation(): SessionMessage[] {
  const old: SessionMessage[] = [];
  for (let i = 0; i < 40; i += 1) {
    old.push(assistantCall('Read', { input: { file: `f${i}.ts` } }));
    old.push(toolResultsMessage([{ toolUseId: (old.at(-1) as SessionMessage).toolUses[0].tool_use_id, options: { text: 'line '.repeat(400) } }]));
  }
  return [...old, humanPrompt('what is the status now'), assistantText('all good, wrapping up')];
}

function openHandlers(options: Record<string, unknown> = {}): Record<string, Handler> {
  const on: Record<string, Handler> = {};
  register(((name: string, fn: Handler) => { on[name] = fn; return { catch: (caught: unknown) => { (on as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS, ...options } as never);
  return on;
}

function labelFetch() {
  return vi.fn(async () => ({
    status: 200,
    ok: true,
    text: JSON.stringify({
      model: 'jev-1.13.0',
      answers: { label: { type: 'choice', choice: 'instruction', probabilities: { instruction: 0.8, question: 0.05, consent: 0.05, information: 0.05, chat: 0.05 } } },
    }),
  }));
}

function denseFetch() {
  return vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { questions?: Record<string, { instructions?: { note?: string } }> };
    const answers = Object.fromEntries(Object.entries(body.questions ?? {}).map(([id, raw]) => {
      const note = raw?.instructions?.note ?? '';
      return [id, { type: 'noul', noul: note.includes('src/alpha-feature.ts') ? 0.05 : 0.9 }];
    }));
    return { status: 200, ok: true, text: JSON.stringify({ model: 'jev-latest', answers, usage: { input_tokens: 123 } }) };
  });
}

function cardFiles(dirs: readonly string[], sessionId = 's1'): Map<string, string> {
  const files = new Map<string, string>();
  for (const dir of dirs) files.set(`${dir}/.exovault/s4-capture/${sessionId}/task-card.md`, CARD);
  return files;
}

function jevHost(spec: {
  cwd: string;
  root?: string | 'reject';
  active: string[];
  off?: string[];
  segment?: string;
  files?: Map<string, string>;
  fetch: ReturnType<typeof vi.fn>;
  messages?: () => Promise<unknown[]>;
  env?: Record<string, string | undefined>;
}) {
  const files = spec.files ?? new Map<string, string>();
  const active = new Set(spec.active.map((dir) => markerFile(dir, 's4-compact-active')));
  const off = new Set((spec.off ?? []).map((dir) => markerFile(dir, 's4-compact-off')));
  const lines: string[] = [];
  const writes: string[] = [];
  const runs: { argv: readonly string[] }[] = [];
  const base = fakeHost({
    fsExists: async (file) => active.has(file) || off.has(file) || files.has(file),
    fsRead: async (file) => {
      if (files.has(file)) return files.get(file) ?? '';
      if (spec.segment !== undefined && file.endsWith('segment-000001.json')) return spec.segment;
      throw new Error(`ENOENT ${file}`);
    },
    fsWrite: async (file, text) => { files.set(file, text); writes.push(file); },
    fsList: async () => (spec.segment !== undefined ? [{ name: 'segment-000001.json', kind: 'file', size: spec.segment.length }] : []),
    uiLog: (line: string) => { lines.push(line); },
    httpFetch: spec.fetch as FakeHost['http']['fetch'],
    processRun: async (argv) => { runs.push({ argv }); return { exitCode: 0, stdout: '', stderr: '' }; },
    sessionCwd: async () => spec.cwd,
    sessionId: async () => 's1',
    sessionMessages: (spec.messages ?? (async () => [{ role: 'user', text: 'turn', toolUses: [] }])) as FakeHost['session']['messages'],
    envGet: async (name) => spec.env ? spec.env[name] : name === 'TYPESAFE_API_KEY' ? 'test-api-key-never-log' : undefined,
  });
  const session: FakeHost['session'] & { root?: () => Promise<string> } = { ...base.session, cwd: async () => spec.cwd, id: async () => 's1' };
  if (spec.root === 'reject') session.root = async () => { throw new Error('root rejected'); };
  else if (spec.root) session.root = async () => spec.root as string;
  return { host: { ...base, session }, lines, writes, runs };
}

function ruleStarts(runs: { argv: readonly string[] }[]): { argv: readonly string[] }[] {
  return runs.filter((run) => run.argv.some((arg) => String(arg).includes('rule-check.mjs')));
}

async function flushBackground(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

async function submitPrompt(host: unknown, options: Record<string, unknown> = {}): Promise<void> {
  const on = openHandlers({ jevEnabled: true, ...options });
  await withStrippedRuntimeGlobals(() => on['prompt.submit'](host, LABEL_PROMPT, async (input) => input));
  await flushBackground();
}

async function compactSession(host: unknown, options: Record<string, unknown>, messages: unknown) {
  const on = openHandlers({ denseNotes: false, totalBudgetTokens: 13000, contract: 'the contract', ...options });
  const next = vi.fn(async () => ({ native: true }));
  const result = await withStrippedRuntimeGlobals(() => on['session.compact'](host, { trigger: 'auto', messages }, next));
  return { result, next };
}

async function completeTurn(host: unknown): Promise<unknown> {
  const on = openHandlers({ taskCard: false });
  return withStrippedRuntimeGlobals(() => on['turn.complete'](host, { reason: 'answer' }, async () => ({ turn: true })));
}

async function stopTurn(host: unknown, options: Record<string, unknown>): Promise<unknown> {
  const on = openHandlers({ taskCard: true, ruleCheck: true, recallPluginRoot: '/plugin', ...options });
  return withStrippedRuntimeGlobals(() => on['classic.Stop'](host, { stop_hook_active: false, last_assistant_message: 'SLICE done' }, async () => ({})));
}

describe('session root handlers', () => {
  it('B1 turn.complete writes under the session root', async () => {
    const built = jevHost({ cwd: '/tmp/wt', root: '/proj', active: ['/proj'], fetch: vi.fn() });
    await completeTurn(built.host);
    expect(built.writes.length, 'B1 turn.complete must write a capture record').toBeGreaterThan(0);
    expect(built.writes.every((file) => file.startsWith('/proj/.exovault/s4-capture/s1/') || file === '/proj/.exovault/.gitignore'), built.writes.join('\n')).toBe(true);
  });

  it('B2 session.compact stands on the plugin when the shell is outside the project', async () => {
    const built = jevHost({ cwd: '/tmp/wt', root: '/proj', active: ['/proj'], fetch: vi.fn(), segment: SEGMENT });
    const { result, next } = await compactSession(built.host, {}, bulkyToolConversation());
    expect(built.lines.join('\n'), 'B2 must not log compact.fallback=not_enabled').not.toContain('compact.fallback=not_enabled');
    expect(next, 'B2 must not take the native fallback').not.toHaveBeenCalled();
    expect((result as { messages?: { text?: string }[] }).messages?.[0]?.text).toContain(REASONING);
  });

  it('B4 turn.complete writes nothing when the root carries the opt-out', async () => {
    const built = jevHost({ cwd: '/tmp/wt', root: '/proj', active: ['/tmp/wt'], off: ['/proj'], fetch: vi.fn() });
    await completeTurn(built.host);
    expect(built.writes, 'B4 turn.complete must write nothing').toEqual([]);
  });

  it('B4 session.compact logs not_enabled when the root carries the opt-out', async () => {
    const built = jevHost({ cwd: '/tmp/wt', root: '/proj', active: ['/tmp/wt'], off: ['/proj'], fetch: vi.fn(), segment: SEGMENT });
    await compactSession(built.host, {}, bulkyToolConversation());
    expect(built.lines.join('\n'), 'B4 session.compact must log compact.fallback=not_enabled').toContain('compact.fallback=not_enabled');
  });

  it('B5 control writes nothing and logs not_enabled when no marker exists', async () => {
    const built = jevHost({ cwd: '/tmp/wt', root: '/proj', active: [], fetch: vi.fn() });
    await completeTurn(built.host);
    const { result, next } = await compactSession(built.host, {}, []);
    expect(built.writes).toEqual([]);
    expect(next).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ native: true });
    expect(built.lines.join('\n')).toContain('compact.fallback=not_enabled');
  });

  it('B6 control keeps the plugin path when session.root is absent', async () => {
    const built = jevHost({ cwd: '/proj', active: ['/proj'], fetch: vi.fn(), segment: SEGMENT });
    await completeTurn(built.host);
    expect(built.writes.some((file) => file.startsWith('/proj/.exovault/s4-capture/s1/')), built.writes.join('\n')).toBe(true);
    const mark = built.lines.length;
    const { next } = await compactSession(built.host, {}, bulkyToolConversation());
    const compactLines = built.lines.slice(mark).join('\n');
    expect(compactLines).not.toContain('compact.fallback=error');
    expect(compactLines).not.toContain('compact.fallback=not_enabled');
    expect(next).not.toHaveBeenCalled();
  });

  it('B6 control keeps the plugin path when session.root rejects', async () => {
    const built = jevHost({ cwd: '/proj', root: 'reject', active: ['/proj'], fetch: vi.fn(), segment: SEGMENT });
    await completeTurn(built.host);
    expect(built.writes.some((file) => file.startsWith('/proj/.exovault/s4-capture/s1/')), built.writes.join('\n')).toBe(true);
    const mark = built.lines.length;
    const { next } = await compactSession(built.host, {}, bulkyToolConversation());
    const compactLines = built.lines.slice(mark).join('\n');
    expect(compactLines).not.toContain('compact.fallback=error');
    expect(compactLines).not.toContain('compact.fallback=not_enabled');
    expect(next).not.toHaveBeenCalled();
  });

  it('B7 control writes nothing and logs not_enabled when the shell carries the opt-out', async () => {
    const built = jevHost({ cwd: '/home/u/q', root: '/proj', active: ['/proj'], off: ['/home/u/q'], fetch: vi.fn() });
    await completeTurn(built.host);
    await compactSession(built.host, {}, []);
    expect(built.writes).toEqual([]);
    expect(built.lines.join('\n')).toContain('compact.fallback=not_enabled');
  });
});

describe('session root keeps Jev on the working directory', () => {
  const ownJevUrl = 'http://127.0.0.1:8080/v1/systemone';
  const ownJevEnv = { EXO_JEV_URL: ownJevUrl };

  it('C0 control prompt.submit fetches when cwd and root are the flagged project', async () => {
    const fetch = labelFetch();
    const built = jevHost({ cwd: '/proj', root: '/proj', active: ['/proj'], fetch });
    await submitPrompt(built.host, {});
    expect(fetch, 'C0 prompt.submit must fetch').toHaveBeenCalled();
  });

  it('C0 control session.compact dense rerank fetches when cwd and root are the flagged project', async () => {
    const fetch = denseFetch();
    const built = jevHost({ cwd: '/proj', root: '/proj', active: ['/proj'], fetch, segment: DENSE_SEGMENT });
    await compactSession(built.host, { denseNotes: true, jevEnabled: true }, bulkyToolConversation());
    expect(fetch, 'C0 dense rerank must fetch').toHaveBeenCalled();
  });

  it('C0 control session.compact selector J fetches when cwd and root are the flagged project', async () => {
    const fetch = denseFetch();
    const built = jevHost({ cwd: '/proj', root: '/proj', active: ['/proj'], fetch, segment: SEGMENT });
    await compactSession(built.host, { jevEnabled: true }, bulkyToolConversation());
    expect(fetch, 'C0 selector J must fetch').toHaveBeenCalled();
  });

  it('C0 control rule-check starts when cwd and root are the flagged project', async () => {
    const fetch = vi.fn();
    const built = jevHost({ cwd: '/proj', root: '/proj', active: ['/proj'], fetch, files: cardFiles(['/proj']) });
    await stopTurn(built.host, {});
    expect(ruleStarts(built.runs), 'C0 rule-check.mjs must start once').toHaveLength(1);
  });

  it('C1 guard makes no fetch and does not start rule-check when the shell is outside the project', async () => {
    const fetch = denseFetch();
    const prompt = jevHost({ cwd: '/tmp/wt', root: '/proj', active: ['/proj'], fetch });
    await submitPrompt(prompt.host, {});
    const dense = jevHost({ cwd: '/tmp/wt', root: '/proj', active: ['/proj'], fetch, segment: DENSE_SEGMENT });
    await compactSession(dense.host, { denseNotes: true, jevEnabled: true }, bulkyToolConversation());
    const selector = jevHost({ cwd: '/tmp/wt', root: '/proj', active: ['/proj'], fetch, segment: SEGMENT });
    await compactSession(selector.host, { jevEnabled: true }, bulkyToolConversation());
    const turn = jevHost({ cwd: '/tmp/wt', root: '/proj', active: ['/proj'], fetch });
    await completeTurn(turn.host);
    const stop = jevHost({ cwd: '/tmp/wt', root: '/proj', active: ['/proj'], fetch, files: cardFiles(['/proj']) });
    await stopTurn(stop.host, { jevEnabled: true });
    const runs = [...prompt.runs, ...dense.runs, ...selector.runs, ...turn.runs, ...stop.runs];
    expect(fetch, 'C1 guard must not fetch').not.toHaveBeenCalled();
    expect(ruleStarts(runs), 'C1 guard must not start rule-check.mjs').toEqual([]);
  });

  it('C2 prompt.submit does not fetch when the root is on the deny list', async () => {
    const fetch = labelFetch();
    const built = jevHost({ cwd: '/proj', root: '/client-acme/app', active: ['/proj', '/client-acme/app'], fetch });
    await submitPrompt(built.host, { jevDenyList: 'client-acme' });
    expect(fetch, 'C2 prompt.submit must not fetch').not.toHaveBeenCalled();
  });

  it('C2 session.compact dense rerank does not fetch when the root is on the deny list', async () => {
    const fetch = denseFetch();
    const built = jevHost({ cwd: '/proj', root: '/client-acme/app', active: ['/proj', '/client-acme/app'], fetch, segment: DENSE_SEGMENT });
    await compactSession(built.host, { denseNotes: true, jevEnabled: true, jevDenyList: 'client-acme' }, bulkyToolConversation());
    expect(fetch, 'C2 dense rerank must not fetch').not.toHaveBeenCalled();
  });

  it('C2 session.compact selector J does not fetch when the root is on the deny list', async () => {
    const fetch = denseFetch();
    const built = jevHost({ cwd: '/proj', root: '/client-acme/app', active: ['/proj', '/client-acme/app'], fetch, segment: SEGMENT });
    await compactSession(built.host, { jevEnabled: true, jevDenyList: 'client-acme' }, bulkyToolConversation());
    expect(fetch, 'C2 selector J must not fetch').not.toHaveBeenCalled();
  });

  it('C2 rule-check does not start when the root is on the deny list', async () => {
    const fetch = vi.fn();
    const built = jevHost({
      cwd: '/proj',
      root: '/client-acme/app',
      active: ['/proj', '/client-acme/app'],
      fetch,
      files: cardFiles(['/proj', '/client-acme/app']),
    });
    await stopTurn(built.host, { jevDenyList: 'client-acme' });
    expect(ruleStarts(built.runs), 'C2 rule-check.mjs must not start').toEqual([]);
  });

  it('C2 prompt.submit does not fetch when the denied root has no marker', async () => {
    const fetch = labelFetch();
    const built = jevHost({ cwd: '/proj', root: '/client-acme/app', active: ['/proj'], fetch });
    await submitPrompt(built.host, { jevDenyList: 'client-acme' });
    expect(fetch, 'C2 prompt.submit must not fetch').not.toHaveBeenCalled();
  });

  it('C2 session.compact dense rerank does not fetch when the denied root has no marker', async () => {
    const fetch = denseFetch();
    const built = jevHost({ cwd: '/proj', root: '/client-acme/app', active: ['/proj'], fetch, segment: DENSE_SEGMENT });
    await compactSession(built.host, { denseNotes: true, jevEnabled: true, jevDenyList: 'client-acme' }, bulkyToolConversation());
    expect(fetch, 'C2 dense rerank must not fetch').not.toHaveBeenCalled();
  });

  it('C2 session.compact selector J does not fetch when the denied root has no marker', async () => {
    const fetch = denseFetch();
    const built = jevHost({ cwd: '/proj', root: '/client-acme/app', active: ['/proj'], fetch, segment: SEGMENT });
    await compactSession(built.host, { jevEnabled: true, jevDenyList: 'client-acme' }, bulkyToolConversation());
    expect(fetch, 'C2 selector J must not fetch').not.toHaveBeenCalled();
  });

  it('C2 rule-check does not start when the denied root has no marker', async () => {
    const fetch = vi.fn();
    const built = jevHost({
      cwd: '/proj',
      root: '/client-acme/app',
      active: ['/proj'],
      fetch,
      files: cardFiles(['/proj']),
    });
    await stopTurn(built.host, { jevDenyList: 'client-acme' });
    expect(ruleStarts(built.runs), 'C2 rule-check.mjs must not start').toEqual([]);
  });

  it('C0 own-server control fetches to EXO_JEV_URL without a TypeSafe key', async () => {
    const fetch = labelFetch();
    const built = jevHost({ cwd: '/proj', root: '/proj', active: ['/proj'], fetch, env: ownJevEnv });
    await submitPrompt(built.host, {});
    expect(fetch, 'C0 own-server control must fetch').toHaveBeenCalled();
    expect(fetch.mock.calls.some(([url]) => url === ownJevUrl), 'C0 own-server control must use EXO_JEV_URL').toBe(true);
  });

  it('C4 own server makes no fetch or rule-check start when the shell is outside the project', async () => {
    const fetch = denseFetch();
    const prompt = jevHost({ cwd: '/tmp/wt', root: '/proj', active: ['/proj'], fetch, env: ownJevEnv });
    await submitPrompt(prompt.host, {});
    const dense = jevHost({ cwd: '/tmp/wt', root: '/proj', active: ['/proj'], fetch, segment: DENSE_SEGMENT, env: ownJevEnv });
    await compactSession(dense.host, { denseNotes: true, jevEnabled: true }, bulkyToolConversation());
    const selector = jevHost({ cwd: '/tmp/wt', root: '/proj', active: ['/proj'], fetch, segment: SEGMENT, env: ownJevEnv });
    await compactSession(selector.host, { jevEnabled: true }, bulkyToolConversation());
    const stop = jevHost({ cwd: '/tmp/wt', root: '/proj', active: ['/proj'], fetch, files: cardFiles(['/proj']), env: ownJevEnv });
    await stopTurn(stop.host, { jevEnabled: true });
    expect(fetch, 'C4 guard must not fetch').not.toHaveBeenCalled();
    expect(ruleStarts(stop.runs), 'C4 guard must not start rule-check.mjs').toEqual([]);
  });

  it('C5 own server makes no fetch or rule-check start when the root is on the deny list', async () => {
    const fetch = denseFetch();
    const prompt = jevHost({ cwd: '/proj', root: '/client-acme/app', active: ['/proj', '/client-acme/app'], fetch, env: ownJevEnv });
    await submitPrompt(prompt.host, { jevDenyList: 'client-acme' });
    const dense = jevHost({ cwd: '/proj', root: '/client-acme/app', active: ['/proj', '/client-acme/app'], fetch, segment: DENSE_SEGMENT, env: ownJevEnv });
    await compactSession(dense.host, { denseNotes: true, jevEnabled: true, jevDenyList: 'client-acme' }, bulkyToolConversation());
    const selector = jevHost({ cwd: '/proj', root: '/client-acme/app', active: ['/proj', '/client-acme/app'], fetch, segment: SEGMENT, env: ownJevEnv });
    await compactSession(selector.host, { jevEnabled: true, jevDenyList: 'client-acme' }, bulkyToolConversation());
    const stop = jevHost({
      cwd: '/proj',
      root: '/client-acme/app',
      active: ['/proj', '/client-acme/app'],
      fetch,
      files: cardFiles(['/proj', '/client-acme/app']),
      env: ownJevEnv,
    });
    await stopTurn(stop.host, { jevDenyList: 'client-acme' });
    expect(fetch, 'C5 guard must not fetch').not.toHaveBeenCalled();
    expect(ruleStarts(stop.runs), 'C5 guard must not start rule-check.mjs').toEqual([]);
  });

  it('C3 guard makes no fetch and does not start rule-check when the shell is on the deny list', async () => {
    const fetch = denseFetch();
    const denied = { jevDenyList: 'client-acme', jevEnabled: true };
    const prompt = jevHost({ cwd: '/client-acme/x', root: '/proj', active: ['/client-acme'], fetch });
    await submitPrompt(prompt.host, denied);
    const dense = jevHost({ cwd: '/client-acme/x', root: '/proj', active: ['/client-acme'], fetch, segment: DENSE_SEGMENT });
    await compactSession(dense.host, { denseNotes: true, ...denied }, bulkyToolConversation());
    const selector = jevHost({ cwd: '/client-acme/x', root: '/proj', active: ['/client-acme'], fetch, segment: SEGMENT });
    await compactSession(selector.host, denied, bulkyToolConversation());
    const stop = jevHost({ cwd: '/client-acme/x', root: '/proj', active: ['/client-acme'], fetch, files: cardFiles(['/client-acme']) });
    await stopTurn(stop.host, denied);
    const runs = [...prompt.runs, ...dense.runs, ...selector.runs, ...stop.runs];
    expect(fetch, 'C3 guard must not fetch').not.toHaveBeenCalled();
    expect(ruleStarts(runs), 'C3 guard must not start rule-check.mjs').toEqual([]);
  });
});

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function flat(node: ts.Node, source: ts.SourceFile): string {
  return node.getText(source).replace(/\s+/g, ' ').trim();
}

function lineOf(node: ts.Node, source: ts.SourceFile): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function flagLiteralsMissingRoot(text: string, fileName: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const missing: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      let cwd: ts.Expression | undefined;
      let root: ts.Expression | undefined;
      let exists = false;
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = propertyName(property.name);
        if (name === 'cwd') cwd = property.initializer;
        if (name === 'root') root = property.initializer;
        if (name === 'exists') exists = true;
      }
      if (cwd && exists && flat(cwd, source) === '() => $.session.cwd()' && (!root || flat(root, source) !== '() => $.session.root()')) {
        missing.push(`${fileName}:${lineOf(node, source)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return missing;
}

function hostForwardsMissingRoot(text: string, fileName: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const missing: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'findCaptureRoot') {
      const arg = node.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        let cwdText = '';
        let rootText = '';
        for (const property of arg.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const name = propertyName(property.name);
          if (name === 'cwd') cwdText = flat(property.initializer, source);
          if (name === 'root') rootText = flat(property.initializer, source);
        }
        if (cwdText === 'host.cwd' && rootText !== 'host.root') missing.push(`${fileName}:${lineOf(arg, source)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return missing;
}

describe('session root source gates', () => {
  it('D1 capture-flag copies match', () => {
    const compact = readFileSync(new URL('../host/capture-flag.ts', import.meta.url), 'utf8');
    const trigger = readFileSync(new URL('../../compact-trigger/host/capture-flag.ts', import.meta.url), 'utf8');
    expect(compact, 'byte-identical').toBe(trigger);
  });

  it('D2 every cwd+exists flag host literal also spells root', () => {
    const compact = readFileSync(new URL('../compact.ts', import.meta.url), 'utf8');
    const trigger = readFileSync(new URL('../../compact-trigger/trigger.ts', import.meta.url), 'utf8');
    const missing = [...flagLiteralsMissingRoot(compact, 'compact.ts'), ...flagLiteralsMissingRoot(trigger, 'trigger.ts')];
    expect(missing, `D2 flag host literals missing root: ${missing.join(', ')}`).toEqual([]);
  });

  it('D3 findCaptureRoot forwards of host.cwd also forward root', () => {
    const compact = readFileSync(new URL('../compact.ts', import.meta.url), 'utf8');
    const missing = hostForwardsMissingRoot(compact, 'compact.ts');
    expect(missing, `D3 findCaptureRoot calls missing root: ${missing.join(', ')}`).toEqual([]);
  });
});
