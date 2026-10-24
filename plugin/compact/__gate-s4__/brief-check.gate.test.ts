import { LEGACY_OPTIONS } from './fixtures/helpers.js';
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BRIEF_CHECK_FILE, parseBriefCheck, renderBriefCheckReason } from '../core/brief-check.js';
import { briefCheck } from '../recall/brief-check.mjs';
import { briefLines } from '../recall/brief-search.mjs';
import { saveBrief } from '../recall/brief.mjs';

const OLD_BRIEF = [
  'Task 1 of 2. Build the list view.',
  '## Tests',
  '- test/r1-list.test.tsx (at least 4): renders the rows in order.',
].join('\n');
const LITERALS = `Literal strings the gate greps for: ${Array.from({ length: 60 }, (_, i) => `\`literalName${i}\``).join(', ')}, \`aria-label="Project"\`.`;
const NEW_BRIEF = [
  'Task 2 of 2. Build the project pill.',
  '## Files',
  '1. src/ui/project-pill.tsx (new, at most 60 lines): exports `ProjectPill`.',
  '## Tests',
  '- test/r2-pill.test.tsx (at least 5): renders the select with the routed project.',
  LITERALS,
  '## Done when',
  '- pnpm --filter @acme/app exec vitest run test/r2 passes and the build is green.',
  '- Frozen: everything outside packages/app; do not change packages/api.',
].join('\n');

function rootWithBriefs(session: string, briefs: string[]): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'brief-check-'));
  briefs.forEach((text, i) => saveBrief(root, session, text, new Date(Date.UTC(2026, 9, 2, 8, i))));
  return root;
}

describe('3.37.0 (S4zj) brief check search', () => {
  it('returns whole lines of the newest brief only, in brief order, with their line numbers', () => {
    const found = briefCheck(rootWithBriefs('s1', [OLD_BRIEF, NEW_BRIEF]), 's1', { fullMaxChars: 0 });
    expect(found?.path).toMatch(/briefs[\\/][0-9a-f]{12}\.md$/);
    const numbers = found!.lines.map((line) => line.line);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(found!.text).not.toContain('r1-list');
    expect(found!.text).toContain('3: 1. src/ui/project-pill.tsx');
    expect(found!.text).toContain('5: - test/r2-pill.test.tsx (at least 5)');
    expect(found!.text).toContain('9: - Frozen: everything outside packages/app');
  });

  it('prints a line over the split size whole, so its last part is there too', () => {
    expect(LITERALS.length).toBeGreaterThan(900);
    const found = briefCheck(rootWithBriefs('s2', [NEW_BRIEF]), 's2', { fullMaxChars: 0 });
    const literal = found!.lines.find((line) => line.line === 6);
    expect(literal?.text).toBe(LITERALS);
  });

  it('keeps the total under the cap and returns undefined without a brief', () => {
    const found = briefCheck(rootWithBriefs('s3', [NEW_BRIEF]), 's3', { maxChars: 400, fullMaxChars: 0 });
    expect(found!.lines.reduce((sum, line) => sum + line.text.length, 0)).toBeLessThanOrEqual(400);
    expect(found!.text).not.toContain('Literal strings');
    expect(briefCheck(mkdtempSync(path.join(os.tmpdir(), 'brief-check-')), 'none')).toBeUndefined();
  });

  it('returns the whole newest brief when it fits the full cap', () => {
    const found = briefCheck(rootWithBriefs('s4', [OLD_BRIEF, NEW_BRIEF]), 's4');
    expect(found?.whole).toBe(true);
    expect(found!.lines.map((line) => line.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(found!.text).not.toContain('r1-list');
  });

  it('fills the room the questions leave with the lines that have the most code spans', () => {
    const prose = 'Goal: the dialog shows the size, then the dimensions, then the pages, for every file in the list.';
    const dense = '- D5 The layer gains `entries={visible}`, the props gain `entries?: MemoryEntry[]` and `entries = []`.';
    const found = briefCheck(rootWithBriefs('s5', [[NEW_BRIEF, '## Goal', prose, dense].join('\n')]), 's5', { fullMaxChars: 0 });
    expect(found!.text).toContain('entries={visible}');
  });

  it('briefLines joins an indented continuation and keeps headings as their own items', () => {
    expect(briefLines('## A\n- one\n  more\n- two')).toEqual([
      { line: 1, body: '## A', heading: '' },
      { line: 2, body: '- one\nmore', heading: 'A' },
      { line: 4, body: '- two', heading: 'A' },
    ]);
  });
});

describe('3.37.0 (S4zj) brief check output', () => {
  it('parses the script output and rejects empty or broken output', () => {
    const json = JSON.stringify({ brief: 'abc', path: '/x/b.md', lines: [{ line: 3, text: 'a' }], text: '3: a' });
    expect(parseBriefCheck(json)?.text).toBe('3: a');
    expect(parseBriefCheck('null')).toBeUndefined();
    expect(parseBriefCheck('{')).toBeUndefined();
    expect(parseBriefCheck(JSON.stringify({ path: '/x', text: '', lines: [] }))).toBeUndefined();
  });

  // 3.44.0: w60d lost 11 report-rule checks when the old "finish with one sentence" became the final report.
  it('names the brief path, asks for a check against each line and for the full final report again', () => {
    const reason = renderBriefCheckReason({ brief: 'abc', path: '/x/b.md', whole: false, lines: [{ line: 3, text: 'a' }], text: '3: a' });
    expect(reason).toContain('/x/b.md');
    expect(reason).toContain('\n3: a\n');
    expect(reason).toMatch(/grep every one of them in that file/);
    expect(reason).toMatch(/write that form: code that does the same thing in other words does not satisfy the line/);
    expect(reason).toMatch(/write your final report again, in full, as your last message/);
    expect(reason).not.toMatch(/one sentence/);
    expect(renderBriefCheckReason({ brief: 'abc', path: '/x/b.md', whole: true, lines: [{ line: 3, text: 'a' }], text: '3: a' })).toMatch(/Here it is in full, from \/x\/b\.md/);
  });
});

type Handler = (host: unknown, event: unknown, next: (event?: unknown) => Promise<unknown>) => Promise<unknown>;

async function stopHook(options: Record<string, unknown> = {}) {
  const { register } = await import('../compact.js');
  const on: Record<string, Handler> = {};
  register(((name: string, fn: Handler) => { on[name] = fn; return { catch: (caught: unknown) => { (on as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS, recallPluginRoot: '/plugin', ...options } as never);
  return on['classic.Stop']!;
}

const FLAG = '/tmp/project/.exovault/s4-compact-active';
const FOUND = JSON.stringify({ brief: 'abc', path: '/r/briefs/abc.md', whole: false, lines: [{ line: 77, text: 'Literal strings: `x`' }], text: '77: Literal strings: `x`' });

function host(flag: string | null) {
  const files = new Map<string, string>();
  const logs: string[] = [];
  const runs: string[][] = [];
  return {
    files, logs, runs,
    session: { cwd: async () => '/tmp/project', id: async () => 's1' },
    fs: {
      exists: async (p: string) => p === FLAG || files.has(p) || (flag !== null && p.endsWith(`/${BRIEF_CHECK_FILE}`)),
      read: async (p: string) => {
        if (files.has(p)) return files.get(p)!;
        if (flag !== null && p.endsWith(`/${BRIEF_CHECK_FILE}`)) return flag;
        throw new Error('ENOENT');
      },
      write: async (p: string, text: string) => { files.set(p, text); },
      list: async () => [],
    },
    env: { get: async (name: string) => (name === 'HOME' ? '/home/u' : undefined) },
    process: { run: async (argv: string[]) => { runs.push(argv); return { exitCode: 0, stdout: '', stderr: '' }; } },
    ui: { log: (line: string) => { logs.push(line); } },
  };
}

const stop = { hook_event_name: 'Stop', session_id: 's1', transcript_path: '/t.jsonl', cwd: '/tmp/project', stop_hook_active: false };
const pass = async () => ({});
const flagWrites = (h: ReturnType<typeof host>) => [...h.files.entries()].filter(([p]) => p.endsWith(`/${BRIEF_CHECK_FILE}`)).map(([, v]) => v);

describe('3.37.0 (S4zj) Stop hook', () => {
  it('blocks the first stop after a cut with the lines the cut found, then marks the check done', async () => {
    const h = host(FOUND);
    const result = await (await stopHook())(h, stop, pass) as { block?: string };
    expect(result.block).toContain('77: Literal strings: `x`');
    expect(result.block).toContain('/r/briefs/abc.md');
    expect(flagWrites(h)).toEqual(['done']);
    expect(h.logs).toContain('brief_check.fired=1 brief=abc lines=1');
    expect(h.runs).toEqual([]);
  });

  it('passes through without a flag, after the check, in a subagent or on a continued stop', async () => {
    for (const [flag, event] of [
      [null, stop],
      ['done', stop],
      [FOUND, { ...stop, stop_hook_active: true }],
      [FOUND, { ...stop, agent_id: 'a1' }],
    ] as const) {
      const h = host(flag);
      const result = await (await stopHook())(h, event, pass) as { block?: string };
      expect(result.block).toBeUndefined();
      expect(flagWrites(h)).toEqual([]);
    }
  });

  it('marks the check done and passes through while the search runs or when it found nothing', async () => {
    for (const [flag, reason] of [['armed', 'not_ready'], ['empty', 'no_lines'], ['{broken', 'no_lines']] as const) {
      const h = host(flag);
      const result = await (await stopHook())(h, stop, pass) as { block?: string };
      expect(result.block).toBeUndefined();
      expect(flagWrites(h)).toEqual(['done']);
      expect(h.logs).toContain(`brief_check.fired=0 reason=${reason}`);
    }
  });
});
