import { bigFixtureFiles, coreRan, PROBE_FIXTURES, report, resumeDebugLogIsClean, runClaude, sessionIdFrom } from './lib.mjs';

/**
 * G2b (round 16, brief-s4a-fix16.md F1): the live case G2's own report has always SKIPped
 * ("auto-style mid-tool-loop compaction with thinking ... not established as cheaply reachable
 * without spending additional plan tokens", g2-post-compact-request.mjs) and that
 * review-opus-r10.md's B2 investigation left as the one open question its "keep only the last
 * assistant turn handled" recommendation depends on (line 313-316: "Mid-tool-loop auto compaction
 * (the untested G2 case) with thinking on is where the spec keeps the last assistant turn
 * handled... or rebuild all there too, once G2b is proven").
 *
 * Reachable cheaply: every other probe in this directory reaches the S4 *soft* trigger
 * (`trigger: 'plugin'`, `exovault-s4-trigger`'s own `softThresholdPercent`) or a scripted
 * `/compact` (`trigger: 'manual'`, `sendCompact`). Neither is `'auto'` -- cc.d.ts:7280/7285's
 * `SessionCompactTrigger` documents `'auto'` as "the engine at its threshold or on a prompt too
 * long", the engine's OWN context-window housekeeping, not anything a plugin calls. Forcing that
 * threshold with a REAL multi-hundred-thousand-token session would be exactly the expensive path
 * this brief rules out. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (cc.d.ts:1949-1953's
 * `ContextWindowSource`, `'env'`) lets a
 * live run shrink the engine's own auto-compact window instead of shrinking the session -- a small
 * fixture plus a small window reaches `trigger: 'auto'` for the price of a G1-sized probe, no
 * different from every other probe in this directory.
 *
 * The "mid-tool-loop" half: the prompt below asks for the fixture files ONE AT A TIME, with a
 * short comment after each read, rather than in one parallel batch (like G1/G3/G7's "read files
 * a..e" phrasing) specifically so the running transcript crosses the shrunk auto-compact window
 * SOMEWHERE inside that sequence of individual tool_use/tool_result round trips, not only at a
 * clean turn boundary between two whole user/assistant exchanges. This cannot be forced to land at
 * an exact call boundary from outside the engine (compiled binary, no hook fires before the
 * decision to compact is made) -- same class of uncertainty G2's own doc comment already flags for
 * its stream-json protocol. What this probe DOES check, deterministically, from the artifacts a
 * run actually produces:
 *   1. some `session.compact (auto): ...` line exists at all (the shrunk window was actually
 *      crossed natively, not merely configured);
 *   2. when it names our plugin's hooked-by list with "core never ran", S4's tail picker won that
 *      compaction under `trigger: 'auto'` -- exactly the code path `core/tail.ts`'s v3.2.3 F1 fix
 *      (every fragment of the last assistant turn keeps its handle, not only one) is meant to keep
 *      safe on resume;
 *   3. a same-session follow-up question after that (`--resume`, same technique as
 *      g3-resume-fork.mjs) shows no `ensureToolResultPairing` repair and no thinking-block 400
 *      (`resumeDebugLogIsClean`, review-opus-r10.md B2) -- the actual, resume-time proof that
 *      keeping the WHOLE exempted run handled (not just its last fragment) was enough, or that it
 *      was not and rebuilding everything under `auto` too (option (b), not chosen this round) is
 *      needed after all.
 *
 * Costed like G1 (one small fixture, no fork): NOT run this round (the brief's "do NOT run it; the
 * maintainer runs live probes" instruction) and not added to run-all.mjs's own probe list for the
 * same reason -- `run-all.mjs --dry` still prints this file's own command by being invoked in
 * isolation (`node g2b-auto-mid-tool-loop.mjs --dry`), same as every other probe file, but this one
 * is deliberately left out of the batch `run-all.mjs` runs live so the maintainer opts into its
 * (still real, if small) `claude` invocations explicitly.
 */
const fixture = PROBE_FIXTURES.G2;
const files = bigFixtureFiles(fixture.names, fixture.repeat, fixture.extra);
// Small enough that the fixture alone does not already exceed the shrunk window before any tool
// call runs (G1/G2/G3/G5/G7 all use the same ~4-5k-token-per-file fixture for their own single- or
// few-request probes); the window below is picked to sit UNDER one file's cost plus the per-request
// base, so crossing it requires at least a couple of the sequential reads below, not the first one.
const AUTO_COMPACT_WINDOW_TOKENS = 12000;
const prompt = `Read the files ${fixture.names.map((name) => `${name}.txt`).join(', ')} ONE AT A TIME, in that exact order. After each file, write one short sentence about it before reading the next file. Do not read more than one file per turn of thinking. When all five are read, reply with the single word done.`;

const first = await runClaude({
  prompt,
  files,
  options: {},
  envOverrides: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: AUTO_COMPACT_WINDOW_TOKENS },
});
const firstSessionId = sessionIdFrom(first);

const AUTO_STAND_LINE = /session\.compact \(auto\): a hook's (\d+) messages stand \(hooked by ([^)]*)\); (core never ran|core ran beneath)/;
const PLUGIN_NAME = 'exo-compact';
function autoStandLines(log) {
  return log.split('\n').filter((line) => AUTO_STAND_LINE.test(line));
}
function s4StoodUnderAuto(log) {
  return log.split('\n').some((line) => {
    const m = AUTO_STAND_LINE.exec(line);
    return Boolean(m) && m[2].includes(PLUGIN_NAME) && m[3] === 'core never ran';
  });
}

const autoLines = autoStandLines(first.debugLog);
const stoodUnderAuto = s4StoodUnderAuto(first.debugLog);
const checks = [
  { name: 'run 1 (sequential fixture reads, shrunk CLAUDE_CODE_AUTO_COMPACT_WINDOW) completed', pass: first.code === 0 && first.parsedJson?.is_error === false, detail: `exit=${first.code} is_error=${first.parsedJson?.is_error}` },
  { name: 'the shrunk window was actually crossed natively: at least one session.compact (auto) line appears', pass: autoLines.length > 0 || first.code !== 0, detail: autoLines.length ? autoLines.join(' | ').slice(0, 400) : (first.code === 0 ? 'no session.compact (auto) line -- the fixture/window pairing may need adjusting on the first live run' : 'run did not complete cleanly, see exit/is_error above') },
  { name: 'when it crossed, S4 stood under trigger=auto (hooked by our plugin, core never ran)', skip: autoLines.length === 0, optionalSkip: true, pass: stoodUnderAuto, detail: stoodUnderAuto ? undefined : 'an auto compaction happened but core ran instead of S4 (or a different hook), see debug log' },
];

if (firstSessionId && stoodUnderAuto) {
  const resumed = await runClaude({ prompt: 'Say ok.', options: {}, extraArgs: ['--resume', String(firstSessionId)], projectDir: first.cwd });
  checks.push({ name: 'a same-session follow-up after the mid-loop auto compaction resumes cleanly: no ensureToolResultPairing repair, no thinking-block 400 (review-opus-r10.md B2)', pass: resumeDebugLogIsClean(resumed.debugLog) });
  checks.push({ name: 'the follow-up request itself returned a result, not an error', pass: resumed.code === 0 && resumed.parsedJson?.is_error === false, detail: `exit=${resumed.code} is_error=${resumed.parsedJson?.is_error} coreRan=${coreRan(resumed.debugLog)}` });
  await resumed.dispose();
} else {
  checks.push({ name: 'same-session resume-cleanliness check (needs run 1 to have stood under trigger=auto)', skip: true, optionalSkip: true, detail: 'skipped: run 1 did not produce a session id and an auto stand, see the checks above' });
}

report('G2b', checks);
await first.dispose();
