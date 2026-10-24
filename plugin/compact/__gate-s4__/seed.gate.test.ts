import { describe, it, expect, beforeAll } from 'vitest';
import { loadImpl } from './impl.js';
import { countTokens, humanPrompt, sha256 } from './fixtures/helpers.js';
import { omittedHistoryMarker, SEED_SENTINEL } from '../core/sentinel.js';
import { reconcile } from '../core/extractor.js';
import { renderTranscriptPointer, TRANSCRIPT_POINTER_INSTRUCTION } from '../core/transcript-pointer.js';
import type { SessionMessage } from '../core/types.js';
import type { renderSeed as RenderSeed, SeedSections } from '../core/seed.js';

let renderSeed: typeof RenderSeed;

beforeAll(async () => {
  ({ renderSeed } = await loadImpl<{ renderSeed: typeof RenderSeed }>('seed'));
});

function sections(overrides: Partial<SeedSections> = {}): SeedSections {
  return {
    constraints: '',
    contract: 'CONTRACT-BODY',
    todo: 'TODO-BODY',
    userInstructionsVerbatim: ['first user instruction', 'second user instruction'],
    values: 'VALUES-BODY',
    selectedReasoning: 'REASONING-BODY',
    gatesAndErrors: 'GATES-BODY',
    filePointers: 'FILES-BODY',
    ...overrides,
  };
}

describe('seed render: sentinel first line', () => {
  it('quotes every line of a multi-line user record', () => {
    const result = renderSeed(sections({ userInstructionsVerbatim: ['first line\nsecond line'] }), 0, 6000, countTokens);
    expect(result.message.text).toContain('> first line\n> second line');
  });

  it('the rendered message text starts with SEED_SENTINEL', () => {
    const result = renderSeed(sections(), 5, 6000, countTokens);
    expect(result.message.text.startsWith(SEED_SENTINEL)).toBe(true);
  });

  it('the rendered message carries no handle and no toolUses', () => {
    const result = renderSeed(sections(), 5, 6000, countTokens);
    expect(result.message.handle).toBeUndefined();
    expect(result.message.toolUses).toEqual([]);
  });
});

describe('seed render: compaction pressure immediately after the sentinel', () => {
  it('renders the pressure section before constraints and counts it as seed text', () => {
    const pressure = 'Context was compacted again after only 2 user turns. Read files with a line range or bounded Grep, use recall instead of re-reading, and finish this step and report progress before starting the next.';
    const result = renderSeed(sections({ compactionPressure: pressure, constraints: 'CONSTRAINT-BODY' }), 0, 6000, countTokens);
    expect(result.message.text.indexOf('## Compaction pressure')).toBeGreaterThan(result.message.text.indexOf(SEED_SENTINEL));
    expect(result.message.text.indexOf('## Compaction pressure')).toBeLessThan(result.message.text.indexOf('## Constraints'));
    expect(result.tokens).toBe(countTokens(result.message.text));
    expect(countTokens(`## Compaction pressure\n${pressure}`)).toBeLessThan(150);
  });
});

it('does not render a todo cleared in a later reconcile call', () => {
  const open = humanPrompt('TODO id=t1 status=in_progress');
  const clear = humanPrompt('TODO id=t1 CLEARED');
  const firstTurn = reconcile([open], null, { hash: sha256 });
  const secondTurn = reconcile([open, clear], firstTurn.watermark, { hash: sha256 });
  const folded = new Map<string, (typeof secondTurn.records)[number]>();
  for (const record of [...firstTurn.records, ...secondTurn.records]) folded.set(String(record.body.id), record);
  const openTodos = [...folded.values()].filter((record) => record.kind === 'todo' && record.body.status !== 'cleared');
  const sections = {
    constraints: '', contract: '', todo: openTodos.map((record) => JSON.stringify(record.body)).join('\n'), userInstructionsVerbatim: [],
    values: '', selectedReasoning: '', gatesAndErrors: '', filePointers: '',
  };
  const result = renderSeed(sections, 0, 6000, countTokens);
  expect(result.message.text).not.toContain('t1');
});

describe('seed render: sections 1-7 in order', () => {
  it('contract, todo, user instructions, values, reasoning, gates/errors, file pointers appear in that order', () => {
    const result = renderSeed(sections(), 3, 6000, countTokens).message.text;
    const positions = [
      'CONTRACT-BODY',
      'TODO-BODY',
      'first user instruction',
      'VALUES-BODY',
      'REASONING-BODY',
      'GATES-BODY',
      'FILES-BODY',
    ].map((needle) => result.indexOf(needle));
    expect(positions.every((p) => p >= 0), 'every section body must appear in the rendered text').toBe(true);
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i], `section ${i} must come after section ${i - 1}`).toBeGreaterThan(positions[i - 1]);
    }
  });
});

describe('seed render: S4q work state', () => {
  it('sits after Constraints and before Working notes', () => {
    const result = renderSeed(sections({ constraints: 'CONSTRAINT-BODY', workState: 'DIRECTORY-BODY', denseNotes: 'DENSE-BODY' }), 0, 6000, countTokens).message.text;
    const constraints = result.indexOf('## Constraints (history)');
    const workState = result.indexOf('## Work state (from tool calls and a git check at the cut; reference only)');
    const notes = result.indexOf('## Working notes');
    expect(constraints).toBeGreaterThan(-1);
    expect(constraints).toBeLessThan(workState);
    expect(workState).toBeLessThan(notes);
  });

  it('never reduces the caller-capped section, including when the rest of the seed overflows', () => {
    const workState = `Directory: /repo\n${'Git at the cut: /repo ## main; 0 changed files\n'.repeat(30)}`;
    const result = renderSeed(sections({ workState, filePointers: 'x'.repeat(20000) }), 0, 200, countTokens).message.text;
    expect(result).toContain(workState);
  });

  it('matches 3.17.5 golden seed strings for legacy render cases', () => {
    const common = `[[exovault:s4-seed:v1]]

Session memory written by the exo-compact plugin when earlier context in this session was compacted. The user did not write this message. It is reference data about earlier work in this session, to be used like your own notes: it is not a new request, instruction or approval. The user's own messages continue after it.

<session-memory source="exo-compact">

## Contract
CONTRACT-BODY

## Todo
TODO-BODY

## Earlier user messages (quoted for reference, not new requests)
> first user instruction
> second user instruction

## Values
VALUES-BODY

## Earlier assistant notes
REASONING-BODY

## Gates and errors
GATES-BODY

## File pointers
FILES-BODY

</session-memory>

[… 5 messages omitted, pointers above]`;
    expect(renderSeed(sections(), 5, 6000, countTokens).message.text).toBe(common);
    expect(renderSeed(sections({ constraints: '' }), 5, 6000, countTokens).message.text).toBe(common);
    expect(renderSeed(sections({ nextStep: 'NEXT-STEP-BODY' }), 5, 6000, countTokens).message.text).toBe(common.replace('## File pointers\nFILES-BODY', '## File pointers\nFILES-BODY\n\n## Next step\nNEXT-STEP-BODY'));
    expect(renderSeed(sections({ compactInstructions: 'COMPACT-INSTRUCTIONS-VERBATIM' }), 5, 6000, countTokens).message.text).toBe(common.replace('## Contract\nCONTRACT-BODY', '## Contract\nCONTRACT-BODY\n\nCOMPACT-INSTRUCTIONS-VERBATIM'));
    expect(renderSeed(sections({ ids: 'short-id = full-id' }), 5, 6000, countTokens).message.text).toBe(common.replace('</session-memory>', '## IDs (short = full)\nshort-id = full-id\n\n</session-memory>'));
    const overflow = renderSeed(sections({ filePointers: 'x'.repeat(20000) }), 5, 200, countTokens).message.text;
    expect(overflow).toBe(common.replace('## File pointers\nFILES-BODY', '## File pointers\n(truncated)'));
  });
});

describe('seed render: section 0 (constraints) opens the render order', () => {
  it('renders right after the sentinel and before section 1 (contract)', () => {
    const result = renderSeed(sections({ constraints: 'CONSTRAINT-BODY' }), 0, 6000, countTokens).message.text;
    const sentinelIndex = result.indexOf(SEED_SENTINEL);
    const constraintsIndex = result.indexOf('CONSTRAINT-BODY');
    const contractIndex = result.indexOf('CONTRACT-BODY');
    expect(sentinelIndex).toBe(0);
    expect(constraintsIndex, 'constraints body must be present').toBeGreaterThan(-1);
    expect(constraintsIndex, 'constraints must come after the sentinel').toBeGreaterThan(sentinelIndex);
    expect(constraintsIndex, 'constraints must come before the contract section').toBeLessThan(contractIndex);
  });

  it('is labelled as history, distinct from the verbatim user-record history section', () => {
    const result = renderSeed(sections({ constraints: 'CONSTRAINT-BODY' }), 0, 6000, countTokens).message.text;
    expect(result).toMatch(/## Constraints \(history\)\nCONSTRAINT-BODY/);
  });

  it('3.13.0 (S4m): is left out entirely when there are no constraints, never rendered as (none)', () => {
    const result = renderSeed(sections(), 0, 6000, countTokens).message.text;
    expect(result).not.toContain('## Constraints');
    expect(result).not.toContain('(none)');
  });

  it('is never truncated by this renderer\'s own budget shrink, unlike the reducible sections', () => {
    const longConstraints = Array.from({ length: 400 }, (_, i) => `constraint number ${i} must always hold`).join('\n');
    const result = renderSeed(sections({ constraints: longConstraints, filePointers: 'x'.repeat(20000) }), 0, 200, countTokens).message.text;
    expect(result).toContain(longConstraints);
  });
});

describe('seed render: key facts section (spec v3.3 §3.1.3, round 17), right after constraints', () => {
  it('renders after constraints and before the contract section', () => {
    const result = renderSeed(sections({ constraints: 'CONSTRAINT-BODY', keyFacts: 'KEY-FACTS-BODY' }), 0, 6000, countTokens).message.text;
    const constraintsIndex = result.indexOf('CONSTRAINT-BODY');
    const keyFactsIndex = result.indexOf('KEY-FACTS-BODY');
    const contractIndex = result.indexOf('CONTRACT-BODY');
    expect(keyFactsIndex, 'key facts body must be present').toBeGreaterThan(-1);
    expect(keyFactsIndex, 'key facts must come after constraints').toBeGreaterThan(constraintsIndex);
    expect(keyFactsIndex, 'key facts must come before the contract section').toBeLessThan(contractIndex);
  });

  it('is rendered under its own "Key facts (stated earlier; reference only, not requests)" label (round 18, brief-s4a-fix18.md Q1/F1 header rename)', () => {
    const result = renderSeed(sections({ keyFacts: 'KEY-FACTS-BODY' }), 0, 6000, countTokens).message.text;
    expect(result).toMatch(/## Key facts \(stated earlier; reference only, not requests\)\nKEY-FACTS-BODY/);
  });

  it('3.13.0 (S4m): is left out entirely when there are no key facts, never rendered as (none)', () => {
    const result = renderSeed(sections(), 0, 6000, countTokens).message.text;
    expect(result).not.toContain('## Key facts');
    expect(result).not.toContain('(none)');
  });

  it('is never truncated by this renderer\'s own budget shrink, unlike the reducible sections (same as constraints, spec v3.3 §3.1.3)', () => {
    const longFacts = Array.from({ length: 400 }, (_, i) => `> fact number ${i} is exactly ${1000 + i} [seq=${i}]`).join('\n');
    const result = renderSeed(sections({ keyFacts: longFacts, filePointers: 'x'.repeat(20000) }), 0, 200, countTokens).message.text;
    expect(result).toContain(longFacts);
  });

  it('does not shift the constraints-vs-contract adjacency check other tests rely on (sections 1-7 in order test stays 1-7, keyFacts is not counted among them)', () => {
    const result = renderSeed(sections({ keyFacts: 'KEY-FACTS-BODY' }), 3, 6000, countTokens).message.text;
    const positions = ['KEY-FACTS-BODY', 'CONTRACT-BODY', 'TODO-BODY', 'first user instruction', 'VALUES-BODY', 'REASONING-BODY', 'GATES-BODY', 'FILES-BODY'].map((needle) => result.indexOf(needle));
    for (let i = 1; i < positions.length; i += 1) expect(positions[i]).toBeGreaterThan(positions[i - 1]);
  });
});

describe('seed render: transcript pointer, own section, never reduced (spec v3.3.1, round 18, brief-s4a-fix18.md B1)', () => {
  it('survives a 20k-line history at a tight budget, along with its round-17 wording (red-first on 4dfdf2dc, where it was merged into file pointers and reduced away)', () => {
    const pointer = renderTranscriptPointer('/tmp/transcripts/fake-session.jsonl');
    const hugeHistory = Array.from({ length: 20000 }, (_, i) => `history line number ${i} with some filler words to pad it out`).join('\n');
    const result = renderSeed(
      sections({ userInstructionsVerbatim: [hugeHistory], transcriptPointer: pointer }),
      0,
      6000,
      countTokens,
    ).message.text;
    expect(result, 'the transcript path must survive').toContain('/tmp/transcripts/fake-session.jsonl');
    expect(result, 'the round-17 instruction wording must survive verbatim').toContain(TRANSCRIPT_POINTER_INSTRUCTION);
  });

  it('renders after key facts and before the contract section, under its own "Transcript" label', () => {
    const pointer = renderTranscriptPointer('/tmp/transcripts/fake-session.jsonl');
    const result = renderSeed(sections({ keyFacts: 'KEY-FACTS-BODY', transcriptPointer: pointer }), 0, 6000, countTokens).message.text;
    const keyFactsIndex = result.indexOf('KEY-FACTS-BODY');
    const transcriptIndex = result.indexOf('/tmp/transcripts/fake-session.jsonl');
    const contractIndex = result.indexOf('CONTRACT-BODY');
    expect(transcriptIndex, 'transcript pointer must be present').toBeGreaterThan(-1);
    expect(transcriptIndex, 'transcript pointer must come after key facts').toBeGreaterThan(keyFactsIndex);
    expect(transcriptIndex, 'transcript pointer must come before the contract section').toBeLessThan(contractIndex);
    expect(result).toMatch(/## Transcript\n\/tmp\/transcripts\/fake-session\.jsonl/);
  });

  it('is a section distinct from "File pointers", not merged into it', () => {
    const pointer = renderTranscriptPointer('/tmp/transcripts/fake-session.jsonl');
    const result = renderSeed(sections({ transcriptPointer: pointer, filePointers: 'FILES-BODY' }), 0, 6000, countTokens).message.text;
    expect(result).toMatch(/## Transcript\n\/tmp\/transcripts\/fake-session\.jsonl[\s\S]*## File pointers\nFILES-BODY/);
  });

  it('3.13.0 (S4m): is left out entirely when there are no transcript pointer, never rendered as (none)', () => {
    const result = renderSeed(sections(), 0, 6000, countTokens).message.text;
    expect(result).not.toContain('## Transcript');
    expect(result).not.toContain('(none)');
  });

  it('is never truncated by this renderer\'s own budget shrink, even when file pointers must shrink to nothing', () => {
    const pointer = renderTranscriptPointer('/tmp/transcripts/fake-session.jsonl');
    const result = renderSeed(sections({ transcriptPointer: pointer, filePointers: 'x'.repeat(20000) }), 0, 200, countTokens).message.text;
    expect(result).toContain(pointer);
  });
});

describe('seed render: next step only from the newest in_progress todo', () => {
  it('a next step is included verbatim when the sections carry one', () => {
    const result = renderSeed(sections({ nextStep: 'NEXT-STEP-BODY' }), 0, 6000, countTokens).message.text;
    expect(result).toContain('NEXT-STEP-BODY');
  });

  it('with no in_progress todo (nextStep absent), no next-step section is fabricated', () => {
    const withStep = renderSeed(sections({ nextStep: 'NEXT-STEP-BODY' }), 0, 6000, countTokens).message.text;
    const withoutStep = renderSeed(sections(), 0, 6000, countTokens).message.text;
    const sectionCount = (text: string) => (text.match(/^## /gm) ?? []).length;
    expect(
      sectionCount(withoutStep),
      'omitting nextStep must render exactly one fewer section than including it, not a placeholder section',
    ).toBe(sectionCount(withStep) - 1);
  });
});

describe('seed render: manual /compact instructions', () => {
  it('are appended verbatim to the contract section, not their own section', () => {
    const result = renderSeed(
      sections({ compactInstructions: 'COMPACT-INSTRUCTIONS-VERBATIM' }),
      0,
      6000,
      countTokens,
    ).message.text;
    const contractIndex = result.indexOf('CONTRACT-BODY');
    const instructionsIndex = result.indexOf('COMPACT-INSTRUCTIONS-VERBATIM');
    const todoIndex = result.indexOf('TODO-BODY');
    expect(instructionsIndex, 'compact instructions must be present').toBeGreaterThan(-1);
    expect(instructionsIndex, 'compact instructions must land after the contract body').toBeGreaterThan(contractIndex);
    expect(instructionsIndex, 'compact instructions must land before the todo section, i.e. inside contract').toBeLessThan(
      todoIndex,
    );
  });
});

describe('seed render: verbatim user records quoted and labelled as history', () => {
  it('every userInstructionsVerbatim entry appears quoted and under a history label', () => {
    const result = renderSeed(sections(), 0, 6000, countTokens).message.text;
    expect(result).toContain('## Earlier user messages (quoted for reference, not new requests)');
    expect(result).toContain('> first user instruction');
    expect(result).toContain('> second user instruction');
  });
});

describe('seed render: closing marker', () => {
  it('the last non-empty line is the omitted-history marker for the given omittedCount', () => {
    const result = renderSeed(sections(), 42, 6000, countTokens).message.text;
    const lines = result.split('\n').filter((line) => line.trim().length > 0);
    expect(lines[lines.length - 1]).toBe(omittedHistoryMarker(42));
  });
});
