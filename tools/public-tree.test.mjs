import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIVATE_PATHS, buildPublicTree } from './public-tree.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' }).trim();

/** A small repository with one file under each private path, an untracked file and two commits. */
function fixture() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'public-tree-'));
  const source = path.join(base, 'source');
  const files = {
    'package.json': '{"name":"exo-compact","version":"9.9.9"}\n',
    'README.md': 'old readme\n',
    'docs/ctx-s4/runtime/cc.d.ts.txt': 'private\n',
    'docs/ctx-s4/runtime/fast-jev.ts.txt': 'private\n',
    'tools/ctxbench/run.mjs': 'private\n',
    'plugin/compact/__gate-s4__/GATE.md': 'private\n',
    'plugin/compact/__gate-s4__/kept.gate.test.ts': 'public\n',
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    writeFileSync(path.join(source, file), text);
  }
  git(base, 'init', '-q', '-b', 'main', source);
  git(source, 'config', 'user.name', 'Repo Owner');
  git(source, 'config', 'user.email', 'owner@example.com');
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', 'first');
  writeFileSync(path.join(source, 'README.md'), 'new readme\n');
  git(source, 'commit', '-q', '-am', 'second');
  writeFileSync(path.join(source, 'untracked.txt'), 'not in git\n');
  return { base, source };
}

test('the private paths are the ones the hygiene gate leaves out', () => {
  assert.deepEqual(PRIVATE_PATHS, ['docs/ctx-s4/', 'tools/ctxbench/', 'plugin/compact/__gate-s4__/GATE.md']);
});

test('builds the tracked tree without the private paths, as one commit with no remote', () => {
  const { base, source } = fixture();
  try {
    const out = path.join(base, 'out');
    const result = buildPublicTree({ source, out });
    assert.equal(readFileSync(path.join(out, 'README.md'), 'utf8'), 'new readme\n');
    assert.ok(existsSync(path.join(out, 'plugin/compact/__gate-s4__/kept.gate.test.ts')));
    for (const gone of ['docs/ctx-s4', 'tools/ctxbench', 'plugin/compact/__gate-s4__/GATE.md', 'untracked.txt']) {
      assert.ok(!existsSync(path.join(out, gone)), gone);
    }
    assert.equal(git(out, 'rev-list', '--count', 'HEAD'), '1');
    assert.equal(git(out, 'branch', '--show-current'), 'main');
    assert.equal(git(out, 'remote'), '');
    assert.equal(git(out, 'log', '-1', '--format=%an <%ae> | %cn <%ce>'), 'Repo Owner <owner@example.com> | Repo Owner <owner@example.com>');
    assert.match(git(out, 'log', '-1', '--format=%s'), /^exo-compact 9\.9\.9$/);
    assert.equal(git(out, 'status', '--porcelain'), '');
    assert.deepEqual(result.dropped.sort(), ['docs/ctx-s4/runtime/cc.d.ts.txt', 'docs/ctx-s4/runtime/fast-jev.ts.txt', 'plugin/compact/__gate-s4__/GATE.md', 'tools/ctxbench/run.mjs']);
    assert.equal(result.files, 3);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('an author that is given wins over the git identity, for both author and committer', () => {
  const { base, source } = fixture();
  try {
    const out = path.join(base, 'out');
    const result = buildPublicTree({ source, out, author: 'Public Author <public@example.com>' });
    assert.equal(git(out, 'log', '-1', '--format=%an <%ae> | %cn <%ce>'), 'Public Author <public@example.com> | Public Author <public@example.com>');
    assert.equal(result.author, 'Public Author <public@example.com>');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('refuses an author that is not "Name <email>", before it writes anything', () => {
  const { base, source } = fixture();
  try {
    for (const author of ['Claude', '<only@example.com>', 'Name <no-at>', 'Name <a@b> extra', 'Two\nLines <a@b.c>']) {
      assert.throws(() => buildPublicTree({ source, out: path.join(base, 'out'), author }), /author must be "Name <email>"/, author);
      assert.ok(!existsSync(path.join(base, 'out')), author);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('with no author and no git identity it refuses, and invents none', () => {
  const { base, source } = fixture();
  try {
    git(source, 'config', '--unset', 'user.name');
    git(source, 'config', '--unset', 'user.email');
    const home = path.join(base, 'home');
    mkdirSync(home);
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1' };
    for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL', 'GIT_CONFIG_GLOBAL']) delete env[name];
    const script = fileURLToPath(new URL('./public-tree.mjs', import.meta.url));
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `import { buildPublicTree } from ${JSON.stringify(script)}; buildPublicTree({ source: ${JSON.stringify(source)}, out: ${JSON.stringify(path.join(base, 'out'))} });`], { env, encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /no git identity: set user\.name and user\.email, or pass --author "Name <email>"/);
    assert.ok(!existsSync(path.join(base, 'out')));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('builds from an older ref when one is given', () => {
  const { base, source } = fixture();
  try {
    const out = path.join(base, 'out');
    buildPublicTree({ source, out, ref: 'HEAD~1' });
    assert.equal(readFileSync(path.join(out, 'README.md'), 'utf8'), 'old readme\n');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('refuses an output directory that is not empty, and leaves it as it was', () => {
  const { base, source } = fixture();
  try {
    const out = path.join(base, 'out');
    mkdirSync(out);
    writeFileSync(path.join(out, 'keep.txt'), 'mine\n');
    assert.throws(() => buildPublicTree({ source, out }), /not empty/);
    assert.equal(readFileSync(path.join(out, 'keep.txt'), 'utf8'), 'mine\n');
    assert.ok(!existsSync(path.join(out, '.git')));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('refuses an output directory inside the source repository', () => {
  const { base, source } = fixture();
  try {
    assert.throws(() => buildPublicTree({ source, out: path.join(source, 'public') }), /inside the source/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('the command line takes the output directory with and without --ref', () => {
  const { base, source } = fixture();
  try {
    const script = path.join(source, 'tools', 'public-tree.mjs');
    mkdirSync(path.dirname(script), { recursive: true });
    writeFileSync(script, readFileSync(new URL('./public-tree.mjs', import.meta.url)));
    git(source, 'add', 'tools/public-tree.mjs');
    git(source, 'commit', '-q', '-m', 'script');
    const plain = execFileSync(process.execPath, [script, path.join(base, 'plain')], { encoding: 'utf8' });
    assert.match(plain, /exo-compact 9\.9\.9, 4 files in one commit by Repo Owner <owner@example\.com>, 4 private files left out, no remote/);
    execFileSync(process.execPath, [script, '--ref', 'HEAD~2', path.join(base, 'old'), '--author', 'Given Name <given@example.com>'], { encoding: 'utf8' });
    assert.equal(readFileSync(path.join(base, 'old', 'README.md'), 'utf8'), 'old readme\n');
    assert.equal(git(path.join(base, 'old'), 'log', '-1', '--format=%an <%ae>'), 'Given Name <given@example.com>');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('refuses a ref with a symlink, and deletes nothing it points at', () => {
  const { base, source } = fixture();
  try {
    const elsewhere = path.join(base, 'elsewhere');
    mkdirSync(path.join(elsewhere, 'ctx-s4'), { recursive: true });
    writeFileSync(path.join(elsewhere, 'ctx-s4', 'keep.txt'), 'mine\n');
    rmSync(path.join(source, 'docs'), { recursive: true });
    symlinkSync(elsewhere, path.join(source, 'docs'));
    git(source, 'add', '-A', 'docs');
    git(source, 'commit', '-q', '-m', 'link');
    assert.throws(() => buildPublicTree({ source, out: path.join(base, 'out') }), /symlink or submodule: docs/);
    assert.ok(existsSync(path.join(elsewhere, 'ctx-s4', 'keep.txt')));
    assert.ok(!existsSync(path.join(base, 'out')));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('refuses an output directory that only looks outside the source', () => {
  const { base, source } = fixture();
  try {
    assert.throws(() => buildPublicTree({ source, out: `${source}${path.sep}..public` }), /inside the source/);
    const link = path.join(base, 'link-to-source');
    symlinkSync(source, link);
    assert.throws(() => buildPublicTree({ source, out: path.join(link, 'public') }), /inside the source/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('runs no git hook, a configured post-commit included', () => {
  const { base, source } = fixture();
  try {
    const hooks = path.join(base, 'hooks');
    mkdirSync(hooks);
    writeFileSync(path.join(hooks, 'post-commit'), `#!/bin/sh\necho ran > "${path.join(base, 'hook-ran')}"\n`, { mode: 0o755 });
    const home = path.join(base, 'home');
    mkdirSync(home);
    writeFileSync(path.join(home, '.gitconfig'), `[core]\n\thooksPath = ${hooks}\n`);
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1' };
    const script = fileURLToPath(new URL('./public-tree.mjs', import.meta.url));
    execFileSync(process.execPath, ['--input-type=module', '-e', `import { buildPublicTree } from ${JSON.stringify(script)}; buildPublicTree({ source: ${JSON.stringify(source)}, out: ${JSON.stringify(path.join(base, 'out'))} });`], { env });
    assert.equal(git(path.join(base, 'out'), 'rev-list', '--count', 'HEAD'), '1');
    assert.ok(!existsSync(path.join(base, 'hook-ran')));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('refuses export and filter attributes, which would drop, rewrite or run something on files', () => {
  for (const rule of ['README.md export-ignore', 'README.md export-subst', 'README.md filter=lfs']) {
    const { base, source } = fixture();
    try {
      writeFileSync(path.join(source, '.gitattributes'), `${rule}\n`);
      git(source, 'add', '.gitattributes');
      git(source, 'commit', '-q', '-m', 'attributes');
      assert.throws(() => buildPublicTree({ source, out: path.join(base, 'out') }), /export-/, rule);
      assert.ok(!existsSync(path.join(base, 'out')));
    } finally { rmSync(base, { recursive: true, force: true }); }
  }
});

test('the command line rejects unknown options and a missing ref', () => {
  const script = fileURLToPath(new URL('./public-tree.mjs', import.meta.url));
  for (const args of [['out', '--ref=HEAD~1'], ['out', '--verfy'], ['out', '--ref'], ['out', '--author'], ['out', 'extra'], []]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /usage:/);
  }
});

test('refuses export attributes in the repository info/attributes and ignores global ones', () => {
  const { base, source } = fixture();
  try {
    mkdirSync(path.join(source, '.git', 'info'), { recursive: true });
    writeFileSync(path.join(source, '.git', 'info', 'attributes'), 'README.md export-ignore\n');
    assert.throws(() => buildPublicTree({ source, out: path.join(base, 'out') }), /export-/);
    rmSync(path.join(source, '.git', 'info', 'attributes'));
    const home = path.join(base, 'home');
    mkdirSync(home);
    writeFileSync(path.join(home, 'attributes'), 'README.md export-ignore\n');
    writeFileSync(path.join(home, '.gitconfig'), `[core]\n\tattributesFile = ${path.join(home, 'attributes')}\n`);
    const script = fileURLToPath(new URL('./public-tree.mjs', import.meta.url));
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1' };
    execFileSync(process.execPath, ['--input-type=module', '-e', `import { buildPublicTree } from ${JSON.stringify(script)}; buildPublicTree({ source: ${JSON.stringify(source)}, out: ${JSON.stringify(path.join(base, 'out'))} });`], { env });
    assert.equal(readFileSync(path.join(base, 'out', 'README.md'), 'utf8'), 'new readme\n');
  } finally { rmSync(base, { recursive: true, force: true }); }
});
