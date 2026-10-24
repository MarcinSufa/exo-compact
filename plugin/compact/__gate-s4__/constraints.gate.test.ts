import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadImpl } from './impl.js';
import { countTokens, sha256 } from './fixtures/helpers.js';
import { extractAdoptedFileConstraints as extractAdoptedReal, extractConstraints as extractConstraintsReal } from '../core/constraints.js';
import type { CaptureRecord } from '../core/types.js';

const require = createRequire(import.meta.url);
import type {
  CONSTRAINT_MARKERS_V1 as ConstraintMarkersV1,
  applyConstraintOverflow as ApplyConstraintOverflow,
  extractConstraints as ExtractConstraints,
  renderConstraintsSection as RenderConstraintsSection,
  splitSentences as SplitSentences,
} from '../core/constraints.js';

let CONSTRAINT_MARKERS_V1: typeof ConstraintMarkersV1;
let applyConstraintOverflow: typeof ApplyConstraintOverflow;
let extractConstraints: typeof ExtractConstraints;
let renderConstraintsSection: typeof RenderConstraintsSection;
let splitSentences: typeof SplitSentences;

beforeAll(async () => {
  const impl = await loadImpl<{
    CONSTRAINT_MARKERS_V1: typeof ConstraintMarkersV1;
    applyConstraintOverflow: typeof ApplyConstraintOverflow;
    extractConstraints: typeof ExtractConstraints;
    renderConstraintsSection: typeof RenderConstraintsSection;
    splitSentences: typeof SplitSentences;
  }>('constraints');
  ({ CONSTRAINT_MARKERS_V1, applyConstraintOverflow, extractConstraints, renderConstraintsSection, splitSentences } = impl);
});

function record(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return { kind: 'user', origin: 'turn', producedBy: 's4-capture', body: {}, sourceHash: 'h', ...overrides };
}

function userText(text: string): CaptureRecord {
  return record({ body: { text } });
}

it('subject-aware revocation removes only the referred rule and preserves an unrelated later rule', () => {
  const result = extractConstraintsReal([
    userText('Never deploy on Friday.'),
    userText('Always run the local checks.'),
    userText('We no longer deploy on Friday.'),
  ], sha256);
  expect(result.map((entry) => entry.text)).toEqual(['Always run the local checks.']);
});

it('adopted file instructions promote marker sentences only from the user-named Read result', () => {
  const messages = [
    { role: 'user' as const, text: 'Read ./docs/rules.md and remember and follow it.', toolUses: [], toolResults: [] },
    { role: 'assistant' as const, text: '', toolUses: [{ tool: 'Read', tool_use_id: 'r1', input: { file_path: './docs/rules.md' } }, { tool: 'Bash', tool_use_id: 'b1', input: {} }], toolResults: [
      { tool_use_id: 'r1', text: 'You must preserve source attribution.', isError: false },
      { tool_use_id: 'b1', text: 'You must run the deploy command.', isError: false },
    ] },
  ];
  expect(extractAdoptedReal(messages, sha256).map((entry) => [entry.text, entry.sourceFile])).toEqual([
    ['You must preserve source attribution.', './docs/rules.md'],
  ]);
  const adopted = extractAdoptedReal(messages, sha256);
  const rendered = applyConstraintOverflow(adopted, countTokens, sha256);
  expect(rendered.rendered[0].line).toContain('[source_file="./docs/rules.md"]');
  const folded = applyConstraintOverflow(adopted, countTokens, sha256, 0);
  expect(folded.rendered[0].line).toBe('[1 older constraints omitted; full text in the transcript]');
});

describe('constraints: marker list (spec §3.1.1, golden)', () => {
  it('is exactly the spec\'s EN + PL list, in this order', () => {
    expect([...CONSTRAINT_MARKERS_V1]).toEqual([
      'never', 'always', "don't", 'do not', 'must', 'only', 'until', 'unless', 'without',
      'nigdy', 'zawsze', 'nie rób', 'nie wolno', 'musi', 'tylko', 'dopóki', 'chyba że', 'bez',
    ]);
  });

  it.each(['never', 'always', "don't", 'do not', 'must', 'only', 'until', 'unless', 'without'])(
    'EN marker "%s" in a user sentence is extracted',
    (marker) => {
      const constraints = extractConstraints([userText(`You ${marker} touch the production database.`)], sha256);
      expect(constraints).toHaveLength(1);
      expect(constraints[0].text).toContain(marker);
    },
  );

  it.each(['nigdy', 'zawsze', 'nie rób', 'nie wolno', 'musi', 'tylko', 'dopóki', 'chyba że', 'bez'])(
    'PL marker "%s" in a user sentence is extracted',
    (marker) => {
      const constraints = extractConstraints([userText(`To ${marker} zrobić tego.`)], sha256);
      expect(constraints).toHaveLength(1);
      expect(constraints[0].text).toContain(marker);
    },
  );

  it('a sentence with no marker is not extracted', () => {
    expect(extractConstraints([userText('The weather is nice today.')], sha256)).toEqual([]);
  });
});

describe('constraints: source is user capture records only (spec §3.1.1)', () => {
  it('a tool result (kind=error) containing "never" yields nothing', () => {
    const toolResult = record({ kind: 'error', body: { text: 'You must never retry this call.' } });
    expect(extractConstraints([toolResult], sha256)).toEqual([]);
  });

  it('assistant_text containing "never" yields nothing', () => {
    const assistant = record({ kind: 'assistant_text', body: { text: 'I will never do that again.' } });
    expect(extractConstraints([assistant], sha256)).toEqual([]);
  });

  it('a gate/file record containing "always" yields nothing', () => {
    const gate = record({ kind: 'gate', body: { text: 'This must always pass.' } });
    const file = record({ kind: 'file', body: { text: 'You must always read this first.' } });
    expect(extractConstraints([gate, file], sha256)).toEqual([]);
  });

  it('mixed records: only the user record contributes a constraint', () => {
    const mixed = [
      record({ kind: 'error', body: { text: 'You must never ignore this error.' } }),
      userText('You must never delete the backups.'),
      record({ kind: 'assistant_text', body: { text: 'I must always confirm first.' } }),
    ];
    const constraints = extractConstraints(mixed, sha256);
    expect(constraints).toHaveLength(1);
    expect(constraints[0].text).toContain('delete the backups');
  });
});

describe('constraints: revocation supersedes (spec §3.1.1)', () => {
  it.each(['już nie', 'no longer', 'ignore the earlier'])(
    'a revocation phrase "%s" drops a uniquely subject-matched constraint',
    (phrase) => {
      const constraints = extractConstraints(
        [userText(`Never touch the production database. Actually, ${phrase}, touch the production database.`)],
        sha256,
      );
      expect(constraints).toEqual([]);
    },
  );

  it('revokes the first referred rule and preserves the unrelated later rule', () => {
    const constraints = extractConstraints(
      [userText('Never deploy on Friday. Always run the local checks. We no longer deploy on Friday.')],
      sha256,
    );
    expect(constraints).toHaveLength(1);
    expect(constraints[0].text).toContain('local checks');
  });

  it('keeps every rule when a revocation has no unique subject match', () => {
    const constraints = extractConstraints(
      [userText('Never deploy on Friday. Always run the local checks. Actually, ignore the earlier rule.')],
      sha256,
    );
    expect(constraints).toHaveLength(2);
  });

  it('a revocation with nothing kept yet is a no-op, not a crash', () => {
    expect(() => extractConstraints([userText('No longer relevant, never mind.')], sha256)).not.toThrow();
  });
});

describe('constraints: sentence splitting (Intl.Segmenter and regex fallback)', () => {
  it('splits a multi-sentence user message into separate sentences (feature-detected path)', () => {
    const sentences = splitSentences('First sentence. Second sentence! Third one?');
    expect(sentences).toEqual(['First sentence.', 'Second sentence!', 'Third one?']);
  });

  it('falls back to a deterministic regex split when Intl.Segmenter is unavailable', () => {
    const original = (Intl as unknown as { Segmenter?: unknown }).Segmenter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (Intl as any).Segmenter;
    try {
      const sentences = splitSentences('You must always confirm. Never skip this step.');
      expect(sentences).toEqual(['You must always confirm.', 'Never skip this step.']);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Intl as any).Segmenter = original;
    }
  });

  it('the regex fallback still lets extractConstraints find a marker in the second sentence', () => {
    const original = (Intl as unknown as { Segmenter?: unknown }).Segmenter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (Intl as any).Segmenter;
    try {
      const constraints = extractConstraints([userText('Hello there. You must never skip tests.')], sha256);
      expect(constraints).toHaveLength(1);
      expect(constraints[0].text).toBe('You must never skip tests.');
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Intl as any).Segmenter = original;
    }
  });
});

describe('constraints: section survives a full-budget seed (spec §3.1.1, "never truncated")', () => {
  it('applyConstraintOverflow does not touch constraints comfortably under the 2k budget', () => {
    const constraints = extractConstraints([userText('You must always keep backups. Never skip a backup.')], sha256);
    const result = applyConstraintOverflow(constraints, countTokens, sha256);
    expect(result.overflowCount).toBe(0);
    expect(result.rendered.every((entry) => !entry.isPointer)).toBe(true);
    const body = renderConstraintsSection(result.rendered);
    expect(body).toContain('keep backups');
    expect(body).toContain('skip a backup');
  });
});

describe('constraints: overflow folds the oldest into one line (spec §3.1.1, 3.13.0 S4m)', () => {
  const omittedLine = (n: number): string => `[${n} older constraints omitted; full text in the transcript]`;
  const check = (count: number, text: (i: number) => string, budget: number) => {
    const constraints = extractConstraints(Array.from({ length: count }, (_, i) => userText(text(i))), sha256);
    expect(constraints).toHaveLength(count);
    const result = applyConstraintOverflow(constraints, countTokens, sha256, budget);
    const body = renderConstraintsSection(result.rendered);
    const [first, ...rest] = result.rendered;
    // One summary line, first, covering exactly the oldest `overflowCount`; the rest verbatim and in order.
    expect(first.line).toBe(omittedLine(result.overflowCount));
    expect(rest.every((entry) => !entry.isPointer)).toBe(true);
    expect(rest.map((entry) => entry.seq)).toEqual(constraints.slice(result.overflowCount).map((c) => c.seq));
    expect(body).not.toMatch(/\[pointer |\[seq=|sha256=/);
    expect(countTokens(body)).toBeLessThanOrEqual(budget);
    // Minimal: folding one fewer would not fit.
    const oneFewer = [omittedLine(result.overflowCount - 1), ...constraints.slice(result.overflowCount - 1).map((c) => `> ${c.text}`)].join('\n');
    if (result.overflowCount > 1) expect(countTokens(oneFewer)).toBeGreaterThan(budget);
    return { constraints, result };
  };

  it('long constraints: only as many of the oldest fold as needed', () => {
    const { constraints, result } = check(70, (i) => `Constraint number ${i} says you must always keep this specific invariant number ${i} true forever no matter what happens next.`, 2000);
    expect(result.overflowCount).toBeGreaterThan(0);
    expect(result.overflowCount).toBeLessThan(constraints.length / 2);
  });

  it('review 3.13.0 #4: many short constraints keep most of them instead of collapsing all', () => {
    const { constraints, result } = check(200, (i) => `Item ${i}: you must always keep invariant ${i} in the build.`, 2000);
    expect(result.overflowCount).toBeGreaterThan(0);
    expect(result.rendered.length - 1).toBeGreaterThan(constraints.length / 2);
  });

  it('a budget too small for any constraint renders just the summary line', () => {
    const constraints = extractConstraints(Array.from({ length: 50 }, (_, i) => userText(`Rule ${i}: you must never break invariant ${i}.`)), sha256);
    const result = applyConstraintOverflow(constraints, countTokens, sha256, 20);
    expect(result.overflowCount).toBe(50);
    expect(result.rendered.map((entry) => entry.line)).toEqual([omittedLine(50)]);
  });

  it('under budget, overflowCount is 0 and every line is verbatim', () => {
    const constraints = extractConstraints([userText('Never skip a backup.')], sha256);
    const result = applyConstraintOverflow(constraints, countTokens, sha256, 2000);
    expect(result.overflowCount).toBe(0);
    expect(result.rendered.map((entry) => entry.line)).toEqual(['> Never skip a backup.']);
  });
});

describe('constraints: mutation survivor M4, the overflow boundary is inclusive (<=, not <)', () => {
  it('an entry set exactly at budget is left verbatim, not converted to a pointer', () => {
    const constraints = extractConstraints([userText('Never skip a backup.')], sha256);
    expect(constraints).toHaveLength(1);
    const line = `> ${constraints[0].text}`;
    const exactBudget = countTokens(line);
    const result = applyConstraintOverflow(constraints, countTokens, sha256, exactBudget);
    expect(result.overflowCount).toBe(0);
    expect(result.rendered[0].isPointer).toBe(false);
    expect(result.rendered[0].line).toBe(line);
  });

  it('one token under that exact budget folds the entry into the summary line', () => {
    const constraints = extractConstraints([userText('Never skip a backup.')], sha256);
    const line = `> ${constraints[0].text}`;
    const exactBudget = countTokens(line);
    const result = applyConstraintOverflow(constraints, countTokens, sha256, exactBudget - 1);
    expect(result.overflowCount).toBe(1);
    expect(result.rendered[0].isPointer).toBe(true);
  });
});

describe('constraints: mutation survivor M2, revocation is checked before the marker check on the same sentence', () => {
  it('a single sentence carrying both a revocation phrase and a constraint marker revokes, and is not itself added', () => {
    // "no longer" (revocation) and "must" (marker) in the same sentence: revocation must win, per
    // the order in extractConstraints (checked first on every sentence, review-opus-r10.md's
    // fix list and CONTRACT.md's LIFO note).
    const constraints = extractConstraints(
      [userText('Never touch the production database. You no longer touch production database, must obey.')],
      sha256,
    );
    expect(constraints).toEqual([]);
  });

  it('order also holds when the combined sentence comes first, with nothing kept yet (no-op, not a crash, and not added)', () => {
    const constraints = extractConstraints(
      [userText('You no longer must follow the old rule. Always keep backups.')],
      sha256,
    );
    expect(constraints).toHaveLength(1);
    expect(constraints[0].text).toContain('keep backups');
  });
});

describe('constraints: B1, whole-word/paragraph/fence hardening against pasted content (review-opus-r10.md B1)', () => {
  // The A/B filler turn's own pasted-content source (the A/B harness's `lib/script.ts`,
  // `fillerFilePath`/`readFillerSource`: `require.resolve('typescript/lib/lib.dom.d.ts')`), read
  // directly here so the fixture is the exact real content the review ran against, not a
  // hand-copied excerpt. The A/B harness's own `buildChainScript`/`loadScenario` were not imported
  // (cross-worktree import of a sibling eval package's `.ts`-extension ESM modules and its own
  // fixture-loading is not clean from this project's vitest config), per the brief's fallback:
  // "otherwise copy a representative fixture and cite where it came from". The chunk size below
  // (49500 chars) matches the A/B harness's own `TURN_CHARS` (`lib/thresholds.ts:26`:
  // `Math.round(15_000 * 3.3)`), so this reproduces the real per-filler-turn paste size.
  const fillerSource = readFileSync(require.resolve('typescript/lib/lib.dom.d.ts'), 'utf8');
  const TURN_CHARS = Math.round(15_000 * 3.3);

  function fillerChunk(n: number): string {
    return fillerSource.slice((n - 1) * TURN_CHARS, n * TURN_CHARS);
  }

  it('a large pasted .d.ts chunk (selfOnly?, completeFramesOnly?, and a licence header containing WITHOUT) yields zero constraints on its own', () => {
    expect(fillerSource).toContain('selfOnly?');
    expect(fillerSource).toContain('completeFramesOnly?');
    expect(fillerChunk(1)).toContain('WITHOUT');
    const pasted = `<<<PART 1 START>>>\n${fillerChunk(1)}\n<<<PART 1 END>>>`;
    const constraints = extractConstraints([userText(pasted)], sha256);
    expect(constraints).toEqual([]);
  });

  it('a real short user instruction in the same turn as the pasted chunk is still caught', () => {
    const pasted = `<<<PART 1 START>>>\n${fillerChunk(1)}\n<<<PART 1 END>>>`;
    const turnText = `You must never commit directly to main.\n\nHere is part 1 of 8 of a large TypeScript declaration file.\n\n${pasted}`;
    const constraints = extractConstraints([userText(turnText)], sha256);
    expect(constraints).toHaveLength(1);
    expect(constraints[0].text).toContain('never commit directly to main');
  });

  it('a run shaped like buildChainScript(\'hard\', 8) (one seed turn plus 8 filler turns of pasted .d.ts) keeps section 0, and the whole seed, within SEED_BUDGET_TOKENS (6000)', () => {
    const SEED_BUDGET_TOKENS = 6000;
    const records: CaptureRecord[] = [
      userText('Project briefing for KESTREL. Every code answer in this session must start with // KESTREL.\n\nReply with exactly one word: ACK'),
    ];
    for (let n = 1; n <= 8; n++) {
      const pasted = `<<<PART ${n} START>>>\n${fillerChunk(n)}\n<<<PART ${n} END>>>`;
      records.push(userText(`Here is part ${n} of 8 of a large TypeScript declaration file. Reply with one line only: how many lines in this part start with the word "interface"? An estimate is fine.\n\n${pasted}`));
    }
    const constraints = extractConstraints(records, sha256);
    // Sanity: the pasted chunks contributed nothing; only the seed's own real constraint(s), plus
    // at most the one deduped "Reply with one line only" boilerplate that repeats every filler
    // turn (a real, if noisy, whole-word "only" match outside any paragraph/fence limit), survive.
    expect(constraints.length).toBeLessThanOrEqual(3);
    const result = applyConstraintOverflow(constraints, countTokens, sha256);
    const section0Tokens = countTokens(renderConstraintsSection(result.rendered));
    expect(section0Tokens).toBeLessThan(SEED_BUDGET_TOKENS);
    // Full-seed bound: section 0 render alone (`## Constraints (history)\n` + body) never exceeds
    // the seed's own overall budget, so it can never on its own be the reason `checkBudget` fails
    // (review-opus-r10.md B1, filler-4/filler-8 rows: section0=6768/15881, both over 6000 today).
    const seedLikeTokens = countTokens(`## Constraints (history)\n${renderConstraintsSection(result.rendered) || '(none)'}`);
    expect(seedLikeTokens).toBeLessThan(SEED_BUDGET_TOKENS);
  });
});

describe('constraints: round 16 F2 (brief-s4a-fix16.md), the section 0 paragraph cap is bullet-aware', () => {
  it('a 9-line bullet paragraph (one line over the 8-line whole-paragraph cap) still yields its marker: the real A/B briefing turn evidence, one bullet away from silently dropping KESTREL', () => {
    const briefing = [
      '- Codename: Project KESTREL-9',
      '- Port: 48213',
      '- Owner: Alice Morgan',
      '- Budget: 3,470 EUR',
      '- Deadline: 2026-11-19',
      '- Database decision: SQLite over Postgres, offline requirement',
      '- Region: eu-central-2',
      '- Ticket: LDG-7734',
      '- Every code answer in this session must start with "// KESTREL".',
    ].join('\n');
    expect(briefing.split('\n').length).toBe(9);
    const constraints = extractConstraints([userText(briefing)], sha256);
    expect(constraints).toHaveLength(1);
    expect(constraints[0].text).toContain('// KESTREL');
  });

  it('a bullet list is scanned per bullet: two separate bullets each carrying their own marker both survive, not merged or capped as one 8-line block', () => {
    const lines = ['- fact one', '- fact two', '- fact three', '- fact four', '- fact five', '- fact six', '- you must never skip a bullet', '- you must always log a bullet', '- fact nine'];
    const constraints = extractConstraints([userText(lines.join('\n'))], sha256);
    expect(constraints).toHaveLength(2);
    expect(constraints.map((c) => c.text)).toEqual(['you must never skip a bullet', 'you must always log a bullet']);
  });

  it('a non-bullet prose paragraph over the cap keeps being skipped from extraction (unchanged B1 rule), but is reported once via the new onSkippedParagraph callback because it carries a marker', () => {
    const overCap = Array.from({ length: 9 }, (_, i) => `This is plain prose sentence number ${i + 1} in a long paragraph with no bullets at all.`).join(' ') + ' You must never lose this rule to the size cap.';
    expect(overCap.split('\n').length).toBe(1);
    expect(overCap.length).toBeGreaterThan(600);
    expect(extractConstraints([userText(overCap)], sha256)).toEqual([]);
    let skipped = 0;
    const result = extractConstraints([userText(overCap)], sha256, () => { skipped += 1; });
    expect(result).toEqual([]);
    expect(skipped, 'the over-cap paragraph contains "must never", so it must be reported, not silently dropped').toBe(1);
  });

  it('an over-cap non-bullet paragraph with no marker at all is skipped with no callback invocation (only a marker-carrying drop is worth logging)', () => {
    const overCapNoMarker = Array.from({ length: 9 }, (_, i) => `Line ${i + 1} of an ordinary long paragraph with nothing special in it at all.`).join('\n');
    expect(overCapNoMarker.split('\n').length).toBe(9);
    let skipped = 0;
    const result = extractConstraints([userText(overCapNoMarker)], sha256, () => { skipped += 1; });
    expect(result).toEqual([]);
    expect(skipped).toBe(0);
  });

  it('the onSkippedParagraph callback is optional: every pre-round-16 two-argument call site keeps compiling and behaving the same', () => {
    expect(() => extractConstraints([userText('You must never break this call shape.')], sha256)).not.toThrow();
  });
});

describe('constraints: 3.35.0, a standing rule glued to a pasted brief survives the paragraph cap', () => {
  const brief = ['# TASK R5 (wave 16, app): the desktop sidebar project tree', 'Repo: acme-app (pnpm monorepo, TypeScript only). Package you touch: packages/app ONLY.',
    ...Array.from({ length: 12 }, (_, i) => `Step ${i + 1}: edit the sidebar row component and keep the existing props as they are.`)].join('\n');
  const prompt = (note: string): string => `Task 5 of 8. The harness committed your previous task. Same rules as before.\n\n${note}${brief}\n`;
  // The real wave 17 r5 note, "e.g." and backticks included.
  const r5 = 'Change to my describe rule: from this task on, the title of each top-level describe in a new test file starts with the plain slice id and a colon, e.g. `describe("r5: sidebar tree", () => {`, no square brackets.';
  const texts = (records: CaptureRecord[]): string[] => extractConstraintsReal(records, sha256).map((entry) => entry.text);
  const withoutSegmenter = <T>(run: () => T): T => {
    const original = (Intl as unknown as { Segmenter?: unknown }).Segmenter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (Intl as any).Segmenter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { return run(); } finally { (Intl as any).Segmenter = original; }
  };

  it('the wave 17 prompt shape keeps the whole note and nothing of the brief, on both sentence-split paths', () => {
    expect(texts([userText(prompt(r5))])).toEqual([r5]);
    expect(withoutSegmenter(() => texts([userText(prompt(r5))]))).toEqual([r5]);
  });

  it('"from now on" and the Polish "od teraz" are caught the same way, in order', () => {
    expect(texts([
      userText(prompt('A note from me before the task: from now on write the summary part of every final report in Polish.')),
      userText(prompt('Od teraz pierwsza linia raportu to nagłówek SLICE.')),
    ])).toEqual(['A note from me before the task: from now on write the summary part of every final report in Polish.', 'Od teraz pierwsza linia raportu to nagłówek SLICE.']);
  });

  it('a note glued after the pasted content (the last lines) counts too, and a hard-wrapped note keeps its second line', () => {
    expect(texts([userText(`${brief}\n\nStep 13: done.\n${brief.split('\n').slice(2).join('\n')}\nFrom now on write the summary of every final\nreport in Polish, not English.`)]))
      .toEqual(['From now on write the summary of every final report in Polish, not English.']);
  });

  it('a "no longer" sentence at the edge of pasted content does not revoke a rule (the wave 17 r17 brief would have)', () => {
    const r17Brief = `${brief}\nThe file no longer imports or names \`ProjectChips\` and has no line for the final report summary.`;
    const polish = 'From now on write the summary part of every final report in Polish.';
    expect(texts([userText(polish), userText(r17Brief)])).toEqual([polish]);
  });

  it('a quoted copy of a rule dedups with the plain rule, and a heading is never a rule', () => {
    expect(texts([userText('From now on write the summary in Polish.'), userText(prompt('> From now on write the summary in Polish.'))])).toEqual(['From now on write the summary in Polish.']);
    expect(texts([userText(`## From now on: migration notes\n${brief}`)])).toEqual([]);
  });

  it('pasted logs, changelogs and chat with "from <x> on" or "starting with" yield nothing', () => {
    const pastes = [
      ['ERROR connection refused from host 10 on port 5432, giving up.', 'INFO listening from port 3000 on 0.0.0.0.'],
      ['Copy the config from this repo on GitHub.', 'I read the value from this file on disk.'],
      ['Starting with this release, the default timeout is 30s.', 'From version 4 on, Node 18 is required.'],
    ];
    for (const [first, last] of pastes) {
      const pasted = [first, ...Array.from({ length: 10 }, (_, i) => `line ${i}: ordinary pasted output with nothing else in it at all`), last].join('\n');
      expect(texts([userText(pasted)]), first).toEqual([]);
    }
  });

  it('a marker in the middle of a long pasted paragraph stays skipped: only its edges are read', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i}: ordinary pasted output with nothing else in it at all`);
    lines.splice(6, 0, 'From now on the cache is warm.');
    expect(texts([userText(lines.join('\n'))])).toEqual([]);
  });

  it('the skipped-paragraph callback fires only when the paragraph yields no rule', () => {
    let skipped = 0;
    extractConstraintsReal([userText(prompt(r5))], sha256, () => { skipped += 1; });
    expect(skipped).toBe(0);
    extractConstraintsReal([userText(`${brief}\nYou must never break the sidebar.`)], sha256, () => { skipped += 1; });
    expect(skipped).toBe(1);
  });

  it('the regex fallback no longer splits after "e.g." or before a lowercase word', () => {
    expect(withoutSegmenter(() => splitSentences('Use a short id, e.g. r5. Then stop. ok go'))).toEqual(['Use a short id, e.g. r5.', 'Then stop. ok go']);
  });
});
