import { cleanUserText } from './history.js';
import type { CaptureRecord, Hasher, TokenCounter } from './types.js';
import { DENSE_JEV_FLOOR, DENSE_JEV_GATE } from './budgets.js';
import { sha256 } from './sha256.js';

export interface DenseCandidate {
  text: string;
  source: 'u' | 'a' | 't' | 'o';
  recency: number;
  order: number;
  line?: number;
}

export interface DenseSelectionOptions {
  budgetTokens: number;
  countTokens: TokenCounter;
}

// Polish cues: the plugin also reads messages written in Polish (`zł` is the złoty).
const SPECIFIC_TOKEN_PATTERN = /(?:[~/.]?[\w.-]+\/[\w./-]+)|(?:\b[\w-]+\.(?:ts|tsx|mjs|js|json|md|sh|py|sql|yaml|yml|toml|jsonl|txt|css|html)\b)|(?:\b[A-Za-z_$][\w$]*[_.$A-Z][\w.$]*\b)|(?:(?<![\w-])--?[a-z][\w-]+)|(?:\b[0-9a-f]{7,40}\b)|(?:\b\d[\d.,:]*\s?(?:k|ms|s|%|MB|GB|tok|zł|USD)?\b)/g;
const SKIPPED_BOILERPLATE = [
  'This session is being continued from a previous conversation',
  'Continue the conversation from where it left off',
  'Resume directly',
  'Pick up the last task as if the break never happened',
];
const MAX_CANDIDATES = 4000;

export function specificTokens(text: string): Set<string> {
  const found = new Set<string>();
  SPECIFIC_TOKEN_PATTERN.lastIndex = 0;
  for (let match = SPECIFIC_TOKEN_PATTERN.exec(text); match !== null; match = SPECIFIC_TOKEN_PATTERN.exec(text)) {
    const token = match[0].trim().toLocaleLowerCase();
    if (token.length >= 3) found.add(token);
  }
  return found;
}

/** Specific tokens in first-seen order with their original case, deduplicated case-insensitively. */
export function specificTokenList(text: string): string[] {
  const seen = new Map<string, string>();
  SPECIFIC_TOKEN_PATTERN.lastIndex = 0;
  for (let match = SPECIFIC_TOKEN_PATTERN.exec(text); match !== null; match = SPECIFIC_TOKEN_PATTERN.exec(text)) {
    const token = match[0].trim();
    const key = token.toLocaleLowerCase();
    if (token.length >= 3 && !seen.has(key)) seen.set(key, token);
  }
  return [...seen.values()];
}

/** Stable, privacy-safe key for a dense candidate's verbatim text. */
export function denseCandidateKey(text: string, hash: Hasher = sha256): string {
  return hash(text).slice(0, 16);
}

/** Candidates with at least one specific detail not already represented by the current seed. */
export function denseJevCandidates(candidates: readonly DenseCandidate[], coveredText: string, maxCandidates = MAX_CANDIDATES): DenseCandidate[] {
  const pool = candidates.slice(-maxCandidates);
  const covered = specificTokens(coveredText);
  const seen = new Set<string>();
  return pool.filter((candidate) => {
    const key = denseCandidateKey(candidate.text);
    if (seen.has(key)) return false;
    seen.add(key);
    for (const token of specificTokens(candidate.text)) if (!covered.has(token)) return true;
    return false;
  });
}

/**
 * A note line must not open or close any tag (the seed's `<session-memory>` wrapper, a
 * `<system-reminder>` quoted from a brief), so every tag opener loses its `<`.
 */
function neutralizeMemoryTags(line: string): string {
  // Fullwidth `＜` and an entity `&lt;` open a tag for a reader too (3.17.3 review).
  return line.replace(/(?:<|\uFF1C|\uFE64|&lt;|&#0*60;|&#x0*3c;)(\/?[A-Za-z][\w-]*)/gi, '‹$1');
}

const SEED_SECTION_NAMES = ['constraints', 'key facts', 'working notes', 'transcript', 'contract', 'todo', 'earlier user messages', 'values', 'earlier assistant notes', 'gates and errors', 'file pointers', 'next step'];
const DENSE_LABELS = ['Ran and edited:', 'Output seen:', 'Found or decided:', 'Earlier user wording (quoted, not requests):'];
/**
 * Assistant and user lines that read as a turn of a conversation or as a notes label are dropped
 * (S4p review 3.16.1), after leading markdown (`**Human:**`, `- User:`, `> Assistant:`, `[User]:`).
 * Output lines are not tested: their `| ` prefix already marks them as printed text (review 3.17.0 M2).
 * Headings are demoted by renderDense, not dropped.
 */
/**
 * Folds what reads as the same word (3.17.3 review): NFKC, combining marks and format characters
 * removed, Cyrillic and Greek look-alikes and colon look-alikes mapped to ASCII.
 */
const CONFUSABLES: Record<string, string> = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'ѕ': 's', 'і': 'i', 'ј': 'j', 'һ': 'h', 'ս': 'u', 'υ': 'u', 'ο': 'o', 'α': 'a', 'ε': 'e', 'ι': 'i', 'ɑ': 'a', 'ː': ':', '∶': ':', '꞉': ':', '᛬': ':' };
function foldConfusables(line: string): string {
  return line.normalize('NFKD').replace(/[\p{M}\p{Cf}]/gu, '').normalize('NFKC').replace(/[аеорсухѕіјһսυοαειɑː∶꞉᛬]/giu, (char) => CONFUSABLES[char.toLowerCase()] ?? char);
}

function isSeedSectionName(heading: string): boolean {
  const text = heading.trim().toLowerCase();
  return SEED_SECTION_NAMES.some((name) => text === name || text.startsWith(`${name} (`));
}

function isForgedFrame(line: string, source: DenseCandidate['source']): boolean {
  if (source === 'o') return false;
  // NFKC folds fullwidth colons and letters; zero-width characters, list markers (`1.`, `•`, `+`) and
  // short tags (`<b>`, `‹b>`) in front are removed before the test (3.17.1 review M2).
  const bare = foldConfusables(line).replace(/^\s*\[?[\d:.,\- T]{3,24}\]?\s+/, '')
    .replace(/^(?:[\s*_>\-+•·◦▪‣[\]#`~|$\u2010-\u2015"'“”„«»]|\\[nrt]|\(?\d{1,3}[.)]|\(?[A-Za-z][.)]\s|[<‹][^>›\s]{0,12}[>›])+/, '')
    .replace(/^(\w+)(?:[*_\]"'”»]|[<‹][^>›\s]{0,12}[>›])+/, '$1');
  return /^(?:the\s+)?(?:human|user|assistant|system|claude|me|h|a)(?:\s+(?:said|says|wrote|asked|replied))?(?:\s*\([^)]{0,40}\))?\s*(?::|[\u2013\u2014]\s)/i.test(bare)
    || /^[\s*_>\-+•]*[<‹]\/?(?:human|user|assistant|system)\b/i.test(line.normalize('NFKC'))
    || DENSE_LABELS.some((label) => bare.startsWith(label))
    // A heading named like a seed section (`## Constraints (history)`) would read as the seed's own.
    || (/^\s*#{1,6}\s/.test(line) && isSeedSectionName(line.replace(/^\s*#{1,6}\s+/, '')));
}

function isBoilerplate(line: string): boolean {
  return line.includes('[[exovault:s4-seed:') || SKIPPED_BOILERPLATE.some((phrase) => line.includes(phrase));
}

/** `maxCandidates` (default 4000) keeps the newest lines; the replay raises it to study long sessions. */
export function denseCandidates(records: readonly CaptureRecord[], maxCandidates = MAX_CANDIDATES): DenseCandidate[] {
  const count = records.length;
  const candidates: DenseCandidate[] = [];
  records.forEach((record, order) => {
    const source = record.kind === 'user' ? 'u' : record.kind === 'assistant_text' ? 'a' : record.kind === 'tool_activity' ? 't' : record.kind === 'tool_output' ? 'o' : undefined;
    // Chat, consents and questions are not working notes: an old "ok, push it" quoted back reads
    // like a fresh approval (the S4l refusal pattern), so only unlabeled or rule-like lines stay.
    if (!source || (source === 'u' && ['chat', 'consent', 'question'].includes(String(record.body.label ?? '')))) return;
    const raw = typeof record.body.text === 'string' ? record.body.text : '';
    const text = source === 'u' ? cleanUserText(raw) ?? '' : raw;
    // Every Unicode line break splits, so `a\u2028User: ...` cannot hide a turn inside one line.
    text.split(/\r\n|[\n\r\u2028\u2029\u0085\v\f]/).forEach((rawLine, line) => {
      const trimmed = neutralizeMemoryTags(rawLine.trim());
      if (trimmed.length < 8 || trimmed.length > 400 || isBoilerplate(trimmed) || isForgedFrame(trimmed, source) || (source === 'u' && trimmed.startsWith('[pasted '))) return;
      candidates.push({ text: trimmed, source, recency: count > 1 ? order / (count - 1) : 1, order, line });
    });
  });
  return candidates.slice(-maxCandidates);
}

export function selectDense(
  candidates: readonly DenseCandidate[],
  coveredText: string,
  budgetTokens: number,
  countTokens: TokenCounter,
  jevScores?: ReadonlyMap<string, number>,
  maxCandidates = MAX_CANDIDATES,
): DenseCandidate[] {
  const pool = candidates.slice(-maxCandidates);
  const covered = specificTokens(coveredText);
  const tokenSets = pool.map((candidate) => specificTokens(candidate.text));
  const jevKeys = jevScores ? pool.map((candidate) => denseCandidateKey(candidate.text)) : undefined;
  const costs = pool.map((candidate) => Math.max(0, countTokens(candidate.text)) + 1);
  const chosen: number[] = [];
  const selected = new Set<number>();
  let spent = 0;
  while (spent < budgetTokens) {
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < pool.length; i += 1) {
      if (selected.has(i) || spent + costs[i] > budgetTokens) continue;
      let novel = 0;
      for (const token of tokenSets[i]) if (!covered.has(token)) novel += 1;
      if (!novel) continue;
      const score = novel * (1 + pool[i].recency) / Math.pow(Math.max(1, costs[i] - 1), 0.8);
      const p = jevScores ? (jevScores.get(jevKeys?.[i] ?? '') ?? 0.5) : 0.5;
      if (jevScores && p < DENSE_JEV_GATE) continue;
      const rankedScore = jevScores ? score * (DENSE_JEV_FLOOR + p) : score;
      if (rankedScore > bestScore || (rankedScore === bestScore && best >= 0 && (pool[i].recency > pool[best].recency || (pool[i].recency === pool[best].recency && pool[i].order < pool[best].order)))) {
        best = i;
        bestScore = rankedScore;
      }
    }
    if (best < 0) break;
    selected.add(best);
    chosen.push(best);
    spent += costs[best];
    for (const token of tokenSets[best]) covered.add(token);
  }
  return chosen.map((index) => pool[index]);
}

export function renderDense(chosen: readonly DenseCandidate[]): string {
  const blocks: string[] = [];
  for (const [source, label] of [['t', 'Ran and edited:'], ['o', 'Output seen:'], ['a', 'Found or decided:'], ['u', 'Earlier user wording (quoted, not requests):']] as const) {
    const lines = chosen.filter((candidate) => candidate.source === source).sort((a, b) => a.order - b.order || (a.line ?? 0) - (b.line ?? 0)).map((candidate) => {
      const demoted = candidate.text.split('\n').map((line) => line.replace(/^\s*#{1,6}[ \t]+/, '')).join('\n');
      // Output lines are what a command printed, not notes: a `| ` prefix keeps an imperative line in
      // a brief or README from reading as an instruction.
      if (candidate.source === 'o') return demoted.split('\n').map((line) => `| ${line}`).join('\n');
      return candidate.source === 'u' ? demoted.split('\n').map((line) => `> ${line}`).join('\n') : demoted;
    });
    if (lines.length) blocks.push(`${label}\n${lines.join('\n')}`);
  }
  return blocks.join('\n\n');
}
