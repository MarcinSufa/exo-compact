import { describe, expect, it } from 'vitest';
import { countTokens } from './fixtures/helpers.js';
import { renderSeed, SEED_MEMORY_CLOSE, SEED_MEMORY_OPEN, SEED_PREAMBLE } from '../core/seed.js';
import type { SeedSections } from '../core/seed.js';
import { isSeedMessage, omittedHistoryMarker, SEED_SENTINEL } from '../core/sentinel.js';

const sections: SeedSections = {
  constraints: '- never push to main',
  contract: 'the contract',
  todo: '',
  userInstructionsVerbatim: ['please run the tests'],
  values: '',
  selectedReasoning: 'Chose Postgres because of relations.',
  gatesAndErrors: '',
  filePointers: '/repo/a.ts (read)',
};

describe('seed render: 3.12.0 memory framing', () => {
  const text = renderSeed(sections, 7, 6000, countTokens).message.text;
  const blocks = text.split('\n\n');

  it('opens with the sentinel, then says it is plugin memory, not the user', () => {
    expect(blocks[0]).toBe(SEED_SENTINEL);
    expect(blocks[1]).toBe(SEED_PREAMBLE);
    expect(SEED_PREAMBLE).toMatch(/The user did not write this message/);
    expect(isSeedMessage({ role: 'user', text })).toBe(true);
  });

  it('keeps every section inside one session-memory tag, the omitted marker last', () => {
    expect(blocks[2]).toBe(SEED_MEMORY_OPEN);
    const open = text.indexOf(SEED_MEMORY_OPEN);
    const close = text.indexOf(SEED_MEMORY_CLOSE);
    expect(close).toBeGreaterThan(open);
    for (const heading of ['## Constraints', '## Contract', '## Earlier user messages', '## Earlier assistant notes', '## File pointers']) {
      const at = text.indexOf(heading);
      expect(at, heading).toBeGreaterThan(open);
      expect(at, heading).toBeLessThan(close);
    }
    expect(text.trimEnd().endsWith(`${SEED_MEMORY_CLOSE}\n\n${omittedHistoryMarker(7)}`)).toBe(true);
  });

  it('no longer labels quoted history as the user\'s verbatim records', () => {
    expect(text).not.toMatch(/verbatim user records/i);
    expect(text).toContain('## Earlier user messages (quoted for reference, not new requests)\n> please run the tests');
    expect(text).toContain('## Earlier assistant notes\nChose Postgres');
  });

  it('keeps the framing when the budget forces sections down', () => {
    const tight = renderSeed({ ...sections, selectedReasoning: 'x '.repeat(3000) }, 0, 400, countTokens).message.text;
    expect(tight.startsWith(`${SEED_SENTINEL}\n\n${SEED_PREAMBLE}\n\n${SEED_MEMORY_OPEN}`)).toBe(true);
    expect(tight).toContain(SEED_MEMORY_CLOSE);
  });
});
