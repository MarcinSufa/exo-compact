import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as doctor from '../doctor.mjs';

// 4.8.1: Claude Code keeps running the copy it installed until `claude plugin update`, so a pulled clone or a merged
// fix changes nothing in a session. The doctor names the installed version, compares it with main, and gives the
// update command when it is behind.
const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const OLD = 'f93f48c2d02758ae56786fa0566fc98f4adde236';
const MAIN = '32bb09c0000000000000000000000000000000aa';

type Git = (cwd: string, args: string[]) => Promise<{ status: number; stdout: string }>;

function plugins(overrides: Record<string, unknown> = {}) {
  const calls: string[][] = [];
  const git: Git = async (cwd, args) => {
    calls.push([cwd, ...args]);
    const line = args.join(' ');
    if (line === 'ls-remote origin refs/heads/main') return { status: 0, stdout: `${MAIN}\trefs/heads/main\n` };
    if (line === `show ${MAIN}:plugin/compact/.claude-plugin/plugin.json`) return { status: 0, stdout: JSON.stringify({ version: '4.8.0' }) };
    if (line === `merge-base --is-ancestor ${OLD} ${MAIN}`) return { status: 0, stdout: '' };
    return { status: 1, stdout: '' };
  };
  return {
    calls,
    value: {
      installed: () => [{ key: 'exo-compact@exo-compact', version: '4.7.4', gitCommitSha: OLD, installPath: '/cfg/plugins/cache/exo-compact/exo-compact/4.7.4' }],
      marketplace: (name: string) => (name === 'exo-compact' ? { source: 'directory', installLocation: '/work/exo-compact' } : null),
      git,
      ownVersion: '4.8.0',
      ...overrides,
    },
  };
}

async function versionCheck(pluginsDeps: Record<string, unknown> | undefined) {
  const result = await doctor.runDoctor({
    env: {}, nodeVersion: '22.23.2', claudeVersion: async () => '2.1.283 (Claude Code)', fileExists: () => true,
    fetch: async () => { throw new Error('no network in this test'); }, jev: false, pluginRoot: '/plugin',
    ...(pluginsDeps ? { plugins: pluginsDeps } : {}),
  });
  return { result, check: result.checks.find((check: { id: string }) => check.id === 'version'), code: doctor.exitCode(result) };
}

describe('doctor: the installed version against main', () => {
  it('behind main: a warning with both versions, the commits and the update command; exit stays 0', async () => {
    const p = plugins();
    const { check, code } = await versionCheck(p.value);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('4.7.4 (f93f48c)');
    expect(check.message).toContain('main is at 4.8.0 (32bb09c)');
    expect(check.message).toContain('git -C "/work/exo-compact" pull --ff-only && claude plugin marketplace update exo-compact && claude plugin update exo-compact@exo-compact');
    expect(check.message).toMatch(/restart/i);
    expect(code).toBe(0);
    // Read-only towards the clone: ls-remote asks the remote, nothing is fetched or pulled.
    expect(p.calls.length).toBeGreaterThan(0);
    expect(p.calls.every(([, command]) => ['ls-remote', 'show', 'merge-base', 'rev-parse', 'tag', 'symbolic-ref'].includes(command))).toBe(true);
  });

  it('same commit as main: ok', async () => {
    const { check } = await versionCheck(plugins({ installed: () => [{ key: 'exo-compact@exo-compact', version: '4.8.0', gitCommitSha: MAIN, installPath: '/x' }] }).value);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('4.8.0 (32bb09c)');
    expect(check.message).toContain('same as main');
  });

  it('ahead of main (a branch build): ok, named as newer', async () => {
    const git: Git = async (_cwd, args) => {
      const line = args.join(' ');
      if (line === 'ls-remote origin refs/heads/main') return { status: 0, stdout: `${MAIN}\trefs/heads/main\n` };
      if (line === `merge-base --is-ancestor ${MAIN} ${OLD}`) return { status: 0, stdout: '' };
      return { status: 1, stdout: '' };
    };
    const { check } = await versionCheck(plugins({ git }).value);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('newer than main');
  });

  it('a commit main does not contain: a warning that it differs, with the update command', async () => {
    const git: Git = async (_cwd, args) => {
      const line = args.join(' ');
      if (line === 'ls-remote origin refs/heads/main') return { status: 0, stdout: `${MAIN}\trefs/heads/main\n` };
      if (line === 'rev-parse --is-shallow-repository') return { status: 0, stdout: 'false\n' };
      return { status: 1, stdout: '' };
    };
    const { check } = await versionCheck(plugins({ git }).value);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('differs from main (32bb09c)');
    expect(check.message).toContain('claude plugin update exo-compact@exo-compact');
  });

  it('the remote cannot be reached: the last fetched origin/main is used and named so', async () => {
    const git: Git = async (_cwd, args) => {
      const line = args.join(' ');
      if (line === 'rev-parse --verify --quiet refs/remotes/origin/main') return { status: 0, stdout: `${MAIN}\n` };
      if (line === `merge-base --is-ancestor ${OLD} ${MAIN}`) return { status: 0, stdout: '' };
      return { status: 128, stdout: '' };
    };
    const { check } = await versionCheck(plugins({ git }).value);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('as of the last fetch');
  });

  it('no main to compare with: ok, says main was not checked', async () => {
    const git: Git = async () => ({ status: 128, stdout: '' });
    const { check, code } = await versionCheck(plugins({ git }).value);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('4.7.4 (f93f48c)');
    expect(check.message).toContain('main not checked');
    expect(code).toBe(0);
  });

  it('a github marketplace: Claude Code keeps the clone, so the command has no git pull', async () => {
    const { check } = await versionCheck(plugins({ marketplace: () => ({ source: 'github', installLocation: '/cfg/plugins/marketplaces/exo-compact' }) }).value);
    expect(check.message).toContain('claude plugin marketplace update exo-compact && claude plugin update exo-compact@exo-compact');
    expect(check.message).not.toContain('pull --ff-only');
  });

  it('this doctor is another copy than the one Claude Code loads: both are named', async () => {
    const { check } = await versionCheck(plugins({ ownVersion: '4.8.0' }).value);
    expect(check.message).toContain('Claude Code loads 4.7.4');
    expect(check.message).toContain('/cfg/plugins/cache/exo-compact/exo-compact/4.7.4');
    expect(check.message).toContain('this doctor is 4.8.0 from /plugin');
    const same = await versionCheck(plugins({ ownVersion: '4.7.4' }).value);
    expect(same.check.message).not.toContain('this doctor is');
  });

  it('not installed as a plugin (the launcher, a clone): the clone itself is compared with main', async () => {
    const git: Git = async (cwd, args) => {
      const line = args.join(' ');
      if (line === 'rev-parse --show-toplevel') return { status: 0, stdout: '/work/exo-compact\n' };
      if (line === 'rev-parse HEAD') return { status: 0, stdout: `${OLD}\n` };
      if (line === 'ls-remote origin refs/heads/main') return { status: 0, stdout: `${MAIN}\trefs/heads/main\n` };
      if (line === `merge-base --is-ancestor ${OLD} ${MAIN}`) return { status: 0, stdout: '' };
      return { status: 1, stdout: cwd };
    };
    const { check } = await versionCheck(plugins({ installed: () => [], git }).value);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('not installed as a plugin');
    expect(check.message).toContain('git -C "/work/exo-compact" pull --ff-only');
    expect(check.message).not.toContain('claude plugin update');
  });

  it('a project install covering the cwd is the copy that loads, not the user one listed first', async () => {
    const installed = () => [
      { key: 'exo-compact@exo-compact', scope: 'user', version: '4.7.4', gitCommitSha: OLD, installPath: '/cfg/user-copy' },
      { key: 'exo-compact@exo-compact', scope: 'project', projectPath: '/work/other', version: '4.6.0', gitCommitSha: OLD, installPath: '/cfg/other-copy' },
      { key: 'exo-compact@exo-compact', scope: 'project', projectPath: '/work/app', version: '4.8.0', gitCommitSha: MAIN, installPath: '/cfg/project-copy' },
    ];
    const inApp = await versionCheck(plugins({ installed, cwd: '/work/app/src' }).value);
    expect(inApp.check.status).toBe('ok');
    expect(inApp.check.message).toContain('/cfg/project-copy');
    expect(inApp.check.message).toContain('the project install of 3');
    const elsewhere = await versionCheck(plugins({ installed, cwd: '/home/me' }).value);
    expect(elsewhere.check.message).toContain('/cfg/user-copy');
    expect(elsewhere.check.message).toContain('the user install of 3');
  });

  it('only a project install for another folder: nothing loads here, the clone is compared instead', async () => {
    const installed = () => [{ key: 'exo-compact@exo-compact', scope: 'project', projectPath: '/work/other', version: '4.6.0', gitCommitSha: OLD, installPath: '/cfg/other-copy' }];
    const git: Git = async () => ({ status: 128, stdout: '' });
    const { check } = await versionCheck(plugins({ installed, cwd: '/work/app', git }).value);
    expect(check.message).not.toContain('/cfg/other-copy');
    expect(check.message).toContain('not installed as a plugin for this folder');
  });

  it('a folder whose name starts with two dots is still inside the project', async () => {
    const installed = () => [
      { key: 'exo-compact@exo-compact', scope: 'user', version: '4.7.4', gitCommitSha: OLD, installPath: '/cfg/user-copy' },
      { key: 'exo-compact@exo-compact', scope: 'project', projectPath: '/work/app', version: '4.8.0', gitCommitSha: MAIN, installPath: '/cfg/project-copy' },
    ];
    const { check } = await versionCheck(plugins({ installed, cwd: '/work/app/..cache/src' }).value);
    expect(check.message).toContain('/cfg/project-copy');
  });

  it('a failed shallow query is unknown too, not diverged', async () => {
    const git: Git = async (_cwd, args) => (args.join(' ') === 'ls-remote origin refs/heads/main' ? { status: 0, stdout: `${MAIN}\trefs/heads/main\n` } : { status: args[0] === 'rev-parse' ? 129 : 1, stdout: '' });
    const { check } = await versionCheck(plugins({ git }).value);
    expect(check.message).toContain('cannot tell which is newer');
  });

  it('no commit recorded: git is not asked at all', async () => {
    const p = plugins({ installed: () => [{ key: 'exo-compact@exo-compact', version: '4.7.4', installPath: '/x' }] });
    const { check } = await versionCheck(p.value);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('main not checked');
    expect(p.calls).toEqual([]);
  });

  it('a commit this clone does not have (merge-base 128) is unknown, not diverged', async () => {
    const git: Git = async (_cwd, args) => (args.join(' ') === 'ls-remote origin refs/heads/main' ? { status: 0, stdout: `${MAIN}\trefs/heads/main\n` } : { status: args[0] === 'merge-base' ? 128 : 1, stdout: '' });
    const { check } = await versionCheck(plugins({ git }).value);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('cannot tell which is newer');
    expect(check.message).not.toContain('differs');
  });

  it('a shallow clone cannot prove ancestry: unknown, not diverged', async () => {
    const git: Git = async (_cwd, args) => {
      const line = args.join(' ');
      if (line === 'ls-remote origin refs/heads/main') return { status: 0, stdout: `${MAIN}\trefs/heads/main\n` };
      if (line === 'rev-parse --is-shallow-repository') return { status: 0, stdout: 'true\n' };
      return { status: 1, stdout: '' };
    };
    const { check } = await versionCheck(plugins({ git }).value);
    expect(check.message).toContain('cannot tell which is newer');
  });

  it('on Windows the command is PowerShell 5.1 safe: no &&, the path in single quotes', async () => {
    const { check } = await versionCheck(plugins({ platform: 'win32', marketplace: () => ({ source: 'directory', installLocation: "C:\\Users\\o'brien\\$x" }) }).value);
    // PowerShell 5.1 has no &&: each step runs only when the one before it succeeded (nested, as a skipped block resets $?).
    expect(check.message).toContain("git -C 'C:\\Users\\o''brien\\$x' pull --ff-only; if ($?) { claude plugin marketplace update exo-compact; if ($?) { claude plugin update exo-compact@exo-compact } }");
    expect(check.message).not.toContain('&&');
  });

  it('without the plugins dependency (--preflight) there is no version line', async () => {
    const { check } = await versionCheck(undefined);
    expect(check).toBeUndefined();
  });
});

describe('doctor CLI: version against a real clone', () => {
  const git = (cwd: string, ...args: string[]) => {
    const ran = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', '-C', cwd, ...args], { encoding: 'utf8' });
    if (ran.status !== 0) throw new Error(ran.stderr);
    return ran.stdout.trim();
  };

  it('reads installed_plugins.json and known_marketplaces.json under CLAUDE_CONFIG_DIR and warns when main moved on', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'doctor-version-'));
    try {
      const origin = path.join(root, 'origin.git');
      const clone = path.join(root, 'clone');
      const config = path.join(root, 'config');
      mkdirSync(origin); git(origin, 'init', '-q', '--bare');
      mkdirSync(path.join(clone, 'plugin', 'compact', '.claude-plugin'), { recursive: true });
      git(clone, 'init', '-q');
      git(clone, 'remote', 'add', 'origin', origin);
      const manifest = path.join(clone, 'plugin', 'compact', '.claude-plugin', 'plugin.json');
      writeFileSync(manifest, JSON.stringify({ version: '4.7.4' }));
      git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', 'old');
      const old = git(clone, 'rev-parse', 'HEAD');
      writeFileSync(manifest, JSON.stringify({ version: '4.8.0' }));
      git(clone, 'commit', '-q', '-am', 'new');
      git(clone, 'push', '-q', 'origin', 'HEAD:main');
      const main = git(clone, 'rev-parse', 'HEAD');
      git(clone, 'reset', '-q', '--hard', old);
      mkdirSync(path.join(config, 'plugins'), { recursive: true });
      writeFileSync(path.join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'exo-compact@exo-compact': [{ scope: 'user', installPath: path.join(config, 'plugins', 'cache', 'x'), version: '4.7.4', gitCommitSha: old }] } }));
      writeFileSync(path.join(config, 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'exo-compact': { source: { source: 'directory', path: clone }, installLocation: clone } }));
      const ran = spawnSync(process.execPath, [path.join(pluginRoot, 'doctor.mjs'), '--json'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: config, GIT_TERMINAL_PROMPT: '0' }, cwd: root });
      const check = (JSON.parse(ran.stdout).checks as { id: string; status: string; message: string }[]).find((item) => item.id === 'version');
      expect(check?.status).toBe('warn');
      expect(check?.message).toContain(`4.7.4 (${old.slice(0, 7)})`);
      expect(check?.message).toContain(`main is at 4.8.0 (${main.slice(0, 7)})`);
      expect(git(clone, 'rev-parse', 'HEAD')).toBe(old);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// 4.8.1: the installers install a release tag, and the clone they leave is a detached HEAD at it. Compared with main,
// such an install read as behind after every merge, and `git pull --ff-only` fails off a branch. With release tags on
// the remote, the newest one is what the install is compared with, by version.
const TAG = 'a1b2c3d4000000000000000000000000000000ff';
const TAG_OBJECT = '0dd0dd0d000000000000000000000000000000ee';
const TAGS = 'ls-remote --tags origin refs/tags/v*';
const FETCH_TAG = 'git -C "/work/exo-compact" fetch --quiet origin tag v4.8.1 && git -C "/work/exo-compact" checkout --quiet --detach v4.8.1';

function tagged(tags: string, overrides: Record<string, unknown> = {}) {
  const base = plugins(overrides);
  const inner = base.value.git as Git;
  const git: Git = async (cwd, args) => {
    if (args.join(' ') === TAGS) { base.calls.push([cwd, ...args]); return { status: 0, stdout: tags }; }
    return inner(cwd, args);
  };
  return { calls: base.calls, value: { ...base.value, git } };
}
const RELEASES = [`${OLD}\trefs/tags/v4.7.4`, `${TAG_OBJECT}\trefs/tags/v4.8.1`, `${TAG}\trefs/tags/v4.8.1^{}`, ''].join('\n');
const install = (version: string, sha: string) => () => [{ key: 'exo-compact@exo-compact', version, gitCommitSha: sha, installPath: '/cfg/copy' }];

describe('doctor: the installed version against the latest release', () => {
  it('an older version: a warning naming the release, with fetch and checkout of the tag instead of a pull', async () => {
    const p = tagged(RELEASES);
    const { check, code } = await versionCheck(p.value);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('4.7.4 (f93f48c)');
    expect(check.message).toContain('behind the latest release');
    expect(check.message).toContain('the latest release is v4.8.1 (a1b2c3d)');
    expect(check.message).toContain(`${FETCH_TAG} && claude plugin marketplace update exo-compact && claude plugin update exo-compact@exo-compact`);
    expect(check.message).not.toContain('pull --ff-only');
    expect(check.message).not.toContain('main');
    expect(check.message).toMatch(/restart/i);
    expect(code).toBe(0);
    expect(p.calls.every(([, command]) => ['ls-remote', 'show', 'merge-base', 'rev-parse', 'tag', 'symbolic-ref'].includes(command))).toBe(true);
  });

  it('the commit of the latest release (the peeled one of an annotated tag): ok, even with main further on', async () => {
    const { check } = await versionCheck(tagged(RELEASES, { installed: install('4.8.1', TAG) }).value);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('the latest release (v4.8.1)');
  });

  it('a lightweight tag lists only the commit, which is used as is', async () => {
    const { check } = await versionCheck(tagged(`${TAG}\trefs/tags/v4.8.1\n`, { installed: install('4.8.1', TAG) }).value);
    expect(check.message).toContain('the latest release (v4.8.1)');
  });

  it('the release version at another commit (a build between releases): ok, and says so', async () => {
    const { check } = await versionCheck(tagged(RELEASES, { installed: install('4.8.1', MAIN) }).value);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('version of the latest release v4.8.1, at another commit than its tag (a1b2c3d)');
  });

  it('a newer version than any release: ok, named as newer', async () => {
    const { check } = await versionCheck(tagged(RELEASES, { installed: install('4.9.0', MAIN) }).value);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('newer than the latest release v4.8.1 (a1b2c3d)');
  });

  it('the newest release is chosen by version, not by name; other v tags are skipped', async () => {
    const tags = [`${TAG}\trefs/tags/v4.10.0`, `${MAIN}\trefs/tags/v4.9.0`, `${MAIN}\trefs/tags/v4.11.0-rc.1`, `${MAIN}\trefs/tags/vnext`, `${MAIN}\trefs/tags/v5`, ''].join('\n');
    const { check } = await versionCheck(tagged(tags, { installed: install('4.9.0', MAIN) }).value);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('the latest release is v4.10.0 (a1b2c3d)');
  });

  it('an installed version that is not x.y.z: the commits decide', async () => {
    const git: Git = async (_cwd, args) => {
      const line = args.join(' ');
      if (line === TAGS) return { status: 0, stdout: RELEASES };
      if (line === `merge-base --is-ancestor ${OLD} ${TAG}`) return { status: 0, stdout: '' };
      return { status: 1, stdout: '' };
    };
    const { check } = await versionCheck(plugins({ git, installed: install('f93f48c2d027', OLD) }).value);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('behind the latest release');
  });

  it('a github marketplace: the command has no git steps', async () => {
    const { check } = await versionCheck(tagged(RELEASES, { marketplace: () => ({ source: 'github', installLocation: '/cfg/plugins/marketplaces/exo-compact' }) }).value);
    expect(check.message).toContain('Update: claude plugin marketplace update exo-compact && claude plugin update exo-compact@exo-compact');
    expect(check.message).not.toContain('checkout');
  });

  it('not installed as a plugin: the clone is compared with the release, and moved with git alone', async () => {
    const git: Git = async (_cwd, args) => {
      const line = args.join(' ');
      if (line === 'rev-parse --show-toplevel') return { status: 0, stdout: '/work/exo-compact\n' };
      if (line === 'rev-parse HEAD') return { status: 0, stdout: `${OLD}\n` };
      if (line === TAGS) return { status: 0, stdout: RELEASES };
      return { status: 1, stdout: '' };
    };
    const { check } = await versionCheck(plugins({ installed: () => [], git, ownVersion: '4.7.4' }).value);
    expect(check.status).toBe('warn');
    expect(check.message).toContain(`Update: ${FETCH_TAG}, then restart`);
    expect(check.message).not.toContain('claude plugin update');
  });

  it('a clone on a branch (a developer clone): pulled, not detached at the tag', async () => {
    const p = tagged(RELEASES);
    const inner = p.value.git;
    const git: Git = async (cwd, args) => (args.join(' ') === 'symbolic-ref --quiet HEAD' ? { status: 0, stdout: 'refs/heads/main\n' } : inner(cwd, args));
    const { check } = await versionCheck({ ...p.value, git });
    expect(check.status).toBe('warn');
    expect(check.message).toContain('the latest release is v4.8.1');
    expect(check.message).toContain('git -C "/work/exo-compact" pull --ff-only && claude plugin marketplace update exo-compact');
    expect(check.message).not.toContain('checkout');
  });

  it('the remote cannot be reached and the clone has release tags: not checked, no stale main', async () => {
    const git: Git = async (_cwd, args) => {
      const line = args.join(' ');
      if (line === 'tag --list v*') return { status: 0, stdout: 'v4.7.4\nv4.8.0\n' };
      if (line === 'rev-parse --verify --quiet refs/remotes/origin/main') return { status: 0, stdout: `${MAIN}\n` };
      if (line === `merge-base --is-ancestor ${OLD} ${MAIN}`) return { status: 0, stdout: '' };
      return { status: 128, stdout: '' };
    };
    const { check } = await versionCheck(plugins({ git }).value);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('latest release not checked: the remote could not be reached');
    expect(check.message).not.toContain('main');
    expect(check.message).not.toContain('pull --ff-only');
  });

  it('no release tags on the remote: main is the comparison, as before', async () => {
    const { check } = await versionCheck(tagged('').value);
    expect(check.message).toContain('main is at 4.8.0 (32bb09c)');
    expect(check.message).toContain('pull --ff-only');
  });

  it('real git: an install cloned at an older tag, then the update command it prints moves the clone to the new one', () => {
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.hooksPath=', ...args], { cwd, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    const root = mkdtempSync(path.join(tmpdir(), 'doctor-release-'));
    try {
      const work = path.join(root, 'work');
      const origin = path.join(root, 'origin.git');
      const clone = path.join(root, 'clone');
      const config = path.join(root, 'config');
      mkdirSync(origin); git(origin, 'init', '-q', '--bare');
      mkdirSync(path.join(work, 'plugin', 'compact', '.claude-plugin'), { recursive: true });
      git(work, 'init', '-q', '-b', 'main');
      git(work, 'remote', 'add', 'origin', origin);
      const manifest = path.join(work, 'plugin', 'compact', '.claude-plugin', 'plugin.json');
      writeFileSync(manifest, JSON.stringify({ version: '4.8.0' }));
      git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'release 4.8.0'); git(work, 'tag', '-a', '-m', '4.8.0', 'v4.8.0');
      const old = git(work, 'rev-parse', 'HEAD');
      writeFileSync(manifest, JSON.stringify({ version: '4.8.1' }));
      git(work, 'commit', '-q', '-am', 'release 4.8.1'); git(work, 'tag', '-a', '-m', '4.8.1', 'v4.8.1');
      const release = git(work, 'rev-parse', 'HEAD');
      writeFileSync(path.join(work, 'UNRELEASED.txt'), 'x');
      git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'unreleased');
      git(work, 'push', '-q', 'origin', 'main', '--tags');
      // What the installer leaves: a shallow clone at the tag, detached.
      git(root, 'clone', '-q', '--depth', '1', '--branch', 'v4.8.0', `file://${origin}`, clone);
      mkdirSync(path.join(config, 'plugins'), { recursive: true });
      writeFileSync(path.join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'exo-compact@exo-compact': [{ scope: 'user', installPath: path.join(config, 'plugins', 'cache', 'x'), version: '4.8.0', gitCommitSha: old }] } }));
      writeFileSync(path.join(config, 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'exo-compact': { source: { source: 'directory', path: clone }, installLocation: clone } }));
      const ran = spawnSync(process.execPath, [path.join(pluginRoot, 'doctor.mjs'), '--json'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: config, GIT_TERMINAL_PROMPT: '0' }, cwd: root });
      const check = (JSON.parse(ran.stdout).checks as { id: string; status: string; message: string }[]).find((item) => item.id === 'version');
      expect(check?.status).toBe('warn');
      expect(check?.message).toContain(`the latest release is v4.8.1 (${release.slice(0, 7)})`);
      expect(git(clone, 'rev-parse', 'HEAD')).toBe(old);
      // The git steps of the printed command, run as printed (the claude steps need Claude Code).
      const command = /Update: (.*), then restart/.exec(check?.message ?? '')?.[1] ?? '';
      const steps = command.split(' && ').filter((step) => step.startsWith('git '));
      expect(steps).toHaveLength(2);
      for (const step of steps) {
        const ranStep = spawnSync('sh', ['-c', step], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
        expect(ranStep.status, ranStep.stderr).toBe(0);
      }
      expect(git(clone, 'rev-parse', 'HEAD')).toBe(release);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
