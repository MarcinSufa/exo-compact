import { describe, it, expect } from 'vitest';
import { bashFileReads } from '../core/file-pointers.js';
import { isQuestion, extractConstraints } from '../core/constraints.js';
import { collectFullIds, expandShortIds } from '../core/id-expansion.js';
import { renderSeed, renderGatesAndErrors, type SeedSections } from '../core/seed.js';
import { findTranscriptPath } from '../host/transcript-path.js';
import { countTokens, sha256 } from './fixtures/helpers.js';

describe('Opus review of 3.8-3.10, round 1', () => {
  it('1: commit messages, echo text and heredoc bodies are not file reads', () => {
    expect(bashFileReads('git commit -m "fix tail handling in seed.ts"')).toEqual([]);
    expect(bashFileReads("echo 'cat notes.md'")).toEqual([]);
    expect(bashFileReads("cat > x.ts <<'EOF'\n// head of list.ts\ncat y.md\nEOF\ncat z.md")).toEqual([['z.md', undefined]]);
  });

  it('2: pattern sed and head -c are partial, cd applies in order', () => {
    expect(bashFileReads("sed -n '/foo/p' a.ts")).toEqual([['a.ts', 'partial']]);
    expect(bashFileReads('head -c 100 a.bin')).toEqual([['a.bin', 'partial']]);
    expect(bashFileReads('cd a && cat x.ts; cd ../b && cat y.ts; cd /abs && head -5 z.ts')).toEqual([
      ['a/x.ts', undefined], ['a/../b/y.ts', undefined], ['/abs/z.ts', '1-5'],
    ]);
  });

  it('3: tag questions keep the rule; questions do not revoke', () => {
    expect(isQuestion("Don't push to main without tests, okay?")).toBe(false);
    expect(isQuestion('Nie pushuj bez testów, ok?')).toBe(false);
    expect(isQuestion('Czy to działa bez serwera?')).toBe(true);
    const record = (text: string) => ({ kind: 'user', origin: 'reconcile', producedBy: 's4-capture', sourceHash: sha256(text), body: { text } }) as never;
    const kept = extractConstraints([record('Nigdy nie pushuj na main bez testów.'), record('Czy już nie pushujemy na main bez testów?')], sha256);
    expect(kept.map((c) => c.text)).toEqual(['Nigdy nie pushuj na main bez testów.']);
  });

  it('4: findTranscriptPath with no HOME, and non-dir entries skipped', async () => {
    const fs = { exists: async (p: string) => p === '/h/.claude/projects/-h/s.jsonl', list: async () => [{ name: 'x.jsonl', kind: 'file' }, { name: '-h', kind: 'dir' }] };
    expect(await findTranscriptPath({ cwd: async () => '/h/y', home: async () => undefined }, 's', fs)).toBeNull();
    expect(await findTranscriptPath({ cwd: async () => '/h/y', home: async () => '/h' }, 's', fs)).toBe('/h/.claude/projects/-h/s.jsonl');
  });

  it('5: expandShortIds stays fast on hex-heavy input', () => {
    const hex = (n: number, len: number) => (n * 2654435761 % 2 ** 32).toString(16).padStart(8, '0').repeat(5).slice(0, len);
    const fulls = Array.from({ length: 20000 }, (_, i) => `${hex(i + 1, 8)}-3d93-428b-b8e3-${hex(i + 7, 12)}`);
    const text = Array.from({ length: 20000 }, (_, i) => `a${hex(i + 99991, 7)}`.slice(0, 8)).join(' ');
    const started = performance.now();
    expandShortIds(text, collectFullIds(fulls));
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('8: capped error lines never split a surrogate pair; line sections are trimmed at a line end', () => {
    const line = renderGatesAndErrors([{ kind: 'error', body: { text: '😀'.repeat(400) } }]);
    expect(line.endsWith('…')).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(line)).toBe(false);
    const base: SeedSections = { constraints: '', contract: '', todo: '', userInstructionsVerbatim: [], values: '', selectedReasoning: '', gatesAndErrors: '', filePointers: Array.from({ length: 400 }, (_, i) => `/r/f${i}.ts (read 1-${i})`).join('\n') };
    const text = renderSeed(base, 0, 600, countTokens).message.text;
    const pointers = text.split('## File pointers\n')[1].split('\n\n')[0].split('\n');
    for (const entry of pointers.filter((l) => l !== '(none)')) expect(entry).toMatch(/^\/r\/f\d+\.ts \(read 1-\d+\)$/);
  });

  it('9: a near-full seed with IDs stays within budget', () => {
    const base: SeedSections = { constraints: 'rule '.repeat(1500), keyFacts: 'fact '.repeat(1100), contract: 'c '.repeat(2000), todo: '', userInstructionsVerbatim: ['u '.repeat(2000)], values: '', selectedReasoning: 'r '.repeat(2000), gatesAndErrors: '', filePointers: '', ids: Array.from({ length: 20 }, (_, i) => `abc${i}def = abc${i}def-3d93-428b-b8e3-dd92b32ed182`).join('\n') };
    const rendered = renderSeed(base, 0, 6000, countTokens);
    expect(rendered.tokens).toBeLessThanOrEqual(6000);
    expect(rendered.message.text).toContain('## IDs (short = full)');
  });
});

describe('Opus review of 3.8-3.10, round 2', () => {
  it('redirect targets are not reads; input redirects are', () => {
    expect(bashFileReads("cat > x.ts <<'EOF'\nbody\nEOF")).toEqual([]);
    expect(bashFileReads('cat <<EOF > out.ts\nbody\nEOF')).toEqual([]);
    expect(bashFileReads('cat a.ts > b.md; cat a.ts >> b.ts; cat a.ts 2> e.txt; cat a.ts &> f.txt')).toEqual([
      ['a.ts', undefined], ['a.ts', undefined], ['a.ts', undefined], ['a.ts', undefined],
    ]);
    expect(bashFileReads('cat < in.json')).toEqual([['in.json', undefined]]);
  });

  it('head -nN / --lines, subshell cd, cd -', () => {
    expect(bashFileReads('head -n5 a.ts; head --lines=7 b.ts; head -n 3 c.ts')).toEqual([['a.ts', '1-5'], ['b.ts', '1-7'], ['c.ts', '1-3']]);
    expect(bashFileReads('(cd sub && cat x.ts); cat y.ts')).toEqual([['sub/x.ts', undefined], ['y.ts', undefined]]);
    expect(bashFileReads('cd a && cd - && cat z.ts')).toEqual([['z.ts', undefined]]);
  });

  it('tag stripping needs a comma and a sentence that does not open as a question', () => {
    for (const q of ['Should this fire without a webhook?', 'Can we run it without the ebook?', 'Is that ok?', 'Should I push without tests, or is that not ok?', 'Does this work without Docker, right?']) {
      expect(isQuestion(q)).toBe(true);
    }
    expect(isQuestion('Never push without tests, right?')).toBe(false);
  });

  it('a line section trimmed to nothing says (truncated), a cut on a newline keeps the whole line', () => {
    const base: SeedSections = { constraints: '', contract: '', todo: '', userInstructionsVerbatim: [], values: '', selectedReasoning: '', gatesAndErrors: `error: ${'x'.repeat(400)}`, filePointers: '' };
    // 3.12.0: budget from the empty seed's own floor, since the memory framing grew the fixed part.
    // 3.13.0: an empty section is left out, so the floor keeps the heading with a one-char body.
    const floor = renderSeed({ ...base, gatesAndErrors: 'e' }, 0, 100000, countTokens).tokens;
    const text = renderSeed(base, 0, floor + 2, countTokens).message.text;
    expect(text).toContain('## Gates and errors\n(truncated)');
  });
});

describe('Opus review of 3.8-3.10, round 3', () => {
  it('cat -n and nl keep their file', () => {
    expect(bashFileReads('cat -n a.ts')).toEqual([['a.ts', undefined]]);
    expect(bashFileReads('cat -n src/a.ts b.ts')).toEqual([['src/a.ts', undefined], ['b.ts', undefined]]);
    expect(bashFileReads('tail -n 20 c.ts')).toEqual([['c.ts', 'tail']]);
    expect(bashFileReads("grep x <<< 'EOF'\ncat d.ts")).toEqual([['d.ts', undefined]]);
  });

  it('imperative rules with a tag stay rules; auxiliary + subject stays a question', () => {
    for (const rule of ['Do not push to main, ok?', 'Do run the tests before pushing, ok?', 'Must use pnpm, ok?', 'Do it without tests, ok?', 'Do this only on main, ok?', 'Do the migration without downtime, ok?']) expect(isQuestion(rule)).toBe(false);
    for (const q of ['Does this work without Docker, right?', 'Do we push without tests, ok?', 'Is that ok?']) expect(isQuestion(q)).toBe(true);
  });

  it('(truncated) never pushes the seed over budget', () => {
    const empty: SeedSections = { constraints: '', contract: '', todo: '', userInstructionsVerbatim: [], values: '', selectedReasoning: '', gatesAndErrors: '', filePointers: '/a/b.ts (read)' };
    const floor = renderSeed(empty, 0, 100000, countTokens).tokens;
    let marked = 0;
    for (let budget = floor; budget <= floor + 150; budget += 1) {
      const rendered = renderSeed({ ...empty, gatesAndErrors: `error: ${'x'.repeat(400)}` }, 0, budget, countTokens);
      expect(rendered.tokens).toBeLessThanOrEqual(budget);
      if (rendered.message.text.includes('## Gates and errors\n(truncated)')) marked += 1;
    }
    expect(marked).toBeGreaterThan(0);
  });
});
