import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Every `key=` that a notice or log call of the plugin spells in a string or template literal. */
function loggedKeys(source: string): string[] {
  const keys: string[] = [];
  for (const call of source.matchAll(/(?:notice|host\.log|\blog)\(\s*([`'"])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    // `${...}` holes hold values, not keys.
    const literal = call[2].replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, '0');
    for (const key of literal.matchAll(/(?:^|\s)([A-Za-z_][\w.]*)=/g)) keys.push(key[1]);
  }
  return keys;
}

/** 4.7.3 (S5m): Claude Code's debug log redacts every `$.ui.log` value whose key contains "token" (`seed.work_state_tokens=[REDACTED]`). */
describe('4.7.3 (S5m) no notice key contains "token"', () => {
  const root = new URL('..', import.meta.url);
  const files = ['compact.ts', ...readdirSync(new URL('core/', root)).filter((name) => name.endsWith('.ts')).map((name) => `core/${name}`)];

  it('finds the keys it is meant to scan', () => {
    const keys = loggedKeys(readFileSync(new URL('compact.ts', root), 'utf8'));
    expect(keys).toEqual(expect.arrayContaining(['seed.task_card_size', 'seed.recipes_size', 'compact.jev_units', 'seed.budget_total']));
  });

  for (const file of files) {
    it(`${file} logs no key with "token" in it`, () => {
      const bad = loggedKeys(readFileSync(new URL(file, root), 'utf8')).filter((key) => /token/i.test(key));
      expect(bad).toEqual([]);
    });
  }

  it('names the three sizes the old way no more', () => {
    const source = readFileSync(new URL('compact.ts', root), 'utf8');
    for (const key of ['seed.work_state_size', 'seed.session_map_size', 'seed.task_brief_size']) expect(source).toContain(`${key}=`);
  });
});
