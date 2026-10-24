import type { CaptureRecord, Hasher, TokenCounter } from '../../core/types.js';

export const CONSTRAINT_MARKERS_V1: readonly string[] = [
  'never', 'always', "don't", 'do not', 'must', 'only', 'until', 'unless', 'without',
  'nigdy', 'zawsze', 'nie rób', 'nie wolno', 'musi', 'tylko', 'dopóki', 'chyba że', 'bez',
];

const REVOCATION_MARKERS: readonly string[] = ['już nie', 'no longer', 'ignore the earlier'];

export const CONSTRAINTS_OVERFLOW_BUDGET_TOKENS = 2000;
export const CONSTRAINTS_POINTER_CAP = 20;

const MAX_PARAGRAPH_CHARS = 600;
const MAX_PARAGRAPH_LINES = 8;

export interface Constraint {
  seq: number;
  text: string;
  sourceHash: string;
}

export function splitSentences(text: string): string[] {
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markerRegex(marker: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(marker)}(?![\\p{L}\\p{N}_])`, 'iu');
}

const CONSTRAINT_MARKER_REGEXES: readonly RegExp[] = CONSTRAINT_MARKERS_V1.map(markerRegex);
const REVOCATION_MARKER_REGEXES: readonly RegExp[] = REVOCATION_MARKERS.map(markerRegex);

function matchesAnyMarker(sentence: string, regexes: readonly RegExp[]): boolean {
  return regexes.some((regex) => regex.test(sentence));
}

function normalizeForDedup(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

const FENCE_LINE = /^(```.*|<{3,}.*>{3,})$/;

// Round 17: mirrors core/constraints.ts's block-comment stripping (key-facts negative case,
// brief-s4a-fix17.md item 3), unrelated to this file's own seeded defect below.
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

function isBulletListParagraph(paragraph: string): boolean {
  const lines = paragraph.split('\n').filter((line) => line.trim().length > 0);
  return lines.length > 0 && lines.every((line) => BULLET_LINE.test(line));
}

// Round 16 (spec v3.2.3 F2, brief-s4a-fix16.md): mirrors core/constraints.ts's bullet-per-line
// scan and skipped-paragraph callback, keeping this file's one deliberate defect (the missing
// `record.kind !== 'user'` guard below) as the only thing this family still discriminates on.
function scannableParagraphs(text: string, onSkippedParagraph?: () => void): string[] {
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
    if (paragraph.length <= MAX_PARAGRAPH_CHARS && paragraph.split('\n').length <= MAX_PARAGRAPH_LINES) {
      units.push(paragraph);
      continue;
    }
    if (onSkippedParagraph && (matchesAnyMarker(paragraph, CONSTRAINT_MARKER_REGEXES) || matchesAnyMarker(paragraph, REVOCATION_MARKER_REGEXES))) {
      onSkippedParagraph();
    }
  }
  return units;
}

/**
 * Mutation-proof defect (spec §3.1.1, "must never scan tool output or assistant text, only
 * `user` capture records"): the `record.kind !== 'user'` guard is missing, so a `gate`/`error`/
 * `assistant_text` record's body text is scanned for markers too, letting a tool result plant a
 * constraint. Everything else (whole-word/paragraph/fence B1 hardening, dedup, revocation order,
 * overflow with the pointer-cap collapse) is otherwise the same working copy as
 * `core/constraints.ts` so the family still discriminates on this one defect only.
 */
export function extractConstraints(
  records: readonly CaptureRecord[],
  hash: Hasher,
  onSkippedParagraph?: () => void,
): Constraint[] {
  const kept: Constraint[] = [];
  const keptNormalized = new Set<string>();
  let seq = 0;
  for (const record of records) {
    const text = String(record.body.text ?? '');
    if (!text) continue;
    for (const paragraph of scannableParagraphs(text, onSkippedParagraph)) {
      for (const sentence of splitSentences(paragraph)) {
        if (matchesAnyMarker(sentence, REVOCATION_MARKER_REGEXES)) {
          const removed = kept.pop();
          if (removed) keptNormalized.delete(normalizeForDedup(removed.text));
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

export interface RenderedConstraintLine {
  seq: number;
  line: string;
  isPointer: boolean;
}

export interface ConstraintOverflowResult {
  rendered: RenderedConstraintLine[];
  overflowCount: number;
}

export function applyConstraintOverflow(
  constraints: readonly Constraint[],
  countTokens: TokenCounter,
  hash: Hasher,
  budgetTokens: number = CONSTRAINTS_OVERFLOW_BUDGET_TOKENS,
): ConstraintOverflowResult {
  const ordered = [...constraints].sort((a, b) => a.seq - b.seq);
  const entries = ordered.map((constraint) => ({
    seq: constraint.seq,
    text: constraint.text,
    line: `> ${constraint.text} [seq=${constraint.seq}]`,
    isPointer: false,
    tokens: countTokens(`> ${constraint.text} [seq=${constraint.seq}]`),
  }));
  let total = entries.reduce((sum, entry) => sum + entry.tokens, 0);
  let overflowCount = 0;
  for (const entry of entries) {
    if (total <= budgetTokens) break;
    const pointerLine = `[pointer seq=${entry.seq} sha256=${hash(entry.text)}]`;
    total = total - entry.tokens + countTokens(pointerLine);
    entry.line = pointerLine;
    entry.isPointer = true;
    entry.tokens = countTokens(pointerLine);
    overflowCount += 1;
  }
  if (overflowCount > CONSTRAINTS_POINTER_CAP) {
    const collapseCount = overflowCount - CONSTRAINTS_POINTER_CAP;
    const collapsed = entries.splice(0, collapseCount);
    const firstSeq = collapsed[0].seq;
    const lastSeq = collapsed[collapsed.length - 1].seq;
    const summaryLine = `[${collapseCount} older constraints omitted; seq=${firstSeq}-${lastSeq}; grep the transcript]`;
    entries.unshift({ seq: firstSeq, text: '', line: summaryLine, isPointer: true, tokens: countTokens(summaryLine) });
  }
  return {
    rendered: entries.map(({ seq, line, isPointer }) => ({ seq, line, isPointer })),
    overflowCount,
  };
}

export function renderConstraintsSection(rendered: readonly RenderedConstraintLine[]): string {
  return rendered.map((entry) => entry.line).join('\n');
}
