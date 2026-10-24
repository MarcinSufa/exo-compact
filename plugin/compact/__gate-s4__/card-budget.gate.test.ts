import { describe, it, expect, vi } from 'vitest';
import { register } from '../compact.js';
import { REAL_TOTAL_BUDGET_TOKENS, estimateTokens } from '../core/budgets.js';
import { CARD_TOTAL_BUDGET_TOKENS, TASK_CARD_FILE, cardBudgets, renderCardSection, stretchForTail } from '../core/task-card.js';
import { fakeHost, humanPrompt, assistantText, withStrippedRuntimeGlobals, sha256, LEGACY_OPTIONS } from './fixtures/helpers.js';
import type { SessionMessage } from '../core/types.js';

const FLAG_PATH = '.exovault/s4-compact-active';
const SESSION = 'session-card-budget';
const BRIEFS = `/home/u/.claude/exovault/recall/${sha256(SESSION)}/briefs`;
const CARD = ['# Task card', '## Goal', 'Build the sidebar tree.', '## Rules', '- Test titles start with `r5:` [user, turn 40]', '## Acceptance checks', '- app 1486 passing', '## Next step', 'Write the model file.'].join('\n');

/** 3.47.0 (CONTRACT S4zu): with a card the cut fits about what native compaction keeps (w17 w60g replay). */
describe('3.47.0 (S4zu) card budget split', () => {
  it('gives the tail 3/8 and the working notes 1/8 of the total', () => {
    expect(cardBudgets(8000)).toEqual({ seed: 5000, tail: 3000, dense: 1000, total: 8000 });
    expect(cardBudgets()).toEqual(cardBudgets(CARD_TOTAL_BUDGET_TOKENS));
  });

  it('lets the newest exchange past the tail budget and grows the total by that much only', () => {
    const budgets = cardBudgets(8000);
    expect(stretchForTail(budgets, 2000)).toBe(budgets);
    expect(stretchForTail(budgets, 6900)).toEqual({ seed: 5000, tail: 6900, dense: 1000, total: 11900 });
  });

  it('puts the card headings one level below the seed section', () => {
    const section = renderCardSection(CARD, '/p/task-card.md', estimateTokens, 2500);
    expect(section).toContain('### Rules');
    expect(section).not.toMatch(/^## /m);
  });
});

describe('3.47.0 (S4zu) a cut with a card', () => {
  const briefText = Array.from({ length: 160 }, (_, i) => `- step ${i}: change packages/app/src/part-${i}.ts and keep its test green`).join('\n');
  const briefFiles: Record<string, string> = {
    [FLAG_PATH]: '1',
    [`${BRIEFS}/briefs.json`]: JSON.stringify([{ id: '0123456789ab', path: `${BRIEFS}/0123456789ab.md`, chars: briefText.length, at: '2026-10-03T09:00:00.000Z', firstLine: '- step 0' }]),
    [`${BRIEFS}/0123456789ab.md`]: briefText,
    [`${BRIEFS}/0123456789ab.digest.md`]: '## Files\n- packages/app/src/part-0.ts\n## Checks\n- pnpm test passes',
  };

  function conversation(lastPromptChars: number): SessionMessage[] {
    const old: SessionMessage[] = [];
    for (let i = 0; i < 30; i += 1) {
      old.push(humanPrompt(`turn ${i}: ${'detail '.repeat(600)}`));
      old.push(assistantText(`reply ${i}: updated packages/app/src/part-${i}.ts:${i * 7} ${'x[1]=2; '.repeat(200)}`));
    }
    // w17 w60g cut 6: the cut came right after a 6.9k-token task prompt, which the tail keeps whole.
    return [...old, humanPrompt(`Task 5 of 8. ${'Change the panel and keep its tests green. '.repeat(Math.ceil(lastPromptChars / 42))}`)];
  }

  async function cut(lastPromptChars: number, withCard: boolean, withDigest = true, extra: Record<string, unknown> = {}) {
    const files: Record<string, string> = { ...briefFiles };
    if (!withDigest) delete files[`${BRIEFS}/0123456789ab.digest.md`];
    const lines: string[] = [];
    const $ = fakeHost({
      sessionId: async () => SESSION,
      envGet: async (name) => (name === 'HOME' ? '/home/u' : undefined),
      fsExists: async (path) => path in files || path.endsWith(`/${FLAG_PATH}`) || (withCard && path.endsWith(`/${TASK_CARD_FILE}`)),
      fsRead: async (path) => {
        if (path in files) return files[path];
        if (path.endsWith(`/${FLAG_PATH}`)) return '1';
        if (withCard && path.endsWith(`/${TASK_CARD_FILE}`)) return CARD;
        throw new Error(`ENOENT: ${path}`);
      },
      uiLog: (line: string) => lines.push(line),
    });
    const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    register(((name: string, handler: never) => { handlers[name] = handler; return { catch: (caught: unknown) => { (handlers as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS, denseNotes: true, recallEnabled: true, ...extra } as never);
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, { trigger: 'auto', messages: conversation(lastPromptChars) }, next))) as { messages?: SessionMessage[] };
    return { lines, next, seed: result.messages?.[0]?.text ?? '', tail: (result.messages ?? []).slice(1).map((message) => message.text).join('\n') };
  }

  it('keeps the card total when totalBudgetTokens arrives with its manifest default (w17 w60h)', async () => {
    const { lines } = await cut(2000, true, true, { totalBudgetTokens: 20000 });
    expect(lines).toContain(`seed.budget_total=${CARD_TOTAL_BUDGET_TOKENS} seed.budget_count=real`);
    expect(lines).toContain('seed.budget_split seed=5000 tail=3000 dense=1000');
  });

  it('keeps a newest prompt past the tail budget and cuts instead of falling back', async () => {
    const { lines, next, seed, tail } = await cut(25500, true);
    expect(lines).toContain(`seed.budget_total=${CARD_TOTAL_BUDGET_TOKENS} seed.budget_count=real`);
    expect(lines).toContain('seed.budget_split seed=5000 tail=3000 dense=1000');
    expect(lines.join('\n')).not.toContain('compact.fallback=budget');
    expect(next).not.toHaveBeenCalled();
    expect(tail).toContain('Task 5 of 8. Change the panel');
    expect(estimateTokens(seed)).toBeLessThanOrEqual(cardBudgets().seed);
  });

  it.each([true, false])('keeps only the brief path lines next to the card (checklist ready: %s)', async (withDigest) => {
    const { seed } = await cut(2000, true, withDigest);
    expect(seed).toContain('## Task card');
    expect(seed).toContain('0123456789ab.md');
    expect(seed).not.toContain('Start of the newest brief');
    expect(seed).not.toContain('<task-brief>');
    expect(seed).not.toContain('- step 0: change');
    expect(seed).not.toContain('Checklist of the newest brief');
  });

  it('logs the checklist as off, not pending, while the card option means none is written (w17 w74)', async () => {
    const digestState = (lines: string[]) => lines.join('\n').match(/seed\.task_brief_digest=(\w+)/)?.[1];
    expect(digestState((await cut(2000, true, false)).lines)).toBe('off');
    expect(digestState((await cut(2000, true, true)).lines)).toBe('ready');
    expect(digestState((await cut(2000, false, false, { taskCard: false })).lines)).toBe('pending');
  });

  it('keeps the 20000 total and the brief while no card exists', async () => {
    const { lines, next, seed } = await cut(2000, false);
    expect(lines).toContain(`seed.budget_total=${REAL_TOTAL_BUDGET_TOKENS} seed.budget_count=real`);
    expect(next).not.toHaveBeenCalled();
    expect(seed).toMatch(/- step 0: change|Checklist of the newest brief/);
  });

  it('keeps the user\'s adopted rules file quoted and trims the card first (3.57.0, w17 w61e)', async () => {
    const rules = ['# Session rules', '1. Report header. The first line of every final report is `SLICE <id> DONE` when every check is green.', '2. Describe titles start with the slice id in square brackets.', '3. The last line of every final report is `Review: W17-4821`.', ...Array.from({ length: 20 }, (_, i) => `${i + 4}. Keep packages/app/src/area-${i}.ts free of side effects and name its helpers in plain words.`)].join('\n');
    const entry = { path: '/w/nd/house-rules.md', savedPath: '/x', chars: rules.length, at: '2026-10-04T12:00:00.000Z' };
    const bigCard = ['# Task card', '## Goal', 'Build the sidebar tree.', '## Rules', ...Array.from({ length: 40 }, (_, i) => `- rule ${i}: keep packages/app/src/part-${i}.ts under 120 lines and its test file named part-${i}.test.ts [brief line ${i}]`), '## Decisions', ...Array.from({ length: 30 }, (_, i) => `- decision ${i}: the helper for part ${i} stays pure and takes plain arrays`), '## Acceptance checks', '- app 1486 passing', '## Next step', 'Write the model file.'].join('\n');
    const lines: string[] = [];
    const $ = fakeHost({
      sessionId: async () => SESSION,
      envGet: async (name) => (name === 'HOME' ? '/home/u' : undefined),
      fsExists: async (path) => path in briefFiles || path.endsWith(`/${FLAG_PATH}`) || path.endsWith(`/${TASK_CARD_FILE}`) || path.endsWith('/adopted.json') || path.endsWith(`/adopted/${sha256(entry.path).slice(0, 12)}.md`),
      fsRead: async (path) => {
        if (path in briefFiles) return briefFiles[path];
        if (path.endsWith(`/${FLAG_PATH}`)) return '1';
        if (path.endsWith(`/${TASK_CARD_FILE}`)) return bigCard;
        if (path.endsWith('/adopted.json')) return JSON.stringify([entry]);
        if (path.endsWith(`/adopted/${sha256(entry.path).slice(0, 12)}.md`)) return rules;
        throw new Error(`ENOENT: ${path}`);
      },
      uiLog: (line: string) => lines.push(line),
    });
    const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    // A smaller total stands in for the live cut's other sections (w61e r3: notes and brief at their floor, the rules file at its 625-token share).
    register(((name: string, handler: never) => { handlers[name] = handler; return { catch: (caught: unknown) => { (handlers as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS, denseNotes: true, recallEnabled: true, cardTotalBudgetTokens: 4000 } as never);
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, { trigger: 'auto', messages: conversation(25500) }, next))) as { messages?: SessionMessage[] };
    const seed = result.messages?.[0]?.text ?? '';
    expect(next).not.toHaveBeenCalled();
    expect(seed).toContain('> 1. Report header. The first line of every final report is `SLICE <id> DONE`');
    expect(lines.join('\n')).not.toContain('seed.adopted_shrunk');
    expect(lines.join('\n')).toContain('seed.task_card_shrunk=');
    expect(seed).toContain('## Task card');
  });
});
