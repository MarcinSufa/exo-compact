import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { bigFixtureFiles, COMPACT_PROMPT, coreRan, PROBE_FIXTURES, report, runClaudeStream, s4Stood } from './lib.mjs';

const turns = ['Reply with the single word ok', '/compact'];
// Same history G2 compacts. A two-line transcript can miss the reduction floor and log
// compact.fallback=insufficient_reduction origin=compact, which is not this slice.
const fixture = PROBE_FIXTURES.G2;
const extensionFiles = bigFixtureFiles(fixture.names, fixture.repeat, fixture.extra);
const extensionFirstTurn = `Read files ${fixture.names.map((name) => `${name}.txt`).join(', ')}. Compare their contents, then say one short sentence.`;
const extensionEnv = {
  CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
  CLAUDE_CODE_SESSION_ATTENDED: '1',
  CLAUDE_AGENT_SDK_VERSION: '0.3.296',
};
const extensionArgs = ['--permission-prompt-tool=stdio'];

async function captureNames(cwd, sessionId) {
  if (!sessionId) return [];
  try { return await readdir(path.join(cwd, '.exovault', 's4-capture', String(sessionId))); }
  catch { return []; }
}

async function arm(spec) {
  const run = await runClaudeStream({
    turns: spec.turns ?? turns,
    files: spec.files ?? {},
    options: { interactiveOnly: true },
    timeoutMs: 180000,
    envOverrides: spec.envOverrides ?? {},
    extraArgs: spec.extraArgs ?? [],
    initialize: Boolean(spec.initialize),
  });
  try {
    const sessionId = (run.results ?? []).map((event) => event.session_id).find(Boolean);
    const names = await captureNames(run.cwd, sessionId);
    return {
      sessionId,
      names,
      debugLog: run.debugLog ?? '',
      code: run.code,
      segments: names.filter((name) => name.startsWith('segment-')),
    };
  } finally {
    await run.dispose();
  }
}

const checks = [];

async function addArm(name, spec, evaluate) {
  try {
    evaluate(await arm(spec));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    checks.push({ name: `${name}: the arm reached its checks`, pass: false, detail });
  }
}

await addArm('extension', {
  initialize: true,
  extraArgs: extensionArgs,
  envOverrides: extensionEnv,
  turns: [extensionFirstTurn, COMPACT_PROMPT],
  files: extensionFiles,
}, (result) => {
  const stood = s4Stood(result.debugLog);
  const coreDidRun = coreRan(result.debugLog);
  const interactiveOnly = result.debugLog.includes('compact.fallback=interactive_only');
  checks.push(
    { name: 'extension: S4 compaction stood (core never ran)', pass: stood && !coreDidRun, detail: `stood=${stood} coreRan=${coreDidRun} interactive_only=${interactiveOnly} exit=${result.code}` },
    { name: 'extension: capture dir has a segment file', pass: result.segments.length > 0, detail: `session=${result.sessionId ?? 'missing'} segments=${result.segments.length}` },
    { name: 'extension: notices.log exists in the capture dir', pass: result.names.includes('notices.log'), detail: `files=${result.names.join(',') || 'none'}` },
  );
});

await addArm('nested', {
  initialize: true,
  extraArgs: extensionArgs,
  envOverrides: { ...extensionEnv, CLAUDE_CODE_CHILD_SESSION: '1' },
}, (result) => {
  const line = 'compact.fallback=interactive_only origin=compact entrypoint=claude-vscode';
  checks.push(
    { name: 'nested: debug log has the interactive_only line for claude-vscode', pass: result.debugLog.includes(line), detail: `exit=${result.code} hasLine=${result.debugLog.includes(line)}` },
    { name: 'nested: no capture segment was written', pass: result.segments.length === 0, detail: `segments=${result.segments.length}` },
  );
});

await addArm('plain', {}, (result) => {
  const entrypoint = /compact\.fallback=interactive_only origin=compact entrypoint=(\S+)/.exec(result.debugLog)?.[1] ?? 'none';
  checks.push(
    { name: 'plain: debug log has the interactive_only line', pass: entrypoint !== 'none' && entrypoint !== 'claude-vscode', detail: `exit=${result.code} entrypoint=${entrypoint}` },
    { name: 'plain: no capture segment was written', pass: result.segments.length === 0, detail: `segments=${result.segments.length}` },
  );
});

report('G9', checks);
