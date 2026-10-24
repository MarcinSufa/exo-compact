import { describe, it, expect } from 'vitest';
import { findTranscriptPath } from '../host/transcript-path.js';
import { extractConstraints, isQuestion } from '../core/constraints.js';
import { GATES_AND_ERRORS_MAX_ENTRIES, renderGatesAndErrors } from '../core/seed.js';
import { sha256 } from './fixtures/helpers.js';

describe('S4i: fixes from the live cut (2026-09-28)', () => {
  const host = (cwd: string) => ({ cwd: async () => cwd, home: async () => '/h' });
  const fs = (files: string[]) => ({
    exists: async (path: string) => files.includes(path),
    list: async (path: string) => [...new Set(files.filter((f) => f.startsWith(`${path}/`)).map((f) => f.slice(path.length + 1).split('/')[0]))].map((name) => ({ name, kind: 'dir' })),
  });

  it('finds the transcript after the session cd-ed into another project', async () => {
    const real = '/h/.claude/projects/-h/s1.jsonl';
    expect(await findTranscriptPath(host('/h/work/voice'), 's1', fs([real, '/h/.claude/projects/-h-work/other.jsonl']))).toBe(real);
    expect(await findTranscriptPath(host('/h'), 's1', fs([real]))).toBe(real);
    expect(await findTranscriptPath(host('/h/x'), 'nope', fs([real]))).toBeNull();
  });

  it('fails closed when listing throws', async () => {
    expect(await findTranscriptPath(host('/h/x'), 's1', { exists: async () => false, list: async () => { throw new Error('EACCES'); } })).toBeNull();
  });

  it('a question is not a constraint, a rule with the same marker still is', () => {
    expect(isQuestion('no tak ale normalnie to chyba będzie dzialać bez serwera ?')).toBe(true);
    expect(isQuestion('czy mozesz to zrobić bez serwera')).toBe(true);
    expect(isQuestion('Rób to bez serwera.')).toBe(false);
    const record = (text: string) => ({ kind: 'user', origin: 'reconcile', producedBy: 's4-capture', sourceHash: sha256(text), body: { text } }) as never;
    const kept = extractConstraints([record('no tak ale to będzie dzialać bez serwera, na laptopie albo w telefonie ?'), record('Nigdy nie commituj bez testów.')], sha256);
    expect(kept.map((c) => c.text)).toEqual(['Nigdy nie commituj bez testów.']);
  });

  it('Gates and errors shows only the newest few, one capped line each', () => {
    const errors = Array.from({ length: 6 }, (_, i) => ({ kind: 'error', body: { text: `Exit code ${i}\n${'x'.repeat(i === 5 ? 1000 : 10)}` } }));
    const lines = renderGatesAndErrors([{ kind: 'user', body: { text: 'hi' } }, ...errors]).split('\n');
    expect(lines).toHaveLength(GATES_AND_ERRORS_MAX_ENTRIES);
    expect(lines[0]).toBe(`error: Exit code 3 ${'x'.repeat(10)}`);
    expect(lines[2].length).toBeLessThanOrEqual('error: '.length + 300);
    expect(renderGatesAndErrors([])).toBe('');
  });
});
