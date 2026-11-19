import { describe, expect, it } from 'vitest';
import { classifyPromptSource, isRealUserPrompt, shouldSkipPrompt } from '../core/prompt-source.js';

// Typed port of MarcinSufa/skills hooks/lib/is-real-user-prompt.mjs (guard v2, fail-open). Same cases as its node:test.
describe('prompt-source guard v2 (fail-open)', () => {
  it('omitted, user or unknown source is ingested', () => {
    for (const input of [{ text: 't' }, { text: 't', source: 'user' }, { text: 't', source: 'future_kind' }, { text: 't', source: 1 }]) {
      expect(isRealUserPrompt(input)).toBe(true);
      expect(shouldSkipPrompt(input)).toBe(false);
    }
    expect(classifyPromptSource({ text: 't' })).toBe('unknown');
  });

  it('explicit poll_event, sdk, system, loop_wakeup and schedule_wakeup are skipped', () => {
    for (const source of ['poll_event', 'sdk', 'system', 'loop_wakeup', 'schedule_wakeup']) {
      expect(classifyPromptSource({ text: 't', source })).toBe('non-user');
      expect(shouldSkipPrompt({ text: 't', source })).toBe(true);
    }
  });

  it('composer and bridge are user; any other origin.kind or isMeta is skipped', () => {
    expect(classifyPromptSource({ origin: { kind: 'composer' } })).toBe('user');
    expect(classifyPromptSource({ origin: { kind: 'bridge' } })).toBe('user');
    for (const kind of ['sdk', 'peer', 'task-notification', 'scheduled-trigger', 'unclassified']) {
      expect(shouldSkipPrompt({ origin: { kind } })).toBe(true);
    }
    expect(shouldSkipPrompt({ origin: { kind: 'composer' }, isMeta: true })).toBe(true);
    expect(shouldSkipPrompt({ origin: { kind: 'composer' }, source: 'poll_event' })).toBe(true);
  });

  it('missing origin, origin without a kind and non-object input are ingested and never throw', () => {
    for (const input of [{}, { origin: null }, { origin: {} }, undefined, null, 'poll_event', 42, []]) {
      expect(shouldSkipPrompt(input)).toBe(false);
    }
    const throwing = Object.defineProperty({}, 'source', { get() { throw new Error('boom'); } });
    expect(classifyPromptSource(throwing)).toBe('unknown');
    expect(shouldSkipPrompt(throwing)).toBe(false);
  });
});
