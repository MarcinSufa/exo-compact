import { bigFixtureFiles, coreRan, COMPACT_PROMPT, PROBE_FIXTURES, report, runClaudeStream, s4Stood } from './lib.mjs';

// D3: give the run real history to reduce (see G1's comment in lib.mjs / this file's sibling).
const fixture = PROBE_FIXTURES.G2;
const files = bigFixtureFiles(fixture.names, fixture.repeat, fixture.extra);
const firstTurn = `Read files ${fixture.names.map((name) => `${name}.txt`).join(', ')}. Compare their contents, then say one short sentence.`;
const secondTurn = 'Reply with the word continued.';

/**
 * Round 12: the headless soft trigger does not exist (lib.mjs's `sendCompact` doc comment /
 * GATE.md's round 12 section), so the middle turn is now a literal, scripted `/compact` -- the
 * same prompt `sendCompact` sends over `--resume`, here written directly into the stream as the
 * second of three turns. Single process, single session: each later user message is only written
 * to stdin after the previous turn's `result` event has arrived (see lib.mjs's `runClaudeStream`),
 * so `secondTurn` necessarily lands after whatever the `/compact` turn caused. This is G2's whole
 * point: a real hook compaction and the next request, in ONE continuous process, which is exactly
 * what a `--resume`-based scripted /compact (a fresh process) cannot exercise -- that is G3's job.
 *
 * Uncertainty flagged, unchanged from prior rounds and unresolved this round (no live `claude`
 * invocation permitted, per the brief): whether a `/compact` turn over stream-json emits a
 * `type: 'result'` event the same way an ordinary answer turn does (needed for `runClaudeStream`'s
 * `sendNextTurn` to fire `secondTurn` at all) is read from cc.d.ts's documented `command.run`/
 * `session.compact` shapes, not confirmed live.
 */
const result = await runClaudeStream({ turns: [firstTurn, COMPACT_PROMPT, secondTurn], options: {}, files });
const [first, compacted, second] = result.results ?? [];

report('G2', [
  { name: 'first turn (fixture read) completed', pass: Boolean(first) },
  { name: 'the scripted /compact turn caused an S4 hook compaction (stood, core never ran)', pass: Boolean(compacted) && s4Stood(result.debugLog) && !coreRan(result.debugLog) },
  { name: 'a second prompt after hook compaction, in the same process, exited successfully with a non-empty answer', pass: Boolean(second) && second.is_error === false && Boolean(String(second.result ?? '').trim()), detail: second ? `is_error=${second.is_error} result_len=${String(second.result ?? '').length}` : 'no third result event' },
  { name: 'auto-style mid-tool-loop compaction with thinking', skip: true, optionalSkip: true, detail: 'not established as cheaply reachable without spending additional plan tokens' },
]);
await result.dispose();
