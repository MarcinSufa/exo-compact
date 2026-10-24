import type { CaptureRecord, Hasher, TokenCounter } from '../../core/types.js';

const MAX_SENTENCE_CHARS = 240;
const MIXED_ALNUM_TOKEN = /\b(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*[0-9])[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]\b/;
const UPPER_DASH_DIGIT_TOKEN = /\b[A-Z]{2,}(?:-[A-Z0-9]+)*-[0-9]+\b/;
const LONG_NUMBER = /\b[0-9]{3,}\b/;
const NUMBER_WITH_UNIT = /\b[0-9]+(?:[.,][0-9]+)?\s?(?:ms|sec|secs|s|min|mins|hr|hrs|h|kb|mb|gb|tb|px|km|kg|k)\b/i;
const CURRENCY = /[$€£]\s?[0-9]+(?:[.,][0-9]+)?(?:k|m)?\b|\b[0-9]+(?:[.,][0-9]+)?\s?(?:USD|EUR|GBP|PLN|zł)\b/i;
const ISO_DATE = /\b[0-9]{4}-[0-9]{2}-[0-9]{2}\b/;
const CLOCK_TIME = /\b[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\s?(?:am|pm)?\b/i;
const FILE_PATH = /(?:^|[\s(])(?:[.~]{1,2})?\/(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,8}\b|(?:^|[\s(])(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8}\b/;
const QUOTED_LITERAL = /"[^"]+"|'[^']{2,}'|"[^"]+"|„[^"]+"/;
const REASON_MARKERS: readonly string[] = ['because', 'so that', 'since', 'żeby', 'bo', 'ponieważ'];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markerRegex(marker: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(marker)}(?![\\p{L}\\p{N}_])`, 'iu');
}

const REASON_MARKER_REGEXES: readonly RegExp[] = REASON_MARKERS.map(markerRegex);

function matchesAnyMarker(sentence: string, regexes: readonly RegExp[]): boolean {
  return regexes.some((regex) => regex.test(sentence));
}

function normalizeForDedup(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

const FENCE_LINE = /^(```.*|<{3,}.*>{3,})$/;

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

const BULLET_LINE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const MAX_PARAGRAPH_CHARS = 600;
const MAX_PARAGRAPH_LINES = 8;

function isBulletListParagraph(paragraph: string): boolean {
  const lines = paragraph.split('\n').filter((line) => line.trim().length > 0);
  return lines.length > 0 && lines.every((line) => BULLET_LINE.test(line));
}

function scannableParagraphs(text: string): string[] {
  const stripped = stripFencedContent(text);
  const paragraphs = stripped
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  const units: string[] = [];
  for (const paragraph of paragraphs) {
    if (isBulletListParagraph(paragraph)) {
      for (const line of paragraph.split('\n')) {
        const bullet = line.trim().replace(BULLET_LINE, '').trim();
        if (bullet.length > 0 && bullet.length <= MAX_PARAGRAPH_CHARS) units.push(bullet);
      }
      continue;
    }
    if (paragraph.length <= MAX_PARAGRAPH_CHARS && paragraph.split('\n').length <= MAX_PARAGRAPH_LINES) units.push(paragraph);
  }
  return units;
}

function splitSentences(text: string): string[] {
  type SegmenterLike = { segment: (input: string) => Iterable<{ segment: string }> };
  type SegmenterCtor = new (locale: string, options: { granularity: string }) => SegmenterLike;
  const ctor = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  if (typeof ctor === 'function') {
    const segmenter = new ctor('en', { granularity: 'sentence' });
    return [...segmenter.segment(text)].map((entry) => entry.segment.trim()).filter(Boolean);
  }
  return text
    .split(/(?<=[.!?])\s+(?=\S)/)
    .map((part) => part.trim())
    .filter(Boolean);
}

const CAPITALIZED_RUN = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g;

function hasNonInitialCapitalizedName(sentence: string): boolean {
  const trimmed = sentence.trimStart();
  for (const match of trimmed.matchAll(CAPITALIZED_RUN)) {
    if ((match.index ?? 0) > 0) return true;
  }
  return false;
}

function hasQualifyingValue(sentence: string): boolean {
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
    matchesAnyMarker(sentence, REASON_MARKER_REGEXES)
  );
}

const SUBJECT_SEPARATORS = /:| is | = | -> | will be | to be /;
const CHANGED_FROM = /\bchanged from\b/i;
const LEADING_LABEL = /^[\s\-*•]*(?:update[d]?|note|correction|fyi|reminder)\s*:\s*/i;

function subjectKey(sentence: string): string {
  const changedFrom = CHANGED_FROM.exec(sentence);
  if (changedFrom) {
    const before = sentence.slice(0, changedFrom.index).replace(LEADING_LABEL, '');
    return normalizeForDedup(before);
  }
  const match = SUBJECT_SEPARATORS.exec(sentence);
  const subjectText = match ? sentence.slice(0, match.index) : sentence.split(/\s+/).slice(0, 4).join(' ');
  return normalizeForDedup(subjectText);
}

export interface KeyFact {
  seq: number;
  text: string;
  sourceHash: string;
  subject: string;
  correctedAtSeq?: number;
}

/**
 * Mutation-proof defect (spec v3.3 §3.1.3, "user records... AND... Write/Edit tool_use inputs...
 * Tool RESULTS are not a source"): the source-kind guard is missing here (`core/key-facts.ts` has
 * `if (record.kind !== 'user' && record.kind !== 'file_write') continue;`), so a `gate`/`error`/
 * `assistant_text`/`file` record's body text is scanned for facts too -- the same class of defect
 * `broken/constraints.ts` seeds for section 0 (its own missing `record.kind !== 'user'` guard),
 * mirrored here for this section. Everything else (sentence qualification, subject-key correction,
 * chronological dedup, overflow with corrections protected) is otherwise the same working copy as
 * `core/key-facts.ts` so this family still discriminates on this one defect only.
 */
export function extractKeyFacts(
  records: readonly CaptureRecord[],
  hash: Hasher,
): KeyFact[] {
  const bySubject = new Map<string, KeyFact>();
  const order: string[] = [];
  const seenNormalized = new Set<string>();
  let seq = 0;
  for (const record of records) {
    const text = String(record.body.text ?? '');
    if (!text) continue;
    for (const paragraph of scannableParagraphs(text)) {
      for (const rawSentence of splitSentences(paragraph)) {
        const sentence = rawSentence.length > MAX_SENTENCE_CHARS ? rawSentence.slice(0, MAX_SENTENCE_CHARS) : rawSentence;
        if (!hasQualifyingValue(sentence)) continue;
        const normalized = normalizeForDedup(sentence);
        if (seenNormalized.has(normalized)) continue;
        seq += 1;
        const subject = subjectKey(sentence);
        const existing = bySubject.get(subject);
        if (existing && existing.text !== sentence) {
          existing.text = sentence;
          existing.sourceHash = hash(sentence);
          existing.correctedAtSeq = seq;
          seenNormalized.add(normalized);
          continue;
        }
        if (existing) continue;
        const fact: KeyFact = { seq, text: sentence, sourceHash: hash(sentence), subject };
        bySubject.set(subject, fact);
        order.push(subject);
        seenNormalized.add(normalized);
      }
    }
  }
  return order.map((subject) => bySubject.get(subject)!);
}

export interface RenderedKeyFactLine {
  seq: number;
  line: string;
  isPointer: boolean;
}

export interface KeyFactsOverflowResult {
  rendered: RenderedKeyFactLine[];
  overflowCount: number;
}

export function applyKeyFactsOverflow(
  facts: readonly KeyFact[],
  countTokens: TokenCounter,
  hash: Hasher,
  budgetTokens: number,
): KeyFactsOverflowResult {
  const ordered = [...facts].sort((a, b) => a.seq - b.seq);
  const lineFor = (fact: KeyFact): string => {
    const tag = fact.correctedAtSeq !== undefined ? ` (updated, seq ${fact.correctedAtSeq})` : '';
    return `> ${fact.text} [seq=${fact.seq}]${tag}`;
  };
  const entries = ordered.map((fact) => {
    const line = lineFor(fact);
    return { seq: fact.seq, text: fact.text, protectedFact: fact.correctedAtSeq !== undefined, line, isPointer: false, tokens: countTokens(line) };
  });
  let total = entries.reduce((sum, entry) => sum + entry.tokens, 0);
  let overflowCount = 0;
  for (let index = entries.length - 1; index >= 0 && total > budgetTokens; index -= 1) {
    const entry = entries[index];
    if (entry.protectedFact) continue;
    const pointerLine = `[pointer seq=${entry.seq} sha256=${hash(entry.text)}]`;
    total = total - entry.tokens + countTokens(pointerLine);
    entry.line = pointerLine;
    entry.isPointer = true;
    entry.tokens = countTokens(pointerLine);
    overflowCount += 1;
  }
  return {
    rendered: entries.map(({ seq, line, isPointer }) => ({ seq, line, isPointer })),
    overflowCount,
  };
}

export function renderKeyFactsSection(rendered: readonly RenderedKeyFactLine[]): string {
  return rendered.map((entry) => entry.line).join('\n');
}
