// 4.10.0 (CONTRACT S5x): Claude Code's auto-compact window and auto mode.
// exo-compact only replaces the summary when Claude Code itself compacts. On a 1M-context model the default
// auto-compact window is the model window, so a session first compacts near 1,000,000 tokens; with
// `autoCompactEnabled: false` it never does. This script sets `autoCompactWindow` and turns auto-compact on in the
// user settings, once per configured value: a marker (`<config dir>/exovault/auto-compact.json`) holds the last
// applied `{window, enabled}`, and a field whose requested value equals its marker field is not looked at again, so a
// later change by hand stays.
// It reads one key, `autoCompactEnabled`, from the legacy global config (`~/.claude.json`, which also holds
// credentials) and never writes or prints that file.
// Usage: node auto-compact.mjs apply <window|keep> <true|false|keep> [--home <abs>] [--config-dir <abs>] [--cwd <abs>] [--json]
// --home / --config-dir: the hook passes the directories it resolved itself; with either one the process
// environment is not used for any path, because a project settings `env` block reaches this child's environment.
// 4.10.1 (CONTRACT S5y) --cwd: the session's folder. When its newest transcripts show another plugin sending
// exo-compact's hook events on past it, nothing is written and no marker is recorded, so the answer applies once
// that is fixed.
// Exit codes: 0 done or nothing to do, 1 the settings file cannot be read, is not a JSON object or kept changing
// (or the write failed), 2 bad arguments.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBypass } from './bypass.mjs';
import { claudeProjectDir } from './recall/paths.mjs';

export const MIN_WINDOW = 100_000;
export const MAX_WINDOW = 1_000_000;
export const HINT = 'Change it with /plugin configure exo-compact.';
const KEEP = 'keep';

/** The settings file, the legacy global config and the marker, as Claude Code resolves its config directory. */
export function configPaths(env, home) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  return {
    settings: path.join(dir, 'settings.json'),
    legacy: env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json'),
    marker: path.join(dir, 'exovault', 'auto-compact.json'),
  };
}

/** `{ window, enabled, json, home, configDir, cwd }`, window and enabled a value or 'keep'; undefined for anything else. */
export function parseApplyArgs(argv) {
  const positional = [];
  const dirs = {};
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--home' || arg === '--config-dir' || arg === '--cwd') {
      const value = argv[i + 1];
      if (value === undefined || !path.isAbsolute(value)) return undefined;
      dirs[{ '--home': 'home', '--config-dir': 'configDir', '--cwd': 'cwd' }[arg]] = value;
      i += 1;
    } else positional.push(arg);
  }
  const [command, windowArg, enabledArg, ...rest] = positional;
  if (command !== 'apply' || windowArg === undefined || enabledArg === undefined || rest.length > 0) return undefined;
  const window = windowArg === KEEP ? KEEP : windowArg.trim() !== '' && Number.isFinite(Number(windowArg)) ? Number(windowArg) : undefined;
  const enabled = enabledArg === KEEP ? KEEP : enabledArg === 'true' ? true : enabledArg === 'false' ? false : undefined;
  if (window === undefined || enabled === undefined) return undefined;
  return { window, enabled, json, ...dirs };
}

const BOM = '\uFEFF';
/** Windows PowerShell 5.1 `Set-Content -Encoding UTF8` starts a file with one; JSON.parse rejects it. */
export const withoutBom = (text) => (text.startsWith(BOM) ? text.slice(1) : text);

/** 1000000 -> "1M", 200000 -> "200k", 123456 -> "123456". */
export function formatWindow(tokens) {
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens % 1000 === 0) return `${tokens / 1000}k`;
  return String(tokens);
}

const validWindow = (window) => Number.isInteger(window) && window >= MIN_WINDOW && window <= MAX_WINDOW;
const isSet = (value) => typeof value === 'string' && value !== '';
const shown = (value) => String(value).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40);

/**
 * The pure planner. `settings` is the parsed user settings object ({} when the file is missing), `marker` the last
 * applied pair or undefined, `legacyEnabled` a thunk for the legacy key (asked only when needed). Returns the keys to
 * write (`set`), the marker to record (undefined: leave it) and the lines to print, in order.
 */
export function planAutoCompact({ window, enabled, settings, marker, legacyEnabled, env }) {
  const plan = { set: {}, marker: undefined, lines: [] };
  const windowDue = window !== KEEP && marker?.window !== window;
  const enabledDue = enabled !== KEEP && marker?.enabled !== enabled;
  if (!windowDue && !enabledDue) return plan;
  const next = { ...(marker ?? {}) };
  const changes = [];
  const warnings = [];
  if (windowDue) {
    const current = settings.autoCompactWindow;
    if (window === 0) next.window = 0;
    else if (!validWindow(window)) {
      warnings.push(`exo-compact: the auto-compact window ${shown(window)} is outside what Claude Code accepts (${MIN_WINDOW}-${MAX_WINDOW}), so it was left alone. ${HINT}`);
    } else if (typeof current === 'number' && current <= window && marker === undefined) {
      // The user already chose a window this small or smaller before exo-compact ever set one.
      next.window = window;
    } else {
      next.window = window;
      if (current !== window) {
        plan.set.autoCompactWindow = window;
        changes.push(`set Claude Code's auto-compact window to ${formatWindow(window)} tokens (it was ${typeof current === 'number' ? `${formatWindow(current)} tokens` : "the model's window"})`);
      }
    }
  }
  if (enabledDue) {
    next.enabled = enabled;
    if (enabled === true) {
      const effective = settings.autoCompactEnabled !== undefined ? settings.autoCompactEnabled : (legacyEnabled() ?? true);
      if (effective === false) {
        plan.set.autoCompactEnabled = true;
        changes.push('turned auto-compact on');
      }
    }
  }
  if (changes.length) plan.lines.push(`exo-compact: ${changes.join('; ')}. ${HINT}`);
  plan.lines.push(...warnings);
  if (windowDue && typeof window === 'number' && window !== 0 && isSet(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)) {
    plan.lines.push(`exo-compact: CLAUDE_CODE_AUTO_COMPACT_WINDOW=${shown(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)} is set, so Claude Code uses that auto-compact window, not the one in the settings. Unset it to use the settings.`);
  }
  if (enabledDue && enabled === true) {
    const off = ['DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT'].filter((name) => isSet(env[name]));
    if (off.length) plan.lines.push(`exo-compact: ${off.join(' and ')} ${off.length > 1 ? 'are' : 'is'} set, so auto-compact stays off and exo-compact does not run when the window fills. Unset ${off.length > 1 ? 'them' : 'it'} to turn auto-compact on.`);
  }
  if (next.window !== marker?.window || next.enabled !== marker?.enabled) plan.marker = next;
  return plan;
}

function readMarker(file) {
  try {
    const value = JSON.parse(withoutBom(fs.readFileSync(file, 'utf8')));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Only `autoCompactEnabled`: the rest of the object is dropped right here. */
function readLegacyEnabled(file) {
  try {
    return JSON.parse(withoutBom(fs.readFileSync(file, 'utf8')))?.autoCompactEnabled;
  } catch {
    return undefined;
  }
}

/** Writes `text` beside `file` and renames it over, keeping the mode of the file it replaces. */
function writeAtomic(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temp, text, mode === undefined ? undefined : { mode });
    if (mode !== undefined) fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* never written */ }
    throw error;
  }
}

/** The settings file as it is now: `{ target, bytes, mode }`, bytes undefined when it does not exist. */
function readSettings(file) {
  // A settings.json that is a link (dotfiles) stays a link: the change goes to its target.
  try {
    const target = fs.realpathSync(file);
    return { target, bytes: fs.readFileSync(target), mode: fs.statSync(target).mode & 0o777 };
  } catch (error) {
    if (error?.code === 'ENOENT') return { target: file, bytes: undefined, mode: undefined };
    throw error;
  }
}

const sameBytes = (a, b) => (a === undefined || b === undefined ? a === b : a.equals(b));

/**
 * Reads, plans, writes. `paths` comes from configPaths; `beforeWrite(attempt)` is a test seam run between the plan
 * and the check that the file is still what was read. Returns `{ code, lines, plan }`; never throws.
 */
export function applyAutoCompact({ window, enabled, env, paths: files, beforeWrite, bypass }) {
  const marker = readMarker(files.marker);
  const due = (window !== KEEP && marker?.window !== window) || (enabled !== KEEP && marker?.enabled !== enabled);
  if (!due) return { code: 0, lines: [], plan: { set: {}, marker: undefined, lines: [] } };
  const skipped = bypass?.() ?? [];
  if (skipped.length) {
    const by = skipped.map((entry) => `"${entry.by}"`).join(' and ');
    const events = [...new Set(skipped.flatMap((entry) => entry.events))].join(', ');
    const line = `exo-compact: auto-compact settings left alone: ${by} runs first and sends exo-compact's hook events on past it (${events}), so every compaction is native and a smaller window would only bring it sooner. Run node "${path.join(path.dirname(fileURLToPath(import.meta.url)), 'doctor.mjs')}" for the fix; the settings are applied at the first session start after it.`;
    return { code: 0, lines: [line], plan: { set: {}, marker: undefined, lines: [line] } };
  }

  let plan;
  for (let attempt = 0; ; attempt += 1) {
    let current;
    try {
      current = readSettings(files.settings);
    } catch (error) {
      return fail(`exo-compact: could not read ${files.settings} (${error?.code ?? 'error'}), so the auto-compact settings were left alone.`);
    }
    const text = current.bytes === undefined ? undefined : current.bytes.toString('utf8');
    let settings = {};
    if (text !== undefined) {
      try { settings = JSON.parse(withoutBom(text)); } catch { settings = undefined; }
      if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
        return fail(`exo-compact: ${files.settings} is not valid JSON, so the auto-compact settings were left alone. Fix the file, then start a new session.`);
      }
    }
    plan = planAutoCompact({ window, enabled, settings, marker, legacyEnabled: () => readLegacyEnabled(files.legacy), env });
    if (!Object.keys(plan.set).length) break;
    beforeWrite?.(attempt);
    // A second session start or Claude Code itself may have written the file since it was read: plan once more from
    // what is there now, and leave it to the next session start if it changed again.
    // ponytail: the window between this check and the rename stays open; closing it needs a lock Claude Code does not take.
    let now;
    try { now = readSettings(files.settings).bytes; } catch { now = null; }
    if (now === null || !sameBytes(now, current.bytes)) {
      if (attempt === 0) continue;
      return fail(`exo-compact: ${files.settings} changed while exo-compact was updating it, so the auto-compact settings were left alone. The next session start tries again.`);
    }
    try {
      writeAtomic(current.target, `${text?.startsWith(BOM) ? BOM : ''}${JSON.stringify({ ...settings, ...plan.set }, null, 2)}\n`, current.mode);
    } catch (error) {
      return fail(`exo-compact: could not write ${files.settings} (${error?.code ?? 'error'}), so the auto-compact settings were left alone.`);
    }
    break;
  }
  if (plan.marker) {
    try {
      fs.mkdirSync(path.dirname(files.marker), { recursive: true, mode: 0o700 });
      writeAtomic(files.marker, `${JSON.stringify(plan.marker)}\n`, 0o600);
    } catch { /* the plan is idempotent: the next run finds the same state and records it then */ }
  }
  return { code: 0, lines: plan.lines, plan };
}

function fail(line) {
  return { code: 1, lines: [line], plan: { set: {}, marker: undefined, lines: [line] } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseApplyArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write('usage: node auto-compact.mjs apply <window|keep> <true|false|keep> [--home <abs>] [--config-dir <abs>] [--cwd <abs>] [--json]\n');
    process.exitCode = 2;
  } else {
    const fromHook = args.home !== undefined || args.configDir !== undefined;
    const paths = fromHook ? configPaths({ CLAUDE_CONFIG_DIR: args.configDir }, args.home) : configPaths(process.env, os.homedir());
    const projectDir = args.cwd === undefined ? undefined : claudeProjectDir(args.cwd, fromHook ? { CLAUDE_CONFIG_DIR: args.configDir } : process.env, fromHook ? args.home : os.homedir());
    const bypass = projectDir === undefined ? undefined : () => findBypass(projectDir);
    const result = applyAutoCompact({ window: args.window, enabled: args.enabled, env: process.env, paths, bypass });
    if (args.json) process.stdout.write(`${JSON.stringify({ set: result.plan.set, marker: result.plan.marker ?? null, lines: result.lines })}\n`);
    else if (result.lines.length) process.stdout.write(`${result.lines.join('\n')}\n`);
    process.exitCode = result.code;
  }
}
