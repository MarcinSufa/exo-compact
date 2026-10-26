import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { register } from '../compact.js';
import { reconcile } from '../core/extractor.js';
import { fakeHost, humanPrompt, assistantText, assistantCall, toolResultsMessage, withStrippedRuntimeGlobals, sha256, LEGACY_OPTIONS, cpuMsAsync } from './fixtures/helpers.js';
import type { CompactEvent, SessionMessage } from '../core/types.js';
import type { FakeHost } from './fixtures/helpers.js';
import { makeFsCaptureStore } from '../host/fs-adapter.js';
import { CAPTURE_GITIGNORE } from '../host/capture-path.js';
import { applyConstraintOverflow, extractConstraints, renderConstraintsSection } from '../core/constraints.js';
import { SEED_BUDGET_TOKENS, TOTAL_BUDGET_TOKENS } from '../core/budgets.js';
import { countTokens as gateCountTokens } from './fixtures/helpers.js';
import { capturedUserText, labelKey } from '../core/labels.js';

type Handler = ($: FakeHost, event: unknown, next: (event: unknown) => Promise<unknown>) => Promise<unknown>;
type CompactPerfAttempt = {
  attempt: number;
  result: { messages?: SessionMessage[]; fellBack?: boolean };
  cpuMs: number;
  totalMs: number;
  maxBlockMs: number;
};
type CompactPerfRetryResult = {
  attempts: CompactPerfAttempt[];
  diagnosticAttempt: CompactPerfAttempt;
  contentAttempt: CompactPerfAttempt;
  passed: boolean;
};

/** Mirrors the relative path `compact.ts` reads and `setup.cjs` writes (CONTRACT.md's S3/S4
 * mutual exclusion section). */
const FLAG_PATH = '.exovault/s4-compact-active';
const SECRET = 'sk-test-dense-key';

function harness(options: Record<string, unknown> = {}): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const on = (name: string, handler: Handler) => {
    handlers[name] = handler;
    return { catch: (caught: unknown) => { (handlers as Record<string, unknown>)[`${name}.catch`] = caught; } };
  };
  // 3.46.0: these tests were sized for the 13000 total; the real-token default (20000) has its own test.
  register(on as never, { ...LEGACY_OPTIONS, ...LEGACY_OPTIONS, denseNotes: false, totalBudgetTokens: 13000, ...options } as never);
  return handlers;
}

/** Many old, verbose exchanges (cut from the tail) plus a couple of short recent ones, so a real
 * compaction shrinks well past the 25% floor regardless of the exact seed/tail content.
 * Sized well past TAIL_BUDGET_TOKENS (10000, chars/4) so `pickTail` actually omits the bulk of
 * this history instead of keeping everything (a smaller fixture leaves nothing to cut, so the
 * "compacted" result is the same size or larger than the original and correctly falls back on
 * insufficient reduction, a fixture defect, not a selector D defect). */
function longConversation(): SessionMessage[] {
  const old: SessionMessage[] = [];
  for (let i = 0; i < 40; i += 1) {
    old.push(humanPrompt(`old turn ${i}: ${'detail '.repeat(200)}`));
    old.push(assistantText(`old reply ${i}: ${'detail '.repeat(200)}`));
  }
  return [...old, humanPrompt('what is the status now'), assistantText('all good, wrapping up')];
}

describe('compact.ts: session.compact fallback must cover the whole handler, not just run() (finding 5)', () => {
  it('a rejecting $.fs.write during capture falls back to next(), instead of throwing out of session.compact', async () => {
    const log = vi.fn();
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const fsRead = vi.fn(async (path: string) => (path === FLAG_PATH ? '1' : ''));
    const fsWrite = vi.fn(async () => {
      throw new Error('disk full');
    });
    const $ = fakeHost({ fsRead, fsWrite, uiLog: log });
    const handlers = harness({ contract: 'the contract' });
    const event: CompactEvent = { trigger: 'auto', messages: [humanPrompt('VALUE key=x: 1'), assistantText('ok')] };
    let error: unknown;
    let result: unknown;
    try {
      result = await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next));
    } catch (e) {
      error = e;
    }
    expect(error, `session.compact must fall back to next() on a capture-write failure, not throw: ${String(error)}`).toBeUndefined();
    expect(fsWrite, 'capture must actually be attempted before the fallback, not skipped by a flag-check short-circuit').toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ fellBack: true });
  });

  it('a rejecting $.fs.write during turn capture does not escape; turn.complete still resolves with next()\'s result', async () => {
    const log = vi.fn();
    const next = vi.fn(async () => ({ turnResult: true }) as unknown);
    const fsRead = vi.fn(async (path: string) => (path === FLAG_PATH ? '1' : ''));
    const fsWrite = vi.fn(async () => {
      throw new Error('disk full');
    });
    const $ = fakeHost({ fsRead, fsWrite, uiLog: log, sessionMessages: async () => [humanPrompt('hi')] });
    const handlers = harness({ contract: 'the contract' });
    const event = { reason: 'answer' } as unknown;
    let error: unknown;
    let result: unknown;
    try {
      result = await withStrippedRuntimeGlobals(() => handlers['turn.complete']($, event, next));
    } catch (e) {
      error = e;
    }
    expect(error, `turn.complete must not let a post-next() capture failure escape: ${String(error)}`).toBeUndefined();
    expect(fsWrite, 'capture must actually be attempted after next(), not skipped by a flag-check short-circuit').toHaveBeenCalled();
    expect(result).toEqual({ turnResult: true });
  });
});

/**
 * Bulk from tool calls/results, not from human/assistant text: round 8 findings 1/2 made this
 * run's own `reconcile(event.messages, ...)` output feed selector D in memory (no longer
 * silently discarded whenever a test's `fsWrite`/`fsRead` mocks happen to be disconnected, as
 * `longConversation()`'s plain text turns used to rely on). Tool call/result pairs are still
 * plenty of bulk for pickTail to cut (and for the 25% shrink floor), but generate no `user` or
 * `assistant_text` reconcile record at all (`reconcile` only reads message `.text`, never tool
 * input/output), so they cannot compete with a fixture's own captured reasoning for
 * `SEED_BUDGET_TOKENS`.
 */
function bulkyToolConversation(): SessionMessage[] {
  const old: SessionMessage[] = [];
  for (let i = 0; i < 40; i += 1) {
    old.push(assistantCall('Read', { input: { file: `f${i}.ts` } }));
    old.push(toolResultsMessage([{ toolUseId: (old.at(-1) as SessionMessage).toolUses[0].tool_use_id, options: { text: 'line '.repeat(400) } }]));
  }
  return [...old, humanPrompt('what is the status now'), assistantText('all good, wrapping up')];
}

describe('compact.ts: selector D must actually be wired in (finding 8)', () => {
  it('captured assistant_text shows up in the rendered seed via selector D, end to end', async () => {
    const reasoningText = 'Chose Postgres over Mongo because of relational constraints.';
    const record = {
      kind: 'assistant_text',
      origin: 'reconcile',
      producedBy: 's4-capture',
      sourceHash: 'fixture-hash',
      body: { text: reasoningText },
    };
    const fsList = vi.fn(async () => [{ name: 'segment-000001.json', kind: 'file', size: 1 }]);
    const fsRead = vi.fn(async (path: string) => {
      if (path === FLAG_PATH) return '1';
      if (path.endsWith('segment-000001.json')) return `${JSON.stringify(record)}\n`;
      throw new Error(`ENOENT: ${path}`);
    });
    const $ = fakeHost({ fsList, fsRead });
    const handlers = harness({ contract: 'the contract' });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next))) as { messages?: SessionMessage[] };
    expect(next, 'this conversation shrinks well past the 25% floor and must not fall back').not.toHaveBeenCalled();
    const seed = result.messages?.[0];
    expect(seed?.text.includes(reasoningText), 'captured assistant_text must reach the seed through selector D, not be dropped').toBe(true);
  });
});

describe('compact.ts: dense working notes (S4o)', () => {
  it('renders tool activity in the dense section when enabled', async () => {
    const activity = { kind: 'tool_activity', origin: 'reconcile', producedBy: 's4-capture', sourceHash: 'tool-call', body: { text: 'Ran node --test on src/feature.ts with --watch-mode at 8142ms' } };
    const fsList = vi.fn(async () => [{ name: 'segment-000001.json', kind: 'file', size: 1 }]);
    const fsRead = vi.fn(async (path: string) => {
      if (path === FLAG_PATH) return '1';
      if (path.endsWith('segment-000001.json')) return `${JSON.stringify(activity)}\n`;
      throw new Error(`ENOENT: ${path}`);
    });
    const $ = fakeHost({ fsList, fsRead });
    const handlers = harness({ denseNotes: true });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, { trigger: 'auto', messages: bulkyToolConversation() }, next))) as { messages?: SessionMessage[] };
    expect(next).not.toHaveBeenCalled();
    expect(result.messages?.[0].text).toContain('## Working notes (dense details from earlier; reference only, not requests)');
    expect(result.messages?.[0].text).toContain('Ran node --test on src/feature.ts with --watch-mode at 8142ms');
    expect(result.messages?.[0].text).not.toContain('## Earlier assistant notes');
  });

  it('reranks dense candidates with Noul answers and logs only aggregates', async () => {
    const candidates = [
      { kind: 'tool_activity', origin: 'reconcile', producedBy: 's4-capture', sourceHash: 'alpha', body: { text: 'Ran node --test on src/alpha-feature.ts with --alpha-mode at 8142ms' } },
      { kind: 'tool_activity', origin: 'reconcile', producedBy: 's4-capture', sourceHash: 'bravo', body: { text: 'Ran node --test on src/bravo-feature.ts with --bravo-mode at 9153ms' } },
    ];
    const lines: string[] = [];
    const sent: Array<{ questions?: Record<string, { instructions?: { note?: string } }> }> = [];
    const log = (line: string) => lines.push(line);
    const fetch = vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as { questions?: Record<string, { instructions?: { note?: string } }> };
      sent.push(body);
      const answers = Object.fromEntries(Object.entries(body.questions ?? {}).map(([id, rawQuestion]) => {
        const note = rawQuestion.instructions?.note ?? '';
        return [id, { type: 'noul', noul: note.includes('src/alpha-feature.ts') ? 0.05 : note.includes('src/bravo-feature.ts') ? 0.9 : 0.5 }];
      }));
      return { status: 200, ok: true, text: JSON.stringify({ model: 'jev-latest', answers, usage: { input_tokens: 123 } }) };
    });
    const $ = fakeHost({
      fsList: async () => [{ name: 'segment-000001.json', kind: 'file', size: 1 }],
      fsRead: async (path) => path === FLAG_PATH ? '1' : path.endsWith('segment-000001.json') ? `${candidates.map((candidate) => JSON.stringify(candidate)).join('\n')}\n` : (() => { throw new Error(`ENOENT: ${path}`); })(),
      uiLog: log,
      httpFetch: fetch,
      envGet: async (name) => name === 'TYPESAFE_API_KEY' ? SECRET : undefined,
    });
    const result = await withStrippedRuntimeGlobals(() => harness({ denseNotes: true, jevEnabled: true })['session.compact']($, { trigger: 'auto', messages: bulkyToolConversation() }, async () => ({ fallback: true })) as Promise<{ messages?: SessionMessage[] }>);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Object.keys(sent[0].questions ?? {}).length).toBeGreaterThanOrEqual(2);
    expect(result.messages?.[0].text).toContain('src/bravo-feature.ts');
    expect(result.messages?.[0].text).not.toContain('src/alpha-feature.ts');
    const asked = Object.keys(sent[0].questions ?? {}).length;
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^dense\\.jev=ok dense\\.jev_requests=1 dense\\.jev_answered=${asked}/${asked} dense\\.jev_units=123 dense\\.jev_ms=\\d+$`)));
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(lines.join('\n')).not.toContain('src/bravo-feature.ts');
  });

  it('4.7.5 (S5q): dense Jev asks the address in EXO_JEV_URL, and skips with bad_jev_url when it is no address', async () => {
    const activity = { kind: 'tool_activity', origin: 'reconcile', producedBy: 's4-capture', sourceHash: 'tool-call', body: { text: 'Ran node --test on src/feature.ts with --watch-mode at 8142ms' } };
    const run = async (address: string) => {
      const lines: string[] = [];
      const asked: Array<{ url: string; auth: string | undefined }> = [];
      const fetch = vi.fn(async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
        asked.push({ url, auth: init?.headers?.Authorization });
        const body = JSON.parse(init?.body ?? '{}') as { questions?: Record<string, unknown> };
        const answers = Object.fromEntries(Object.keys(body.questions ?? {}).map((id) => [id, { type: 'noul', noul: 0.9 }]));
        return { status: 200, ok: true, text: JSON.stringify({ model: 'jev-0.1', answers, usage: { input_tokens: 10 } }) };
      });
      const $ = fakeHost({
        fsList: async () => [{ name: 'segment-000001.json', kind: 'file', size: 1 }],
        fsRead: async (path) => path === FLAG_PATH ? '1' : path.endsWith('segment-000001.json') ? `${JSON.stringify(activity)}\n` : (() => { throw new Error(`ENOENT: ${path}`); })(),
        uiLog: (line: string) => lines.push(line),
        httpFetch: fetch,
        envGet: async (name) => name === 'EXO_JEV_URL' ? address : undefined,
      });
      await withStrippedRuntimeGlobals(() => harness({ denseNotes: true, jevEnabled: true })['session.compact']($, { trigger: 'auto', messages: bulkyToolConversation() }, async () => ({ fallback: true })));
      return { lines, asked };
    };
    const own = await run('http://localhost:9000/v1/systemone');
    expect(own.asked.length).toBeGreaterThan(0);
    for (const call of own.asked) expect(call).toEqual({ url: 'http://localhost:9000/v1/systemone', auth: 'Bearer local' });
    expect(own.lines).toContainEqual(expect.stringMatching(/^dense\.jev=ok /));
    const wrong = await run('not an address');
    expect(wrong.asked).toEqual([]);
    expect(wrong.lines).toContainEqual(expect.stringMatching(/^dense\.jev=skipped .*dense\.jev_skipped=bad_jev_url$/));
  });

  it.each([
    ['disabled', { jevEnabled: false }, SECRET, 'disabled'],
    ['denied cwd', { jevEnabled: true, jevDenyList: '/project' }, SECRET, 'deny_list'],
    ['missing API key', { jevEnabled: true }, undefined, 'no_api_key'],
    ['option off', { jevEnabled: true, jevDenseRerank: false }, SECRET, 'option_off'],
  ] as const)('skips dense Jev for %s without making a fetch', async (_name, options, apiKey, reason) => {
    const activity = { kind: 'tool_activity', origin: 'reconcile', producedBy: 's4-capture', sourceHash: 'tool-call', body: { text: 'Ran node --test on src/feature.ts with --watch-mode at 8142ms' } };
    const log = vi.fn();
    const fetch = vi.fn(async () => ({ status: 200, ok: true, text: '{}' }));
    const $ = fakeHost({
      fsList: async () => [{ name: 'segment-000001.json', kind: 'file', size: 1 }],
      fsRead: async (path) => path === FLAG_PATH ? '1' : path.endsWith('segment-000001.json') ? `${JSON.stringify(activity)}\n` : (() => { throw new Error(`ENOENT: ${path}`); })(),
      uiLog: log,
      httpFetch: fetch,
      envGet: async (name) => name === 'TYPESAFE_API_KEY' ? apiKey : undefined,
    });
    await withStrippedRuntimeGlobals(() => harness({ denseNotes: true, ...options })['session.compact']($, { trigger: 'auto', messages: bulkyToolConversation() }, async () => ({ fallback: true })));
    expect(fetch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^dense\\.jev=skipped .*dense\\.jev_skipped=${reason}$`)));
  });
});

describe('compact.ts: work state at the cut (S4q)', () => {
  it('keeps a cut alive with oversized task, todo and background state', async () => {
    const messages: SessionMessage[] = [...bulkyToolConversation()];
    for (let i = 0; i < 120; i += 1) {
      const id = `task-${i}`;
      messages.push(assistantCall('TaskCreate', { tool_use_id: id, input: { subject: `Task ${i} ${'x'.repeat(160)}` } }));
      messages.push(toolResultsMessage([{ toolUseId: id, options: { text: `Task #${i} created successfully: Task ${i} ${'x'.repeat(160)}` } }]));
    }
    messages.push(assistantCall('TodoWrite', { input: { todos: Array.from({ length: 30 }, (_, i) => ({ content: `Todo ${i} ${'y'.repeat(160)}`, status: 'pending' })) } }));
    for (let i = 0; i < 12; i += 1) {
      const id = `job-${i}`;
      messages.push(assistantCall('Bash', { tool_use_id: id, input: { command: `sleep ${i}`, run_in_background: true, description: `Job ${i} ${'z'.repeat(160)}` } }));
      messages.push(toolResultsMessage([{ toolUseId: id, options: { text: `command running with ID: ${id}` } }]));
    }
    const files = new Map<string, string>();
    const $ = fakeHost({ fsRead: async (path) => path === FLAG_PATH ? '1' : files.get(path) ?? '', fsWrite: async (path, text) => { files.set(path, text); }, fsList: async (path = '') => [...files.entries()].filter(([name]) => name.startsWith(`${path}/`)).map(([name, text]) => ({ name: name.slice(path.length + 1), kind: 'file', size: text.length })), fsExists: async (path) => path === '/project' || path.endsWith(FLAG_PATH) || files.has(path), processRun: async (argv) => argv.includes('status') ? { exitCode: 0, stdout: '## main\n', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' } });
    const next = vi.fn(async () => ({ fallback: true }) as unknown);
    const result = (await withStrippedRuntimeGlobals(() => harness({ denseNotes: false })['session.compact']($, { trigger: 'auto', messages }, next))) as { messages?: SessionMessage[] };
    expect(next).not.toHaveBeenCalled();
    expect(result.messages?.[0].text).toContain('## Work state');
  });

  it('skips malformed work events and contains a synchronous probe throw', async () => {
    const files = new Map<string, string>();
    const segment = '/project/.exovault/s4-capture/session-default/segment-000001.json';
    files.set(segment, `${JSON.stringify({ kind: 'work_event', origin: 'turn', producedBy: 's4-capture', sourceHash: 'bad', body: { type: 'clone' } })}\n`);
    const log = vi.fn();
    const $ = fakeHost({ fsRead: async (path) => path === FLAG_PATH ? '1' : files.get(path) ?? '', fsWrite: async (path, text) => { files.set(path, text); }, fsList: async (path = '') => [...files.entries()].filter(([name]) => name.startsWith(`${path}/`)).map(([name, text]) => ({ name: name.slice(path.length + 1), kind: 'file', size: text.length })), fsExists: async (path) => path === '/project' || path.endsWith(FLAG_PATH) || files.has(path), processRun: () => { throw new Error('sync probe failure'); }, uiLog: log });
    const next = vi.fn(async () => ({ fallback: true }) as unknown);
    const result = (await withStrippedRuntimeGlobals(() => harness({ denseNotes: false })['session.compact']($, { trigger: 'auto', messages: bulkyToolConversation() }, next))) as { messages?: SessionMessage[] };
    expect(next).not.toHaveBeenCalled();
    expect(result.messages?.[0].text).not.toContain('## Work state');
    expect(log).toHaveBeenCalledWith('seed.work_state=error');
  });

  it('captures work events and renders the cut-time Git probe', async () => {
    const log = vi.fn();
    const files = new Map<string, string>();
    const processRun = vi.fn(async (argv: readonly string[]) => argv[3] === 'status'
      ? { exitCode: 0, stdout: '## feat/x...origin/feat/x [ahead 2]\n M one.ts\n', stderr: '' }
      : { exitCode: 0, stdout: 'worktree /project\nbranch refs/heads/feat/x\n\nworktree /tmp/wt\nbranch refs/heads/other\n', stderr: '' });
    const $ = fakeHost({
      fsRead: async (path) => path === FLAG_PATH ? '1' : files.get(path) ?? '',
      fsWrite: async (path, text) => { files.set(path, text); },
      fsList: async (path = '') => [...files.entries()].filter(([name]) => name.startsWith(`${path}/`)).map(([name, text]) => ({ name: name.slice(path.length + 1), kind: 'file', size: text.length })),
      fsExists: async (path) => path === '/project' || path.endsWith(FLAG_PATH) || files.has(path),
      processRun,
      uiLog: log,
    });
    const handlers = harness({ denseNotes: false });
    const messages = [...bulkyToolConversation(), assistantCall('Bash', { input: { command: 'git switch -c feat/work' } })];
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, { trigger: 'auto', messages }, next))) as { messages?: SessionMessage[] };
    expect(next).not.toHaveBeenCalled();
    expect(result.messages?.[0].text).toContain('## Work state (from tool calls and a git check at the cut; reference only)');
    expect(result.messages?.[0].text).toContain('Branches: created feat/work in /project');
    expect(result.messages?.[0].text).toContain('Git at the cut: /project: ## feat/x...origin/feat/x [ahead 2]; 1 changed file');
    expect(processRun).toHaveBeenCalledTimes(2);
    for (const call of processRun.mock.calls) expect(call[1]).toEqual({ cwd: '/project', env: { GIT_OPTIONAL_LOCKS: '0' }, timeoutMs: 1500 });
    expect(log).toHaveBeenCalledWith('seed.work_state_probe=ok');
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^seed\.work_state_size=\d+$/));
  });

  it('persists work events from turn.complete for the next cut', async () => {
    const files = new Map<string, string>();
    const $ = fakeHost({
      fsRead: async (path) => path === FLAG_PATH ? '1' : files.get(path) ?? '',
      fsWrite: async (path, text) => { files.set(path, text); },
      fsList: async (path = '') => [...files.entries()].filter(([name]) => name.startsWith(`${path}/`)).map(([name, text]) => ({ name: name.slice(path.length + 1), kind: 'file', size: text.length })),
      fsExists: async (path) => path.endsWith(FLAG_PATH) || files.has(path),
      sessionMessages: async () => [assistantCall('Bash', { input: { command: 'git -C /project switch -c feat/persisted' } })],
    });
    const handlers = harness();
    const next = vi.fn(async () => ({ turnComplete: true }) as unknown);
    await withStrippedRuntimeGlobals(() => handlers['turn.complete']($, { reason: 'answer' }, next));
    const records = [...files.entries()].filter(([path]) => path.includes('/segment-')).flatMap(([, text]) => text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { kind: string; body: { type?: string; name?: string } }));
    expect(records).toContainEqual(expect.objectContaining({ kind: 'work_event', body: { type: 'branch', name: 'feat/persisted', repo: '/project', created: true } }));
    expect(next).toHaveBeenCalledOnce();
  });

  it('folds queued task notifications from work-events.jsonl at the cut', async () => {
    const files = new Map<string, string>();
    files.set('/project/.exovault/s4-capture/session-default/work-events.jsonl', JSON.stringify({ id: 'job-1', status: 'completed', summary: 'Done' }));
    const use = assistantCall('Bash', { tool_use_id: 'bg-tool', input: { command: 'sleep 1', run_in_background: true, description: 'Wait' } });
    const messages = [...bulkyToolConversation(), use, toolResultsMessage([{ toolUseId: 'bg-tool', options: { text: 'command running with ID: job-1' } }])];
    const $ = fakeHost({
      fsRead: async (path) => path === FLAG_PATH ? '1' : files.get(path) ?? '',
      fsWrite: async (path, text) => { files.set(path, text); },
      fsList: async (path = '') => [...files.entries()].filter(([name]) => name.startsWith(`${path}/`)).map(([name, text]) => ({ name: name.slice(path.length + 1), kind: 'file', size: text.length })),
      fsExists: async (path) => path === '/project' || path.endsWith(FLAG_PATH) || files.has(path),
      processRun: async (argv) => argv[3] === 'status' ? { exitCode: 0, stdout: '## main\n', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' },
    });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const result = (await withStrippedRuntimeGlobals(() => harness({ denseNotes: false })['session.compact']($, { trigger: 'auto', messages }, next))) as { messages?: SessionMessage[] };
    expect(next).not.toHaveBeenCalled();
    expect(result.messages?.[0].text).toContain('Background: completed job-1 "Wait"');
  });

  it('keeps the cut alive after probe failures and skips the probe when disabled', async () => {
    const processRun = vi.fn(async () => { throw new Error('timeout'); });
    const log = vi.fn();
    const files = new Map<string, string>();
    const $ = fakeHost({
      fsRead: async (path) => path === FLAG_PATH ? '1' : files.get(path) ?? '',
      fsWrite: async (path, text) => { files.set(path, text); },
      fsList: async (path = '') => [...files.entries()].filter(([name]) => name.startsWith(`${path}/`)).map(([name, text]) => ({ name: name.slice(path.length + 1), kind: 'file', size: text.length })),
      fsExists: async (path) => path === '/project' || path.endsWith(FLAG_PATH) || files.has(path),
      processRun,
      uiLog: log,
    });
    const handlers = harness({ denseNotes: false });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const messages = [...bulkyToolConversation(), assistantCall('Bash', { input: { command: 'git switch feat/x' } })];
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, { trigger: 'auto', messages }, next))) as { messages?: SessionMessage[] };
    expect(next).not.toHaveBeenCalled();
    expect(result.messages?.[0].text).toContain('Branches: switched to feat/x in /project');
    expect(processRun).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('seed.work_state_probe=timeout');

    const disabledRun = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const disabledHost = fakeHost({ fsRead: async (path) => path === FLAG_PATH ? '1' : files.get(path) ?? '', fsWrite: async (path, text) => { files.set(path, text); }, fsList: async (path = '') => [...files.entries()].filter(([name]) => name.startsWith(`${path}/`)).map(([name, text]) => ({ name: name.slice(path.length + 1), kind: 'file', size: text.length })), fsExists: async (path) => path === '/project' || path.endsWith(FLAG_PATH) || files.has(path), processRun: disabledRun });
    const disabled = harness({ workState: false });
    const disabledResult = (await withStrippedRuntimeGlobals(() => disabled['session.compact'](disabledHost, { trigger: 'auto', messages }, next))) as { messages?: SessionMessage[] };
    expect(disabledRun).not.toHaveBeenCalled();
    expect(disabledResult.messages?.[0].text).not.toContain('## Work state');
  });
});

describe('S4q: queued task notification capture in prompt.submit', () => {
  const notification = '<task-notification><task-id>bzch9qgap</task-id><status>completed</status><summary>Finished safely</summary></task-notification>';
  async function flushBackground(): Promise<void> { for (let i = 0; i < 20; i += 1) await Promise.resolve(); }
  const activeHost = (overrides: Parameters<typeof fakeHost>[0] = {}) => fakeHost({
    fsExists: async (path) => path === '/project/.exovault/s4-compact-active',
    sessionCwd: async () => '/project',
    ...overrides,
  });

  it('writes a task-notification origin block as redacted event JSON without waiting on the write', async () => {
    const files = new Map<string, string>();
    let release!: () => void;
    const fsWrite = vi.fn(async (path: string, text: string) => { await new Promise<void>((resolve) => { release = resolve; }); files.set(path, text); });
    const log = vi.fn();
    const $ = activeHost({ fsWrite, uiLog: log });
    const input = { text: notification, origin: { kind: 'task-notification' } };
    const next = vi.fn(async () => ({ immediate: true }));
    const result = await withStrippedRuntimeGlobals(() => harness({ jevEnabled: false })['prompt.submit']($, input, next));
    expect(result).toEqual({ immediate: true });
    expect(next).toHaveBeenCalledOnce();
    await flushBackground();
    expect(fsWrite).toHaveBeenCalledOnce();
    const [path, text] = fsWrite.mock.calls[0];
    expect(path).toContain('/work-events.jsonl');
    expect(JSON.parse(text)).toEqual({ id: 'bzch9qgap', status: 'completed', summary: 'Finished safely' });
    release();
    await flushBackground();
    expect(log).not.toHaveBeenCalled();
  });

  it('does not write composer text without a notification block and swallows write errors', async () => {
    const write = vi.fn(async () => { throw new Error('private fs failure'); });
    const log = vi.fn();
    const $ = activeHost({ fsWrite: write, uiLog: log });
    const handlers = harness({ jevEnabled: false });
    await withStrippedRuntimeGlobals(() => handlers['prompt.submit']($, { text: 'ordinary composer text', origin: { kind: 'composer' } }, async () => ({})));
    expect(write).not.toHaveBeenCalled();
    const next = vi.fn(async () => ({ passed: true }));
    const result = await withStrippedRuntimeGlobals(() => handlers['prompt.submit']($, { text: notification, origin: { kind: 'task-notification' } }, next));
    expect(result).toEqual({ passed: true });
    await flushBackground();
    expect(write).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledExactlyOnceWith('work_state.notification_write=error');
  });

  it('retains only the newest 500 notification lines on rewrite', async () => {
    const files = new Map<string, string>();
    const path = '/project/.exovault/s4-capture/session-default/work-events.jsonl';
    files.set(path, Array.from({ length: 500 }, (_, i) => JSON.stringify({ id: `old-${i}`, status: 'done' })).join('\n'));
    const $ = activeHost({ fsRead: async (name) => files.get(name) ?? '', fsWrite: async (name, text) => { files.set(name, text); } });
    const source = '<task-notification><task-id>new</task-id><status>completed</status></task-notification>';
    await withStrippedRuntimeGlobals(() => harness({ jevEnabled: false })['prompt.submit']($, { text: source, origin: { kind: 'task-notification' } }, async () => ({})));
    await flushBackground();
    const rows = files.get(path)!.split('\n');
    expect(rows).toHaveLength(500);
    expect(rows[0]).toContain('old-1');
    expect(rows.at(-1)).toContain('"id":"new"');
  });
});

describe('compact.ts: round 8 findings 1 and 2, watermark redesign end to end', () => {
  function statefulFs() {
    const files = new Map<string, string>();
    const fsList = vi.fn(async (path = '') => [...files.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => ({ name: key.slice(path.length + 1), kind: 'file', size: files.get(key)!.length })));
    const fsRead = vi.fn(async (path: string) => (path === FLAG_PATH ? '1' : files.get(path) ?? Promise.reject(new Error(`ENOENT: ${path}`))));
    const fsWrite = vi.fn(async (path: string, text: string) => { files.set(path, text); });
    return { files, fsList, fsRead, fsWrite };
  }

  function capturedValues(files: Map<string, string>): Record<string, string> {
    const values: Record<string, string> = {};
    for (const [path, text] of files) {
      if (!path.includes('/segment-')) continue;
      for (const line of text.split('\n').filter(Boolean)) {
        const record = JSON.parse(line) as { kind: string; body: { key?: string; content?: string } };
        if (record.kind === 'value' && record.body.key) values[record.body.key] = String(record.body.content);
      }
    }
    return values;
  }

  it('finding 1 repro: after an S4 compaction stands, a new VALUE and a value reset in the next turn are captured, not dropped', async () => {
    const { files, fsList, fsRead, fsWrite } = statefulFs();
    let messages: SessionMessage[] = [];
    const $ = fakeHost({ fsRead, fsWrite, fsList, sessionMessages: async () => messages });
    const handlers = harness({ contract: 'the contract' });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);

    // Turn 1: VALUE port=5432, captured by turn.complete.
    messages = [humanPrompt('VALUE key=port: 5432'), assistantText('ok')];
    await withStrippedRuntimeGlobals(() => handlers['turn.complete']($, { reason: 'answer' }, async () => ({})));
    expect(capturedValues(files).port).toBe('5432');

    // Turn 2: enough bulk that S4 stands, ending with a value reset (port=5433), then compact.
    messages = [...messages, ...bulkyToolConversation().slice(0, -2), humanPrompt('VALUE key=port: 5433'), assistantText('ok')];
    const compactResult = (await withStrippedRuntimeGlobals(() =>
      handlers['session.compact']($, { trigger: 'auto', messages } as CompactEvent, next),
    )) as { messages?: SessionMessage[] };
    expect(next, 'this conversation shrinks well past the 25% floor and S4 must stand').not.toHaveBeenCalled();
    expect(capturedValues(files).port, 'the reset to 5433 must be captured by the S4 compaction itself').toBe('5433');
    messages = compactResult.messages ?? [];

    // Turn 3: a brand new VALUE on top of the compacted list, plus the same "ok" closer as
    // before compaction (round 8 finding 1's exact repro: an identical short closer must not
    // make the watermark match at the wrong, pre-compaction position).
    messages = [...messages, humanPrompt('VALUE key=db: postgres-16'), assistantText('ok')];
    await withStrippedRuntimeGlobals(() => handlers['turn.complete']($, { reason: 'answer' }, async () => ({})));

    const values = capturedValues(files);
    expect(values.port, 'a watermark computed over the pre-compaction list would still "match" this turn\'s own trailing ok and capture nothing').toBe('5433');
    expect(values.db, 'the VALUE from the turn after compaction must be captured, not silently dropped').toBe('postgres-16');
  });
});

describe('compact.ts: round 9 findings 1-3, ported from the reviewer repro (r8/proxy/hooks/compact/__gate-s4__/zz-repro-r8.gate.test.ts)', () => {
  /** Unlike the block above, `fsExists` genuinely reflects file state, so `loadWatermark`
   * round-trips through disk instead of always seeing "absent" (fakeHost's default `fsExists`
   * only recognizes the S3/S4 flag path). This is required to exercise the sourceHash-reuse
   * and early-write bugs, which only appear when a real watermark is loaded back. */
  function statefulFs() {
    const files = new Map<string, string>();
    const fsList = vi.fn(async (path = '') => {
      const keys = [...files.keys()].filter((key) => key.startsWith(`${path}/`));
      if (!keys.length) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return keys.map((key) => ({ name: key.slice(path.length + 1), kind: 'file', size: files.get(key)!.length }));
    });
    const fsRead = vi.fn(async (path: string) => (path === FLAG_PATH ? '1' : files.has(path) ? files.get(path)! : Promise.reject(new Error(`ENOENT: ${path}`))));
    const fsWrite = vi.fn(async (path: string, text: string) => { files.set(path, text); });
    const fsExists = vi.fn(async (path: string) => path.endsWith(FLAG_PATH) || files.has(path) || [...files.keys()].some((k) => k.startsWith(`${path}/`)));
    return { files, fsList, fsRead, fsWrite, fsExists };
  }
  function records(files: Map<string, string>) {
    const out: { kind: string; origin: string; sourceHash: string; body: Record<string, unknown> }[] = [];
    for (const [path, text] of files) if (path.includes('/segment-')) for (const line of text.split('\n').filter(Boolean)) out.push(JSON.parse(line));
    return out;
  }
  function latestValues(files: Map<string, string>) {
    const v: Record<string, string> = {};
    for (const r of records(files)) if (r.kind === 'value') v[String(r.body.key)] = String(r.body.content);
    return v;
  }
  const turn = (h: Record<string, Handler>, $: FakeHost) => withStrippedRuntimeGlobals(() => h['turn.complete']($, { reason: 'answer' }, async () => ({})));

  it('finding 1: a value reset to an earlier identical VALUE after an S4 compaction is persisted, not dropped by sourceHash reuse', async () => {
    const fs = statefulFs();
    let messages: SessionMessage[] = [];
    const $ = fakeHost({ ...fs, sessionMessages: async () => messages });
    const h = harness({ contract: 'c' });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    messages = [humanPrompt('VALUE key=port: 5432'), assistantText('ok')];
    await turn(h, $);
    messages = [...messages, humanPrompt('go'), ...bulkyToolConversation(), humanPrompt('VALUE key=port: 5433'), assistantText('ok')];
    const res = (await withStrippedRuntimeGlobals(() => h['session.compact']($, { trigger: 'auto', messages } as CompactEvent, next))) as { messages?: SessionMessage[] };
    expect(next).not.toHaveBeenCalled();
    expect(latestValues(fs.files).port).toBe('5433');
    messages = [...(res.messages ?? []), humanPrompt('VALUE key=port: 5432'), assistantText('ok')];
    await turn(h, $);
    expect(latestValues(fs.files).port, 'reset back to 5432 after compaction must land, not be skipped as a stale sourceHash').toBe('5432');
  });

  it('finding 2: a budget fallback mid-turn persists the uncaptured VALUE before core summarizes it away', async () => {
    const fs = statefulFs();
    let messages: SessionMessage[] = [];
    const $ = fakeHost({ ...fs, sessionMessages: async () => messages });
    const h = harness({ contract: 'c' });
    messages = [humanPrompt('start'), assistantText('ok')];
    await turn(h, $);
    const call = assistantCall('Read', { input: { file: 'huge.ts' } });
    // Round 14 (spec v3.2.2): a tail message's oversized *tool-result* body is rebuilt to a small
    // pointer regardless of trigger (only the single last-assistant-turn message is ever exempt,
    // and even then only from losing its handle, not from cost accounting). So the overflow this
    // test needs must live in a plain `text` field, which rebuild never touches, not in a
    // toolResults body -- otherwise it would be pointerized away and the attempt would fit under
    // budget instead of falling back, defeating the point of this test.
    const smallResult = toolResultsMessage([{ toolUseId: call.toolUses[0].tool_use_id, options: { text: 'ok' } }]);
    messages = [...messages, humanPrompt('VALUE key=port: 5433'), ...bulkyToolConversation(), call, smallResult, assistantText(`huge final reply: ${'x'.repeat(60000)}`)];
    const next = vi.fn(async () => ({ messages: [{ role: 'user', text: 'core summary', toolUses: [] }] }) as unknown);
    await withStrippedRuntimeGlobals(() => h['session.compact']($, { trigger: 'auto', messages } as CompactEvent, next));
    expect(next, 'this attempt must exceed the tail budget and fall back to core').toHaveBeenCalled();
    messages = [{ role: 'user', text: 'core summary', toolUses: [] }, assistantText('done reading')];
    await turn(h, $);
    expect(latestValues(fs.files).port, 'VALUE given in the turn that fell back to core must not be lost').toBe('5433');
  });

  it('finding 3: a fresh session whose first compaction falls back to core does not capture the core summary as a verbatim user record', async () => {
    const fs = statefulFs();
    let messages: SessionMessage[] = [];
    const $ = fakeHost({ ...fs, sessionMessages: async () => messages });
    const h = harness({ contract: 'c' });
    const call = assistantCall('Read', { input: { file: 'huge.ts' } });
    const huge = toolResultsMessage([{ toolUseId: call.toolUses[0].tool_use_id, options: { text: 'x'.repeat(60000) } }]);
    messages = [humanPrompt('please read'), ...bulkyToolConversation(), call, huge];
    const summaryText = 'This session is being continued from a previous conversation. Summary: ...';
    const next = vi.fn(async () => ({ messages: [{ role: 'user', text: summaryText, toolUses: [] }] }) as unknown);
    await withStrippedRuntimeGlobals(() => h['session.compact']($, { trigger: 'auto', messages } as CompactEvent, next));
    messages = [{ role: 'user', text: summaryText, toolUses: [] }, assistantText('done')];
    await turn(h, $);
    const users = records(fs.files).filter((r) => r.kind === 'user').map((r) => String(r.body.text));
    expect(users.some((t) => t.startsWith('This session is being continued')), `users=${JSON.stringify(users)}`).toBe(false);
  });

  it('D (regression guard, already fixed): a repeated 3-sequence in the tail after an S4 compaction does not duplicate user history', async () => {
    const fs = statefulFs();
    let messages: SessionMessage[] = [];
    const $ = fakeHost({ ...fs, sessionMessages: async () => messages });
    const h = harness({ contract: 'c' });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    messages = [humanPrompt('go'), ...bulkyToolConversation(), humanPrompt('continue'), assistantText('Done.'), humanPrompt('continue'), assistantText('Done.'), humanPrompt('continue'), assistantText('Done.')];
    await turn(h, $);
    const res = (await withStrippedRuntimeGlobals(() => h['session.compact']($, { trigger: 'plugin', messages } as CompactEvent, next))) as { messages?: SessionMessage[] };
    expect(next).not.toHaveBeenCalled();
    const before = records(fs.files).filter((r) => r.kind === 'user').length;
    messages = [...(res.messages ?? []), humanPrompt('new ask'), assistantText('ok')];
    await turn(h, $);
    const after = records(fs.files).filter((r) => r.kind === 'user').length;
    expect(after).toBe(before + 1);
  });

  it('E (regression guard, already fixed): leftmost sequence match in a growing list with a repeated sub-sequence loses nothing', () => {
    const deps = { hash: sha256 };
    const m = [humanPrompt('c'), assistantText('D'), humanPrompt('c'), assistantText('D')];
    const w = reconcile(m, null, deps).watermark;
    const grown = [...m, humanPrompt('VALUE key=a: 1'), assistantText('D'), humanPrompt('c'), assistantText('D')];
    const r = reconcile(grown, w, deps);
    expect(r.records.some((x) => x.kind === 'value')).toBe(true);
  });
});

describe('compact.ts: round 14 (spec v3.2.2) end to end, through the real handler wiring', () => {
  it.each(['manual', 'plugin'] as const)('%s: a successful compaction returns a tail with no handle on any message, and the seed+tail total still fits TOTAL_BUDGET_TOKENS', async (trigger) => {
    const $ = fakeHost();
    const handlers = harness({ contract: 'c' });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger, messages: bulkyToolConversation() };
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next))) as { messages?: SessionMessage[] };
    expect(next, 'this conversation shrinks well past the 25% floor and must not fall back').not.toHaveBeenCalled();
    const messages = result.messages ?? [];
    expect(messages.length).toBeGreaterThan(1);
    // messages[0] is the freshly rendered seed message; every message after it is the picked tail.
    for (const message of messages.slice(1)) {
      expect((message as SessionMessage).handle, `${trigger}: every returned tail message must lose its handle`).toBeUndefined();
    }
    const countTokens = (text: string) => Math.ceil(text.length / 4);
    const totalTokens = messages.reduce((sum, message) => sum + countTokens((message as SessionMessage).text) + (message as SessionMessage).toolUses.reduce((n, tool) => n + (tool.input === undefined ? 0 : countTokens(JSON.stringify(tool.input) ?? '')), 0) + ((message as SessionMessage).toolResults ?? []).reduce((n, r) => n + countTokens(r.text), 0), 0);
    expect(totalTokens, `${trigger}: serialized seed+tail size (${totalTokens}) must stay within TOTAL_BUDGET_TOKENS`).toBeLessThanOrEqual(TOTAL_BUDGET_TOKENS);
  });

  it('auto: a successful compaction keeps exactly the last assistant turn handled, and no returned message is an empty-text assistant fragment', async () => {
    const $ = fakeHost();
    const handlers = harness({ contract: 'c' });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next))) as { messages?: SessionMessage[] };
    expect(next).not.toHaveBeenCalled();
    const messages = (result.messages ?? []) as SessionMessage[];
    const handledCount = messages.slice(1).filter((message) => message.handle !== undefined).length;
    expect(handledCount, 'auto keeps at most the one exempted last-assistant-turn message handled').toBeLessThanOrEqual(1);
    expect(messages.some((message) => message.role === 'assistant' && message.text === '' && message.toolUses.length === 0), 'no empty-text assistant fragment must ever be returned').toBe(false);
  });
});

describe('compact.ts: S3/S4 mutual exclusion (finding 10)', () => {
  it('finds the exclusion flag in a parent of the session cwd', async () => {
    const exists = vi.fn(async (path: string) => path === '/parent/.exovault/s4-compact-active');
    const $ = fakeHost({ fsExists: exists, sessionCwd: async () => '/parent/project' });
    const handlers = harness();
    const next = vi.fn(async () => ({ ok: true }) as unknown);
    const result = await withStrippedRuntimeGlobals(() => handlers['session.compact']($, { trigger: 'auto', messages: longConversation() }, next));
    expect(next).not.toHaveBeenCalled();
    expect((result as { messages?: unknown[] }).messages).toBeDefined();
    expect(exists).toHaveBeenCalledWith('/parent/.exovault/s4-compact-active');
  });

  it('is a pass-through to next(), doing no capture work at all, when the exclusion flag is absent', async () => {
    const fsRead = vi.fn(async (path: string) => {
      throw new Error(`ENOENT: ${path}`);
    });
    const fsWrite = vi.fn(async () => {});
    const $ = fakeHost({ fsRead, fsWrite });
    const handlers = harness({ contract: 'the contract' });
    const next = vi.fn(async () => ({ ok: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: [humanPrompt('hi')] };
    const result = await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next));
    expect(next).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true });
    expect(fsWrite, 'S4 must not write any capture record when setup never enabled the exclusion flag').not.toHaveBeenCalled();
  });
});

describe('compact.ts: flag semantics is presence, not content (round 4 finding 2)', () => {
  it('a flag file present with empty content still enables S4 capture, a successful read of any content means enabled', async () => {
    const fsRead = vi.fn(async (path: string) => (path === FLAG_PATH ? '' : ''));
    const fsWrite = vi.fn(async () => {});
    const $ = fakeHost({ fsRead, fsWrite });
    const handlers = harness({ contract: 'the contract' });
    const next = vi.fn(async () => ({ ok: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: [humanPrompt('VALUE key=x: 1'), assistantText('ok')] };
    await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next));
    expect(
      fsWrite,
      'CONTRACT: a successful $.fs.read of the flag means enabled, regardless of content; checking content === "1" wrongly disables S4 when the flag file is empty',
    ).toHaveBeenCalled();
  });
});

describe('compact.ts: session-scoped capture', () => {
  it('isolates seeds and watermarks between two sessions in one cwd', async () => {
    const files = new Map<string, string>();
    const current = { id: 'A' };
    const fsList = vi.fn(async (path = '') => [...files.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => ({ name: key.slice(path.length + 1), kind: 'file', size: files.get(key)!.length })));
    const fsRead = vi.fn(async (path: string) => path === FLAG_PATH ? '1' : files.get(path) ?? Promise.reject(new Error(`ENOENT: ${path}`)));
    const fsWrite = vi.fn(async (path: string, text: string) => { files.set(path, text); });
    const $ = fakeHost({ fsRead, fsWrite, fsList, sessionId: async () => current.id });
    const handlers = harness();
    const eventA: CompactEvent = { trigger: 'auto', messages: [...longConversation().slice(0, -2), humanPrompt('A-private capture instruction'), assistantText('A summary')] };
    await withStrippedRuntimeGlobals(() => handlers['session.compact']($, eventA, async () => ({}) as never));
    current.id = 'B';
    const eventB: CompactEvent = { trigger: 'auto', messages: [...longConversation().slice(0, -2), humanPrompt('B-only fresh prompt'), assistantText('B answer')] };
    const result = await withStrippedRuntimeGlobals(() => handlers['session.compact']($, eventB, async () => ({}) as never)) as { messages?: SessionMessage[] };
    expect(result.messages?.[0].text).toContain('B-only fresh prompt');
    expect(result.messages?.[0].text).not.toContain('A-private capture instruction');
    expect([...files.keys()].some((path) => path.includes('/A/segment-'))).toBe(true);
    expect([...files.keys()].some((path) => path.includes('/B/segment-'))).toBe(true);
  });
});

describe('compact.ts: capture read failures', () => {
  it('appendRecords rejects on an existing unreadable segment and leaves it untouched', async () => {
    const previous = 'previous captured bytes';
    const contents = new Map([['.exovault/s4-capture/session/segment-000001.json', previous]]);
    const write = vi.fn(async (path: string, text: string) => { contents.set(path, text); });
    const store = makeFsCaptureStore({
      read: async () => { throw new Error('EIO'); },
      write,
      exists: async () => true,
      list: async () => [{ name: 'segment-000001.json', kind: 'file', size: previous.length }],
    }, '.exovault/s4-capture/session');
    await expect(store.appendRecords([{ kind: 'user', origin: 'turn', producedBy: 's4-capture', sourceHash: 'hash', body: { text: 'new' } }], { identities: ['watermark'] })).rejects.toThrow('EIO');
    expect(write).not.toHaveBeenCalled();
    expect(contents.get('.exovault/s4-capture/session/segment-000001.json')).toBe(previous);
  });

  it('falls back to next and logs compact.fallback=error when an existing segment cannot be read', async () => {
    const log = vi.fn();
    const next = vi.fn(async () => ({ native: true }) as unknown);
    const fsRead = vi.fn(async (path: string) => {
      if (path === FLAG_PATH) return '1';
      if (path.endsWith('watermark.json')) return '{"watermark":null}';
      if (path.endsWith('segment-000001.json')) throw new Error('EIO');
      throw new Error(`ENOENT: ${path}`);
    });
    const $ = fakeHost({ fsRead, fsList: async () => [{ name: 'segment-000001.json', kind: 'file', size: 40 }], uiLog: log });
    const result = await withStrippedRuntimeGlobals(() => harness()['session.compact']($, { trigger: 'auto', messages: longConversation() }, next));
    expect(result).toEqual({ native: true });
    expect(next).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.some(([line]) => String(line).startsWith('compact.fallback='))).toBe(true);
  });

  it('falls back and logs compact.fallback=error if the runtime session id lookup fails', async () => {
    const log = vi.fn();
    const next = vi.fn(async () => ({ native: true }) as unknown);
    const $ = fakeHost({ fsExists: async (path) => path.endsWith('/.exovault/s4-compact-active'), uiLog: log, sessionId: async () => { throw new Error('session unavailable'); } });
    const result = await withStrippedRuntimeGlobals(() => harness()['session.compact']($, { trigger: 'auto', messages: longConversation() }, next));
    expect(result).toEqual({ native: true });
    expect(next).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.some(([line]) => String(line).startsWith('compact.fallback='))).toBe(true);
  });

  it('turn.complete skips a failed segment read without writing a new watermark', async () => {
    const writes: string[] = [];
    const fsRead = vi.fn(async (path: string) => {
      if (path.endsWith('/.exovault/s4-compact-active')) return '1';
      if (path.endsWith('watermark.json')) return '{"watermark":null}';
      if (path.endsWith('segment-000001.json')) throw new Error('EIO');
      throw new Error(`ENOENT: ${path}`);
    });
    const $ = fakeHost({ fsRead, fsExists: async (path) => path.endsWith('/.exovault/s4-compact-active'), fsList: async () => [{ name: 'segment-000001.json', kind: 'file', size: 40 }], fsWrite: async (path) => { writes.push(path); }, sessionMessages: async () => [humanPrompt('new prompt')] });
    const next = vi.fn(async () => ({ turn: true }) as unknown);
    const result = await withStrippedRuntimeGlobals(() => harness()['turn.complete']($, { reason: 'answer' }, next));
    expect(result).toEqual({ turn: true });
    expect(next).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
  });
});

describe('S4n: prompt.submit labels user messages asynchronously', () => {
  const prompt = { text: 'Typed request marker S4N_PRIVATE_93817', origin: { kind: 'composer' } };
  async function flushBackground(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }
  function activeHost(overrides: Parameters<typeof fakeHost>[0] = {}) {
    return fakeHost({
      fsExists: async (path) => path === '/project/.exovault/s4-compact-active',
      sessionCwd: async () => '/project',
      envGet: async (name) => name === 'TYPESAFE_API_KEY' ? 'test-api-key-never-log' : undefined,
      ...overrides,
    });
  }
  const successfulResponse = JSON.stringify({
    model: 'jev-1.13.0',
    answers: { label: { type: 'choice', choice: 'instruction', probabilities: { instruction: 0.8, question: 0.05, consent: 0.05, information: 0.05, chat: 0.05 } } },
  });

  it('returns next(input) immediately, passes the same object, and stores no message text', async () => {
    const files = new Map<string, string>();
    let releaseFetch!: (value: { status: number; ok: boolean; text: string }) => void;
    const fetch = vi.fn(() => new Promise<{ status: number; ok: boolean; text: string }>((resolve) => { releaseFetch = resolve; }));
    const write = vi.fn(async (path: string, text: string) => { files.set(path, text); });
    const $ = activeHost({ httpFetch: fetch, fsWrite: write });
    const handlers = harness({ jevEnabled: true });
    const next = vi.fn(async (event: unknown) => ({ passed: event }));
    const result = await withStrippedRuntimeGlobals(() => handlers['prompt.submit']($, prompt, next));
    expect(result).toEqual({ passed: prompt });
    expect(next).toHaveBeenCalledWith(prompt);
    await flushBackground();
    expect(fetch).toHaveBeenCalledTimes(1);
    releaseFetch({ status: 200, ok: true, text: successfulResponse });
    await flushBackground();
    expect(write).toHaveBeenCalledTimes(1);
    const [path, contents] = [...files.entries()][0];
    expect(path).toContain('/labels.jsonl');
    expect(contents).not.toContain('S4N_PRIVATE_93817');
    expect(JSON.parse(contents)).toEqual({ key: labelKey(prompt.text, sha256), label: 'instruction', p: 0.8, model: 'jev-1.13.0' });
  });

  it('labels Remote Control prompts and sends the redacted text only', async () => {
    const files = new Map<string, string>();
    const fetch = vi.fn(async () => ({ status: 200, ok: true, text: successfulResponse }));
    const $ = activeHost({ httpFetch: fetch, fsWrite: async (path: string, text: string) => { files.set(path, text); } });
    const handlers = harness({ jevEnabled: true });
    const input = { text: 'deploy with api_key=S4N_SECRET_7781 please', origin: { kind: 'bridge' } };
    await withStrippedRuntimeGlobals(() => handlers['prompt.submit']($, input, async () => ({})));
    await flushBackground();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fetch.mock.calls[0])).not.toContain('S4N_SECRET_7781');
    const stored = JSON.parse([...files.values()][0]);
    expect(stored.key).toBe(labelKey(capturedUserText(input.text), sha256));
  });

  it.each([
    ['not typed by a person (sdk)', { origin: { kind: 'sdk' } }, true, '/project', undefined],
    ['a task notification', { origin: { kind: 'task-notification' } }, true, '/project', undefined],
    ['capture flag off', {}, false, '/project', undefined],
    ['Jev disabled', {}, true, '/project', false],
    ['cwd denied', {}, true, '/project/client-acme/repo', true],
    ['no condensed key', { text: '[[exovault:s4-seed:v1]] internal seed' }, true, '/project', true],
  ] as const)('does not fetch when %s', async (_name, event, captureOn, cwd, jevEnabled) => {
    const log = vi.fn();
    const fetch = vi.fn(async () => ({ status: 200, ok: true, text: successfulResponse }));
    const $ = fakeHost({
      fsExists: async (path) => !captureOn && path === '/project/.exovault/s4-compact-off',
      sessionCwd: async () => cwd,
      envGet: async () => 'test-api-key',
      httpFetch: fetch,
      uiLog: log,
    });
    const handlers = harness({ jevEnabled: jevEnabled ?? true, jevDenyList: 'client-acme' });
    const next = vi.fn(async (input: unknown) => input);
    const input = { ...prompt, ...event };
    const result = await withStrippedRuntimeGlobals(() => handlers['prompt.submit']($, input, next));
    expect(result).toBe(input);
    await flushBackground();
    expect(fetch).not.toHaveBeenCalled();
    // Skips are silent: a transcript line on every prompt would be noise.
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ['fetch failure', async () => { throw new Error('private response text'); }, undefined],
    ['HTTP 500', async () => ({ status: 500, ok: false, text: 'private body' }), undefined],
    ['malformed JSON', async () => ({ status: 200, ok: true, text: '{' }), undefined],
    ['unknown option', async () => ({ status: 200, ok: true, text: JSON.stringify({ model: 'jev-1.13.0', answers: { label: { type: 'choice', choice: 'other', probabilities: { other: 1 } } } }) }), undefined],
    ['low probability', async () => ({ status: 200, ok: true, text: JSON.stringify({ model: 'jev-1.13.0', answers: { label: { type: 'choice', choice: 'question', probabilities: { question: 0.59 } } } }) }), undefined],
    ['timeout', async () => new Promise<{ status: number; ok: boolean; text: string }>(() => {}), 'timeout'],
  ] as const)('leaves no label for %s and logs a safe outcome', async (_name, httpFetch, timeout) => {
    const write = vi.fn(async () => {});
    const log = vi.fn();
    const after = vi.fn((_ms: number, callback: () => void) => {
      if (timeout) callback();
      return { cancel: vi.fn() };
    });
    const $ = activeHost({ httpFetch, fsWrite: write, uiLog: log, clockAfter: after });
    const handlers = harness({ jevEnabled: true });
    await withStrippedRuntimeGlobals(() => handlers['prompt.submit']($, prompt, async () => ({})));
    await flushBackground();
    expect(write).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^labels\.jev=/));
    expect(log.mock.calls.flat().join(' ')).not.toContain('S4N_PRIVATE_93817');
    expect(log.mock.calls.flat().join(' ')).not.toContain('private response text');
  });
});

describe('S4n: labels filter seed sources with 3.13 fallback', () => {
  function userRecord(text: string, suffix: string) {
    return { kind: 'user', origin: 'reconcile', producedBy: 's4-capture', sourceHash: `label-${suffix}`, body: { text } };
  }
  async function cut(records: unknown[], labelsText?: string, options: Record<string, unknown> = {}) {
    const segment = records.map((record) => JSON.stringify(record)).join('\n');
    const fsList = vi.fn(async () => [{ name: 'segment-000001.json', kind: 'file', size: segment.length }]);
    const fsRead = vi.fn(async (path: string) => {
      if (path === FLAG_PATH) return '1';
      if (path.endsWith('segment-000001.json')) return segment;
      if (path.endsWith('/labels.jsonl') && labelsText !== undefined) return labelsText;
      throw new Error(`ENOENT: ${path}`);
    });
    const fsExists = vi.fn(async (path: string) => path.endsWith('/.exovault/s4-compact-active') || (path.endsWith('/labels.jsonl') && labelsText !== undefined));
    const log = vi.fn();
    const $ = fakeHost({ fsList, fsRead, fsExists, uiLog: log });
    const handlers = harness({ contract: 'c', ...options });
    const result = await withStrippedRuntimeGlobals(() => handlers['session.compact']($, { trigger: 'auto', messages: bulkyToolConversation() } as CompactEvent, async () => ({ fallback: true })));
    return { seed: (result as { messages?: SessionMessage[] }).messages?.[0]?.text ?? '', log };
  }
  const labelLine = (text: string, label: string) => JSON.stringify({ key: labelKey(text, sha256), label });
  const section = (seed: string, heading: string) => seed.match(new RegExp(`## ${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |\\n<\\/session-memory>)`))?.[1] ?? '';

  it('omits labelled questions and consents from Constraints, while unlabelled records retain 3.13 behavior', async () => {
    const question = 'Zastanawiam się, czy deployujemy tylko na main';
    const consent = 'ok, rób. The migration must wait until QA approves.';
    const mixedQuestion = 'Możesz to zrobić dzisiaj? Tylko nie ruszaj prod.';
    const records = [userRecord(question, 'q'), userRecord(consent, 'c'), userRecord(mixedQuestion, 'mq')];
    const labelled = await cut(records, [labelLine(question, 'question'), labelLine(consent, 'consent'), labelLine(mixedQuestion, 'question')].join('\n'));
    expect(labelled.log.mock.calls.flat().filter((line) => String(line).startsWith('labels.'))).toEqual(['labels.applied=3 labels.missing=0']);
    expect(section(labelled.seed, 'Constraints')).not.toContain('deployujemy tylko na main');
    // One label on a mixed message never drops the rule it carries (review of 3.14.0, finding 4).
    expect(section(labelled.seed, 'Constraints')).not.toContain('ok, rób');
    expect(section(labelled.seed, 'Constraints')).toContain('must wait until QA approves');
    expect(section(labelled.seed, 'Constraints')).toContain('nie ruszaj prod');
    expect(section(labelled.seed, 'Constraints')).not.toContain('zrobić dzisiaj');
    const unlabelled = await cut(records);
    expect(section(unlabelled.seed, 'Constraints')).toContain('deployujemy tylko na main');
    expect(section(unlabelled.seed, 'Constraints')).toContain('must wait until QA approves');
  });

  it('omits labelled question facts from Key facts and drops chat history except for the last three', async () => {
    const factQuestion = 'I wonder whether PROJECT2 operates only on staging';
    const chatFact = 'The project codename is PROJECT3-44.';
    const chat = ['Thanks for that.', 'Hello there.', 'What a day.', 'Could you inspect PROJECT2?'];
    const records = [userRecord(factQuestion, 'fq'), userRecord(chatFact, 'chat-fact'), ...chat.map((text, i) => userRecord(text, `chat-${i}`))];
    const labelled = await cut(records, [labelLine(factQuestion, 'question'), labelLine(chatFact, 'chat'), labelLine(chat[0], 'chat'), labelLine(chat[3], 'chat')].join('\n'));
    expect(section(labelled.seed, 'Key facts')).not.toContain('PROJECT2 operates only on staging');
    expect(section(labelled.seed, 'Key facts')).not.toContain('PROJECT3-44');
    expect(labelled.seed).not.toContain('Thanks for that.');
    expect(labelled.seed).toContain('Hello there.');
    expect(labelled.seed).toContain('Could you inspect PROJECT2?');
    const unlabelled = await cut(records);
    expect(section(unlabelled.seed, 'Key facts')).toContain('PROJECT3-44');
  });

  it('dense mode keeps labelled consents and chat out of Working notes, and labels reach the selector', async () => {
    const consent = 'ok go ahead and push src/deploy-gate.ts to origin/release-7 with --force-with-lease';
    const chat = 'haha nice, src/banter-module.ts and --silly-flag were fun';
    // Twenty later messages push both out of the quoted user history, which dense notes skip.
    const later = Array.from({ length: 20 }, (_, i) => userRecord(`later message ${i} about src/later-${i}.ts`, `later-${i}`));
    const records = [userRecord(consent, 'dc'), userRecord(chat, 'dchat'), ...later];
    const labelled = await cut(records, [labelLine(consent, 'consent'), labelLine(chat, 'chat')].join('\n'), { denseNotes: true });
    const notes = section(labelled.seed, 'Working notes');
    expect(labelled.seed).toContain('## Working notes');
    expect(labelled.seed).not.toContain('force-with-lease');
    expect(notes).not.toContain('force-with-lease');
    expect(notes).not.toContain('banter-module');
    const unlabelled = await cut(records, undefined, { denseNotes: true });
    expect(section(unlabelled.seed, 'Working notes')).toContain('force-with-lease');
    expect(section(unlabelled.seed, 'Working notes')).toContain('Earlier user wording (quoted, not requests):');
  });

  it('treats a corrupt labels file as if no labels were stored', async () => {
    const question = 'Zastanawiam się, czy deployujemy tylko na main';
    const { seed } = await cut([userRecord(question, 'corrupt')], '{invalid json');
    expect(section(seed, 'Constraints')).toContain('deployujemy tylko na main');
  });
});

describe('compact.ts: cleared todos are filtered out of the rendered Todo section (round 7 D10)', () => {
  it('a cleared todo does not appear in the seed while a pending one in the same batch does', async () => {
    const pending = { kind: 'todo', origin: 'reconcile', producedBy: 's4-capture', sourceHash: 'h1', body: { id: 'todo-pending', status: 'pending' } };
    const cleared = { kind: 'todo', origin: 'reconcile', producedBy: 's4-capture', sourceHash: 'h2', body: { id: 'todo-cleared', status: 'cleared' } };
    const fsList = vi.fn(async () => [{ name: 'segment-000001.json', kind: 'file', size: 1 }]);
    const fsRead = vi.fn(async (path: string) => {
      if (path === FLAG_PATH) return '1';
      if (path.endsWith('segment-000001.json')) return `${JSON.stringify(pending)}\n${JSON.stringify(cleared)}\n`;
      throw new Error(`ENOENT: ${path}`);
    });
    const $ = fakeHost({ fsList, fsRead });
    const handlers = harness({ contract: 'the contract' });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: longConversation() };
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next))) as { messages?: SessionMessage[] };
    expect(next, 'this conversation shrinks well past the 25% floor and must not fall back').not.toHaveBeenCalled();
    const seed = result.messages?.[0];
    expect(seed?.text.includes('todo-pending')).toBe(true);
    expect(seed?.text.includes('todo-cleared'), 'a cleared todo must not appear in the rendered Todo section').toBe(false);
  });
});

describe('compact.ts: turn.complete looks up the session id fresh on every call, not cached (round 7 D10)', () => {
  it('captures two consecutive turns from two different sessions into two different per-session directories', async () => {
    const writes: string[] = [];
    let current = 'A';
    const fsWrite = vi.fn(async (path: string) => { writes.push(path); });
    const $ = fakeHost({ fsWrite, sessionId: async () => current, sessionMessages: async () => [humanPrompt(`prompt from ${current}`)] });
    const handlers = harness();
    const next = vi.fn(async () => ({ ok: true }) as unknown);
    await withStrippedRuntimeGlobals(() => handlers['turn.complete']($, { reason: 'answer' }, next));
    current = 'B';
    await withStrippedRuntimeGlobals(() => handlers['turn.complete']($, { reason: 'answer' }, next));
    expect(writes.some((path) => path.includes('/A/')), 'the first turn must persist under session A\'s own capture directory').toBe(true);
    expect(writes.some((path) => path.includes('/B/')), 'the second turn must persist under session B\'s own capture directory, not a baseDir cached from the first call').toBe(true);
  });
});

describe('compact.ts: render-time segment read is sorted by name (round 7 D8)', () => {
  it('a newer segment listed before an older one in $.fs.list still wins for the same todo id', async () => {
    const older = { kind: 'todo', origin: 'reconcile', producedBy: 's4-capture', sourceHash: 'h1', body: { id: 'todo1', status: 'pending' } };
    const newer = { kind: 'todo', origin: 'reconcile', producedBy: 's4-capture', sourceHash: 'h2', body: { id: 'todo1', status: 'cleared' } };
    const fsList = vi.fn(async () => [
      { name: 'segment-000002.json', kind: 'file', size: 1 },
      { name: 'segment-000001.json', kind: 'file', size: 1 },
    ]);
    const fsRead = vi.fn(async (path: string) => {
      if (path === FLAG_PATH) return '1';
      if (path.endsWith('segment-000001.json')) return `${JSON.stringify(older)}\n`;
      if (path.endsWith('segment-000002.json')) return `${JSON.stringify(newer)}\n`;
      throw new Error(`ENOENT: ${path}`);
    });
    const fsWrite = vi.fn(async () => {});
    const $ = fakeHost({ fsList, fsRead, fsWrite });
    const handlers = harness({ contract: 'the contract' });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: longConversation() };
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next))) as { messages?: SessionMessage[] };
    expect(next, 'this conversation shrinks well past the 25% floor and must not fall back').not.toHaveBeenCalled();
    const seed = result.messages?.[0];
    expect(seed?.text.includes('"id":"todo1"'), 'the newer segment (cleared) must win regardless of $.fs.list order; an unsorted render-time read lets the older pending todo overwrite it').toBe(false);
  });
});

describe('compact.ts: turn.complete capture work is bounded by a timeout, end to end (round 7 D4)', () => {
  it('skips capture, logs capture.timeout, and still returns next()\'s result when the reconcile pipeline hangs', async () => {
    const log = vi.fn();
    const writes: string[] = [];
    const fsWrite = vi.fn(async (path: string) => { writes.push(path); });
    const sleep = (_ms: number, { signal }: { signal: AbortSignal }) => new Promise<void>((resolve, reject) => {
      Promise.resolve().then(() => { if (!signal.aborted) resolve(); });
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const $ = fakeHost({
      fsWrite,
      uiLog: log,
      clockSleep: sleep,
      sessionMessages: () => new Promise<SessionMessage[]>(() => {}),
    });
    const handlers = harness({ contract: 'the contract', timeoutMs: 10 });
    const next = vi.fn(async () => ({ turnResult: true }) as unknown);
    const result = await withStrippedRuntimeGlobals(() => handlers['turn.complete']($, { reason: 'answer' }, next));
    expect(result).toEqual({ turnResult: true });
    expect(next).toHaveBeenCalledTimes(1);
    expect(writes, 'a timed-out capture must not advance the watermark or write any segment').toEqual([]);
    expect(log.mock.calls.some(([line]) => line === 'capture.timeout'), 'a hung reconcile pipeline must be logged distinctly as capture.timeout, not silently dropped or confused with compact.fallback=error').toBe(true);
  });
});

it('captures the completed turn before passing control to the separate soft-trigger module', async () => {
  const order: string[] = [];
  const fsWrite = vi.fn(async () => { order.push('capture-write'); });
  const $ = fakeHost({ fsWrite, sessionMessages: async () => [humanPrompt('completed prompt')] });
  const next = vi.fn(async () => { order.push('next-trigger-module'); return { ok: true }; });
  await withStrippedRuntimeGlobals(() => harness()['turn.complete']($, { reason: 'answer' }, next));
  expect(order.indexOf('capture-write')).toBeGreaterThanOrEqual(0);
  expect(order.indexOf('capture-write')).toBeLessThan(order.indexOf('next-trigger-module'));
});

it('plugin manifest declares each compact option with the matching option type', async () => {
  const isBroken = process.env.S4_GATE_IMPL === 'broken';
  const manifestPath = isBroken ? new URL('./broken/plugin.json', import.meta.url) : new URL('../.claude-plugin/plugin.json', import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { userConfig?: Record<string, { type?: string; default?: unknown }> };
  // Round 10: `trigger.ts` moved to its own plugin (`exovault-s4-trigger`), so its
  // softThresholdPercent/compactWindowTokens options are no longer part of THIS manifest; see
  // compact-trigger/__gate-s4__/trigger.gate.test.ts's own copy of this test for those two.
  const source = `${readFileSync(new URL('../compact.ts', import.meta.url), 'utf8')}\n${readFileSync(new URL('../core/handler.ts', import.meta.url), 'utf8')}`;
  const readNames = new Set([
    ...[...source.matchAll(/options\.([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]),
    ...[...source.matchAll(/optionNumber\(options,\s*'([^']+)'/g)].map((match) => match[1]),
    // Selector J (spec v3.4 §3.3): jevEnabled/jevDenyList/jevModel are read through
    // optionBoolean/optionString, not options.<name> or optionNumber, so this scan needs its own
    // patterns for them, same as optionNumber's above.
    ...[...source.matchAll(/optionBoolean\(options,\s*'([^']+)'/g)].map((match) => match[1]),
    ...[...source.matchAll(/optionString\(options,\s*'([^']+)'/g)].map((match) => match[1]),
  ]);
  const types: Record<string, string> = {
    recallEnabled: 'boolean',
    briefCheck: 'boolean',
    briefPush: 'boolean',
    ruleCheck: 'boolean',
    briefLimits: 'boolean',
    sessionPush: 'boolean',
    recallVectors: 'boolean',
    interactiveOnly: 'boolean',
    notices: 'string',
    recallPluginRoot: 'string',
    timeoutMs: 'number',
    retentionDays: 'number',
    contract: 'string',
    denseNotes: 'boolean',
    workState: 'boolean',
    currentValues: 'boolean',
    sessionMap: 'boolean',
    totalBudgetTokens: 'number',
    taskBriefs: 'boolean',
    fullBrief: 'boolean',
    briefDigestModel: 'string',
    workStateProbe: 'boolean',
    adoptedFiles: 'boolean',
    toolOutputNotes: 'boolean',
    realTokenCount: 'boolean',
    taskCard: 'boolean',
    sinceCard: 'boolean',
    lateCardRefresh: 'boolean',
    recipes: 'boolean',
    cutOnNewBrief: 'boolean',
    cardTotalBudgetTokens: 'number',
    jevEnabled: 'boolean',
    jevDenyList: 'string',
    jevModel: 'string',
    jevPerCallTimeoutMs: 'number',
    jevTotalBudgetMs: 'number',
    jevDenseRerank: 'boolean',
    jevDensePerCallTimeoutMs: 'number',
    jevDenseTotalBudgetMs: 'number',
  };
  expect([...readNames].sort()).toEqual(Object.keys(types).sort());
  // The live gate's force override comes through the environment: users never see it as an option.
  expect(Object.keys(manifest.userConfig ?? {}).filter((name) => /^gate/i.test(name))).toEqual([]);
  for (const name of readNames) expect(manifest.userConfig?.[name]?.type, `${name} must be declared with type ${types[name]}`).toBe(types[name]);
  expect(manifest.userConfig?.recallEnabled?.default).toBe(true); // 4.8.0: a native install needs no userConfig step
  expect(manifest.userConfig?.denseNotes?.default).toBe(true);
  expect(manifest.userConfig?.toolOutputNotes?.default).toBe(true);
  expect(manifest.userConfig?.workState?.default).toBe(true);
  expect(manifest.userConfig?.workStateProbe?.default).toBe(true);
  expect(manifest.userConfig?.jevDenseRerank?.default).toBe(true);
  expect(manifest.userConfig?.jevDensePerCallTimeoutMs?.default).toBe(3000);
  expect(manifest.userConfig?.jevDenseTotalBudgetMs?.default).toBe(5000);
  expect(manifest.userConfig?.recipes?.default).toBe(true); // 4.7.2
  expect(manifest.userConfig?.lateCardRefresh?.default).toBe(false);
});

/**
 * Round 10: the real debug log of Claude Code 2.1.280 refuses a second `hooks.json` `modules`
 * entry ("hooks.json `modules` names one hooks module per plugin; a second entry is refused"),
 * which is why `trigger.ts` now lives in its own plugin directory, `../../compact-trigger/`,
 * instead of sharing this one's `hooks.json`. This test guards the invariant that made that split
 * necessary in the first place, across every `compact*` plugin directory under `proxy/hooks/`, not
 * just this one.
 */
it('round 10: every hooks.json under proxy/hooks/compact* lists exactly one module', () => {
  const hooksRoot = new URL('../../', import.meta.url); // proxy/hooks/
  const dirs = readdirSync(hooksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('compact'))
    .map((entry) => entry.name)
    .sort();
  expect(dirs).toEqual(['compact', 'compact-trigger']);
  for (const dir of dirs) {
    const hooks = JSON.parse(readFileSync(new URL(`../../${dir}/hooks/hooks.json`, import.meta.url), 'utf8')) as { modules?: string[] };
    expect(hooks.modules, `${dir}/hooks/hooks.json`).toHaveLength(1);
  }
});

it('registers the S4a compaction hook and the soft trigger in their own separate plugins', () => {
  const compactHooks = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8')) as { modules?: string[] };
  expect(compactHooks.modules).toEqual(['../compact.ts']);
  const triggerHooks = JSON.parse(readFileSync(new URL('../../compact-trigger/hooks/hooks.json', import.meta.url), 'utf8')) as { modules?: string[] };
  expect(triggerHooks.modules).toEqual(['../trigger.ts']);
});

/** 4.9.2: the recall launcher's runs, without the harden.mjs runs (host/capture-mode.ts) the same hooks start. */
const launches = (run: { mock: { calls: unknown[][] } }) => run.mock.calls.filter((call) => String((call[0] as string[])[1]).endsWith('/recall/launch.mjs')) as [string[], unknown][];

describe('compact.ts: S4d transcript pointer wiring (spec §3.1.2)', () => {
  it('recallEnabled starts only the detached launcher and points the seed at the MCP recall tool', async () => {
    const processRun = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const fsExists = vi.fn(async (target: string) => target.endsWith('/.exovault/s4-compact-active') || target.endsWith('.jsonl'));
    const $ = fakeHost({ fsExists, processRun, pluginRoot: '/plugins/exo-compact', envGet: async (name) => name === 'HOME' ? '/home/u' : undefined });
    const handlers = harness({ contract: 'the contract', recallEnabled: true, workStateProbe: false });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next))) as { messages?: SessionMessage[] };
    expect(launches(processRun)).toHaveLength(1);
    expect(launches(processRun)[0][0]).toEqual(['node', '/plugins/exo-compact/recall/launch.mjs', expect.stringContaining('/.claude/projects/'), '/home/u/.claude/exovault/recall', 'session-default', 'vectors', 'cut', '30']);
    expect(launches(processRun)[0][1]).toEqual({ timeoutMs: 5000 });
    expect(result.messages?.[0].text).toContain('search_session tool (server recall) using session "session-default"');
    expect(result.messages?.[0].text).not.toContain('recall.mjs');
  });

  it('turn.complete refreshes the recall index after an answer (turn trigger), and not when recall is off', async () => {
    const processRun = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const fsExists = vi.fn(async (target: string) => target.endsWith('/.exovault/s4-compact-active') || target.endsWith('.jsonl'));
    const envGet = async (name: string) => name === 'HOME' ? '/home/u' : undefined;
    const pluginRoot = '/plugins/exo-compact';
    const $ = fakeHost({ fsExists, processRun, envGet, pluginRoot });
    await withStrippedRuntimeGlobals(() => harness({ recallEnabled: true, recallVectors: false })['turn.complete']($, { reason: 'answer' }, async () => ({})));
    expect(launches(processRun)).toHaveLength(1);
    expect(launches(processRun)[0][0]).toEqual(['node', '/plugins/exo-compact/recall/launch.mjs', expect.stringContaining('/.claude/projects/'), '/home/u/.claude/exovault/recall', 'session-default', 'lexical', 'turn', '30']);
    const processRunOff = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    await withStrippedRuntimeGlobals(() => harness({})['turn.complete'](fakeHost({ fsExists, processRun: processRunOff, envGet, pluginRoot }), { reason: 'answer' }, async () => ({})));
    expect(launches(processRunOff)).toHaveLength(0);
  });

  it('retentionDays reaches the launcher at a cut and after an answer; 0 turns retention off', async () => {
    const fsExists = vi.fn(async (target: string) => target.endsWith('/.exovault/s4-compact-active') || target.endsWith('.jsonl'));
    const envGet = async (name: string) => name === 'HOME' ? '/home/u' : undefined;
    const pluginRoot = '/plugins/exo-compact';
    const cutRun = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    await withStrippedRuntimeGlobals(() => harness({ contract: 'the contract', recallEnabled: true, workStateProbe: false, retentionDays: 0 })['session.compact'](fakeHost({ fsExists, processRun: cutRun, envGet, pluginRoot }), { trigger: 'auto', messages: bulkyToolConversation() } as CompactEvent, next));
    expect(launches(cutRun)[0][0].slice(-2)).toEqual(['cut', '0']);
    const turnRun = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    await withStrippedRuntimeGlobals(() => harness({ recallEnabled: true, retentionDays: 7 })['turn.complete'](fakeHost({ fsExists, processRun: turnRun, envGet, pluginRoot }), { reason: 'answer' }, async () => ({})));
    expect(launches(turnRun)[0][0].slice(-2)).toEqual(['turn', '7']);
  });

  it('turn capture writes .exovault/.gitignore next to the captures, once per root', async () => {
    const written: string[] = [];
    const files = new Map<string, string>();
    const fsExists = vi.fn(async (target: string) => target.endsWith('/.exovault/s4-compact-active') || files.has(target));
    const fsWrite = vi.fn(async (target: string, text: string) => { written.push(target); files.set(target, text); });
    const $ = fakeHost({ fsExists, fsWrite, fsRead: async (target) => files.get(target) ?? '', sessionMessages: async () => [humanPrompt('hello'), assistantText('hi')] });
    const handlers = harness({ recallEnabled: false });
    await withStrippedRuntimeGlobals(() => handlers['turn.complete']($, { reason: 'answer' }, async () => ({})));
    await withStrippedRuntimeGlobals(() => handlers['turn.complete']($, { reason: 'answer' }, async () => ({})));
    const ignores = written.filter((target) => target.endsWith('/.exovault/.gitignore'));
    expect(ignores).toHaveLength(1);
    expect(files.get(ignores[0])).toBe(CAPTURE_GITIGNORE);
  });

  it('4.9.2: $.plugin.root wins, CLAUDE_PLUGIN_ROOT from a project env block is ignored, recallPluginRoot is only a safe absolute fallback', async () => {
    const fsExists = vi.fn(async (target: string) => target.endsWith('/.exovault/s4-compact-active') || target.endsWith('.jsonl'));
    // A cloned repository's .claude/settings.json `env` block reaches $.env.get for the whole session.
    const hostileEnv = async (name: string) => name === 'HOME' ? '/home/u' : name === 'CLAUDE_PLUGIN_ROOT' ? '/tmp/evil-env' : undefined;
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const cut = (options: Record<string, unknown>, $: ReturnType<typeof fakeHost>) =>
      withStrippedRuntimeGlobals(() => harness({ contract: 'the contract', recallEnabled: true, workStateProbe: false, ...options })['session.compact']($, { trigger: 'auto', messages: bulkyToolConversation() } as CompactEvent, next));

    const engineRun = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    await cut({ recallPluginRoot: '/explicit/plugin' }, fakeHost({ fsExists, processRun: engineRun, envGet: hostileEnv, pluginRoot: '/plugins/exo-compact/' }));
    expect(engineRun.mock.calls[0][0][1]).toBe('/plugins/exo-compact/recall/launch.mjs');

    const optionRun = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    await cut({ recallPluginRoot: '/explicit/plugin' }, fakeHost({ fsExists, processRun: optionRun, envGet: hostileEnv }));
    expect(optionRun.mock.calls[0][0][1]).toBe('/explicit/plugin/recall/launch.mjs');

    for (const unsafe of ['relative/plugin', '/opt/../tmp/evil', '']) {
      const log = vi.fn();
      const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
      await cut({ recallPluginRoot: unsafe }, fakeHost({ fsExists, processRun: run, uiLog: log, envGet: hostileEnv }));
      expect(run, unsafe).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith('recall.build_started=0 reason=no_plugin_root');
    }
  });

  it('is rendered in the seed when the derived transcript file exists', async () => {
    const log = vi.fn();
    const fsExists = vi.fn(async (path: string) => path.endsWith('/.exovault/s4-compact-active') || path.endsWith('.jsonl'));
    const $ = fakeHost({ fsExists, uiLog: log, envGet: async (name) => (name === 'HOME' ? '/home/u' : undefined), sessionCwd: async () => '/workspace/project', sessionId: async () => 'sess-1' });
    const handlers = harness({ contract: 'the contract' });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next))) as { messages?: SessionMessage[] };
    const seed = result.messages?.[0];
    expect(seed?.text).toContain('/home/u/.claude/projects/-workspace-project/sess-1.jsonl');
    expect(log.mock.calls.some(([line]) => line === 'seed.transcript_pointer=missing')).toBe(false);
  });

  it('is omitted, and seed.transcript_pointer=missing is logged, when the file does not exist', async () => {
    const log = vi.fn();
    const fsExists = vi.fn(async (path: string) => path.endsWith('/.exovault/s4-compact-active'));
    const $ = fakeHost({ fsExists, uiLog: log, envGet: async (name) => (name === 'HOME' ? '/home/u' : undefined) });
    const handlers = harness({ contract: 'the contract' });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next))) as { messages?: SessionMessage[] };
    const seed = result.messages?.[0];
    expect(seed?.text).not.toContain('.claude/projects');
    expect(log.mock.calls.some(([line]) => line === 'seed.transcript_pointer=missing')).toBe(true);
  });

  it('is omitted and logged as missing when HOME is unavailable (nothing to derive from)', async () => {
    const log = vi.fn();
    const $ = fakeHost({ uiLog: log });
    const handlers = harness({ contract: 'the contract' });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next))) as { messages?: SessionMessage[] };
    const seed = result.messages?.[0];
    expect(seed?.text).not.toContain('.claude/projects');
    expect(log.mock.calls.some(([line]) => line === 'seed.transcript_pointer=missing')).toBe(true);
  });
});

describe('compact.ts: S4d constraints wiring (spec §3.1.1)', () => {
  it('a constraint stated by the user is mandatory in the rendered seed', async () => {
    const record = { kind: 'user', origin: 'reconcile', producedBy: 's4-capture', sourceHash: 'fixture-hash-c1', body: { text: 'You must never delete the production backups.' } };
    const fsList = vi.fn(async () => [{ name: 'segment-000001.json', kind: 'file', size: 1 }]);
    const fsRead = vi.fn(async (path: string) => {
      if (path === FLAG_PATH) return '1';
      if (path.endsWith('segment-000001.json')) return `${JSON.stringify(record)}\n`;
      throw new Error(`ENOENT: ${path}`);
    });
    const $ = fakeHost({ fsList, fsRead });
    const handlers = harness({ contract: 'the contract' });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next))) as { messages?: SessionMessage[] };
    const seed = result.messages?.[0];
    expect(seed?.text).toContain('Constraints (history)');
    expect(seed?.text).toContain('delete the production backups');
  });

  it('logs seed.constraints_overflow=<n> when constraints alone exceed the 2k overflow budget', async () => {
    const log = vi.fn();
    const records = Array.from({ length: 200 }, (_, i) => ({
      kind: 'user',
      origin: 'reconcile',
      producedBy: 's4-capture',
      sourceHash: `fixture-hash-overflow-${i}`,
      body: { text: `Constraint number ${i} says you must always keep this specific invariant number ${i} true forever no matter what.` },
    }));
    const fsList = vi.fn(async () => [{ name: 'segment-000001.json', kind: 'file', size: 1 }]);
    const fsRead = vi.fn(async (path: string) => {
      if (path === FLAG_PATH) return '1';
      if (path.endsWith('segment-000001.json')) return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
      throw new Error(`ENOENT: ${path}`);
    });
    const $ = fakeHost({ fsList, fsRead, uiLog: log });
    const handlers = harness({ contract: 'the contract' });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next));
    expect(log.mock.calls.some(([line]) => /^seed\.constraints_overflow=[1-9]\d*$/.test(String(line)))).toBe(true);
  });
});

describe('compact.ts: round 17 key facts wiring (spec v3.3 §3.1.3, brief-s4a-fix17.md)', () => {
  it('a plain fact stated by the user is mandatory in the rendered seed\'s Key facts section', async () => {
    const record = { kind: 'user', origin: 'reconcile', producedBy: 's4-capture', sourceHash: 'fixture-hash-kf1', body: { text: 'The project codename is Project KESTREL-9.' } };
    const fsList = vi.fn(async () => [{ name: 'segment-000001.json', kind: 'file', size: 1 }]);
    const fsRead = vi.fn(async (path: string) => {
      if (path === FLAG_PATH) return '1';
      if (path.endsWith('segment-000001.json')) return `${JSON.stringify(record)}\n`;
      throw new Error(`ENOENT: ${path}`);
    });
    const $ = fakeHost({ fsList, fsRead });
    const handlers = harness({ contract: 'the contract' });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next))) as { messages?: SessionMessage[] };
    const seed = result.messages?.[0];
    expect(seed?.text).toContain('Key facts');
    expect(seed?.text).toContain('Project KESTREL-9');
  });

  it('a fact stated only inside a Write tool_use input (file_write) also reaches the Key facts section', async () => {
    const record = { kind: 'file_write', origin: 'reconcile', producedBy: 's4-capture', sourceHash: 'fixture-hash-kf2', body: { text: 'Owner: Alice Morgan.', tool_use_id: 'toolu_1', tool: 'Write' } };
    const fsList = vi.fn(async () => [{ name: 'segment-000001.json', kind: 'file', size: 1 }]);
    const fsRead = vi.fn(async (path: string) => {
      if (path === FLAG_PATH) return '1';
      if (path.endsWith('segment-000001.json')) return `${JSON.stringify(record)}\n`;
      throw new Error(`ENOENT: ${path}`);
    });
    const $ = fakeHost({ fsList, fsRead });
    const handlers = harness({ contract: 'the contract' });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next))) as { messages?: SessionMessage[] };
    const seed = result.messages?.[0];
    expect(seed?.text).toContain('Alice Morgan');
  });

  it('logs seed.facts_omitted=<n> when key facts alone exceed the 1500-token budget (3.13.0: no pointers)', async () => {
    const log = vi.fn();
    const records = Array.from({ length: 60 }, (_, i) => ({
      kind: 'user',
      origin: 'reconcile',
      producedBy: 's4-capture',
      sourceHash: `fixture-hash-kf-overflow-${i}`,
      body: { text: `Fact number ${i} states that the relevant configuration value for this subsystem, which several downstream teams depend on for correct behavior, is exactly ${1000 + i} and must not be changed without updating every downstream service config that reads it.` },
    }));
    const fsList = vi.fn(async () => [{ name: 'segment-000001.json', kind: 'file', size: 1 }]);
    const fsRead = vi.fn(async (path: string) => {
      if (path === FLAG_PATH) return '1';
      if (path.endsWith('segment-000001.json')) return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
      throw new Error(`ENOENT: ${path}`);
    });
    const $ = fakeHost({ fsList, fsRead, uiLog: log });
    const handlers = harness({ contract: 'the contract' });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next));
    expect(log.mock.calls.some(([line]) => /^seed\.facts_omitted=[1-9]\d*$/.test(String(line)))).toBe(true);
    expect(log.mock.calls.some(([line]) => /^seed\.facts_overflow=/.test(String(line)))).toBe(false);
  });

  it('a plain fact tool result (not a Write/Edit tool_use input, not user text) does not reach the Key facts section (source restriction, round 17)', async () => {
    const record = { kind: 'user', origin: 'reconcile', producedBy: 's4-capture', sourceHash: 'fixture-hash-kf3', body: { text: 'Please read the config file.' } };
    const fsList = vi.fn(async () => [{ name: 'segment-000001.json', kind: 'file', size: 1 }]);
    const fsRead = vi.fn(async (path: string) => {
      if (path === FLAG_PATH) return '1';
      if (path.endsWith('segment-000001.json')) return `${JSON.stringify(record)}\n`;
      throw new Error(`ENOENT: ${path}`);
    });
    const $ = fakeHost({ fsList, fsRead });
    const handlers = harness({ contract: 'the contract' });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    // A tool RESULT carrying an otherwise-qualifying fact (a port number) must not leak into Key
    // facts: only `user`/`file_write` capture records are ever handed to `extractKeyFacts`.
    const messages: SessionMessage[] = [
      ...bulkyToolConversation(),
      assistantCall('t-kf', 'Read', { file_path: '/etc/app/config.yml' }, ''),
      toolResultsMessage([{ tool_use_id: 't-kf', text: 'The staging API listens on port 48213 and the region is eu-central-2.', isError: false }]),
    ];
    const event: CompactEvent = { trigger: 'auto', messages };
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next))) as { messages?: SessionMessage[] };
    const seed = result.messages?.[0];
    expect(seed?.text).not.toContain('48213');
  });
});

/**
 * Mutation survivor M6 (review-opus-r10.md mutation-survivor list, brief-s4a-fix13.md item 5):
 * a mutant that lets `reasoningBudgetTokens` ignore constraints' own rendered size (i.e. hands
 * selector D the full, unreduced `SEED_BUDGET_TOKENS` instead of `compact.ts`'s
 * `SEED_BUDGET_TOKENS - countTokens(constraintsBody)`, line ~92) survived every prior test,
 * because no existing fixture built a reasoning candidate sized to fall strictly between the two
 * budgets. This is a register-level integration test, white-box: it derives the EXACT reduced
 * budget the real pipeline computes by running the same real `extractConstraints`/
 * `applyConstraintOverflow`/`renderConstraintsSection` (with the same `countTokens` formula
 * `compact.ts` uses, `ceil(text.length / 4)`) the handler itself will run, rather than guessing a
 * number, so the test cannot go stale if those functions' output size ever shifts.
 */
describe('compact.ts: mutation survivor M6 (reasoning budget must subtract constraints\' own rendered size)', () => {
  it('excludes a reasoning candidate that fits the FULL seed budget but not the budget reduced by constraints', async () => {
    const countTokens = (text: string) => Math.ceil(text.length / 4);
    const NUM_CONSTRAINTS = 80;
    const constraintRecords = Array.from({ length: NUM_CONSTRAINTS }, (_, i) => ({
      kind: 'user',
      origin: 'reconcile',
      producedBy: 's4-capture',
      sourceHash: `m6-constraint-${i}`,
      body: { text: `You must always keep module boundary ${i} isolated from module boundary ${i + 1}.` },
    }));
    // White-box derivation of the real reduced budget, using the same functions and formula
    // compact.ts itself uses (core/constraints.ts, compact.ts line ~92).
    const constraints = extractConstraints(constraintRecords as never, sha256);
    expect(constraints.length, 'fixture sanity: every sentence must actually be picked up as a constraint').toBe(NUM_CONSTRAINTS);
    const overflow = applyConstraintOverflow(constraints, countTokens, sha256);
    const constraintsBody = renderConstraintsSection(overflow.rendered);
    const reasoningBudgetTokens = Math.max(0, SEED_BUDGET_TOKENS - countTokens(constraintsBody));
    expect(reasoningBudgetTokens, 'fixture sanity: constraints must actually eat into the seed budget for this test to distinguish anything').toBeLessThan(SEED_BUDGET_TOKENS - 500);

    // Sized just above the REDUCED budget but comfortably below the FULL SEED_BUDGET_TOKENS: the
    // real fix excludes it (does not fit reasoningBudgetTokens); a mutant that ignores
    // constraints and hands select() the full, unreduced SEED_BUDGET_TOKENS would wrongly include
    // it instead.
    const candidateTokens = reasoningBudgetTokens + 300;
    expect(candidateTokens, 'fixture sanity: the candidate must still fit under the full, unreduced seed budget for this to distinguish the mutant').toBeLessThan(SEED_BUDGET_TOKENS);
    const marker = 'KESTREL-REASONING-MARKER';
    const reasoningText = `${marker} ${'x'.repeat(candidateTokens * 4)}`;
    const reasoningRecord = {
      kind: 'assistant_text',
      origin: 'reconcile',
      producedBy: 's4-capture',
      sourceHash: 'm6-reasoning-fixture',
      body: { text: reasoningText },
    };
    const segmentText = [...constraintRecords, reasoningRecord].map((record) => JSON.stringify(record)).join('\n');
    const fsList = vi.fn(async () => [{ name: 'segment-000001.json', kind: 'file', size: 1 }]);
    const fsRead = vi.fn(async (path: string) => {
      if (path === FLAG_PATH) return '1';
      if (path.endsWith('segment-000001.json')) return `${segmentText}\n`;
      throw new Error(`ENOENT: ${path}`);
    });
    const $ = fakeHost({ fsList, fsRead });
    const handlers = harness({ contract: 'the contract' });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next))) as { messages?: SessionMessage[] };
    expect(next, 'this conversation shrinks well past the 25% floor and must not fall back').not.toHaveBeenCalled();
    const seed = result.messages?.[0];
    expect(seed?.text.includes(marker), 'M6: a reasoning candidate that only fits the FULL seed budget, not the budget reduced by constraints\' own rendered size, must be excluded').toBe(false);
  });
});

/**
 * Round 15 (brief-s4a-fix15.md item 4): "vitest timers once hid a hook-runtime crash" is a
 * standing constraint (memory: cc-hook-dollar-rule.md), so this gate does not use
 * `vi.useFakeTimers()` and, unlike every other test in this file, does not wrap the handler call
 * in `withStrippedRuntimeGlobals` either: its whole point is to run against a real,
 * macrotask-driven event loop (real `setInterval`, real `setTimeout`), the same kind the hooks
 * worker's 5000ms heartbeat actually runs on. A stripped-globals run would leave `compact.ts`'s
 * `await $.clock.sleep(0, { signal })` yields (its `yieldTick` closure) as bare microtask
 * resolutions under the fixture default `fakeHost()` clock, so this probe would never see the
 * gaps between phases; overriding `clockSleep` here to a real `setTimeout`-backed promise
 * restores that.
 *
 * The fixture (`fixtures/round15-large-capture.ndjson`, ~950 KB) is the real evidence capture
 * (`A-D-capture/1fd27e02-.../segment-000001.json`, brief-s4a-fix15.md's live finding) copied
 * verbatim: synthetic A/B filler (a fake "Project KESTREL-9" briefing and Q&A), nothing secret
 * (checked: no `sk-`/`AKIA`/`BEGIN PRIVATE`/`api_key` substrings). It is what made
 * `core/seed.ts`'s pre-round-15 `index === 3` shift+render loop take ~15.1s (see that file's
 * round-15 comment and this brief's per-phase timings).
 */
describe('compact.ts: round 15 perf gate, real handler wiring against a real-size capture store (brief-s4a-fix15.md item 4)', () => {
  const FIXTURE_URL = new URL('./fixtures/round15-large-capture.ndjson', import.meta.url);
  const PROBE_INTERVAL_MS = 15;
  const CPU_BUDGET_MS = 1000;
  const TOTAL_WALL_BUDGET_MS = 10_000;
  const MAX_BLOCK_BUDGET_MS = 1000;
  const MAX_ATTEMPTS = 3;

  // 4.9.1: Issue #68: interval lag is wall time and can spike under load even when the handler did not block.
  // A real handler slowdown repeats; a scheduling spike may not, so retry with fresh state up to three times.
  async function runCompactAttempts(runAttempt: (attempt: number) => Promise<CompactPerfAttempt>): Promise<CompactPerfRetryResult> {
    const attempts: CompactPerfAttempt[] = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const measured = await runAttempt(attempt);
      attempts.push(measured);
      if (measured.cpuMs < CPU_BUDGET_MS && measured.totalMs < TOTAL_WALL_BUDGET_MS && measured.maxBlockMs < MAX_BLOCK_BUDGET_MS) {
        return { attempts, diagnosticAttempt: measured, contentAttempt: measured, passed: true };
      }
    }
    const diagnosticAttempt = attempts.reduce((best, measured) => measured.maxBlockMs < best.maxBlockMs ? measured : best);
    return { attempts, diagnosticAttempt, contentAttempt: attempts[attempts.length - 1]!, passed: false };
  }

  it('retries a load-related lag spike and uses the first attempt within all three budgets', async () => {
    const calls: number[] = [];
    const samples = [
      { cpuMs: 80, totalMs: 1700, maxBlockMs: 1637.8 },
      { cpuMs: 85, totalMs: 220, maxBlockMs: 17.2 },
      { cpuMs: 90, totalMs: 200, maxBlockMs: 15.1 },
    ];
    const measured = await runCompactAttempts(async (attempt) => {
      calls.push(attempt);
      return { attempt, result: { fellBack: true }, ...samples[attempt - 1]! };
    });

    expect(calls).toEqual([1, 2]);
    expect(measured.passed).toBe(true);
    expect(measured.diagnosticAttempt.attempt).toBe(2);
    expect(measured.contentAttempt.attempt).toBe(2);
  });

  it('uses the smallest-lag attempt for failure diagnostics and the last attempt for content checks', async () => {
    const calls: number[] = [];
    const samples = [
      { cpuMs: 1200, totalMs: 1500, maxBlockMs: 1800 },
      { cpuMs: 1100, totalMs: 12_000, maxBlockMs: 1250 },
      { cpuMs: 1300, totalMs: 1300, maxBlockMs: 1400 },
    ];
    const measured = await runCompactAttempts(async (attempt) => {
      calls.push(attempt);
      return { attempt, result: { fellBack: true }, ...samples[attempt - 1]! };
    });

    expect(calls).toEqual([1, 2, 3]);
    expect(measured.passed).toBe(false);
    expect(measured.diagnosticAttempt.attempt).toBe(2);
    expect(measured.contentAttempt.attempt).toBe(3);
  });

  // The old 1.5 s wall budget failed when a loaded server delayed this process (PR #64, issue #49). CPU time tracks the
  // handler's own work; retain a generous wall ceiling and the interval-lag ceiling to catch waits and synchronous blocks.

  /** Real `setInterval` lag probe (not a vitest fake timer): the gap between an interval firing
   * and when it was scheduled to fire is exactly how long something else held the event loop. */
  function startLagProbe(): { stop: () => number } {
    let maxLag = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const lag = now - last - PROBE_INTERVAL_MS;
      if (lag > maxLag) maxLag = lag;
      last = now;
    }, PROBE_INTERVAL_MS);
    return {
      stop: () => {
        const lag = performance.now() - last - PROBE_INTERVAL_MS;
        if (lag > maxLag) maxLag = lag;
        clearInterval(timer);
        return maxLag;
      },
    };
  }

  it('a session.compact through the real handler, over the ~950KB evidence-derived capture store, stays within CPU and blocking budgets', async () => {
    const fixtureSegment = readFileSync(FIXTURE_URL, 'utf8');
    const baseDir = '/project/.exovault/s4-capture/session-default'; // captures anchor at the flag directory (fakeHost cwd /project); fakeHost()'s default session id is 'session-default'
    const measured = await runCompactAttempts(async (attempt) => {
      const files = new Map<string, string>([[`${baseDir}/segment-000001.json`, fixtureSegment]]);
      const fsList = async (path = ''): Promise<{ name: string; kind: string; size: number }[]> =>
        [...files.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => ({ name: key.slice(path.length + 1), kind: 'file', size: files.get(key)!.length }));
      const fsRead = async (path: string): Promise<string> => (path === FLAG_PATH ? '1' : files.get(path) ?? Promise.reject(new Error(`ENOENT: ${path}`)));
      const fsWrite = async (path: string, text: string): Promise<void> => {
        files.set(path, text);
      };
      const clockSleep = (ms: number, { signal }: { signal: AbortSignal }): Promise<void> =>
        new Promise((resolve, reject) => {
          if (signal.aborted) {
            reject(new Error('aborted'));
            return;
          }
          const timer = setTimeout(resolve, ms);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          }, { once: true });
        });
      const $ = fakeHost({ fsList, fsRead, fsWrite, clockSleep });
      const handlers = harness({ contract: 'the contract' });
      const next = async () => ({ fellBack: true }) as unknown;
      const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
      const probe = startLagProbe();
      const start = performance.now();
      let probeStopped = false;
      try {
        const result = await cpuMsAsync(() => handlers['session.compact']($, event, next));
        const totalMs = performance.now() - start;
        const maxBlockMs = probe.stop();
        probeStopped = true;
        return { attempt, result: result.result as CompactPerfAttempt['result'], cpuMs: result.cpuMs, totalMs, maxBlockMs };
      } finally {
        if (!probeStopped) probe.stop();
      }
    });
    const { diagnosticAttempt, contentAttempt, attempts, passed } = measured;
    const attemptDetail = (sample: CompactPerfAttempt) =>
      `attempt ${sample.attempt}: CPU=${sample.cpuMs.toFixed(1)}ms, wall=${sample.totalMs.toFixed(1)}ms, lag=${sample.maxBlockMs.toFixed(1)}ms`;
    const attemptSummary = passed
      ? `first attempt meeting all budgets: ${attemptDetail(diagnosticAttempt)} (${attempts.length} attempt${attempts.length === 1 ? '' : 's'} measured)`
      : `all ${MAX_ATTEMPTS} attempts failed; smallest-lag attempt: ${attemptDetail(diagnosticAttempt)}; measurements: ${attempts.map(attemptDetail).join('; ')}`;
    const result = contentAttempt.result;

    expect(result.messages ?? result.fellBack, `sanity: attempt ${contentAttempt.attempt} must return something (a compaction or an explicit fallback), not throw`).toBeDefined();

    // Round 17 (brief-s4a-fix17.md item 3, "seed stays within 6k tokens on evidence input"): the
    // passing run, or the final run when all attempts miss a timing budget, must produce a seed
    // whose Key facts section is populated AND whose total size still fits SEED_BUDGET_TOKENS.
    const seed = result.messages?.[0];
    expect(seed?.text, `attempt ${contentAttempt.attempt} must produce an actual seed, not a fallback`).toBeDefined();
    expect(seed!.text).toContain('## Key facts');
    expect(seed!.text).not.toMatch(/## Key facts\n\(none\)/);
    expect(seed!.text).toContain('KESTREL-9');
    const seedTokens = gateCountTokens(seed!.text);
    expect(
      seedTokens,
      `attempt ${contentAttempt.attempt} rendered ${seedTokens} tokens against the real evidence-derived fixture; budget is ${SEED_BUDGET_TOKENS}`,
    ).toBeLessThanOrEqual(SEED_BUDGET_TOKENS);

    expect.soft(
      diagnosticAttempt.cpuMs,
      `compact.ts session.compact process CPU budget is ${CPU_BUDGET_MS}ms; ${attemptSummary}`,
    ).toBeLessThan(CPU_BUDGET_MS);
    expect.soft(
      diagnosticAttempt.totalMs,
      `compact.ts session.compact generous wall budget is ${TOTAL_WALL_BUDGET_MS}ms; ${attemptSummary}`,
    ).toBeLessThan(TOTAL_WALL_BUDGET_MS);
    expect.soft(
      diagnosticAttempt.maxBlockMs,
      `the real ${PROBE_INTERVAL_MS}ms setInterval lag ceiling is ${MAX_BLOCK_BUDGET_MS}ms; ${attemptSummary}`,
    ).toBeLessThan(MAX_BLOCK_BUDGET_MS);
  }, 60_000);
});

/**
 * F9 (review-opus-s4b.md): "there are no tests at all for the compact.ts J wiring: the privacy
 * gate, the literal key read (B1), the M7 line text (B2), and signal propagation (F1)." These
 * tests exercise `compact.ts`'s own J-selection block end to end, through a fake `$.http` and
 * `$.env`, never `host/jev-client.ts`'s real network path.
 */
describe('compact.ts: selector J wiring, end to end, with a fake Jev (review-opus-s4b.md F9)', () => {
  const SECRET = 'sk-test-wiring-key';

  function jevRecord(id: string, text: string) {
    return { kind: 'assistant_text', origin: 'reconcile', producedBy: 's4-capture', sourceHash: `jev-fixture-${id}`, body: { text } };
  }

  function jevSegmentFs(records: ReturnType<typeof jevRecord>[]) {
    const fsList = vi.fn(async () => [{ name: 'segment-000001.json', kind: 'file', size: 1 }]);
    const fsRead = vi.fn(async (path: string) => {
      if (path === FLAG_PATH) return '1';
      if (path.endsWith('segment-000001.json')) return `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
      throw new Error(`ENOENT: ${path}`);
    });
    return { fsList, fsRead };
  }

  it('keep, pointer and drop decisions each render correctly, and M7/decision log lines carry no "token"/"key"/"secret" key names', async () => {
    const keepText = 'Chose the retry backoff formula because of the rate-limit tests.';
    const pointerText = 'Considered three cache eviction policies before settling on LRU.';
    const dropText = 'Restated the same conclusion a second time for emphasis.';
    const records = [jevRecord('0', keepText), jevRecord('1', pointerText), jevRecord('2', dropText)];
    const { fsList, fsRead } = jevSegmentFs(records);
    const log = vi.fn();
    const fetch = vi.fn(async (_url: string, init: { headers: Record<string, string>; body: string }) => {
      expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
      const body = JSON.parse(init.body) as { model: string; questions: Record<string, unknown> };
      const answers: Record<string, unknown> = {};
      const decisionOf: Record<string, string> = { '0': 'keep_verbatim', '1': 'pointer', '2': 'drop' };
      for (const id of Object.keys(body.questions)) {
        const chosen = decisionOf[id];
        const rest = 0.3 / 3;
        answers[id] = { type: 'choice', choice: chosen, probabilities: { keep_verbatim: chosen === 'keep_verbatim' ? 0.7 : rest, pointer: chosen === 'pointer' ? 0.7 : rest, drop: chosen === 'drop' ? 0.7 : rest, unsure: rest } };
      }
      // jev-live-smoke-20260926.md finding 2: the real response resolves the requested alias
      // ("jev-latest") to a concrete version, never echoing the alias back; this fake mirrors that
      // so this end-to-end test also exercises resolvesRequestedModel, not just an exact match.
      // finding 4: usage.input_tokens is a real, top-level field on the response.
      return { status: 200, ok: true, text: JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 137 } }) };
    });
    const $ = fakeHost({ fsList, fsRead, uiLog: log, httpFetch: fetch, envGet: async (name) => (name === 'TYPESAFE_API_KEY' ? SECRET : undefined) });
    const handlers = harness({ contract: 'the contract', jevEnabled: true });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next))) as { messages?: SessionMessage[] };
    expect(next, 'this conversation shrinks well past the 25% floor and must not fall back').not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    const seed = result.messages?.[0]?.text ?? '';
    expect(seed, 'a keep_verbatim decision keeps the span verbatim').toContain(keepText);
    expect(seed, 'a drop decision omits the span entirely').not.toContain(dropText);
    expect(seed, 'a drop decision must not even leave the pointer/drop marker text in the seed').not.toContain(pointerText);
    // B2 (review-opus-s4b-r2.md): labeled seq (D's own pointer convention), and the sha is the
    // span's own content hash at render time, not the batch's shared call hash.
    expect(seed, 'F5: a pointer decision renders as a one-line pointer, not nothing').toMatch(/\[pointer seq=1 sha256=[0-9a-f]{64}\]/);

    const lines = log.mock.calls.map(([line]) => String(line));
    const unitsLine = lines.find((line) => line.startsWith('compact.jev_units='));
    expect(unitsLine, 'M7 line must be emitted').toBeDefined();
    // jev-live-smoke-20260926.md finding 4: the one real call's own usage.input_tokens (137) is
    // used verbatim, not this run's own pre-call estimate.
    expect(unitsLine).toBe('compact.jev_units=137 compact.jev_fallback=0');
    const decisionLine = lines.find((line) => line.startsWith('compact.jev_decision_sha='));
    expect(decisionLine, 'F4 decision log line must be emitted').toBeDefined();
    // finding 2: the decision log names the concrete response model, never the requested alias.
    expect(decisionLine).toMatch(/^compact\.jev_decision_sha=[0-9a-f]{64} compact\.jev_decision_model=jev-1\.13\.0 compact\.jev_decision_spans=3 compact\.jev_decision_keep=1 compact\.jev_decision_pointer=1 compact\.jev_decision_drop=1$/);
    // B2: the CC debug log redacts any value whose KEY contains "token"; no log line's key portion
    // (the part before "=") may contain "token", "key" or "secret", on any line this handler logs.
    for (const line of lines) {
      for (const field of line.split(' ')) {
        const key = field.split('=')[0].toLowerCase();
        expect(key.includes('token'), `log key "${key}" must not contain "token"`).toBe(false);
        expect(key.includes('key'), `log key "${key}" must not contain "key"`).toBe(false);
        expect(key.includes('secret'), `log key "${key}" must not contain "secret"`).toBe(false);
      }
    }
    expect(seed.includes(SECRET), 'the API key must never reach the rendered seed').toBe(false);
  });

  it('a disabled J makes zero fetch calls and still emits the M7 line with jev_skipped=disabled', async () => {
    const records = [jevRecord('0', 'some reasoning text')];
    const { fsList, fsRead } = jevSegmentFs(records);
    const log = vi.fn();
    const fetch = vi.fn(async () => ({ status: 200, ok: true, text: '{}' }));
    const $ = fakeHost({ fsList, fsRead, uiLog: log, httpFetch: fetch, envGet: async (name) => (name === 'TYPESAFE_API_KEY' ? SECRET : undefined) });
    const handlers = harness({ contract: 'the contract' }); // jevEnabled defaults to false
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next));
    expect(fetch).not.toHaveBeenCalled();
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines).toContain('compact.jev_units=0 compact.jev_fallback=0');
    expect(lines).toContain('compact.jev_skipped=disabled');
  });

  it('a denied J (deny-list match) makes zero fetch calls and emits jev_skipped=deny_list', async () => {
    const records = [jevRecord('0', 'some reasoning text')];
    const { fsList, fsRead } = jevSegmentFs(records);
    const log = vi.fn();
    const fetch = vi.fn(async () => ({ status: 200, ok: true, text: '{}' }));
    const $ = fakeHost({ fsList, fsRead, uiLog: log, httpFetch: fetch, sessionCwd: async () => '/home/u/work/client-acme/repo', envGet: async (name) => (name === 'TYPESAFE_API_KEY' ? SECRET : undefined) });
    const handlers = harness({ contract: 'the contract', jevEnabled: true, jevDenyList: 'client-acme' });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next));
    expect(fetch).not.toHaveBeenCalled();
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines).toContain('compact.jev_units=0 compact.jev_fallback=0');
    expect(lines).toContain('compact.jev_skipped=deny_list');
  });

  it('a missing API key makes zero fetch calls and emits jev_skipped=no_api_key (B1: this must not require a non-literal $.env.get)', async () => {
    const records = [jevRecord('0', 'some reasoning text')];
    const { fsList, fsRead } = jevSegmentFs(records);
    const log = vi.fn();
    const fetch = vi.fn(async () => ({ status: 200, ok: true, text: '{}' }));
    const $ = fakeHost({ fsList, fsRead, uiLog: log, httpFetch: fetch, envGet: async () => undefined });
    const handlers = harness({ contract: 'the contract', jevEnabled: true });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next));
    expect(fetch).not.toHaveBeenCalled();
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines).toContain('compact.jev_units=0 compact.jev_fallback=0');
    expect(lines).toContain('compact.jev_skipped=no_api_key');
  });

  /**
   * review-opus-s4b-r2.md status table, F6/F1: "Throw path, compact.ts:257: no test, the mutant
   * stays green." A no-key skip (tested above) never throws; this drives a genuine throw (the key
   * read itself fails) to land on the separate catch branch at compact.ts:253-259 and checks that
   * branch's own M7 line and jev_skipped=error, independent of the no-key branch's own lines.
   */
  it('4.7.5 (S5q): with EXO_JEV_URL on this machine and no key, selector J asks that address with the placeholder key', async () => {
    const records = [jevRecord('0', 'Chose the retry backoff formula because of the rate-limit tests.')];
    const { fsList, fsRead } = jevSegmentFs(records);
    const log = vi.fn();
    const asked: Array<{ url: string; auth: string }> = [];
    const fetch = vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
      asked.push({ url, auth: init.headers.Authorization });
      const body = JSON.parse(init.body) as { questions: Record<string, unknown> };
      const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'choice', choice: 'keep_verbatim', probabilities: { keep_verbatim: 0.7, pointer: 0.1, drop: 0.1, unsure: 0.1 } }]));
      return { status: 200, ok: true, text: JSON.stringify({ model: 'jev-0.1', answers, usage: { input_tokens: 50 } }) };
    });
    const $ = fakeHost({ fsList, fsRead, uiLog: log, httpFetch: fetch, envGet: async (name) => (name === 'EXO_JEV_URL' ? 'http://127.0.0.1:8080' : undefined) });
    const handlers = harness({ contract: 'the contract', jevEnabled: true });
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, vi.fn(async () => ({ fellBack: true }) as unknown)));
    expect(asked).toEqual([{ url: 'http://127.0.0.1:8080/v1/systemone', auth: 'Bearer local' }]);
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines).toContain('compact.jev_units=50 compact.jev_fallback=0');
    expect(lines.some((line) => line.startsWith('compact.jev_skipped=')), lines.join('\n')).toBe(false);
  });

  it('4.7.5 (S5q): an EXO_JEV_URL that is no address makes zero fetch calls, TypeSafe included, and emits jev_skipped=bad_jev_url', async () => {
    const records = [jevRecord('0', 'some reasoning text')];
    const { fsList, fsRead } = jevSegmentFs(records);
    const log = vi.fn();
    const fetch = vi.fn(async () => ({ status: 200, ok: true, text: '{}' }));
    const $ = fakeHost({ fsList, fsRead, uiLog: log, httpFetch: fetch, envGet: async (name) => (name === 'EXO_JEV_URL' ? 'localhost:8080' : name === 'TYPESAFE_API_KEY' ? SECRET : undefined) });
    const handlers = harness({ contract: 'the contract', jevEnabled: true });
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, vi.fn(async () => ({ fellBack: true }) as unknown)));
    expect(fetch).not.toHaveBeenCalled();
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines).toContain('compact.jev_units=0 compact.jev_fallback=0');
    expect(lines).toContain('compact.jev_skipped=bad_jev_url');
  });

  it('a genuine throw (the key read itself fails) still falls back to D with the M7 line and jev_skipped=error (review-opus-s4b-r2.md: throw-path mutation gap, compact.ts:257)', async () => {
    const records = [jevRecord('0', 'first reasoning span'), jevRecord('1', 'second reasoning span'), jevRecord('2', 'third reasoning span')];
    const { fsList, fsRead } = jevSegmentFs(records);
    const log = vi.fn();
    const fetch = vi.fn(async () => ({ status: 200, ok: true, text: '{}' }));
    // Only TYPESAFE_API_KEY throws; $.env.get('HOME') (the separate transcript-pointer seam,
    // compact.ts's own transcriptPathHost) must keep working so this test isolates the genuine
    // throw to the key read alone, not to an unrelated env lookup elsewhere in the same handler.
    const $ = fakeHost({ fsList, fsRead, uiLog: log, httpFetch: fetch, envGet: async (name: string) => { if (name === 'TYPESAFE_API_KEY') throw new Error('env read failed'); return undefined; } });
    const handlers = harness({ contract: 'the contract', jevEnabled: true });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next))) as { messages?: SessionMessage[] };
    expect(fetch, 'a throw reading the key must never reach selectJ, let alone a real call').not.toHaveBeenCalled();
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines).toContain('compact.jev_units=0 compact.jev_fallback=3');
    expect(lines).toContain('compact.jev_skipped=error');
    const seed = result.messages?.[0]?.text ?? '';
    expect(seed, 'the throw path still falls back to D, which keeps these small spans').toContain('first reasoning span');
  });

  /**
   * brief-s4b-fix4.md item 4: only the error's own constructor name is ever logged, never its
   * message or stack -- a genuine throw here can carry arbitrary session content (a malformed
   * response body, a rejected fetch's own error text), and this line is read by an external
   * harness, not a private debug channel.
   */
  it('a genuine throw logs only compact.jev_error_class=<constructor name>, never the message or stack (brief-s4b-fix4.md item 4)', async () => {
    const records = [jevRecord('0', 'first reasoning span')];
    const { fsList, fsRead } = jevSegmentFs(records);
    const log = vi.fn();
    class ReadFailure extends Error {}
    const secretMessage = 'super secret env read failure detail xyz123';
    const $ = fakeHost({ fsList, fsRead, uiLog: log, envGet: async (name: string) => { if (name === 'TYPESAFE_API_KEY') throw new ReadFailure(secretMessage); return undefined; } });
    const handlers = harness({ contract: 'the contract', jevEnabled: true });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next));
    const lines = log.mock.calls.map(([line]) => String(line));
    const errorClassLine = lines.find((line) => line.startsWith('compact.jev_error_class='));
    expect(errorClassLine).toBe('compact.jev_error_class=ReadFailure');
    for (const line of lines) {
      expect(line, 'the error message must never reach the log').not.toContain(secretMessage);
    }
  });

  /**
   * brief-s4b-fix4.md item 3: "J enabled but zero calls made" must be visible even on the success
   * path (no throw) -- here every reasoning span is individually oversized, so selectJ completes
   * normally, the M7 line still fires, but no batch was ever actually sent to Jev.
   */
  it('compact.jev_skipped=oversized_all is logged when the only reasoning span is individually oversized (brief-s4b-fix4.md item 3)', async () => {
    const records = [jevRecord('0', 'x'.repeat(200000))];
    const { fsList, fsRead } = jevSegmentFs(records);
    const log = vi.fn();
    const fetch = vi.fn(async () => ({ status: 200, ok: true, text: '{}' }));
    const $ = fakeHost({ fsList, fsRead, uiLog: log, httpFetch: fetch, envGet: async (name) => (name === 'TYPESAFE_API_KEY' ? SECRET : undefined) });
    const handlers = harness({ contract: 'the contract', jevEnabled: true });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next));
    expect(fetch, 'an individually oversized span must never be sent to Jev').not.toHaveBeenCalled();
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines.some((line) => line.startsWith('compact.jev_units='))).toBe(true);
    expect(lines).toContain('compact.jev_skipped=oversized_all');
  });

  /**
   * brief-s4b-fix4.md item 3: the total Jev budget can be spent (or, as here, configured to zero)
   * before any batch is ever attempted -- selectJ still completes normally, on the success path.
   */
  it('compact.jev_skipped=budget_exhausted is logged when the total Jev budget is already spent (brief-s4b-fix4.md item 3)', async () => {
    const records = [jevRecord('0', 'first reasoning span'), jevRecord('1', 'second reasoning span')];
    const { fsList, fsRead } = jevSegmentFs(records);
    const log = vi.fn();
    const fetch = vi.fn(async () => ({ status: 200, ok: true, text: '{}' }));
    const $ = fakeHost({ fsList, fsRead, uiLog: log, httpFetch: fetch, envGet: async (name) => (name === 'TYPESAFE_API_KEY' ? SECRET : undefined) });
    const handlers = harness({ contract: 'the contract', jevEnabled: true, jevTotalBudgetMs: 0 });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next));
    expect(fetch, 'a zero total budget must leave no room for even the first batch').not.toHaveBeenCalled();
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines).toContain('compact.jev_skipped=budget_exhausted');
  });

  /**
   * review-opus-s4b-fix4.md F5: zero reasoning candidates is not a skip -- D and J give identical
   * output when there is nothing to select from, so treating it as `jev_skipped` invalidates an
   * otherwise-healthy A-J chain in the harness. This must log `compact.jev_candidates=0` instead,
   * and must never emit a `compact.jev_skipped=` line for this case.
   */
  it('compact.jev_candidates=0 is logged, not compact.jev_skipped=no_candidates, when there are zero reasoning spans (review-opus-s4b-fix4.md F5)', async () => {
    const records: ReturnType<typeof jevRecord>[] = [];
    const { fsList, fsRead } = jevSegmentFs(records);
    const log = vi.fn();
    const fetch = vi.fn(async () => ({ status: 200, ok: true, text: '{}' }));
    const $ = fakeHost({ fsList, fsRead, uiLog: log, httpFetch: fetch, envGet: async (name) => (name === 'TYPESAFE_API_KEY' ? SECRET : undefined) });
    const handlers = harness({ contract: 'the contract', jevEnabled: true });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next));
    expect(fetch, 'zero reasoning candidates must never reach Jev').not.toHaveBeenCalled();
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines).toContain('compact.jev_units=0 compact.jev_fallback=0');
    expect(lines).toContain('compact.jev_candidates=0');
    expect(lines.some((line) => line.startsWith('compact.jev_skipped=')), 'zero candidates is not a skip').toBe(false);
  });

  /**
   * review-opus-s4b-fix4.md F6: `compact.jev_error_class` logs only `constructor.name`, which for a
   * code-thrown Error subclass is a fixed identifier, but a thrown plain object (or one built from
   * parsed/attacker-influenced data) can carry an arbitrary `constructor.name` string. This line is
   * read by an external harness, so a non-identifier name must be sanitized to `Unknown` rather than
   * logged verbatim.
   */
  it('a thrown value whose constructor name is not a plain identifier logs compact.jev_error_class=Unknown (review-opus-s4b-fix4.md F6)', async () => {
    const records = [jevRecord('0', 'first reasoning span')];
    const { fsList, fsRead } = jevSegmentFs(records);
    const log = vi.fn();
    const evilName = 'Evil Class! <script>';
    const evilError = { constructor: { name: evilName } };
    const $ = fakeHost({ fsList, fsRead, uiLog: log, envGet: async (name: string) => { if (name === 'TYPESAFE_API_KEY') throw evilError; return undefined; } });
    const handlers = harness({ contract: 'the contract', jevEnabled: true });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next));
    const lines = log.mock.calls.map(([line]) => String(line));
    const errorClassLine = lines.find((line) => line.startsWith('compact.jev_error_class='));
    expect(errorClassLine).toBe('compact.jev_error_class=Unknown');
    for (const line of lines) {
      expect(line, 'the attacker-shaped constructor name must never reach the log').not.toContain(evilName);
    }
  });

  /**
   * The brief's own acceptance test for B2 (brief-s4b-fix3.md item 2): "Test that A-D and A-J with
   * identical keep decisions produce identical seeds." Before the B2 fix, a pointer's rendered
   * bytes were never budgeted, so even a run where Jev agrees with D on every span could still
   * diverge from D's own seed once section 7's suffix trim ran; this scenario has no pointer or
   * drop decisions at all (every span answered keep_verbatim, D's own decision for each at this
   * budget), so the two arms' rendered seed text must be byte-identical.
   */
  it('A-D and A-J render byte-identical seeds when every span is answered keep_verbatim, matching D\'s own decision (review-opus-s4b-r2.md B2 acceptance test)', async () => {
    const records = [jevRecord('0', 'first reasoning span'), jevRecord('1', 'second reasoning span'), jevRecord('2', 'third reasoning span')];

    const { fsList: fsListD, fsRead: fsReadD } = jevSegmentFs(records);
    const $d = fakeHost({ fsList: fsListD, fsRead: fsReadD, uiLog: vi.fn(), envGet: async () => undefined });
    const handlersD = harness({ contract: 'the contract' }); // jevEnabled defaults to false: A-D
    const resultD = (await withStrippedRuntimeGlobals(() =>
      handlersD['session.compact']($d, { trigger: 'auto', messages: bulkyToolConversation() }, vi.fn(async () => ({ fellBack: true }) as unknown)),
    )) as { messages?: SessionMessage[] };

    const { fsList: fsListJ, fsRead: fsReadJ } = jevSegmentFs(records);
    const fetch = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { questions: Record<string, unknown> };
      const answers: Record<string, unknown> = {};
      for (const id of Object.keys(body.questions)) {
        answers[id] = { type: 'choice', choice: 'keep_verbatim', probabilities: { keep_verbatim: 0.7, pointer: 0.1, drop: 0.1, unsure: 0.1 } };
      }
      return { status: 200, ok: true, text: JSON.stringify({ model: 'jev-latest', answers }) };
    });
    const $j = fakeHost({ fsList: fsListJ, fsRead: fsReadJ, uiLog: vi.fn(), httpFetch: fetch, envGet: async (name) => (name === 'TYPESAFE_API_KEY' ? SECRET : undefined) });
    const handlersJ = harness({ contract: 'the contract', jevEnabled: true }); // A-J
    const resultJ = (await withStrippedRuntimeGlobals(() =>
      handlersJ['session.compact']($j, { trigger: 'auto', messages: bulkyToolConversation() }, vi.fn(async () => ({ fellBack: true }) as unknown)),
    )) as { messages?: SessionMessage[] };

    expect(fetch, 'the A-J arm must have actually asked Jev, not silently skipped').toHaveBeenCalled();
    expect(resultJ.messages?.[0]?.text).toBe(resultD.messages?.[0]?.text);
  });
});

describe('compact.ts: 3.11.0 refusal guard end to end', () => {
  function statefulFs() {
    const files = new Map<string, string>();
    const fsList = vi.fn(async (path = '') => [...files.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => ({ name: key.slice(path.length + 1), kind: 'file', size: files.get(key)!.length })));
    const fsRead = vi.fn(async (path: string) => (path === FLAG_PATH ? '1' : files.has(path) ? files.get(path)! : Promise.reject(new Error(`ENOENT: ${path}`))));
    const fsWrite = vi.fn(async (path: string, text: string) => { files.set(path, text); });
    const fsExists = vi.fn(async (path: string) => path.endsWith(FLAG_PATH) || files.has(path));
    return { files, fsList, fsRead, fsWrite, fsExists };
  }
  const fileEnding = (files: Map<string, string>, name: string) => [...files.entries()].find(([path]) => path.endsWith(`/${name}`))?.[1];

  it('a refusal of the first reply after a standing S4 cut sends the next cut to core', async () => {
    const { files, fsList, fsRead, fsWrite, fsExists } = statefulFs();
    let messages: SessionMessage[] = [...bulkyToolConversation()];
    const $ = fakeHost({ fsRead, fsWrite, fsList, fsExists, sessionMessages: async () => messages });
    const handlers = harness({ contract: 'the contract' });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);

    const cut = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, { trigger: 'auto', messages } as CompactEvent, next))) as { messages?: SessionMessage[] };
    expect(next, 'S4 must stand on this fixture').not.toHaveBeenCalled();
    expect(fileEnding(files, 's4-cut-fresh.json'), 'a standing S4 cut opens the fresh-cut window').toBe('open');

    messages = cut.messages ?? [];
    await withStrippedRuntimeGlobals(() => handlers['turn.complete']($, { reason: 'refusal', refusal: { category: null, explanation: null }, answer: '' }, async () => ({ text: '' })));
    expect(fileEnding(files, 's4-disabled.json'), 'the refusal trips the guard').toBeDefined();

    await withStrippedRuntimeGlobals(() => handlers['session.compact']($, { trigger: 'manual', messages } as CompactEvent, next));
    expect(next, 'the next cut goes to core').toHaveBeenCalledTimes(1);
  });

  it('an answer after the cut closes the window, so a later refusal leaves S4 on', async () => {
    const { files, fsList, fsRead, fsWrite, fsExists } = statefulFs();
    let messages: SessionMessage[] = [...bulkyToolConversation()];
    const $ = fakeHost({ fsRead, fsWrite, fsList, fsExists, sessionMessages: async () => messages });
    const handlers = harness({ contract: 'the contract' });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);

    const cut = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, { trigger: 'auto', messages } as CompactEvent, next))) as { messages?: SessionMessage[] };
    messages = [...(cut.messages ?? []), humanPrompt('next step'), assistantText('done')];
    await withStrippedRuntimeGlobals(() => handlers['turn.complete']($, { reason: 'answer', answer: 'done' }, async () => ({ text: 'done' })));
    expect(fileEnding(files, 's4-cut-fresh.json')).toBe('answered');

    await withStrippedRuntimeGlobals(() => handlers['turn.complete']($, { reason: 'refusal', refusal: { category: null, explanation: null }, answer: '' }, async () => ({ text: '' })));
    expect(fileEnding(files, 's4-disabled.json')).toBeUndefined();
  });
});

describe('compact.ts: 3.13.0 condensed user history (CONTRACT S4m)', () => {
  it('the seed shows a paste as its head and size, strips harness blocks, and keeps only the newest messages', async () => {
    const texts = [
      ...Array.from({ length: 20 }, (_, i) => `request number ${i} please`),
      `look at this\n<pasted_content id="p1">\nPASTE-HEAD ${'q'.repeat(6000)} PASTE-TAIL-MARKER\n</pasted_content id="p1">`,
      'final ask <system-reminder>REMINDER-MARKER</system-reminder>',
    ];
    const records = texts.map((text, i) => ({ kind: 'user', origin: 'reconcile', producedBy: 's4-capture', sourceHash: `fixture-hash-hist-${i}`, body: { text } }));
    const fsList = vi.fn(async () => [{ name: 'segment-000001.json', kind: 'file', size: 1 }]);
    const fsRead = vi.fn(async (path: string) => {
      if (path === FLAG_PATH) return '1';
      if (path.endsWith('segment-000001.json')) return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
      throw new Error(`ENOENT: ${path}`);
    });
    const $ = fakeHost({ fsList, fsRead });
    const handlers = harness({ contract: 'the contract' });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: bulkyToolConversation() };
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next))) as { messages?: SessionMessage[] };
    const text = result.messages?.[0]?.text ?? '';
    expect(text).toContain('> final ask');
    expect(text).toMatch(/\[pasted 60\d\d chars: PASTE-HEAD q+…\]/);
    expect(text).not.toContain('PASTE-TAIL-MARKER');
    expect(text).not.toContain('REMINDER-MARKER');
    expect(text).toContain('\n(7 earlier user messages not shown; full text in the transcript)\n> request number 7 please');
    expect(text).not.toContain('request number 6 please');
    expect(text).toContain('> request number 7 please');
  });
});

describe('S4r dense Jev failure paths', () => {
  const records = Array.from({ length: 170 }, (_, i) => ({ kind: 'tool_activity', origin: 'reconcile', producedBy: 's4-capture', sourceHash: `r${i}`, body: { text: `Ran node --test on src/mod${i}-unit.ts with --flag${i} at ${1000 + i}ms` } }));
  const segment = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  const run = async (options: Record<string, unknown>, httpFetch: (url: string, init?: { body?: string }) => Promise<{ status: number; ok: boolean; text: string }>) => {
    const lines: string[] = [];
    const $ = fakeHost({
      fsList: async () => [{ name: 'segment-000001.json', kind: 'file', size: 1 }],
      fsRead: async (path) => path === FLAG_PATH ? '1' : path.endsWith('segment-000001.json') ? segment : (() => { throw new Error(`ENOENT: ${path}`); })(),
      uiLog: (line: string) => lines.push(line),
      httpFetch,
      envGet: async (name) => name === 'TYPESAFE_API_KEY' ? SECRET : undefined,
      // The harness settles on microtasks only, so every timeout fires on the next turn; an answer
      // that is already resolved still wins the race because the fetch promise is raced first.
      clockAfter: (_ms, fn) => { let live = true; void Promise.resolve().then(() => Promise.resolve()).then(() => { if (live) fn(); }); return { cancel: () => { live = false; } }; },
    });
    const started = Date.now();
    const result = await withStrippedRuntimeGlobals(() => harness({ denseNotes: true, ...options })['session.compact']($, { trigger: 'auto', messages: bulkyToolConversation() }, async () => ({ fallback: true })) as Promise<{ messages?: SessionMessage[] }>);
    return { text: result.messages?.[0].text ?? '', lines, ms: Date.now() - started };
  };
  const denseLine = (lines: string[]) => lines.find((line) => line.startsWith('dense.jev=')) ?? '';
  const answerAll = (p: (note: string) => number) => async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { questions: Record<string, { instructions: { note: string } }> };
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]) => [id, { type: 'noul', noul: p(q.instructions.note) }]));
    return { status: 200, ok: true, text: JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 10 } }) };
  };

  it('hung requests end as timeout within the budget and leave the seed as without Jev', async () => {
    const off = await run({ jevEnabled: false }, answerAll(() => 0.5));
    const hung = await run({ jevEnabled: true }, () => new Promise(() => {}));
    expect(denseLine(hung.lines)).toMatch(/^dense\.jev=timeout /);
    expect(hung.text).toBe(off.text);
    expect(hung.ms).toBeLessThan(5000);
  });

  it('rejected fetches end as error and leave the seed as without Jev', async () => {
    const off = await run({ jevEnabled: false }, answerAll(() => 0.5));
    const failed = await run({ jevEnabled: true }, async () => { throw new Error('network down'); });
    expect(denseLine(failed.lines)).toMatch(/^dense\.jev=error dense\.jev_requests=2 /);
    expect(failed.text).toBe(off.text);
    expect(failed.lines.join('\n')).not.toContain('network down');
  });

  it('one failing request keeps the scores of the others (partial)', async () => {
    let call = 0;
    const scored = answerAll((note) => (note.includes('src/mod') ? 0.01 : 0.5));
    const mixed = await run({ jevEnabled: true }, async (url, init) => (++call === 1 ? { status: 429, ok: false, text: 'slow down' } : scored(url, init)));
    const line = denseLine(mixed.lines);
    expect(line).toMatch(/^dense\.jev=partial dense\.jev_requests=2 dense\.jev_answered=(\d+)\/170 /);
    expect(Number(line.match(/answered=(\d+)/)?.[1])).toBeGreaterThan(0);
    const off = await run({ jevEnabled: false }, answerAll(() => 0.5));
    expect(mixed.text).not.toBe(off.text);
  });

  it('out-of-range and non-numeric noul answers are ignored', async () => {
    const off = await run({ jevEnabled: false }, answerAll(() => 0.5));
    const bad = await run({ jevEnabled: true }, async (_url, init) => {
      const body = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
      const answers = Object.fromEntries(Object.keys(body.questions).map((id, i) => [id, { type: 'noul', noul: i % 2 ? 7 : 'x' }]));
      return { status: 200, ok: true, text: JSON.stringify({ model: 'jev-1.13.0', answers }) };
    });
    expect(denseLine(bad.lines)).toMatch(/dense\.jev_answered=0\/170/);
    expect(bad.text).toBe(off.text);
  });
});
