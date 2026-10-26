import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The installers (install.sh, install.ps1) run against a stub `claude` that appends its arguments, one
// JSON array per line, to $STUB_CALLS, and against a throwaway git repository that stands in for the
// public one. PATH holds only the stub, node and the system directories, so the real claude is not used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sh = path.join(root, 'install.sh');
const ps1 = path.join(root, 'install.ps1');
// The installers default to this release's tag, so the stand-in repository tags its commit the same way.
const releaseTag = `v${JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version}`;

// The full path: the sandbox runs pwsh with a PATH of /usr/bin and /bin only, so a pwsh found elsewhere on the
// caller's PATH (~/.local/bin) would not start there.
function findPwsh() {
  if (process.env.PWSH && fs.existsSync(process.env.PWSH)) return process.env.PWSH;
  const probe = spawnSync('pwsh', ['-NoProfile', '-Command', '(Get-Process -Id $PID).Path'], { encoding: 'utf8' });
  const found = probe.status === 0 ? probe.stdout.trim() : '';
  return found && fs.existsSync(found) ? found : undefined;
}
const pwsh = findPwsh();
// The sandbox stubs claude with a POSIX shell script and keeps PATH to /usr/bin and /bin, so on Windows
// both installers are tested under pwsh on Linux or macOS instead.
const noPosix = process.platform === 'win32' ? 'the sandbox needs a POSIX shell (run on Linux or macOS)' : false;
const noPwsh = noPosix || (pwsh ? false : 'pwsh not found (set PWSH)');

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// Every sandbox directory, removed once the file's tests are done.
const sandboxes = [];
after(() => { for (const dir of sandboxes) fs.rmSync(dir, { recursive: true, force: true }); });

function sandbox({ claude = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'exo-install-')));
  sandboxes.push(dir);
  const source = path.join(dir, 'source');
  fs.mkdirSync(path.join(source, 'plugin'), { recursive: true });
  fs.cpSync(path.join(root, '.claude-plugin'), path.join(source, '.claude-plugin'), { recursive: true });
  fs.cpSync(path.join(root, 'plugin/compact'), path.join(source, 'plugin/compact'), {
    recursive: true,
    filter: (file) => !file.includes('__gate-s4__') && !file.includes(`${path.sep}types${path.sep}`),
  });
  git(source, 'init', '-q', '-b', 'main', '.');
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', 'initial');
  git(source, 'tag', releaseTag);

  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const calls = path.join(dir, 'calls.jsonl');
  if (claude) {
    fs.writeFileSync(path.join(bin, 'claude'), [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "${STUB_CLAUDE_VERSION:-2.1.299} (Claude Code)"; exit 0; fi',
      'if [ -n "$STUB_FAIL" ] && [ "$1 $2 $3" = "$STUB_FAIL" ]; then echo "EBUSY: resource busy or locked" >&2; exit 1; fi',
      `exec "${process.execPath}" -e 'require("fs").appendFileSync(process.env.STUB_CALLS, JSON.stringify(process.argv.slice(1)) + "\\n")' -- "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });
  }
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const env = {
    PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    HOME: home,
    USERPROFILE: home,
    STUB_CALLS: calls,
    EXO_COMPACT_REPO: source,
  };
  const readCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { dir, source, home, env, clone: path.join(home, '.exo-compact'), readCalls };
}

const flag = (dir) => path.join(dir, '.exovault', 's4-compact-active');
const optout = (dir) => path.join(dir, '.exovault', 's4-compact-off');
const runSh = (env, options = {}) => spawnSync('bash', [sh], { env, encoding: 'utf8', ...options });
const runPs1 = (env) => spawnSync(pwsh, ['-NoProfile', '-File', ps1], { env, encoding: 'utf8' });

/**
 * The only options an install sets: the plugin directory and, since 4.9.2 (CONTRACT S5w), the absolute path of the Node
 * that ran the installer, so the hook does not start `node` from a PATH a project can change.
 */
function assertInstallConfigs(install, plugin) {
  const configs = install.filter((_, index) => install[index - 1] === '--config');
  assert.deepEqual(configs.map((config) => config.split('=')[0]).sort(), ['nodePath', 'recallPluginRoot']);
  const rootOption = configs.find((config) => config.startsWith('recallPluginRoot='));
  if (plugin !== undefined) assert.equal(path.resolve(rootOption.slice('recallPluginRoot='.length)), plugin);
  const nodePath = configs.find((config) => config.startsWith('nodePath=')).slice('nodePath='.length);
  assert.ok(path.isAbsolute(nodePath) && fs.existsSync(nodePath), `nodePath is an existing absolute path: ${nodePath}`);
}

function assertFreshInstall(box, result) {
  assert.equal(result.status, 0, result.stderr);
  const plugin = path.join(box.clone, 'plugin', 'compact');
  assert.ok(fs.existsSync(path.join(plugin, 'setup.cjs')), 'the clone holds the plugin');
  const calls = box.readCalls();
  assert.deepEqual(calls[0].slice(0, 3), ['plugin', 'marketplace', 'add']);
  assert.equal(path.resolve(calls[0][3]), box.clone);
  const install = calls.find((call) => call[1] === 'install');
  assert.deepEqual(install.slice(0, 3), ['plugin', 'install', 'exo-compact@exo-compact']);
  // recallEnabled and interactiveOnly come from the manifest defaults now; only the clone path and Node are set here.
  assertInstallConfigs(install, plugin);
  assert.ok(!fs.existsSync(flag(box.home)), 'no flag file is written: installed means enabled');
  assert.ok(!fs.existsSync(optout(box.home)), 'and nothing is opted out');
  assert.match(result.stdout, /exo-compact \d+\.\d+\.\d+ is installed/);
}

test('install.sh: a fresh install clones, registers the plugin with only the plugin directory and Node set, and writes no flag file', { skip: noPosix }, () => {
  const box = sandbox();
  assertFreshInstall(box, runSh(box.env));
});

test('install.sh: the check before the install does not warn that the folder is not turned on yet', { skip: noPosix }, () => {
  const box = sandbox();
  const result = runSh(box.env, { cwd: box.dir });
  assertFreshInstall(box, result);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /S4 is not enabled/);
});

test('install.sh: works when piped into bash, as in curl | bash', { skip: noPosix }, () => {
  const box = sandbox();
  assertFreshInstall(box, spawnSync('bash', [], { env: box.env, encoding: 'utf8', input: fs.readFileSync(sh, 'utf8') }));
});

test('install.sh: a second run updates the clone and keeps the options the user changed', { skip: noPosix }, () => {
  const box = sandbox();
  assert.equal(runSh(box.env).status, 0);
  fs.writeFileSync(path.join(box.source, 'NEW.txt'), 'new');
  git(box.source, 'add', '-A');
  git(box.source, 'commit', '-q', '-m', 'second');
  // A new release: the tag moves to the new commit.
  git(box.source, 'tag', '-f', releaseTag);
  // What Claude Code writes once the plugin is installed.
  const installed = path.join(box.home, '.claude', 'plugins', 'installed_plugins.json');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, JSON.stringify({ version: 2, plugins: { 'exo-compact@exo-compact': [{ scope: 'user' }] } }));
  const before = box.readCalls().length;
  const result = runSh(box.env);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(box.clone, 'NEW.txt')), 'the clone was updated');
  const calls = box.readCalls().slice(before);
  const install = calls.find((call) => call[1] === 'install');
  assertInstallConfigs(install);
  assert.ok(calls.some((call) => call.join(' ') === 'plugin marketplace update exo-compact'));
  assert.ok(calls.some((call) => call.join(' ') === 'plugin update exo-compact@exo-compact'));
  assert.match(result.stdout, /is installed/);
  assert.ok(!fs.existsSync(flag(box.home)) && !fs.existsSync(optout(box.home)), 'a second run leaves the enabled state alone');
});

// An existing clone moves to EXO_COMPACT_REF instead of only pulling the branch it was cloned from.
function stageRefSwitch(box, run) {
  assert.equal(run(box.env).status, 0);
  git(box.source, 'checkout', '-q', '-b', 'next');
  fs.writeFileSync(path.join(box.source, 'NEXT.txt'), 'next');
  git(box.source, 'add', '-A');
  git(box.source, 'commit', '-q', '-m', 'next');
  git(box.source, 'checkout', '-q', 'main');
  const result = run({ ...box.env, EXO_COMPACT_REF: 'next' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(box.clone, 'NEXT.txt')), 'the clone is on the requested ref');
  const back = run(box.env);
  assert.equal(back.status, 0, back.stderr);
  assert.ok(!fs.existsSync(path.join(box.clone, 'NEXT.txt')), 'and goes back to the release tag without it');
}

// 4.8.1: the default is the release tag, not main, so a commit merged to main installs nothing until it is released.
function stageMainAhead(box, run) {
  const tagged = git(box.source, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(box.source, 'UNRELEASED.txt'), 'unreleased');
  git(box.source, 'add', '-A');
  git(box.source, 'commit', '-q', '-m', 'unreleased');
  const result = run(box.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(box.clone, 'rev-parse', 'HEAD'), tagged, `the clone is at ${releaseTag}`);
  assert.ok(!fs.existsSync(path.join(box.clone, 'UNRELEASED.txt')), 'and does not hold the commit main has on top');
  const again = run(box.env);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(git(box.clone, 'rev-parse', 'HEAD'), tagged, 'a second run stays at the tag');
}

test('install.sh: the default ref is the release tag, so main moving ahead installs nothing new', { skip: noPosix }, () => {
  stageMainAhead(sandbox(), runSh);
});

test('install.sh: a second run with EXO_COMPACT_REF switches the clone to that ref', { skip: noPosix }, () => {
  stageRefSwitch(sandbox(), runSh);
});

test('install.sh: EXO_COMPACT_ENABLE_DIR writes a flag for one project, and "none" keeps it off everywhere', { skip: noPosix }, () => {
  const one = sandbox();
  const project = path.join(one.dir, 'project');
  fs.mkdirSync(project);
  assert.equal(runSh({ ...one.env, EXO_COMPACT_ENABLE_DIR: project }).status, 0);
  assert.ok(fs.existsSync(flag(project)));
  assert.ok(!fs.existsSync(flag(one.home)));
  assert.ok(!fs.existsSync(optout(one.home)));

  const none = sandbox();
  assert.equal(runSh({ ...none.env, EXO_COMPACT_ENABLE_DIR: 'none' }).status, 0);
  assert.ok(!fs.existsSync(flag(none.home)));
  assert.ok(fs.existsSync(optout(none.home)), 'the home directory is opted out');
});

test('install.sh: EXO_COMPACT_HOME moves the clone', { skip: noPosix }, () => {
  const box = sandbox();
  const elsewhere = path.join(box.dir, 'elsewhere');
  const result = runSh({ ...box.env, EXO_COMPACT_HOME: elsewhere });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(elsewhere, 'plugin', 'compact', 'setup.cjs')));
  assert.ok(!fs.existsSync(box.clone));
});

test('install.sh: without Claude Code it stops before cloning', { skip: noPosix }, () => {
  const box = sandbox({ claude: false });
  const probe = spawnSync('bash', ['-c', 'command -v claude'], { env: box.env, encoding: 'utf8' });
  if (probe.status === 0) return; // claude lives in a system directory here; the case cannot be staged
  const result = runSh(box.env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Claude Code/);
  assert.ok(!fs.existsSync(box.clone));
});

test('install.sh: a Claude Code that is too old stops the install before anything is registered', { skip: noPosix }, () => {
  const box = sandbox();
  const result = runSh({ ...box.env, STUB_CLAUDE_VERSION: '2.1.200' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /too old/);
  assert.deepEqual(box.readCalls(), []);
  assert.ok(!fs.existsSync(flag(box.home)));
});

test('install.sh: a folder that is not a clone is left alone', { skip: noPosix }, () => {
  const box = sandbox();
  fs.mkdirSync(box.clone);
  fs.writeFileSync(path.join(box.clone, 'mine.txt'), 'keep');
  const result = runSh(box.env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EXO_COMPACT_HOME/);
  assert.equal(fs.readFileSync(path.join(box.clone, 'mine.txt'), 'utf8'), 'keep');
  assert.deepEqual(box.readCalls(), []);
});

test('install.ps1: a fresh install clones, registers the plugin with only the plugin directory and Node set, and writes no flag file', { skip: noPwsh }, () => {
  const box = sandbox();
  assertFreshInstall(box, runPs1(box.env));
});

test('install.ps1: the check before the install does not warn that the folder is not turned on yet', { skip: noPwsh }, () => {
  const box = sandbox();
  const result = spawnSync(pwsh, ['-NoProfile', '-File', ps1], { env: box.env, encoding: 'utf8', cwd: box.dir });
  assertFreshInstall(box, result);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /S4 is not enabled/);
});

test('install.ps1: a second run sets only the plugin directory and Node again and runs the updates', { skip: noPwsh }, () => {
  const box = sandbox();
  assert.equal(runPs1(box.env).status, 0);
  const installed = path.join(box.home, '.claude', 'plugins', 'installed_plugins.json');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, JSON.stringify({ version: 2, plugins: { 'exo-compact@exo-compact': [{ scope: 'user' }] } }));
  const before = box.readCalls().length;
  const result = runPs1(box.env);
  assert.equal(result.status, 0, result.stderr);
  const calls = box.readCalls().slice(before);
  const install = calls.find((call) => call[1] === 'install');
  assertInstallConfigs(install);
  assert.ok(calls.some((call) => call.join(' ') === 'plugin update exo-compact@exo-compact'));
});

test('install.ps1: the default ref is the release tag, so main moving ahead installs nothing new', { skip: noPwsh }, () => {
  stageMainAhead(sandbox(), runPs1);
});

test('install.ps1: a second run with EXO_COMPACT_REF switches the clone to that ref', { skip: noPwsh }, () => {
  stageRefSwitch(sandbox(), runPs1);
});

test('install.ps1: a failed marketplace add says what to close when the folder is busy', { skip: noPwsh }, () => {
  const box = sandbox();
  const result = runPs1({ ...box.env, STUB_FAIL: 'plugin marketplace add' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EBUSY \(resource busy or locked\), close every terminal and editor/);
});

test('install.ps1: EXO_COMPACT_ENABLE_DIR and a Claude Code that is too old', { skip: noPwsh }, () => {
  const one = sandbox();
  const project = path.join(one.dir, 'project');
  fs.mkdirSync(project);
  assert.equal(runPs1({ ...one.env, EXO_COMPACT_ENABLE_DIR: project }).status, 0);
  assert.ok(fs.existsSync(flag(project)));
  assert.ok(!fs.existsSync(flag(one.home)));
  assert.ok(!fs.existsSync(optout(one.home)));

  const none = sandbox();
  assert.equal(runPs1({ ...none.env, EXO_COMPACT_ENABLE_DIR: 'none' }).status, 0);
  assert.ok(fs.existsSync(optout(none.home)));

  const old = sandbox();
  const result = runPs1({ ...old.env, STUB_CLAUDE_VERSION: '2.1.200' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(old.readCalls(), []);
});
