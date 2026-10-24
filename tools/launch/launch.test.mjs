import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The launchers (launch/exo-compact.sh, launch/exo-compact.ps1) run against a stub `claude` that prints its
// arguments, environment and --settings file as one JSON object on stdout: nothing else may reach stdout,
// so `launcher -p ... --output-format json` stays machine-readable, and every argument must arrive unchanged.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sh = path.join(root, 'launch/exo-compact.sh');
const ps1 = path.join(root, 'launch/exo-compact.ps1');
const plugin = path.join(root, 'plugin/compact');

function findPwsh() {
  if (process.env.PWSH && fs.existsSync(process.env.PWSH)) return process.env.PWSH;
  const probe = spawnSync('pwsh', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' });
  return probe.status === 0 ? 'pwsh' : undefined;
}
const noBashLauncher = process.platform === 'win32' ? 'the bash launcher is for Linux and macOS' : false;
const pwsh = findPwsh();

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exo-launch-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const cwd = path.join(dir, 'project');
  fs.mkdirSync(cwd);
  const stub = path.join(bin, 'claude');
  fs.writeFileSync(stub, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "2.1.299 (Claude Code)"; exit 0; fi',
    `exec "${process.execPath}" -e '`,
    'const fs = require("fs"); const args = process.argv.slice(1); const at = args.indexOf("--settings");',
    'console.log(JSON.stringify({ args, window: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? null, hooks: process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS ?? null, settings: at >= 0 ? JSON.parse(args[at + 1].startsWith("{") ? args[at + 1] : fs.readFileSync(args[at + 1], "utf8")) : null }));',
    `' -- "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CLAUDE_CONFIG_DIR: path.join(dir, 'cfg'), HOME: dir };
  return { dir, cwd, env };
}

function parse(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('exo-compact.sh: stdout is only claude\'s output; doctor goes to stderr; arguments arrive in order', { skip: noBashLauncher }, () => {
  const { cwd, env } = sandbox();
  const result = spawnSync('bash', [sh, '-p', 'say hi', '--output-format', 'json', '--allowedTools', 'Bash'], { cwd, env, encoding: 'utf8' });
  const out = parse(result);
  assert.deepEqual(out.args.slice(0, 2), ['--plugin-dir', plugin]);
  assert.deepEqual(out.args.slice(4), ['-p', 'say hi', '--output-format', 'json', '--allowedTools', 'Bash']);
  assert.equal(out.hooks, '1');
  assert.match(result.stderr, /exo-compact doctor ok/);
});

test('exo-compact.sh: S4_SKIP_DOCTOR and S4_WINDOW', { skip: noBashLauncher }, () => {
  const { cwd, env } = sandbox();
  const out = parse(spawnSync('bash', [sh, '-p', 'x'], { cwd, env: { ...env, S4_SKIP_DOCTOR: '1', S4_WINDOW: '5000' }, encoding: 'utf8' }));
  assert.equal(out.window, '5000');
});

test('exo-compact.ps1: no param block, so -p is claude\'s and positional words are not -PluginDir', { skip: pwsh ? false : 'pwsh not found (set PWSH)' }, () => {
  const { cwd, env } = sandbox();
  const result = spawnSync(pwsh, ['-NoProfile', '-File', ps1, '-p', 'say hi', '--output-format', 'json', '--allowedTools', 'Bash'], { cwd, env, encoding: 'utf8' });
  const out = parse(result);
  assert.equal(out.args[0], '--plugin-dir');
  assert.equal(path.resolve(out.args[1]), plugin);
  assert.deepEqual(out.args.slice(4), ['-p', 'say hi', '--output-format', 'json', '--allowedTools', 'Bash']);
  assert.match(result.stderr, /exo-compact doctor ok/);
});

test('exo-compact.ps1: -PluginDir, -Window, -Jev, -SkipDoctor are recognised only exactly (any case) and not passed on', { skip: pwsh ? false : 'pwsh not found (set PWSH)' }, () => {
  const { dir, cwd, env } = sandbox();
  const copy = path.join(dir, 'plugin-copy');
  fs.cpSync(plugin, copy, { recursive: true });
  const result = spawnSync(pwsh, ['-NoProfile', '-File', ps1, '-skipdoctor', '-WINDOW', '5000', '-plugindir', copy, '-jev', '-pluginDirX', '-Win', 'word', '-p', 'hi'], { cwd, env, encoding: 'utf8' });
  const out = parse(result);
  assert.equal(path.resolve(out.args[1]), copy);
  assert.deepEqual(out.args.slice(4), ['-pluginDirX', '-Win', 'word', '-p', 'hi']);
  assert.equal(out.window, '5000');
  assert.equal(out.settings.pluginConfigs['exo-compact'].options.jevEnabled, true);
});

test('exo-compact.ps1: a recognised flag with no value is an error, not a silent drop', { skip: pwsh ? false : 'pwsh not found (set PWSH)' }, () => {
  const { cwd, env } = sandbox();
  const result = spawnSync(pwsh, ['-NoProfile', '-File', ps1, '-SkipDoctor', '-Window'], { cwd, env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /-Window/);
});
