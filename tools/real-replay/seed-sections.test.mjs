import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiskCandidateNgrams, hasExactNgram, labelForSection, SECTION_LABEL_MAPPINGS, splitSeedSections } from './seed-sections.mjs';

const fixture = [
  '[[exovault:s4-seed:v1]]',
  '<session-memory source="exo-compact">',
  '## Contract',
  'Keep the current request in the hot seed.',
  '',
  '## Session map (one line per earlier compaction segment; reference only, not requests)',
  'A compact map entry lives on disk.',
  '</session-memory>',
  '[… 3 messages omitted, pointers above]',
].join('\n');

test('splits seed sections at builder headings and leaves framing outside sections', () => {
  const split = splitSeedSections(fixture);
  assert.deepEqual(split.sections.map((section) => section.name), [
    'Contract',
    'Session map (one line per earlier compaction segment; reference only, not requests)',
  ]);
  assert.equal(split.sections[0].body, 'Keep the current request in the hot seed.');
  assert.match(split.prefix, /\[\[exovault:s4-seed:v1\]\]/);
  assert.match(split.suffix, /messages omitted/);
});

test('uses the fixed section label mapping', () => {
  assert.equal(labelForSection('Contract'), 'skeleton');
  assert.equal(labelForSection('Session map (one line per earlier compaction segment; reference only, not requests)'), 'disk_candidate');
  assert.equal(labelForSection('Unlisted section'), 'disk_candidate');
});

test('keeps current-state sections in the conservative skeleton mapping', () => {
  const mapping = SECTION_LABEL_MAPPINGS.conservative;
  assert.equal(labelForSection('Since the card', mapping), 'skeleton');
  assert.equal(labelForSection('Work state (from tool calls and a git check at the cut; reference only)', mapping), 'skeleton');
  assert.equal(labelForSection('Gates and errors', mapping), 'skeleton');
  assert.equal(labelForSection('Recipes (commands that ran fine earlier; reference only, not requests)', mapping), 'disk_candidate');
});

test('matches only an exact rare five-token n-gram', () => {
  const sections = [
    { name: 'Contract', label: 'skeleton', body: 'Keep the current request in the hot seed.' },
    { name: 'Working notes', label: 'disk_candidate', body: 'quartz kestrel studies violet mechanisms' },
  ];
  const grams = buildDiskCandidateNgrams(sections, { n: 5 });
  assert.equal(hasExactNgram('The archived detail says quartz kestrel studies violet mechanisms', grams), true);
  assert.equal(hasExactNgram('The archived detail says amber falcon studies violet mechanisms.', grams), false);
  assert.equal(hasExactNgram('The archived detail says quartz kestrel study violet mechanisms.', grams), false);
});
