import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../core/budgets.js';
import { renderSeed } from '../core/seed.js';
import { extractStateUpdates, renderStateUpdates, STATE_UPDATES_BUDGET_TOKENS } from '../core/state-updates.js';

const chars4 = (text: string) => Math.ceil(text.length / 4);

describe('current values (3.43.0, CONTRACT S4zo)', () => {
  it('keeps only the newest value per subject, with how many times it changed', () => {
    const updates = extractStateUpdates(['Set ledger to 6 replicas. Table version is now 11.', 'Rollout change: set ledger to 2 replicas. Table version is now 12.']);
    expect(updates.map((u) => [u.subject, u.value, u.updates, u.seq])).toEqual([['ledger', '2 replicas', 2, 2], ['Table version', '12', 2, 2]]);
    const body = renderStateUpdates(updates, chars4);
    expect(body).toContain('- ledger: 2 replicas (changed 2 times; this is the newest)');
    expect(body).not.toContain('6 replicas');
  });

  it('reads "from A to B", several updates in one sentence, and Polish', () => {
    const updates = extractStateUpdates(['Change the default port from 3000 to 8080 and bump the plugin version to 3.43.0.', 'zmień timeout na 30 s, limit jest teraz 5 zadań']);
    expect(Object.fromEntries(updates.map((u) => [u.subject, u.value]))).toEqual({ 'default port': '8080', 'plugin version': '3.43.0', timeout: '30 s', limit: '5 zadań' });
  });

  it('counts a resent update once, and drops a "Label:" prefix from the subject', () => {
    const updates = extractStateUpdates(['set ledger to 6 replicas.', 'set ledger to 6 replicas.', 'Correction: the flag guarding the audit rewrite is now ff_delta_80.']);
    expect(updates.map((u) => [u.subject, u.value, u.updates])).toEqual([['ledger', '6 replicas', 1], ['flag guarding the audit rewrite', 'ff_delta_80', 1]]);
  });

  it('drops leading conjunctions from the subject', () => {
    expect(extractStateUpdates(['ale sonnet jest teraz tani', 'and the limit is now 5.']).map((u) => u.subject)).toEqual(['sonnet', 'limit']);
  });

  it('ignores phrasal verbs, pronouns, questions and quoted lines', () => {
    expect(extractStateUpdates(['ok set up the repo and move on to the tests, it is now done', 'This is now fixed.', 'Can you set the flag to true?', '> set quoted to 9 replicas.'])).toEqual([]);
  });

  it('lists the newest change first and cuts at whole lines to the budget', () => {
    const texts = Array.from({ length: 200 }, (_, i) => `set service-${i} to ${i} replicas.`);
    const body = renderStateUpdates(extractStateUpdates(texts), chars4);
    expect(body.split('\n')[0]).toBe('- service-199: 199 replicas');
    expect(chars4(body)).toBeLessThanOrEqual(STATE_UPDATES_BUDGET_TOKENS);
    expect(body.split('\n').every((line) => /^- service-\d+: \d+ replicas$/.test(line))).toBe(true);
  });

  it('renders as its own seed section, and none when empty', () => {
    const base = { constraints: '', contract: '', todo: '', userInstructionsVerbatim: [], values: '', selectedReasoning: '', gatesAndErrors: '', filePointers: '' };
    expect(renderSeed({ ...base, currentValues: '- ledger: 2 replicas' }, 0, 6000, chars4).message.text).toContain('## Current values (newest value of each thing the user changed; earlier values are replaced)\n- ledger: 2 replicas');
    expect(renderSeed(base, 0, 6000, chars4).message.text).not.toContain('## Current values');
  });
});

describe('tail token estimate (3.43.0)', () => {
  it('costs prose like chars / 4 and never less', () => {
    const prose = 'The deploy finished without errors and the team agreed to ship the change on Monday morning. '.repeat(20);
    expect(estimateTokens(prose)).toBe(chars4(prose));
    expect(estimateTokens('')).toBe(0);
  });

  it('costs logs, hex ids and JSON up to chars / 2', () => {
    const log = Array.from({ length: 50 }, (_, i) => `2026-10-02T18:${String(i).padStart(2, '0')}:07Z id=${(i * 2654435761).toString(16)} {"ok":true,"n":${i}}`).join('\n');
    expect(estimateTokens(log)).toBeGreaterThan(chars4(log) * 1.6);
    expect(estimateTokens(log)).toBeLessThanOrEqual(Math.ceil(log.length / 2));
  });
});
