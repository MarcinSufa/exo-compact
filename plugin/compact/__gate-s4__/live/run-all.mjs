import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bigFixtureFiles, estimateTokens, fixtureCharCount, PROBE_FIXTURES, printDryCommand } from './lib.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
// Round 8 finding 13: pricing each probe as `fixture chars / 4` (one call's worth) left out the
// base request (system prompt plus tool schema, about 20-25k tokens per the review, present on
// EVERY request, not just one) and the fact that each fixture file read is its own tool-use
// round trip, so a 5-file read is several requests, not one, each carrying the fixture already
// read so far in cache. `requests` below is a per-probe estimate of that request count (one per
// file read plus one for the final answer, plus resumed/forked follow-up questions, plus the
// extra core-fallback summary findings 4/10 note G2 still pays for on its second turn at
// threshold 1); `BASE_REQUEST_TOKENS` is added once per request, not once per probe. This lands
// around 1.2-2M total, matching the review's own recomputation, not the old ~10x-too-low figure.
const BASE_REQUEST_TOKENS = 22500;
const probes = [
  ['G1', 'g1-soft-path.mjs', { prompt: 'Read files a.txt..e.txt, compare, say one short sentence.', options: { softThresholdPercent: 1 }, calls: 1, requests: 6 }],
  ['G2', 'g2-post-compact-request.mjs', { prompt: '[stream-json, 2 turns] read fixtures then say one sentence; then reply "continued"', options: { softThresholdPercent: 1 }, calls: 2, requests: 6, stream: true, note: 'round 9 finding 8 (stale note fixed): with one compact per crossing (round 8 finding 10 / round 9 finding 4), turn 2 does not re-fire at threshold 1 because tokens never drop below it, so there is no extra core-fallback summary here; the compacted context is small enough that it is one fewer core summary than an earlier estimate assumed' }],
  ['G2b', 'g2b-auto-mid-tool-loop.mjs', { prompt: 'Read a..e one at a time with CLAUDE_CODE_AUTO_COMPACT_WINDOW shrunk to 12000, then (if it stood under auto) one resume follow-up "Say ok."', options: {}, calls: 2, requests: 7, note: 'round 16 (brief-s4a-fix16.md F1): reaches trigger=auto natively via a shrunk auto-compact window, not the S4 soft trigger or a scripted /compact; the second (resume) call is conditional on the first standing under auto, so real cost may be lower than the 2-call estimate if it does not' }],
  ['G3', 'g3-resume-fork.mjs', { prompt: 'Read five project files, retain sentinel, summarize', options: { softThresholdPercent: 1 }, calls: 3, requests: 8 }],
  ['G4', 'g4-precompute-and-agent.mjs', { prompt: 'Read fixtures then say one sentence; then --resume twice with "Say ok."', options: { softThresholdPercent: 1000 }, calls: 3, requests: 8 }],
  ['G5', 'g5-mutual-exclusion.mjs', { prompt: 'Read fixtures; use Bash once for pwd; report', options: { softThresholdPercent: 1 }, calls: 2, requests: 12 }],
  ['G6', 'g6-module-loads-and-writes.mjs', { prompt: 'Read three files and compare them.', options: { softThresholdPercent: 1 }, calls: 1, requests: 4 }],
  ['G7', 'g7-transcript-pointer.mjs', { prompt: 'Read files a.txt, b.txt, c.txt, d.txt, and e.txt. Compare their contents and say one short sentence.', options: { softThresholdPercent: 1 }, calls: 1, requests: 6 }],
  ['G8', 'g8-jev-selector.mjs', { prompt: 'Read files a.txt..e.txt, compare, say one short sentence.', options: { softThresholdPercent: 1 }, calls: 6, requests: 18, note: 'S4b, spec v3.4 selector J: three full compactions (off, denied, enabled), each a fixture-reading call plus a scripted /compact, per compactOnceWith in g8-jev-selector.mjs; needs TYPESAFE_API_KEY exported in the operator\'s own shell to exercise the real-call branch, and is never run by the implementer per brief-s4b-jev.md' }],
  ['G9', 'g9-extension-session.mjs', { prompt: 'Extension: read a.txt..e.txt, compare, one short sentence, then /compact. Nested and plain: reply ok, then /compact.', options: { interactiveOnly: true }, calls: 3, requests: 11, stream: true, note: 'ext-fallback: one stream-json process per arm. Extension is 5 file reads plus the answer plus /compact (7). Nested and plain stay two short turns (2 + 2).' }],
  ['G10', 'g10-session-root.mjs', { prompt: 'Extension: read a.txt..e.txt, compare, one short sentence; Bash cd to an outside directory and pwd; then /compact.', options: { interactiveOnly: true }, calls: 1, requests: 9, stream: true, note: 'session-root: one stream-json extension session. Five file reads plus the answer (6), one Bash plus the one-word reply (2), then /compact (1).' }],
  ['G11', 'g11-session-push-server.mjs', { prompt: 'Stream: read a.txt..c.txt plus a note with a rare id; /compact; ok; ask about the id without tools.', options: {}, calls: 1, requests: 7, stream: true, note: 'session push via the recall server (S5s): one stream-json session with the recall server handed in through the strict MCP config. Three file reads plus the answer (4), /compact (1), a one-word turn while the index builds (1), question (1).' }],
];

if (process.argv.includes('--dry')) {
  let totalCalls = 0;
  let totalTokens = 0;
  for (const [id, , spec] of probes) {
    printDryCommand({ prompt: spec.prompt, cwd: `<fresh-${id}-project>`, debugFile: `<fresh-${id}-project>/debug.log`, settingsFile: `<fresh-${id}-project>/settings.json`, extraArgs: [], stream: Boolean(spec.stream) });
    const fixture = PROBE_FIXTURES[id];
    const fixtureChars = fixture ? fixtureCharCount(bigFixtureFiles(fixture.names, fixture.repeat, fixture.extra)) : 0;
    const fixtureTokens = estimateTokens(fixtureChars);
    const perRequestTokens = BASE_REQUEST_TOKENS + fixtureTokens;
    const tokens = perRequestTokens * spec.requests;
    totalCalls += spec.calls;
    totalTokens += tokens;
    console.log(`[${id}] DRY: command constructed; Claude was not started`);
    console.log(`[${id}] DRY: planned claude invocations=${spec.calls}, estimated requests~=${spec.requests}, estimated input tokens~=${tokens} (~${perRequestTokens}/request = ${BASE_REQUEST_TOKENS} base + ${fixtureTokens} fixture)${spec.note ? ` -- ${spec.note}` : ''}`);
  }
  console.log(`[dry] TOTAL planned claude invocations=${totalCalls}, estimated total input tokens~=${totalTokens}`);
  console.log('[dry] Estimate includes a per-request base (system prompt + tools, ~22.5k tokens) and one request per fixture-file read, not just one request per invocation, per round 8 finding 13. Still excludes the model\'s own output tokens and any cache-miss pricing difference. Priced for whatever S4_GATE_MODEL is set to (default haiku).');
} else {
  let failed = false;
  for (const [id, file] of probes) {
    const result = spawnSync(process.execPath, [path.join(root, file)], { encoding: 'utf8' });
    const summary = result.stdout.split('\n').filter((line) => line.startsWith(`[${id}] `)).at(-1) ?? `[${id}] FAIL: no summary line`;
    console.log(summary);
    if (result.status !== 0) failed = true;
  }
  if (failed) process.exitCode = 1;
}
