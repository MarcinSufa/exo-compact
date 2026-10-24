import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { bigFixtureFiles, coreRan, PROBE_FIXTURES, report, runClaude, s4Stood, sendCompact, sessionIdFrom, skippedWithReason } from './lib.mjs';

/**
 * Round 12 (brief-s4a-fix12.md): the headless soft trigger does not exist (trigger.ts's own
 * $.session.compact() call always rejects in a -p/SDK session -- see lib.mjs's sendCompact doc
 * comment and GATE.md's round 12 section), so `softThresholdPercent` never caused a real
 * session.compact dispatch here in any prior round -- both the round-11 "precompute" and
 * "agentId" checks below were exercising `gateForceTrigger`/`gateForceAgentId` against an
 * `extraArgs: ['--resume', ...]` turn that also never fired a real dispatch on its own. The
 * maintainer's round-12 G4 diagnostic run (probes-09c75b58/g4-precompute-and-agent.log) recorded
 * `skipLine=false stood=false coreRan=true` for the precompute case: `skipLine` was false because
 * `compact.ts`'s own session.compact hook never ran at all (no SKIP_LINE was ever written, by
 * precompute or anything else), and `coreRan` was true only because of the coreRan() false
 * positive fixed this round (the old catch-all regex misread trigger.ts's own harmless
 * "compacting, N chars of instructions" call-announcement line -- present on every turn once
 * capture is enabled -- as proof core ran a compaction). The agentId check's `coreRan===true`
 * requirement was therefore a VACUOUS pass: it was satisfied by the same false-positive line on
 * every headless run that loaded the trigger plugin, regardless of gateForceAgentId or anything
 * else. Both checks below now use `sendCompact` (a scripted `/compact`, `trigger: 'manual'`,
 * cc.d.ts:7278-9) so `session.compact` genuinely dispatches, and `EXO_COMPACT_GATE_FORCE_TRIGGER`/
 * `EXO_COMPACT_GATE_FORCE_AGENT_ID` (compact.ts's own test-only override, see core/handler.ts's
 * forceTriggerOverride; plugin options `gateForceTrigger`/`gateForceAgentId` before 4.8.1)
 * reroute that real dispatch as precompute/agentId would.
 */
const fixture = PROBE_FIXTURES.G4;
const files = bigFixtureFiles(fixture.names, fixture.repeat, fixture.extra);
const baseline = await runClaude({ prompt: `Read files ${fixture.names.map((name) => `${name}.txt`).join(', ')}. Compare their contents, then say one short sentence.`, files, options: {} });
const sessionId = sessionIdFrom(baseline);
const captureDir = (cwd, session) => path.join(cwd, '.exovault', 's4-capture', String(session ?? 'missing'));

async function snapshot(dir) {
  const files = new Map();
  let names = [];
  try { names = (await readdir(dir)).filter((name) => name.startsWith('segment-')); } catch { return files; }
  for (const name of names) {
    try { files.set(name, await readFile(path.join(dir, name), 'utf8')); } catch {}
  }
  return files;
}

const preSkipSnapshot = await snapshot(captureDir(baseline.cwd, sessionId));

const checks = [
  { name: 'baseline run returned a session id', pass: Boolean(sessionId), detail: `session=${sessionId ?? 'missing'}` },
];

if (sessionId) {
  const skip = await sendCompact({ sessionId, projectDir: baseline.cwd, envOverrides: { EXO_COMPACT_GATE_FORCE_TRIGGER: 'precompute' } });
  checks.push({ name: 'precompute is an explicit skip, logged with the exact skip line, no stand and no core run', pass: skippedWithReason(skip.debugLog, 'precompute') && !s4Stood(skip.debugLog) && !coreRan(skip.debugLog), detail: `skipLine=${skippedWithReason(skip.debugLog, 'precompute')} stood=${s4Stood(skip.debugLog)} coreRan=${coreRan(skip.debugLog)}` });
  const postSkipSnapshot = await snapshot(captureDir(skip.cwd, sessionId));
  // Round 8 finding 6(a): the skip run's own turn.complete still runs (it is independent of
  // session.compact's route) and appends this turn's "/compact"/reply records into whatever
  // segment fs-adapter's own append logic picks, which is usually the last pre-existing segment,
  // not a fresh one. Exact byte-equality on pre-existing segments was therefore always false,
  // whether or not session.compact itself ever touched capture. The real claim -- session.compact
  // was skipped before touching .exovault/s4-capture at all -- is that every pre-existing
  // segment's content is still a byte-for-byte PREFIX of its post version (nothing already
  // written was rewritten or removed), and every line added anywhere (to an existing segment or a
  // brand-new one) carries `origin: 'turn'`, never `origin: 'reconcile'` (which only
  // session.compact's own extraction would produce).
  function linesOf(text) { return text ? text.split('\n').filter(Boolean) : []; }
  let prefixOk = true;
  const brokenPrefix = [];
  let addedLines = 0;
  let addedNonTurnOrigin = 0;
  const scoreAddedLines = (before, after) => {
    for (let index = before.length; index < after.length; index += 1) {
      addedLines += 1;
      try { if (JSON.parse(after[index]).origin !== 'turn') addedNonTurnOrigin += 1; } catch { addedNonTurnOrigin += 1; }
    }
  };
  for (const [name, content] of preSkipSnapshot) {
    const post = postSkipSnapshot.get(name) ?? '';
    if (!post.startsWith(content)) { prefixOk = false; brokenPrefix.push(name); continue; }
    scoreAddedLines(linesOf(content), linesOf(post));
  }
  for (const [name, content] of postSkipSnapshot) {
    if (preSkipSnapshot.has(name)) continue;
    scoreAddedLines([], linesOf(content));
  }
  checks.push({ name: 'precompute skip left every pre-existing capture segment as a prefix of its post version (nothing already written was rewritten or removed)', pass: prefixOk, detail: brokenPrefix.length ? `brokenPrefix=${brokenPrefix.join(',')}` : `preExisting=${preSkipSnapshot.size}` });
  // Round 12: loosened from `addedLines > 0 && addedNonTurnOrigin === 0`. Whether a scripted
  // `/compact` prompt dispatches a normal `turn.complete` with `reason: 'answer'` (the thing that
  // would append a fresh `origin: 'turn'` line at all) is not confirmed by any documented type --
  // cc.d.ts's TurnCompleteReason lists 'answer' | 'aborted' | 'refusal' | 'error', no distinct
  // "command" reason, and no live run was permitted this round to observe it directly. The actual
  // invariant this check exists to prove -- session.compact's precompute route never writes a
  // reconcile-origin capture record -- holds whether zero or more turn-origin lines were appended,
  // so `addedLines > 0` is dropped rather than risk a false FAIL if a /compact command turns out
  // not to fire turn.complete the way an ordinary answer does.
  checks.push({ name: "every line added to capture during the skip run has origin=turn; none came from session.compact's own reconcile, so session.compact itself never wrote to .exovault/s4-capture", pass: addedNonTurnOrigin === 0, detail: `addedLines=${addedLines} nonTurnOrigin=${addedNonTurnOrigin}` });
  await skip.dispose();

  const agent = await sendCompact({ sessionId, projectDir: baseline.cwd, envOverrides: { EXO_COMPACT_GATE_FORCE_AGENT_ID: 'sub_1' } });
  checks.push({ name: 'agentId leaves S4 unstood and lets core run beneath', pass: coreRan(agent.debugLog) && !s4Stood(agent.debugLog), detail: `coreRan=${coreRan(agent.debugLog)} stood=${s4Stood(agent.debugLog)}` });
  await agent.dispose();
} else {
  checks.push({ name: 'precompute / agentId checks', skip: true, detail: 'no session id from baseline run' });
}

report('G4', checks);
await baseline.dispose();
