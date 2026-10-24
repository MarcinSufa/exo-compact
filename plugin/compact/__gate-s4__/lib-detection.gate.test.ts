import { describe, it, expect } from 'vitest';
import {
  coreRan,
  s4Stood,
  skippedWithReason,
  entryUsageTokens,
  isPlainTextUserEntry,
  lastRealUserEntryIndex,
  firstAssistantUsageAfterIndex,
  firstAssistantUsageForResumedPrompt,
  resumeDebugLogIsClean,
} from './live/lib.mjs';

/**
 * Round 9 finding 7: `coreRan()` treated ANY `compact.fallback=` line as proof core produced the
 * result. Three different call sites log that same prefix: `core/handler.ts`'s `withFallback`
 * (compact.ts's session.compact path, where a fallback really does mean `next()`/core ran),
 * `compact.ts`'s `turn.complete` handler (a per-turn *capture* failure, unrelated to whether core
 * ever ran a compaction), and `trigger.ts`'s own catch (the soft-trigger's background
 * `session.compact()` call failing, logged on a turn.complete that already returned `next()`'s own
 * result). The latter two used to be misread by a live probe as "core ran". Every writer now
 * appends `origin=compact` (the true session.compact fallback) or `origin=turn-capture` /
 * `origin=trigger` (neither means core ran), and `coreRan()` only trusts `origin=compact`.
 */
describe('lib.mjs coreRan(): round 9 finding 7 (origin field disambiguates compact.fallback= lines)', () => {
  it('does not count a turn-capture failure log line as core having run', () => {
    const log = 'some turn ui output\ncompact.fallback=error origin=turn-capture\nmore output\n';
    expect(coreRan(log)).toBe(false);
  });

  it('does not count a trigger.ts soft-trigger failure log line as core having run', () => {
    const log = 'compact.fallback=error origin=trigger\n';
    expect(coreRan(log)).toBe(false);
  });

  it('still counts a real session.compact fallback (core actually ran beneath it) as core having run', () => {
    const log = 'compact.fallback=timeout origin=compact\n';
    expect(coreRan(log)).toBe(true);
  });

  it('still counts a real session.compact fallback logged by compact.ts\'s own outer catch as core having run', () => {
    const log = 'compact.fallback=error origin=compact\n';
    expect(coreRan(log)).toBe(true);
  });
});

/**
 * Round 12 (brief-s4a-fix12.md): a real diagnostic live run against 09c75b58 (the maintainer's
 * /tmp/s4-gate-project-hfKAZi/debug.log, lines 221-223, kept verbatim below) showed `coreRan()`
 * misreading `trigger.ts`'s own call-announcement line as proof core ran a compaction:
 *
 * ```
 * 2026-09-26T12:04:24.360Z [DEBUG] $.session.compact (exovault-s4-trigger): compacting, 0 chars of instructions
 * 2026-09-26T12:04:24.360Z [DEBUG] [exovault-s4-trigger] $.ui.log: trigger.diag=exovault-s4-trigger: $.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on
 * 2026-09-26T12:04:24.360Z [DEBUG] [exovault-s4-trigger] $.ui.log: compact.fallback=error origin=trigger
 * ```
 *
 * The engine logs `session.compact (<plugin>): compacting, <n> chars of instructions` the moment a
 * PLUGIN calls `$.session.compact()` (cc.d.ts:2344-5's "the event `session.compact` with `trigger`
 * `plugin`"), before the call has resolved or rejected -- an attempt announcement, not an outcome.
 * Here it rejects one line later ("not available in a headless session"), so no compaction of any
 * kind happened, yet the old `coreRan()` fell through to its catch-all `/session\.compact \(/`
 * match and reported `true`. This is the exact false positive the round-12 G1 diagnostic run (see
 * GATE.md's round 12 section) traced every headless G1/G3/G5 false FAIL and G4 agentId false PASS
 * back to, since every headless run loaded `trigger.ts` and it logs this pair on every turn once
 * capture is enabled, regardless of what the probe under test is actually checking.
 */
describe('lib.mjs coreRan(): round 12 (a plugin\'s own $.session.compact() call-announcement line is not an outcome)', () => {
  const realCallAnnouncementOnly = '2026-09-26T12:04:24.360Z [DEBUG] $.session.compact (exovault-s4-trigger): compacting, 0 chars of instructions';
  const realFullRejectedAttempt = [
    realCallAnnouncementOnly,
    '2026-09-26T12:04:24.360Z [DEBUG] [exovault-s4-trigger] $.ui.log: trigger.diag=exovault-s4-trigger: $.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on',
    '2026-09-26T12:04:24.360Z [DEBUG] [exovault-s4-trigger] $.ui.log: compact.fallback=error origin=trigger',
  ].join('\n');
  // Same call-announcement line, seen paired only with the generic rejection fallback (no
  // trigger.diag line), taken verbatim from /tmp/s4-gate-project-2w2bYU/debug.log lines 218-219.
  const realShortRejectedAttempt = [
    '2026-09-26T12:03:23.452Z [DEBUG] $.session.compact (exovault-s4-trigger): compacting, 0 chars of instructions',
    '2026-09-26T12:03:23.452Z [DEBUG] [exovault-s4-trigger] $.ui.log: compact.fallback=error origin=trigger',
  ].join('\n');

  it('does not count a bare call-announcement line as core having run', () => {
    expect(coreRan(realCallAnnouncementOnly)).toBe(false);
  });

  it('does not count the real rejected-in-headless attempt (call-announcement + trigger.diag + fallback=error origin=trigger) as core having run', () => {
    expect(coreRan(realFullRejectedAttempt)).toBe(false);
  });

  it('does not count the real short rejected attempt (call-announcement + fallback=error origin=trigger, no trigger.diag line) as core having run', () => {
    expect(coreRan(realShortRejectedAttempt)).toBe(false);
  });

  it('does not count a call-announcement line as S4 having stood either (it never reached an outcome)', () => {
    expect(s4Stood(realFullRejectedAttempt)).toBe(false);
  });

  it('a call-announcement line with a nonzero instruction char count is still not an outcome', () => {
    expect(coreRan('session.compact (exo-compact): compacting, 42 chars of instructions')).toBe(false);
  });
});

/**
 * Round 12: `skippedWithReason`'s `SKIP_LINE` format (`session.compact (<trigger>): skipped
 * (<reason>; hooked by <names>)`) is still unverified against a real debug log -- none of the 8
 * kept round-12 logs contain a `session.compact (exo-compact` or `skipped (` line at all
 * (grepped directly; see the report), because no headless run ever sent a real `/compact` prompt,
 * so `compact.ts`'s own `session.compact` hook never once fired. These tests pin today's
 * documented-but-unconfirmed shape so a future live run's real line can be diffed against it
 * quickly; they do not claim the shape itself is confirmed.
 */
describe('lib.mjs skippedWithReason(): documented shape, still unverified against a real log (round 12)', () => {
  it('matches the documented precompute skip line shape for the compact plugin', () => {
    const log = "session.compact (exo-compact): skipped (precompute; hooked by exo-compact)\n";
    expect(skippedWithReason(log, 'precompute')).toBe(true);
  });

  it('does not match a call-announcement line as any kind of skip', () => {
    const log = '$.session.compact (exovault-s4-trigger): compacting, 0 chars of instructions\n';
    expect(skippedWithReason(log, 'precompute')).toBe(false);
  });
});

/**
 * Mutation survivor M10 (review-opus-r10.md mutation-survivor list, brief-s4a-fix13.md item 5):
 * `coreRan`'s round 8 finding 6 branch (`if (line.includes('compact.route=next')) return true;`,
 * lib.mjs:405) is real, load-bearing code (this plugin's own agentId/subagent pass-through log
 * line, documented in the comment above it) but had no direct test anywhere in this suite, so a
 * mutant that deleted or inverted that branch still passed every existing test. Pinned directly.
 */
describe('lib.mjs coreRan(): mutation survivor M10 (compact.route=next pass-through, round 8 finding 6)', () => {
  it('counts a compact.route=next line as core having run', () => {
    const log = 'some other line\ncompact.route=next\nmore output';
    expect(coreRan(log)).toBe(true);
  });

  it('counts compact.route=next even as the only line in the log', () => {
    expect(coreRan('compact.route=next')).toBe(true);
  });

  it('does not count an unrelated line mentioning "route" or "next" as core having run', () => {
    expect(coreRan('the next step is to route the request\n')).toBe(false);
  });
});

/**
 * B2 (review-opus-r10.md, brief-s4a-fix13.md item 4, G3 check only): pure unit tests for the new
 * lib.mjs parsers `entryUsageTokens`/`isPlainTextUserEntry`/`lastRealUserEntryIndex`/
 * `firstAssistantUsageAfterIndex`/`firstAssistantUsageForResumedPrompt`/`resumeDebugLogIsClean`,
 * fixtured from the review's own real numbers and log lines (transcript aa1e2930 entries 58-71,
 * all usage (0,0,0,0); the resumed reply's real usage 10 + 17661 + 13687 = 31358 input tokens,
 * against 30567 before compaction; the fork's resume debug log,
 * /tmp/s4-gate-project-T2JKdy/debug.log 12:34:07.975 and 12:34:11.193).
 */
describe('lib.mjs entryUsageTokens(): B2 zero-guard (review-opus-r10.md, transcript aa1e2930 entries 58-71)', () => {
  it('returns undefined for an all-zero usage entry (a CC-rewritten tail fragment, not a real request)', () => {
    const entry = { type: 'assistant', message: { usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
    expect(entryUsageTokens(entry)).toBeUndefined();
  });

  it('returns undefined when usage is entirely absent', () => {
    expect(entryUsageTokens({ type: 'assistant', message: {} })).toBeUndefined();
  });

  it('sums the three input-token figures for a real request, the review\'s own 10 + 17661 + 13687 = 31358', () => {
    const entry = { type: 'assistant', message: { usage: { input_tokens: 10, cache_read_input_tokens: 17661, cache_creation_input_tokens: 13687 } } };
    expect(entryUsageTokens(entry)).toBe(31358);
  });

  it('treats a missing individual field as 0, not NaN', () => {
    const entry = { type: 'assistant', message: { usage: { input_tokens: 5 } } };
    expect(entryUsageTokens(entry)).toBe(5);
  });
});

describe('lib.mjs isPlainTextUserEntry(): B2 (a genuine prompt, never a tool_result housekeeping entry)', () => {
  it('is true for a plain string content user entry', () => {
    expect(isPlainTextUserEntry({ type: 'user', message: { content: 'What is the sentinel phrase?' } })).toBe(true);
  });

  it('is false for an empty string content', () => {
    expect(isPlainTextUserEntry({ type: 'user', message: { content: '' } })).toBe(false);
  });

  it('is true for an all-text-block array content', () => {
    expect(isPlainTextUserEntry({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } })).toBe(true);
  });

  it('is false when the content array contains a tool_result block (CC housekeeping, not a person typing)', () => {
    expect(isPlainTextUserEntry({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', text: 'ok' }] } })).toBe(false);
  });

  it('is false for an empty array content', () => {
    expect(isPlainTextUserEntry({ type: 'user', message: { content: [] } })).toBe(false);
  });

  it('is false for an assistant entry regardless of content shape', () => {
    expect(isPlainTextUserEntry({ type: 'assistant', message: { content: 'hi' } })).toBe(false);
  });
});

describe('lib.mjs lastRealUserEntryIndex() / firstAssistantUsageAfterIndex() / firstAssistantUsageForResumedPrompt(): B2 fix', () => {
  // Shape mirrors g3-resume-fork.mjs's real transcript: the resumed prompt's own user entry,
  // followed by CC's zero-usage rewritten tail fragments (aa1e2930 entries 58-71), followed by
  // the real reply (the review's 31358 figure).
  const entries = [
    { type: 'user', message: { content: 'What is the sentinel phrase?' } },
    { type: 'assistant', message: { usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: 'assistant', message: { usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: 'assistant', message: { usage: { input_tokens: 10, cache_read_input_tokens: 17661, cache_creation_input_tokens: 13687 } } },
  ];

  it('lastRealUserEntryIndex finds the resumed prompt\'s own user entry', () => {
    expect(lastRealUserEntryIndex(entries)).toBe(0);
  });

  it('lastRealUserEntryIndex returns -1 when there is no genuine user entry', () => {
    expect(lastRealUserEntryIndex([{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', text: 'ok' }] } }])).toBe(-1);
  });

  it('firstAssistantUsageAfterIndex skips the zero-usage tail fragments and returns the real reply\'s usage', () => {
    expect(firstAssistantUsageAfterIndex(entries, 0)).toBe(31358);
  });

  it('firstAssistantUsageAfterIndex returns undefined when nothing nonzero follows', () => {
    expect(firstAssistantUsageAfterIndex(entries.slice(0, 3), 0)).toBeUndefined();
  });

  it('firstAssistantUsageForResumedPrompt anchors on the resumed prompt\'s own user entry and skips the zero-usage fragments, yielding the review\'s 31358', () => {
    expect(firstAssistantUsageForResumedPrompt(entries)).toBe(31358);
  });

  it('firstAssistantUsageForResumedPrompt returns undefined when there is no genuine resumed prompt at all', () => {
    expect(firstAssistantUsageForResumedPrompt([{ type: 'assistant', message: { usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }])).toBeUndefined();
  });
});

describe('lib.mjs resumeDebugLogIsClean(): B2 (review-opus-r10.md, /tmp/s4-gate-project-T2JKdy/debug.log)', () => {
  it('is false when the debug log shows CC repaired missing tool_result blocks across the compaction boundary', () => {
    const log = '2026-09-25T12:34:07.975Z [DEBUG] ensureToolResultPairing: repaired missing tool_result blocks\n';
    expect(resumeDebugLogIsClean(log)).toBe(false);
  });

  it('is false when the debug log shows the API 400 on modified thinking blocks', () => {
    const log = '2026-09-25T12:34:11.193Z [ERROR] API error 400: {"type":"error","error":{"message":"messages.1.content.15: thinking or redacted_thinking blocks in the latest assistant message cannot be modified"}}\n';
    expect(resumeDebugLogIsClean(log)).toBe(false);
  });

  it('is true for an ordinary clean resume debug log', () => {
    const log = '2026-09-25T12:34:07.000Z [DEBUG] session.compact (exo-compact): a hook\'s 3 messages stand (hooked by exo-compact); core never ran\n';
    expect(resumeDebugLogIsClean(log)).toBe(true);
  });

  it('is true for an empty or missing debug log', () => {
    expect(resumeDebugLogIsClean('')).toBe(true);
    expect(resumeDebugLogIsClean(undefined)).toBe(true);
  });
});
