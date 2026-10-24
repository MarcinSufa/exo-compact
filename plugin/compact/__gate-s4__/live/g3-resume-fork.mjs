import { bigFixtureFiles, coreRan, firstAssistantUsageForResumedPrompt, lastAssistantUsageBeforeMarker, PROBE_FIXTURES, report, resumeDebugLogIsClean, runClaude, s4Stood, sendCompact, sessionIdFrom, transcriptContainsSeed, transcriptEntries } from './lib.mjs';

const SEED = '[[exovault:s4-seed:v1]]';
const fixture = PROBE_FIXTURES.G3;
const files = bigFixtureFiles(fixture.names, fixture.repeat, fixture.extra);

const first = await runClaude({ prompt: `Read files ${fixture.names.map((name) => `${name}.txt`).join(', ')}. Compare their contents, retain the sentinel phrase BLUE-ORCHID-731, then summarize.`, files, options: {} });
const firstSessionId = sessionIdFrom(first);
// Round 12: the headless soft trigger does not exist (GATE.md's round 12 section / lib.mjs's
// sendCompact doc comment), so run 1 no longer compacts on its own. A scripted `/compact`
// (`--resume <firstSessionId>`, no fork) forces exactly one real hook compaction in the SAME
// session -- a plain `--resume` keeps the session id unchanged (round 7's fix, unchanged this
// round), so `firstSessionId` still names the right transcript file afterward.
const compacted = firstSessionId ? await sendCompact({ sessionId: firstSessionId, projectDir: first.cwd, options: {} }) : undefined;
// Round 8 finding 5: `before`/`after` are single-request `message.usage` figures read straight
// from the transcript jsonl (lib.mjs's transcriptEntries), not each run's cumulative usage across
// every request it made. Round 12: this read must happen AFTER the scripted /compact call, not
// right after run 1, because the seed sentinel this looks for is written BY that compaction, which
// is now a separate, later invocation appending to the same transcript file.
const entriesAfterCompact = firstSessionId ? await transcriptEntries(firstSessionId) : [];
const before = lastAssistantUsageBeforeMarker(entriesAfterCompact, SEED);
const checks = [
  { name: 'a scripted /compact after run 1 caused an S4 hook compaction (stood, core never ran)', pass: Boolean(compacted) && s4Stood(compacted.debugLog) && !coreRan(compacted.debugLog) },
  { name: 'run 1 returned a session id, and the transcript carries a pre-compaction per-request usage figure before the seed sentinel', pass: Boolean(firstSessionId) && before !== undefined, detail: `session=${firstSessionId ?? 'missing'} input=${before ?? 'missing'}` },
];
for (const [label, extraArgs] of [['--resume', ['--resume', String(firstSessionId)]], ['--resume --fork-session', ['--resume', String(firstSessionId), '--fork-session']]]) {
  if (!firstSessionId || !compacted) { checks.push({ name: `${label}: resume validation`, pass: false, detail: 'no session id from run 1, or the scripted /compact never ran' }); continue; }
  // Round 8 finding 5 (unchanged this round): softThresholdPercent no longer applies (no trigger
  // plugin loaded), so nothing here can accidentally re-trigger a second compaction on the
  // resume/fork call itself; this probe is purely about the FIRST post-resume request already
  // being cheaper because of the compaction already forced above.
  const resumed = await runClaude({ prompt: 'What is the sentinel phrase?', options: {}, extraArgs, projectDir: first.cwd });
  // A `--fork-session` run gets a brand-new session id; the transcript to check is the FORK's
  // own reported id, never the original run 1 id (round 7 fix -- this used to always check
  // `firstSessionId`, which is wrong for the fork case and would silently read a nonexistent or
  // unrelated transcript file, or the original transcript, neither of which the forked run wrote
  // to). A plain `--resume` (no fork) keeps the same session id, so using the resumed run's own
  // reported id is correct there too.
  const resumedSessionId = sessionIdFrom(resumed) ?? firstSessionId;
  const resumedEntries = await transcriptEntries(resumedSessionId);
  // B2 fix (review-opus-r10.md, G3 check only): anchor on the resumed prompt's own user entry,
  // not "anywhere after the seed sentinel" -- the old `firstAssistantUsageAfterMarker` passed
  // vacuously against CC's zero-usage rewritten tail fragments (entries 58-71 of aa1e2930), which
  // are not the resumed request. `firstAssistantUsageForResumedPrompt` also benefits from
  // `entryUsageTokens`'s zero-guard (undefined, not 0, for an all-zero usage entry), so a
  // genuinely-zero request can no longer read as "cheaper than before" by accident either.
  const after = firstAssistantUsageForResumedPrompt(resumedEntries);
  const transcriptSeed = await transcriptContainsSeed(resumedSessionId, SEED);
  checks.push({ name: `${label}: resumed transcript (session=${resumedSessionId ?? 'missing'}) contains the S4 seed sentinel`, pass: transcriptSeed });
  checks.push({ name: `${label}: first post-resume request's own usage is below run 1's last pre-compaction request`, pass: after !== undefined && before !== undefined && after < before, detail: `before=${before ?? 'missing'} after=${after ?? 'missing'}` });
  // B2: the resumed run's debug log must show no sign CC regrouped assistant fragments across the
  // compaction boundary (ensureToolResultPairing repairing a duplicated tool_use/tool_result set,
  // then a 400 on thinking blocks that were never meant to be replayed).
  checks.push({ name: `${label}: resumed run's debug log has no ensureToolResultPairing repair and no thinking-block 400`, pass: resumeDebugLogIsClean(resumed.debugLog) });
  checks.push({ name: `${label}: resumed request returned a result`, pass: resumed.code === 0 && resumed.parsedJson?.is_error === false, detail: `exit=${resumed.code} is_error=${resumed.parsedJson?.is_error}` });
  await resumed.dispose();
}
report('G3', checks);
if (compacted) await compacted.dispose();
await first.dispose();
