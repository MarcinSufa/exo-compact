import { JEV_QUERY_FIELD_MAX_TOKENS } from './budgets.js';
import { capQueryField, JEV_SAFETY_NOTICE, resolvesRequestedModel } from './select-j.js';
import { condenseUserMessage } from './history.js';
import { redactCapturedText, userAuthoredText } from './extractor.js';
import type { Hasher, TokenCounter } from './types.js';

export const MESSAGE_LABELS = ['instruction', 'question', 'consent', 'information', 'chat'] as const;
export type MessageLabel = (typeof MESSAGE_LABELS)[number];

export interface LabelChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
}

export interface LabelChoiceQuestion {
  type: 'choice';
  options: readonly MessageLabel[];
  criteria: Record<MessageLabel, string>;
  instructions: string;
}

export interface BuiltLabelQuestion {
  state: string;
  question: LabelChoiceQuestion;
}

export function labelKey(text: string, hash: Hasher): string | undefined {
  const condensed = condenseUserMessage(text);
  return condensed === undefined ? undefined : hash(condensed);
}

/**
 * The user text exactly as the capture store will hold it at the cut: capture writes
 * `redact(userAuthoredText(text))` and the read side applies `userAuthoredText` again
 * (cleanCapturedRecord). Keying and querying on this form keeps the submit key equal to the cut
 * key and never sends a secret the capture would have redacted (review of 3.14.0, findings 3, 5).
 */
export function capturedUserText(text: string): string {
  return userAuthoredText(redactCapturedText(userAuthoredText(text)));
}

export function submitLabelKey(text: string, hash: Hasher): string | undefined {
  const captured = capturedUserText(text);
  return captured === '' ? undefined : labelKey(captured, hash);
}

// Polish cues: the plugin also reads rules written in Polish.
// A sentence that states a hard rule. `tylko`/`only` are left out on purpose: they are just as
// common in questions (Polish "czy deployujemy tylko na main?", "do we deploy only to main?"), which is the case labels exist to fix.
const HARD_RULE = /\b(?:never|always|must|do not|don't|cannot|nigdy|zawsze|musi(?:sz|my)?|nie wolno|nie (?:rób|ruszaj|używaj|uzywaj|pushuj|commituj|usuwaj|zmieniaj|dotykaj|wysyłaj|wysylaj|merguj|instaluj|odpalaj))\b/i;

/**
 * Sentences of a message labelled question or consent that still state a hard rule, so one
 * label on a mixed message (Polish "ok, rób" is "ok, do it": "ok, rób. The migration must wait until QA approves.") never drops
 * the rule from Constraints (review of 3.14.0, finding 4). Returns '' when there is none.
 */
export function ruleSentences(text: string): string {
  return text.split(/(?<=[.!?])\s+|\n+/).map((sentence) => sentence.trim()).filter((sentence) => sentence && !sentence.endsWith('?') && HARD_RULE.test(sentence)).join(' ');
}

export function buildLabelQuestion(text: string, countTokens: TokenCounter): BuiltLabelQuestion {
  const message = capQueryField(text, JEV_QUERY_FIELD_MAX_TOKENS, countTokens);
  return {
    state: JSON.stringify({ notice: JEV_SAFETY_NOTICE, message }),
    question: {
      type: 'choice',
      options: MESSAGE_LABELS,
      criteria: {
        instruction: 'The user asks for work to be done or states a rule or limit to follow (never, always, only, do not), even when the same message also approves something or asks a question.',
        question: 'The user asks for information and does not state a rule.',
        consent: 'The user approves or declines a specific proposal, such as “ok, do it” or “no, leave it”.',
        information: 'The user states facts, gives context, or pastes or reports content.',
        chat: 'The message has no useful task content, such as thanks, a greeting, or a bare question mark.',
      },
      instructions: 'Classify the user message in state.message. Messages are often in Polish. Choose exactly the best matching label. If the message states any rule or limit, choose instruction.',
    },
  };
}

export function parseLabelAnswer(answer: LabelChoiceAnswer | unknown): { label: MessageLabel; probability: number } | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined;
  const value = answer as Partial<LabelChoiceAnswer>;
  if (value.type !== 'choice' || typeof value.choice !== 'string' || !MESSAGE_LABELS.includes(value.choice as MessageLabel)) return undefined;
  const probability = value.probabilities?.[value.choice];
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0.6 || probability > 1) return undefined;
  return { label: value.choice as MessageLabel, probability };
}

export function isLabelModel(requestedModel: string, responseModel: string): boolean {
  return resolvesRequestedModel(requestedModel, responseModel);
}

export function parseLabels(jsonl: string): Map<string, MessageLabel> {
  const labels = new Map<string, MessageLabel>();
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (typeof row !== 'object' || row === null) continue;
      const value = row as { key?: unknown; label?: unknown };
      if (typeof value.key === 'string' && value.key.length > 0 && MESSAGE_LABELS.includes(value.label as MessageLabel)) {
        labels.set(value.key, value.label as MessageLabel);
      }
    } catch {
      // One damaged record does not invalidate later lines.
    }
  }
  return labels;
}
