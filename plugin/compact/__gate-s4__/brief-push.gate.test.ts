import { LEGACY_OPTIONS } from './fixtures/helpers.js';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { BRIEF_PUSH_ARMED, BRIEF_PUSH_FILE, BRIEF_PUSH_OFF, bashWrites, parseBriefLimits, parseBriefPush, pushTarget, renderBriefLimits, renderBriefPush } from '../core/brief-push.js';
import { briefLineLimits, briefPush, limitWarnings, pushQuery } from '../recall/brief-push.mjs';
import { saveBrief } from '../recall/brief.mjs';

const OLD_BRIEF = [
  'Task 1 of 2. Build the list view.',
  '## Tests',
  '- test/r1-list.test.tsx (at least 4): renders the rows in order.',
].join('\n');
const NEW_BRIEF = [
  'Task 2 of 2. Build the project pill.',
  '## Files',
  '1. src/ui/project-pill.tsx (new, at most 60 lines): exports `ProjectPill` and `projectPillLabel`.',
  '2. src/styles/vault.css: `.ck .mv-proj` gets `height: 44px` and `border: 1px solid var(--line2)`.',
  '',
  '## Tests',
  'test/r2-css-pill.test.ts (at least 7): reads only vault.css.',
  '- pins the `.ck .mv-proj` declarations.',
  'Literal pins (the gate greps each): `readFileSync`, `var(--line2)`, `var(--bg1)`.',
  'test/r2-pill.test.tsx (at least 5): renders the select with the routed project.',
  '',
  '## Done when',
  '- pnpm --filter @acme/app exec vitest run test/r2 passes.',
].join('\n');

function rootWithBriefs(session: string, briefs: string[]): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'brief-push-'));
  briefs.forEach((text, i) => saveBrief(root, session, text, new Date(Date.UTC(2026, 9, 2, 8, i))));
  return root;
}

describe('3.40.0 (S4zl) which calls write a file', () => {
  it('finds heredoc, redirect, tee and in-place targets, not reads or /tmp', () => {
    expect(bashWrites("cat > packages/app/test/r2-css-pill.test.ts <<'EOF'\nx\nEOF")).toEqual(['packages/app/test/r2-css-pill.test.ts']);
    expect(bashWrites('echo a | tee -a src/a.css')).toEqual(['src/a.css']);
    expect(bashWrites("sed -i 's/a/b/' src/ui/x.tsx src/ui/y.tsx")).toEqual(['src/ui/x.tsx', 'src/ui/y.tsx']);
    expect(bashWrites('pnpm vitest run test/r2-pill.test.tsx > /tmp/v.json')).toEqual([]);
    expect(bashWrites('cat test/r2-pill.test.tsx; grep -n x src/a.css')).toEqual([]);
    expect(bashWrites('node x.mjs > ../../tmp/out.json')).toEqual([]);
  });

  it('maps Write, Edit, MultiEdit and Bash to files and text, and ignores other tools', () => {
    expect(pushTarget({ tool: 'Write', tool_use_id: 't', file_path: '/r/a.ts', content: 'export const A = 1;' })).toEqual({ files: ['/r/a.ts'], text: 'export const A = 1;' });
    expect(pushTarget({ tool: 'Edit', tool_use_id: 't', file_path: '/r/a.ts', old_string: 'x', new_string: 'y' })).toEqual({ files: ['/r/a.ts'], text: 'y' });
    expect(pushTarget({ tool: 'MultiEdit', tool_use_id: 't', file_path: '/r/a.ts', edits: [{ new_string: 'p' }, { new_string: 'q' }] })?.text).toBe('p\nq');
    expect(pushTarget({ tool: 'Bash', tool_use_id: 't', command: 'cat > src/a.css <<EOF\n.x{}\nEOF' })?.files).toEqual(['src/a.css']);
    expect(pushTarget({ tool: 'Bash', tool_use_id: 't', command: 'git status' })).toBeUndefined();
    expect(pushTarget({ tool: 'Read', tool_use_id: 't', file_path: '/r/a.ts' })).toBeUndefined();
  });
});

describe('3.40.0 (S4zl) brief push search', () => {
  it('returns the line naming the file and the lines under it up to the next file, from the newest brief only', () => {
    const root = rootWithBriefs('s1', [OLD_BRIEF, NEW_BRIEF]);
    const found = briefPush(root, 's1', { files: ['packages/app/test/r2-css-pill.test.ts'], text: 'import { readFileSync } from "node:fs";' }, { ranked: 0 });
    const numbers = found!.lines.map((line) => line.line);
    expect(numbers).toEqual([7, 8, 9]);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(found!.text).toContain('9: Literal pins (the gate greps each): `readFileSync`, `var(--line2)`, `var(--bg1)`.');
    expect(found!.text).not.toContain('r1-list');
  });

  it('finds a line by the selectors and names in the written text when no line names the file', () => {
    const root = rootWithBriefs('s2', [NEW_BRIEF]);
    const found = briefPush(root, 's2', { files: ['src/styles/other.css'], text: '.ck .mv-proj { height: 44px; }' });
    expect(found!.text).toContain('4: 2. src/styles/vault.css');
  });

  it('skips lines already shown, respects the caps and returns undefined with nothing new or no brief', () => {
    const root = rootWithBriefs('s3', [NEW_BRIEF]);
    const first = briefPush(root, 's3', { files: ['test/r2-css-pill.test.ts'], text: '' });
    const again = briefPush(root, 's3', { files: ['test/r2-css-pill.test.ts'], text: '' }, { shown: first!.lines.map((line) => line.line), ranked: 0 });
    expect(again).toBeUndefined();
    const small = briefPush(root, 's3', { files: ['test/r2-css-pill.test.ts'], text: '' }, { maxLines: 1 });
    expect(small!.lines).toHaveLength(1);
    expect(briefPush(mkdtempSync(path.join(os.tmpdir(), 'brief-push-')), 'none', { files: ['a.ts'], text: '' })).toBeUndefined();
  });

  it('answers a prompt by its words and ignores a too-short one', () => {
    const root = rootWithBriefs('s4', [NEW_BRIEF]);
    expect(briefPush(root, 's4', { prompt: 'which vitest command finishes the r2 task?' })!.text).toContain('pnpm --filter @acme/app exec vitest run test/r2');
    expect(briefPush(root, 's4', { prompt: 'ok' })).toBeUndefined();
  });

  it('builds the query from file name words, declared names, selectors and short strings', () => {
    const query = pushQuery({ files: ['test/r17-css-pill.test.ts'], text: 'describe("pill rules", () => {});\nconst rule = ".ck .mv-proj";\n.ck .mv-phead .mv-ib { }' });
    for (const term of ['r17-css-pill.test.ts', 'r17', 'pill', 'rule', '.ck .mv-phead .mv-ib', 'pill rules']) expect(query).toContain(term);
    expect(query.split(' ')).not.toContain('ts');
  });

  it('the script keeps per-brief state, so a line is pushed once until the state is reset', () => {
    const root = rootWithBriefs('s5', [NEW_BRIEF]);
    const state = path.join(mkdtempSync(path.join(os.tmpdir(), 'brief-push-state-')), BRIEF_PUSH_FILE);
    writeFileSync(state, BRIEF_PUSH_ARMED);
    const run = () => execFileSync('node', [fileURLToPath(new URL('../recall/brief-push.mjs', import.meta.url)), root, 's5', state], {
      input: JSON.stringify({ files: ['test/r2-css-pill.test.ts'], text: '' }), env: { ...process.env, EXO_BRIEF_PUSH_VECTORS: '0' }, encoding: 'utf8' });
    const first = parseBriefPush(run());
    expect(first!.text).toContain('Literal pins');
    expect(JSON.parse(readFileSync(state, 'utf8')).shown).toEqual(expect.arrayContaining([7, 8, 9]));
    expect(parseBriefPush(run())?.text ?? '').not.toContain('Literal pins');
    writeFileSync(state, BRIEF_PUSH_ARMED);
    expect(parseBriefPush(run())!.text).toContain('Literal pins');
  });
});

describe('3.40.0 (S4zl) brief push output', () => {
  it('parses the script output and rejects empty or broken output', () => {
    expect(parseBriefPush(JSON.stringify({ brief: 'a', path: '/b.md', lines: [{ line: 3, text: 'x' }], text: '3: x' }))?.text).toBe('3: x');
    for (const bad of ['null', '{', JSON.stringify({ path: '/b.md', lines: [], text: '' })]) expect(parseBriefPush(bad)).toBeUndefined();
  });

  it('names the files, the brief path, and says the lines apply now', () => {
    const note = renderBriefPush({ brief: 'a', path: '/r/briefs/a.md', lines: [{ line: 9, text: 'x' }], text: '9: x' }, { files: ['test/r2.test.ts'] });
    expect(note).toContain('for test/r2.test.ts, the file this call writes');
    expect(note).toContain('/r/briefs/a.md');
    expect(note).toContain('\n9: x\n');
    expect(note).toMatch(/They apply now/);
  });
});

type Handler = (host: unknown, event: unknown, next: (event?: unknown) => Promise<unknown>) => Promise<unknown>;

async function hooks(options: Record<string, unknown> = {}) {
  const { register } = await import('../compact.js');
  const on: Record<string, Handler> = {};
  register(((name: string, fn: Handler) => { on[name] = fn; return { catch: (caught: unknown) => { (on as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS, recallPluginRoot: '/plugin', ...options } as never);
  return on;
}

const FLAG = '/tmp/project/.exovault/s4-compact-active';
const FOUND = JSON.stringify({ brief: 'abc', path: '/r/briefs/abc.md', lines: [{ line: 77, text: 'Literal pins: `var(--line2)`' }], text: '77: Literal pins: `var(--line2)`' });

function host(state: string | null, stdout = FOUND) {
  const files = new Map<string, string>();
  const logs: string[] = [];
  const runs: { argv: string[]; stdin?: string }[] = [];
  return {
    files, logs, runs,
    session: { cwd: async () => '/tmp/project', id: async () => 's1', surfaces: async () => [] },
    fs: {
      exists: async (p: string) => p === FLAG || files.has(p) || (state !== null && p.endsWith(`/${BRIEF_PUSH_FILE}`)),
      read: async (p: string) => {
        if (files.has(p)) return files.get(p)!;
        if (state !== null && p.endsWith(`/${BRIEF_PUSH_FILE}`)) return state;
        throw new Error('ENOENT');
      },
      write: async (p: string, text: string) => { files.set(p, text); },
      list: async () => [],
    },
    env: { get: async (name: string) => (name === 'HOME' ? '/home/u' : undefined) },
    clock: { now: async () => 0, after: () => ({ cancel: () => {} }) },
    // 4.9.2 review: the capture guard's harden.mjs run is not recorded.
    process: { run: async (argv: string[], init?: { stdin?: string }) => { if (String(argv[1]).endsWith('/harden.mjs')) return { exitCode: 0, stdout: '', stderr: '' }; runs.push({ argv, stdin: init?.stdin }); return { exitCode: 0, stdout, stderr: '' }; } },
    ui: { log: (line: string) => { logs.push(line); } },
  };
}

const heredoc = { tool: 'Bash', tool_use_id: 't1', command: "cat > packages/app/test/r17-css-pill.test.ts <<'EOF'\nit('x', () => {});\nEOF" };

describe('3.40.0 (S4zl) PreToolUse and prompt hooks', () => {
  it('a write after a cut runs brief-push.mjs with the files and gets the lines as context', async () => {
    const h = host(BRIEF_PUSH_ARMED);
    const result = await (await hooks())['classic.PreToolUse']!(h, heredoc, async () => ({ additionalContext: ['other'] })) as { additionalContext?: string[] };
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]!.argv.slice(0, 2)).toEqual(['node', '/plugin/recall/brief-push.mjs']);
    expect(h.runs[0]!.argv.at(-1)).toMatch(new RegExp(`/${BRIEF_PUSH_FILE}$`));
    expect(JSON.parse(h.runs[0]!.stdin!).files).toEqual(['packages/app/test/r17-css-pill.test.ts']);
    expect(result.additionalContext).toHaveLength(2);
    expect(result.additionalContext![1]).toContain('77: Literal pins: `var(--line2)`');
    expect(h.logs).toContain('brief_push.fired=1 brief=abc lines=77 on=write');
  });

  it('passes the call unchanged before a cut, after a new brief, for a non-write, with the option off or on a failure', async () => {
    const cases: [string | null, Record<string, unknown>, Record<string, unknown>, string][] = [
      [null, heredoc, {}, FOUND],
      [BRIEF_PUSH_OFF, heredoc, {}, FOUND],
      [BRIEF_PUSH_ARMED, { tool: 'Bash', tool_use_id: 't2', command: 'pnpm test' }, {}, FOUND],
      [BRIEF_PUSH_ARMED, heredoc, { briefPush: false }, FOUND],
      [BRIEF_PUSH_ARMED, heredoc, {}, 'null'],
    ];
    for (const [state, call, options, stdout] of cases) {
      const h = host(state, stdout);
      const result = await (await hooks(options))['classic.PreToolUse']!(h, call, async () => ({})) as { additionalContext?: string[] };
      expect(result.additionalContext).toBeUndefined();
    }
  });

  it('a short prompt after a cut gets the lines as context; a new brief turns the push off', async () => {
    const h = host(BRIEF_PUSH_ARMED);
    let passed: { context?: string[] } = {};
    await (await hooks())['prompt.submit']!(h, { text: 'is the css test complete?', origin: { kind: 'composer' } }, async (e) => { passed = e as never; return e; });
    expect(JSON.parse(h.runs[0]!.stdin!)).toEqual({ prompt: 'is the css test complete?' });
    expect(passed.context?.[0]).toContain('for this message');
    const h2 = host(BRIEF_PUSH_ARMED);
    await (await hooks({ recallEnabled: true }))['prompt.submit']!(h2, { text: `Task 3 of 6.\n${'x '.repeat(1500)}`, origin: { kind: 'sdk' } }, async (e) => e);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([...h2.files.entries()].filter(([p]) => p.endsWith(`/${BRIEF_PUSH_FILE}`)).map(([, v]) => v)).toEqual([BRIEF_PUSH_OFF]);
  });

  it('a subagent hand-back after a cut is not a new brief: the push stays on and nothing is saved', async () => {
    const report = `<agent-message from="a1">\n[Subagent hand-back] The text below is the final report of a subagent.\n${'  line of the report\n'.repeat(200)}</agent-message>`;
    for (const origin of [{ kind: 'peer', handback: true }, { kind: 'peer' }]) {
      const h = host(BRIEF_PUSH_ARMED);
      await (await hooks({ recallEnabled: true }))['prompt.submit']!(h, { text: report, origin }, async (e) => e);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect([...h.files.keys()].filter((p) => p.endsWith(`/${BRIEF_PUSH_FILE}`))).toEqual([]);
      expect(h.runs.filter((run) => run.argv.some((arg) => arg.includes('brief.mjs')))).toEqual([]);
    }
  });

  // 4.1.0: with the task card on, the seed never shows the checklist (0 of 29 w61 cuts, 0 of 210 recorded seeds),
  // so the brief is saved without the `claude -p` call that wrote it (~$0.76 per 8-task chain).
  it('saves a brief with no checklist model while the task card is on, and with briefDigestModel when it is off', async () => {
    const saveModel = async (options: Record<string, unknown>) => {
      const h = host(null);
      await (await hooks({ recallEnabled: true, ...options }))['prompt.submit']!(h, { text: `Task 3 of 6.\n${'x '.repeat(1500)}`, origin: { kind: 'sdk' } }, async (e) => e);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const save = h.runs.find((run) => run.argv[1] === '/plugin/recall/brief.mjs');
      expect(save?.argv[2]).toBe('save');
      return save!.argv.at(-1);
    };
    expect(await saveModel({})).toBe('');
    expect(await saveModel({ briefDigestModel: 'opus' })).toBe('');
    expect(await saveModel({ taskCard: false })).toBe('sonnet');
    expect(await saveModel({ taskCard: false, briefDigestModel: 'haiku' })).toBe('haiku');
  });
});

const LIMIT_BRIEF = `${NEW_BRIEF}\nEvery new file is at most 260 lines and has no line over 160 characters.`;

function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'brief-limits-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args]);
  git('init', '-q');
  for (const [file, text] of Object.entries(files)) { execFileSync('mkdir', ['-p', path.dirname(path.join(repo, file))]); writeFileSync(path.join(repo, file), text); }
  git('add', '.');
  git('commit', '-qm', 'base');
  return repo;
}

describe('3.41.0 (S4zm) brief line-length limits after a write', () => {
  it('reads the limits a brief states, one per distinct maximum', () => {
    expect(briefLineLimits('a\nno line over 160 characters\nlines of at most 120 chars\nNo line over 160 characters.')).toEqual([{ line: 2, max: 160 }, { line: 3, max: 120 }]);
    expect(briefLineLimits('at most 260 lines\n160 characters wide')).toEqual([]);
  });

  it('flags only added lines over the limit: a diff hunk by its new line number, an untracked file whole', () => {
    const root = rootWithBriefs('s1', [LIMIT_BRIEF]);
    const repo = repoWith({ 'src/old.ts': `${'o'.repeat(150)}\nb\n` });
    writeFileSync(path.join(repo, 'src/old.ts'), `${'o'.repeat(150)}\nb\n${'x'.repeat(161)}\n`);
    execFileSync('mkdir', ['-p', path.join(repo, 'test')]);
    writeFileSync(path.join(repo, 'test/r2-pill.test.tsx'), `ok\n${'y'.repeat(160)}\n${'z'.repeat(300)}\n`);
    const warnings = limitWarnings(root, 's1', path.join(repo, 'test'), ['src/old.ts', 'r2-pill.test.tsx']);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^src\/old\.ts: 1 added line over 160 characters, .* line 3 \(161\)\.$/);
    expect(warnings[1]).toMatch(/^test\/r2-pill\.test\.tsx: 1 added line over 160 characters, .* line 3 \(300\)\.$/);
  });

  it('leaves a tracked file alone when it already had a line over the limit before the call', () => {
    const root = rootWithBriefs('s1', [LIMIT_BRIEF]);
    const repo = repoWith({ 'wide.css': `${'w'.repeat(200)}\n`, 'narrow.css': 'a\n' });
    writeFileSync(path.join(repo, 'wide.css'), `${'w'.repeat(200)}\n${'x'.repeat(272)}\n`);
    writeFileSync(path.join(repo, 'narrow.css'), `a\n${'x'.repeat(272)}\n`);
    expect(limitWarnings(root, 's1', repo, ['wide.css', 'narrow.css'])).toEqual([expect.stringMatching(/^narrow\.css: 1 added line over 160/)]);
  });

  it('says nothing for a clean write, a file the call did not write, no limit, no brief or no repo', () => {
    const repo = repoWith({ 'a.ts': 'a\n' });
    writeFileSync(path.join(repo, 'a.ts'), `a\n${'x'.repeat(170)}\n`);
    const root = rootWithBriefs('s1', [LIMIT_BRIEF]);
    expect(limitWarnings(root, 's1', repo, ['b.ts'])).toEqual([]);
    expect(limitWarnings(rootWithBriefs('s1', [NEW_BRIEF]), 's1', repo, ['a.ts'])).toEqual([]);
    expect(limitWarnings(root, 'other', repo, ['a.ts'])).toEqual([]);
    expect(limitWarnings(root, 's1', mkdtempSync(path.join(os.tmpdir(), 'no-repo-')), ['a.ts'])).toEqual([]);
    writeFileSync(path.join(repo, 'a.ts'), `a\n${'x'.repeat(160)}\n`);
    expect(limitWarnings(root, 's1', repo, ['a.ts'])).toEqual([]);
  });

  it('parses the script output and renders a note that says to shorten the lines', () => {
    expect(parseBriefLimits('["a.ts: 1 added line over 160 characters."]')).toEqual(['a.ts: 1 added line over 160 characters.']);
    expect(parseBriefLimits('null')).toEqual([]);
    expect(parseBriefLimits('{"a":1}')).toEqual([]);
    expect(renderBriefLimits(['a.ts: x.'])).toMatch(/^Limit check after this write: a\.ts: x\.\nShorten those lines now/);
  });

  it('a PostToolUse write runs the limits script and adds the note only when a limit is broken', async () => {
    const post = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: heredoc.command }, tool_response: {}, tool_use_id: 't1' };
    const h = host(null, '["packages/app/test/r17-css-pill.test.ts: 1 added line over 160 characters."]');
    const result = await (await hooks({ recallEnabled: true }))['classic.PostToolUse']!(h, post, async () => ({ additionalContext: ['other'] })) as { additionalContext?: string[] };
    expect(h.runs[0]!.argv).toEqual(['node', '/plugin/recall/brief-push.mjs', 'limits', '/home/u/.claude/exovault/recall', 's1', '/tmp/project']);
    expect(JSON.parse(h.runs[0]!.stdin!)).toEqual({ files: ['packages/app/test/r17-css-pill.test.ts'] });
    expect(result.additionalContext).toHaveLength(2);
    expect(result.additionalContext![1]).toMatch(/^Limit check after this write: packages/);
    expect(h.logs).toContain('brief_limits.fired=1 files=1');
  });

  it('adds nothing for a clean write, a non-write, recall off or the option off', async () => {
    const post = (tool_name: string, tool_input: Record<string, unknown>) => ({ hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response: {}, tool_use_id: 't1' });
    const cases: [Record<string, unknown>, ReturnType<typeof post>, string, number][] = [
      [{ recallEnabled: true }, post('Write', { file_path: '/tmp/project/a.ts', content: 'x' }), '[]', 1],
      [{ recallEnabled: true }, post('Bash', { command: 'pnpm test' }), '["x"]', 0],
      [{}, post('Write', { file_path: '/tmp/project/a.ts', content: 'x' }), '["x"]', 0],
      [{ recallEnabled: true, briefLimits: false }, post('Write', { file_path: '/tmp/project/a.ts', content: 'x' }), '["x"]', 0],
    ];
    for (const [options, input, stdout, runs] of cases) {
      const h = host(null, stdout);
      const result = await (await hooks(options))['classic.PostToolUse']!(h, input, async () => ({})) as { additionalContext?: string[] };
      expect(result.additionalContext).toBeUndefined();
      expect(h.runs).toHaveLength(runs);
    }
  });
});
