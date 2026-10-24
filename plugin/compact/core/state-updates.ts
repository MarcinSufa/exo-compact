import { splitSentences } from './constraints.js';
import type { TokenCounter } from './types.js';

/**
 * 3.43.0 (CONTRACT S4zo): the newest value of each thing the user changed during the session.
 *
 * The seed kept rules (`must`, `never`) and dense notes, but not state the user moved step by step: "set X to 6",
 * "X is now 11", "change X from 3 to 5". After a few cuts only the session map's cut-off first line was left, and the
 * model answered UNKNOWN (ctxbench 2026-10-02, no push: 4/7 on a table changed one cell at a time). Each such
 * sentence in a user message is one update; the newest update per subject wins and earlier values are not shown,
 * so a stale value never sits next to the current one. User messages only, never tool output or assistant text.
 */

export interface StateUpdate {
  /** The subject as the user wrote it, e.g. `ledger` or `Table version`. */
  subject: string;
  value: string;
  /** How many different values the subject was set to in a row; the newest one is `value`. */
  updates: number;
  /** 1-based ordinal of the user message with the newest update, oldest first. */
  seq: number;
}

export const STATE_UPDATES_BUDGET_TOKENS = 500;

const SUBJECT = String.raw`[\p{L}\p{N}_][\p{L}\p{N}_.\-/:@#]*(?:\s+[\p{L}\p{N}_][\p{L}\p{N}_.\-/:@#]*){0,4}`;
const VALUE = String.raw`[^\s.,;!?][^,;!?\n]*?`;
const END = String.raw`(?=\s*(?:[.,;!?](?:\s|$)|$|\s+(?:and|but|so|i|ale|oraz)\s))`;
// "set X to V", "change X from A to V"; "set up/aside/out" and "move on/back" are not updates.
const EN_SET = new RegExp(String.raw`\b(?:set|change|changed|update|updated|bump|bumped|raise|raised|lower|lowered|scale|scaled|switch|switched|rename|renamed|move|moved)\s+(?!up\b|out\b|aside\b|on\b|back\b|off\b)(?:the\s+)?(${SUBJECT}?)\s+(?:from\s+\S+\s+)?to\s+(${VALUE})${END}`, 'giu');
const EN_NOW = new RegExp(String.raw`(?:^|[\s(])((?:the\s+)?${SUBJECT}?)\s+(?:is|are)\s+now\s+(${VALUE})${END}`, 'giu');
// Polish cues: the plugin also reads rules written in Polish.
const PL_SET = new RegExp(String.raw`(?:^|\s)(?:ustaw|ustawiłem|ustawiłam|ustawiamy|zmień|zmieniłem|zmieniłam|zmieniamy|podbij|zwiększ|zmniejsz)\s+(${SUBJECT}?)\s+(?:z\s+\S+\s+)?na\s+(${VALUE})${END}`, 'giu');
const PL_NOW = new RegExp(String.raw`(?:^|\s)(${SUBJECT}?)\s+(?:jest|ma|wynosi)\s+teraz\s+(${VALUE})${END}`, 'giu');

/** Words that make a subject a pronoun or filler ("it is now done", "this is now fixed"), not a thing. */
const NOT_A_SUBJECT = new Set(['it', 'this', 'that', 'these', 'those', 'there', 'he', 'she', 'they', 'we', 'you', 'i', 'which', 'what', 'everything', 'something', 'nothing', 'all', 'to', 'też', 'co', 'wszystko', 'nic', 'on', 'ona', 'ono', 'oni']);
/** Conjunctions and fillers the subject match can start with ("but the X is now", Polish "ale X jest teraz", "but X is now"). */
const LEADING_FILLER = /^(?:(?:the|and|but|so|ok|okay|now|a|i|ale|oraz|więc|no|to)\s+)+/iu;
const MAX_SENTENCE_CHARS = 300;
const MAX_VALUE_CHARS = 80;

function subjectKey(subject: string): string | undefined {
  const words = subject.toLowerCase().replace(/^the\s+/, '').split(/\s+/).filter(Boolean);
  if (!words.length || NOT_A_SUBJECT.has(words[0]!) || NOT_A_SUBJECT.has(words.at(-1)!)) return undefined;
  return words.join(' ');
}

/** Updates from user message texts, oldest first; newest per subject, in order of their newest update. */
export function extractStateUpdates(userTexts: readonly string[]): StateUpdate[] {
  const bySubject = new Map<string, StateUpdate>();
  userTexts.forEach((text, index) => {
    for (const line of text.split('\n')) {
      for (const sentence of splitSentences(line)) {
        // A quoted line is someone else's text; a question asks for a change that may not have happened.
        if (sentence.length > MAX_SENTENCE_CHARS || sentence.trimStart().startsWith('>') || sentence.trimEnd().endsWith('?')) continue;
        for (const pattern of [EN_SET, EN_NOW, PL_SET, PL_NOW]) {
          for (const match of sentence.matchAll(pattern)) {
            // "Correction: the X is now V" names X, not "Correction: the X".
            const subject = match[1]!.trim().replace(/^.*:\s+/, '').replace(LEADING_FILLER, '');
            const value = match[2]!.trim();
            const key = subjectKey(subject);
            if (key === undefined || !value || value.length > MAX_VALUE_CHARS) continue;
            const previous = bySubject.get(key);
            bySubject.delete(key);
            // The same value again (a repeated or resent message) is not a change.
            const updates = previous === undefined ? 1 : previous.updates + (previous.value === value ? 0 : 1);
            bySubject.set(key, { subject, value, updates, seq: index + 1 });
          }
        }
      }
    }
  });
  return [...bySubject.values()];
}

/** One line per subject, newest first, cut at whole lines to `budgetTokens`; `''` when there are none. */
export function renderStateUpdates(updates: readonly StateUpdate[], countTokens: TokenCounter, budgetTokens: number = STATE_UPDATES_BUDGET_TOKENS): string {
  const lines: string[] = [];
  let used = 0;
  for (const update of [...updates].reverse()) {
    const line = `- ${update.subject}: ${update.value}${update.updates > 1 ? ` (changed ${update.updates} times; this is the newest)` : ''}`;
    const cost = countTokens(`${line}\n`);
    if (used + cost > budgetTokens) break;
    lines.push(line);
    used += cost;
  }
  return lines.join('\n');
}
