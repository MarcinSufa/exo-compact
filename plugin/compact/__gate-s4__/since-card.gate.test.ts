import { describe, it, expect } from 'vitest';
import { SINCE_CARD_BUDGET_TOKENS, estimateTokens } from '../core/budgets.js';
import { collectSinceCard, parseCardHorizon, READ_ONLY_TOOLS, renderSinceCard } from '../core/since-card.js';
import { SEED_SENTINEL } from '../core/sentinel.js';
import type { SessionMessage } from '../core/types.js';

/** 4.6.0 (CONTRACT S5f): what happened after the task card's horizon and before the kept tail. */

const NONE: ReadonlySet<string> = new Set();

function call(id: string, tool: string, input: Record<string, unknown>): SessionMessage {
  return { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] };
}
function result(id: string, text: string, isError = false): SessionMessage {
  return { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text, isError }] };
}
function step(id: string, tool: string, input: Record<string, unknown>, text = 'ok', isError = false): SessionMessage[] {
  return [call(id, tool, input), result(id, text, isError)];
}
const prompt = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] });
const seed = (): SessionMessage => ({ role: 'user', text: `${SEED_SENTINEL}\nold seed`, toolUses: [] });

function lines(messages: SessionMessage[], horizon = 'h1', tail: ReadonlySet<string> = NONE) {
  const steps = collectSinceCard(messages, horizon, tail);
  return { steps, text: renderSinceCard(steps, 5000, estimateTokens).body };
}
/** The list lines of a rendered section. */
const items = (body: string): string[] => body.split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2));

describe('4.6.0 (S5f) parseCardHorizon', () => {
  it('reads the tool use id, and treats {} / junk / nothing as no horizon', () => {
    expect(parseCardHorizon('{"toolUseId":"toolu_1","at":"2026-10-07T10:00:00.000Z","tokens":5}')).toBe('toolu_1');
    expect(parseCardHorizon('{}')).toBeUndefined();
    expect(parseCardHorizon('not json')).toBeUndefined();
    expect(parseCardHorizon('{"toolUseId":""}')).toBeUndefined();
    expect(parseCardHorizon('{"toolUseId":7}')).toBeUndefined();
    expect(parseCardHorizon(undefined)).toBeUndefined();
  });
});

describe('4.6.0 (S5f) one line per step', () => {
  it('lists writes and edits by path, oldest first', () => {
    const messages = [
      prompt('go'),
      ...step('h1', 'Write', { file_path: 'src/a.ts', content: 'x' }),
      ...step('t2', 'Edit', { file_path: 'src/b.ts', old_string: 'a', new_string: 'b' }),
      ...step('t3', 'MultiEdit', { file_path: 'src/c.ts', edits: [] }),
      ...step('t4', 'NotebookEdit', { notebook_path: 'n.ipynb', new_source: 'x' }),
    ];
    expect(items(lines(messages).text)).toEqual(['wrote src/a.ts', 'edited src/b.ts', 'edited src/c.ts', 'edited n.ipynb']);
  });

  it('reports a failed edit with the first error line', () => {
    const messages = [...step('h1', 'Edit', { file_path: 'src/b.ts', old_string: 'a', new_string: 'b' }, '\n\nString to replace not found in file.\nmore detail', true)];
    expect(items(lines(messages).text)).toEqual(['edit of src/b.ts failed: String to replace not found in file.']);
  });

  it.each([
    ["cat > src/a.ts <<'EOF'\nexport const a = 1;\nEOF", 'wrote src/a.ts (bash)'],
    ['echo "x" >> notes/log.md', 'wrote notes/log.md (bash)'],
    ['printf hi | tee out/b.txt', 'wrote out/b.txt (bash)'],
    ["sed -i 's/a/b/' src/c.ts", 'wrote src/c.ts (bash)'],
    ["sed -i -e 's/a/b/' -e 's/c/d/' src/c.ts", 'wrote src/c.ts (bash)'],
    ["sed -i --expression='s/a/b/' -f fix.sed src/c.ts src/e.ts", 'wrote src/c.ts, src/e.ts (bash)'],
    ['mv old.ts new.ts', 'wrote new.ts (bash)'],
    ['cp -r tpl/ src/d', 'wrote src/d (bash)'],
  ])('lists a Bash file write: %s', (command, expected) => {
    expect(items(lines(step('h1', 'Bash', { command })).text)).toEqual([expected]);
  });

  it('does not call a test run with a log redirect a file write', () => {
    const [line] = items(lines(step('h1', 'Bash', { command: 'pnpm test > /tmp/out.log 2>&1' }, 'Tests 3 passed (3)')).text);
    expect(line).toBe('ran `pnpm test > /tmp/out.log 2>&1` -> Tests 3 passed (3)');
  });

  it('lists other Bash with the first command line and the last output line', () => {
    const out = 'RUN v2\n\n ✓ a.test.ts (4)\n Tests  12 passed (12)\n';
    expect(items(lines(step('h1', 'Bash', { command: 'npx vitest run a\necho done' }, out)).text)).toEqual(['ran `npx vitest run a` -> Tests 12 passed (12)']);
  });

  it('cuts the command and the outcome at 100 characters', () => {
    const [line] = items(lines(step('h1', 'Bash', { command: `echo ${'a'.repeat(300)} | wc`.replace('echo', 'run') }, `x ${'b'.repeat(300)}\n${'c'.repeat(150)}`)).text);
    const command = /ran `([^`]*)`/.exec(line)![1];
    const outcome = line.split(' -> ')[1];
    expect(Array.from(command).length).toBeLessThanOrEqual(100);
    expect(Array.from(outcome).length).toBeLessThanOrEqual(100);
  });

  it('reports a failed command with its first error line', () => {
    const [line] = items(lines(step('h1', 'Bash', { command: 'pnpm build' }, '\nerror TS2304: Cannot find name x\n  at y', true)).text);
    expect(line).toBe('ran `pnpm build` -> failed: error TS2304: Cannot find name x');
  });

  it('lists an agent by its description', () => {
    expect(items(lines(step('h1', 'Agent', { description: 'Review the diff', prompt: 'long' })).text)).toEqual(['started agent: Review the diff']);
    expect(items(lines(step('h1', 'Task', { description: 'Find usages', prompt: 'long' })).text)).toEqual(['started agent: Find usages']);
  });

  it('names any other tool, with its activity text when there is one', () => {
    expect(items(lines(step('h1', 'TodoWrite', { todos: [] })).text)).toEqual(['TodoWrite']);
    expect(items(lines(step('h1', 'mcp__exo__write_memory', { text: 'x' })).text)).toEqual(['mcp__exo__write_memory']);
  });

  it('folds read-only calls into one last line', () => {
    const messages = [
      ...step('h1', 'Read', { file_path: 'a.ts' }),
      ...step('t2', 'Write', { file_path: 'src/a.ts', content: 'x' }),
      ...step('t3', 'Grep', { pattern: 'x' }),
      ...step('t4', 'Read', { file_path: 'b.ts' }),
      ...step('t5', 'mcp__exo__search_memories', { query: 'x' }),
      ...step('t6', 'Glob', { pattern: '*.ts' }),
      ...step('t7', 'Read', { file_path: 'c.ts' }),
    ];
    const { text } = lines(messages);
    expect(items(text)).toEqual(['wrote src/a.ts', 'plus 6 read-only calls (Read ×3, Grep ×1, mcp__exo__search_memories ×1, Glob ×1)']);
  });

  it('says nothing when the only calls are read-only', () => {
    expect(lines([...step('h1', 'Read', { file_path: 'a.ts' }), ...step('t2', 'Grep', { pattern: 'x' })]).text).toBe('');
  });

  it('strips ANSI escapes and keeps every step on one physical line', () => {
    const out = '\u001b[32mPASS\u001b[0m  src/a.test.ts\r\n\u001b[1mTests\u001b[22m  4\tpassed\u001b[0m';
    const { text } = lines(step('h1', 'Bash', { command: '\u001b[1mnpx vitest\u001b[0m run' }, out));
    expect(text).not.toContain('\u001b');
    expect(items(text)).toEqual(['ran `npx vitest run` -> Tests 4 passed']);
    for (const line of text.split('\n')) expect(line).not.toMatch(/[\r\t]/);
  });
});

describe('4.6.0 (S5f) redaction', () => {
  it('redacts a secret in a command and in its output', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const command = `curl -s -H "X-Thing: ${secret}" https://api.example.com/v1`;
    const { text } = lines(step('h1', 'Bash', { command }, `{"ok":true}\nuser token ${secret}`));
    expect(text).not.toContain('ghp_');
    expect(text).toContain('ran `curl');
    const failed = lines(step('h1', 'Bash', { command: 'curl https://api.example.com' }, `bad key ${secret}`, true)).text;
    expect(failed).not.toContain('ghp_');
  });

  it('withholds the output of a command the extractor skips, error or not', () => {
    const quiet = lines(step('h1', 'Bash', { command: 'printenv HOME' }, 'HOME=/home/x')).text;
    expect(items(quiet)).toEqual(['ran `printenv HOME` -> [output withheld]']);
    const failed = lines(step('h1', 'Bash', { command: 'cat .env' }, 'API_URL=x', true)).text;
    expect(failed).not.toContain('API_URL');
    expect(failed).toContain('[output withheld]');
  });
});

describe('4.6.0 (S5f) the horizon', () => {
  const before = [...step('b1', 'Write', { file_path: 'old.ts', content: 'x' }), ...step('b2', 'Bash', { command: 'ls' }, 'files')];
  const after = [...step('h1', 'Write', { file_path: 'src/h.ts', content: 'x' }), ...step('a2', 'Write', { file_path: 'src/a.ts', content: 'x' })];

  it('starts at the horizon call itself and skips what the card already saw', () => {
    const steps = collectSinceCard([prompt('go'), ...before, ...after], 'h1', NONE);
    expect(steps.horizon).toBe('found');
    expect(steps.predates).toBe(false);
    expect(items(renderSinceCard(steps, 5000, estimateTokens).body)).toEqual(['wrote src/h.ts', 'wrote src/a.ts']);
  });

  it('starts after the last seed message when the horizon predates an earlier cut', () => {
    const messages = [...before, seed(), prompt('go on'), ...after.slice(2), ...step('a3', 'Bash', { command: 'pnpm lint' }, 'clean')];
    const steps = collectSinceCard(messages, 'gone', NONE);
    expect(steps.horizon).toBe('before_cut');
    expect(steps.predates).toBe(true);
    const body = renderSinceCard(steps, 5000, estimateTokens).body;
    expect(body).toContain('The task card above predates the last cut; these 2 steps came after it');
    expect(items(body)).toEqual(['wrote src/a.ts', 'ran `pnpm lint` -> clean']);
  });

  it('is missing without a horizon id, and renders nothing', () => {
    const steps = collectSinceCard([...before, ...after], undefined, NONE);
    expect(steps.horizon).toBe('missing');
    expect(renderSinceCard(steps, 5000, estimateTokens)).toEqual({ body: '', listed: 0 });
  });

  it('leaves out the calls the kept tail shows verbatim', () => {
    const tail = [...step('t1', 'Write', { file_path: 'src/tail.ts', content: 'x' })];
    const steps = collectSinceCard([...before, ...after, ...tail], 'h1', new Set(['t1']));
    expect(items(renderSinceCard(steps, 5000, estimateTokens).body)).toEqual(['wrote src/h.ts', 'wrote src/a.ts']);
  });

  it('renders nothing when the horizon call is already inside the tail', () => {
    const steps = collectSinceCard([...before, ...after], 'h1', new Set(['h1', 'a2']));
    expect(steps.horizon).toBe('found');
    expect(renderSinceCard(steps, 5000, estimateTokens).body).toBe('');
  });
});

describe('4.6.0 (S5f) the section text', () => {
  it('says what the steps are and which side to trust', () => {
    const messages = [...step('h1', 'Write', { file_path: 'src/a.ts', content: 'x' }), ...step('t2', 'Bash', { command: 'npx vitest run a' }, 'Tests 12 passed (12)')];
    const { body, listed } = renderSinceCard(collectSinceCard(messages, 'h1', NONE), 5000, estimateTokens);
    expect(listed).toBe(2);
    expect(body).toBe([
      'The task card above was written before these 2 steps (oldest first); neither the card nor the kept tail shows them.',
      "Where they disagree with the card's Done or Next step, trust them and `git status` / `git diff` over the card.",
      '- wrote src/a.ts',
      '- ran `npx vitest run a` -> Tests 12 passed (12)',
    ].join('\n'));
  });

  it('is deterministic', () => {
    const messages = [...step('h1', 'Write', { file_path: 'src/a.ts', content: 'x' }), ...step('t2', 'Bash', { command: 'ls' }, 'a\nb c d e f g h')];
    const render = () => renderSinceCard(collectSinceCard(messages, 'h1', NONE), 5000, estimateTokens);
    expect(render()).toEqual(render());
  });
});

describe('4.6.0 (S5f) budget', () => {
  const many = Array.from({ length: 80 }, (_, i) => step(i === 0 ? 'h1' : `t${i}`, 'Write', { file_path: `src/part-${i}/index-file-${i}.ts`, content: 'x' })).flat();

  it('is 500 tokens', () => {
    expect(SINCE_CARD_BUDGET_TOKENS).toBe(500);
  });

  it('keeps the newest lines and says how many earlier steps it left out', () => {
    const steps = collectSinceCard(many, 'h1', NONE);
    const { body, listed } = renderSinceCard(steps, SINCE_CARD_BUDGET_TOKENS, estimateTokens);
    expect(estimateTokens(body)).toBeLessThanOrEqual(SINCE_CARD_BUDGET_TOKENS);
    const list = items(body);
    expect(list[0]).toBe(`(${80 - listed} earlier steps left out)`);
    expect(listed).toBeGreaterThan(0);
    expect(listed).toBeLessThan(80);
    expect(list.at(-1)).toBe('wrote src/part-79/index-file-79.ts');
    expect(list).not.toContain('wrote src/part-0/index-file-0.ts');
    expect(body).toContain('written before these 80 steps');
  });

  it('shrinks further on a smaller budget and floors at the header and the left-out line', () => {
    const steps = collectSinceCard(many, 'h1', NONE);
    const small = renderSinceCard(steps, 150, estimateTokens);
    const none = renderSinceCard(steps, 0, estimateTokens);
    expect(small.listed).toBeLessThan(renderSinceCard(steps, SINCE_CARD_BUDGET_TOKENS, estimateTokens).listed);
    expect(none.listed).toBe(0);
    expect(items(none.body)).toEqual(['(80 earlier steps left out)']);
  });

  it('keeps the read-only line when it trims', () => {
    const messages = [...many, ...step('r1', 'Read', { file_path: 'a.ts' }), ...step('r2', 'Read', { file_path: 'b.ts' })];
    const { body } = renderSinceCard(collectSinceCard(messages, 'h1', NONE), 200, estimateTokens);
    expect(items(body).at(-1)).toBe('plus 2 read-only calls (Read ×2)');
  });
});

describe('4.6.0 (S5f) minKept', () => {
  const many = Array.from({ length: 80 }, (_, i) => step(i === 0 ? 'h1' : `t${i}`, 'Write', { file_path: `src/part-${i}/index-file-${i}.ts`, content: 'x' })).flat();

  it('keeps the newest 3 lines even at budget 0', () => {
    const { body, listed } = renderSinceCard(collectSinceCard(many, 'h1', NONE), 0, estimateTokens, 3);
    expect(items(body)).toEqual(['(77 earlier steps left out)', 'wrote src/part-77/index-file-77.ts', 'wrote src/part-78/index-file-78.ts', 'wrote src/part-79/index-file-79.ts']);
    expect(listed).toBe(3);
  });

  it('keeps all lines when there are fewer than minKept', () => {
    const messages = [...step('h1', 'Write', { file_path: 'src/a.ts', content: 'x' }), ...step('t1', 'Write', { file_path: 'src/b.ts', content: 'x' })];
    const { body } = renderSinceCard(collectSinceCard(messages, 'h1', NONE), 0, estimateTokens, 3);
    expect(items(body)).toEqual(['wrote src/a.ts', 'wrote src/b.ts']);
  });

  it('with minKept 0 (or none) behaves as before', () => {
    const steps = collectSinceCard(many, 'h1', NONE);
    expect(renderSinceCard(steps, 0, estimateTokens, 0)).toEqual(renderSinceCard(steps, 0, estimateTokens));
    expect(items(renderSinceCard(steps, 0, estimateTokens, 0).body)).toEqual(['(80 earlier steps left out)']);
    expect(renderSinceCard(steps, 150, estimateTokens, 0)).toEqual(renderSinceCard(steps, 150, estimateTokens));
  });

  it('does not cut a roomy budget below what fits', () => {
    const steps = collectSinceCard(many, 'h1', NONE);
    expect(renderSinceCard(steps, 150, estimateTokens, 3).listed).toBe(renderSinceCard(steps, 150, estimateTokens).listed);
  });
});

describe('4.6.0 (S5f) Bash steps that write files among other commands, cd stripping, camelCase MCP', () => {
  const only = (messages: SessionMessage[]): string => items(lines(messages).text)[0];

  it('names the file of a real over-4096-char heredoc step that also runs sed and grep', () => {
    const body = 'it("x", () => { expect(1).toBe(1); });\n'.repeat(130);
    const command = `cd /home/u/work/sandbox/s4-rw63a/acme-app/packages/app\ncat > test/r13-css-targets.test.ts <<'EOF'\n${body}EOF\nsed -n 1,40p src/ui/memory/memory-learned.tsx | head -20; grep -n "mr-chip\\|mr-inbox" src/ui/memory/*.tsx | head`;
    expect(command.length).toBeGreaterThan(4096);
    expect(only(step('h1', 'Bash', { command }, 'done'))).toBe('wrote /home/u/work/sandbox/s4-rw63a/acme-app/packages/app/test/r13-css-targets.test.ts (bash, with other commands) -> [output withheld]');
  });

  it('adds the last output line to a short mixed command', () => {
    const command = "cat > a.txt <<'EOF'\nx\nEOF\npnpm vitest run a";
    expect(only(step('h1', 'Bash', { command }, 'RUN v1\n Tests  3 passed (3)\n'))).toBe('wrote a.txt (bash, with other commands) -> Tests 3 passed (3)');
  });

  it('names the written file on a failed mixed command, after the shown command', () => {
    const command = "cat > a.txt <<'EOF'\nx\nEOF\npnpm vitest run a";
    expect(only(step('h1', 'Bash', { command }, 'Error: boom', true))).toBe("ran `cat > a.txt <<'EOF'` (writes a.txt) -> failed: Error: boom");
  });

  it('drops leading cd commands from the shown command only', () => {
    expect(only(step('h1', 'Bash', { command: 'cd packages/api && pnpm vitest run x' }, 'ok'))).toBe('ran `pnpm vitest run x` -> ok');
    expect(only(step('h1', 'Bash', { command: 'cd "/tmp/a b"; ls' }, 'ok'))).toBe('ran `ls` -> ok');
    expect(only(step('h1', 'Bash', { command: "cd 'x'\ncd y && ls" }, 'ok'))).toBe('ran `ls` -> ok');
    expect(only(step('h1', 'Bash', { command: 'cd packages/api' }, 'ok'))).toBe('ran `cd packages/api` -> ok');
  });

  it('splits camelCase MCP tool names when judging read-only', () => {
    const messages = [
      ...step('h1', 'mcp__srv__readMessages', {}),
      ...step('t2', 'mcp__srv__get_status', {}),
      ...step('t3', 'mcp__exo-vault__search_memories', {}),
      ...step('t4', 'mcp__srv__writeMemory', {}),
      ...step('t5', 'mcp__srv__update_task', {}),
      ...step('t6', 'mcp__srv__getaway', {}),
    ];
    const { steps } = lines(messages);
    expect(steps.readOnly).toBe('plus 3 read-only calls (mcp__srv__readMessages ×1, mcp__srv__get_status ×1, mcp__exo-vault__search_memories ×1)');
    expect(steps.lines.map((line) => line.split(':')[0])).toEqual(['mcp__srv__writeMemory', 'mcp__srv__update_task', 'mcp__srv__getaway']);
  });

  it('shortens a long list of absolute paths to their last two segments so every name survives the line cut', () => {
    const dir = '/home/u/work/sandbox/s4-rw60a/acme-app/packages/app';
    const command = `cd ${dir}\ncat > test/r17-vault-header.test.tsx <<'EOF'\nx\nEOF\ncat > test/r17-pill-scope.test.tsx <<'EOF'\ny\nEOF\npnpm vitest run test/r17`;
    expect(only(step('h1', 'Bash', { command }, 'ok'))).toBe('wrote …/test/r17-vault-header.test.tsx, …/test/r17-pill-scope.test.tsx (bash, with other commands) -> ok');
  });

  it('keeps a single absolute path whole when the list fits the line', () => {
    const command = "cd /tmp/proj\ncat > out/a.txt <<'EOF'\nx\nEOF\npnpm test";
    expect(only(step('h1', 'Bash', { command }, 'ok'))).toBe('wrote /tmp/proj/out/a.txt (bash, with other commands) -> ok');
  });
});

describe('4.6.0 (S5f) review fixes: shortened lists, reads, horizon message, read-only set', () => {
  const only = (messages: SessionMessage[]): string => items(lines(messages).text)[0];

  it('lists the shortened names that fit whole, then +K more, when even the shortened list is over the line', () => {
    const names = ['r17-first-testname', 'r17-second-testnam', 'r17-third-testname'];
    const command = `cd /home/u/work/sandbox/s4-rw60a/acme-app/packages/app\n${names.map((name) => `cat > test/${name}.test.tsx <<'EOF'\nx\nEOF`).join('\n')}\npnpm vitest run test/r17`;
    const line = only(step('h1', 'Bash', { command }, 'ok'));
    expect(line).toBe('wrote …/test/r17-first-testname.test.tsx, …/test/r17-second-testnam.test.tsx, +1 more (bash, with other commands) -> ok');
    expect(line).not.toMatch(/third/);
    expect(line).not.toMatch(/…(?!\/)(?! \()/);
  });

  it('keeps a heredoc write followed by a read-only sed -n as a mixed command with its outcome', () => {
    const command = "cat > src/a.ts <<'EOF'\nexport const a = 1;\nEOF\nsed -n '1,20p' src/a.ts";
    expect(only(step('h1', 'Bash', { command }, 'export const a = 1;'))).toBe('wrote src/a.ts (bash, with other commands) -> export const a = 1;');
  });

  it.each([['head -5 src/a.ts'], ['tail -n 3 src/a.ts'], ['cat src/a.ts'], ['ls src'], ['grep -n a src/a.ts']])('a write followed by the read `%s` is a mixed command', (read) => {
    const command = `echo x > src/a.ts\n${read}`;
    expect(only(step('h1', 'Bash', { command }, 'out'))).toBe('wrote src/a.ts (bash, with other commands) -> out');
  });

  it.each([['echo y | tee out.txt'], ['mv a b'], ['cp a b'], ['mkdir -p d && touch d/x'], ['chmod +x run.sh && rm old.sh'], ['export A=1; set -e']])('real file work `%s` stays file work only', (work) => {
    const command = `echo x > d/f.txt && ${work}`;
    expect(only(step('h1', 'Bash', { command }, 'out'))).toMatch(/^wrote .* \(bash\)$/);
  });

  it('counts sed as file work only with -i', () => {
    expect(only(step('h1', 'Bash', { command: "sed -i 's/a/b/' src/a.ts" }, 'out'))).toBe('wrote src/a.ts (bash)');
    expect(only(step('h1', 'Bash', { command: "echo x > src/a.ts\nsed -n '1p' src/a.ts" }, 'out'))).toBe('wrote src/a.ts (bash, with other commands) -> out');
  });

  it('lists only the horizon call and later ones on the horizon message itself', () => {
    const messages: SessionMessage[] = [
      prompt('go'),
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a1', tool: 'Write', input: { file_path: 'a.ts', content: 'x' } }, { tool_use_id: 'h1', tool: 'Write', input: { file_path: 'b.ts', content: 'x' } }] },
      result('a1', 'ok'),
      result('h1', 'ok'),
    ];
    const { steps, text } = lines(messages);
    expect(items(text)).toEqual(['wrote b.ts']);
    expect(steps.total).toBe(1);
  });

  it.each([...READ_ONLY_TOOLS])('folds %s into the read-only line', (tool) => {
    const { steps } = lines([...step('h1', 'Write', { file_path: 'a.ts', content: 'x' }), ...step('t2', tool, {})]);
    expect(steps.lines).toEqual(['wrote a.ts']);
    expect(steps.readOnly).toBe(`plus 1 read-only calls (${tool} ×1)`);
  });
});
