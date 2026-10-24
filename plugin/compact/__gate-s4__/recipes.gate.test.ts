import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../core/budgets.js';
import { collectRecipes, renderRecipes, RECIPES_MAX_LINES, RECIPES_BUDGET_TOKENS } from '../core/recipes.js';
import { SEED_SENTINEL } from '../core/sentinel.js';
import type { SessionMessage } from '../core/types.js';

/** 4.7.0 (CONTRACT S5k): the seed's Recipes section, the commands that worked earlier in the session. Pure, no model call. */

const NONE: ReadonlySet<string> = new Set();

function call(id: string, tool: string, input: Record<string, unknown>): SessionMessage {
  return { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] };
}
function result(id: string, text: string, isError = false): SessionMessage {
  return { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text, isError }] };
}
function bash(id: string, command: string, output = '', isError = false, extra: Record<string, unknown> = {}): SessionMessage[] {
  return [call(id, 'Bash', { command, ...extra }), result(id, output, isError)];
}
const prompt = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] });
const commands = (messages: SessionMessage[], tail: ReadonlySet<string> = NONE) => collectRecipes(messages, tail).map((recipe) => recipe.command);

describe('4.7.0 (S5k) which commands are recipes', () => {
  it('keeps run, test, build, verify and deploy commands that worked, with a short outcome', () => {
    const messages = [
      prompt('go'),
      ...bash('a', 'cd /home/u/exo-compact && nice -n 10 node node_modules/vitest/vitest.mjs run plugin/compact', ' RUN v2.1\n Test Files  62 passed (62)\n      Tests  1462 passed (1462)\n   Duration  41s'),
      ...bash('b', 'npm run typecheck', '> tsc --noEmit\n'),
      ...bash('c', 'pnpm --filter mcp-server build', 'Done in 3.1s'),
      ...bash('d', 'curl -s localhost:3000/api/health', '{"ok":true}'),
    ];
    const recipes = collectRecipes(messages, NONE);
    expect(recipes.map((recipe) => recipe.command)).toEqual([
      'cd /home/u/exo-compact && nice -n 10 node node_modules/vitest/vitest.mjs run plugin/compact',
      'npm run typecheck',
      'pnpm --filter mcp-server build',
      'curl -s localhost:3000/api/health',
    ]);
    expect(recipes[0].outcome).toBe('1462 passed (1462)');
    expect(recipes[3].outcome).toBe('{"ok":true}');
  });

  it('skips a command that failed (error result or non-zero exit) and one with no result', () => {
    const messages = [
      ...bash('a', 'npm test', 'Exit code 1\nFAIL src/a.test.ts', true),
      ...bash('b', 'npm run build', 'Exit code 2\nerror TS2304', false),
      call('c', 'Bash', { command: 'npm run lint' }),
      ...bash('d', 'npm run typecheck', 'ok'),
    ];
    expect(commands(messages)).toEqual(['npm run typecheck']);
  });

  it('skips pure reads, git inspection and plain file work', () => {
    const messages = [
      ...bash('a', 'cat package.json', '{}'),
      ...bash('b', 'ls -la src', 'a.ts'),
      ...bash('c', "grep -rn 'recipes' plugin | head -20", 'x'),
      ...bash('d', 'sed -n 1,40p plugin/compact/compact.ts', 'x'),
      ...bash('e', 'git status --short', ''),
      ...bash('f', 'git log --oneline | head -5', 'abc'),
      ...bash('g', 'git diff --stat', ''),
      ...bash('h', 'find . -name "*.ts" -not -path "*/node_modules/*"', 'x'),
      ...bash('i', 'head -c 200 README.md', 'x'),
      ...bash('j', 'cd /home/u/proj', ''),
      ...bash('k', 'mkdir -p out && cp a.txt out/a.txt', ''),
      ...bash('l', 'pnpm test', 'Tests 3 passed'),
    ];
    expect(commands(messages)).toEqual(['pnpm test']);
  });

  it('classifies a path-shaped command by its basename: system binaries never qualify, project scripts do', () => {
    const messages = [
      ...bash('a', '/usr/bin/git log --oneline', 'abc'),
      ...bash('b', '/bin/cat package.json', '{}'),
      ...bash('c', '/usr/local/bin/rg recipes plugin', 'x'),
      ...bash('d', 'C:\\Windows\\System32\\findstr.exe foo a.txt', 'x'),
      ...bash('e', './scripts/dev.sh', 'started'),
      ...bash('f', '../tools/run.sh', 'ran'),
      ...bash('g', '/home/x/proj/bin/serve', 'serving'),
      ...bash('h', '/usr/bin/node build.js', 'built'),
      ...bash('i', '/usr/bin/npm test', '3 passed'),
      ...bash('j', './docs/notes.md', 'x'),
    ];
    expect(commands(messages)).toEqual(['./scripts/dev.sh', '../tools/run.sh', '/home/x/proj/bin/serve', '/usr/bin/node build.js', '/usr/bin/npm test']);
  });

  it('drops node/nodejs/python eval flags only before the script, not script arguments', () => {
    const messages = [
      ...bash('a', 'node dist/server.js -p 3000', 'listening'),
      ...bash('b', "nodejs -e 'console.log(1)'", '1'),
      ...bash('c', "node -p 'process.version'", 'v22'),
      ...bash('d', "python3 -c 'print(1)'", '1'),
      ...bash('e', 'python3 app.py -c config.yml', 'ok'),
      ...bash('f', 'node --version', 'v22'),
      ...bash('g', 'nodejs server.js --port 3100', 'up'),
    ];
    expect(commands(messages)).toEqual(['node dist/server.js -p 3000', 'python3 app.py -c config.yml', 'nodejs server.js --port 3100']);
  });

  it('does not show a password in a URL credential', () => {
    const messages = bash('a', 'curl -s http://admin:hunter2@127.0.0.1:3000/health', '{"ok":true}');
    const recipes = collectRecipes(messages, NONE);
    expect(recipes).toHaveLength(1);
    expect(JSON.stringify(recipes)).not.toContain('hunter2');
  });

  it('skips a heredoc command and a command that reads secrets', () => {
    const messages = [
      ...bash('a', "cat > notes.md <<'EOF'\nnpm test\nEOF", ''),
      ...bash('b', 'cat .env.local', 'KEY=1'),
      ...bash('c', 'npm run build', 'built'),
    ];
    expect(commands(messages)).toEqual(['npm run build']);
  });

  it('redacts secrets in env assignments and flags, keeping the variable name', () => {
    const messages = bash('a', 'EXOVAULT_AGENT_KEY=exo_live_9f8e7d6c5b4a39281706 EXOVAULT_API_URL=http://localhost:3000 node dist/server.js', 'listening on http://localhost:3000');
    const [recipe] = collectRecipes(messages, NONE);
    expect(recipe.command).not.toContain('exo_live_9f8e7d6c5b4a39281706');
    expect(recipe.command).toContain('EXOVAULT_AGENT_KEY=[redacted]');
    expect(recipe.command).toContain('EXOVAULT_API_URL=http://localhost:3000');
    expect(recipe.command).toContain('node dist/server.js');
    const [password] = collectRecipes(bash('b', 'DATABASE_PASSWORD=hunter2hunter2xyz npm run migrate', 'done'), NONE);
    expect(password.command).not.toContain('hunter2');
    expect(password.command).toContain('[redacted] npm run migrate');
  });

  it('leaves out a command the output-skip rules flag as sensitive (--token, env dumps, secret files)', () => {
    const messages = [
      ...bash('a', 'node dist/server.js --token abc123secret456', 'ok'),
      ...bash('b', 'docker compose config', 'services: {}'),
      ...bash('c', 'npm test', 'Tests 3 passed'),
    ];
    expect(commands(messages)).toEqual(['npm test']);
  });

  it('keeps one line per command, the newest outcome, and puts it at its newest position', () => {
    const messages = [
      ...bash('a', 'npm test', 'Tests 10 passed'),
      ...bash('b', 'npm run build', 'built'),
      ...bash('c', 'npm  test  2>&1 | tail -20', 'Tests 12 passed'),
    ];
    const recipes = collectRecipes(messages, NONE);
    expect(recipes.map((recipe) => recipe.command)).toEqual(['npm run build', 'npm test']);
    expect(recipes[1].outcome).toBe('12 passed');
  });

  it('skips a command the kept tail already shows (by id or by the same command)', () => {
    const messages = [
      ...bash('a', 'npm run build', 'built'),
      ...bash('b', 'npm test', 'Tests 12 passed'),
      ...bash('c', 'npm run build', 'built again'),
    ];
    expect(commands(messages, new Set(['c']))).toEqual(['npm test']);
    expect(commands(messages, new Set(['b']))).toEqual(['npm run build']);
  });

  it('records a background run with its task id, the port and the working directory', () => {
    const messages = [
      ...bash('a', 'cd /home/u/app', ''),
      ...bash('b', 'PORT=3100 npm run dev', 'Command running in background with ID: bk7m2x9. Output is being written to: /tmp/x.output', false, { run_in_background: true }),
      ...bash('c', 'tail -5 /tmp/x.output', '- Local: http://localhost:3100'),
    ];
    const [recipe, ...rest] = collectRecipes(messages, NONE, { sessionCwd: '/home/u/other' });
    expect(rest).toEqual([]);
    expect(recipe.command).toBe('PORT=3100 npm run dev');
    expect(recipe.outcome).toContain('background bk7m2x9');
    expect(recipe.outcome).toContain('localhost:3100');
    expect(recipe.outcome).toContain('in /home/u/app');
  });

  it('adds the port a server printed when it is not in the command', () => {
    const [recipe] = collectRecipes(bash('a', 'node dist/server.js', 'Server listening on 127.0.0.1:8765', false, { run_in_background: true }), NONE);
    expect(recipe.outcome).toContain('127.0.0.1:8765');
  });

  it('shortens a long command in the middle and joins continuation lines', () => {
    const long = `node scripts/run.mjs ${'--flag-number-'.repeat(20)}--end-marker`;
    const [recipe] = collectRecipes(bash('a', long, 'ok'), NONE);
    expect(Array.from(recipe.command).length).toBeLessThanOrEqual(130);
    expect(recipe.command).toContain('…');
    expect(recipe.command.startsWith('node scripts/run.mjs')).toBe(true);
    expect(recipe.command.endsWith('--end-marker')).toBe(true);
    const [joined] = collectRecipes(bash('b', 'npm run build \\\n  --workspaces', 'ok'), NONE);
    expect(joined.command).toBe('npm run build --workspaces');
  });

  it('caps the list at RECIPES_MAX_LINES, newest kept', () => {
    const messages = Array.from({ length: 12 }, (_, i) => bash(`t${i}`, `npm run build:pkg${i}`, 'ok')).flat();
    const recipes = collectRecipes(messages, NONE);
    expect(recipes).toHaveLength(RECIPES_MAX_LINES);
    expect(recipes.at(-1)?.command).toBe('npm run build:pkg11');
    expect(recipes[0].command).toBe(`npm run build:pkg${12 - RECIPES_MAX_LINES}`);
  });

  it('carries recipes from an earlier seed forward, the newer run winning', () => {
    const earlier: SessionMessage = { role: 'user', text: `${SEED_SENTINEL}\n## Task card\nx\n\n## Recipes (commands that ran fine earlier; reference only)\nThe commands.\n- npm run e2e  (12 passed)\n- npm test  (10 passed)\n\n## Next`, toolUses: [] };
    const messages = [earlier, ...bash('a', 'npm test', 'Tests 14 passed')];
    const recipes = collectRecipes(messages, NONE);
    expect(recipes.map((recipe) => `${recipe.command}|${recipe.outcome}`)).toEqual(['npm run e2e|12 passed', 'npm test|14 passed']);
  });
});

describe('4.7.0 (S5k) renderRecipes', () => {
  const recipes = [
    { command: 'npm test', outcome: '12 passed' },
    { command: 'cd /home/u/app && npm run dev', outcome: 'background bk1; localhost:3100' },
  ];
  it('renders one line per recipe, "- cmd  (outcome)", under a one-line header', () => {
    const body = renderRecipes(recipes, RECIPES_BUDGET_TOKENS, estimateTokens);
    expect(body.split('\n').filter((line) => line.startsWith('- '))).toEqual(['- npm test  (12 passed)', '- cd /home/u/app && npm run dev  (background bk1; localhost:3100)']);
    expect(body.split('\n')[0]).not.toMatch(/^- /);
  });
  it('is empty for no recipes, and drops the oldest lines over the budget', () => {
    expect(renderRecipes([], 400, estimateTokens)).toBe('');
    const many = Array.from({ length: 8 }, (_, i) => ({ command: `npm run build:package-${i} --workspaces --if-present`, outcome: 'ok' }));
    const body = renderRecipes(many, 60, estimateTokens);
    expect(estimateTokens(body)).toBeLessThanOrEqual(60);
    expect(body).toContain('package-7');
    expect(body).not.toContain('package-0');
    expect(renderRecipes(many, 5, estimateTokens)).toBe('');
  });
  it('stays within about 400 tokens at the cap on realistic long commands', () => {
    const many = Array.from({ length: RECIPES_MAX_LINES }, (_, i) => ({ command: `cd /home/user1/work/exo-compact-recipes && nice -n 10 node node_modules/vitest/vitest.mjs run plugin/compact/__gate-s4__/file-${i}.test.ts`, outcome: '62 files passed' }));
    expect(estimateTokens(renderRecipes(many, RECIPES_BUDGET_TOKENS, estimateTokens))).toBeLessThanOrEqual(RECIPES_BUDGET_TOKENS);
  });
});

describe('4.7.2 (S5k) outputText off (toolOutputNotes: false)', () => {
  it('gives ok, no output text, keeps the background id, drops result-only ports', () => {
    const messages = [
      prompt('go'),
      ...bash('a', 'npm test', 'line 0072 secret-ish text\n 12 passed (12)'),
      ...bash('b', 'npm run dev', 'Command running in background with ID: bk7m2x9. listening on localhost:4000', false, { run_in_background: true }),
      ...bash('c', 'PORT=3100 npm run dev', 'Command running in background with ID: bk8. also localhost:4001', false, { run_in_background: true }),
    ];
    const off = collectRecipes(messages, NONE, { outputText: false });
    expect(off.map((recipe) => recipe.outcome)).toEqual(['ok', 'background bk7m2x9', 'background bk8; localhost:3100']);
    const on = collectRecipes(messages, NONE);
    expect(on[0].outcome).toBe('12 passed (12)');
    expect(on[1].outcome).toBe('background bk7m2x9; localhost:4000');
    expect(collectRecipes(messages, NONE, { outputText: true })).toEqual(on);
  });
  it('strips result-only text from recipes carried in an earlier seed, keeping our own background marker, command ports and cwd', () => {
    const lines = ['- npm run dev  (background bk7m2x9; localhost:4000)', '- npm run dev:b  (started in background; localhost:4000)', '- PORT=3100 npm run dev:c  (background bk8; localhost:3100; localhost:4001)', '- npm test  (12 passed (12))', '- npm run dev:d  (background bk9; localhost:4000; in /repo/app)', '- npm run build  (done; in /repo)'];
    const earlier: SessionMessage = { role: 'user', text: `${SEED_SENTINEL}\n## Task card\nx\n\n## Recipes (commands that ran fine earlier; reference only)\nThe commands.\n${lines.join('\n')}\n\n## Next`, toolUses: [] };
    const off = collectRecipes([earlier, prompt('go')], NONE, { outputText: false });
    expect(off.map((recipe) => recipe.outcome)).toEqual(['background bk7m2x9', 'started in background', 'background bk8; localhost:3100', 'ok', 'background bk9; in /repo/app', 'ok']);
    const on = collectRecipes([earlier, prompt('go')], NONE);
    expect(on.map((recipe) => recipe.outcome)).toEqual(['background bk7m2x9; localhost:4000', 'started in background; localhost:4000', 'background bk8; localhost:3100; localhost:4001', '12 passed (12)', 'background bk9; localhost:4000; in /repo/app', 'done; in /repo']);
    expect(collectRecipes([earlier, prompt('go')], NONE, { outputText: true })).toEqual(on);
  });
});
