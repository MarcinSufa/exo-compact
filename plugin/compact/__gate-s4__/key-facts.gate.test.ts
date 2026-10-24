import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadImpl } from './impl.js';
import { countTokens, sha256 } from './fixtures/helpers.js';
import type { CaptureRecord } from '../core/types.js';

const require = createRequire(import.meta.url);
import type {
  applyKeyFactsOverflow as ApplyKeyFactsOverflow,
  extractKeyFacts as ExtractKeyFacts,
  extractKeyFactsChunked as ExtractKeyFactsChunked,
  renderKeyFactsSection as RenderKeyFactsSection,
} from '../core/key-facts.js';

let applyKeyFactsOverflow: typeof ApplyKeyFactsOverflow;
let extractKeyFacts: typeof ExtractKeyFacts;
let extractKeyFactsChunked: typeof ExtractKeyFactsChunked;
let renderKeyFactsSection: typeof RenderKeyFactsSection;

beforeAll(async () => {
  const impl = await loadImpl<{
    applyKeyFactsOverflow: typeof ApplyKeyFactsOverflow;
    extractKeyFacts: typeof ExtractKeyFacts;
    extractKeyFactsChunked: typeof ExtractKeyFactsChunked;
    renderKeyFactsSection: typeof RenderKeyFactsSection;
  }>('key-facts');
  ({ applyKeyFactsOverflow, extractKeyFacts, extractKeyFactsChunked, renderKeyFactsSection } = impl);
});

function record(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return { kind: 'user', origin: 'turn', producedBy: 's4-capture', body: {}, sourceHash: `h${Math.random()}`, ...overrides };
}

function userText(text: string): CaptureRecord {
  return record({ kind: 'user', body: { text } });
}

function fileWriteText(text: string): CaptureRecord {
  return record({ kind: 'file_write', body: { text, tool_use_id: `toolu_${Math.random()}`, tool: 'Write' } });
}

describe('key-facts: candidate qualification, one sentence per signal type (spec v3.3 §3.1.3)', () => {
  it('mixed alphanumeric identifier token', () => {
    const facts = extractKeyFacts([userText('The staging environment is named PROJ2b for this sprint.')], sha256);
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toContain('PROJ2b');
  });

  it('UPPER-case token with a dash and digits', () => {
    const facts = extractKeyFacts([userText('Ticket KESTREL-9 tracks this work.')], sha256);
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toContain('KESTREL-9');
  });

  it('a plain number of 3+ digits', () => {
    const facts = extractKeyFacts([userText('The service listens on port 482.')], sha256);
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toContain('482');
  });

  it('a number with a unit', () => {
    const facts = extractKeyFacts([userText('Allow up to 500ms for the health check.')], sha256);
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toContain('500ms');
  });

  it('a currency amount', () => {
    const facts = extractKeyFacts([userText('The budget for this phase is $3400 total.')], sha256);
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toContain('$3400');
  });

  it('an ISO date', () => {
    const facts = extractKeyFacts([userText('The deadline for this phase is 2026-11-19.')], sha256);
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toContain('2026-11-19');
  });

  it('a clock time', () => {
    const facts = extractKeyFacts([userText('Daily standup happens at 09:30 sharp.')], sha256);
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toContain('09:30');
  });

  it('a file path', () => {
    const facts = extractKeyFacts([userText('The extra notes are kept in facts/turn-1-notes.txt for reference.')], sha256);
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toContain('facts/turn-1-notes.txt');
  });

  it('a quoted literal', () => {
    const facts = extractKeyFacts([userText('The codeword for this drop is "falcon" tonight.')], sha256);
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toContain('"falcon"');
  });

  it('a multi-word Capitalized name that is not sentence-initial-only', () => {
    const facts = extractKeyFacts([userText('The lead reviewer this cycle is Alice Morgan.')], sha256);
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toContain('Alice Morgan');
  });

  it('a sentence-initial capitalized run alone does not qualify (ordinary English capitalization, not a name signal)', () => {
    const facts = extractKeyFacts([userText('Quick Overview covers nothing else worth noting today.')], sha256);
    expect(facts).toHaveLength(0);
  });

  it('a stated reason (because / so that / since / żeby / bo / ponieważ)', () => {
    const en = extractKeyFacts([userText('We chose SQLite because it works fully offline.')], sha256);
    expect(en).toHaveLength(1);
    expect(en[0].text).toMatch(/because/);
    const pl = extractKeyFacts([userText('Wybraliśmy SQLite, ponieważ działa offline.')], sha256);
    expect(pl).toHaveLength(1);
    expect(pl[0].text).toMatch(/ponieważ/);
  });

  it('a plain sentence with no qualifying value yields nothing', () => {
    const facts = extractKeyFacts([userText('Thanks, that all sounds good to me.')], sha256);
    expect(facts).toHaveLength(0);
  });
});

describe('key-facts: dotted host/domain token and copula-led proper noun (round 20, brief-s4a-fix20.md item 1, real A/B evidence: the main A/B run showed every S4 chain scoring 35 lost exactly these 3 facts)', () => {
  it.each([
    ['The metrics dashboard is hosted at kestrel-dash.internal.', 'kestrel-dash.internal'],
    ['The log shipper we run is Rillwater.', 'Rillwater'],
    ['The translations vendor is Polyglotta.', 'Polyglotta'],
  ])('%s is kept (real A/B evidence sentence)', (sentence, needle) => {
    const facts = extractKeyFacts([userText(sentence)], sha256);
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toBe(sentence);
    expect(facts[0].text).toContain(needle);
  });

  it('a dotted host token elsewhere in a sentence also qualifies', () => {
    const facts = extractKeyFacts([userText('You can ping api.example.com for a status check.')], sha256);
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toContain('api.example.com');
  });

  it.each([
    ['The staging port is 4821.', 'The staging port is Open.'],
    ['The deadline is 2026-11-19.', 'The deadline is Tight.'],
    ['The dashboard is at kestrel-dash.internal.', 'The dashboard is Slow.'],
  ])('a copula-only status value does not supersede stronger evidence: %s then %s', (strong, weak) => {
    const facts = extractKeyFacts([userText(strong), userText(weak)], sha256);
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toBe(strong);
    expect(facts[0].correctedAtSeq).toBeUndefined();
  });

  it.each([
    'We use Rillwater for logs.',
    'We run Rillwater.',
    'I use Neovim.',
  ])('a pronoun subject with use/run and a proper noun is kept: %s', (sentence) => {
    const facts = extractKeyFacts([userText(sentence)], sha256);
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toBe(sentence);
  });

  it.each([
    'The language is TypeScript.',
    'The db is PostgreSQL.',
    'Our CEO is McDonald.',
  ])('a CamelCase or internally capitalized name after a copula is kept: %s', (sentence) => {
    const facts = extractKeyFacts([userText(sentence)], sha256);
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toBe(sentence);
  });

  it.each([
    'Done.Next one please',
    'Sounds good.Thanks!',
    'This works fine.The end.',
  ])('a missing-space sentence boundary is not read as a dotted host: %s', (sentence) => {
    expect(extractKeyFacts([userText(sentence)], sha256)).toHaveLength(0);
  });

  it.each(['Node.js', 'Next.js', 'kestrel-dash.internal', 'api.example.com'])('lowercase dotted labels still qualify: %s', (host) => {
    const facts = extractKeyFacts([userText(`The endpoint is ${host}.`)], sha256);
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toContain(host);
  });

  it('"e.g." alone (an abbreviation, not a host) does not qualify', () => {
    const facts = extractKeyFacts([userText('We often say e.g. in emails.')], sha256);
    expect(facts).toHaveLength(0);
  });

  it('"i.e." alone (an abbreviation, not a host) does not qualify', () => {
    const facts = extractKeyFacts([userText('That book, i.e. the manual, helped a lot.')], sha256);
    expect(facts).toHaveLength(0);
  });

  it('a plain sentence-final period after a dotted token is not swallowed into it, and does not itself create a false host', () => {
    const facts = extractKeyFacts([userText('U.S. policy did not change.')], sha256);
    expect(facts).toHaveLength(0);
  });

  it('a decimal number (no letters) is not read as a dotted host', () => {
    const facts = extractKeyFacts([userText('The measured ratio was roughly 3.14 today.')], sha256);
    expect(facts).toHaveLength(0);
  });

  it.each([
    'That is Great.',
    'I am Sure.',
    'This is Fine.',
    'It is Ready.',
    'There is Progress.',
    'We are Done.',
  ])('chatter, not a fact: %s stays DROP', (sentence) => {
    const facts = extractKeyFacts([userText(sentence)], sha256);
    expect(facts).toHaveLength(0);
  });
});

describe('key-facts: source restriction (user and file_write only, never a tool result or assistant text)', () => {
  it('an assistant_text record with a qualifying value is not scanned', () => {
    const facts = extractKeyFacts([record({ kind: 'assistant_text', body: { text: 'The port is 4821 and the deadline is 2026-11-19.' } })], sha256);
    expect(facts).toHaveLength(0);
  });

  it('a gate/error record with a qualifying value is not scanned', () => {
    const facts = extractKeyFacts([record({ kind: 'error', body: { text: 'Failed on port 4821 at 2026-11-19, isError true.' } })], sha256);
    expect(facts).toHaveLength(0);
  });

  it('a file_write record (Write/Edit tool_use input text) is scanned', () => {
    const facts = extractKeyFacts([fileWriteText('Ticket: KESTREL-9. Owner: Marek Nowak.')], sha256);
    expect(facts.map((f) => f.text).join(' ')).toContain('KESTREL-9');
    expect(facts.map((f) => f.text).join(' ')).toContain('Marek Nowak');
  });

  it('user and file_write records interleave in the single chronological order the caller provides', () => {
    const facts = extractKeyFacts(
      [userText('Codename: FALCON-1.'), fileWriteText('Ticket: OPS-42.'), userText('Owner: Ola Wrona.')],
      sha256,
    );
    expect(facts.map((f) => f.seq)).toEqual([1, 2, 3]);
  });
});

describe('key-facts: corrections (brief item 1, "a later sentence... on the same subject... supersedes")', () => {
  it('supersedes corrected A/B settings despite optional ids, articles, and explicit supersession wording', () => {
    const records = [
      userText('F04: The webhook retry limit is 4 attempts.'),
      userText('F05: Status badge label is read-only.'),
      userText('F16: Error-rate alert threshold is 0.08.'),
      userText('F20: Read replica count is 6 replicas.'),
      userText('The code review reconciled four project settings. F04 The webhook retry limit is now 2 attempts because the extra retries caused duplicate webhook writes. F05 The status badge label is now readonly because the UI string table uses the unhyphenated label. F16 The error-rate alert threshold is now 0.06 because the load-test report superseded the earlier estimate. F20 The read replica count is now 9 replicas because the load test found three regions without a local replica. These updates supersede the earlier values. Revoke project rule A for Nacre; keep unrelated project rule B for Opal. Apply these changes in the current work plan.'),
    ];
    const facts = extractKeyFacts(records, sha256);
    const rendered = renderKeyFactsSection(applyKeyFactsOverflow(facts, countTokens, sha256, 1500).rendered);
    for (const [current, old] of [['readonly', 'read-only'], ['0.06', '0.08'], ['9 replicas', '6 replicas']] as const) {
      expect(rendered.match(new RegExp(current, 'g')) ?? []).toHaveLength(1);
      expect(rendered).not.toContain(old);
    }
    expect(rendered).toContain('2 attempts');
    expect(facts.find((fact) => fact.text.includes('readonly'))?.correctedAtSeq).toBeDefined();
  });

  it('does not supersede a subject when an unrelated later sentence only shares a word', () => {
    const facts = extractKeyFacts([
      userText('The service timeout is 30s.'),
      userText('The service deadline is 2026-12-15.'),
    ], sha256);
    expect(facts).toHaveLength(2);
    expect(facts.some((fact) => fact.text.includes('30s'))).toBe(true);
  });

  it('review-opus-s4e P1: a leading item id is part of the subject, so different ids never merge', () => {
    const pairs = [
      ['Q3 budget is 4,000 EUR.', 'Q4 budget is 5,000 EUR.'],
      ['P1 owner is alice@example.com.', 'P2 owner is bob@example.com.'],
      ['F05: Status badge label is read-only.', 'F06: Status badge label is 12px.'],
    ];
    for (const [first, second] of pairs) {
      const facts = extractKeyFacts([userText(first), userText(second)], sha256);
      expect(facts.map((fact) => fact.text)).toEqual([first, second]);
      expect(facts.every((fact) => fact.correctedAtSeq === undefined)).toBe(true);
    }
  });

  it('review-opus-s4e P3: the earliest separator wins over a later "changed to"', () => {
    const facts = extractKeyFacts([
      userText('The port is 3000.'),
      userText('The port is 4000 after the default changed to IPv6.'),
    ], sha256);
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toContain('4000');
  });

  it('recognizes the explicit "X changed to Y" correction form', () => {
    const facts = extractKeyFacts([
      userText('F05: The status badge label is read-only.'),
      userText('F05 The status badge label changed to readonly because the UI string table is unhyphenated.'),
    ], sha256);
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toContain('changed to readonly');
    expect(facts[0].correctedAtSeq).toBeDefined();
  });

  it('a later statement on the same colon-delimited subject with a different value supersedes the earlier one, tagged (updated)', () => {
    const facts = extractKeyFacts(
      [userText('Deadline: 2026-11-19.'), userText('Some unrelated filler text with no signal at all.'), userText('Deadline: 2026-11-25.')],
      sha256,
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toContain('2026-11-25');
    expect(facts[0].correctedAtSeq).toBe(2);
    const rendered = applyKeyFactsOverflow(facts, countTokens, sha256, 1500);
    expect(renderKeyFactsSection(rendered.rendered)).toContain('2026-11-25. (updated)');
    expect(renderKeyFactsSection(rendered.rendered)).not.toMatch(/\[seq=|seq \d/);
  });

  it('the original fact\'s own seq (first-stated position) is kept distinct from the correcting seq', () => {
    const facts = extractKeyFacts(
      [userText('Port: 4821.'), userText('Port: 4900.')],
      sha256,
    );
    expect(facts[0].seq).toBe(1);
    expect(facts[0].correctedAtSeq).toBe(2);
  });

  it('an identical sentence repeated verbatim is deduped, not treated as a correction', () => {
    const facts = extractKeyFacts([userText('Deadline: 2026-11-19.'), userText('Deadline: 2026-11-19.')], sha256);
    expect(facts).toHaveLength(1);
    expect(facts[0].correctedAtSeq).toBeUndefined();
  });

  describe('the "changed from OLD to NEW" idiom (real A/B evidence reproduction, round 17 finding)', () => {
    // `fixtures/round15-large-capture.ndjson` records 8/10/12 state corrections this way: a single
    // sentence carrying both the old and the new value, prefixed with a generic bullet + label
    // ("- Update: ..."). Reproduced here at unit scope. This was a genuine bug found by running the
    // extractor against that fixture directly (not a hand-written case guessed in advance): before
    // the `CHANGED_FROM`/`LEADING_LABEL` handling in `subjectKey`, every "- Update: ..." bullet's
    // subject collapsed to the same "- update" bucket (the colon right after the label word was the
    // first separator found), so the three unrelated corrections (deadline/budget/region) chained
    // onto EACH OTHER instead of onto the plain declarative fact that first stated the old value,
    // and the true corrections (new deadline, new budget) never appeared in the output at all while
    // the stale originals stayed unflagged. `core/key-facts.ts` strips a leading bullet/label prefix
    // ("- Update:", "Note:", ...) before deriving the subject from the text preceding "changed from",
    // so the subject lines up with the one the original plain-declarative sentence already used.
    it('a same-sentence "X changed from OLD to NEW because REASON" corrects an earlier plain declarative fact on the same subject', () => {
      const facts = extractKeyFacts(
        [
          userText('The hard delivery deadline is 2026-11-19.'),
          userText('Some unrelated filler text with no signal at all.'),
          userText('- Update: the hard delivery deadline changed from 2026-11-19 to 2026-12-03 because the payment provider certification slipped.'),
        ],
        sha256,
      );
      expect(facts).toHaveLength(1);
      expect(facts[0].text).toContain('2026-12-03');
      expect(facts[0].text).toContain('changed from 2026-11-19');
      expect(facts[0].seq).toBe(1);
      // The filler sentence in between carries no qualifying signal, so it never increments `seq`
      // (seq is scoped to qualifying sentences only, see `core/key-facts.ts`); the correction is
      // seq 2, not seq 3.
      expect(facts[0].correctedAtSeq).toBe(2);
    });

    it('three distinct "- Update:" bullets on three distinct subjects do not chain onto each other (the round-17 bug, reproduced as a negative)', () => {
      const facts = extractKeyFacts(
        [
          userText('The hard delivery deadline is 2026-11-19.'),
          userText('The approved budget for this phase is 3,470 EUR.'),
          userText('- Update: the hard delivery deadline changed from 2026-11-19 to 2026-12-03 because the payment provider certification slipped.'),
          userText('- Update: the approved budget for this phase changed from 3,470 EUR to 4,120 EUR because the audit scope grew.'),
          userText('- Update: the primary deployment region changed from eu-central-2 to eu-north-1 because of the data residency contract.'),
        ],
        sha256,
      );
      // Three subjects survive (deadline, budget, and the region fact introduced fresh by its own
      // update sentence, with no earlier plain statement of its own), not one collapsed "- update".
      expect(facts).toHaveLength(3);
      const deadline = facts.find((f) => f.text.includes('2026-12-03'));
      const budget = facts.find((f) => f.text.includes('4,120 EUR'));
      const region = facts.find((f) => f.text.includes('eu-north-1'));
      expect(deadline, 'the deadline correction must be its own fact, not merged into the budget or region bullet').toBeDefined();
      expect(budget, 'the budget correction must be its own fact, not merged into the deadline or region bullet').toBeDefined();
      expect(region, 'the region statement must be its own fact, not merged into the deadline or budget bullet').toBeDefined();
      expect(deadline!.correctedAtSeq).toBeDefined();
      expect(budget!.correctedAtSeq).toBeDefined();
      // Region has no earlier plain statement of its own in this fixture, so it is a new fact, not
      // a correction of anything.
      expect(region!.correctedAtSeq).toBeUndefined();
    });
  });
});

describe('key-facts: chronological order and dedupe', () => {
  it('facts render in the order their subjects were first introduced, tagged with their own seq', () => {
    const facts = extractKeyFacts(
      [userText('Codename: FALCON-1.'), userText('Budget: $3400.'), userText('Deadline: 2026-11-19.')],
      sha256,
    );
    expect(facts.map((f) => f.seq)).toEqual([1, 2, 3]);
    const rendered = applyKeyFactsOverflow(facts, countTokens, sha256, 1500);
    const body = renderKeyFactsSection(rendered.rendered);
    expect(body.indexOf('FALCON-1')).toBeLessThan(body.indexOf('3400'));
    expect(body.indexOf('3400')).toBeLessThan(body.indexOf('2026-11-19'));
  });
});

describe('key-facts: overflow (brief item 1, "keep the OLDEST facts plus the latest corrections")', () => {
  it('when over budget, a correction is protected outright and never converted to a pointer', () => {
    const records: CaptureRecord[] = [];
    for (let n = 1; n <= 40; n++) records.push(userText(`Fact number ${n}: value is ${1000 + n}.`));
    records.push(userText('Fact number 1: value is 9999.'));
    const facts = extractKeyFacts(records, sha256);
    const corrected = facts.find((f) => f.correctedAtSeq !== undefined);
    expect(corrected).toBeDefined();
    const tinyBudget = 200;
    const result = applyKeyFactsOverflow(facts, countTokens, sha256, tinyBudget);
    const correctedRendered = result.rendered.find((r) => r.seq === corrected!.seq);
    expect(correctedRendered!.isPointer).toBe(false);
  });

  it('among never-corrected facts, the oldest are kept and the newest are omitted behind one line (3.13.0: no pointers)', () => {
    // Long sentences, so a rendered fact line (proportional to sentence length) is reliably
    // bigger than its fixed-size `[pointer seq=<n> sha256=<64-hex>]` replacement -- with short
    // facts the pointer line (its sha256 alone is 64 hex chars) can be no smaller than the
    // original, and conversion would never bring the total under budget at all.
    const records: CaptureRecord[] = [];
    for (let n = 1; n <= 40; n++) {
      records.push(userText(`Fact number ${n} states that the relevant configuration value for this subsystem, which several downstream teams depend on for correct behavior, is exactly ${1000 + n} and must not be changed without updating every downstream service config that reads it.`));
    }
    const facts = extractKeyFacts(records, sha256);
    const budget = 1500;
    const result = applyKeyFactsOverflow(facts, countTokens, sha256, budget);
    expect(result.overflowCount).toBe(0);
    expect(result.omittedCount).toBeGreaterThan(0);
    expect(result.omittedCount).toBeLessThan(40);
    const first = result.rendered[0];
    const last = result.rendered[result.rendered.length - 1];
    expect(first.isPointer).toBe(false);
    expect(first.line).toContain('Fact number 1 ');
    expect(last.line).toBe(`[${result.omittedCount} key facts omitted over budget; use recall or the transcript]`);
    expect(result.rendered.some((r) => /\[pointer /.test(r.line))).toBe(false);
    expect(countTokens(renderKeyFactsSection(result.rendered))).toBeLessThanOrEqual(budget);
  });

  it('an entry set already within budget is left entirely alone (no pointer at all)', () => {
    const facts = extractKeyFacts([userText('Deadline: 2026-11-19.'), userText('Budget: $3400.')], sha256);
    const result = applyKeyFactsOverflow(facts, countTokens, sha256, 1500);
    expect(result.overflowCount).toBe(0);
    expect(result.rendered.every((r) => !r.isPointer)).toBe(true);
  });

  describe('the "Files the user pointed at" line is not the first thing reduced (round 19, brief-s4a-fix19.md F17, review-opus-r18.md finding F17)', () => {
    it('the files line, which always carries the highest seq, is exempt from ever becoming a pointer', () => {
      const records: CaptureRecord[] = [];
      for (let n = 1; n <= 40; n++) {
        records.push(userText(`Fact number ${n} states that the relevant configuration value for this subsystem, which several downstream teams depend on for correct behavior, is exactly ${1000 + n} and must not be changed without updating every downstream service config that reads it.`));
      }
      records.push(userText('Also read the file facts/seed-extra.txt and remember it.'));
      const facts = extractKeyFacts(records, sha256);
      const filesFact = facts.find((f) => f.subject === '__files__');
      expect(filesFact, 'the files line must exist and carry the highest seq of any fact').toBeDefined();
      expect(filesFact!.seq).toBe(Math.max(...facts.map((f) => f.seq)));
      // A budget tight enough that, before the fix, the files line (highest seq, so first in the
      // newest-first loop) would be the very first thing pointerized.
      const result = applyKeyFactsOverflow(facts, countTokens, sha256, 1500);
      expect(result.omittedCount).toBeGreaterThan(0);
      const filesRendered = result.rendered.find((r) => r.seq === filesFact!.seq);
      expect(filesRendered!.isPointer, 'the files line must never be turned into a pointer').toBe(false);
      expect(filesRendered!.line).toContain('facts/seed-extra.txt');
    });

    it('a fact is never pointerized when its pointer line would not actually be shorter than the fact itself', () => {
      const records: CaptureRecord[] = [];
      for (let n = 1; n <= 5; n++) records.push(userText(`Fact ${n}: value ${1000 + n}.`));
      const facts = extractKeyFacts(records, sha256);
      // A short fact's rendered line is far shorter than a `[pointer seq=<n> sha256=<64-hex>]` line
      // (the sha256 alone is 64 hex characters), so converting it would only grow the section.
      const total = facts.reduce((sum, f) => sum + countTokens(`> ${f.text} [seq=${f.seq}]`), 0);
      const result = applyKeyFactsOverflow(facts, countTokens, sha256, Math.max(1, total - 1));
      expect(result.rendered.every((r) => !/sha256=/.test(r.line))).toBe(true);
    });

    it('S4e real-session replay: hundreds of short facts still fit the budget (omitted, not pointerized)', () => {
      // Replay of a real 13 MB session (2026-09-27): 1614 short key facts and zero
      // pointers, because every pointer was longer than its fact, so the section reached ~51k
      // tokens against a 1500 budget. Short facts past the budget are omitted behind one line.
      const records: CaptureRecord[] = [];
      for (let n = 1; n <= 600; n++) records.push(userText(`Setting ${n}: value ${1000 + n}.`));
      const facts = extractKeyFacts(records, sha256);
      const result = applyKeyFactsOverflow(facts, countTokens, sha256, 1500);
      const section = renderKeyFactsSection(result.rendered);
      expect(countTokens(section)).toBeLessThanOrEqual(1500);
      expect(section).toMatch(/key facts omitted over budget; use recall or the transcript/);
      expect(section).toContain('Setting 1: value 1001.');
      expect(result.omittedCount).toBeGreaterThan(0);
    });

    it('review-opus-s4e P1: many corrections alone may not blow the budget; the newest survive', () => {
      const records: CaptureRecord[] = [];
      for (let n = 1; n <= 300; n++) records.push(userText(`Service ${n} port is ${3000 + n}.`));
      for (let n = 1; n <= 300; n++) records.push(userText(`Service ${n} port is ${5000 + n}.`));
      const facts = extractKeyFacts(records, sha256);
      expect(facts.filter((fact) => fact.correctedAtSeq !== undefined).length).toBe(300);
      const result = applyKeyFactsOverflow(facts, countTokens, sha256, 1500);
      const section = renderKeyFactsSection(result.rendered);
      expect(countTokens(section)).toBeLessThanOrEqual(1500);
      expect(section).toContain('Service 300 port is 5300.');
      expect(section).not.toContain('Service 1 port is 5001.');
      expect(section).toMatch(/key facts omitted over budget/);
    });

    it('S4e real-session replay: pointers alone may not blow the budget either', () => {
      const records: CaptureRecord[] = [];
      for (let n = 1; n <= 400; n++) {
        records.push(userText(`Fact number ${n} states that the relevant configuration value for this subsystem, which several downstream teams depend on for correct behavior, is exactly ${1000 + n} and must not be changed without updating every downstream service config that reads it.`));
      }
      const facts = extractKeyFacts(records, sha256);
      const result = applyKeyFactsOverflow(facts, countTokens, sha256, 1500);
      expect(countTokens(renderKeyFactsSection(result.rendered))).toBeLessThanOrEqual(1500);
      expect(result.rendered[0].isPointer).toBe(false);
    });
  });
});

describe('key-facts: seed-of-seed, a fact kept by an earlier compaction is not lost by a later one (brief item 1)', () => {
  it('compaction #3\'s extraction, given the SAME accumulated records list compaction #1 saw plus new ones, still contains the fact compaction #1 kept', () => {
    // Mirrors `host/fs-adapter.ts`'s real behaviour cited in CONTRACT.md's round 17 section: the
    // capture store never prunes old segments, so every compaction's `latest.values()` includes
    // everything every earlier compaction saw, plus whatever is new. This test stands in for that
    // full pipeline at the `core/key-facts.ts` layer, which is what this module can see directly.
    const atCompactionOne: CaptureRecord[] = [userText('Codename: FALCON-1.'), userText('Owner: Ola Wrona.')];
    const factsAtOne = extractKeyFacts(atCompactionOne, sha256);
    expect(factsAtOne.map((f) => f.text).join(' ')).toContain('FALCON-1');

    const atCompactionTwo = [...atCompactionOne, userText('Filler turn with no signal.'), userText('Ticket: OPS-42.')];
    const atCompactionThree = [...atCompactionTwo, userText('Another filler turn.'), userText('Region is eu-central-2.')];
    const factsAtThree = extractKeyFacts(atCompactionThree, sha256);
    expect(factsAtThree.map((f) => f.text).join(' ')).toContain('FALCON-1');
    expect(factsAtThree.map((f) => f.text).join(' ')).toContain('Ola Wrona');
    expect(factsAtThree.map((f) => f.text).join(' ')).toContain('OPS-42');
    expect(factsAtThree.map((f) => f.text).join(' ')).toContain('eu-central-2');
  });
});

describe('key-facts: negative cases, pasted content yields zero or near-zero facts', () => {
  // Same real fixture and sizing as `constraints.gate.test.ts`'s B1 hardening describe block
  // (the A/B harness's `lib/script.ts` filler source and TURN_CHARS), read directly so
  // this is the exact real content the round-13-onward gate has run against, not a hand copy.
  const fillerSource = readFileSync(require.resolve('typescript/lib/lib.dom.d.ts'), 'utf8');
  const TURN_CHARS = Math.round(15_000 * 3.3);

  function fillerChunk(n: number): string {
    return fillerSource.slice((n - 1) * TURN_CHARS, n * TURN_CHARS);
  }

  it('a large pasted .d.ts chunk (code fence via <<<PART ... >>> wrapper) yields at most a few facts, listed here', () => {
    const pasted = `<<<PART 1 START>>>\n${fillerChunk(1)}\n<<<PART 1 END>>>`;
    const facts = extractKeyFacts([userText(pasted)], sha256);
    // Round 17 finding (brief-s4a-fix17.md item 3, "round 13 filler fixture yields at most a few
    // facts, which you list"): the wrapper line itself is fence-stripped (`stripFencedContent`,
    // reused from `core/constraints.ts`), so nothing inside the `<<<PART ... >>>` markers reaches
    // scanning at all; this chunk yields exactly zero, listed here as the empty list it is.
    expect(facts).toHaveLength(0);
  });

  it('a licence header (the .d.ts file\'s own top-of-file block comment, pasted on its own, not inside a fence) yields zero facts', () => {
    const headerEnd = fillerSource.indexOf('*/') + 2;
    const header = fillerSource.slice(0, headerEnd);
    expect(header).toMatch(/Copyright|License|LICENSE/i);
    expect(header.startsWith('/*')).toBe(true);
    expect(header.endsWith('*/')).toBe(true);
    const facts = extractKeyFacts([userText(header)], sha256);
    expect(facts).toHaveLength(0);
  });

  it('a log dump (many short timestamped lines, no blank line between them) yields zero facts: one over-cap non-bullet paragraph, excluded as a whole', () => {
    const lines: string[] = [];
    for (let n = 0; n < 30; n++) lines.push(`2026-09-26 10:${String(n).padStart(2, '0')}:00 INFO worker-${n} handled request ${1000 + n}`);
    const facts = extractKeyFacts([userText(lines.join('\n'))], sha256);
    expect(facts).toHaveLength(0);
  });
});

describe('key-facts: HELD-OUT fixture (anti-overfit, brief item 3)', () => {
  // Anti-overfit intent (brief item 3): a synthetic bilingual PL/EN conversation with facts, a
  // domain and a vocabulary entirely disjoint from the A/B evidence's fact bank
  // (the A/B harness's `inputs/facts-hard.json`: codename/port/owner/budget/deadline/ticket/
  // codeword/file/nightly/qaLead/region, all software-project-shaped) -- this fixture is a
  // marketing-campaign scenario instead (campaign name, budget, date, contact name, meeting time,
  // a brief file path, a slogan, a reason), so passing it cannot be explained by the extractor
  // having been keyed to the evidence's own tokens or structure. Honesty note (documented per this
  // brief's own "report a gap rather than guess silently" convention, same as the LIFO revocation
  // note in `core/constraints.ts`): this fixture was written in the same implementation pass as
  // the extractor itself, not literally before it existed, so it cannot fully substitute for a
  // fixture written by a separate hand at a separate time; its anti-overfit value here rests on
  // the deliberate disjointness of its vocabulary/domain/language mix from the tuning evidence,
  // not on a verified authorship order.
  it('every fact in a from-scratch bilingual PL/EN marketing-campaign turn is extracted', () => {
    const turn = [
      'Nazwa kampanii to REDBIRD-4.',
      'Budżet wynosi $12500 total.',
      'Termin: 2027-03-15.',
      'Kontakt: Anna Kowalska.',
      'Spotkanie o 10:15.',
      'Plik z briefem jest w campaign/brief-redbird.txt.',
      'Wybraliśmy TikTok, ponieważ dociera do młodszej grupy odbiorców.',
      'Hasło promocji to "Lot do gwiazd".',
    ].join(' ');
    const facts = extractKeyFacts([userText(turn)], sha256);
    const joined = facts.map((f) => f.text).join(' | ');
    expect(joined).toContain('REDBIRD-4');
    expect(joined).toContain('$12500');
    expect(joined).toContain('2027-03-15');
    expect(joined).toContain('Anna Kowalska');
    expect(joined).toContain('10:15');
    expect(joined).toContain('campaign/brief-redbird.txt');
    expect(joined).toMatch(/ponieważ/);
    expect(joined).toContain('"Lot do gwiazd"');
  });

  it('a later correction on the same colon subject supersedes, in this held-out fixture too', () => {
    const facts = extractKeyFacts(
      [userText('Termin: 2027-03-15.'), userText('Nowa wiadomość bez żadnych faktów.'), userText('Termin: 2027-03-22.')],
      sha256,
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toContain('2027-03-22');
    expect(facts[0].correctedAtSeq).toBe(2);
  });
});

describe('key-facts: instructions and questions are filtered out (round 18, brief-s4a-fix18.md Q1/F1, review-opus-r17.md finding Q1/F1)', () => {
  it.each([
    'Also read the file notes/a.txt and remember it.',
    'Run npm test in packages/api because CI is flaky.',
    'Please fix the bug in src/app.ts.',
    'Use v2 of the API.',
    'Is it 3pm yet?',
  ])('%s yields zero facts', (sentence) => {
    const facts = extractKeyFacts([userText(sentence)], sha256);
    expect(facts.filter((f) => f.subject !== '__files__')).toHaveLength(0);
  });

  it('a skipped instruction\'s file path still survives, harvested into a single "Files the user pointed at" fact', () => {
    const facts = extractKeyFacts(
      [
        userText('Also read the file facts/seed-extra.txt in this directory and remember its contents as project facts too.'),
        userText('Some unrelated filler text with no signal at all.'),
        userText('Also read the file facts/turn-3-notes.txt in this directory (a project-notes update) and remember its contents for later.'),
      ],
      sha256,
    );
    const filesFact = facts.find((f) => f.text.startsWith('Files the user pointed at:'));
    expect(filesFact, 'seed-extra.txt survives in the files line').toBeDefined();
    expect(filesFact!.text).toContain('facts/seed-extra.txt');
    expect(filesFact!.text).toContain('facts/turn-3-notes.txt');
  });

  it('a declarative sentence with a file path (not an instruction) is kept as a normal fact, not routed to the files line', () => {
    const facts = extractKeyFacts([userText('The extra notes are kept in facts/turn-1-notes.txt for reference.')], sha256);
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toContain('facts/turn-1-notes.txt');
    expect(facts[0].subject).not.toBe('__files__');
  });

  it('a genuine declarative fact right next to a filtered instruction is still extracted (the instruction filter is per-sentence, not per-record)', () => {
    const facts = extractKeyFacts(
      [userText('Please fix the bug in src/app.ts. The staging port is 48213.')],
      sha256,
    );
    expect(facts.some((f) => f.text.includes('48213'))).toBe(true);
  });
});

describe('key-facts: imperative-opener false positives (round 19, brief-s4a-fix19.md F14, review-opus-r18.md finding F14)', () => {
  // Each of these opens with a word `IMPERATIVE_OPENER` also treats as a command verb ("start",
  // "list", "check", "change", "read", "return", "set", "keep"), but every sentence here is a plain
  // declarative fact ("NOUN is/are/opens/begins/lives ..."), not a request. Before the fix these all
  // yielded zero facts and no path harvest, silently dropping real facts from the seed.
  it.each([
    ['Start date is 2026-11-19.', '2026-11-19'],
    ['List price is 400 EUR.', '400 EUR'],
    ['Check-in time is 15:00.', '15:00'],
    ['Change freeze begins on 2026-11-19.', '2026-11-19'],
    ['Read replicas live in eu-central-2.', 'eu-central-2'],
    ['Return window is 300 days.', '300'],
    ['Set size is 48213 rows.', '48213'],
    ['Keep-alive timeout is 75s.', '75s'],
  ])('%s is kept as a declarative fact, not filtered as an instruction', (sentence, needle) => {
    const facts = extractKeyFacts([userText(sentence)], sha256);
    expect(facts.filter((f) => f.subject !== '__files__')).toHaveLength(1);
    expect(facts[0].text).toBe(sentence);
    expect(facts[0].text).toContain(needle);
  });

  it('a genuine instruction opening with the same verb is still filtered (the fix is not a blanket exemption)', () => {
    const facts = extractKeyFacts([userText('Check the deployment logs in packages/api/server.ts for errors.')], sha256);
    expect(facts.filter((f) => f.subject !== '__files__')).toHaveLength(0);
  });
});

describe('key-facts: subject-key fixes (round 18, brief-s4a-fix18.md Q1/F1 follow-up, review-opus-r17.md simulated bugs)', () => {
  it('a "Note:"-prefixed fact keys to its real subject, not a shared "note" bucket, so two distinct Note: facts both survive', () => {
    const facts = extractKeyFacts(
      [userText('Note: the staging port is 48213.'), userText('Note: the primary owner is Marek Nowak.')],
      sha256,
    );
    expect(facts).toHaveLength(2);
    expect(facts.some((f) => f.text.includes('48213'))).toBe(true);
    expect(facts.some((f) => f.text.includes('Marek Nowak'))).toBe(true);
  });

  it('a later "Note:"-prefixed sentence on the same real subject as an earlier plain fact still supersedes it', () => {
    const facts = extractKeyFacts(
      [userText('The staging port is 48213.'), userText('Note: the staging port is 48900.')],
      sha256,
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toContain('48900');
    expect(facts[0].correctedAtSeq).toBe(2);
  });

  it('two unrelated "It is ..." sentences do not collide on the shared pronoun subject', () => {
    const facts = extractKeyFacts(
      [userText('It is 3400 dollars for the venue deposit.'), userText('It is 48213 for the staging port.')],
      sha256,
    );
    expect(facts).toHaveLength(2);
    expect(facts.some((f) => f.text.includes('3400'))).toBe(true);
    expect(facts.some((f) => f.text.includes('48213'))).toBe(true);
  });

  it('two clock-time sentences with the SAME text before the digit-adjacent colon do not collide on it (round 19, brief-s4a-fix19.md F13, review-opus-r18.md finding F13: the old version of this test used two sentences with different text before their first colon, "Daily standup happens at 09:00 sharp." vs. "The next release window opens at 09:30.", so it passed even on the pre-round-18 bare-`:` bug -- neither sentence ever exercised the actual collision, since their pre-colon text already differed for reasons unrelated to the fix. This version reproduces the real round-17 case: both sentences open with the same words up to the shared hour "09", so a bare `:` separator reads both as the identical subject "at 09")', () => {
    const facts = extractKeyFacts(
      [userText('At 09:00 the deploy window opens.'), userText('At 09:30 the review window opens.')],
      sha256,
    );
    expect(facts).toHaveLength(2);
    expect(facts.some((f) => f.text.includes('09:00'))).toBe(true);
    expect(facts.some((f) => f.text.includes('09:30'))).toBe(true);
  });

  it('a value restated back to an earlier value after being corrected is treated as a new correction, not silently dropped (F1 point 4)', () => {
    const facts = extractKeyFacts(
      [
        userText('The staging port is 48213.'),
        userText('The staging port is 48900.'),
        userText('The staging port is 48213.'),
      ],
      sha256,
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toContain('48213');
    expect(facts[0].correctedAtSeq).toBe(3);
  });
});

describe('key-facts: perf gate, extractKeyFactsChunked yields during extraction (round 18, brief-s4a-fix18.md F6, like the round-15 gate in compact.gate.test.ts)', () => {
  const PROBE_INTERVAL_MS = 15;
  const MAX_BLOCK_BUDGET_MS = 1000;
  const FACT_COUNT = 60000;

  /** Real `setInterval` lag probe (not a vitest fake timer), same technique as
   * `compact.gate.test.ts`'s round-15 perf gate: the gap between an interval firing and when it
   * was scheduled to fire is exactly how long something else held the event loop. */
  function startLagProbe(): { stop: () => number } {
    let maxLag = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const lag = now - last - PROBE_INTERVAL_MS;
      if (lag > maxLag) maxLag = lag;
      last = now;
    }, PROBE_INTERVAL_MS);
    return {
      stop: () => {
        clearInterval(timer);
        return maxLag;
      },
    };
  }

  /** A large, bullet-shaped capture (round 16's per-bullet scanning keeps every line even though
   * the whole paragraph is far past `MAX_PARAGRAPH_CHARS`), each bullet its own distinct fact
   * subject so none of them collide or supersede each other, tens of thousands of sentences deep
   * -- large enough that the pre-round-18 unchunked scan is a multi-hundred-millisecond-plus
   * synchronous stretch reproduced offline against this same fixture shape. */
  function largeKeyFactsCapture(): CaptureRecord {
    const lines = Array.from({ length: FACT_COUNT }, (_, i) => `- Fact number ${i} is exactly ${1000 + i}.`);
    return record({ kind: 'user', body: { text: lines.join('\n') } });
  }

  it('extractKeyFactsChunked never blocks the event loop for more than ~1s at a time on a large capture, and still returns every fact', async () => {
    const records = [largeKeyFactsCapture()];
    const onYield = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    const probe = startLagProbe();
    const facts = await extractKeyFactsChunked(records, sha256, onYield);
    const maxBlockMs = probe.stop();

    expect(facts).toHaveLength(FACT_COUNT);
    expect(
      maxBlockMs,
      `the longest single stretch extractKeyFactsChunked blocked the event loop (measured by a real ${PROBE_INTERVAL_MS}ms setInterval lag probe) was ${maxBlockMs.toFixed(1)}ms against a ${FACT_COUNT}-fact capture; budget is ${MAX_BLOCK_BUDGET_MS}ms (brief-s4a-fix18.md F6)`,
    ).toBeLessThan(MAX_BLOCK_BUDGET_MS);
  }, 20_000); // the guard is the 1 s block above; a Windows laptop took 4.6 s unloaded and over 5 s under load

  it('extractKeyFactsChunked produces the exact same facts as the all-at-once extractKeyFacts, on the same input', async () => {
    const records = [
      userText('Deadline: 2026-11-19.'),
      userText('Also read the file notes/a.txt and remember it.'),
      userText('Deadline: 2026-11-25.'),
    ];
    const sync = extractKeyFacts(records, sha256);
    const chunked = await extractKeyFactsChunked(records, sha256, async () => {});
    expect(chunked).toEqual(sync);
  });
});

describe('renderKeyFactsSection: plain join, one line per rendered fact', () => {
  it('renders (none) upstream when there are no facts (empty body, same convention as every other seed section)', () => {
    const result = applyKeyFactsOverflow([], countTokens, sha256, 1500);
    expect(renderKeyFactsSection(result.rendered)).toBe('');
  });
});
