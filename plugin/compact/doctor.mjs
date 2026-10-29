// Preflight for exo-compact: checks what can break S4 before a session starts, and, only when
// Jev (selector J) is enabled, that TYPESAFE_API_KEY is set and the TypeSafe API accepts it.
// Without this, a missing or wrong key silently falls back to selector D.
// Exit codes: 0 ok (warnings allowed), 1 hard failure, 3 Jev enabled with --jev but not working.
// 4.7.5: a Jev option that is on in Claude Code's settings.json gets the same key check, as a warning with exit 0.
// 4.10.1 (CONTRACT S5y): `doctor.mjs digest [folder]` prints the pluginDigests digest of the copy Claude Code loads.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configPaths, withoutBom } from './auto-compact.mjs';
import { findBypass, pluginDigest } from './bypass.mjs';
import { claudeProjectDir } from './recall/paths.mjs';
import { jevEndpoint, jevOrigin, TYPESAFE_URL as DEFAULT_JEV_URL } from './recall/jev-endpoint.mjs';

// Kept in step with host/jev-client.ts and core/select-j.ts by doctor.test.ts.
export const TYPESAFE_URL = DEFAULT_JEV_URL;
export const JEV_OPTIONS = ['keep_verbatim', 'pointer', 'drop', 'unsure'];
export const JEV_CRITERIA = {
  keep_verbatim:
    'Keep this span exactly as written in the compacted seed, because the remaining work depends on its exact wording.',
  pointer:
    'Leave this span out of the seed but note that it existed, because it may be worth finding again later but is not needed verbatim now.',
  drop: 'Leave this span out entirely, because the remaining work does not depend on it.',
  unsure:
    'Answer this when none of the other options is clearly right. An unsure answer defers to a separate deterministic rule for this span, never to a guess.',
};
export const MIN_NODE = '22.15.0';
export const MIN_CLAUDE = '2.1.278';
export const PROBE_TIMEOUT_MS = 10_000;
const RECALL_FILES = ['recall/launch.mjs', 'recall/mcp-server.mjs', 'recall/build-worker.mjs', 'recall/cleanup.mjs', 'recall/embed-worker.mjs', 'recall/vectors.mjs', 'recall/jev-rerank.mjs', 'recall/jev-endpoint.mjs'];

const KEY_HELP = [
  'Set the key, then start again:',
  "  bash:        export TYPESAFE_API_KEY=...   (persist it in ~/.bashrc)",
  "  PowerShell:  $env:TYPESAFE_API_KEY = '...'   (persist: setx TYPESAFE_API_KEY ...)",
  'Or start without Jev (S4 and recall work without it).',
].join('\n');

const JEV_OPTION_NAMES = ['ruleCheck', 'jevEnabled'];
// 4.8.0: a warning, not an ok line: with Jev off the rule check silently never runs, so the doctor says how to turn it on.
const JEV_HINT = 'It needs a TypeSafe key: set TYPESAFE_API_KEY, then run: claude plugin install exo-compact@exo-compact --config ruleCheck=true (docs/install.md, "Optional: Jev rule check")';
const INTERACTIVE_ONLY_HINT = 'To use S4 in -p and SDK runs too (for example a benchmark): claude plugin install exo-compact@exo-compact --config interactiveOnly=false';
const keyHelpFor = (names) => [
  ...KEY_HELP.split('\n').slice(0, 3),
  `Or turn ${names.length > 1 ? 'them' : 'it'} off:  claude plugin install exo-compact@exo-compact ${names.map((name) => `--config ${name}=false`).join(' ')}`,
].join('\n');

/** The Jev options that are on for this plugin in the text of Claude Code's settings.json; [] when there is none or it cannot be read. */
export function jevOptionsOn(settingsText) {
  let settings;
  try { settings = JSON.parse(settingsText ?? ''); } catch { return []; }
  const configs = settings?.pluginConfigs;
  if (!configs || typeof configs !== 'object') return [];
  const on = new Set();
  for (const [id, config] of Object.entries(configs)) {
    if (id !== 'exo-compact' && !id.startsWith('exo-compact@')) continue;
    for (const name of JEV_OPTION_NAMES) {
      const value = config?.options?.[name];
      if (value === true || value === 'true') on.add(name);
    }
  }
  return JEV_OPTION_NAMES.filter((name) => on.has(name));
}

export function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '');
  return match ? match.slice(1, 4).map(Number) : null;
}

export function atLeast(version, minimum) {
  const min = parseVersion(minimum);
  for (let i = 0; i < 3; i += 1) {
    if (version[i] !== min[i]) return version[i] > min[i];
  }
  return true;
}

// Synthetic content only: the probe never carries session text.
export function buildProbeRequest(apiKey, model, url = TYPESAFE_URL) {
  return {
    url,
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      state: 'exo-compact doctor probe. Span probe: "The dev server port is 4000."',
      questions: {
        probe: { type: 'choice', options: JEV_OPTIONS, criteria: JEV_CRITERIA, instructions: 'Judge only span probe.' },
      },
    }),
  };
}

// Same rule as core/select-j.ts resolvesRequestedModel (doctor.gate.test.ts keeps them in step): the exact name, or
// for a `*-latest` request the family name, a dash, then digits and dots.
export function resolvesModel(requested, reported) {
  if (requested === reported) return true;
  if (!requested.endsWith('-latest')) return false;
  const family = requested.slice(0, -'-latest'.length);
  if (family.length === 0) return false;
  return new RegExp(`^${family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+(\\.\\d+)*$`).test(reported);
}

async function probeJev(fetchImpl, apiKey, model, timeoutMs, url) {
  const request = buildProbeRequest(apiKey, model, url);
  let response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return { jev: 'api_down', detail: timedOut ? `no answer in ${timeoutMs / 1000} s` : 'network error' };
  }
  if (response.status === 401 || response.status === 403) return { jev: 'bad_key', detail: `HTTP ${response.status}` };
  if (response.status === 402) return { jev: 'no_credit', detail: 'HTTP 402' };
  if (!response.ok) return { jev: 'api_down', detail: `HTTP ${response.status}` };
  try {
    const payload = JSON.parse(await response.text());
    if (typeof payload?.model !== 'string' || typeof payload?.answers !== 'object' || payload.answers === null) {
      return { jev: 'api_down', detail: 'unexpected response shape' };
    }
    return { jev: 'ok', detail: `model ${payload.model}`, model: payload.model };
  } catch {
    return { jev: 'api_down', detail: 'malformed response' };
  }
}

// The working-directory walk of host/capture-flag.ts findCaptureRoot, same marker order (active before off in each directory); a Node tool has no session root, so the root walk is not mirrored.
// 4.8.0: with neither file anywhere up the tree the plugin is active (installed means enabled) unless the home directory opts out.
function captureFlagStatus(cwd, fileExists, home) {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (fileExists(path.join(dir, '.exovault', 's4-compact-active'))) return { enabled: true, dir };
    if (fileExists(path.join(dir, '.exovault', 's4-compact-off'))) return { enabled: false, dir, optOut: true };
    if (path.dirname(dir) === dir) break;
  }
  if (typeof home === 'string' && home !== '') {
    if (fileExists(path.join(home, '.exovault', 's4-compact-off'))) return { enabled: false, dir: home, optOut: true };
    return { enabled: true, dir: null };
  }
  return { enabled: false, dir: null };
}

const PLUGIN_CONFIG_KEY = /^exo-compact(@|$)/;

// Read pluginConfigs[exo-compact | exo-compact@*].options.interactiveOnly in file order; absent values keep the runtime default (true).
function readInteractiveOnly(files, readFile) {
  let value;
  for (const file of files) {
    let settings;
    try { settings = JSON.parse(readFile(file)); } catch { continue; }
    for (const [key, config] of Object.entries(settings?.pluginConfigs ?? {})) {
      const option = config?.options?.interactiveOnly;
      if (PLUGIN_CONFIG_KEY.test(key) && typeof option === 'boolean') value = option;
    }
  }
  return value !== false;
}

function settingsFiles(deps) {
  const configDir = deps.env.CLAUDE_CONFIG_DIR || path.join(deps.home, '.claude');
  return [path.join(configDir, 'settings.json'), path.join(deps.cwd, '.claude', 'settings.json'), path.join(deps.cwd, '.claude', 'settings.local.json')];
}

// 4.10.0 (CONTRACT S5x): the window and on/off Claude Code resolves; ~/.claude.json is read for autoCompactEnabled only.
function checkAutoCompact(deps, add) {
  const files = settingsFiles(deps);
  const window = { value: undefined, from: 'model default' };
  let enabled = { value: undefined, from: '' };
  let unreadable = '';
  for (const file of files) {
    let text;
    try { text = deps.readFile(file); } catch { continue; }
    let settings;
    try { settings = JSON.parse(withoutBom(text)); } catch { unreadable = file; continue; }
    if (Number.isInteger(settings?.autoCompactWindow)) Object.assign(window, { value: settings.autoCompactWindow, from: file });
    if (typeof settings?.autoCompactEnabled === 'boolean') enabled = { value: settings.autoCompactEnabled, from: file };
  }
  const envWindow = String(deps.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? '').trim();
  if (envWindow !== '') Object.assign(window, { value: Number(envWindow), from: `CLAUDE_CODE_AUTO_COMPACT_WINDOW=${envWindow.slice(0, 40)}` });
  if (enabled.value === undefined) {
    const legacy = configPaths(deps.env, deps.home).legacy;
    let value;
    try { value = JSON.parse(withoutBom(deps.readFile(legacy)))?.autoCompactEnabled; } catch { value = undefined; }
    enabled = typeof value === 'boolean' ? { value, from: legacy } : { value: true, from: 'default' };
  }
  const disabledBy = ['DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT'].find((name) => String(deps.env[name] ?? '') !== '');
  const user = files[0];
  const broken = unreadable ? ` (${unreadable} is not valid JSON and was skipped)` : '';
  if (disabledBy) return add('auto-compact', 'warn', `auto-compact is off: ${disabledBy} is set, so exo-compact never runs. Fix: unset ${disabledBy}.${broken}`);
  if (enabled.value === false) return add('auto-compact', 'warn', `auto-compact is off (${enabled.from}), so exo-compact never runs. Fix: turn Auto-compact on in /config.${broken}`);
  if (window.value === undefined) return add('auto-compact', 'warn', `auto-compact window: model default (1,000,000 tokens on a 1M model), so a session may run far past 200000 before it compacts. Fix: set "autoCompactWindow": ${MAX_RECOMMENDED_WINDOW} in ${user}.${broken}`);
  const fix = window.from.startsWith('CLAUDE_CODE_AUTO_COMPACT_WINDOW=') ? `unset CLAUDE_CODE_AUTO_COMPACT_WINDOW or set it to ${MAX_RECOMMENDED_WINDOW}` : `set "autoCompactWindow": ${MAX_RECOMMENDED_WINDOW} in ${window.from}`;
  if (!(window.value <= MAX_RECOMMENDED_WINDOW)) return add('auto-compact', 'warn', `auto-compact window: ${window.value} tokens (${window.from}), above the ${MAX_RECOMMENDED_WINDOW} the A/B tests ran with. Fix: ${fix}.${broken}`);
  add('auto-compact', broken ? 'warn' : 'ok', `auto-compact on, window ${window.value} tokens (${window.from})${broken}`);
}

const MAX_RECOMMENDED_WINDOW = 200_000;

const PLUGIN_ID = 'exo-compact@exo-compact';
const BYPASS_SECTION = 'README, "Hooks skipped by another plugin"';

// 4.10.1 (CONTRACT S5y): a plugin seated before the user tier sends exo-compact's events on past it.
function checkBypass(deps, add) {
  let found;
  try { found = deps.bypass?.() ?? []; } catch { found = []; }
  for (const { by, events, file } of found) {
    add('bypass', 'warn', [
      `exo-compact's hooks are skipped: "${by}" runs first and sends ${events.join(', ')} on past exo-compact (${file}), so every compaction is native.`,
      `  Fix 1: add "appendPlugins": ["${PLUGIN_ID}"] to ${settingsFiles(deps)[0]}, then restart Claude Code. It does nothing if Claude Code's debug log (claude --debug) says "${PLUGIN_ID} in user settings ignored".`,
      `  Fix 2, then: an administrator lists the plugin in the managed settings (${BYPASS_SECTION}); node "${path.join(deps.pluginRoot, 'doctor.mjs')}" digest prints the digest that entry names.`,
    ].join('\n'));
  }
}

function checkNode(nodeVersion, add) {
  const node = parseVersion(nodeVersion);
  if (node && atLeast(node, MIN_NODE)) add('node', 'ok', `Node ${node.join('.')}`);
  else add('node', 'fail', `Node ${nodeVersion} is too old, need >= ${MIN_NODE}`);
}

function checkClaude(claudeText, add) {
  const claude = parseVersion(claudeText);
  if (claudeText === null || claudeText === undefined) add('claude', 'warn', 'claude not found on PATH, version not checked');
  else if (!claude) add('claude', 'warn', 'could not read the claude version');
  else if (atLeast(claude, MIN_CLAUDE)) add('claude', 'ok', `Claude Code ${claude.join('.')}`);
  else add('claude', 'fail', `Claude Code ${claude.join('.')} is too old, need >= ${MIN_CLAUDE} (run: claude update)`);
}

/**
 * 4.8.0: the SessionStart check (host/preflight.ts, `doctor.mjs --versions`). The same two version checks as the full
 * report, so the minimums live in one place; only a hard failure counts (an unknown Claude Code version does not).
 */
export function versionProblems({ nodeVersion, claudeVersion }) {
  const problems = [];
  const add = (_id, status, message) => { if (status === 'fail') problems.push(message); };
  checkNode(nodeVersion, add);
  checkClaude(claudeVersion, add);
  return problems;
}

const short = (sha) => String(sha).slice(0, 7);
const MANIFEST_IN_REPO = 'plugin/compact/.claude-plugin/plugin.json';

// main as the remote has it now, or else as the last fetch left it. Read-only: ls-remote asks, nothing is fetched.
async function mainCommit(git, repo) {
  const remote = await git(repo, ['ls-remote', 'origin', 'refs/heads/main']);
  const sha = remote.status === 0 ? /^([0-9a-f]{40})\s/.exec(remote.stdout)?.[1] : undefined;
  if (sha) return { sha, stale: false };
  const local = await git(repo, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']);
  const fetched = local.status === 0 ? /^[0-9a-f]{40}$/.exec(local.stdout.trim())?.[0] : undefined;
  return fetched ? { sha: fetched, stale: true } : null;
}

async function mainVersion(git, repo, sha) {
  const shown = await git(repo, ['show', `${sha}:${MANIFEST_IN_REPO}`]);
  if (shown.status !== 0) return null;
  try { return String(JSON.parse(shown.stdout).version ?? '') || null; } catch { return null; }
}

// 4.8.1: the newest release tag on the remote, `vX.Y.Z` by version (prerelease and other v tags are skipped), with
// the commit it points to: an annotated tag is listed twice, the second time peeled (`^{}`) to its commit.
const RELEASE_REF = /^refs\/tags\/v(\d+)\.(\d+)\.(\d+)(\^\{\})?$/;
const versionParts = (version) => /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? ''))?.slice(1).map(Number) ?? null;
const compareParts = (a, b) => a.map((part, i) => part - b[i]).find((diff) => diff !== 0) ?? 0;

// The remote could not be asked, and the clone has release tags: comparing with a stale main would be wrong.
const UNREACHABLE = 'unreachable';

async function latestRelease(git, repo) {
  const listed = await git(repo, ['ls-remote', '--tags', 'origin', 'refs/tags/v*']);
  if (listed.status !== 0) {
    const local = await git(repo, ['tag', '--list', 'v*']);
    return local.status === 0 && local.stdout.split('\n').some((tag) => /^v\d+\.\d+\.\d+$/.test(tag.trim())) ? UNREACHABLE : null;
  }
  const releases = new Map();
  for (const line of listed.stdout.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    const match = ref ? RELEASE_REF.exec(ref) : null;
    if (!match || !/^[0-9a-f]{40}$/.test(sha)) continue;
    const parts = match.slice(1, 4).map(Number);
    const tag = `v${parts.join('.')}`;
    if (match[4] || !releases.has(tag)) releases.set(tag, { tag, parts, sha });
  }
  return [...releases.values()].sort((a, b) => compareParts(b.parts, a.parts))[0] ?? null;
}

// Against a release the versions decide; only an install without an x.y.z version falls back to the commits.
async function releaseOrder(git, repo, loaded, release) {
  if (loaded.sha === release.sha) return 'same';
  const mine = versionParts(loaded.version);
  if (!mine) return order(git, repo, loaded.sha, release.sha);
  const diff = compareParts(mine, release.parts);
  return diff < 0 ? 'behind' : diff > 0 ? 'ahead' : 'version';
}

// 'same', 'behind', 'ahead', 'differs' (neither contains the other), or 'unknown' (a commit is not in this clone).
async function order(git, repo, installed, main) {
  if (installed === main) return 'same';
  const behind = await git(repo, ['merge-base', '--is-ancestor', installed, main]);
  if (behind.status === 0) return 'behind';
  const ahead = await git(repo, ['merge-base', '--is-ancestor', main, installed]);
  if (ahead.status === 0) return 'ahead';
  if (behind.status !== 1 || ahead.status !== 1) return 'unknown';
  // A shallow clone can miss the shared history, so "neither contains the other" is not proven there.
  const shallow = await git(repo, ['rev-parse', '--is-shallow-repository']);
  return shallow.status === 0 && shallow.stdout.trim() === 'false' ? 'differs' : 'unknown';
}

const inside = (dir, parent) => {
  const relative = path.relative(parent, dir);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

// The install that loads in `cwd`: a local or project one whose folder holds it (the deepest), else the user one.
function loadedInstall(entries, cwd) {
  const local = entries.filter((entry) => entry.scope !== 'user' && typeof entry.projectPath === 'string' && cwd && inside(cwd, entry.projectPath))
    .sort((a, b) => b.projectPath.length - a.projectPath.length);
  return local[0] ?? entries.find((entry) => entry.scope === 'user' || entry.scope === undefined);
}

// One line to paste: && for sh, cmd and PowerShell 7; `;` and a single-quoted path for Windows PowerShell 5.1.
function commandLine(platform, repo, steps) {
  const windows = platform === 'win32';
  const quoted = repo === undefined ? '' : windows ? `'${repo.replaceAll("'", "''")}'` : `"${repo}"`;
  const lines = steps.map((step) => step.replace('<repo>', quoted));
  if (!windows) return lines.join(' && ');
  // PowerShell 5.1 has no &&. Each step runs only if the one before it succeeded; the blocks nest, because a skipped
  // `if` block leaves $? true again.
  return lines.reduceRight((rest, line) => (rest === undefined ? line : `${line}; if ($?) { ${rest} }`), undefined);
}

/**
 * 4.8.1: Claude Code runs the copy it installed until `claude plugin update`, so a pulled clone or a merged fix does
 * not reach a session by itself. This names the copy Claude Code loads and compares it with the latest release tag,
 * or with main when the remote has no release tags.
 */
async function checkVersion(plugins, pluginRoot, add) {
  const entries = plugins.installed();
  const entry = loadedInstall(entries, plugins.cwd);
  const own = plugins.ownVersion;
  // `update(gitSteps)` is the command that brings the install to the target; gitSteps move the clone.
  let loaded; let repo; let update; let note = '';
  if (entry) {
    const marketplaceName = entry.key.slice(entry.key.indexOf('@') + 1);
    const marketplace = plugins.marketplace(marketplaceName);
    repo = marketplace?.installLocation;
    const directory = marketplace?.source === 'directory' && repo;
    update = (gitSteps) => commandLine(plugins.platform, repo, [...(directory ? gitSteps : []), `claude plugin marketplace update ${marketplaceName}`, `claude plugin update ${entry.key}`]);
    loaded = { version: entry.version, sha: entry.gitCommitSha };
    const commit = loaded.sha ? ` (${short(loaded.sha)})` : '';
    if (own && own !== entry.version) note = ` Note: this doctor is ${own} from ${pluginRoot}, not the copy Claude Code loads.`;
    const which = entries.length > 1 ? ` (the ${entry.scope ?? 'user'} install of ${entries.length})` : '';
    loaded.text = `Claude Code loads ${entry.version}${commit} from ${entry.installPath}${which}`;
  } else {
    const top = await plugins.git(pluginRoot, ['rev-parse', '--show-toplevel']);
    const head = top.status === 0 ? await plugins.git(pluginRoot, ['rev-parse', 'HEAD']) : null;
    const prefix = `exo-compact ${own ?? 'version unknown'} from ${pluginRoot} (not installed as a plugin${entries.length ? ' for this folder' : ''}`;
    if (!head || head.status !== 0) {
      add('version', 'ok', `${prefix}, not a git clone; main not checked).`);
      return;
    }
    repo = top.stdout.trim();
    update = (gitSteps) => commandLine(plugins.platform, repo, gitSteps);
    loaded = { version: own, sha: head.stdout.trim() };
    loaded.text = `${prefix}) is at ${short(loaded.sha)}`;
  }

  const say = (status, message) => add('version', status, `${message}${note}`);
  const release = repo && loaded.sha ? await latestRelease(plugins.git, repo) : null;
  if (release === UNREACHABLE) {
    say('ok', `${loaded.text}; the latest release not checked: the remote could not be reached.`);
    return;
  }
  if (release) {
    const { tag } = release;
    const at = `the latest release is ${tag} (${short(release.sha)})`;
    // The installer leaves a detached clone at the tag, where a pull fails; a clone on a branch stays on it.
    const onBranch = (await plugins.git(repo, ['symbolic-ref', '--quiet', 'HEAD'])).status === 0;
    const gitSteps = onBranch ? ['git -C <repo> pull --ff-only'] : [`git -C <repo> fetch --quiet origin tag ${tag}`, `git -C <repo> checkout --quiet --detach ${tag}`];
    const then = `Update: ${update(gitSteps)}, then restart Claude Code sessions.`;
    const relation = await releaseOrder(plugins.git, repo, loaded, release);
    if (relation === 'same') say('ok', `${loaded.text}, the latest release (${tag}).`);
    else if (relation === 'version') say('ok', `${loaded.text}: the version of the latest release ${tag}, at another commit than its tag (${short(release.sha)}).`);
    else if (relation === 'ahead') say('ok', `${loaded.text}, newer than the latest release ${tag} (${short(release.sha)}).`);
    else if (relation === 'behind') say('warn', `${loaded.text}, behind the latest release; ${at}. ${then}`);
    else if (relation === 'differs') say('warn', `${loaded.text}, which differs from the latest release ${tag} (${short(release.sha)}): its history does not contain it. ${then}`);
    else say('warn', `${loaded.text}; ${at}, and this clone cannot tell which is newer. ${then}`);
    return;
  }
  const main = repo && loaded.sha ? await mainCommit(plugins.git, repo) : null;
  if (!main || !loaded.sha) {
    say('ok', `${loaded.text}; main not checked.`);
    return;
  }
  const version = await mainVersion(plugins.git, repo, main.sha);
  const at = `main is at ${version ? `${version} ` : ''}(${short(main.sha)})${main.stale ? ' as of the last fetch' : ''}`;
  const then = `Update: ${update(['git -C <repo> pull --ff-only'])}, then restart Claude Code sessions.`;
  const relation = await order(plugins.git, repo, loaded.sha, main.sha);
  if (relation === 'same') say('ok', `${loaded.text}, same as main.`);
  else if (relation === 'ahead') say('ok', `${loaded.text}, newer than main; ${at}.`);
  else if (relation === 'behind') say('warn', `${loaded.text}, behind main; ${at}. ${then}`);
  else if (relation === 'differs') say('warn', `${loaded.text}, which differs from main (${short(main.sha)}): main does not contain it. ${then}`);
  else say('warn', `${loaded.text}; ${at}, and this clone cannot tell which is newer. ${then}`);
}

export async function runDoctor(deps) {
  const checks = [];
  const add = (id, status, message) => checks.push({ id, status, message });

  checkNode(deps.nodeVersion, add);
  checkClaude(await deps.claudeVersion(), add);

  const missing = RECALL_FILES.filter((file) => !deps.fileExists(path.join(deps.pluginRoot, file)));
  if (missing.length === 0) add('recall', 'ok', 'recall files present');
  else add('recall', 'fail', `recall files missing: ${missing.join(', ')}`);

  if (deps.plugins) await checkVersion(deps.plugins, deps.pluginRoot, add);

  if (typeof deps.cwd === 'string' && typeof deps.home === 'string' && typeof deps.readFile === 'function') {
    const flag = captureFlagStatus(deps.cwd, deps.fileExists, deps.home);
    if (flag.enabled && flag.dir) add('capture-flag', 'ok', `S4 is enabled for ${deps.cwd} (flag in ${flag.dir})`);
    else if (flag.enabled) add('capture-flag', 'ok', `S4 is enabled for ${deps.cwd} (installed, no flag file needed)`);
    else if (flag.optOut) add('capture-flag', 'warn', `S4 is not enabled for ${deps.cwd}: the opt-out file in ${flag.dir} turns it off, every compaction here is native (undo: node "${path.join(deps.pluginRoot, 'setup.cjs')}" enable <dir>)`);
    else add('capture-flag', 'warn', `S4 is not enabled for ${deps.cwd}: no home directory found, every compaction here is native (enable: node "${path.join(deps.pluginRoot, 'setup.cjs')}" enable <dir>)`);

    const entrypoint = deps.env.CLAUDE_CODE_ENTRYPOINT;
    if (!readInteractiveOnly(settingsFiles(deps), deps.readFile)) add('interactive-only', 'ok', 'interactiveOnly: off, every session kind uses S4');
    else if (entrypoint === 'cli' || entrypoint === 'claude-vscode') add('interactive-only', 'ok', `interactiveOnly: on, a ${entrypoint} session uses S4`);
    else if (entrypoint) add('interactive-only', 'warn', `interactiveOnly is on and CLAUDE_CODE_ENTRYPOINT=${entrypoint}: this kind of session keeps native compaction. ${INTERACTIVE_ONLY_HINT}`);
    else add('interactive-only', 'ok', `interactiveOnly: on, terminal and VS Code or Cursor extension sessions use S4; -p and SDK runs stay on native compaction. ${INTERACTIVE_ONLY_HINT}`);

    checkAutoCompact(deps, add);
    checkBypass(deps, add);
  }

  let jev = 'off';
  // 4.7.5: without --jev, a Jev option that is on in the settings is checked the same way, as a warning only.
  const optionsOn = deps.jev ? [] : (deps.jevOptions ?? []);
  if (!deps.jev && optionsOn.length === 0) {
    add('jev', 'warn', `Jev: off (optional), so the rule check does not run. ${JEV_HINT}`);
  } else {
    const help = optionsOn.length ? keyHelpFor(optionsOn) : KEY_HELP;
    // 4.7.5 (S5q): EXO_JEV_URL names another address for Jev; a loopback one needs no key (recall/jev-endpoint.mjs).
    const endpoint = jevEndpoint(deps.env);
    const customUrl = String(deps.env.EXO_JEV_URL ?? '').trim();
    if (endpoint === 'bad_url') {
      jev = 'bad_url';
      add('jev', 'warn', 'Jev: EXO_JEV_URL is set but is not an http or https address, so Jev is not asked. Set it to the address of a /v1/systemone endpoint (for example http://127.0.0.1:8080/v1/systemone), or unset it to use TypeSafe.');
    } else if (endpoint === 'no_key' && customUrl && !customUrl.startsWith('${')) {
      jev = 'no_key';
      add('jev', 'warn', `Jev: EXO_JEV_URL names ${jevOrigin(customUrl)}, which is not this machine, and TYPESAFE_API_KEY is not set, so Jev is not asked. Only an address on this machine (127.0.0.1, localhost) works without a key.`);
    } else if (endpoint === 'no_key') {
      jev = 'no_key';
      const many = optionsOn.length > 1;
      add('jev', 'warn', optionsOn.length
        ? `Jev: ${optionsOn.join(' and ')} ${many ? 'are' : 'is'} on in the plugin options but TYPESAFE_API_KEY is not set, so ${many ? 'they do' : 'it does'} nothing.\n${help}`
        : `Jev: enabled but TYPESAFE_API_KEY is not set.\n${help}`);
    } else if (endpoint.own) {
      const server = `your own server ${jevOrigin(endpoint.url)} (EXO_JEV_URL)`;
      const model = deps.jevModel ?? 'jev-latest';
      const now = deps.now ?? Date.now;
      const startedAt = now();
      const result = await probeJev(deps.fetch, endpoint.key, model, deps.timeoutMs ?? PROBE_TIMEOUT_MS, endpoint.url);
      const ms = Math.max(0, Math.round(now() - startedAt));
      jev = result.jev;
      if (jev === 'ok') {
        const named = resolvesModel(model, result.model) ? '' : `\nThe server names its model "${result.model}", which is not what jevModel "${model}" asks for, so span selection (jevEnabled) rejects every answer. Start the server with a name the default accepts (llama-server: --alias jev-0.1), or set jevModel to that name.`;
        add('jev', 'ok', `Jev: ${server} answered in ${ms} ms (${result.detail})${named}`);
      } else if (jev === 'bad_key') add('jev', 'warn', `Jev: ${server} rejected the key (${result.detail}). It is sent TYPESAFE_API_KEY as the bearer key${endpoint.key === deps.env.TYPESAFE_API_KEY ? '' : ', or "local" when that is not set'}.`);
      else if (jev === 'no_credit') add('jev', 'warn', `Jev: ${server} answered HTTP 402 (payment required), so Jev does nothing.`);
      else add('jev', 'warn', `Jev: no answer from ${server} (${result.detail}). Start it, or unset EXO_JEV_URL.`);
    } else {
      const result = await probeJev(deps.fetch, endpoint.key, deps.jevModel ?? 'jev-latest', deps.timeoutMs ?? PROBE_TIMEOUT_MS);
      jev = result.jev;
      if (jev === 'ok') add('jev', 'ok', `Jev: key set, API answered (${result.detail})`);
      else if (jev === 'bad_key') add('jev', 'warn', `Jev: TypeSafe rejected the key (${result.detail}).\n${help}`);
      else if (jev === 'no_credit') add('jev', 'warn', 'Jev: TypeSafe answered HTTP 402 (payment required): the account has no credit, so Jev does nothing until it is topped up.');
      else add('jev', 'warn', `Jev: TypeSafe API not reachable (${result.detail}). Start without Jev, or retry later.`);
    }
  }
  return { checks, jev, ...(optionsOn.length ? { warnOnly: true } : {}) };
}

export function exitCode(result) {
  if (result.checks.some((check) => check.status === 'fail')) return 1;
  return result.jev === 'off' || result.jev === 'ok' || result.warnOnly === true ? 0 : 3;
}

export function formatReport(result) {
  const mark = { ok: 'ok  ', warn: 'WARN', fail: 'FAIL' };
  return result.checks.map((check) => `exo-compact doctor ${mark[check.status]} ${check.message}`).join('\n');
}

// Windows needs the shell to find claude.cmd; there the command goes as one string, since args with shell: true raise
// DEP0190 on Node 24, which PowerShell 5.1 shows as a red NativeCommandError.
export function claudeVersionCommand(platform) {
  const shell = platform === 'win32';
  return shell
    ? { command: 'claude --version', args: [], options: { timeout: 15_000, shell } }
    : { command: 'claude', args: ['--version'], options: { timeout: 15_000, shell } };
}

function claudeVersion() {
  const { command, args, options } = claudeVersionCommand(process.platform);
  return new Promise((resolve) => {
    execFile(command, args, options, (error, stdout) => {
      resolve(error ? null : String(stdout));
    });
  });
}

function configDir(env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// The plugin records Claude Code keeps under <config>/plugins, and git with no prompt and a time limit.
function pluginRecords(env, pluginRoot) {
  const dir = path.join(configDir(env), 'plugins');
  return {
    installed: () => Object.entries(readJson(path.join(dir, 'installed_plugins.json'))?.plugins ?? {})
      .filter(([key, entries]) => key.startsWith('exo-compact@') && Array.isArray(entries) && entries[0])
      .flatMap(([key, entries]) => entries.map((entry) => ({ key, scope: entry?.scope, projectPath: entry?.projectPath, version: entry?.version, gitCommitSha: entry?.gitCommitSha, installPath: entry?.installPath }))),
    marketplace: (name) => {
      const record = readJson(path.join(dir, 'known_marketplaces.json'))?.[name];
      return record ? { source: record.source?.source, installLocation: record.installLocation } : null;
    },
    git: (cwd, args) => new Promise((resolve) => {
      const gitEnv = { ...env, GIT_TERMINAL_PROMPT: '0', ...(env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }) };
      execFile('git', ['-C', cwd, ...args], { timeout: 15_000, env: gitEnv, windowsHide: true }, (error, stdout) => {
        resolve({ status: error ? (typeof error.code === 'number' ? error.code : 127) : 0, stdout: String(stdout ?? '') });
      });
    }),
    ownVersion: readJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json'))?.version,
    cwd: process.cwd(),
    platform: process.platform,
  };
}

function readSettings(env) {
  try { return fs.readFileSync(path.join(configDir(env), 'settings.json'), 'utf8'); } catch { return null; }
}

async function versionsMain(argv) {
  const at = argv.indexOf('--claude');
  const claudeText = at >= 0 ? argv[at + 1] : await claudeVersion();
  const problems = versionProblems({ nodeVersion: process.versions.node, claudeVersion: claudeText });
  if (problems.length === 0) return 0;
  process.stdout.write(`exo-compact: ${problems.join('; ')}. It stays off for this session and Claude Code uses its native compaction.\n`);
  return 1;
}

function digestMain(argv, pluginRoot) {
  const folder = argv[1] !== undefined ? path.resolve(argv[1]) : loadedInstall(pluginRecords(process.env, pluginRoot).installed(), process.cwd())?.installPath ?? pluginRoot;
  const result = pluginDigest(folder);
  if (result.problem) {
    process.stdout.write(`exo-compact digest: no digest for ${folder}: ${result.problem}.\n`);
    return 1;
  }
  const where = 'Managed settings name it under extraKnownMarketplaces["exo-compact"].pluginDigests["exo-compact"]';
  const lines = [result.digest, `exo-compact digest: ${folder}, ${result.files} files. ${where} (${BYPASS_SECTION}).`, ...result.notes.map((note) => `exo-compact digest: note: ${note}.`)];
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

async function main(argv) {
  if (argv.includes('--versions')) return versionsMain(argv);
  const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
  if (argv[0] === 'digest') return digestMain(argv, pluginRoot);
  const modelAt = argv.indexOf('--jev-model');
  const result = await runDoctor({
    env: process.env,
    nodeVersion: process.versions.node,
    claudeVersion,
    fileExists: (file) => fs.existsSync(file),
    fetch: globalThis.fetch,
    jev: argv.includes('--jev'),
    jevOptions: jevOptionsOn(readSettings(process.env)),
    jevModel: modelAt >= 0 ? argv[modelAt + 1] : undefined,
    pluginRoot,
    // --preflight (the installers): no folder is turned on yet, so the checks about a session in the cwd and about the
    // installed copy are left out.
    ...(argv.includes('--preflight') ? {} : { cwd: process.cwd(), home: os.homedir(), readFile: (file) => fs.readFileSync(file, 'utf8'), plugins: pluginRecords(process.env, pluginRoot), bypass: () => findBypass(claudeProjectDir(process.cwd(), process.env, os.homedir())) }),
  });
  process.stdout.write(`${argv.includes('--json') ? JSON.stringify(result) : formatReport(result)}\n`);
  return exitCode(result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
