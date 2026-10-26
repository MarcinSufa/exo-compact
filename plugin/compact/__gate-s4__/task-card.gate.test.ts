import { describe, expect, it, vi } from 'vitest';
import { register } from '../compact.js';
import { estimateTokens, serializedTokens } from '../core/budgets.js';
import { BRIEF_CHECK_FILE } from '../core/brief-check.js';
import { CARD_TOTAL_BUDGET_TOKENS, TASK_CARD_BRIEF_FILE, TASK_CARD_FILE, TASK_CARD_STATE_FILE, cardAcceptance, cardRefreshDue, parseCardReply, parseTaskCardState, renderCardPrompt, renderCardSection } from '../core/task-card.js';
import { sha256 } from '../host/sha256.js';
import { assistantText, fakeHost, humanPrompt, withStrippedRuntimeGlobals, LEGACY_OPTIONS } from './fixtures/helpers.js';
import type { SessionMessage } from '../core/types.js';

const CARD = [
  '# Task card',
  '## Goal',
  'Build the lane fit in src/ui/graph-fit.ts.',
  '## Rules',
  '- Report line 1 is `SLICE r12 DONE` [user, house rules]',
  '- `export const LANE_PAD = 16;` [brief line 12]',
  '## Decisions',
  '- Zoom never goes in.',
  '## Done',
  '- graph-fit.ts written.',
  '## Acceptance checks',
  '- pnpm --filter @acme/app exec vitest run test/r12 passes',
  '- grep `padding-left:22px` in the view test',
  '## Next step',
  'Write test/r12-lane-fit.test.ts.',
].join('\n');

describe('3.49.0 task card schedule', () => {
  it('waits until the context holds 60% of the compaction window', () => {
    expect(cardRefreshDue({ lastTokens: 0, refreshes: 0 }, 47_000, 80_000).due).toBe(false);
    expect(cardRefreshDue({ lastTokens: 0, refreshes: 0 }, 48_000, 80_000).due).toBe(true);
  });

  it('refreshes once per stretch between cuts', () => {
    const first = cardRefreshDue({ lastTokens: 0, refreshes: 0 }, 50_000, 80_000).state;
    expect(first).toEqual({ lastTokens: 50_000, refreshes: 1, stretchDone: true });
    expect(cardRefreshDue(first, 60_000, 80_000).due).toBe(false);
    expect(cardRefreshDue(first, 79_000, 80_000).due).toBe(false);
  });

  it('opens a new stretch after a cut lowered the context', () => {
    const afterCut = cardRefreshDue({ lastTokens: 50_000, refreshes: 3, stretchDone: true }, 22_000, 80_000);
    expect(afterCut).toEqual({ due: false, state: { lastTokens: 0, refreshes: 3, stretchDone: false } });
    expect(cardRefreshDue(afterCut.state, 40_000, 80_000).due).toBe(false);
    expect(cardRefreshDue(afterCut.state, 48_000, 80_000).due).toBe(true);
  });

  it('refreshes for a new task past 45%, and that refresh counts for the stretch', () => {
    const before = { lastTokens: 0, refreshes: 2, stretchDone: false, briefId: 'old' };
    expect(cardRefreshDue(before, 35_000, 80_000, 'new').due).toBe(false);
    const task = cardRefreshDue(before, 36_000, 80_000, 'new');
    expect(task).toEqual({ due: true, state: { lastTokens: 36_000, refreshes: 3, stretchDone: true, briefId: 'new' } });
    expect(cardRefreshDue(task.state, 60_000, 80_000, 'new').due).toBe(false);
    expect(cardRefreshDue(task.state, 60_000, 80_000, 'newer').due).toBe(true);
  });

  it('does not refresh for the same brief twice, even in a new stretch below 60%', () => {
    const afterCut = cardRefreshDue({ lastTokens: 50_000, refreshes: 1, stretchDone: true, briefId: 'b1' }, 20_000, 80_000, 'b1').state;
    expect(cardRefreshDue(afterCut, 40_000, 80_000, 'b1').due).toBe(false);
  });

  it('reads the state of 3.47-3.48, which has no stretch or brief', () => {
    expect(parseTaskCardState(JSON.stringify({ lastTokens: 40_000, refreshes: 2 }))).toEqual({ lastTokens: 40_000, refreshes: 2 });
    expect(parseTaskCardState('{"lastTokens":1,"refreshes":1,"stretchDone":true,"briefId":"x"}')).toEqual({ lastTokens: 1, refreshes: 1, stretchDone: true, briefId: 'x' });
  });

  it('never refreshes without a context reading or a window', () => {
    expect(cardRefreshDue({ lastTokens: 0, refreshes: 0 }, 0, 80_000).due).toBe(false);
    expect(cardRefreshDue({ lastTokens: 0, refreshes: 0 }, 50_000, 0).due).toBe(false);
  });
});

describe('3.47.0 (S4zu) task card text', () => {
  it('asks for the fixed sections and carries the previous card and the brief path forward', () => {
    const prompt = renderCardPrompt(CARD, '/r/briefs/abc.md');
    expect(prompt).toContain('## Acceptance checks');
    expect(prompt).toContain('/r/briefs/abc.md');
    expect(prompt).toContain('Keep every rule and decision in it');
    expect(prompt.endsWith(CARD)).toBe(true);
  });

  it('keeps the card from the heading on and rejects a reply that is not a card', () => {
    expect(parseCardReply(`Sure, here it is.\n\n${CARD}`, estimateTokens)).toBe(CARD);
    expect(parseCardReply('I cannot write that.', estimateTokens)).toBeUndefined();
    expect(parseCardReply('# Task card\nonly a heading', estimateTokens)).toBeUndefined();
  });

  it('trims an oversized card section by section and keeps every heading (3.50.0)', () => {
    const rules = Array.from({ length: 400 }, (_, i) => `- extra rule ${i} about packages/app/src/file-${i}.ts [brief line ${i}]`).join('\n');
    const long = CARD.replace('## Rules\n', `## Rules\n${rules}\n`);
    const card = parseCardReply(long, estimateTokens, 500)!;
    expect(estimateTokens(card)).toBeLessThanOrEqual(500);
    for (const heading of CARD.split('\n').filter((line) => line.startsWith('## '))) expect(card).toContain(heading);
    expect(card).toContain(cardAcceptance(CARD)!.split('\n')[0]);
    expect(card).toMatch(/- \(\d+ more lines cut\)/);
  });

  it('keeps the acceptance checks and the next step in the seed when Rules alone is over the budget (w60i)', () => {
    const rules = Array.from({ length: 60 }, (_, i) => `- Rule ${i}: keep \`src/ui/memory/memory-shell-${i}.tsx\` under 120 lines, no colour literals [brief line ${i}]`).join('\n');
    const long = CARD.replace('## Rules\n', `## Rules\n${rules}\n`);
    const section = renderCardSection(long, '/p/task-card.md', estimateTokens, 1200);
    expect(estimateTokens(section)).toBeLessThanOrEqual(1200);
    expect(section).toContain('### Acceptance checks');
    expect(section).toContain('### Next step');
    expect(section).toContain('more lines in /p/task-card.md)');
  });

  it('cuts at a line when even one line per section does not fit', () => {
    const card = parseCardReply(CARD, estimateTokens, 30)!;
    expect(estimateTokens(card)).toBeLessThanOrEqual(30);
    // 4.7.3 (S5m): the line cut says what it left out (it was a silent prefix; the prefix itself is unchanged).
    const lines = card.split('\n');
    expect(lines.at(-1)).toMatch(/^- \(\d+ more lines? cut\)$/);
    expect(CARD.startsWith(lines.slice(0, -1).join('\n'))).toBe(true);
  });

  it('renders the seed section with the card path and without the top heading', () => {
    const section = renderCardSection(CARD, '/p/task-card.md', estimateTokens, 2500);
    expect(section).toContain('/p/task-card.md');
    expect(section).toContain('`export const LANE_PAD = 16;` [brief line 12]');
    expect(section).not.toContain('# Task card');
  });

  it('reads the acceptance checks and nothing after them', () => {
    expect(cardAcceptance(CARD)).toBe('- pnpm --filter @acme/app exec vitest run test/r12 passes\n- grep `padding-left:22px` in the view test');
    expect(cardAcceptance('# Task card\n## Goal\nx')).toBeUndefined();
  });
});

type Handler = (host: unknown, event: unknown, next: (event?: unknown) => Promise<unknown>) => Promise<unknown>;

function handlers(options: Record<string, unknown> = {}): Record<string, Handler> {
  const on: Record<string, Handler> = {};
  register(((name: string, fn: Handler) => { on[name] = fn; return { catch: (caught: unknown) => { (on as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS, recallPluginRoot: '/plugin', ...options } as never);
  return on;
}

const FLAG = '/tmp/project/.exovault/s4-compact-active';

function host(options: { tokens?: number; window?: number; files?: Record<string, string>; reply?: string | null } = {}) {
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  const logs: string[] = [];
  const prompts: string[] = [];
  let release: () => void = () => {};
  const replied = new Promise<void>((resolve) => { release = resolve; });
  return {
    files, logs, prompts, replied,
    session: {
      cwd: async () => '/tmp/project',
      id: async () => 's1',
      usage: async () => ({ context: { tokens: options.tokens ?? 40_000, window: 1_000_000, breakdown: { rawMaxTokens: options.window ?? 80_000 } } }),
    },
    fs: {
      exists: async (p: string) => p === FLAG || files.has(p),
      read: async (p: string) => { if (files.has(p)) return files.get(p)!; throw new Error('ENOENT'); },
      write: async (p: string, text: string) => { files.set(p, text); if (p.endsWith(`/${TASK_CARD_FILE}`)) release(); },
      list: async () => [],
    },
    env: { get: async (name: string) => (name === 'HOME' ? '/home/u' : undefined) },
    process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    model: { fork: async ({ prompt }: { prompt: string }) => { prompts.push(prompt); return options.reply === null ? null : { text: options.reply ?? CARD, usage: {} }; } },
    ui: { log: (line: string) => { logs.push(line); } },
  };
}

const toolDone = { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} };
const pass = async () => ({});
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const cardFile = (h: ReturnType<typeof host>) => [...h.files.entries()].find(([p]) => p.endsWith(`/${TASK_CARD_FILE}`))?.[1];

describe('3.47.0 (S4zu) task card refresh', () => {
  it('forks the main thread past 60% of the window and writes the card it answers', async () => {
    const h = host({ tokens: 50_000 });
    await handlers()['classic.PostToolUse']!(h, toolDone, pass);
    await h.replied;
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain('## Acceptance checks');
    expect(cardFile(h)).toBe(`${CARD}\n`);
    expect(h.logs).toContain('task_card.refresh=start ctx=50000 window=80000 n=1');
  });

  it('4.9.2: a key the fork copies into the card is redacted before the card reaches the disk', async () => {
    const key = 'ghp_CCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    const h = host({ tokens: 50_000, reply: CARD.replace('## Rules\n', `## Rules\n- Push with the token ${key}.\n`) });
    await handlers()['classic.PostToolUse']!(h, toolDone, pass);
    await h.replied;
    expect(cardFile(h)).toContain('- Push with the token [redacted].');
    expect(cardFile(h)).not.toContain(key);
  });

  it('records next to the card the id of the newest saved brief it was written for (3.48.1)', async () => {
    const index = `/home/u/.claude/exovault/recall/${sha256('s1')}/briefs/briefs.json`;
    const h = host({ tokens: 40_000, files: { [index]: JSON.stringify([{ id: '653bdcf9b439', path: '/r/b.md', chars: 900, at: '2026-10-03T21:14:35.121Z', firstLine: 'Task 3 of 8.' }]) } });
    await handlers()['classic.PostToolUse']!(h, toolDone, pass);
    await h.replied;
    await settle();
    expect(h.files.get(`/tmp/project/.exovault/s4-capture/s1/${TASK_CARD_BRIEF_FILE}`)).toBe('653bdcf9b439');
  });

  it('3.49.0: below 60% forks only for a new task (a newer saved brief)', async () => {
    const plain = host({ tokens: 40_000 });
    await handlers()['classic.PostToolUse']!(plain, toolDone, pass);
    await settle();
    expect(plain.prompts).toHaveLength(0);
    const index = `/home/u/.claude/exovault/recall/${sha256('s1')}/briefs/briefs.json`;
    const brief = JSON.stringify([{ id: '0000000000b2', path: '/r/b2.md', chars: 900, at: '2026-10-03T21:14:35.121Z', firstLine: 'Task 4 of 8.' }]);
    const state = `/tmp/project/.exovault/s4-capture/s1/${TASK_CARD_STATE_FILE}`;
    const seen = host({ tokens: 40_000, files: { [index]: brief, [state]: JSON.stringify({ lastTokens: 0, refreshes: 1, stretchDone: false, briefId: '0000000000b2' }) } });
    await handlers()['classic.PostToolUse']!(seen, toolDone, pass);
    await settle();
    expect(seen.prompts).toHaveLength(0);
    const fresh = host({ tokens: 40_000, files: { [index]: brief, [state]: JSON.stringify({ lastTokens: 0, refreshes: 1, stretchDone: false, briefId: '0000000000b1' }) } });
    await handlers()['classic.PostToolUse']!(fresh, toolDone, pass);
    await fresh.replied;
    expect(fresh.prompts).toHaveLength(1);
  });

  it('does not fork below the first share, in a subagent or with the option off', async () => {
    const below = host({ tokens: 30_000 });
    await handlers()['classic.PostToolUse']!(below, toolDone, pass);
    const agent = host({ tokens: 50_000 });
    await handlers()['classic.PostToolUse']!(agent, { ...toolDone, agent_id: 'a1' }, pass);
    const off = host({ tokens: 50_000 });
    await handlers({ taskCard: false })['classic.PostToolUse']!(off, toolDone, pass);
    await settle();
    expect(below.prompts).toHaveLength(0);
    expect(agent.prompts).toHaveLength(0);
    expect(off.prompts).toHaveLength(0);
  });

  it('keeps the previous card when the fork fails or answers something else', async () => {
    const files = { [`/tmp/project/.exovault/s4-capture/s1/${TASK_CARD_FILE}`]: 'old card' };
    for (const reply of [null, 'no card here']) {
      const h = host({ tokens: 50_000, reply, files });
      await handlers()['classic.PostToolUse']!(h, toolDone, pass);
      await settle();
      expect([...h.files.values()]).toContain('old card');
      expect(h.logs.some((line) => /task_card\.refresh=(no_reply|unparsed)/.test(line))).toBe(true);
    }
  });

  it('3.52.0: gives the refresh back when the fork fails, so the next tool call retries it (w60k)', async () => {
    const statePath = `/tmp/project/.exovault/s4-capture/s1/${TASK_CARD_STATE_FILE}`;
    const before = JSON.stringify({ lastTokens: 0, refreshes: 7, stretchDone: false });
    for (const fail of ['throw', 'null'] as const) {
      const h = host({ tokens: 50_000, reply: fail === 'null' ? null : undefined, files: { [statePath]: before } });
      if (fail === 'throw') h.model.fork = async () => { throw new Error('no main-thread response to fork yet'); };
      const on = handlers();
      await on['classic.PostToolUse']!(h, toolDone, pass);
      await settle();
      expect(parseTaskCardState(h.files.get(statePath))).toEqual(parseTaskCardState(before));
      h.model.fork = async ({ prompt }: { prompt: string }) => { h.prompts.push(prompt); return { text: CARD, usage: {} }; };
      await on['classic.PostToolUse']!(h, toolDone, pass);
      await h.replied;
      await settle();
      expect(cardFile(h)).toBe(`${CARD}\n`);
      expect(JSON.parse(h.files.get(statePath)!)).toEqual({ lastTokens: 50_000, refreshes: 8, stretchDone: true });
    }
  });

  // 4.7.1 (S5l): since Claude Code 2.1.287 `$.model.fork` resolves to `{ isAnswered: true, text, usage }` or `{ isAnswered: false, reason }`.
  describe('4.7.1: the $.model.fork result shape', () => {
    const statePath = `/tmp/project/.exovault/s4-capture/s1/${TASK_CARD_STATE_FILE}`;
    const before = JSON.stringify({ lastTokens: 0, refreshes: 7, stretchDone: false });
    const refreshWith = async (fork: () => Promise<unknown>) => {
      const h = host({ tokens: 50_000, files: { [statePath]: before } });
      h.model.fork = (async () => fork()) as never;
      await handlers()['classic.PostToolUse']!(h, toolDone, pass);
      await settle();
      return h;
    };
    for (const reason of ['nothing-to-fork', 'api-error', 'empty-reply', 'aborted'] as const) {
      it(`isAnswered:false (${reason}) gives the step back and logs the reason`, async () => {
        const h = await refreshWith(async () => (reason === 'api-error' ? { isAnswered: false, reason, status: 529, error: 'overloaded' } : { isAnswered: false, reason }));
        expect(parseTaskCardState(h.files.get(statePath))).toEqual(parseTaskCardState(before));
        expect(h.logs).toContain(`task_card.refresh=no_reply reason=${reason}`);
        expect(h.logs).not.toContain('task_card.refresh=error');
        expect(cardFile(h)).toBeUndefined();
      });
    }
    it('the old null result gives the step back and logs no_reply with reason null', async () => {
      const h = await refreshWith(async () => null);
      expect(parseTaskCardState(h.files.get(statePath))).toEqual(parseTaskCardState(before));
      expect(h.logs).toContain('task_card.refresh=no_reply reason=null');
      expect(h.logs).not.toContain('task_card.refresh=error');
    });
    it('isAnswered:true writes the card as before', async () => {
      const h = host({ tokens: 50_000 });
      h.model.fork = (async () => ({ isAnswered: true, text: CARD, usage: {} })) as never;
      await handlers()['classic.PostToolUse']!(h, toolDone, pass);
      await h.replied;
      await settle();
      expect(cardFile(h)).toBe(`${CARD}\n`);
      expect(h.logs.some((line) => /^task_card\.refresh=written size=\d+$/.test(line))).toBe(true);
    });
    it('a reply that is not a card keeps the step spent and logs unparsed', async () => {
      const h = await refreshWith(async () => ({ isAnswered: true, text: 'no card here', usage: {} }));
      expect(parseTaskCardState(h.files.get(statePath))).not.toEqual(parseTaskCardState(before));
      expect(h.logs.some((line) => line.startsWith('task_card.refresh=unparsed'))).toBe(true);
    });
  });

  it('keeps the step spent when the fork answers something that is not a card', async () => {
    const h = host({ tokens: 50_000, reply: 'no card here' });
    const on = handlers();
    await on['classic.PostToolUse']!(h, toolDone, pass);
    await settle();
    await on['classic.PostToolUse']!(h, toolDone, pass);
    await settle();
    expect(h.prompts).toHaveLength(1);
  });

  it('records the refresh so the next tool call within the step does not fork again', async () => {
    const h = host({ tokens: 50_000 });
    const on = handlers();
    await on['classic.PostToolUse']!(h, toolDone, pass);
    await h.replied;
    await on['classic.PostToolUse']!(h, toolDone, pass);
    await settle();
    expect(h.prompts).toHaveLength(1);
    const state = [...h.files.entries()].find(([p]) => p.endsWith(`/${TASK_CARD_STATE_FILE}`))?.[1];
    expect(JSON.parse(state!)).toEqual({ lastTokens: 50_000, refreshes: 1, stretchDone: true });
  });
});

describe('3.47.0 (S4zu) stop check from the card', () => {
  const stop = { hook_event_name: 'Stop', session_id: 's1', transcript_path: '/t.jsonl', cwd: '/tmp/project', stop_hook_active: false };
  const found = JSON.stringify({ brief: 'abc', path: '/r/briefs/abc.md', whole: true, lines: [{ line: 1, text: 'the whole brief' }], text: '1: the whole brief' });

  it('blocks with the card acceptance checks instead of the whole brief', async () => {
    const h = host({ files: { [`/tmp/project/.exovault/s4-capture/s1/${BRIEF_CHECK_FILE}`]: found, [`/tmp/project/.exovault/s4-capture/s1/${TASK_CARD_FILE}`]: CARD } });
    const result = await handlers()['classic.Stop']!(h, stop, pass) as { block?: string };
    expect(result.block).toContain('grep `padding-left:22px` in the view test');
    expect(result.block).toContain('/r/briefs/abc.md');
    expect(result.block).not.toContain('the whole brief');
    expect(result.block).toMatch(/write your final report again, in full, as your last message/);
    expect(h.logs.some((line) => line.startsWith('brief_check.fired=1 source=card'))).toBe(true);
  });

  it('falls back to the brief lines when the card has no acceptance checks', async () => {
    const h = host({ files: { [`/tmp/project/.exovault/s4-capture/s1/${BRIEF_CHECK_FILE}`]: found, [`/tmp/project/.exovault/s4-capture/s1/${TASK_CARD_FILE}`]: '# Task card\n## Goal\nx' } });
    const result = await handlers()['classic.Stop']!(h, stop, pass) as { block?: string };
    expect(result.block).toContain('1: the whole brief');
  });
});

describe('3.47.0 (S4zu) task card in the seed', () => {
  function conversation(): SessionMessage[] {
    const messages: SessionMessage[] = [];
    for (let i = 0; i < 60; i += 1) {
      messages.push(humanPrompt(`turn ${i}: check packages/app/src/part-${i}.ts`));
      messages.push(assistantText(`Updated packages/app/src/part-${i}.ts:${i * 7} ${'x[1]=2; '.repeat(300)}`));
    }
    return messages;
  }

  async function cut(options: Record<string, unknown>, withCard: boolean, extra: Record<string, string> = {}, lastPrompt?: string) {
    const lines: string[] = [];
    const extraFile = (path: string) => Object.keys(extra).find((suffix) => path.endsWith(suffix));
    const $ = fakeHost({
      fsExists: async (path) => path.endsWith('/.exovault/s4-compact-active') || (withCard && path.endsWith(`/${TASK_CARD_FILE}`)) || extraFile(path) !== undefined,
      fsRead: async (path) => {
        if (path.endsWith('/.exovault/s4-compact-active')) return '1';
        if (withCard && path.endsWith(`/${TASK_CARD_FILE}`)) return CARD;
        const key = extraFile(path);
        if (key !== undefined) return extra[key]!;
        throw new Error(`ENOENT: ${path}`);
      },
      envGet: async (name: string) => (name === 'HOME' ? '/home/u' : undefined),
      uiLog: (line: string) => lines.push(line),
    });
    const on: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    register(((name: string, handler: never) => { on[name] = handler; return { catch: (caught: unknown) => { (on as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS, denseNotes: true, ...options } as never);
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const result = (await withStrippedRuntimeGlobals(() => on['session.compact']!($, { trigger: 'auto', messages: lastPrompt === undefined ? conversation() : [...conversation(), humanPrompt(lastPrompt)] }, next))) as { messages?: SessionMessage[] };
    return { lines, next, messages: result.messages ?? [] };
  }

  it('puts the card in the seed under an 8000-token total by default', async () => {
    const { lines, next, messages } = await cut({}, true);
    expect(next).not.toHaveBeenCalled();
    expect(lines).toContain(`seed.budget_total=${CARD_TOTAL_BUDGET_TOKENS} seed.budget_count=real`);
    expect(lines.some((line) => line.startsWith('seed.task_card=1 '))).toBe(true);
    expect(JSON.stringify(messages[0])).toContain('## Task card');
    expect(serializedTokens(messages, estimateTokens)).toBeLessThanOrEqual(CARD_TOTAL_BUDGET_TOKENS);
  });

  it('3.53.0: leaves out a card written for an earlier brief than the newest one (w60m r2)', async () => {
    const briefs = JSON.stringify([
      { id: '0000000000b1', path: '/home/u/r/b1.md', chars: 900, at: '2026-10-04T00:20:00.000Z', firstLine: 'Task 7 of 8.' },
      { id: '0000000000b2', path: '/home/u/r/b2.md', chars: 900, at: '2026-10-04T00:25:00.000Z', firstLine: 'Task 8 of 8.' },
    ]);
    const files = (cardBrief: string) => ({ '/briefs/briefs.json': briefs, [`/${TASK_CARD_BRIEF_FILE}`]: cardBrief, '/r/b2.md': `Task 8 of 8. ${'Build the shell. '.repeat(40)}` });
    const stale = await cut({ recallEnabled: true }, true, files('0000000000b1'));
    expect(stale.lines).toContain('seed.task_card_stale=1 seed.brief_last_prompt=0');
    expect(stale.lines).toContain('seed.task_card=0 seed.task_card_size=0');
    expect(JSON.stringify(stale.messages[0])).not.toContain('## Task card');
    expect(JSON.stringify(stale.messages[0])).toContain('Task 8 of 8');
    const current = await cut({ recallEnabled: true }, true, files('0000000000b2'));
    expect(current.lines.some((line) => line.startsWith('seed.task_card_stale=1'))).toBe(false);
    expect(JSON.stringify(current.messages[0])).toContain('## Task card');
  });

  it('3.54.0: a cut on the new task prompt keeps the card total and the prompt in the tail, without a second copy of the brief (w60n)', async () => {
    const brief = `Task 8 of 8. The harness committed your previous task. ${'Build the shell and keep every limit. '.repeat(120)}`;
    const briefs = JSON.stringify([
      { id: '0000000000b1', path: '/home/u/r/b1.md', chars: 900, at: '2026-10-04T00:20:00.000Z', firstLine: 'Task 7 of 8.' },
      { id: '0000000000b2', path: '/home/u/r/b2.md', chars: brief.length, at: '2026-10-04T00:25:00.000Z', firstLine: brief.slice(0, 200) },
    ]);
    const { lines, next, messages } = await cut({ recallEnabled: true }, true, { '/briefs/briefs.json': briefs, [`/${TASK_CARD_BRIEF_FILE}`]: '0000000000b1', '/r/b2.md': brief }, brief);
    expect(next).not.toHaveBeenCalled();
    expect(lines).toContain('seed.task_card_stale=1 seed.brief_last_prompt=1');
    expect(lines).toContain(`seed.budget_total=${CARD_TOTAL_BUDGET_TOKENS} seed.budget_count=real`);
    expect(lines.some((line) => line.startsWith('seed.full_brief='))).toBe(false);
    const seed = JSON.stringify(messages[0]);
    expect(seed).not.toContain('## Task card');
    expect(seed).not.toContain('Build the shell and keep every limit. '.repeat(4));
    expect(messages.at(-1)!.text).toBe(brief);
  });

  it('3.55.0: a prompt that repeats only the brief heading does not count as the brief in the tail (review 5 B1)', async () => {
    const head = 'Please carry out the following implementation task.';
    const full = `${head}\n${'REQUIRED_SPEC_SENTINEL: retain this exact requirement.\n'.repeat(70)}`;
    const briefs = JSON.stringify([{ id: '0000000000b2', path: '/r/new.md', chars: full.length, at: '2026-10-04T00:00:00Z', firstLine: head }]);
    const { lines, next, messages } = await cut({ recallEnabled: true }, true, { '/briefs/briefs.json': briefs, [`/${TASK_CARD_BRIEF_FILE}`]: '0000000000b1', '/r/new.md': full }, `${head}\nPlease continue.`);
    expect(next).not.toHaveBeenCalled();
    expect(lines).toContain('seed.task_card_stale=1 seed.brief_last_prompt=0');
    expect(JSON.stringify(messages[0])).toContain('REQUIRED_SPEC_SENTINEL');
  });

  it('cuts within the same total before any card exists', async () => {
    const { lines, next } = await cut({}, false);
    expect(next).not.toHaveBeenCalled();
    expect(lines).toContain('seed.task_card=0 seed.task_card_size=0');
  });
});

describe('3.55.0 card lifecycle (external review 5 A1-A2)', () => {
  it('two hooks at once fork the card once', async () => {
    const h = host({ tokens: 50_000 });
    const on = handlers();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    h.model.fork = async ({ prompt }) => { h.prompts.push(prompt); await barrier; return { text: CARD, usage: {} }; };
    await Promise.all([on['classic.PostToolUse']!(h, toolDone, pass), on['classic.PostToolUse']!(h, toolDone, pass)]);
    await settle();
    expect(h.prompts).toHaveLength(1);
    release();
    await settle();
  });

  it('a fork that never ran does not roll back a state another refresh wrote since', async () => {
    const statePath = `/tmp/project/.exovault/s4-capture/s1/${TASK_CARD_STATE_FILE}`;
    const h = host({ tokens: 50_000 });
    let reply!: (value: null) => void;
    h.model.fork = async ({ prompt }) => { h.prompts.push(prompt); return await new Promise<null>((resolve) => { reply = resolve; }); };
    await handlers()['classic.PostToolUse']!(h, toolDone, pass);
    await settle();
    const newer = JSON.stringify({ lastTokens: 70_000, refreshes: 2, stretchDone: true });
    h.files.set(statePath, newer);
    reply(null);
    await settle();
    expect(h.files.get(statePath)).toBe(newer);
  });

  it('a stop with a stale card blocks with the new brief, not the stale card checks', async () => {
    const index = `/home/u/.claude/exovault/recall/${sha256('s1')}/briefs/briefs.json`;
    const base = '/tmp/project/.exovault/s4-capture/s1';
    const h = host({ files: {
      [index]: JSON.stringify([{ id: '0000000000b2', path: '/r/new.md', chars: 900, at: '2026-10-04T00:00:00Z', firstLine: 'New task' }]),
      [`${base}/${TASK_CARD_BRIEF_FILE}`]: '0000000000b1',
      [`${base}/${TASK_CARD_FILE}`]: CARD,
      [`${base}/${BRIEF_CHECK_FILE}`]: JSON.stringify({ brief: '0000000000b2', path: '/r/new.md', whole: true, lines: [{ line: 1, text: 'NEW TASK ONLY' }], text: 'NEW TASK ONLY' }),
    } });
    const out = await handlers({ ruleCheck: true })['classic.Stop']!(h, { stop_hook_active: false, last_assistant_message: 'done' }, pass) as { block?: string };
    expect(h.logs).toContain('rule_check.fired=0 reason=card_stale');
    expect(out.block).not.toContain('padding-left:22px');
    expect(out.block).toContain('NEW TASK ONLY');
  });
});
