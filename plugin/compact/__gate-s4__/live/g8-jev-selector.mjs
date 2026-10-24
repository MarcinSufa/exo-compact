import { bigFixtureFiles, PROBE_FIXTURES, report, runClaude, sendCompact, sessionIdFrom } from './lib.mjs';

/**
 * G8 (spec v3.4.3-s4b §3.3 J, `core/select-j.ts` / `host/jev-client.ts`): live-only verification of
 * selector J's privacy rule and its clean-skip/real-call M7 logging, against the real Claude Code
 * hook runtime. Never run by the implementer (brief-s4b-jev.md's own instruction); intended for the
 * the maintainer or a later live-gate pass to run by hand.
 *
 * brief-s4b-fix2.md (jev-live-smoke-20260926.md smoke 3): every question sent to Jev now also
 * carries a per-question `instructions` string naming its own span id (`buildJevInstructions`), the
 * fix for smoke 2's finding that identical questions in a batch left Jev unable to tell which span
 * a given question was about. This is invisible to M7's own log line (`compact.jev_units=<n>
 * compact.jev_fallback=<n>` already counts the added per-question overhead as part of the existing
 * batch-sizing/units accounting, no new field), so the checks below are unchanged; this header note
 * exists so a reader diffing G8 across rounds can see the wire shape moved without a check re-read.
 *
 * The TypeSafe API key is read only from the environment: this script never reads, prints, or
 * forwards `TYPESAFE_API_KEY` itself. `lib.mjs`'s `buildChildEnv` already inherits the parent
 * process's environment unchanged into every spawned `claude` child (only `CLAUDE_CODE_*` vars are
 * stripped), so if the operator running this script has `TYPESAFE_API_KEY` exported in their own
 * shell, the child hook process sees it exactly as `$.env.get('TYPESAFE_API_KEY')` would.
 *
 * **review-opus-s4b-r2.md B1 (this round): a no-key skip on the enabled/not-denied path is now a
 * FAILURE of this check, not an acceptable alternative.** The prior header wording called a
 * `compact.jev_skipped=no_api_key` outcome there "itself a pass" -- that let this live gate pass
 * clean on an environment that never actually exercised J at all, which is exactly backwards for
 * the gate the maintainer is meant to run before spending money on the A/B. If the operator running
 * this script has not exported `TYPESAFE_API_KEY` in their own shell, the third check below is
 * expected to fail, loudly, telling the operator to export the key and rerun before trusting any
 * calibration result.
 *
 * **review-opus-s4b-r2.md B1, off/deny-list checks:** F6 (review-opus-s4b.md) made `compact.ts` log
 * `compact.jev_units=0 compact.jev_fallback=0` plus `compact.jev_skipped=<reason>` on the disabled
 * and deny-list paths too, not only on a genuine throw. The old checks below asserted "no
 * `compact.jev_*` log line at all" on these two runs, which is now always false (a clean
 * off/deny-list run always logs `jev_skipped=disabled`/`jev_skipped=deny_list`) and would fail both
 * runs even though they behave correctly. The checks now assert the specific skip reason instead.
 *
 * Three separate sessions, mirroring g1-soft-path.mjs's fixture pattern (a real, sizeable history
 * so `withFallback` actually keeps S4's own reduction instead of deferring to core, which is a
 * precondition for the reasoning-selection code path -- and so selector J or D -- to run at all):
 *
 *   1. jevEnabled left at its default (false): the privacy rule (spec §3.6/v2 §4 "off by default")
 *      must produce `compact.jev_skipped=disabled` (and jev_units=0 jev_fallback=0); the whole
 *      reasoning selection goes to D.
 *   2. jevEnabled=true but jevDenyList matches this run's own project directory: same as (1) but
 *      `compact.jev_skipped=deny_list`, since `isJevAllowed` denies before any Jev call is even
 *      attempted.
 *   3. jevEnabled=true, no deny-list match: a real Jev call must have been attempted
 *      (`compact.jev_units=<n> compact.jev_fallback=<n>` with `n > 0`, plus a
 *      `compact.jev_decision_sha=<hex>` line, B2: renamed from `jev_tokens` since the CC debug log
 *      redacts any value whose key contains "token"). review-opus-s4b-r2.md B1: this check FAILS,
 *      it does not pass, when the run instead logged `compact.jev_skipped=no_api_key` -- an operator
 *      running this script by hand is expected to have `TYPESAFE_API_KEY` exported in their own
 *      shell (see the paragraph above); a no-key skip here means the live gate was not actually
 *      exercised, not that J behaved correctly.
 *   4. brief-s4b-fix4.md item 6: the same real-world shape calibration A-J-0 found -- jevEnabled=true,
 *      no deny-list match, but this session's own prompt includes a genuine ~50KB paste, the exact
 *      condition that made `compact.ts`'s pre-fix unbounded `lastUserMessages` alone exceed
 *      `JEV_BATCH_MAX_TOKENS` and silently zero out every real Jev call. Requires the same real-call
 *      evidence as case 3 (`jev_decision_sha=` present, `jev_units > 0`): this is the live-probe proof
 *      that the query-cap fix (this round) actually reaches a real session with a real oversized
 *      paste, not only the gate's own fake-Jev tests. **Not run by the implementer this round** (the
 *      brief's own "no real network calls" rule); added to this file's source and syntax-checked only
 *      (`node --check`).
 */
const fixture = PROBE_FIXTURES.G8 ?? PROBE_FIXTURES.G1;
const files = bigFixtureFiles(fixture.names, fixture.repeat, fixture.extra);
const prompt = `Read files ${fixture.names.map((name) => `${name}.txt`).join(', ')}. Compare their contents, then say one short sentence.`;

async function compactOnceWith(options) {
  const first = await runClaude({ prompt, files, options: { softThresholdPercent: 1, ...options } });
  const sessionId = sessionIdFrom(first);
  const compacted = sessionId ? await sendCompact({ sessionId, projectDir: first.cwd, options: { softThresholdPercent: 1, ...options } }) : undefined;
  return { first, compacted };
}

function jevUnitsAndFallback(log) {
  const m = /compact\.jev_units=(\d+) compact\.jev_fallback=(\d+)/.exec(log);
  return m ? { units: Number(m[1]), fallback: Number(m[2]) } : undefined;
}

function jevSkippedReason(log, reason) {
  return log.includes(`compact.jev_skipped=${reason}`);
}

function hasJevDecisionSha(log) {
  return /compact\.jev_decision_sha=[0-9a-f]{64}/.test(log);
}

// 1. Default off.
const off = await compactOnceWith({});
const offLog = off.compacted?.debugLog ?? '';
const offResult = jevUnitsAndFallback(offLog);

// 2. Deny-list active. Every probe project directory is `mkdtemp(os.tmpdir(), 's4-gate-project-')`
// (lib.mjs's runClaude), so this literal substring matches this run's own cwd without needing to
// know the random suffix in advance -- a stand-in for a real client-repo deny-list entry.
const denied = await compactOnceWith({ jevEnabled: true, jevDenyList: 's4-gate-project' });
const deniedLog = denied.compacted?.debugLog ?? '';
const deniedResult = jevUnitsAndFallback(deniedLog);

// 3. Enabled, not denied.
const enabled = await compactOnceWith({ jevEnabled: true, jevDenyList: '' });
const enabledLog = enabled.compacted?.debugLog ?? '';
const enabledResult = jevUnitsAndFallback(enabledLog);
const enabledSkippedNoKey = jevSkippedReason(enabledLog, 'no_api_key');
const enabledRealCall = Boolean(enabledResult) && enabledResult.units > 0 && !enabledSkippedNoKey && hasJevDecisionSha(enabledLog);

// 4. brief-s4b-fix4.md item 6: enabled, not denied, this session's own prompt carries a genuine
// ~50KB paste -- the real-world shape calibration A-J-0 found. Requires the same real-call
// evidence as case 3; a no-key skip is a FAILURE here too, for the same reason as case 3.
const bigPaste = 'the user pasted this fifty-kilobyte block for the live G8 probe: '.repeat(800);
const bigPastePrompt = `${prompt}\n\nAlso, for context, here is a large paste: ${bigPaste}`;
async function compactOnceWithPrompt(promptText, options) {
  const first = await runClaude({ prompt: promptText, files, options: { softThresholdPercent: 1, ...options } });
  const sessionId = sessionIdFrom(first);
  const compacted = sessionId ? await sendCompact({ sessionId, projectDir: first.cwd, options: { softThresholdPercent: 1, ...options } }) : undefined;
  return { first, compacted };
}
const enabledBigPaste = await compactOnceWithPrompt(bigPastePrompt, { jevEnabled: true, jevDenyList: '' });
const enabledBigPasteLog = enabledBigPaste.compacted?.debugLog ?? '';
const enabledBigPasteResult = jevUnitsAndFallback(enabledBigPasteLog);
const enabledBigPasteSkippedNoKey = jevSkippedReason(enabledBigPasteLog, 'no_api_key');
const enabledBigPasteRealCall = Boolean(enabledBigPasteResult) && enabledBigPasteResult.units > 0 && !enabledBigPasteSkippedNoKey && hasJevDecisionSha(enabledBigPasteLog);

report('G8', [
  { name: 'off-by-default run compacted (a hook compaction actually happened)', pass: Boolean(off.compacted), detail: `session=${sessionIdFrom(off.first) ?? 'missing'}` },
  // review-opus-s4b-r2.md B1: off-by-default still emits an M7 line (F6), just with jev_skipped=disabled;
  // "no jev line at all" is no longer the correct check.
  { name: 'off by default: compact.jev_skipped=disabled, with jev_units=0 jev_fallback=0', skip: !off.compacted, pass: jevSkippedReason(offLog, 'disabled') && Boolean(offResult) && offResult.units === 0 && offResult.fallback === 0, detail: offResult ? `units=${offResult.units} fallback=${offResult.fallback} skipped=${jevSkippedReason(offLog, 'disabled')}` : 'no compact.jev_units line observed' },
  { name: 'deny-list run compacted', pass: Boolean(denied.compacted), detail: `session=${sessionIdFrom(denied.first) ?? 'missing'}` },
  { name: 'deny-list matched: compact.jev_skipped=deny_list, with jev_units=0 jev_fallback=0 (denied before any Jev call)', skip: !denied.compacted, pass: jevSkippedReason(deniedLog, 'deny_list') && Boolean(deniedResult) && deniedResult.units === 0 && deniedResult.fallback === 0, detail: deniedResult ? `units=${deniedResult.units} fallback=${deniedResult.fallback} skipped=${jevSkippedReason(deniedLog, 'deny_list')}` : 'no compact.jev_units line observed' },
  { name: 'enabled/not-denied run compacted', pass: Boolean(enabled.compacted), detail: `session=${sessionIdFrom(enabled.first) ?? 'missing'}` },
  // review-opus-s4b-r2.md B1: a real call is required here, full stop. A no-key skip used to count as
  // a pass; it no longer does, since that let this check pass on an environment that never actually
  // exercised J at all. Run this script with `TYPESAFE_API_KEY` exported in your own shell (see the
  // file header) or this check fails.
  { name: 'enabled/not-denied: a real Jev call was attempted -- jev_units > 0 and a compact.jev_decision_sha= line (a no-key skip is a FAILURE here, review-opus-s4b-r2.md B1, not an acceptable alternative)', skip: !enabled.compacted, pass: enabledRealCall, detail: enabledSkippedNoKey ? 'FAIL: compact.jev_skipped=no_api_key (export TYPESAFE_API_KEY before running this script)' : enabledResult ? `jev_units=${enabledResult.units} jev_fallback=${enabledResult.fallback} decision_sha=${hasJevDecisionSha(enabledLog)}` : 'FAIL: neither a real call nor a no-key skip was logged' },
  { name: 'jevTokens (M7 units) and fallbackCount are both finite non-negative integers', skip: !enabledRealCall, pass: enabledRealCall && Number.isInteger(enabledResult.units) && enabledResult.units >= 0 && Number.isInteger(enabledResult.fallback) && enabledResult.fallback >= 0, detail: enabledResult ? `jev_units=${enabledResult.units} jev_fallback=${enabledResult.fallback}` : 'no real call attempted this run (see the check above, already failed)' },
  { name: 'enabled/not-denied run with a ~50KB paste compacted', pass: Boolean(enabledBigPaste.compacted), detail: `session=${sessionIdFrom(enabledBigPaste.first) ?? 'missing'}` },
  // brief-s4b-fix4.md item 6: the real-world shape calibration A-J-0 found. Before this round's fix,
  // this case would have logged compact.jev_units=0 with no jev_decision_sha at all (every span
  // misreported as individually oversized, ask() never called); the fix requires a real call here.
  { name: 'a ~50KB paste in the prompt still produces a real Jev call -- jev_units > 0 and a compact.jev_decision_sha= line (brief-s4b-fix4.md item 6, calibration A-J-0 shape)', skip: !enabledBigPaste.compacted, pass: enabledBigPasteRealCall, detail: enabledBigPasteSkippedNoKey ? 'FAIL: compact.jev_skipped=no_api_key (export TYPESAFE_API_KEY before running this script)' : enabledBigPasteResult ? `jev_units=${enabledBigPasteResult.units} jev_fallback=${enabledBigPasteResult.fallback} decision_sha=${hasJevDecisionSha(enabledBigPasteLog)}` : 'FAIL: neither a real call nor a no-key skip was logged (the original calibration A-J-0 bug: every span misreported as oversized)' },
]);

await off.compacted?.dispose();
await off.first.dispose();
await denied.compacted?.dispose();
await denied.first.dispose();
await enabled.compacted?.dispose();
await enabled.first.dispose();
await enabledBigPaste.compacted?.dispose();
await enabledBigPaste.first.dispose();
