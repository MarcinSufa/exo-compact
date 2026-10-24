import { describe, it, expect, vi } from 'vitest';
import { register } from '../compact.js';
import { TASK_CARD_FILE, TASK_CARD_HORIZON_FILE } from '../core/task-card.js';
import { fakeHost, humanPrompt, assistantText, withStrippedRuntimeGlobals, sha256, LEGACY_OPTIONS } from './fixtures/helpers.js';
import type { SessionMessage } from '../core/types.js';

/** 4.6.0 (CONTRACT S5f): the horizon file next to the card, and the "Since the card" section at the cut. */

const FLAG_PATH = '.exovault/s4-compact-active';
const CAPTURE = '/tmp/project/.exovault/s4-capture/s1';
const NOW = Date.parse('2026-10-07T10:00:00.000Z');
const CARD = ['# Task card', '## Goal', 'Build the sidebar tree.', '## Rules', '- Test titles start with `r5:` [user, turn 40]', '## Acceptance checks', '- app 1486 passing', '## Next step', 'Write the model file.'].join('\n');

type Handler = (host: unknown, event: unknown, next: (event?: unknown) => Promise<unknown>) => Promise<unknown>;
function handlers(options: Record<string, unknown> = {}): Record<string, Handler> {
  const on: Record<string, Handler> = {};
  register(((name: string, fn: Handler) => { on[name] = fn; return { catch: (caught: unknown) => { (on as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS, recallPluginRoot: '/plugin', ...options } as never);
  return on;
}
const pass = async () => ({});
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function use(id: string, tool: string, input: Record<string, unknown>): SessionMessage {
  return { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] };
}
function res(id: string, text = 'ok', isError = false): SessionMessage {
  return { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text, isError }] };
}

/** A host for the refresh hooks: a card is due (50k of 80k), the fork answers `reply`. */
function refreshHost(options: { reply?: string | null; messages?: SessionMessage[] } = {}) {
  const files = new Map<string, string>();
  const logs: string[] = [];
  let release: () => void = () => {};
  const replied = new Promise<void>((resolve) => { release = resolve; });
  return {
    files, logs, replied,
    session: {
      cwd: async () => '/tmp/project',
      id: async () => 's1',
      usage: async () => ({ context: { tokens: 50_000, window: 1_000_000, breakdown: { rawMaxTokens: 80_000 } } }),
      messages: async () => options.messages ?? [],
      surfaces: async () => ['terminal'],
    },
    fs: {
      exists: async (p: string) => p === `/tmp/project/${FLAG_PATH}` || files.has(p),
      read: async (p: string) => { if (files.has(p)) return files.get(p)!; throw new Error('ENOENT'); },
      write: async (p: string, text: string) => { files.set(p, text); if (p.endsWith(`/${TASK_CARD_HORIZON_FILE}`)) release(); },
      list: async () => [],
    },
    env: { get: async (name: string) => (name === 'HOME' ? '/home/u' : undefined) },
    clock: { now: async () => NOW, sleep: async () => undefined, after: () => ({ cancel: () => {} }) },
    process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    model: { fork: async () => (options.reply === null ? null : { text: options.reply ?? CARD, usage: {} }) },
    ui: { log: (line: string) => { logs.push(line); } },
  };
}
const horizonFile = (h: ReturnType<typeof refreshHost>) => h.files.get(`${CAPTURE}/${TASK_CARD_HORIZON_FILE}`);
const postToolUse = (extra: Record<string, unknown> = {}) => ({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {}, ...extra });

describe('4.6.0 (S5f) the horizon file', () => {
  it('is written with the card from PostToolUse, with the call that fired the refresh', async () => {
    const h = refreshHost();
    await handlers()['classic.PostToolUse']!(h, postToolUse({ tool_use_id: 'toolu_77' }), pass);
    await h.replied;
    await settle();
    expect(h.files.get(`${CAPTURE}/${TASK_CARD_FILE}`)).toBe(`${CARD}\n`);
    expect(JSON.parse(horizonFile(h)!)).toEqual({ toolUseId: 'toolu_77', at: '2026-10-07T10:00:00.000Z', tokens: 50_000 });
  });

  it('is written with the card from turn.complete, with the newest tool call in the session', async () => {
    const messages = [humanPrompt('go'), use('toolu_1', 'Read', { file_path: 'a' }), res('toolu_1'), use('toolu_2', 'Bash', { command: 'ls' }), res('toolu_2'), assistantText('done')];
    const h = refreshHost({ messages });
    await handlers()['turn.complete']!(h, { reason: 'answer', answer: 'done' }, pass);
    await h.replied;
    await settle();
    expect(JSON.parse(horizonFile(h)!)).toEqual({ toolUseId: 'toolu_2', at: '2026-10-07T10:00:00.000Z', tokens: 50_000 });
  });

  it('is {} when no tool call has been made yet, so an old horizon never pairs with the new card', async () => {
    const h = refreshHost({ messages: [humanPrompt('go'), assistantText('hi')] });
    h.files.set(`${CAPTURE}/${TASK_CARD_HORIZON_FILE}`, JSON.stringify({ toolUseId: 'toolu_old', at: 'x', tokens: 1 }));
    await handlers()['turn.complete']!(h, { reason: 'answer', answer: 'hi' }, pass);
    await h.replied;
    await settle();
    expect(JSON.parse(horizonFile(h)!)).toEqual({});
  });

  it('is not written when the fork returns no card', async () => {
    for (const reply of [null, 'no card here']) {
      const h = refreshHost({ reply });
      await handlers()['classic.PostToolUse']!(h, postToolUse({ tool_use_id: 'toolu_77' }), pass);
      await settle();
      expect(h.files.has(`${CAPTURE}/${TASK_CARD_FILE}`)).toBe(false);
      expect(horizonFile(h)).toBeUndefined();
    }
  });
});

describe('4.6.0 (S5f) the section at the cut', () => {
  const SESSION = 's1';
  const sectionAfterCard = (seed: string): string | undefined => {
    const parts = seed.split('\n\n## ');
    const at = parts.findIndex((part) => part.startsWith('Task card\n'));
    return at >= 0 && parts[at + 1]?.startsWith('Since the card\n') ? parts[at + 1] : undefined;
  };

  function conversation(): SessionMessage[] {
    const old: SessionMessage[] = [];
    for (let i = 0; i < 20; i += 1) {
      old.push(humanPrompt(`turn ${i}: ${'detail '.repeat(600)}`));
      old.push(assistantText(`reply ${i}: updated packages/app/src/part-${i}.ts:${i * 7} ${'x[1]=2; '.repeat(200)}`));
    }
    return [
      ...old,
      use('b1', 'Write', { file_path: 'src/before.ts', content: 'x' }), res('b1'),
      use('h1', 'Write', { file_path: 'src/horizon.ts', content: 'x' }), res('h1'),
      use('s2', 'Edit', { file_path: 'src/model.ts', old_string: 'a', new_string: 'b' }), res('s2'),
      use('s3', 'Read', { file_path: 'src/model.ts' }), res('s3', 'text'),
      use('s4', 'Bash', { command: 'npx vitest run model' }), res('s4', 'RUN v2\nTests 12 passed (12)'),
      humanPrompt(`Task 5 of 8. ${'Change the panel and keep its tests green. '.repeat(200)}`),
    ];
  }

  async function cut(options: { horizon?: string | null; sinceCard?: boolean; cardTotal?: number; card?: string; messages?: SessionMessage[] } = {}) {
    const lines: string[] = [];
    const horizon = options.horizon === undefined ? JSON.stringify({ toolUseId: 'h1', at: '2026-10-07T09:58:00.000Z', tokens: 40000 }) : options.horizon;
    const card = options.card ?? CARD;
    const $ = fakeHost({
      sessionId: async () => SESSION,
      envGet: async (name) => (name === 'HOME' ? '/home/u' : undefined),
      fsExists: async (path) => path.endsWith(`/${FLAG_PATH}`) || path.endsWith(`/${TASK_CARD_FILE}`) || (horizon !== null && path.endsWith(`/${TASK_CARD_HORIZON_FILE}`)),
      fsRead: async (path) => {
        if (path.endsWith(`/${FLAG_PATH}`)) return '1';
        if (path.endsWith(`/${TASK_CARD_FILE}`)) return card;
        if (horizon !== null && path.endsWith(`/${TASK_CARD_HORIZON_FILE}`)) return horizon;
        throw new Error(`ENOENT: ${path}`);
      },
      uiLog: (line: string) => lines.push(line),
    });
    const on = handlers({ denseNotes: true, ...(options.sinceCard === undefined ? {} : { sinceCard: options.sinceCard }), ...(options.cardTotal === undefined ? {} : { cardTotalBudgetTokens: options.cardTotal }) });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const result = (await withStrippedRuntimeGlobals(() => on['session.compact']($, { trigger: 'auto', messages: options.messages ?? conversation() }, next))) as { messages?: SessionMessage[] };
    return { lines, next, seed: result.messages?.[0]?.text ?? '', tail: (result.messages ?? []).slice(1).map((message) => message.text).join('\n') };
  }

  it('puts the section right after the task card, and logs it', async () => {
    const { seed, tail, lines } = await cut();
    expect(tail).toContain('Task 5 of 8.');
    const section = sectionAfterCard(seed);
    expect(section).toBeDefined();
    expect(section).toContain('The task card above was written before these 4 steps (oldest first)');
    expect(section).toContain('- wrote src/horizon.ts\n- edited src/model.ts\n- ran `npx vitest run model` -> Tests 12 passed (12)\n- plus 1 read-only calls (Read ×1)');
    expect(section).not.toContain('src/before.ts');
    expect(lines.some((line) => /^seed\.since_card=4 seed\.since_card_size=\d+ seed\.since_card_horizon=found$/.test(line))).toBe(true);
  });

  it('is left out with sinceCard: false', async () => {
    const { seed, lines } = await cut({ sinceCard: false });
    expect(seed).not.toContain('## Since the card');
    expect(seed).toContain('## Task card');
    expect(lines).toContain('seed.since_card=0 seed.since_card_size=0 seed.since_card_horizon=off');
  });

  it.each([['no file', null], ['an empty horizon', '{}']])('is left out with %s', async (_name, horizon) => {
    const { seed, lines } = await cut({ horizon });
    expect(seed).not.toContain('## Since the card');
    expect(lines).toContain('seed.since_card=0 seed.since_card_size=0 seed.since_card_horizon=missing');
  });

  it('starts after the last seed message when the card predates an earlier cut', async () => {
    const { seed, lines } = await cut({ horizon: JSON.stringify({ toolUseId: 'from-an-earlier-segment' }) });
    const section = sectionAfterCard(seed);
    expect(section).toContain('The task card above predates the last cut; these');
    expect(lines.some((line) => /seed\.since_card_horizon=before_cut$/.test(line))).toBe(true);
  });

  it('is left out when the seed carries no card', async () => {
    const lines: string[] = [];
    const $ = fakeHost({
      sessionId: async () => SESSION,
      fsExists: async (path) => path.endsWith(`/${FLAG_PATH}`) || path.endsWith(`/${TASK_CARD_HORIZON_FILE}`),
      fsRead: async (path) => { if (path.endsWith(`/${FLAG_PATH}`)) return '1'; if (path.endsWith(`/${TASK_CARD_HORIZON_FILE}`)) return JSON.stringify({ toolUseId: 'h1' }); throw new Error('ENOENT'); },
      uiLog: (line: string) => lines.push(line),
    });
    const result = (await withStrippedRuntimeGlobals(() => handlers({ denseNotes: true })['session.compact']($, { trigger: 'auto', messages: conversation() }, async () => ({ fellBack: true })))) as { messages?: SessionMessage[] };
    expect(result.messages?.[0]?.text).not.toContain('## Since the card');
  });

  describe('when the seed does not fit', () => {
    // card-budget.gate.test.ts's "trims the card first" cut (w17 w61e): a big card, the user's rules file quoted whole and a
    // 6k-token newest prompt on a total of 4000, now with 60 steps after the card's horizon.
    const BRIEFS = `/home/u/.claude/exovault/recall/${sha256(SESSION)}/briefs`;
    const briefText = Array.from({ length: 160 }, (_, i) => `- step ${i}: change packages/app/src/part-${i}.ts and keep its test green`).join('\n');
    const briefFiles: Record<string, string> = {
      [FLAG_PATH]: '1',
      [`${BRIEFS}/briefs.json`]: JSON.stringify([{ id: '0123456789ab', path: `${BRIEFS}/0123456789ab.md`, chars: briefText.length, at: '2026-10-03T09:00:00.000Z', firstLine: '- step 0' }]),
      [`${BRIEFS}/0123456789ab.md`]: briefText,
    };
    const rules = ['# Session rules', '1. Report header. The first line of every final report is `SLICE <id> DONE` when every check is green.', ...Array.from({ length: 20 }, (_, i) => `${i + 4}. Keep packages/app/src/area-${i}.ts free of side effects and name its helpers in plain words.`)].join('\n');
    const entry = { path: '/w/nd/house-rules.md', savedPath: '/x', chars: rules.length, at: '2026-10-04T12:00:00.000Z' };
    const bigCard = ['# Task card', '## Goal', 'Build the sidebar tree.', '## Rules', ...Array.from({ length: 40 }, (_, i) => `- rule ${i}: keep packages/app/src/part-${i}.ts under 120 lines and its test file named part-${i}.test.ts [brief line ${i}]`), '## Decisions', ...Array.from({ length: 30 }, (_, i) => `- decision ${i}: the helper for part ${i} stays pure and takes plain arrays`), '## Acceptance checks', '- app 1486 passing', '## Next step', 'Write the model file.'].join('\n');

    function busy(stepCount: number): SessionMessage[] {
      const messages: SessionMessage[] = [];
      for (let i = 0; i < 30; i += 1) {
        messages.push(humanPrompt(`turn ${i}: ${'detail '.repeat(600)}`), assistantText(`reply ${i}: updated packages/app/src/part-${i}.ts:${i * 7} ${'x[1]=2; '.repeat(200)}`));
      }
      for (let i = 0; i < stepCount; i += 1) messages.push(use(i === 0 ? 'h1' : `w${i}`, 'Write', { file_path: `packages/app/src/area-${i}/part-number-${i}.ts`, content: 'x' }), res(i === 0 ? 'h1' : `w${i}`));
      messages.push(humanPrompt(`Task 5 of 8. ${'Change the panel and keep its tests green. '.repeat(Math.ceil(25500 / 42))}`));
      return messages;
    }

    async function rulesCut(cardTotal: number, sinceCard: boolean, stepCount: number) {
      const lines: string[] = [];
      const horizon = JSON.stringify({ toolUseId: 'h1' });
      const $ = fakeHost({
        sessionId: async () => SESSION,
        envGet: async (name) => (name === 'HOME' ? '/home/u' : undefined),
        fsExists: async (path) => path in briefFiles || path.endsWith(`/${FLAG_PATH}`) || path.endsWith(`/${TASK_CARD_FILE}`) || path.endsWith(`/${TASK_CARD_HORIZON_FILE}`) || path.endsWith('/adopted.json') || path.endsWith(`/adopted/${sha256(entry.path).slice(0, 12)}.md`),
        fsRead: async (path) => {
          if (path in briefFiles) return briefFiles[path];
          if (path.endsWith(`/${FLAG_PATH}`)) return '1';
          if (path.endsWith(`/${TASK_CARD_FILE}`)) return bigCard;
          if (path.endsWith(`/${TASK_CARD_HORIZON_FILE}`)) return horizon;
          if (path.endsWith('/adopted.json')) return JSON.stringify([entry]);
          if (path.endsWith(`/adopted/${sha256(entry.path).slice(0, 12)}.md`)) return rules;
          throw new Error(`ENOENT: ${path}`);
        },
        uiLog: (line: string) => lines.push(line),
      });
      const on = handlers({ denseNotes: true, recallEnabled: true, cardTotalBudgetTokens: cardTotal, sinceCard });
      const next = vi.fn(async () => ({ fellBack: true }) as unknown);
      const result = (await withStrippedRuntimeGlobals(() => on['session.compact']($, { trigger: 'auto', messages: busy(stepCount) }, next))) as { messages?: SessionMessage[] };
      return { lines, log: lines.join('\n'), next, seed: result.messages?.[0]?.text ?? '' };
    }

    it('shrinks the section before the card does', async () => {
      const without = await rulesCut(4000, false, 60);
      expect(without.log).toContain('seed.task_card_shrunk=');
      const withIt = await rulesCut(4000, true, 60);
      expect(withIt.next).not.toHaveBeenCalled();
      expect(withIt.log).toContain('seed.since_card_shrunk=');
      expect(withIt.log.indexOf('seed.since_card_shrunk=')).toBeLessThan(withIt.log.indexOf('seed.task_card_shrunk='));
    });

    const newest3 = ['- wrote packages/app/src/area-57/part-number-57.ts', '- wrote packages/app/src/area-58/part-number-58.ts', '- wrote packages/app/src/area-59/part-number-59.ts'];
    const sinceSection = (seed: string): string => seed.split('\n\n## ').find((part) => part.startsWith('Since the card\n')) ?? '';

    it('keeps the newest 3 since lines when only the card tail has to give', async () => {
      let shrunkCard = 0;
      for (const cardTotal of [3000, 3250, 3500, 3750, 4000, 4250, 4500, 4750, 5000, 5500, 6000, 7000, 8000]) {
        const cut = await rulesCut(cardTotal, true, 60);
        if (!cut.log.includes('seed.task_card_shrunk=') || cut.log.includes('seed.since_card_dropped=1') || cut.next.mock.calls.length > 0) continue;
        shrunkCard += 1;
        const section = sinceSection(cut.seed);
        for (const line of newest3) expect(section, `cardTotal ${cardTotal}: ${cut.lines.join(' | ')}`).toContain(line);
      }
      expect(shrunkCard).toBeGreaterThan(0);
    }, 60_000);

    it('ends the section at its floor or drops it when the seed is over by more than the card can give', async () => {
      let floored = 0;
      for (const cardTotal of [2000, 2500, 3000, 3500, 4000]) {
        const cut = await rulesCut(cardTotal, true, 60);
        if (cut.log.includes('seed.since_card_dropped=1')) { floored += 1; expect(sinceSection(cut.seed)).toBe(''); continue; }
        if (cut.log.split('seed.since_card_shrunk=').length < 3) continue;
        floored += 1;
        const list = sinceSection(cut.seed).split('\n').filter((line) => line.startsWith('- '));
        expect(list, `cardTotal ${cardTotal}: ${cut.lines.join(' | ')}`).toHaveLength(1);
        expect(list[0]).toMatch(/^- \(\d+ earlier steps left out\)$/);
      }
      expect(floored).toBeGreaterThan(0);
    }, 60_000);

    it('shrinks to the keep-3 step, then to the floor, and only a section still over is dropped after both', async () => {
      // cardTotal 2000 (the smallest the card honours): the section gives 3 lines, the card its tail, then the section its floor.
      const cut = await rulesCut(2000, true, 60);
      const shrunkAt = cut.lines.flatMap((line, i) => (line.startsWith('seed.since_card_shrunk=') ? [i] : []));
      expect(shrunkAt.length, cut.lines.join(' | ')).toBe(2);
      const cardAt = cut.lines.findIndex((line) => line.startsWith('seed.task_card_shrunk='));
      expect(shrunkAt[0]).toBeLessThan(cardAt);
      expect(shrunkAt[1]).toBeGreaterThan(cardAt);
      const droppedAt = cut.lines.indexOf('seed.since_card_dropped=1');
      if (droppedAt >= 0) expect(droppedAt).toBeGreaterThan(shrunkAt[1]);
      else expect(sinceSection(cut.seed).split('\n').filter((line) => line.startsWith('- '))).toEqual([expect.stringMatching(/^- \(\d+ earlier steps left out\)$/)]);
    });

    it('does not fall back where the seed without the section did not', async () => {
      let compared = 0;
      for (const cardTotal of [2000, 2500, 3000, 3500, 4000, 4500, 5000, 8000]) {
        const without = await rulesCut(cardTotal, false, 60);
        const withIt = await rulesCut(cardTotal, true, 60);
        if (without.next.mock.calls.length === 0) {
          compared += 1;
          expect(withIt.next.mock.calls.length, `cardTotal ${cardTotal}: ${withIt.lines.join(' | ')}`).toBe(0);
        }
      }
      expect(compared).toBeGreaterThan(2);
    }, 60_000);
  });
});
