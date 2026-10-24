import { describe, expect, it } from 'vitest';
import { MESSAGE_LABELS, buildLabelQuestion, labelKey, parseLabelAnswer, parseLabels, ruleSentences, submitLabelKey } from '../core/labels.js';
import { cleanCapturedRecord, reconcile } from '../core/extractor.js';
import { JEV_SAFETY_NOTICE } from '../core/select-j.js';
import { sha256 } from './fixtures/helpers.js';

describe('S4n core message labels', () => {
  it('uses the same condensed hash with or without a harness block', () => {
    const typed = 'Please remember port 443.';
    const wrapped = `<system-reminder>Runtime note that is not user text.</system-reminder>\n${typed}`;
    expect(labelKey(wrapped, sha256)).toBe(labelKey(typed, sha256));
    expect(labelKey('<system-reminder>only harness content</system-reminder>', sha256)).toBeUndefined();
  });

  it('builds one bounded choice question with dictionary criteria and untrusted-data notice', () => {
    const built = buildLabelQuestion(`Do the task. ${'marker '.repeat(2000)}`, (text) => Math.ceil(text.length / 4));
    const state = JSON.parse(built.state) as { notice: string; message: string };
    expect(state.notice).toBe(JEV_SAFETY_NOTICE);
    expect(state.message.length).toBeLessThan(2000);
    expect(built.question.options).toEqual(MESSAGE_LABELS);
    expect(Array.isArray(built.question.criteria)).toBe(false);
    expect(Object.keys(built.question.criteria)).toEqual(MESSAGE_LABELS);
    expect(built.question.instructions).toContain('Polish');
  });

  it('accepts only a known label at probability 0.6 or above', () => {
    expect(parseLabelAnswer({ type: 'choice', choice: 'question', probabilities: { question: 0.6 } })).toEqual({ label: 'question', probability: 0.6 });
    expect(parseLabelAnswer({ type: 'choice', choice: 'question', probabilities: { question: 0.59 } })).toBeUndefined();
    expect(parseLabelAnswer({ type: 'choice', choice: 'unknown', probabilities: { unknown: 1 } })).toBeUndefined();
    expect(parseLabelAnswer({ type: 'choice', choice: 'chat', probabilities: { chat: Number.NaN } })).toBeUndefined();
  });

  it('ignores damaged JSONL rows and keeps the last valid label for a key', () => {
    const labels = parseLabels([
      JSON.stringify({ key: 'abc', label: 'question' }),
      '{not-json',
      JSON.stringify({ key: 'abc', label: 'chat' }),
      JSON.stringify({ key: 'def', label: 'not-a-label' }),
      JSON.stringify({ key: '', label: 'chat' }),
    ].join('\n'));
    expect([...labels]).toEqual([['abc', 'chat']]);
  });
});

describe('S4n review fixes', () => {
  it.each([
    ['plain', 'Refactor module X'],
    ['wrapped', '<system-reminder>harness</system-reminder>\nRefactor module X'],
    ['secret', 'Use password: hunter2 and api_key=abc123 for the staging box'],
  ])('the submit key equals the key of the captured record (%s)', (_name, raw) => {
    const records = reconcile([{ role: 'user', text: raw, toolUses: [] }], null, { hash: sha256 }).records.filter((record) => record.kind === 'user');
    expect(records).toHaveLength(1);
    const cleaned = cleanCapturedRecord(records[0]);
    expect(labelKey(String(cleaned?.body.text ?? ''), sha256)).toBe(submitLabelKey(raw, sha256));
  });

  it('keeps only hard-rule sentences that are not questions', () => {
    expect(ruleSentences('ok, rób. The migration must wait until QA approves.')).toBe('The migration must wait until QA approves.');
    expect(ruleSentences('Możesz to zrobić? Tylko nie ruszaj prod.')).toBe('Tylko nie ruszaj prod.');
    expect(ruleSentences('czy deployujemy tylko na main?')).toBe('');
    expect(ruleSentences('Zastanawiam się, czy deployujemy tylko na main')).toBe('');
    expect(ruleSentences('tak, ale nigdy nie pushuj na main')).toBe('tak, ale nigdy nie pushuj na main');
  });
});
