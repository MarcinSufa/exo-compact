import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)), '..');
const PLUGIN_NAME = 'exo-compact';
/**
 * Round 10: the real debug log of Claude Code 2.1.280 refuses a second `hooks.json` `modules`
 * entry ("hooks.json `modules` names one hooks module per plugin; a second entry is refused"), so
 * the soft trigger (`trigger.ts`, `turn.complete`) now lives in its own sibling plugin directory,
 * `exovault-s4-trigger`, loaded via a second `--plugin-dir`.
 */
const TRIGGER_PLUGIN_DIR = path.resolve(PLUGIN_DIR, '..', 'compact-trigger');
const TRIGGER_PLUGIN_NAME = 'exovault-s4-trigger';
const SETUP_CJS = path.join(PLUGIN_DIR, 'setup.cjs');

export function pluginDir() { return PLUGIN_DIR; }
export function triggerPluginDir() { return TRIGGER_PLUGIN_DIR; }
export function isDry() { return process.argv.includes('--dry'); }

/**
 * Round 12 (brief-s4a-fix12.md item 1): a headless (-p / SDK) session never loads
 * `exovault-s4-trigger` by default any more. Its whole reason to exist -- the soft, threshold-based
 * proactive trigger, `trigger.ts`'s `on('turn.complete', ...)` calling `$.session.compact()` itself
 * -- rejects outright in a headless session (real debug-log line, round 12 diagnostic run against
 * 09c75b58, `/tmp/s4-gate-project-hfKAZi/debug.log:222`): "$.session.compact: not available in a
 * headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it
 * and carry on". Loading it anyway costs nothing functionally (it always no-ops the same way in
 * headless) but its own call-announcement/fallback log lines are noise every detector in this file
 * has to explicitly filter out (see COMPACTING_LINE above), so headless probes leave it out unless
 * a probe explicitly asks for it (`includeTriggerPlugin: true`) as a negative control, e.g. G6's
 * "both plugins still load cleanly" check.
 */
export function buildClaudeCommand({ prompt, cwd, debugFile, settingsFile, extraArgs = [], stream = false, includeTriggerPlugin = false }) {
  const pluginArgs = includeTriggerPlugin ? ['--plugin-dir', PLUGIN_DIR, '--plugin-dir', TRIGGER_PLUGIN_DIR] : ['--plugin-dir', PLUGIN_DIR];
  const base = ['--model', process.env.S4_GATE_MODEL || 'haiku', ...pluginArgs, '--debug-file', debugFile, '--strict-mcp-config', '--mcp-config', path.join(cwd, 'empty-mcp.json'), '--setting-sources', 'project', '--settings', settingsFile];
  const args = stream
    ? ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...base, ...extraArgs]
    : ['-p', prompt, '--output-format', 'json', ...base, ...extraArgs];
  return { command: process.env.S4_GATE_CLAUDE_BIN || 'claude', args, cwd };
}

/**
 * Round 10: every probe still calls `runClaude`/`runClaudeStream`/`withSettingsFile` with one flat
 * `options` bag (unchanged call sites in g1-g6). Each plugin's own manifest only declares the
 * option names its own module actually reads (compact: timeoutMs/contract/...; trigger: softThresholdPercent/compactWindowTokens; see CONTRACT.md), so
 * handing the same bag to both plugins' pluginConfigs is harmless -- each `register(on, options)`
 * only looks at the keys it declared -- and no probe script needs to know the option split.
 */
// 4.8.0 made interactiveOnly default to true, which keeps every `claude -p` probe on native compaction; the probes
// are -p runs, so they turn it off unless one asks for it (G9, G10 pass interactiveOnly: true).
function pluginConfigsFor(probeOptions) {
  const options = { interactiveOnly: false, ...probeOptions };
  return {
    [PLUGIN_NAME]: { options },
    [`${PLUGIN_NAME}@inline`]: { options },
    [TRIGGER_PLUGIN_NAME]: { options },
    [`${TRIGGER_PLUGIN_NAME}@inline`]: { options },
  };
}

export function printDryCommand(input) {
  const command = buildClaudeCommand(input);
  console.log(`[dry] cwd=${command.cwd}`);
  console.log(`[dry] ${command.command} ${command.args.map((arg) => JSON.stringify(arg)).join(' ')}`);
}

export async function withSettingsFile(options, run, extras = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 's4-gate-settings-'));
  const settingsFile = path.join(dir, 'settings.json');
  const settings = { ...extras, pluginConfigs: pluginConfigsFor(options) };
  await writeFile(settingsFile, JSON.stringify(settings, null, 2));
  try { return await run(settingsFile); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

/**
 * Auth (round 7 live-probes fix): the child MUST inherit the real process HOME /
 * CLAUDE_CONFIG_DIR unchanged, because the Linux OAuth credentials this gate authenticates
 * with live under the real home. Redirecting HOME (as earlier rounds did, to sandbox the run)
 * would hide those credentials from the child and break every live probe at the auth layer.
 * Isolation instead comes from `--setting-sources project` / `--settings` / `--strict-mcp-config`
 * (already in buildClaudeCommand) plus a fresh temp `cwd` per run (below).
 *
 * We also strip the messaging/socket env vars this parent process inherited from ITS OWN
 * Claude Code session (CLAUDECODE, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_ENTRYPOINT, and any other
 * CLAUDE_CODE_* var), so the spawned child can never be mistaken for a subagent of, or otherwise
 * cross-talk with, the session that is running this gate. CLAUDE_CODE_ENABLE_FUNCTION_HOOKS is
 * the one exception: S4 needs it, so it is stripped from inheritance and then re-set explicitly.
 * `envOverrides` may pass `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: undefined` to delete it again (G5's
 * positive control needs a run with it unset).
 */
function buildChildEnv(envOverrides) {
  const env = { ...process.env };
  const stripExact = new Set(['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT']);
  const keepPrefixed = new Set(['CLAUDE_CODE_ENABLE_FUNCTION_HOOKS']);
  for (const key of Object.keys(env)) {
    if (stripExact.has(key)) { delete env[key]; continue; }
    if (key.startsWith('CLAUDE_CODE_') && !keepPrefixed.has(key)) delete env[key];
  }
  env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = '1';
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key];
    else env[key] = String(value);
  }
  return env;
}

/**
 * Round 12 item 1: `S4_GATE_KEEP=1` keeps every probe's temp project directory on disk instead of
 * deleting it in `dispose()`, and makes every probe print its debug log path so a human (or the
 * maintainer) can read the real lines a check failed or passed against, the way this round's own
 * diagnosis needed the round-12 `/tmp/s4-gate-project-<id>` directories' debug.log files kept
 * around by hand.
 */
function keepEnabled() { return process.env.S4_GATE_KEEP === '1'; }

export async function runClaude({ prompt, extraArgs = [], options = {}, settings = {}, setup = true, timeoutMs = 120000, files = {}, projectDir, envOverrides = {}, prepareProject, includeTriggerPlugin = false }) {
  const ownsProject = !projectDir;
  const cwd = projectDir ?? await mkdtemp(path.join(tmpdir(), 's4-gate-project-'));
  const debugFile = path.join(cwd, 'debug.log');
  if (keepEnabled()) console.log(`[S4_GATE_KEEP] project=${cwd} debug=${debugFile}`);
  const mcpFile = path.join(cwd, 'empty-mcp.json');
  await writeFile(mcpFile, '{"mcpServers":{}}');
  for (const [name, content] of Object.entries(files)) {
    const target = path.resolve(cwd, name);
    if (!target.startsWith(`${cwd}${path.sep}`)) throw new Error(`fixture path escapes project: ${name}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await mkdir(path.join(cwd, '.claude'), { recursive: true });
  // Staging directory for probes (e.g. G5's S3 hook install) that need a plain scratch
  // directory to hold generated files. This is NOT the process HOME any more (see buildChildEnv
  // above) -- it is just a conveniently-namespaced subdirectory of the project.
  await mkdir(path.join(cwd, '.home'), { recursive: true });
  const setupResult = spawnSync('node', [SETUP_CJS, setup ? 'enable' : 'disable', cwd], { encoding: 'utf8' });
  if (setupResult.status !== 0) throw new Error(`setup.cjs ${setup ? 'enable' : 'disable'} failed: ${setupResult.stderr || setupResult.error || setupResult.status}`);
  const settingsFile = path.join(cwd, 'settings.json');
  const preparedSettings = prepareProject ? await prepareProject({ cwd, home: path.join(cwd, '.home') }) : {};
  await writeFile(settingsFile, JSON.stringify({ ...settings, ...preparedSettings, pluginConfigs: pluginConfigsFor(options) }, null, 2));
  const command = buildClaudeCommand({ prompt, cwd, debugFile, settingsFile, extraArgs, includeTriggerPlugin });
  const disposeProject = () => (ownsProject && !keepEnabled()) ? rm(cwd, { recursive: true, force: true }) : Promise.resolve();
  if (isDry()) {
    printDryCommand({ prompt, cwd, debugFile, settingsFile, extraArgs, includeTriggerPlugin });
    return { code: 0, stdout: '', stderr: '', cwd, parsedJson: undefined, debugLog: '', command, dispose: disposeProject };
  }
  // Round 8 finding 12: G5 installs the real S3 hook scripts (exovault-hook.cjs), which, now that
  // HOME is not redirected (round 7's auth fix), would otherwise read/write the caller's real
  // `~/.exovault-mcp` (sessions/, outbox/, the shared breaker.json). Every S3 call in G5 points at
  // a deliberately unreachable EXOVAULT_API_URL, so two failures there would trip the real
  // breaker for the maintainer's own S1-S3 hooks. Defaulting EXOVAULT_HOME to this run's own
  // `.home` scratch dir (both hook scripts honor it) keeps every probe's S3 side effects inside
  // its own temp project; a caller-supplied `envOverrides.EXOVAULT_HOME` still wins.
  const env = buildChildEnv({ EXOVAULT_HOME: path.join(cwd, '.home'), ...envOverrides });
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`claude timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  let parsedJson;
  try { parsedJson = JSON.parse(result.stdout); } catch {}
  let debugLog = '';
  try { debugLog = await readFile(debugFile, 'utf8'); } catch {}
  return { ...result, cwd, parsedJson, debugLog, command, dispose: disposeProject };
}

/**
 * Round 12 decision (the maintainer, spec v3.2.1 Sec 3.4 item 1a, Sec 5 B133, Sec 5.1 G1): the headless
 * soft trigger IS a scripted `/compact` prompt (no instructions), sent as a new user turn into an
 * ALREADY-RUNNING session. `session.compact` then fires with `trigger: 'manual'`
 * (`core/handler.ts:14-18`'s `routeTrigger` routes anything that is not `precompute` and carries no
 * `agentId` to `{ kind: 'run' }`, i.e. our handler actually runs).
 *
 * Why not `$.session.compact()` (what `trigger.ts`'s old soft trigger called): that fires
 * `trigger: 'plugin'`, never `'manual'` (cc.d.ts:2344-5, "the event `session.compact` with
 * `trigger` `plugin`"), and rejects outright in a headless session anyway (the round-12 diagnostic
 * finding quoted at the top of this file and in GATE.md's round 12 section).
 *
 * Why a `/compact` PROMPT works instead, from `claude --help` and cc.d.ts (neither confirmed
 * against a real run this round -- no live `claude` invocation is permitted, see the brief's
 * constraints; flagged for the maintainer to verify on the first live run):
 *  - cc.d.ts:7278-7279 (`SessionCompactTrigger`'s own doc comment): "Who compacts: the person's
 *    `/compact` (`manual`), the engine at its threshold or on a prompt too long (`auto`), a
 *    plugin, or a `precompute`." -- `'manual'` is explicitly the person's own `/compact`, not an
 *    API call.
 *  - cc.d.ts:1426-1449 (`CommandRunInput`): a slash command's `origin: PromptOrigin`
 *    (cc.d.ts:5850-5869) includes `{ kind: 'sdk' }`, documented as "The SDK host's own turn
 *    (`claude -p`, the Agent SDK), not typed at a terminal" -- a dedicated, named case for exactly
 *    this transport, distinct from `{ kind: 'composer' }` (typed at a terminal). Nothing in
 *    cc.d.ts restricts slash-command parsing (a leading `/name args` in the prompt text) to the
 *    composer path; the `origin` field exists precisely to tell the two apart downstream, which
 *    only makes sense if both dispatch the same command.
 *  - `claude --help`: `-r, --resume [value]` ("Resume a conversation by session ID"), with no
 *    caveat that a resumed prompt is parsed any differently from a fresh one; `--input-format`/
 *    `--output-format stream-json` likewise document arbitrary turn text with no special-casing
 *    for a leading `/`.
 * `sendCompact` below defaults to `--resume <sessionId> -p "/compact"` (the transport G3 already
 * runs live successfully for an ordinary follow-up question -- see g3-resume-fork.mjs), since it
 * is proven live for SOME prompt text where the stream-json protocol (`runClaudeStream`, used only
 * by G2) has never been run against the real binary at all, per that function's own doc comment.
 */
export const COMPACT_PROMPT = '/compact';

/**
 * Sends `/compact` into an existing session as the next request, via `--resume <sessionId>` in a
 * fresh `claude -p` invocation against the same project directory (so the same `.exovault/`
 * capture store and settings.json apply). Use `projectDir` from the run that produced `sessionId`.
 * `options` still goes through the same `pluginConfigsFor` plumbing every other call uses;
 * G4's force override goes through `envOverrides` instead.
 */
export async function sendCompact({ sessionId, projectDir, options = {}, envOverrides = {}, extraArgs = [], includeTriggerPlugin = false, timeoutMs, settings = {} }) {
  return runClaude({
    prompt: COMPACT_PROMPT,
    options,
    envOverrides,
    extraArgs: ['--resume', String(sessionId), ...extraArgs],
    projectDir,
    includeTriggerPlugin,
    settings,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

/**
 * G2 needs one long-lived process with two user turns, the second arriving only after the
 * first turn's `turn.complete`/soft-trigger `session.compact` has had a chance to run, so it
 * uses `--input-format stream-json --output-format stream-json` instead of `-p <prompt>`.
 * Protocol (Claude Code's NDJSON stream-json interface): write one JSON object per line to
 * stdin, of shape `{"type":"user","message":{"role":"user","content":"..."}}`; read one JSON
 * object per line from stdout, where a line with `"type":"result"` marks the end of a turn and
 * carries `is_error`, `result` (the final text), `session_id` and `usage`.
 *
 * This has NOT been run against the real binary this round (only `--dry` is permitted) -- the
 * exact field names above are Claude Code's documented stream-json contract, not something this
 * round could verify live. Flagged in the report as the highest-uncertainty piece.
 */
// `mcpServers` goes into the one config --strict-mcp-config allows: G11 needs the plugin's own recall server, which
// strict mode leaves out.
export async function runClaudeStream({ turns, options = {}, settings = {}, setup = true, timeoutMs = 120000, files = {}, envOverrides = {}, extraArgs = [], includeTriggerPlugin = false, initialize = false, onEvent, mcpServers = {} }) {
  const cwd = await mkdtemp(path.join(tmpdir(), 's4-gate-project-'));
  const debugFile = path.join(cwd, 'debug.log');
  if (keepEnabled()) console.log(`[S4_GATE_KEEP] project=${cwd} debug=${debugFile}`);
  await writeFile(path.join(cwd, 'empty-mcp.json'), JSON.stringify({ mcpServers }));
  for (const [name, content] of Object.entries(files)) {
    const target = path.resolve(cwd, name);
    if (!target.startsWith(`${cwd}${path.sep}`)) throw new Error(`fixture path escapes project: ${name}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await mkdir(path.join(cwd, '.claude'), { recursive: true });
  const setupResult = spawnSync('node', [SETUP_CJS, setup ? 'enable' : 'disable', cwd], { encoding: 'utf8' });
  if (setupResult.status !== 0) throw new Error(`setup.cjs ${setup ? 'enable' : 'disable'} failed: ${setupResult.stderr || setupResult.error || setupResult.status}`);
  const settingsFile = path.join(cwd, 'settings.json');
  await writeFile(settingsFile, JSON.stringify({ ...settings, pluginConfigs: pluginConfigsFor(options) }, null, 2));
  const command = buildClaudeCommand({ cwd, debugFile, settingsFile, extraArgs, stream: true, includeTriggerPlugin });
  const disposeProject = () => keepEnabled() ? Promise.resolve() : rm(cwd, { recursive: true, force: true });
  if (isDry()) {
    printDryCommand({ cwd, debugFile, settingsFile, extraArgs, stream: true, includeTriggerPlugin });
    return { code: 0, results: [], cwd, debugLog: '', command, dispose: disposeProject };
  }
  const results = await new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, { cwd, env: buildChildEnv(envOverrides), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdoutBuf = '';
    const collected = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error(`claude (stream) timed out after ${timeoutMs}ms`)); }, timeoutMs);
    let turnIndex = 0;
    let turnsOpen = !initialize;
    const sendNextTurn = () => {
      if (!turnsOpen) return;
      if (turnIndex >= turns.length) { child.stdin.end(); return; }
      const text = turns[turnIndex];
      turnIndex += 1;
      child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
    };
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      let newlineAt;
      while ((newlineAt = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, newlineAt);
        stdoutBuf = stdoutBuf.slice(newlineAt + 1);
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (onEvent) onEvent(event, (payload) => {
          const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
          child.stdin.write(text.endsWith('\n') ? text : `${text}\n`);
        });
        if (initialize && !turnsOpen && event.type === 'control_response' && event.response?.request_id === 'init-1') {
          turnsOpen = true;
          sendNextTurn();
          continue;
        }
        if (event.type === 'result') {
          collected.push(event);
          sendNextTurn();
        }
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, results: collected }); });
    if (initialize) child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } })}\n`);
    else sendNextTurn();
  });
  let debugLog = '';
  try { debugLog = await readFile(debugFile, 'utf8'); } catch {}
  return { ...results, cwd, debugLog, command, dispose: disposeProject };
}

export async function readDebugLog(debugFile) {
  try { return await readFile(debugFile, 'utf8'); } catch { return ''; }
}

export async function captureEvidence(cwd, sessionId) {
  if (!sessionId) return false;
  try { return (await (await import('node:fs/promises')).stat(path.join(cwd, '.exovault', 's4-capture', String(sessionId)))).isDirectory(); }
  catch { return false; }
}

export function sessionIdFrom(result) {
  const json = result?.parsedJson ?? result;
  return json?.session_id ?? json?.sessionId ?? json?.session?.id;
}

/**
 * Detection (round 7 live-probes fix): the earlier `/compaction|compact/i` regex was too loose
 * (it also matched, e.g., S4's own "hooked by" line, comments, or unrelated words containing
 * "compact"). Per docs/ctx-s4/review-opus-r6.md, the binary's own log lines are:
 *   `session.compact (<trigger>): a hook's N messages stand (hooked by <names>); core never ran`
 *   `session.compact (<trigger>): a hook's N messages stand (hooked by <names>); core ran beneath`
 *   `session.compact (<trigger>): skipped (<reason>; hooked by <names>)`
 * S4 "stood" (won outright) = a "messages stand" line whose hooked-by list names our plugin AND
 * whose suffix is "core never ran". "Core ran" = an explicit "core ran beneath" suffix, OR any
 * `session.compact (` line that is neither a "messages stand" line nor a "skipped" line (i.e.
 * core ran with no hook claiming the result at all).
 *
 * These patterns are built directly from the review's citation of the binary's own lines; they
 * have not been checked against a real debug log this round (live runs are out of scope --
 * `--dry` only). The maintainer should diff a real debug log against these regexes on the first
 * live run and adjust here if the literal wording differs.
 *
 * Round 12 update: STAND_LINE and SKIP_LINE are STILL unconfirmed against a real debug log. The
 * maintainer's round-12 probe run against 09c75b58 (8 kept debug logs, see GATE.md's round 12
 * section) never once produced a `session.compact (exo-compact` line of any shape --
 * `compact.ts`'s own `session.compact` hook never fired in any of the 8 runs, because nothing in a
 * headless run ever dispatched a real `session.compact` event (see COMPACTING_LINE below and
 * `sendCompact()`'s doc comment). What those 8 logs DID confirm is a third, different line format,
 * logged by the ENGINE the moment a plugin calls `$.session.compact()` itself, before that call
 * resolves or rejects -- an attempt announcement, not an outcome:
 *   `$.session.compact (<plugin>): compacting, <n> chars of instructions`
 * (verbatim, e.g. `/tmp/s4-gate-project-hfKAZi/debug.log:221`: `$.session.compact
 * (exovault-s4-trigger): compacting, 0 chars of instructions`, immediately followed there by
 * `trigger.ts`'s own diagnostic log line, `trigger.diag=...: $.session.compact: not available in a
 * headless (-p / SDK) session yet`, and then `compact.fallback=error origin=trigger` -- the call
 * rejected one line later, so nothing resembling a compaction ever happened). The old `coreRan()`
 * fell through this line to its catch-all `/session\.compact \(/` match and reported `true`,
 * exactly the false positive brief-s4a-fix12.md calls out and every headless G1/G3/G4-agentId/G5
 * check traced back to.
 */
const STAND_LINE = /session\.compact \(([^)]*)\): a hook's (\d+) messages stand \(hooked by ([^)]*)\); (core never ran|core ran beneath)/;
const SKIP_LINE = /session\.compact \(([^)]*)\): skipped \(([^;]*); hooked by ([^)]*)\)/;
/**
 * Round 12: the engine's own "a plugin is about to call $.session.compact()" announcement, real
 * lines quoted above. Never an outcome by itself -- the call it announces may still reject
 * (headless) or resolve `{ skip }` (a hook vetoed it) with no further `session.compact (` line at
 * all. Excluded from both `coreRan` and `s4Stood`'s line-matching so it can never stand in for
 * either "core ran" or "S4 stood".
 */
const COMPACTING_LINE = /session\.compact \(([^)]*)\): compacting, \d+ chars? of instructions/;

export function s4Stood(log, pluginName = PLUGIN_NAME) {
  return log.split('\n').some((line) => {
    const m = STAND_LINE.exec(line);
    return Boolean(m) && m[3].includes(pluginName) && m[4] === 'core never ran';
  });
}

export function s4StoodCount(log, pluginName = PLUGIN_NAME) {
  return log.split('\n').filter((line) => {
    const m = STAND_LINE.exec(line);
    return Boolean(m) && m[3].includes(pluginName) && m[4] === 'core never ran';
  }).length;
}

/**
 * Round 8 finding 6: when the hook's own returned messages equal core's, the binary logs no
 * "session.compact (" line at all (confirmed from the binary's own dispatch, per the review),
 * so an agentId pass-through (`compact.route=next`, this module's own log line added for exactly
 * this) or a `compact.fallback=<reason>` (this module falling back to `next()`, which is itself
 * core running) look identical to "nothing happened" under the old detection, when they in fact
 * both mean core produced the result. `coreRan` now also treats either of this plugin's own log
 * lines as "core ran": `compact.route=next` (agentId/subagent, core handles it) and
 * `compact.fallback=` (a throw, timeout or insufficient reduction, `next()` was called).
 *
 * Round 9 finding 7: `compact.fallback=` is not unique to that session.compact path. `compact.ts`'s
 * own `turn.complete` handler logs `compact.fallback=error` when per-turn *capture* fails (nothing
 * to do with whether core ran a compaction), and `trigger.ts` logs the same string when its
 * background soft-trigger `session.compact()` call throws, on a turn.complete that already
 * returned `next()`'s own result. Both used to be misread here as "core ran". Every writer now
 * tags its line with `origin=compact` (the true session.compact fallback) or `origin=turn-capture`
 * / `origin=trigger` (neither means core ran), so only `origin=compact` counts here.
 */
export function coreRan(log) {
  return log.split('\n').some((line) => {
    const stand = STAND_LINE.exec(line);
    if (stand) return stand[4] === 'core ran beneath';
    if (SKIP_LINE.test(line)) return false;
    // Round 12: a plugin's own call-announcement line ("compacting, N chars of instructions"),
    // logged before the call has resolved or rejected -- never an outcome, see the COMPACTING_LINE
    // comment above. Checked before the generic catch-all below, which would otherwise treat it as
    // "a session.compact ( line with no hook claiming the result", the exact false positive that
    // made every headless G1/G3/G5 probe (and G4's agentId check, vacuously) misreport coreRan=true
    // in round 12's live run even though no compaction of any kind ever happened.
    if (COMPACTING_LINE.test(line)) return false;
    if (line.includes('compact.route=next')) return true;
    if (line.includes('compact.fallback=')) return line.includes('origin=compact');
    return /session\.compact \(/.test(line);
  });
}

export function skippedWithReason(log, reason, pluginName = PLUGIN_NAME) {
  return log.split('\n').some((line) => {
    const m = SKIP_LINE.exec(line);
    return Boolean(m) && m[2].trim() === reason && m[3].includes(pluginName);
  });
}

/**
 * Round 8 finding 13: `totalInputTokens(result.parsedJson)` is the run's cumulative usage
 * including the system prompt and tool definitions (about 20-25k tokens on its own), so a floor
 * of 10% of the fixture size was clearing on the system prompt alone, before any fixture content
 * was even read -- "history was large enough" was true no matter how the run went. compact.ts's
 * own `$.ui.log(\`compact.sizeBefore=${tokensBefore}\`)` (added this round) instead reports
 * `serializedTokens(event.messages, ...)`, the size of exactly the message list S4 is about to
 * compact: no system prompt, no tool schema. Reading it back from the debug log gives a floor
 * check that is actually tied to the fixture, not to constant per-run overhead.
 */
export function tokensBeforeReadings(log) {
  return log.split('\n').flatMap((line) => {
    const m = /compact\.sizeBefore=(\d+)/.exec(line);
    return m ? [Number(m[1])] : [];
  });
}

export function coreCompactionLines(log) {
  // Retained only as a diagnostic (prints raw session.compact( lines for a FAIL detail message);
  // pass/fail decisions should use s4Stood/coreRan/skippedWithReason above, not this.
  return log.split('\n').filter((line) => /session\.compact \(/.test(line));
}

/**
 * D3: several probes force `softThresholdPercent: 1`, which alone does not prove anything --
 * the review (D3) found that a small conversation makes the S4 seed render BIGGER than the raw
 * transcript, so `withFallback` always falls back to core no matter how low the threshold is.
 * G1, G2 and G5 need a real, sizeable history so the seed render can actually beat the 25%
 * reduction floor. This mirrors the fixture pattern G3 and G6 already used.
 */
const FIXTURE_LABEL = 'project evidence ';

export function bigFixtureFiles(names, repeat = 900, extra = '') {
  return Object.fromEntries(names.map((name) => [`${name}.txt`, `${name}: ${FIXTURE_LABEL.repeat(repeat)}${extra}`]));
}

export function fixtureCharCount(files) {
  return Object.values(files).reduce((sum, content) => sum + content.length, 0);
}

export function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}

export const PROBE_FIXTURES = {
  G1: { names: ['a', 'b', 'c', 'd', 'e'], repeat: 900 },
  G2: { names: ['a', 'b', 'c', 'd', 'e'], repeat: 900 },
  // Round 16: g2b-auto-mid-tool-loop.mjs reuses G2's own fixture set (same names/repeat), kept as
  // its own key purely so run-all.mjs --dry's per-probe cost estimate (keyed by probe id) is
  // accurate for G2b too, instead of silently pricing it at 0 fixture tokens.
  G2b: { names: ['a', 'b', 'c', 'd', 'e'], repeat: 900 },
  G3: { names: ['a', 'b', 'c', 'd', 'e'], repeat: 900, extra: ' BLUE-ORCHID-731' },
  G4: { names: ['a', 'b', 'c', 'd', 'e'], repeat: 900 },
  G5: { names: ['a', 'b', 'c', 'd', 'e'], repeat: 900 },
  G6: { names: ['a', 'b', 'c'], repeat: 500 },
  G7: { names: ['a', 'b', 'c', 'd', 'e'], repeat: 900, extra: ' CRIMSON-YETI-509' },
  // Round S4b: g8-jev-selector.mjs runs three full compactions (off, denied, enabled), reusing G1's
  // own fixture shape; kept as its own key so run-all.mjs --dry prices it against its own `calls`.
  G8: { names: ['a', 'b', 'c', 'd', 'e'], repeat: 900 },
  G11: { names: ['a', 'b', 'c'], repeat: 900 },
};

export function totalInputTokens(json) {
  const usage = json?.usage ?? json?.result?.usage ?? {};
  if (!Number.isFinite(usage.input_tokens)) return undefined;
  return [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens].reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
}

/**
 * G3 (round 7 fix): since the Auth fix stops redirecting CLAUDE_CONFIG_DIR into a temp `.home`,
 * real transcripts land under the REAL home's `~/.claude/projects/<slug>/<session-id>.jsonl`,
 * not under the project's own `.home`. `sessionId` must be the id the resumed/forked run itself
 * reports (a `--fork-session` run gets a brand-new id), not the original run's id.
 */
export function claudeProjectsRoot() {
  return path.join(homedir(), '.claude', 'projects');
}

async function findTranscriptFile(sessionId) {
  async function walk(dir, depth = 0) {
    if (depth > 6) return undefined;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return undefined; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = await walk(file, depth + 1); if (found) return found; }
      else if (entry.isFile() && entry.name.includes(String(sessionId)) && entry.name.endsWith('.jsonl')) return file;
    }
    return undefined;
  }
  return walk(claudeProjectsRoot());
}

export async function transcriptContainsSeed(sessionId, marker) {
  if (!sessionId) return false;
  const file = await findTranscriptFile(sessionId);
  if (!file) return false;
  try { return (await readFile(file, 'utf8')).includes(marker); } catch { return false; }
}

/**
 * Round 8 finding 5: G3 used to compare run 1's cumulative usage (every request of a multi-read
 * turn) against a resumed single short question's cumulative usage, which is smaller with or
 * without compaction ever running. These read the transcript jsonl directly for per-request
 * `message.usage` (the same field g2's stream-json `result` events carry), so the comparison is
 * apples to apples: one request's input tokens against one request's input tokens.
 */
export async function transcriptEntries(sessionId) {
  if (!sessionId) return [];
  const file = await findTranscriptFile(sessionId);
  if (!file) return [];
  const text = await readFile(file, 'utf8');
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch {}
  }
  return entries;
}

/**
 * B2 (review-opus-r10.md): "make entryUsageTokens return undefined when all three input figures
 * are 0". A resumed/forked transcript's tail fragments (CC rewrites them at compaction) all carry
 * usage (0,0,0,0); summing them to 0 used to compare as "less than before" against anything
 * nonzero, which is not a measurement. Exported (was module-private) so lib-detection.gate.test.ts
 * can pin this with a pure fixture built from the review's own numbers (transcript aa1e2930
 * entries 58-71).
 */
export function entryUsageTokens(entry) {
  const usage = entry?.message?.usage;
  if (!usage) return undefined;
  const total = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens].reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  return total > 0 ? total : undefined;
}

function entryContainsMarker(entry, marker) {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content.includes(marker);
  if (Array.isArray(content)) return content.some((block) => typeof block?.text === 'string' && block.text.includes(marker));
  return false;
}

/** The last assistant request's usage strictly before the first entry containing `marker`. */
export function lastAssistantUsageBeforeMarker(entries, marker) {
  const markerIndex = entries.findIndex((entry) => entryContainsMarker(entry, marker));
  const upperBound = markerIndex === -1 ? entries.length : markerIndex;
  for (let index = upperBound - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === 'assistant') {
      const usage = entryUsageTokens(entries[index]);
      if (usage !== undefined) return usage;
    }
  }
  return undefined;
}

/**
 * The first assistant request's usage strictly after the LAST entry containing `marker`. Used
 * the same way for a plain `--resume` (shared transcript file, the marker is the seed run 1's
 * compaction wrote, the new answer lands after it) and a `--fork-session` (its own new
 * transcript file, which itself carries the copied seed followed by its own new turn).
 */
export function firstAssistantUsageAfterMarker(entries, marker) {
  let markerIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entryContainsMarker(entries[index], marker)) { markerIndex = index; break; }
  }
  if (markerIndex === -1) return undefined;
  for (let index = markerIndex + 1; index < entries.length; index += 1) {
    if (entries[index]?.type === 'assistant') {
      const usage = entryUsageTokens(entries[index]);
      if (usage !== undefined) return usage;
    }
  }
  return undefined;
}

/**
 * B2 (review-opus-r10.md): "better, anchor `after` to the first assistant entry after the
 * resumed prompt's own user entry." `firstAssistantUsageAfterMarker` above answers "the first
 * assistant reply anywhere after the seed sentinel last appears", which is vacuously satisfied by
 * the zero-usage tail fragments CC rewrites at compaction (entries 58-71 of transcript aa1e2930,
 * usage (0,0,0,0) each) -- those are not a real request. A "plain text" user entry is a genuine
 * prompt: `type: 'user'` with `message.content` either a non-empty string, or an array of blocks
 * that are all `type: 'text'` (never a `tool_result` block, which is CC's own house-keeping, not
 * something a person typed).
 */
export function isPlainTextUserEntry(entry) {
  if (entry?.type !== 'user') return false;
  const content = entry?.message?.content;
  if (typeof content === 'string') return content.length > 0;
  if (Array.isArray(content)) return content.length > 0 && content.every((block) => block?.type === 'text');
  return false;
}

/** The index of the last genuine (plain-text) user entry, or -1 if there is none. */
export function lastRealUserEntryIndex(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (isPlainTextUserEntry(entries[index])) return index;
  }
  return -1;
}

/** The first assistant entry's usage strictly after `index`, skipping any zero-usage entry. */
export function firstAssistantUsageAfterIndex(entries, index) {
  for (let i = index + 1; i < entries.length; i += 1) {
    if (entries[i]?.type === 'assistant') {
      const usage = entryUsageTokens(entries[i]);
      if (usage !== undefined) return usage;
    }
  }
  return undefined;
}

/**
 * B2's actual fix: anchor on the resumed prompt's own user entry (the last genuine user turn in
 * the transcript -- the new question sent into the resumed/forked session), not on "anywhere
 * after the seed marker". Returns the first assistant usage after that entry, skipping the
 * zero-usage rewritten tail fragments the old marker-based approach mistook for a measurement.
 */
export function firstAssistantUsageForResumedPrompt(entries) {
  const userIndex = lastRealUserEntryIndex(entries);
  if (userIndex === -1) return undefined;
  return firstAssistantUsageAfterIndex(entries, userIndex);
}

/**
 * B2: "add a check that the resumed run's debug log has no ensureToolResultPairing and no
 * 'cannot be modified'." Real lines from review-opus-r10.md B2 (the resume debug log,
 * /tmp/s4-gate-project-T2JKdy/debug.log, 12:34:07.975 and 12:34:11.193 for the fork):
 *   "ensureToolResultPairing: repaired missing tool_result blocks"
 *   "API error 400 ... messages.1.content.15: thinking or redacted_thinking blocks in the latest
 *   assistant message cannot be modified"
 * Both indicate CC regrouped assistant fragments by message.id across the compaction boundary on
 * resume, pulling the pre-boundary content (and its tool results) back in -- exactly the bug B2
 * describes. Matched against the whole log text (not line by line): a real debug log may wrap or
 * pretty-print the JSON error body between "API error 400" and "cannot be modified".
 */
const TOOL_RESULT_PAIRING_REPAIR_LINE = /ensureToolResultPairing: repaired missing tool_result blocks/;
const THINKING_BLOCK_400_LINE = /API error 400[\s\S]*?thinking or redacted_thinking blocks[\s\S]*?cannot be modified/;

export function resumeDebugLogIsClean(debugLog) {
  const log = debugLog ?? '';
  return !TOOL_RESULT_PAIRING_REPAIR_LINE.test(log) && !THINKING_BLOCK_400_LINE.test(log);
}

/**
 * S3 (brief-s4a-fix13.md item 6): "record the CC version in every live probe's report line
 * (`claude --version` once per probe run)." Cached at module scope so a probe that calls
 * `report()` more than once (none do today) or several probes run in one process (run-all.mjs)
 * only ever spawns `claude --version` once. `--dry` never spawns `claude` at all elsewhere in this
 * file, so this also short-circuits under `isDry()` rather than spawning a real process for a
 * dry run; the brief's "do not run claude for real" constraint is about compaction/session
 * behaviour, and `--version` is explicitly allowed, but a dry run should still print nothing it
 * did not actually invoke.
 */
let cachedClaudeVersion;
export function claudeVersion() {
  if (cachedClaudeVersion !== undefined) return cachedClaudeVersion;
  if (isDry()) { cachedClaudeVersion = null; return cachedClaudeVersion; }
  try {
    const result = spawnSync(process.env.S4_GATE_CLAUDE_BIN || 'claude', ['--version'], { encoding: 'utf8' });
    cachedClaudeVersion = result.status === 0 ? result.stdout.trim() : null;
  } catch {
    cachedClaudeVersion = null;
  }
  return cachedClaudeVersion;
}

export function report(checkId, checks, meta = {}) {
  let allPassed = true;
  for (const { name, pass, detail, skip, optionalSkip } of checks) {
    if (skip) {
      if (!optionalSkip) allPassed = false;
      console.log(`[${checkId}] SKIP: ${name}${detail ? ` (${detail})` : ''}`);
      continue;
    }
    if (!pass) allPassed = false;
    console.log(`[${checkId}] ${pass ? 'PASS' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`);
  }
  const version = meta.version ?? claudeVersion();
  // The version is folded into the final overall line, not a separate line before it: run-all.mjs
  // (and anything else scanning a probe's stdout for its summary) keeps only the LAST `[ID] ...`
  // line, so a separate `cc_version=` line printed before "PASS/FAIL overall" would never surface
  // there.
  console.log(`[${checkId}] ${allPassed ? 'PASS' : 'FAIL'} overall${version ? ` cc_version=${version}` : ''}`);
  if (!allPassed) process.exitCode = 1;
  return allPassed;
}
