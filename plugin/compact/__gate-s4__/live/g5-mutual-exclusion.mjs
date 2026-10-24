import { cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { bigFixtureFiles, coreRan, PROBE_FIXTURES, pluginDir, report, runClaude, s4Stood, s4StoodCount, sendCompact, sessionIdFrom } from './lib.mjs';

async function installS3({ home, cwd }) {
  await mkdir(path.join(cwd, '.exovault', 'runs'), { recursive: true });
  // The S3 hooks ship with ExoVault, not here: in the old monorepo they sat two levels above the plugin (proxy/);
  // in the standalone repo, point S4_GATE_S3_SOURCE at an ExoVault proxy/ checkout.
  const source = process.env.S4_GATE_S3_SOURCE || path.resolve(pluginDir(), '..', '..');
  const hooksTarget = path.join(home, '.exovault', 'hooks');
  await mkdir(hooksTarget, { recursive: true });
  await cp(path.join(source, 'hooks'), path.join(hooksTarget), { recursive: true });
  await cp(path.join(source, 'run-log'), path.join(hooksTarget, 'run-log'), { recursive: true });
  const script = path.join(hooksTarget, 'exovault-hook.cjs');
  const entry = (role) => ({ hooks: [{ type: 'command', command: `node "${script}" ${role} claude_code`, timeout: 5 }] });
  const hooks = {
    SessionStart: [entry('session_start')], UserPromptSubmit: [entry('prompt_submit')], Stop: [entry('stop')],
    PreToolUse: [entry('pre_tool_use_all')], PostToolUse: [entry('post_tool_use_all')],
    PostToolUseFailure: [entry('post_tool_use_failure')], PreCompact: [entry('pre_compact')],
    SubagentStart: [entry('subagent_start')], SubagentStop: [entry('subagent_stop')],
  };
  return { hooks };
}

async function s3ArtifactsIn(cwd) {
  const runDir = path.join(cwd, '.exovault', 'runs');
  try { return (await readdir(runDir)).filter((name) => name.includes('.ctx.') && name.endsWith('.json')); }
  catch { return []; }
}

const fixture = PROBE_FIXTURES.G5;
const files = bigFixtureFiles(fixture.names, fixture.repeat, fixture.extra);
const prompt = `Read files ${fixture.names.map((name) => `${name}.txt`).join(', ')}. Then use the Bash tool once to run pwd, then report its output in one short sentence.`;
// Round 12: EXOVAULT_ROTATION/EXOVAULT_AGENT_KEY/EXOVAULT_API_URL are shared between the initial
// run and the scripted /compact call below, since S3's mutual-exclusion check (rotation.cjs's own
// flag+env check) is unconditional on the env each process sees, not tied to any particular turn.
const envOverrides = { EXOVAULT_ROTATION: '1', EXOVAULT_AGENT_KEY: 'gate-only', EXOVAULT_API_URL: 'http://127.0.0.1:1' };

// Positive control (round 7 fix): the same S3 install, but with CLAUDE_CODE_ENABLE_FUNCTION_HOOKS
// UNSET (buildChildEnv deletes the key when an override value is `undefined`), proving the S3
// artifact this probe later checks for absence is actually produced under normal S3-only
// conditions -- without this, an S3 artifact could be missing for any number of unrelated
// reasons and "S4 mutual exclusion suppressed it" would be an unproven inference.
const control = await runClaude({
  prompt,
  files,
  options: {},
  envOverrides: { ...envOverrides, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: undefined },
  prepareProject: installS3,
});
const controlS3Files = await s3ArtifactsIn(control.cwd);

// Round 12: the headless soft trigger does not exist (lib.mjs's sendCompact doc comment /
// GATE.md's round 12 section), so this run alone can no longer cause a real S4 hook compaction;
// a scripted `/compact` is sent afterward, into the SAME project (same .exovault/runs and
// .exovault/s4-capture directories), with the same S3-triggering env so the mutual-exclusion
// check below is exercised on a genuine session.compact dispatch instead of the old vacuous one.
const result = await runClaude({
  prompt,
  files,
  options: {},
  envOverrides,
  prepareProject: installS3,
});
const session = sessionIdFrom(result);
const compacted = session ? await sendCompact({ sessionId: session, projectDir: result.cwd, envOverrides }) : undefined;
const s3Files = await s3ArtifactsIn(result.cwd);
const s4Count = compacted ? s4StoodCount(compacted.debugLog) : 0;

report('G5', [
  { name: 'positive control: S3 rotation artifact is produced when function hooks are unset', pass: controlS3Files.length > 0, detail: `exit=${control.code} s3Artifacts=${controlS3Files.length}` },
  { name: 'a scripted /compact was sent while S3 hooks were installed and function hooks enabled', pass: Boolean(compacted), detail: `session=${session ?? 'missing'}` },
  { name: 'S4 handler ran exactly once on the scripted /compact (S3 deferred, core never ran)', skip: !compacted, pass: s4Count === 1 && Boolean(compacted && s4Stood(compacted.debugLog)) && !Boolean(compacted && coreRan(compacted.debugLog)), detail: `s4=${s4Count}` },
  { name: 'S3 rotation state artifact was not created (over the run\'s full lifetime, including the scripted /compact) because the S4 flag is enabled', pass: s3Files.length === 0, detail: `s3Artifacts=${s3Files.length} session=${session ?? 'missing'}` },
  { name: 'Claude completed the probe (initial run and the scripted /compact both exited cleanly)', pass: result.code === 0 && Boolean(compacted) && compacted.code === 0, detail: `exit=${result.code} compactExit=${compacted?.code ?? 'missing'}` },
]);
if (compacted) await compacted.dispose();
await result.dispose();
await control.dispose();
