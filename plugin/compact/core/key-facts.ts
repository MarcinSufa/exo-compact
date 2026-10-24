import { matchesAnyMarker, markerRegex, normalizeForDedup, scannableParagraphs, splitSentences } from './constraints.js';
import type { CaptureRecord, Hasher, TokenCounter } from './types.js';

/**
 * Section "Key facts" (spec v3.3 §3.1.3, round 17, brief-s4a-fix17.md). Why: the A/B evidence
 * shows plain small facts (a codename, a port, an owner, a budget, a deadline) stated once early
 * in a session and then never repeated, surviving as `user`/`file_write` capture records long
 * after the turn that stated them scrolls out of the tail -- exactly the material section 0
 * (constraints) already protects for modal/prohibition sentences, but constraints only fires on
 * `never`/`always`/`must`/... markers, not on a plain declarative fact. This section is that same
 * protection for facts.
 *
 * Sources (brief item 1 "Source"): `user` records (this module skips the same S2 command-wrapper
 * text `core/constraints.ts` skips, since that text is a filter of `extractConstraints`'s own
 * caller and is invisible to a `kind: 'user'` record already -- see `core/extractor.ts`'s
 * `isCcCommandWrapperText` check, which runs before a `kind: 'user'` record is ever created) and
 * `file_write` records (`core/extractor.ts`, round 17: the text of a `Write`/`Edit` tool_use
 * *input*, never a tool result -- a tool result is reachable through the transcript pointer
 * already, spec §3.1.2, and the brief is explicit that results are not a source here).
 */

/**
 * Candidate units are sentences (brief item 1), reusing `core/constraints.ts`'s own segmentation
 * (`scannableParagraphs` for the 600-char/8-line paragraph scan limits and per-bullet counting,
 * `splitSentences` for the `Intl.Segmenter`-or-regex sentence split) so a pasted file, log or code
 * fence is excluded from key-facts scanning exactly the same way it already is from constraints
 * scanning, and so the two modules cannot silently drift apart on what counts as "prose".
 */
const MAX_SENTENCE_CHARS = 240;
// A single review message can reconcile several short settings in one paragraph (>600 chars).
// Keep sentence scanning bounded, but admit that compact user-authored message as a whole.
const MAX_FACT_PARAGRAPH_CHARS = 1200;

/**
 * An identifier-like token: letters and digits mixed in one word (e.g. "PROJ2b", "b64f9a1"), or
 * the same mix across a hyphenated slug (e.g. "eu-central-2", a region/environment name): the
 * hyphen is allowed inside the token but the token must still start and end on a letter or digit,
 * and still needs at least one letter and one digit somewhere in it.
 */
const MIXED_ALNUM_TOKEN = /\b(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*[0-9])[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]\b/;

/** An UPPER-case token with a dash and digits (e.g. "KESTREL-7", "PROJ-1234"). */
const UPPER_DASH_DIGIT_TOKEN = /\b[A-Z]{2,}(?:-[A-Z0-9]+)*-[0-9]+\b/;

/** A number of 3+ digits (a port, a ticket number, a staging id, ...). */
const LONG_NUMBER = /\b[0-9]{3,}\b/;

/** A number with a unit or currency attached (a budget, a duration, a size). */
const NUMBER_WITH_UNIT = /\b[0-9]+(?:[.,][0-9]+)?\s?(?:ms|sec|secs|s|min|mins|hr|hrs|h|kb|mb|gb|tb|px|km|kg|k)\b/i;
// Polish cues: the plugin also reads rules written in Polish.
const CURRENCY = /[$€£]\s?[0-9]+(?:[.,][0-9]+)?(?:k|m)?\b|\b[0-9]+(?:[.,][0-9]+)?\s?(?:USD|EUR|GBP|PLN|zł)\b/i;

/** An ISO date (2026-09-26) or a clock time (14:30, 9:00am). */
const ISO_DATE = /\b[0-9]{4}-[0-9]{2}-[0-9]{2}\b/;
const CLOCK_TIME = /\b[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\s?(?:am|pm)?\b/i;

/** A file path: at least one `/` between path-like segments, not a bare protocol-less word. */
const FILE_PATH = /(?:^|[\s(])(?:[.~]{1,2})?\/(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,8}\b|(?:^|[\s(])(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8}\b/;

/** A quoted literal: straight or curly double/single quotes, or Polish „...". */
const QUOTED_LITERAL = /"[^"]+"|'[^']{2,}'|"[^"]+"|„[^"]+"/;

/**
 * A stated reason (brief item 1): the same EN/PL connective words the brief lists, matched as a
 * whole word/phrase via `core/constraints.ts`'s own `markerRegex` so "because" does not also match
 * inside an unrelated longer word.
 */
// Polish cues: the plugin also reads rules written in Polish.
const REASON_MARKERS: readonly string[] = ['because', 'so that', 'since', 'żeby', 'bo', 'ponieważ'];
const REASON_MARKER_REGEXES: readonly RegExp[] = REASON_MARKERS.map(markerRegex);

/**
 * A multi-word Capitalized name that is not sentence-initial-only (brief item 1): two or more
 * consecutive Capitalized words. "Sentence-initial-only" is read literally: a match starting at
 * the very first character of the (trimmed) sentence is exactly the case English capitalizes any
 * first word regardless of whether it is a name, so that position alone proves nothing; a match
 * starting anywhere else in the sentence is not explained by ordinary capitalization rules and so
 * is treated as a real multi-word proper name (a person, a team, a product).
 *
 * Title Case only (`[A-Z][a-z]+`, not `[A-Z][a-zA-Z]*`): an ALL-CAPS run ("THIS CODE IS PROVIDED",
 * a license header's own shouting-case boilerplate) is not how a real proper name is written in
 * running EN/PL prose, so it is excluded here rather than treated as a name; a genuine acronym
 * inside an otherwise-lowercase name (rare) is a known, accepted gap of this heuristic, not a
 * silent one (same disclosure style as `core/constraints.ts`'s own LIFO revocation note).
 */
const CAPITALIZED_RUN = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g;

function hasNonInitialCapitalizedName(sentence: string): boolean {
  // trimStart so a leading quote/bullet/space does not make an otherwise sentence-initial match
  // look like it starts at a non-zero index by accident.
  const trimmed = sentence.trimStart();
  for (const match of trimmed.matchAll(CAPITALIZED_RUN)) {
    if ((match.index ?? 0) > 0) return true;
  }
  return false;
}

/**
 * A dotted host/domain token (round 20, brief-s4a-fix20.md item 1a; real A/B evidence: "The
 * metrics dashboard is hosted at kestrel-dash.internal." carries no other qualifying signal type
 * and was silently dropped -- `qv.mjs`'s repro against the round-15 evidence fixture confirmed
 * this exact sentence, plus "The log shipper we run is Rillwater." and "The translations vendor is
 * Polyglotta." below, all three DROP under the pre-round-20 signal set). Two or more dot-separated
 * labels of letters/digits/hyphens (`api.example.com`, `kestrel-dash.internal`).
 *
 * The brief's own excluded cases ("e.g."/"i.e." and a plain sentence-final period) both fall out
 * of one rule, not two: the LAST label of the match must be at least 2 characters. A real host's
 * rightmost label (a TLD like "com"/"co", or a suffix like "internal"/"local") is never one
 * character; "e.g." and "i.e." each parse as a 2-label dotted token ("e.g" / "i.e") whose last
 * label is exactly one character, so both are rejected by this same length check, no separate
 * abbreviation list needed. A plain sentence-final period is never part of the match at all,
 * regardless of length: '.' is not in the label character class, so `kestrel-dash.internal.`'s
 * trailing sentence period simply is not where the match ends -- there is nothing to special-case.
 * Any label after the first that starts uppercase is rejected to avoid treating a missing-space
 * sentence boundary (`Done.Next`) as a host; lowercase product names such as `Node.js` remain valid.
 * A token with no letter anywhere (a decimal number like "3.14") is excluded separately, since a
 * host name is never all-digits.
 */
const DOTTED_TOKEN = /\b[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+\b/g;

function hasDottedHostToken(sentence: string): boolean {
  for (const match of sentence.matchAll(DOTTED_TOKEN)) {
    const token = match[0];
    const labels = token.split('.');
    if (labels[labels.length - 1].length < 2) continue;
    if (labels.slice(1).some((label) => /^[A-Z]/.test(label))) continue;
    if (!/[A-Za-z]/.test(token)) continue;
    return true;
  }
  return false;
}

/**
 * A single capitalized proper noun following a copula (round 20, brief-s4a-fix20.md item 1b; real
 * A/B evidence: "The log shipper we run is Rillwater." / "The translations vendor is Polyglotta."
 * -- a single-word name is neither a `MIXED_ALNUM_TOKEN` nor a multi-word `CAPITALIZED_RUN`, so
 * both DROPped under the pre-round-20 signal set). Only the exact words the brief lists trigger
 * this ("is"/"are"/"uses"/"use"/"run"), immediately before the capitalized word ("is Rillwater",
 * not "is probably Rillwater"). "am"/"was"/"were" are deliberately not in this list (the brief's
 * own), which for free drops the brief's own chatter example "I am Sure." (no trigger word at all
 * -- never even reaches the pronoun check below).
 *
 * The brief's other named chatter risk, "That is Great.", does reach a trigger word ("is"), so it
 * needs its own guard: for `is` and `are` only, the single word immediately before the copula is
 * checked against a small set of personal/demonstrative pronouns (the same weak-subject idea `PRONOUN_SUBJECTS`/
 * `isWeakSubject` above already use for correction subject-keys, extended here with the first/
 * second person forms that idea did not need). A bare pronoun subject ("That is great.", "It is
 * ready.", "We are done.") almost always introduces a predicate adjective, never a real proper-noun
 * identity claim; a real fact's subject is a definite noun phrase ("the log shipper we run", "the
 * translations vendor"), which this guard leaves untouched. `use` and `run` are exempt from the
 * guard because pronoun subjects commonly state real tool or service usage.
 */
const COPULA_PROPER_NOUN = /\b(is|are|uses|use|run)\s+([A-Z][a-z][A-Za-z]*)\b/;
const WEAK_SUBJECT_BEFORE_COPULA = new Set(['i', 'you', 'he', 'she', 'it', 'we', 'they', 'this', 'that', 'these', 'those', 'there']);

function hasCapitalizedNounAfterCopula(sentence: string): boolean {
  const match = COPULA_PROPER_NOUN.exec(sentence);
  if (!match) return false;
  if (match[1] !== 'is' && match[1] !== 'are') return true;
  const before = sentence.slice(0, match.index).trim().split(/\s+/).pop() ?? '';
  return !WEAK_SUBJECT_BEFORE_COPULA.has(before.toLowerCase());
}

/** True when `sentence` carries any qualifying signal except the weaker copula-name signal. */
function hasStrongQualifyingValue(sentence: string): boolean {
  return (
    MIXED_ALNUM_TOKEN.test(sentence) ||
    UPPER_DASH_DIGIT_TOKEN.test(sentence) ||
    LONG_NUMBER.test(sentence) ||
    NUMBER_WITH_UNIT.test(sentence) ||
    CURRENCY.test(sentence) ||
    ISO_DATE.test(sentence) ||
    CLOCK_TIME.test(sentence) ||
    FILE_PATH.test(sentence) ||
    QUOTED_LITERAL.test(sentence) ||
    hasNonInitialCapitalizedName(sentence) ||
    matchesAnyMarker(sentence, REASON_MARKER_REGEXES) ||
    hasDottedHostToken(sentence)
  );
}

/** True when `sentence` carries at least one of the brief's qualifying signal types. */
function hasQualifyingValue(sentence: string): boolean {
  return hasStrongQualifyingValue(sentence) || hasCapitalizedNounAfterCopula(sentence);
}

/**
 * A generic label that can open either a fact or an instruction (a superset of `LEADING_LABEL`
 * below, round 18: also strips "remember"/"important"/"also" and a `>` quote marker, since a
 * sentence opening with any of these can still turn out to be an instruction once the label itself
 * is stripped away -- see `isInstructionOrQuestion`).
 */
const INSTRUCTION_LEADING_LABEL = /^[\s\-*•>]*(?:update[d]?|note|correction|fyi|reminder|remember|important|also)\s*:\s*/i;

/**
 * An opening verb that makes a sentence a request/command rather than a statement of fact (round
 * 18, brief-s4a-fix18.md Q1/F1, review-opus-r17.md finding F1). EN/PL, with a small set of leading
 * adverbs ("please", "also", "now", ...) allowed before the verb itself, since "Also read the file
 * ... and remember it." is exactly the shape the review's own repro used.
 */
// Polish cues: the plugin also reads rules written in Polish.
const IMPERATIVE_OPENER =
  /^(?:(?:please|also|now|then|next|first|finally|and|just|proszę|teraz|potem|najpierw|na koniec|i)\s+)*(?:reply|respond|answer|read|write|open|run|execute|call|use|do|don't|make|create|add|remove|delete|fix|implement|check|verify|list|show|tell|give|explain|summari[sz]e|remember|keep|wait|start|stop|continue|go|look|search|grep|find|update|change|set|send|return|print|output|ignore|refer|referring|odpowiedz|przeczytaj|zapisz|uruchom|sprawdź|pamiętaj|zrób|dodaj|usuń|napraw|pokaż|podaj)\b/i;

/**
 * A copula (or a bare label-value dash) within the first few words of the sentence (round 19,
 * brief-s4a-fix19.md F14, review-opus-r18.md finding F14): `IMPERATIVE_OPENER` matches a sentence's
 * opening WORD against a small set of verbs, but several of those words are also ordinary English
 * nouns/adjectives that open a plain declarative sentence -- "Start date is 2026-11-19.", "List
 * price is 400 EUR.", "Check-in time is 15:00.", "Change freeze begins on 2026-11-19.", "Read
 * replicas live in eu-central-2.", "Return window is 30 days.", "Set size is 48213 rows.",
 * "Keep-alive timeout is 75s." all opened with a word `IMPERATIVE_OPENER` treats as a command verb
 * and were silently dropped (0 facts, no path harvest either) even though every one of them states a
 * plain fact. A real instruction almost never has a copula this close to its opening verb ("Also
 * read the file ... and remember it." has none in its first few words); a declarative "NOUN is/are/
 * opens/begins/lives ..." sentence, or a "LABEL - VALUE" dash sentence, does. Checked over the first
 * `NEAR_OPENER_WORDS` whitespace-split words of the sentence (the opener word itself, plus a few
 * more), not only the text after the regex match's own end index, so a hyphenated opener like
 * "Check-in" (one whitespace-split word, `IMPERATIVE_OPENER` matches its "Check" prefix up to the
 * hyphen) still finds the "is" that follows it two words later.
 */
const NEAR_OPENER_WORDS = 4;
const COPULA_NEAR_OPENER = /\b(?:is|are|was|were|will be|opens|begins|lives?)\b|(?:^|\s)-(?:\s|$)/i;

function hasDeclarativeCopulaNearOpener(body: string): boolean {
  const words = body.trim().split(/\s+/).slice(0, NEAR_OPENER_WORDS);
  return COPULA_NEAR_OPENER.test(words.join(' '));
}

/**
 * True when `sentence` is a request, command or question rather than a statement of fact (round
 * 18, brief-s4a-fix18.md Q1/F1). A file path can still be mentioned inside an instruction (e.g.
 * "Also read the file notes/a.txt and remember it.") without the sentence itself being a fact
 * worth keeping verbatim -- see `extractFilePaths`, called on exactly these skipped sentences so
 * the path is not lost, just not kept as a fake "fact".
 */
function isInstructionOrQuestion(sentence: string): boolean {
  const withoutLabel = sentence.replace(INSTRUCTION_LEADING_LABEL, '');
  const body = withoutLabel.replace(/^[\s\-*•>]+/, '');
  if (/\?\s*["”]?\s*$/.test(sentence.trim())) return true;
  if (!IMPERATIVE_OPENER.test(body)) return false;
  return !hasDeclarativeCopulaNearOpener(body) && !hasCapitalizedNounAfterCopula(body);
}

/** A global-flag copy of `FILE_PATH` so every match in a sentence can be harvested, not just the first. */
const FILE_PATH_GLOBAL = new RegExp(FILE_PATH.source, 'g');

/**
 * Every file path mentioned in `sentence`, leading whitespace/paren trimmed off each match (round
 * 18, brief-s4a-fix18.md Q1/F1: "keep referenced file paths as a list so the path info survives"
 * for sentences skipped by `isInstructionOrQuestion`).
 */
function extractFilePaths(sentence: string): string[] {
  const paths: string[] = [];
  for (const match of sentence.matchAll(FILE_PATH_GLOBAL)) {
    const cleaned = match[0].replace(/^[\s(]+/, '');
    if (cleaned) paths.push(cleaned);
  }
  return paths;
}

/** Cap on the harvested file-paths list (round 18), a small fixed cap rather than an unbounded line. */
const MAX_POINTED_FILES = 20;

/**
 * Subject-key derivation for corrections (brief item 1 "Corrections": "use the same subject-key
 * approach as constraint revocation"). `core/constraints.ts`'s revocation is documented there as
 * having no real topic model at all (LIFO: "the most recently kept, still-open constraint"), so
 * there is no existing subject-key function to literally reuse; this is an honestly-documented,
 * original heuristic in that same spirit, not a claim that a real subject model exists anywhere in
 * this plugin. A sentence's subject is the text before its first colon, or before the first
 * standalone " is "/" = "/" -> "/" will be "/" to be " separator (whichever comes first), lowercased
 * and whitespace-normalized; a sentence with none of those separators falls back to its first 4
 * words. Two sentences with the same subject key are "the same subject" (brief's wording); the
 * later one, if it carries a *different* qualifying value, supersedes the earlier one.
 *
 * Round 18 (brief-s4a-fix18.md Q1/F1 follow-up, review-opus-r17.md): the colon branch now requires
 * trailing whitespace (`:\s`, not a bare `:`), so a clock time like "09:00" is not itself read as a
 * subject/value separator -- "Daily standup happens at 09:00 sharp." no longer collides with "The
 * next release window opens at 09:30." onto the shared subject "daily standup happens at 09" vs
 * "the next release window opens at 09" (it never did collide on that exact pair, but the same bug
 * made any two clock-time sentences whose text up to the colon happened to match collide; the fix
 * removes the false separator entirely rather than patching one example).
 */
const SUBJECT_SEPARATORS = /:\s| is | = | -> | will be | to be /;

/**
 * A subject is "weak" (round 18, brief-s4a-fix18.md Q1/F1 follow-up) when it is a bare pronoun:
 * "It is 3pm in the office." and "It is critical to ship by Friday." both key to the bare subject
 * "it" under the plain separator rule above, which is wrong -- they are not statements about the
 * same topic, they just both happen to open with the same pronoun. A weak subject is keyed by the
 * sentence's own full normalized text instead of the shared short subject, so unrelated
 * pronoun-led sentences never falsely collide or supersede each other, while two sentences that
 * really do restate the exact same weak subject text still dedupe as identical (same as any other
 * verbatim repeat).
 *
 * Deliberately narrower than "any single-word subject": a single-word LABEL like "Deadline:
 * 2026-11-19." / "Port: 4821." / "Termin: 2027-03-15." must keep colliding on that one word so a
 * later "Deadline: 2026-11-25." still supersedes it (existing tests, round 15-17) -- only an actual
 * pronoun is meaningless enough on its own to disable supersession.
 */
const PRONOUN_SUBJECTS = new Set(['it', 'this', 'that', 'they', 'we', 'there', 'he', 'she']);

function isWeakSubject(subjectText: string): boolean {
  const words = subjectText.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return true;
  return words.length === 1 && PRONOUN_SUBJECTS.has(words[0].toLowerCase());
}

/**
 * The "changed from OLD to NEW" idiom (brief item 1 "Corrections", confirmed against the real A/B
 * evidence fixture `fixtures/round15-large-capture.ndjson`, records 8/10/12: "the hard delivery
 * deadline changed from 2026-11-19 to 2026-12-03 because ...", "...budget ... changed from 3,470
 * EUR to 4,120 EUR because ...", "...region changed from eu-central-2 to eu-north-1 because ..."):
 * both the old and the new value are stated in one sentence, so the ":"/" is "/... separator rule
 * above finds the wrong split point whenever the sentence also opens with a generic label. Handled
 * as its own case: the subject is the text before "changed from", with a leading generic label
 * stripped first.
 */
const CHANGED_FROM = /\bchanged from\b/i;
const CHANGED_TO = /\bchanged to\b/i;

/**
 * A generic label a correction line is commonly prefixed with (a bullet marker and/or a bare
 * "Update:"/"Note:"/"Correction:"/"FYI:"/"Reminder:" word), carrying no topic of its own. Stripped
 * before deriving the subject so "- Update: the hard delivery deadline changed from ..." keys to
 * the same subject ("the hard delivery deadline") as the plain declarative sentence that first
 * stated it ("The hard delivery deadline is 2026-11-19."), rather than colliding every "- Update:
 * ..." bullet in a session onto one shared "- update" subject regardless of topic.
 *
 * Round 18 (brief-s4a-fix18.md Q1/F1 follow-up, review-opus-r17.md): this label is now stripped in
 * *both* branches of `subjectKey` below, not only the `changed from` one. Before round 18, "Note:
 * the staging port is 48213." keyed to the subject "note" (the whole "Note:" prefix, since the
 * plain branch never stripped it), so every "Note: ..." sentence in a session collided onto one
 * shared "note" subject regardless of topic and silently overwrote each other.
 */
const LEADING_LABEL = /^[\s\-*•]*(?:update[d]?|note|correction|fyi|reminder)\s*:\s*/i;

function subjectKey(sentence: string): string {
  // Strip the generic label from the whole sentence first (round 18), not just from the slice
  // before a matched separator: doing it after would let the label's own colon be picked up as
  // the separator itself ("Note:" would then key to the bare subject "note", the exact collision
  // this round's fix is for), rather than the real separator further into the sentence.
  // A leading item id (F05, Q3, P1) stays part of the subject, so "Q3 budget" and "Q4 budget" are
  // different facts (review-opus-s4e P1). Only its optional colon and an article on either side of
  // it are formatting, so "F05: Status badge ..." and "F05 The status badge ..." share a subject.
  const ARTICLE = /^\s*(?:the|a|an)\s+/i;
  const unlabeled = sentence.replace(LEADING_LABEL, '').replace(ARTICLE, '');
  const id = /^\s*([A-Z]\d+)\s*:?\s+/i.exec(unlabeled);
  const stripped = id ? `${id[1]} ${unlabeled.slice(id[0].length).replace(ARTICLE, '')}` : unlabeled;
  // Take the earliest separator: "The port is 4000 after the default changed to IPv6" keys to
  // "port", not to everything before "changed to" (review-opus-s4e P3).
  const changed = [CHANGED_FROM.exec(stripped), CHANGED_TO.exec(stripped)].filter((m): m is RegExpExecArray => m !== null).sort((a, b) => a.index - b.index)[0];
  const separator = SUBJECT_SEPARATORS.exec(stripped);
  let subjectText: string;
  if (changed && (!separator || changed.index <= separator.index)) {
    subjectText = stripped.slice(0, changed.index);
  } else {
    subjectText = separator ? stripped.slice(0, separator.index) : stripped.split(/\s+/).slice(0, 4).join(' ');
  }
  if (isWeakSubject(subjectText)) return `full:${normalizeForDedup(sentence)}`;
  return normalizeForDedup(subjectText);
}

export interface KeyFact {
  /**
   * 1-based ordinal over the source records this extraction call was given, oldest first --
   * mirrors `Constraint.seq` (`core/constraints.ts`) for the same reason: scoped to this module's
   * own output, no shared-schema `seq` field needed.
   */
  seq: number;
  /** The verbatim sentence carrying the fact. */
  text: string;
  sourceHash: string;
  /** The subject key this fact was grouped under (for correction/supersession). */
  subject: string;
  /**
   * Set when this fact's text replaced an earlier fact on the same subject (brief item 1
   * "Corrections"). Carries the *correcting* sentence's own `seq` (not the original fact's first
   * `seq`, which the fact keeps in its own `seq` field above) -- two traceable numbers: where the
   * fact was first stated, and which later statement corrected it.
   */
  correctedAtSeq?: number;
}

/**
 * Sentences per yield point inside the generator below (round 18, brief-s4a-fix18.md F6). Chosen
 * the same way round 15's line-chunking in `core/seed.ts` was: small enough that the synchronous
 * work between two yields stays well under the ~1s budget the perf gate checks, large enough that
 * yielding itself is not the dominant cost on an ordinary-sized capture.
 */
const YIELD_EVERY_SENTENCES = 200;

/**
 * The actual extraction algorithm, written as a generator so it can be driven either all at once
 * (`extractKeyFacts`, every existing caller and test) or one chunk at a time with a real
 * await-a-macrotask between chunks (`extractKeyFactsChunked`, round 18 brief-s4a-fix18.md F6,
 * used by `compact.ts`). `core/` still calls no host API and awaits nothing itself (the
 * dollar-spelling rule): a bare `yield;` with no value is not an await, it just hands control back
 * to whichever loop is driving the generator, which is the only thing that needs to await anything.
 *
 * Pure (spec v3.3 §3.1.3): scans `user` and `file_write` capture records, in the order given (the
 * caller, `compact.ts`, is responsible for handing them over in one true chronological order across
 * both kinds -- see its own doc comment on `factSourceRecords`). Extraction is generic, not keyed to
 * any one fixture (brief item 1): every sentence in a scannable paragraph that carries a qualifying
 * value (`hasQualifyingValue`) becomes a candidate; a later sentence on the same subject
 * (`subjectKey`) with a *different* qualifying text supersedes the earlier one when its qualifying
 * signal is at least as strong. The copula-name signal alone cannot replace an earlier fact with
 * another qualifying signal. The earlier fact is dropped from the output entirely (not kept as a
 * superseded duplicate) and replaced by the correcting sentence tagged `correctedAtSeq`. Deduped per
 * subject (an identical sentence repeated
 * verbatim under the same subject is not a correction and is not added twice); round 18
 * (brief-s4a-fix18.md Q1/F1 follow-up, review-opus-r17.md finding F1 point 4) removed the earlier
 * *global* dedup set, which silently dropped a value's later, exact restatement (e.g. an earlier
 * correction reverted back to the original value) because that exact text had already been "seen"
 * once anywhere in the whole capture, on any subject. Dedup is now purely local to the current
 * subject's own current text, which fixes that case for free: a restatement identical to the
 * subject's current text is still a no-op dedup, but a restatement identical to a value the subject
 * held *before* its most recent correction is a new correction, exactly like any other change.
 *
 * Round 18 (brief-s4a-fix18.md Q1/F1, review-opus-r17.md finding Q1/F1) also filters out imperative
 * and question sentences before they ever reach `hasQualifyingValue` (`isInstructionOrQuestion`): a
 * request like "Also read the file notes/a.txt and remember it." is not a fact the user stated, it
 * is an instruction, and round-17's plain qualifying-value scan kept it anyway whenever it also
 * happened to carry a file path or a number. Its file path(s) are not simply discarded, though
 * (brief: "keep referenced file paths as a list so the path info survives") -- they are harvested
 * into a capped, deduped list and rendered as one extra fact at the very end, "Files the user
 * pointed at: ...".
 *
 * Rejected review sub-proposal (review-opus-r17.md finding F1 point 3, not in the brief's own
 * item-2 list): also skip any sentence matching a `core/constraints.ts` marker word, on the theory
 * that section 0 already keeps it verbatim. Tried and reverted: `CONSTRAINT_MARKERS_V1` includes
 * plain English words ("only", "always", "without", "must", ...) that appear plenty in ordinary
 * factual sentences with no real modal/prohibition meaning, and section 0's own extraction has its
 * own independent scanning/dedup/revocation rules -- a sentence matching a marker word is not
 * guaranteed to actually survive into section 0's rendered output. Blanket-skipping on a bare
 * regex match risks losing a real fact from *both* sections with nothing protecting it, confirmed
 * against this module's own existing overflow gate test (`key-facts.gate.test.ts`, "among
 * never-corrected facts..."): its 40 synthetic facts all read "...and must not be changed without
 * updating...", so the blanket filter silently dropped every one of them, not just their would-be
 * duplicates in section 0.
 */
function* extractKeyFactsSteps(records: readonly CaptureRecord[], hash: Hasher): Generator<void, KeyFact[], void> {
  const bySubject = new Map<string, KeyFact>();
  const order: string[] = [];
  const pointedFiles: string[] = [];
  const pointedFilesSeen = new Set<string>();
  let seq = 0;
  let sinceYield = 0;
  for (const record of records) {
    if (record.kind !== 'user' && record.kind !== 'file_write') continue;
    const text = String(record.body.text ?? '');
    if (!text) continue;
    for (const paragraph of scannableParagraphs(text, undefined, MAX_FACT_PARAGRAPH_CHARS)) {
      for (const rawSentence of splitSentences(paragraph)) {
        sinceYield += 1;
        if (sinceYield >= YIELD_EVERY_SENTENCES) {
          sinceYield = 0;
          yield;
        }
        const sentence = rawSentence.length > MAX_SENTENCE_CHARS ? rawSentence.slice(0, MAX_SENTENCE_CHARS) : rawSentence;
        if (isInstructionOrQuestion(sentence)) {
          for (const path of extractFilePaths(sentence)) {
            if (pointedFiles.length >= MAX_POINTED_FILES) break;
            if (pointedFilesSeen.has(path)) continue;
            pointedFilesSeen.add(path);
            pointedFiles.push(path);
          }
          continue;
        }
        if (!hasQualifyingValue(sentence)) continue;
        const subject = subjectKey(sentence);
        const existing = bySubject.get(subject);
        if (existing && existing.text === sentence) continue;
        if (existing && !hasStrongQualifyingValue(sentence) && hasStrongQualifyingValue(existing.text)) continue;
        seq += 1;
        if (existing) {
          existing.text = sentence;
          existing.sourceHash = hash(sentence);
          existing.correctedAtSeq = seq;
          continue;
        }
        const fact: KeyFact = { seq, text: sentence, sourceHash: hash(sentence), subject };
        bySubject.set(subject, fact);
        order.push(subject);
      }
    }
  }
  if (pointedFiles.length > 0) {
    seq += 1;
    const line = `Files the user pointed at: ${pointedFiles.join(', ')}`;
    const filesFact: KeyFact = { seq, text: line, sourceHash: hash(line), subject: '__files__' };
    bySubject.set('__files__', filesFact);
    order.push('__files__');
  }
  return order.map((subject) => bySubject.get(subject)!);
}

/** All-at-once driver: every existing call site (round 17 and earlier, and every unit test). */
export function extractKeyFacts(records: readonly CaptureRecord[], hash: Hasher): KeyFact[] {
  const steps = extractKeyFactsSteps(records, hash);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/**
 * Chunked driver (round 18, brief-s4a-fix18.md F6): identical output to `extractKeyFacts`, but
 * awaits `onYield()` between chunks of `YIELD_EVERY_SENTENCES` sentences instead of running the
 * whole scan synchronously in one stretch. `core/` still never touches `$` itself (dollar-spelling
 * rule); `onYield` is a plain injected async function, and `compact.ts` is the one that spells
 * `$.clock.sleep(0, {signal})` directly in its own file to build it.
 */
export async function extractKeyFactsChunked(
  records: readonly CaptureRecord[],
  hash: Hasher,
  onYield: () => Promise<void>,
): Promise<KeyFact[]> {
  const steps = extractKeyFactsSteps(records, hash);
  let step = steps.next();
  while (!step.done) {
    await onYield();
    step = steps.next();
  }
  return step.value;
}

export interface RenderedKeyFactLine {
  seq: number;
  /** The rendered line: a tagged fact, or `[pointer seq=<n> sha256=<hash>]` past overflow. */
  line: string;
  isPointer: boolean;
}

export interface KeyFactsOverflowResult {
  rendered: RenderedKeyFactLine[];
  /** Count of facts turned into pointers, for `seed.facts_overflow=<n>` (spec v3.3 §3.1.3). */
  overflowCount: number;
  /**
   * Facts dropped because a pointer would be no shorter than the fact itself. Without this a long
   * session of short facts never shrank (real replay 2026-09-27: 1614 facts, ~51k tokens).
   */
  omittedCount: number;
}

export const KEY_FACTS_OMITTED_LINE = (count: number): string =>
  `[${count} key facts omitted over budget; use recall or the transcript]`;

/**
 * Budget rule (brief item 1 "Order and overflow", 3.13.0 S4m): chronological order by each fact's
 * own first-stated `seq`; a correction reads `(updated)`. Over budget, corrections (newest first,
 * as many as fit) and the "Files the user pointed at" line (already capped at `MAX_POINTED_FILES`)
 * are kept, then the OLDEST plain facts ("early facts are the ones most at risk"), and everything
 * else is omitted behind one line; the full text stays in the transcript and in recall. Before
 * 3.13.0 the newest facts first became `[pointer seq=N sha256=...]` lines, which cost ~25 tokens
 * each and meant nothing to the model. `hash` is unused since then and kept for callers;
 * `overflowCount` is always 0.
 */
export function applyKeyFactsOverflow(
  facts: readonly KeyFact[],
  countTokens: TokenCounter,
  hash: Hasher,
  budgetTokens: number,
): KeyFactsOverflowResult {
  const ordered = [...facts].sort((a, b) => a.seq - b.seq);
  const lineFor = (fact: KeyFact): string => {
    // 3.13.0 (S4m): no `[seq=N]` tags; they meant nothing to the model.
    return `> ${fact.text}${fact.correctedAtSeq !== undefined ? ' (updated)' : ''}`;
  };
  const entries = ordered.map((fact) => {
    const line = lineFor(fact);
    const exempt = fact.correctedAtSeq !== undefined || fact.subject === '__files__';
    return { seq: fact.seq, text: fact.text, subject: fact.subject, protectedFact: exempt, line, factLine: line, isPointer: false, tokens: countTokens(line) };
  });
  const total = entries.reduce((sum, entry) => sum + entry.tokens, 0);
  const overflowCount = 0;
  let omittedCount = 0;
  const omitted = new Set<number>();
  // Reserve room for the single omission line so the finished section still fits the budget.
  const reserve = countTokens(KEY_FACTS_OMITTED_LINE(facts.length));
  const joinedTokens = (): number => {
    const lines = entries.filter((_, index) => !omitted.has(index)).map((entry) => entry.line);
    if (omittedCount > 0) lines.push(KEY_FACTS_OMITTED_LINE(omittedCount));
    return countTokens(lines.join('\n'));
  };
  // Over budget: keep protected entries plus the OLDEST facts in full, omit the rest behind one line.
  if (total > budgetTokens || joinedTokens() > budgetTokens) {
    omittedCount = 0;
    omitted.clear();
    for (const entry of entries) {
      entry.line = entry.factLine;
      entry.isPointer = false;
      entry.tokens = countTokens(entry.factLine);
    }
    // Corrections are protected, but not unboundedly (review-opus-s4e P1): keep the newest ones
    // that fit and omit older ones (they stay recallable). The files line is never omitted.
    let used = reserve + entries.filter((entry) => entry.subject === '__files__').reduce((sum, entry) => sum + entry.tokens + 1, 0);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry.protectedFact || entry.subject === '__files__') continue;
      if (used + entry.tokens + 1 <= budgetTokens) used += entry.tokens + 1;
      else { omitted.add(index); omittedCount += 1; }
    }
    entries.forEach((entry, index) => {
      if (entry.protectedFact) return;
      if (used + entry.tokens + 1 <= budgetTokens) used += entry.tokens + 1;
      else { omitted.add(index); omittedCount += 1; }
    });
    // Exact trim for rounding between per-line and joined token counts; check only after a drop.
    let over = joinedTokens() > budgetTokens;
    for (let index = entries.length - 1; index >= 0 && over; index -= 1) {
      if (entries[index].subject === '__files__' || omitted.has(index)) continue;
      omitted.add(index);
      omittedCount += 1;
      over = joinedTokens() > budgetTokens;
    }
  }
  const rendered = entries.filter((_, index) => !omitted.has(index)).map(({ seq, line, isPointer }) => ({ seq, line, isPointer }));
  if (omittedCount > 0) {
    const maxSeq = Math.max(...entries.filter((_, index) => omitted.has(index)).map((entry) => entry.seq));
    rendered.push({ seq: maxSeq, line: KEY_FACTS_OMITTED_LINE(omittedCount), isPointer: true });
  }
  return { rendered, overflowCount, omittedCount };
}

/** Renders the key facts section body; `seed.ts` wraps it under the `## Key facts` header. */
export function renderKeyFactsSection(rendered: readonly RenderedKeyFactLine[]): string {
  return rendered.map((entry) => entry.line).join('\n');
}
