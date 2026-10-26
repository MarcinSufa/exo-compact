import { describe, it, expect, vi } from 'vitest';
import { register, unwrapPastes } from '../compact.js';
import { fakeHost, humanPrompt, assistantText, withStrippedRuntimeGlobals, LEGACY_OPTIONS } from './fixtures/helpers.js';
import { BRIEF_MIN_CHARS } from '../core/briefs.js';
import type { SessionMessage } from '../core/types.js';

type Handler = (host: unknown, event: unknown, next: (event?: unknown) => Promise<unknown>) => Promise<unknown>;
const FLAG_PATH = '/tmp/project/.exovault/s4-compact-active';
const TURN_RUNNING = 'exo-compact: $.session.compact: a turn is running (t1); the conversation compacts between turns, so call it from turn.complete or later';

const HOOK_HOLDING = 'exo-compact: session.compact: called from a prompt.submit hook, it would compact under the turn this hook is holding; call it from a later event (turn.complete)';

const longBrief = (label: string): string => `${label}\n\n${Array.from({ length: 80 }, (_, i) => `- Requirement ${i + 1}: preserve the existing API and verify the complete task output.`).join('\n')}`;
const history = (): SessionMessage[] => [humanPrompt('Previous task\nrequirement'), assistantText('Work completed.')];

/** compactErrors: the messages the next compact() calls reject with, in order; afterwards compact resolves. */
function harness(opts: { compactErrors: (string | 'forever')[]; fillResult?: { isFilled: boolean } | 'reject'; submitReject?: boolean; surfaces?: string[]; noRoot?: boolean; writeThrows?: boolean; sleep?: (ms: number) => Promise<void>; pluginRoot?: string }) {
  const on: Record<string, Handler> = {};
  register(((name: string, fn: Handler) => { on[name] = fn; return { catch: (caught: unknown) => { (on as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS, notices: 'all', cutOnNewBrief: true, taskCard: false, workState: false, workStateProbe: false, recallEnabled: false, adoptedFiles: false, timeoutMs: 30000 } as never);
  const logs: string[] = [];
  const runs: string[][] = [];
  const files = new Map<string, string>();
  const queue = [...opts.compactErrors];
  const compact = vi.fn(async () => {
    const e = queue[0];
    if (e === 'forever') throw new Error(TURN_RUNNING);
    if (e !== undefined) { queue.shift(); throw new Error(e); }
  });
  const fill = vi.fn(async (_: { text: string }) => {
    if (opts.fillResult === 'reject') throw new Error('nope');
    return opts.fillResult ?? { isFilled: true };
  });
  const submit = vi.fn(async (_: { text: string }) => { if (opts.submitReject) throw new Error('no'); });
  const toast = vi.fn();
  const base = fakeHost({
    sessionId: async () => 's1',
    sessionCwd: async () => '/tmp/project',
    sessionMessages: async () => history(),
    sessionCompact: compact as never,
    clockSleep: async (ms) => { await opts.sleep?.(ms); },
    fsExists: async (path) => !opts.noRoot && (path === FLAG_PATH || files.has(path)),
    fsRead: async (path) => { if (path === FLAG_PATH) return '1'; const t = files.get(path); if (t !== undefined) return t; throw new Error('ENOENT'); },
    fsWrite: async (path, text) => { if (opts.writeThrows) throw new Error('disk\nfull'); files.set(path, text); },
    uiLog: (line) => logs.push(line),
    pluginRoot: opts.pluginRoot,
    processRun: async (argv) => { runs.push(argv); return { exitCode: 0, stdout: '', stderr: '' }; },
  });
  const host = {
    ...base,
    ui: { ...base.ui, toast },
    prompt: { fill, submit },
    session: { ...base.session, surfaces: async () => opts.surfaces ?? ['terminal'] },
  };
  return { on, host, logs, files, compact, fill, submit, toast, runs };
}

async function submitPrompt(h: ReturnType<typeof harness>, text: string, extra: Record<string, unknown> = {}) {
  const input = { text, origin: { kind: 'composer' }, wait: false, ...extra };
  const next = vi.fn(async (event: unknown) => event);
  const result = await withStrippedRuntimeGlobals(() => h.on['prompt.submit']!(h.host, input, next));
  await new Promise((r) => setTimeout(r, 20));
  return { input, next, result };
}

describe('4.6.0 (S5g) cutOnNewBrief hold and return', () => {
  it('holds the brief when the engine refuses a cut, compacts on retry, and puts the brief back with fill', async () => {
    const h = harness({ compactErrors: [TURN_RUNNING, TURN_RUNNING] });
    const brief = longBrief('Task 2');
    const { next, result } = await submitPrompt(h, brief);
    expect(result).toEqual({ drop: expect.stringContaining('press Enter') });
    expect(next).not.toHaveBeenCalled();
    expect([...h.files.entries()].find(([p]) => p.endsWith('/held-brief.md'))?.[1]).toBe(brief);
    expect(h.compact).toHaveBeenCalledTimes(3);
    expect(h.fill).toHaveBeenCalledWith({ text: brief });
    expect(h.logs).toContain('compact.trigger=new_brief');
    expect(h.logs).toContain('compact.brief_returned=fill');
  });

  it('4.9.2 (S5u): deletes the verbatim held brief once it is back in the prompt box (fill or submit), keeps it when lost', async () => {
    const removals = (h: ReturnType<typeof harness>) => h.runs.filter((argv) => argv[1] === '/plugins/exo-compact/harden.mjs' && argv.includes('--remove'));
    const filled = harness({ compactErrors: [TURN_RUNNING], pluginRoot: '/plugins/exo-compact' });
    await submitPrompt(filled, longBrief('Task 2'));
    expect(removals(filled)).toEqual([['node', '/plugins/exo-compact/harden.mjs', '/tmp/project', '/tmp/project/.exovault/s4-capture/s1', '--remove', 'held-brief.md']]);
    const submitted = harness({ compactErrors: [TURN_RUNNING], fillResult: { isFilled: false }, pluginRoot: '/plugins/exo-compact' });
    await submitPrompt(submitted, longBrief('Task 2'));
    expect(submitted.logs).toContain('compact.brief_returned=submit');
    expect(removals(submitted)).toHaveLength(1);
    const lost = harness({ compactErrors: [TURN_RUNNING], fillResult: 'reject', submitReject: true, pluginRoot: '/plugins/exo-compact' });
    await submitPrompt(lost, longBrief('Task 2'));
    expect(lost.logs).toContain('compact.brief_returned=lost');
    expect(removals(lost)).toEqual([]);
  });

  it('lets the returned brief through unchanged on the next submit without cutting again', async () => {
    const h = harness({ compactErrors: [TURN_RUNNING] });
    const brief = longBrief('Task 2');
    await submitPrompt(h, brief);
    const calls = h.compact.mock.calls.length;
    const { next, input } = await submitPrompt(h, brief);
    expect(next).toHaveBeenCalledWith(input);
    expect(h.compact).toHaveBeenCalledTimes(calls);
    expect(h.logs).toContain('compact.trigger_skipped=brief_returned');
  });

  it('falls back to submit when fill reports isFilled false', async () => {
    const h = harness({ compactErrors: [TURN_RUNNING], fillResult: { isFilled: false } });
    const brief = longBrief('Task 2');
    await submitPrompt(h, brief);
    expect(h.submit).toHaveBeenCalledWith({ text: brief });
    expect(h.logs).toContain('compact.brief_returned=submit');
  });

  it('logs lost and a toast naming held-brief.md when fill and submit both fail', async () => {
    const h = harness({ compactErrors: [TURN_RUNNING], fillResult: 'reject', submitReject: true });
    await submitPrompt(h, longBrief('Task 2'));
    expect(h.logs).toContain('compact.brief_returned=lost');
    expect(h.toast).toHaveBeenCalledWith(expect.stringContaining('held-brief.md'));
  });

  it('still returns the brief after the retry limit and logs compact_error plus compact.error', async () => {
    const h = harness({ compactErrors: ['forever'] });
    const brief = longBrief('Task 2');
    await submitPrompt(h, brief);
    expect(h.fill).toHaveBeenCalledWith({ text: brief });
    expect(h.logs).toContain('compact.trigger_skipped=compact_error');
    expect(h.logs.some((l) => l.startsWith('compact.error=') && l.includes('a turn is running'))).toBe(true);
    expect(h.logs).toContain('compact.brief_returned=fill');
  });

  it('does not hold a prompt with attachments', async () => {
    const h = harness({ compactErrors: [TURN_RUNNING] });
    const { next, input } = await submitPrompt(h, longBrief('Task 2'), { attachments: [{ type: 'image' }, { type: 'audio' }] });
    expect(next).toHaveBeenCalledWith(input);
    expect(h.fill).not.toHaveBeenCalled();
    expect(h.logs).toContain('compact.trigger_skipped=compact_error');
    expect(h.logs).toContain('compact.hold_skipped=attachments:image,audio');
  });

  it('holds on the interactive hooks-worker refusal text (HOOK_HOLDING) and returns the brief with fill', async () => {
    const h = harness({ compactErrors: [HOOK_HOLDING] });
    const brief = longBrief('Task 2');
    const { next, result } = await submitPrompt(h, brief);
    expect(result).toEqual({ drop: expect.stringContaining('press Enter') });
    expect(next).not.toHaveBeenCalled();
    expect([...h.files.entries()].find(([p]) => p.endsWith('/held-brief.md'))?.[1]).toBe(brief);
    expect(h.fill).toHaveBeenCalledWith({ text: brief });
    expect(h.logs).toContain('compact.trigger=new_brief');
    expect(h.logs).toContain('compact.brief_returned=fill');
  });

  it('keeps retrying on HOOK_HOLDING until the cut runs', async () => {
    const h = harness({ compactErrors: [HOOK_HOLDING, HOOK_HOLDING] });
    await submitPrompt(h, longBrief('Task 2'));
    expect(h.compact).toHaveBeenCalledTimes(3);
    expect(h.logs).toContain('compact.trigger=new_brief');
    expect(h.logs).toContain('compact.brief_returned=fill');
  });

  it('does not hold a prompt with attachments on HOOK_HOLDING', async () => {
    const h = harness({ compactErrors: [HOOK_HOLDING] });
    const { next, input } = await submitPrompt(h, longBrief('Task 2'), { attachments: [{ type: 'image' }, { type: 'audio' }] });
    expect(next).toHaveBeenCalledWith(input);
    expect(h.fill).not.toHaveBeenCalled();
    expect(h.logs).toContain('compact.hold_skipped=attachments:image,audio');
  });

  it('logs no_capture_root when there is nowhere to write the held brief', async () => {
    const h = harness({ compactErrors: [TURN_RUNNING], noRoot: true });
    const { next, input } = await submitPrompt(h, longBrief('Task 2'));
    expect(next).toHaveBeenCalledWith(input);
    expect(h.logs).toContain('compact.trigger_skipped=compact_error');
    expect(h.logs).toContain('compact.error=' + TURN_RUNNING.slice(0, 120));
    expect(h.logs).toContain('compact.hold_skipped=no_capture_root');
  });

  it('logs hold_error with the cleaned message when the held-brief write throws', async () => {
    const h = harness({ compactErrors: [TURN_RUNNING], writeThrows: true });
    const { next, input } = await submitPrompt(h, longBrief('Task 2'));
    expect(next).toHaveBeenCalledWith(input);
    expect(h.logs).toContain('compact.hold_skipped=hold_error:disk full');
  });

  it('does not hold when the session has no prompt box (headless)', async () => {
    const h = harness({ compactErrors: [TURN_RUNNING], surfaces: [] });
    const { next, input } = await submitPrompt(h, longBrief('Task 2'));
    expect(next).toHaveBeenCalledWith(input);
    expect(h.fill).not.toHaveBeenCalled();
    expect(h.logs).toContain('compact.trigger_skipped=headless');
  });

  it('keeps pass-through for any other compact error', async () => {
    const h = harness({ compactErrors: ['boom'] });
    const { next, input } = await submitPrompt(h, longBrief('Task 2'));
    expect(next).toHaveBeenCalledWith(input);
    expect(h.fill).not.toHaveBeenCalled();
    expect(h.logs).toContain('compact.trigger_skipped=compact_error');
    expect(h.logs).toContain('compact.error=boom');
    expect(h.logs.some((l) => l.startsWith('compact.hold_skipped='))).toBe(false);
  });
});

describe('4.6.0 (S5g) the returned-brief flag is consumed only by a cut candidate', () => {
  it('a short submit during the retry window leaves the flag, so the returned brief is not cut again', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({ compactErrors: [TURN_RUNNING, TURN_RUNNING], sleep: () => gate });
    const brief = longBrief('Task 2');
    await submitPrompt(h, brief);
    expect(h.compact).toHaveBeenCalledTimes(2);
    const ok = await submitPrompt(h, 'ok');
    expect(ok.next).toHaveBeenCalledWith(ok.input);
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.logs).toContain('compact.brief_returned=fill');
    const calls = h.compact.mock.calls.length;
    const { next, input } = await submitPrompt(h, brief);
    expect(next).toHaveBeenCalledWith(input);
    expect(h.compact).toHaveBeenCalledTimes(calls);
    expect(h.logs).toContain('compact.trigger_skipped=brief_returned');
  });
});

describe('4.6.0 (S5g) threshold and retry cap', () => {
  it('does not cut a prompt of BRIEF_MIN_CHARS - 1 characters', async () => {
    const h = harness({ compactErrors: [] });
    const { next, input } = await submitPrompt(h, 'a'.repeat(BRIEF_MIN_CHARS - 1));
    expect(next).toHaveBeenCalledWith(input);
    expect(h.compact).not.toHaveBeenCalled();
  });

  it('cuts a prompt of exactly BRIEF_MIN_CHARS characters', async () => {
    const h = harness({ compactErrors: [] });
    const { next, input } = await submitPrompt(h, 'a'.repeat(BRIEF_MIN_CHARS));
    expect(next).toHaveBeenCalledWith(input);
    expect(h.compact).toHaveBeenCalledTimes(1);
    expect(h.logs).toContain('compact.trigger=new_brief');
  });

  it('retries a forever refusal exactly 100 times after the first refusal, sleeping 100 ms between tries', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const h = harness({ compactErrors: ['forever'], sleep });
    await submitPrompt(h, longBrief('Task 2'));
    expect(h.compact).toHaveBeenCalledTimes(101);
    expect(sleep).toHaveBeenCalledTimes(100);
    expect(sleep.mock.calls.every(([ms]) => ms === 100)).toBe(true);
  });
});

describe('4.6.0 (S5g) returned brief is unwrapped from paste tags', () => {
  const inner = longBrief('Pasted task');
  const wrap = (id: string, text: string): string => `<pasted_content id="${id}">\n${text}\n</pasted_content id="${id}">`;
  const heldFile = (h: ReturnType<typeof harness>): string | undefined => [...h.files.entries()].find(([p]) => p.endsWith('/held-brief.md'))?.[1];

  it('fills back and saves the bare inner text for the live paste wrapper', async () => {
    const h = harness({ compactErrors: [TURN_RUNNING] });
    const { next } = await submitPrompt(h, `\n\n${wrap('770d', inner)}\n`);
    expect(next).not.toHaveBeenCalled();
    expect(h.fill).toHaveBeenCalledWith({ text: inner });
    expect(heldFile(h)).toBe(inner);
  });

  it('uses the bare text for the submit fallback too', async () => {
    const h = harness({ compactErrors: [TURN_RUNNING], fillResult: { isFilled: false } });
    await submitPrompt(h, `\n\n${wrap('770d', inner)}\n`);
    expect(h.submit).toHaveBeenCalledWith({ text: inner });
  });

  it('keeps typed text around and between pastes and drops only the tags', async () => {
    const h = harness({ compactErrors: [TURN_RUNNING] });
    await submitPrompt(h, `before ${wrap('a1', inner)} middle ${wrap('b2', 'second')} after`);
    expect(h.fill).toHaveBeenCalledWith({ text: `before ${inner} middle second after` });
  });

  it('leaves a mismatched pair as is', async () => {
    const h = harness({ compactErrors: [TURN_RUNNING] });
    const text = `<pasted_content id="a1">\n${inner}\n</pasted_content id="b2">`;
    await submitPrompt(h, text);
    expect(h.fill).toHaveBeenCalledWith({ text });
  });

  it('unwrapPastes unit cases', () => {
    expect(unwrapPastes('\n\n<pasted_content id="x">\nhi \n</pasted_content id="x">\n')).toBe('hi ');
    expect(unwrapPastes('<pasted_content id="x">\nhi')).toBe('<pasted_content id="x">\nhi');
    expect(unwrapPastes('  a  \n')).toBe('  a  ');
    expect(unwrapPastes('<pasted_content id="x">\n\nhi\n\n</pasted_content id="x">')).toBe('hi');
  });
});
