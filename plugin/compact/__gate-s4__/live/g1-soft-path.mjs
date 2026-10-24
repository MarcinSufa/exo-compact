import { bigFixtureFiles, captureEvidence, coreCompactionLines, coreRan, estimateTokens, fixtureCharCount, PROBE_FIXTURES, report, runClaude, s4Stood, s4StoodCount, sendCompact, sessionIdFrom, tokensBeforeReadings } from './lib.mjs';

// D3: softThresholdPercent alone does not prove S4 actually stood -- a tiny conversation makes
// the seed render bigger than the raw transcript, so withFallback always defers to core. This
// fixture (mirroring G3/G6) gives the run real history to reduce.
const fixture = PROBE_FIXTURES.G1;
const files = bigFixtureFiles(fixture.names, fixture.repeat, fixture.extra);
const prompt = `Read files ${fixture.names.map((name) => `${name}.txt`).join(', ')}. Compare their contents, then say one short sentence.`;

// Round 12 (brief-s4a-fix12.md): the headless soft trigger does not exist. `trigger.ts`'s own
// `$.session.compact()` call rejects outright in a headless (-p / SDK) session (real debug-log
// line quoted in lib.mjs's `sendCompact` doc comment and GATE.md's round 12 section), and it fires
// `trigger: 'plugin'` even when it does not reject, never `'manual'`. So this run only builds real
// history; S4's own compaction is triggered explicitly afterward by sending `/compact` as a second
// request into the same session (`sendCompact`), which fires `session.compact` with
// `trigger: 'manual'` (cc.d.ts:7278-9). No trigger plugin is loaded (lib.mjs's new
// `includeTriggerPlugin` default is `false`), so there is nothing to soft-trigger and no
// call-announcement noise to filter.
const first = await runClaude({ prompt, files, options: {} });
const sessionId = sessionIdFrom(first);
const compacted = sessionId
  ? await sendCompact({ sessionId, projectDir: first.cwd, options: {} })
  : undefined;

const ownCount = compacted ? s4StoodCount(compacted.debugLog) : 0;
const evidenceSessionId = (compacted && sessionIdFrom(compacted)) ?? sessionId;
const evidence = await captureEvidence(first.cwd, evidenceSessionId);
const coreDidRun = compacted ? coreRan(compacted.debugLog) : false;
const coreLines = compacted ? coreCompactionLines(compacted.debugLog) : [];
// Round 8 finding 13: totalInputTokens carries ~20-25k tokens of constant system-prompt/tool
// overhead that alone clears a 10%-of-fixture floor, making the old check pass regardless of
// whether the fixture was ever actually read. compact.ts's own `compact.sizeBefore=<n>` log (CC redacts any `token...=` value in the debug log)
// line reports only the message list S4 is compacting, so this floor is checked against that
// figure instead, with a floor tight enough (50% of the fixture's own estimated size) that a
// degenerate near-empty transcript still fails it. This is logged inside compact.ts's real
// `session.compact` handler, so it only appears in the SCRIPTED /compact call's own debug log now,
// not the first (fixture-reading) call's.
const tokensBefore = compacted ? tokensBeforeReadings(compacted.debugLog) : [];
const fixtureTokenFloor = estimateTokens(fixtureCharCount(files)) * 0.5;
report('G1', [
  { name: 'a scripted /compact was sent (round 12: the headless soft trigger does not exist; see sendCompact in lib.mjs)', pass: Boolean(compacted), detail: `session=${sessionId ?? 'missing'}` },
  { name: 'S4 saw a pre-compaction message list large enough to exercise a real reduction (compact.tokensBefore vs fixture floor)', skip: !compacted, pass: tokensBefore.length > 0 && Math.max(...tokensBefore, 0) > fixtureTokenFloor, detail: `observed=${tokensBefore.join(',') || 'missing'} floor=${Math.round(fixtureTokenFloor)}` },
  { name: 'our session.compact handler ran exactly once on the scripted /compact and core never ran', skip: !compacted, pass: ownCount === 1 && Boolean(compacted && s4Stood(compacted.debugLog)) && !coreDidRun, detail: `stood=${ownCount} coreRan=${coreDidRun}` },
  { name: 'the session capture directory exists on disk', pass: evidence, detail: `session=${evidenceSessionId ?? 'missing'}` },
  { name: 'core compaction did not run', skip: !compacted, pass: !coreDidRun, detail: coreLines.length ? coreLines.join(' | ') : 'no core compaction log line' },
  { name: 'both the fixture-reading turn and the scripted /compact returned structured JSON successfully', pass: first.code === 0 && Boolean(first.parsedJson) && Boolean(compacted) && compacted.code === 0 && Boolean(compacted.parsedJson), detail: `firstExit=${first.code} compactExit=${compacted?.code ?? 'missing'}` },
]);
if (compacted) await compacted.dispose();
await first.dispose();
