import { describe, expect, it } from 'vitest';
import { buildDenseJevRequests, DENSE_JEV_NOTICE, DENSE_JEV_QUESTION, denseJevQuery, parseDenseJevAnswers } from '../core/dense-jev.js';
import { sha256 } from '../core/sha256.js';

const countTokens = (text: string): number => Math.ceil(text.length / 4);

describe('S4r dense Jev request construction', () => {
  it('builds the replay query from the last three capped user messages and tail', () => {
    expect(denseJevQuery('x'.repeat(24001), ['old', 'u1', 'u2', 'z'.repeat(1001)])).toBe(`Last user messages:\n- u1\n- u2\n- ${'z'.repeat(1000)}\n\nMost recent work (tail of the session):\n${'x'.repeat(24000)}`);
  });

  it('splits under both limits, includes every note once, and uses the fixed Noul wording', () => {
    const candidates = Array.from({ length: 7 }, (_, i) => ({ text: `candidate-${i} src/a${i}.ts --mode-${i}`, source: 't' as const, recency: 1, order: i }));
    const requests = buildDenseJevRequests('current work', candidates, 'jev-latest', { perRequest: 3, maxRequestTokens: 1000, countTokens, hash: (text) => `${text}0000000000000000` });
    expect(requests.every(({ body, keys }) => keys.length <= 3 && countTokens(JSON.stringify(body)) <= 1000)).toBe(true);
    expect(requests.flatMap(({ body }) => Object.values(body.questions).map((question) => question.instructions.note))).toEqual(candidates.map(({ text }) => text));
    expect(requests[0].body.state.notice).toBe(DENSE_JEV_NOTICE);
    expect(Object.values(requests[0].body.questions)[0].instructions.question).toBe(DENSE_JEV_QUESTION);
  });

  it('accepts only finite probabilities in range and retains choice client parsing separately', () => {
    expect(parseDenseJevAnswers({ n0: { noul: 0 }, n1: { noul: 1 }, n2: { noul: 1.01 }, n3: { noul: NaN }, n4: { type: 'choice', choice: 'drop' } }, ['a', 'b', 'c', 'd', 'e'])).toEqual(new Map([['a', 0], ['b', 1]]));
    expect(sha256('x')).toHaveLength(64);
  });
});
