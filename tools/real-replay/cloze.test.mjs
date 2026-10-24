import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPrompt, isCorrect, pickItems } from './cloze.mjs';

const ctx = 'the agent then edited the file and ran the tests again';
test('pickItems keeps specific items with a masked context, deterministically', () => {
  const items = [
    { item: 'src/app/main.ts', context: ctx },
    { item: 'user', context: ctx },
    { item: 'parseItem', context: ctx },
    { item: 'readConfig', context: ctx },
    { item: 'v3.17.0', context: 'too short' },
    { item: 'leaked.ts', context: `${ctx} leaked.ts` },
  ];
  const picked = pickItems(items, 8).map((x) => x.item).sort();
  assert.deepEqual(picked, ['parseItem', 'readConfig', 'src/app/main.ts']);
  assert.deepEqual(pickItems(items, 8), pickItems([...items].reverse(), 8));
});

test('isCorrect accepts exact or contained answers and rejects UNKNOWN', () => {
  assert.equal(isCorrect('`src/app/main.ts`', 'src/app/main.ts'), true);
  assert.equal(isCorrect('app/main.ts', 'src/app/main.ts'), true);
  assert.equal(isCorrect('UNKNOWN', 'src/app/main.ts'), false);
  assert.equal(isCorrect('ts', 'src/app/main.ts'), false);
});

test('buildPrompt puts the memory inside tags and numbers the blanks', () => {
  const prompt = buildPrompt('MEMORY', [{ item: 'x.ts', context: ctx }]);
  assert.match(prompt, /<memory>\nMEMORY\n<\/memory>/);
  assert.match(prompt, /1\. \.\.\.the agent/);
});
