import { userAuthoredText } from './extractor.js';
import type { CaptureRecord, Hasher, SessionMessage, TokenCounter } from './types.js';

/**
 * Section 0 constraints (spec §3.1.1). Why: compactors keep 17% of user-injected constraints,
 * while a separate extractor keeps over 90% (arXiv 2608.11242); the A11 losses were the same
 * class (conditions).
 */

/**
 * PL + EN modal/prohibition markers, exactly the spec's list (§3.1.1), versioned so a future
 * addition to the list is a new constant (`CONSTRAINT_MARKERS_V2`, ...), not a silent edit of
 * this one; golden-tested against this exact array in `constraints.gate.test.ts`.
 */
export const CONSTRAINT_MARKERS_V1: readonly string[] = [
  // EN
  'never', 'always', "don't", 'do not', 'must', 'only', 'until', 'unless', 'without',
  // Polish cues: the plugin also reads rules written in Polish.
  'nigdy', 'zawsze', 'nie rób', 'nie wolno', 'musi', 'tylko', 'dopóki', 'chyba że', 'bez',
];

/**
 * Revocation phrases. Subject matching below removes a rule only when the revoking sentence
 * overlaps exactly one rule on meaningful terms; zero or multiple matches preserve all rules.
 */
const REVOCATION_MARKERS: readonly string[] = ['już nie', 'no longer', 'ignore the earlier'];

/** Mandatory: constraints are never truncated by the seed's own token-budget shrink (spec §3.1.1); only this overflow rule ever shortens the section. */
export const CONSTRAINTS_OVERFLOW_BUDGET_TOKENS = 2000;


/** Paragraphs bigger than this are pasted content, not prose, and are never scanned (B1). */
const MAX_PARAGRAPH_CHARS = 600;
const MAX_PARAGRAPH_LINES = 8;

export interface Constraint {
  /**
   * 1-based ordinal over the `user` records this extraction call was given, oldest first. Not a
   * new field on the shared `CaptureRecord` type (that type has no run-log-style monotonic `seq`
   * today, see CONTRACT.md's S4d section): scoped to this module's own output so citing "the
   * source record seq" (spec §3.1.1) needs no pipeline-wide schema change.
   */
  seq: number;
  /** The verbatim sentence that carried the marker. */
  text: string;
  sourceHash: string;
  sourceFile?: string;
}

const REVOCATION_NOISE = new Set(['ignore', 'the', 'earlier', 'rule', 'constraint', 'no', 'longer', 'already', 'not', 'relevant', 'anymore']);
function subjectTerms(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu)?.filter((word) => word.length > 2 && !REVOCATION_NOISE.has(word)) ?? []);
}

function revokeBySubject(kept: Constraint[], sentence: string): void {
  const revocationTerms = subjectTerms(sentence);
  const matches = kept.map((item, index) => ({ item, index })).filter(({ item }) => {
    const terms = subjectTerms(item.text);
    return [...terms].some((term) => revocationTerms.has(term));
  });
  if (matches.length !== 1) return;
  kept.splice(matches[0].index, 1);
}

/**
 * Feature-detects `Intl.Segmenter` (a JS builtin that may not exist in the hook runtime, per the
 * brief's hard runtime rule) and falls back to a deterministic regex sentence split. Both paths
 * are exercised by `constraints.gate.test.ts`.
 */
export function splitSentences(text: string): string[] {
  type SegmenterLike = { segment: (input: string) => Iterable<{ segment: string }> };
  type SegmenterCtor = new (locale: string, options: { granularity: string }) => SegmenterLike;
  const ctor = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  if (typeof ctor === 'function') {
    const segmenter = new ctor('en', { granularity: 'sentence' });
    return [...segmenter.segment(text)].map((entry) => entry.segment.trim()).filter(Boolean);
  }
  return text
    // No split after "e.g."-style abbreviations or before a lowercase letter or a backtick ("e.g. `describe(...)`").
    .split(/(?<!(?<![\p{L}])(?:e\.g|i\.e|etc|vs|cf)\.)(?<=[.!?])\s+(?=[^\s\p{Ll}`])/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * B1 (review-opus-r10.md line 48): whole word/phrase match, Unicode-aware, case-insensitive, not
 * `includesMarker`'s old plain substring test (which matched "only" inside `selfOnly?` and
 * "without" inside `WITHOUT` in unrelated pasted text, and would match "bez" inside "bezpieczny").
 * Boundaries use `\p{L}\p{N}_` (letter/number/underscore) on both flags so this rejects a marker
 * glued to identifier characters on either side but still matches ordinary EN/PL punctuation
 * boundaries; a leading/trailing space inside a multi-word marker (e.g. "do not") is literal.
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function markerRegex(marker: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(marker)}(?![\\p{L}\\p{N}_])`, 'iu');
}

/**
 * 3.34.0: standing-instruction phrases. A rule given for later turns often has no modal word ("From now on write the
 * summary in Polish", "from this task on the last line is ..."); wave 17's cold run lost such rules at the cut.
 */
export const CONSTRAINT_MARKERS_V2: readonly string[] = [
  ...CONSTRAINT_MARKERS_V1,
  // EN
  'from now on', 'from this point on',
  // Polish cues: the plugin also reads rules written in Polish.
  'od teraz', 'od tej pory', 'odtąd', 'od tego momentu',
];

/** "from this task on", "from step 3 on", "starting with the next slice": a standing rule that starts at a named point. */
const STARTING_POINT_MARKER = /(?<![\p{L}\p{N}_])(?:from (?:this|the next) [\p{L}-]+ on|from [\p{L}-]+ \d+ on|starting (?:with|from) (?:this|the next) [\p{L}-]+)(?![\p{L}\p{N}_])/iu;

const CONSTRAINT_MARKER_REGEXES: readonly RegExp[] = [...CONSTRAINT_MARKERS_V2.map(markerRegex), STARTING_POINT_MARKER];

/**
 * 3.35.0: rules glued to pasted content. Wave 17 glued each mid-session rule change to the pasted brief after it
 * ("...no square brackets.# TASK R5 ..."); the 2 kB paragraph was skipped as pasted content and all four rule changes
 * were gone after the cut. An over-cap paragraph is now read at its edges only (the first and last two lines, where a
 * glued note sits), and only for standing-rule sentences. Revoking sentences there are not read: pasted briefs describe
 * code with "no longer" ("The file no longer imports `ProjectChips`"), and on the wave 17 prompts that revoked two real
 * rules by a shared word. "from <x> on" counts there only when the "on"
 * closes a clause or an order follows it, since logs and changelogs say "from port 3000 on 0.0.0.0" and "from
 * version 4 on, Node 18 is required".
 */
const STANDING_EDGE_REGEXES: readonly RegExp[] = [
  ...CONSTRAINT_MARKERS_V2.slice(CONSTRAINT_MARKERS_V1.length).map(markerRegex),
  /(?<![\p{L}\p{N}_])from (?:this|the next) [\p{L}-]+ on(?=\s*[,:;]|\s+(?:the|every|each|all|any|write|use|add|keep|put|start|end|make|do|don't|never|always)(?![\p{L}\p{N}_]))/iu,
];
const EDGE_LINES = 2;

/** A sentence end glued to a Markdown heading ("brackets.# TASK R5", "`Tests:`.## Scope") is a boundary too. */
const GLUED_HEADING = /(?<=[.!?]["'`)\]»”]*)(?=#{1,6}\s)/;

/** Quote, comment and heading prefixes are not part of the rule ("> From now on ..." dedups with the plain rule). */
const LINE_PREFIX = /^(?:>\s*|\/\/\s*|#{1,6}\s+)+/;

function edgeRuleSentences(paragraph: string): string[] {
  const lines = paragraph.split('\n');
  // A hard-wrapped note keeps its second line: each edge is joined before the sentence split.
  const edges = lines.length <= 2 * EDGE_LINES ? [lines.join(' ')] : [lines.slice(0, EDGE_LINES).join(' '), lines.slice(-EDGE_LINES).join(' ')];
  return edges.flatMap((edge) => edge.split(GLUED_HEADING)).flatMap(splitSentences)
    .filter((sentence) => !sentence.startsWith('#'))
    .map((sentence) => sentence.replace(LINE_PREFIX, '').trim())
    .filter((sentence) => sentence.length > 0 && sentence.length <= MAX_PARAGRAPH_CHARS
      && matchesAnyMarker(sentence, STANDING_EDGE_REGEXES));
}
const REVOCATION_MARKER_REGEXES: readonly RegExp[] = REVOCATION_MARKERS.map(markerRegex);

/**
 * S4i: a question is never a rule, whatever words it carries (the Polish "czy to będzie działać bez
 * serwera?", "will this work without a server?", matched on "bez" and landed in section 0 on a live cut). Ends with "?", or opens
 * with Polish "czy", which asks even when the "?" is missing. Questions neither add nor revoke.
 */
export function isQuestion(sentence: string): boolean {
  // A tag question ("Don't push without tests, ok?") is a rule with a check-in, not a question:
  // dropping a real rule costs more than keeping a question, so the tag is removed first. The
  // tag needs a comma before it, and a sentence that opens like a question stays a question
  // ("Does this work without Docker, right?").
  // An English auxiliary opens a question only when a subject follows it: "Does this work" asks,
  // "Do not push to main" and "Must use pnpm" are rules. Bare "do" needs a personal pronoun,
  // since "Do it/this/the migration ..., ok?" is an order.
  const opensAsQuestion = /^(?:czy|what|why|how|when|where|who|which)(?![\p{L}\p{N}_])|^do\s+(?:i|you|we|they|he|she)(?![\p{L}\p{N}_])|^(?:does|did|is|are|was|were|can|could|should|would|will|shall|may|might|must|has|have|had)\s+(?:i|you|we|they|he|she|it|this|that|these|those|the|a|an|there|our|my|your)(?![\p{L}\p{N}_])/iu;
  const bare = sentence.trim();
  const trimmed = opensAsQuestion.test(bare) ? bare : bare.replace(/,\s*(?:ok|okay|right|dobrze|jasne|tak|yes|zgoda)\s*[?？]+["'»”)\]]*$/iu, '.');
  return /[?？]["'»”)\]]*$/.test(trimmed) || /^czy(?![\p{L}\p{N}_])/iu.test(trimmed);
}

export function matchesAnyMarker(sentence: string, regexes: readonly RegExp[]): boolean {
  return regexes.some((regex) => regex.test(sentence));
}

/** Normalizes a sentence for dedup (B1: "constraints are deduped by normalized text"). */
export function normalizeForDedup(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * A line made only of fence-like punctuation, opening or closing a pasted block: a Markdown
 * ``` fence (review-opus-r10.md line 49, "also skip text inside ``` fences"), or the A/B filler
 * turn's own `<<<PART n START>>>` / `<<<PART n END>>>` wrapper (the A/B harness's
 * `lib/script.ts`). Generic on purpose: any tool or harness that wraps pasted content in a
 * symmetric `<<<...>>>`-shaped marker line is covered, not just this one script's exact text.
 */
const FENCE_LINE = /^(```.*|<{3,}.*>{3,})$/;

/**
 * Round 17 (brief-s4a-fix17.md item 3, key-facts negative case "a licence header... yield zero
 * facts"): a C-style block comment, opened by a slash-star and closed by a star-slash possibly
 * many lines later, is how a license header is pasted on its own, not wrapped in a ``` fence or
 * this project's own `<<<...>>>` marker -- and it is not a symmetric single-line toggle like those
 * two (`FENCE_LINE` above), since its open and close markers differ and its open marker can carry
 * trailing text on the same line (a `/*!` banner-comment opener, for instance). A block comment
 * that opens and closes on different lines is dropped in full, same rationale as `FENCE_LINE`:
 * pasted, not prose. A one-line block comment (both markers on the same line) is left alone, since
 * a short inline comment is exactly the kind of short prose-sized unit the paragraph caps below
 * are already built to judge on its own merits.
 */
function isBlockCommentOpen(trimmedLine: string): boolean {
  return trimmedLine.startsWith('/*') && !trimmedLine.includes('*/');
}

function stripFencedContent(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let inFence = false;
  let inBlockComment = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inFence && !inBlockComment && isBlockCommentOpen(trimmed)) {
      inBlockComment = true;
      continue;
    }
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }
    if (FENCE_LINE.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * A line that opens a bullet or numbered list item ("- ", "* ", "+ ", "1. ", "2) ", ...), any
 * amount of leading indent. Round 16 (spec v3.2.3 F2, brief-s4a-fix16.md).
 */
const BULLET_LINE = /^\s*(?:[-*+]|\d+[.)])\s+/;

/**
 * True when every non-blank line of the (already paragraph-split) block opens a bullet: a real
 * A/B briefing turn puts several one-line facts in a single 7-line bullet list with no blank line
 * between them, so the whole block is one `scannableParagraphs`-style paragraph even though each
 * bullet is really its own short sentence.
 */
function isBulletListParagraph(paragraph: string): boolean {
  const lines = paragraph.split('\n').filter((line) => line.trim().length > 0);
  return lines.length > 0 && lines.every((line) => BULLET_LINE.test(line));
}

/**
 * B1: "only paragraphs of at most 600 chars and 8 lines are scanned. Pasted files, logs and code
 * blocks are not instructions." Paragraphs are blank-line-delimited chunks of the (fence-stripped)
 * user text.
 *
 * Round 16 (spec v3.2.3 F2, brief-s4a-fix16.md): the 8-line cap is a whole-paragraph cap, so a
 * bullet-list paragraph one bullet over that line count silently dropped every marker in it (the
 * KESTREL evidence: a 7-line briefing bullet list is one added fact away from an 8-line cap that
 * would drop the whole list, constraint included). A bullet-shaped paragraph is instead scanned
 * per bullet line, each kept individually if it is at most `MAX_PARAGRAPH_CHARS` (a bullet line is
 * always 1 line, so the line cap cannot apply to it). A non-bullet paragraph keeps the old
 * whole-block cap unchanged (pasted files/logs/code still are not instructions), but when it is
 * over-cap AND contains a marker, `onSkippedParagraph` is invoked once so the caller can log
 * `seed.constraints_skipped_paragraph` (compact.ts) instead of the drop staying silent; the
 * paragraph is still excluded from extraction either way, since size alone does not make pasted
 * content prose.
 */
export function scannableParagraphs(text: string, onSkippedParagraph?: () => void, maxParagraphChars = MAX_PARAGRAPH_CHARS, keepStandingRules = false): string[] {
  const stripped = stripFencedContent(text);
  const paragraphs = stripped
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  const units: string[] = [];
  for (const paragraph of paragraphs) {
    if (isBulletListParagraph(paragraph)) {
      for (const line of paragraph.split('\n')) {
        // The bullet marker itself ("- ", "1. ", ...) is list punctuation, not part of the
        // constraint's own verbatim sentence (spec §3.1.1 "quoted verbatim"), so it is stripped
        // before the bullet becomes its own scannable unit.
        const bullet = line.trim().replace(BULLET_LINE, '').trim();
        if (bullet.length > 0 && bullet.length <= maxParagraphChars) units.push(bullet);
      }
      continue;
    }
    if (paragraph.length <= maxParagraphChars && paragraph.split('\n').length <= MAX_PARAGRAPH_LINES) {
      units.push(paragraph);
      continue;
    }
    const edgeRules = keepStandingRules ? edgeRuleSentences(paragraph) : [];
    units.push(...edgeRules);
    if (edgeRules.length === 0 && onSkippedParagraph && (matchesAnyMarker(paragraph, CONSTRAINT_MARKER_REGEXES) || matchesAnyMarker(paragraph, REVOCATION_MARKER_REGEXES))) {
      onSkippedParagraph();
    }
  }
  return units;
}

/**
 * Pure extractor (spec §3.1.1): scans `user` capture records only, never tool output or
 * assistant text, so a tool result cannot plant a constraint. A user sentence is a constraint
 * when it carries a marker from `CONSTRAINT_MARKERS_V2`, as a whole word/phrase, inside a
 * prose-sized paragraph (B1). A uniquely subject-matched revocation removes only that rule and
 * does not render the revoking sentence itself; the revocation check runs before the marker check
 * on every sentence (a sentence carrying both revocation and marker must revoke, not add).
 * Constraints are deduped by normalized text (B1): a sentence already kept (by normalized text)
 * is not added again, but revoking it frees the normalized text to be kept again later.
 */
export function extractConstraints(
  records: readonly CaptureRecord[],
  hash: Hasher,
  /**
   * Round 16 (spec v3.2.3 F2, brief-s4a-fix16.md): invoked once per over-cap, non-bullet paragraph
   * that contains a marker and was skipped. Optional so every pre-round-16 call site (tests
   * included) keeps working unchanged; `compact.ts` passes one to log
   * `seed.constraints_skipped_paragraph=<n>` (this module stays pure and never calls `$` itself).
   */
  onSkippedParagraph?: () => void,
): Constraint[] {
  const kept: Constraint[] = [];
  const keptNormalized = new Set<string>();
  let seq = 0;
  for (const record of records) {
    if (record.kind !== 'user') continue;
    const text = String(record.body.text ?? '');
    if (!text) continue;
    for (const paragraph of scannableParagraphs(text, onSkippedParagraph, MAX_PARAGRAPH_CHARS, true)) {
      for (const sentence of splitSentences(paragraph)) {
        // Revocation is checked before the marker check, on every sentence, so a sentence that
        // happens to carry both wins as a revocation (M2).
        if (isQuestion(sentence)) continue;
        if (matchesAnyMarker(sentence, REVOCATION_MARKER_REGEXES)) {
          const before = new Set(kept);
          revokeBySubject(kept, sentence);
          for (const previous of before) if (!kept.includes(previous)) keptNormalized.delete(normalizeForDedup(previous.text));
          continue;
        }
        if (matchesAnyMarker(sentence, CONSTRAINT_MARKER_REGEXES)) {
          const normalized = normalizeForDedup(sentence);
          if (keptNormalized.has(normalized)) continue;
          seq += 1;
          kept.push({ seq, text: sentence, sourceHash: hash(sentence) });
          keptNormalized.add(normalized);
        }
      }
    }
  }
  return kept;
}

/** Constraints from Read results are trusted only when the user explicitly adopted that file. */
export function extractAdoptedFileConstraints(messages: readonly SessionMessage[], hash: Hasher): Constraint[] {
  const adopted = new Set<string>();
  for (const message of messages) {
    // 4.9.2: only what the user typed adopts a file. Text Claude Code adds to a user message (a <system-reminder> with
    // a project's CLAUDE.md or a hook's output) is not the user's, and could otherwise name a file whose rule-like
    // sentences would then land in Constraints.
    const own = message.role === 'user' ? userAuthoredText(message.text) : '';
    if (!/\b(read|look at|open)\b[\s\S]{0,100}\b(remember|follow|use as instructions|treat as rules|obey)\b/i.test(own)) continue;
    const paths = own.match(/(?:\.\.?\/|\/)[\w./-]+|[\w.-]+\.(?:md|txt|rst)/g) ?? [];
    for (const path of paths) adopted.add(path.replaceAll('\\', '/'));
  }
  if (adopted.size === 0) return [];
  const reads = new Map<string, string>();
  for (const message of messages) for (const use of message.toolUses) {
    if (use.tool !== 'Read' || !use.tool_use_id || !use.input || typeof use.input !== 'object') continue;
    const filePath = (use.input as Record<string, unknown>).file_path;
    if (typeof filePath === 'string' && adopted.has(filePath.replaceAll('\\', '/'))) reads.set(use.tool_use_id, filePath);
  }
  const constraints: Constraint[] = [];
  let seq = 0;
  for (const message of messages) for (const result of message.toolResults ?? []) {
    const sourceFile = reads.get(result.tool_use_id);
    if (!sourceFile || result.isError) continue;
    for (const paragraph of scannableParagraphs(result.text)) for (const sentence of splitSentences(paragraph)) {
      if (!matchesAnyMarker(sentence, CONSTRAINT_MARKER_REGEXES)) continue;
      seq += 1;
      constraints.push({ seq, text: sentence, sourceHash: hash(`${sourceFile}\u0000${sentence}`), sourceFile });
    }
  }
  return constraints;
}

export interface RenderedConstraintLine {
  seq: number;
  /** The rendered line: a quoted sentence, `[pointer seq=<n> sha256=<hash>]` past overflow, or the one collapsed summary line past the pointer cap. */
  line: string;
  isPointer: boolean;
  /** Present only for constraints adopted from a specifically named Read result. */
  sourceFile?: string;
}

export interface ConstraintOverflowResult {
  rendered: RenderedConstraintLine[];
  /** Count of constraints turned into pointers or folded into the summary line, for `seed.constraints_overflow=<n>` (spec §3.1.1). */
  overflowCount: number;
}

/**
 * Budget rule (spec §3.1.1, 3.13.0 S4m): constraints are mandatory and shown in full while they fit
 * `CONSTRAINTS_OVERFLOW_BUDGET_TOKENS`. Past it, the OLDEST fold into one
 * `[N older constraints omitted; full text in the transcript]` line, just enough of them that the
 * rest plus that line fit, so the section is bounded however many constraints were extracted.
 * Deterministic (oldest-first by `seq`); the boundary is inclusive (mutation survivor M4: exactly
 * at budget folds nothing). Before 3.13.0 the oldest first became `[pointer seq=N sha256=...]`
 * lines, which meant nothing to the model and, for short constraints, grew the section. `hash` is
 * unused since then and kept for callers.
 */
const constraintsOmittedLine = (count: number): string => `[${count} older constraints omitted; full text in the transcript]`;

export function applyConstraintOverflow(
  constraints: readonly Constraint[],
  countTokens: TokenCounter,
  hash: Hasher,
  budgetTokens: number = CONSTRAINTS_OVERFLOW_BUDGET_TOKENS,
): ConstraintOverflowResult {
  const ordered = [...constraints].sort((a, b) => a.seq - b.seq);
  const entries = ordered.map((constraint) => {
    const sourceTag = constraint.sourceFile === undefined ? '' : ` [source_file=${JSON.stringify(constraint.sourceFile)}]`;
    const line = `> ${constraint.text}${sourceTag}`;
    return {
      seq: constraint.seq,
      text: constraint.text,
      sourceFile: constraint.sourceFile,
      line,
      isPointer: false,
      tokens: countTokens(line),
    };
  });
  // 3.13.0 (S4m): no pointer lines. Over budget, the oldest constraints fold into one summary
  // line, just enough of them that the rest plus that line fit (the boundary stays inclusive).
  // Measured on the joined section, so newlines count too. Binary search for the fewest folded
  // entries that fit: folding more only shrinks the section (monotonic), O(n log n) renders.
  const sectionTokens = (folded: number): number => countTokens([...(folded > 0 ? [constraintsOmittedLine(folded)] : []), ...entries.slice(folded).map((entry) => entry.line)].join('\n'));
  let overflowCount = 0;
  if (sectionTokens(0) > budgetTokens) {
    let low = 1, high = entries.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (sectionTokens(middle) <= budgetTokens) high = middle;
      else low = middle + 1;
    }
    overflowCount = low;
    const firstSeq = entries[0].seq;
    const summaryLine = constraintsOmittedLine(overflowCount);
    entries.splice(0, overflowCount, { seq: firstSeq, text: '', sourceFile: undefined, line: summaryLine, isPointer: true, tokens: countTokens(summaryLine) });
  }
  return {
    rendered: entries.map(({ seq, line, isPointer, sourceFile }) => ({ seq, line, isPointer, ...(sourceFile === undefined ? {} : { sourceFile }) })),
    overflowCount,
  };
}

/** Renders section 0's body (spec §3.1.1: "labelled as history"); `seed.ts` wraps it under the `## Constraints (history)` header. */
export function renderConstraintsSection(rendered: readonly RenderedConstraintLine[]): string {
  return rendered.map((entry) => entry.line).join('\n');
}
