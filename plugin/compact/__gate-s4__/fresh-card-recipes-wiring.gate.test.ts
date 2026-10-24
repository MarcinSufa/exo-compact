import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { register } from '../compact.js';
import { TASK_CARD_FILE, TASK_CARD_HORIZON_FILE, TASK_CARD_STATE_FILE } from '../core/task-card.js';
import { fakeHost, humanPrompt, assistantText, withStrippedRuntimeGlobals, sha256, LEGACY_OPTIONS } from './fixtures/helpers.js';
import type { SessionMessage } from '../core/types.js';

/** 4.7.0 (CONTRACT S5j, S5k): options `lateCardRefresh` (default off) and `recipes` (default off until 4.7.1, on since 4.7.2); with both explicitly off the seed is byte-identical to 4.6.0. */

const FLAG_PATH = '.exovault/s4-compact-active';
const CAPTURE = '/tmp/project/.exovault/s4-capture/s1';
const NOW = Date.parse('2026-10-09T10:00:00.000Z');
const CARD = ['# Task card', '## Goal', 'Build the sidebar tree.', '## Rules', '- Test titles start with `r5:` [user, turn 40]', '## Acceptance checks', '- app 1486 passing', '## Next step', 'Write the model file.'].join('\n');

type Handler = (host: unknown, event: unknown, next: (event?: unknown) => Promise<unknown>) => Promise<unknown>;
// The late-refresh tests read log lines that 4.7.0's quiet notices (S5i) keep out of an interactive transcript.
function handlers(options: Record<string, unknown> = {}): Record<string, Handler> {
  const on: Record<string, Handler> = {};
  register(((name: string, fn: Handler) => { on[name] = fn; return { catch: (caught: unknown) => { (on as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS, recallPluginRoot: '/plugin', notices: 'all', ...options } as never);
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

const SESSION = 's1';
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
    use('s5', 'Bash', { command: 'cd /home/u/app && PORT=3100 npm run dev' , run_in_background: true }), res('s5', 'Command running in background with ID: bk7m2x9. Output is being written to: /tmp/x.output'),
    humanPrompt(`Task 5 of 8. ${'Change the panel and keep its tests green. '.repeat(200)}`),
  ];
}
async function cut(options: Record<string, unknown> = {}, extra: { horizon?: string | null; messages?: SessionMessage[]; memoryFs?: boolean } = {}) {
  const lines: string[] = [];
  // memoryFs: written capture segments come back on the listing, so the working notes (dense notes) have candidates.
  const written = new Map<string, string>();
  const horizon = extra.horizon === undefined ? JSON.stringify({ toolUseId: 'h1', at: '2026-10-07T09:58:00.000Z', tokens: 40000 }) : extra.horizon;
  const $ = fakeHost({
    sessionId: async () => SESSION,
    envGet: async (name) => (name === 'HOME' ? '/home/u' : undefined),
    ...(extra.memoryFs ? { fsWrite: async (path: string, text: string) => { written.set(path, text); }, fsList: async (dir?: string) => [...written.keys()].filter((path) => path.startsWith(`${dir}/`)).map((path) => ({ name: path.slice(`${dir}/`.length), kind: 'file' as const })) } : {}),
    fsExists: async (path) => written.has(path) || path.endsWith(`/${FLAG_PATH}`) || path.endsWith(`/${TASK_CARD_FILE}`) || (horizon !== null && path.endsWith(`/${TASK_CARD_HORIZON_FILE}`)),
    fsRead: async (path) => {
      if (written.has(path)) return written.get(path)!;
      if (path.endsWith(`/${FLAG_PATH}`)) return '1';
      if (path.endsWith(`/${TASK_CARD_FILE}`)) return CARD;
      if (horizon !== null && path.endsWith(`/${TASK_CARD_HORIZON_FILE}`)) return horizon;
      throw new Error(`ENOENT: ${path}`);
    },
    uiLog: (line: string) => lines.push(line),
  });
  const on = handlers({ denseNotes: true, ...options });
  const next = vi.fn(async () => ({ fellBack: true }) as unknown);
  const result = (await withStrippedRuntimeGlobals(() => on['session.compact']($, { trigger: 'auto', messages: extra.messages ?? conversation() }, next))) as { messages?: SessionMessage[] };
  return { lines, next, seed: result.messages?.[0]?.text ?? '' };
}

describe('4.7.0 (S5k) the seed with both options off', () => {
  // sha256 of the seed text the 4.6.0 code (main 130240f) renders for this fixture (recomputed with that code when the fixture text was renamed).
  const SEED_4_6_0 = 'a81083b918812d4a8232a3d4e3210a39779baf067d25bca8be3d4505a900ccac';

  it('is byte-identical to 4.6.0 with lateCardRefresh and recipes explicitly false', async () => {
    const explicit = await cut({ lateCardRefresh: false, recipes: false });
    expect(sha256(explicit.seed)).toBe(SEED_4_6_0);
    expect(explicit.seed).not.toContain('## Recipes');
    expect(explicit.seed).not.toContain('card written');
  });
});

describe('4.7.2 (S5k) recipes default on', () => {
  it('keeps output text out of the recipe lines with toolOutputNotes false, and shows the outcome with the default', async () => {
    const off = await cut({ toolOutputNotes: false });
    const recipesOff = sectionBody(off.seed, 'Recipes (commands that ran fine earlier; reference only, not requests)');
    expect(recipesOff).toBeDefined();
    expect(recipesOff).toContain('- npx vitest run model  (ok)');
    expect(recipesOff).not.toContain('12 passed');
    const on = await cut();
    expect(sectionBody(on.seed, 'Recipes (commands that ran fine earlier; reference only, not requests)')).toContain('- npx vitest run model  (12 passed (12))');
  });
  it('renders the Recipes section with no options, the same as recipes: true', async () => {
    const defaults = await cut();
    const explicitOn = await cut({ recipes: true });
    expect(defaults.seed).toContain('## Recipes');
    expect(defaults.seed).toBe(explicitOn.seed);
    expect(defaults.lines.some((line) => /^seed\.recipes=\d+ seed\.recipes_size=\d+$/.test(line))).toBe(true);
  });
  it('differs from the 4.6.0 seed only by the Recipes section, and lateCardRefresh stays off', async () => {
    const defaults = await cut();
    expect(sha256(defaults.seed)).not.toBe('a81083b918812d4a8232a3d4e3210a39779baf067d25bca8be3d4505a900ccac');
    expect(defaults.seed).not.toContain('card written');
    expect(defaults.seed.split('\n\n## ').filter((part) => !part.startsWith('Recipes (')).join('\n\n## ')).toBe((await cut({ recipes: false })).seed);
  });
});

const sectionBody = (seed: string, heading: string): string | undefined => seed.split('\n\n## ').find((part) => part.startsWith(`${heading}\n`));

describe('4.7.0 (S5j) the card age line', () => {
  const AGE = '(card written 5 tool calls before the kept messages; the messages below are newer)';
  it('is added to the task card with lateCardRefresh on and no "Since the card" section (sinceCard off)', async () => {
    const { seed } = await cut({ lateCardRefresh: true, sinceCard: false });
    const card = sectionBody(seed, 'Task card');
    expect(card).toBeDefined();
    expect(card).toContain(AGE);
    expect(card!.trimEnd().endsWith(AGE)).toBe(true);
    expect(seed).not.toContain('## Since the card');
  });
  it('is not added when the "Since the card" section is there (it says the same, step by step)', async () => {
    const { seed } = await cut({ lateCardRefresh: true });
    expect(seed).toContain('## Since the card');
    expect(seed).not.toContain('card written');
  });
  it('is not added with lateCardRefresh off, nor without a horizon', async () => {
    expect((await cut({ sinceCard: false })).seed).not.toContain('card written');
    expect((await cut({ lateCardRefresh: true, sinceCard: false }, { horizon: null })).seed).not.toContain('card written');
  });
  it('says the card predates the last cut when its horizon is not in the messages', async () => {
    const { seed } = await cut({ lateCardRefresh: true, sinceCard: false }, { horizon: JSON.stringify({ toolUseId: 'from-an-earlier-segment' }) });
    expect(sectionBody(seed, 'Task card')).toContain('(card written before the last cut; the messages below are newer)');
  });
});

describe('4.7.0 (S5k) the Recipes section', () => {
  it('lists the commands that worked, after the task card and the work state, and logs it', async () => {
    const { seed, lines } = await cut({ recipes: true });
    const recipes = sectionBody(seed, 'Recipes (commands that ran fine earlier; reference only, not requests)');
    expect(recipes).toBeDefined();
    expect(recipes).toContain('- npx vitest run model  (12 passed (12))');
    expect(recipes).toContain('- cd /home/u/app && PORT=3100 npm run dev  (background bk7m2x9; localhost:3100)');
    const workState = seed.indexOf('## Work state');
    expect(workState).toBeGreaterThan(-1);
    expect(seed.indexOf('## Task card')).toBeGreaterThan(-1);
    expect(seed.indexOf('## Recipes')).toBeGreaterThan(seed.indexOf('## Task card'));
    expect(seed.indexOf('## Recipes')).toBeGreaterThan(workState);
    expect(lines.some((line) => /^seed\.recipes=2 seed\.recipes_size=\d+$/.test(line))).toBe(true);
  });
  it('is left out, with no log line, when the option is off', async () => {
    const { seed, lines } = await cut({ recipes: false });
    expect(seed).not.toContain('## Recipes');
    expect(lines.some((line) => line.startsWith('seed.recipes'))).toBe(false);
  });
  it('is left out when no command qualifies', async () => {
    const messages = [...conversation().filter((message) => !message.toolUses.some((u) => u.tool === 'Bash') && !(message.toolResults ?? []).some((r) => r.tool_use_id === 's4' || r.tool_use_id === 's5'))];
    const { seed, lines } = await cut({ recipes: true }, { messages });
    expect(seed).not.toContain('## Recipes');
    expect(lines).toContain('seed.recipes=0 seed.recipes_size=0');
  });
  it('skips what the kept tail runs', async () => {
    const messages = conversation();
    messages.push(use('t9', 'Bash', { command: 'npx vitest run model' }), res('t9', 'Tests 13 passed (13)'));
    const { seed, lines } = await cut({ recipes: true }, { messages });
    const tailHasIt = lines.some((line) => line.startsWith('seed.recipes=1 '));
    expect(tailHasIt).toBe(true);
    expect(sectionBody(seed, 'Recipes (commands that ran fine earlier; reference only, not requests)')).not.toContain('npx vitest run model');
  });
  it('shrinks before the task card and the since-card section when the seed is over budget (no working notes here; see 4.7.1 below)', async () => {
    const messages = conversation();
    for (let i = 0; i < 8; i += 1) messages.splice(-1, 0, use(`r${i}`, 'Bash', { command: `cd /home/user1/work/exo-compact-recipes && nice -n 10 node node_modules/vitest/vitest.mjs run plugin/compact/__gate-s4__/area-number-${i}.gate.test.ts` }), res(`r${i}`, `Tests ${i + 10} passed (${i + 10})`));
    const OTHERS = ['seed.dense_shrunk=', 'seed.task_brief_shrunk=', 'seed.since_card_shrunk=', 'seed.task_card_shrunk=', 'seed.adopted_shrunk='];
    const firstOf = (lines: string[], prefixes: string[]) => lines.findIndex((line) => prefixes.some((prefix) => line.startsWith(prefix)) || (prefixes.includes('seed.recipes_shrunk=') && line === 'seed.recipes_dropped=1'));
    // 2000 is the smallest budget the option takes (below it the 8000 default applies): with the 8 long recipes the seed is over
    // budget there, and the guarantee is that the recipes alone give way: fewer lines, while the card, the since-card section
    // and the dense notes stay exactly as they are with the option off.
    const tight = await cut({ recipes: true, cardTotalBudgetTokens: 2000 }, { messages });
    const tightOff = await cut({ recipes: false, cardTotalBudgetTokens: 2000 }, { messages });
    expect(tight.lines.some((line) => /^seed\.recipes_shrunk=\d+$/.test(line)), tight.lines.join(' | ')).toBe(true);
    expect(firstOf(tight.lines, OTHERS), tight.lines.join(' | ')).toBe(-1);
    expect(tight.next).not.toHaveBeenCalled();
    const kept = tight.lines.find((line) => line.startsWith('seed.recipes='))!;
    expect(Number(/seed\.recipes=(\d+)/.exec(kept)![1])).toBeLessThan(8);
    for (const heading of ['Task card', 'Since the card']) expect(sectionBody(tight.seed, heading), heading).toBe(sectionBody(tightOff.seed, heading));
    expect(sectionBody(tight.seed, 'Task card')).toContain('Build the sidebar tree.');
    // The ordering rule over a range of budgets: no other section is shrunk before the recipes have been.
    for (const cardTotal of [2000, 2400, 2800, 3200, 3600, 4000, 4500, 5000]) {
      const { lines, next } = await cut({ recipes: true, cardTotalBudgetTokens: cardTotal }, { messages });
      const at = firstOf(lines, ['seed.recipes_shrunk=']);
      const other = firstOf(lines, OTHERS);
      if (other >= 0) expect(at, `${cardTotal}: other sections shrank with no recipes shrink: ${lines.join(' | ')}`).toBeGreaterThanOrEqual(0);
      if (other >= 0 && at >= 0) expect(other, `${cardTotal}: ${lines.join(' | ')}`).toBeGreaterThan(at);
      expect(next).not.toHaveBeenCalled();
    }
  });
});

// 4.7.1 (S5k): over budget the working notes give way first and the recipes after them.
describe('4.7.1 (S5k) the recipes give way after the working notes', () => {
  const RECIPES_HEADING = 'Recipes (commands that ran fine earlier; reference only, not requests)';
  const OTHERS = ['seed.task_brief_shrunk=', 'seed.since_card_shrunk=', 'seed.task_card_shrunk=', 'seed.adopted_shrunk='];
  const indexOf = (lines: string[], test: (line: string) => boolean) => lines.findIndex(test);
  const lastIndexOf = (lines: string[], test: (line: string) => boolean) => lines.map(test).lastIndexOf(true);
  const isRecipesShrink = (line: string) => line.startsWith('seed.recipes_shrunk=') || line === 'seed.recipes_dropped=1';
  const isDenseShrink = (line: string) => line.startsWith('seed.dense_shrunk=');
  const recipeCount = (lines: string[]) => Number(/seed\.recipes=(\d+)/.exec(lines.find((line) => line.startsWith('seed.recipes='))!)![1]);

  function fixture(): SessionMessage[] {
    const messages = conversation();
    for (let i = 0; i < 8; i += 1) messages.splice(-1, 0, use(`r${i}`, 'Bash', { command: `cd /home/user1/work/exo-compact-recipes && nice -n 10 node node_modules/vitest/vitest.mjs run plugin/compact/__gate-s4__/area-number-${i}.gate.test.ts` }), res(`r${i}`, `Tests ${i + 10} passed (${i + 10})`));
    // Short lines with details the kept messages do not repeat: candidates for the working notes.
    for (let i = 0; i < 20; i += 1) messages[i * 2 + 1] = assistantText([`Decided: adapter-${i}.ts retries ${i + 3} times on port ${41000 + i}`, `Found: ${i}th shard \`shard_${i}_alpha\` lags ${i * 13} ms behind \`ledger_${i}_beta\``, `Fixed: src/worker-${i}/queue.ts line ${i * 11 + 5} dropped job J-${i}00`].join('\n'));
    return messages;
  }

  it('shrinks the working notes first and keeps the recipes whole', async () => {
    const messages = fixture();
    const roomy = await cut({ recipes: true, cardTotalBudgetTokens: 5000 }, { messages, memoryFs: true });
    const tight = await cut({ recipes: true, cardTotalBudgetTokens: 2400 }, { messages, memoryFs: true });
    expect(roomy.lines.some(isDenseShrink) || roomy.lines.some(isRecipesShrink), roomy.lines.join(' | ')).toBe(false);
    expect(tight.lines.some(isDenseShrink), tight.lines.join(' | ')).toBe(true);
    expect(tight.lines.some(isRecipesShrink), tight.lines.join(' | ')).toBe(false);
    expect(tight.lines.filter((line) => OTHERS.some((prefix) => line.startsWith(prefix)))).toEqual([]);
    expect(recipeCount(tight.lines)).toBe(recipeCount(roomy.lines));
    expect(sectionBody(tight.seed, RECIPES_HEADING)).toBe(sectionBody(roomy.seed, RECIPES_HEADING));
    expect(sectionBody(tight.seed, RECIPES_HEADING)).toBeDefined();
    expect(tight.next).not.toHaveBeenCalled();
  });

  it('shrinks the recipes only after the working notes are down to none', async () => {
    const messages = fixture();
    const roomy = await cut({ recipes: true, cardTotalBudgetTokens: 5000 }, { messages, memoryFs: true });
    const tight = await cut({ recipes: true, cardTotalBudgetTokens: 2000 }, { messages, memoryFs: true });
    const lastDense = lastIndexOf(tight.lines, isDenseShrink);
    const firstRecipes = indexOf(tight.lines, isRecipesShrink);
    expect(lastDense, tight.lines.join(' | ')).toBeGreaterThan(-1);
    expect(tight.lines[lastDense]).toBe('seed.dense_shrunk=0');
    expect(firstRecipes, tight.lines.join(' | ')).toBeGreaterThan(lastDense);
    expect(recipeCount(tight.lines)).toBeLessThan(recipeCount(roomy.lines));
    expect(tight.lines.filter((line) => OTHERS.some((prefix) => line.startsWith(prefix)))).toEqual([]);
    expect(sectionBody(tight.seed, 'Task card')).toBe(sectionBody(roomy.seed, 'Task card'));
    expect(sectionBody(tight.seed, 'Since the card')).toBe(sectionBody(roomy.seed, 'Since the card'));
    expect(tight.next).not.toHaveBeenCalled();
  });

  it('keeps the card, the brief and the rules whole while the recipes still have lines', async () => {
    const messages = fixture();
    for (const cardTotal of [2000, 2200, 2400, 2600, 2800, 3000]) {
      const { lines, next } = await cut({ recipes: true, cardTotalBudgetTokens: cardTotal }, { messages, memoryFs: true });
      const recipes = indexOf(lines, isRecipesShrink);
      const other = indexOf(lines, (line) => OTHERS.some((prefix) => line.startsWith(prefix)));
      if (other >= 0) {
        expect(recipes, `${cardTotal}: ${lines.join(' | ')}`).toBeGreaterThanOrEqual(0);
        expect(other, `${cardTotal}: ${lines.join(' | ')}`).toBeGreaterThan(recipes);
        expect(recipeCount(lines), `${cardTotal}: ${lines.join(' | ')}`).toBe(0);
      }
      if (recipes >= 0) expect(recipes, `${cardTotal}: ${lines.join(' | ')}`).toBeGreaterThan(lastIndexOf(lines, isDenseShrink));
      expect(next).not.toHaveBeenCalled();
    }
  });

  it('shrinks the recipes before the card when the working notes are off and the dense loop does not run', async () => {
    const messages = fixture();
    const roomy = await cut({ recipes: true, denseNotes: false, cardTotalBudgetTokens: 5000 }, { messages, memoryFs: true });
    const tight = await cut({ recipes: true, denseNotes: false, cardTotalBudgetTokens: 2000 }, { messages, memoryFs: true });
    expect(tight.lines.some(isDenseShrink), tight.lines.join(' | ')).toBe(false);
    expect(tight.lines.some(isRecipesShrink), tight.lines.join(' | ')).toBe(true);
    expect(recipeCount(tight.lines)).toBeLessThan(recipeCount(roomy.lines));
    expect(tight.lines.filter((line) => OTHERS.some((prefix) => line.startsWith(prefix)))).toEqual([]);
    expect(sectionBody(tight.seed, 'Task card')).toBe(sectionBody(roomy.seed, 'Task card'));
    expect(tight.next).not.toHaveBeenCalled();
  });

  it('shrinks the recipes with the working notes on when there is no card and no whole brief (the dense loop does not run)', async () => {
    const messages = fixture();
    const roomy = await cut({ recipes: true, taskCard: false, totalBudgetTokens: 5000 }, { messages, memoryFs: true });
    const tight = await cut({ recipes: true, taskCard: false, totalBudgetTokens: 3600 }, { messages, memoryFs: true });
    for (const seed of [roomy.seed, tight.seed]) {
      expect(seed).not.toContain('## Task card');
      expect(seed).not.toContain('<task-brief>');
      expect(seed).toContain('## Working notes');
    }
    expect(recipeCount(roomy.lines)).toBeGreaterThan(0);
    expect(tight.lines.some(isDenseShrink), tight.lines.join(' | ')).toBe(false);
    expect(tight.lines.some(isRecipesShrink), tight.lines.join(' | ')).toBe(true);
    expect(recipeCount(tight.lines)).toBeLessThan(recipeCount(roomy.lines));
    expect(tight.lines.filter((line) => OTHERS.some((prefix) => line.startsWith(prefix)))).toEqual([]);
    expect(tight.next).not.toHaveBeenCalled();
  });
});

describe('4.7.0 (S5j) the late card refresh', () => {
  const STATE_PATH = `${CAPTURE}/${TASK_CARD_STATE_FILE}`;
  const HORIZON_PATH = `${CAPTURE}/${TASK_CARD_HORIZON_FILE}`;
  function lateHost(options: { tokens?: number; calls?: number; state?: Record<string, unknown> | null } = {}) {
    const files = new Map<string, string>();
    const logs: string[] = [];
    const forks: string[] = [];
    let release: () => void = () => {};
    const replied = new Promise<void>((resolve) => { release = resolve; });
    if (options.state !== null) files.set(STATE_PATH, JSON.stringify(options.state ?? { lastTokens: 150_000, refreshes: 1, stretchDone: true }));
    files.set(HORIZON_PATH, JSON.stringify({ toolUseId: 'h0', at: 'x', tokens: 150_000 }));
    files.set(`${CAPTURE}/${TASK_CARD_FILE}`, `${CARD}\n`);
    const messages: SessionMessage[] = [humanPrompt('go'), use('h0', 'Bash', { command: 'ls' }), res('h0'), ...Array.from({ length: options.calls ?? 20 }, (_, i) => [use(`c${i}`, 'Bash', { command: 'ls' }), res(`c${i}`)]).flat()];
    return {
      files, logs, forks, replied,
      session: {
        cwd: async () => '/tmp/project',
        id: async () => 's1',
        usage: async () => ({ context: { tokens: options.tokens ?? 215_000, window: 1_000_000, breakdown: { rawMaxTokens: 250_000 } } }),
        messages: async () => messages,
        surfaces: async () => ['terminal'],
      },
      fs: {
        exists: async (p: string) => p === `/tmp/project/${FLAG_PATH}` || files.has(p),
        read: async (p: string) => { if (files.has(p)) return files.get(p)!; throw new Error('ENOENT'); },
        write: async (p: string, text: string) => { files.set(p, text); if (p === HORIZON_PATH && text !== files.get('seen')) release(); },
        list: async () => [],
      },
      env: { get: async (name: string) => (name === 'HOME' ? '/home/u' : undefined) },
      clock: { now: async () => NOW, sleep: async () => undefined, after: () => ({ cancel: () => {} }) },
      process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
      model: { fork: async (arg: { prompt: string }) => { forks.push(arg.prompt); return { text: CARD, usage: {} }; } },
      ui: { log: (line: string) => { logs.push(line); } },
    };
  }
  const post = { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {}, tool_use_id: 'c19' };

  it('forks again past 85% of the window when the card is older than 15 tool calls, and logs it', async () => {
    const h = lateHost();
    await handlers({ lateCardRefresh: true })['classic.PostToolUse']!(h, post, pass);
    await h.replied;
    await settle();
    expect(h.forks).toHaveLength(1);
    expect(h.logs).toContain('task_card.refresh=start ctx=215000 window=250000 n=2 late=1 calls=20');
    expect(JSON.parse(h.files.get(STATE_PATH)!)).toMatchObject({ refreshes: 2, stretchDone: true, lateDone: true, lastTokens: 215_000 });
    expect(JSON.parse(h.files.get(HORIZON_PATH)!).toolUseId).toBe('c19');
  });
  it('also runs from turn.complete', async () => {
    const h = lateHost();
    await handlers({ lateCardRefresh: true })['turn.complete']!(h, { reason: 'answer', answer: 'done' }, pass);
    await h.replied;
    await settle();
    expect(h.forks).toHaveLength(1);
  });
  it('does nothing with the option off (the default)', async () => {
    const h = lateHost();
    await handlers()['classic.PostToolUse']!(h, post, pass);
    await settle();
    expect(h.forks).toHaveLength(0);
    expect(h.logs.some((line) => line.includes('late=1'))).toBe(false);
  });
  it.each([
    ['a fresh card (10 calls)', { calls: 10 }],
    ['below 85% of the window', { tokens: 200_000 }],
    ['the late step already spent', { state: { lastTokens: 215_000, refreshes: 2, stretchDone: true, lateDone: true } }],
    ['no stretch refresh yet (the 60% step is due instead)', { state: { lastTokens: 0, refreshes: 0 }, tokens: 100_000 }],
  ])('does not fork for %s', async (_name, options) => {
    const h = lateHost(options);
    await handlers({ lateCardRefresh: true })['classic.PostToolUse']!(h, post, pass);
    await settle();
    expect(h.forks).toHaveLength(0);
  });

  it.each([
    ['the 60% stretch step is due (64%), card old', 160_000],
    ['past 85% with the stretch step not done, card old', 215_000],
  ])('runs the stretch refresh, not the late one, when %s', async (_name, tokens) => {
    const h = lateHost({ state: { lastTokens: 0, refreshes: 0 }, tokens, calls: 20 });
    await handlers({ lateCardRefresh: true })['classic.PostToolUse']!(h, post, pass);
    await h.replied;
    await settle();
    expect(h.forks).toHaveLength(1);
    expect(h.logs.some((line) => line.startsWith('task_card.refresh=start'))).toBe(true);
    expect(h.logs.some((line) => line.includes('late=1'))).toBe(false);
    const state = JSON.parse(h.files.get(STATE_PATH)!);
    expect(state).toMatchObject({ refreshes: 1, stretchDone: true, lastTokens: tokens });
    expect(state.lateDone).toBeUndefined();
  });
});

describe('4.7.0 the options are declared (recipes default on since 4.7.2)', () => {
  it('lateCardRefresh and recipes are boolean options in the manifest; lateCardRefresh defaults false, recipes true', () => {
    const manifest = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')) as { userConfig?: Record<string, { type?: string; default?: unknown }> };
    for (const name of ['lateCardRefresh', 'recipes']) {
      expect(manifest.userConfig?.[name]?.type).toBe('boolean');
      expect(manifest.userConfig?.[name]?.default).toBe(name === 'recipes');
    }
  });
});
