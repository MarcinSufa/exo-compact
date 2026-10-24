// Hidden-test verification for task A/B runs. A task is a real request from a session that ended in a commit with
// tests: the agent works from the commit's parent, then the commit's test files are copied over its work and run.
// The reward is the share of those test cases that pass. `selfCheck` keeps only tasks whose tests fail on the parent
// and pass on the commit (the "fail first" rule), so a reward measures the work, not the test setup.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// NODE_TEST_CONTEXT is dropped so a `node --test` child reports TAP even when this runs under a test runner.
const { NODE_TEST_CONTEXT: _testContext, ...baseEnv } = process.env;
const run = (cmd, args, cwd, timeout = 600_000) => spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 << 20, env: { ...baseEnv, CI: '1', FORCE_COLOR: '0' } });
const git = (cwd, ...args) => {
  const r = run('git', args, cwd);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${String(r.stderr ?? r.error ?? '').trim()}`);
  return r.stdout.trim();
};

/**
 * A standalone repository holding `rev` and its history only: no later commit, no alternates pointing at the
 * source, no remote. This is what an agent works in, so `git log --all` cannot show it the answer.
 */
export function isolatedCheckout(repo, rev, dir, depth = 200) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const sha = git(repo, 'rev-parse', '--verify', `${rev}^{commit}`);
  git(dir, 'init', '-q');
  git(dir, 'fetch', '-q', `--depth=${depth}`, `file://${repo}`, sha);
  git(dir, '-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', 'FETCH_HEAD');
  return dir;
}

/** A clone that borrows the source repository's objects and leaves the source untouched, checked out at `rev`. */
export function checkout(repo, rev, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(path.dirname(dir), 'clone', '-q', '--shared', '--no-checkout', repo, dir);
  git(dir, '-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', rev);
  return dir;
}

/** Installs dependencies offline from the local store, the way the repository's lockfile says. */
export function install(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  const r = has('pnpm-lock.yaml') ? run('pnpm', ['install', '--offline', '--frozen-lockfile', '--reporter=silent'], dir)
    : has('package-lock.json') ? run('npm', ['ci', '--offline', '--no-audit', '--no-fund', '--loglevel=error'], dir)
      : { status: 0 };
  if (r.status !== 0) throw new Error(`install failed in ${dir}: ${(r.stderr || r.stdout || '').slice(-400)}`);
  return build(dir);
}

/**
 * Workspace packages resolve each other through their built output, so a pnpm workspace is built. A failed build
 * is not fatal (the agent's work may not compile, and some parents did not): it is reported, and tests run anyway.
 */
export function build(dir) {
  if (!fs.existsSync(path.join(dir, 'pnpm-workspace.yaml')) || !JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts?.build) return { built: 'n/a' };
  const r = run('pnpm', ['-r', '--no-bail', '--workspace-concurrency=4', 'build'], dir);
  return r.status === 0 ? { built: 'ok' } : { built: 'failed', buildError: (r.stderr || r.stdout || '').slice(-400) };
}

const packageDir = (root, file) => {
  for (let d = path.dirname(path.join(root, file)); d.startsWith(root); d = path.dirname(d)) if (fs.existsSync(path.join(d, 'package.json'))) return d;
  return root;
};

/** Runs one test file and returns its cases by name: node:test files with `node --test`, everything else with vitest. */
export function runTestFile(root, file) {
  const abs = path.join(root, file);
  if (/\.(json|snap)$/.test(file)) return null;
  if (!fs.existsSync(abs)) return { file, cases: {}, error: 'missing' };
  const cases = {};
  if (/from ['"]node:test['"]/.test(fs.readFileSync(abs, 'utf8'))) {
    const r = run(process.execPath, ['--experimental-strip-types', '--no-warnings', '--test', '--test-reporter=tap', abs], root);
    const stack = [];
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^( *)(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO).*)?$/);
      if (!m) { const sub = line.match(/^( *)# Subtest: (.*)$/); if (sub) stack[sub[1].length / 4] = sub[2]; continue; }
      const depth = m[1].length / 4;
      stack.length = depth + 1; stack[depth] = m[3];
      const name = stack.join(' > ');
      if (!Object.keys(cases).some((k) => k.startsWith(`${name} > `))) cases[name] = m[2] === 'ok';
    }
    for (const k of Object.keys(cases)) if (Object.keys(cases).some((o) => o.startsWith(`${k} > `))) delete cases[k];
    return { file, cases, ...(Object.keys(cases).length ? {} : { error: (r.stderr || r.stdout).slice(-300) }) };
  }
  const cwd = packageDir(root, file), out = path.join(root, `.task-ab-${path.basename(file)}.json`);
  const r = run('npx', ['vitest', 'run', path.relative(cwd, abs), '--reporter=json', `--outputFile=${out}`], cwd);
  try {
    const j = JSON.parse(fs.readFileSync(out, 'utf8'));
    for (const t of j.testResults ?? []) for (const a of t.assertionResults ?? []) if (a.status !== 'skipped' && a.status !== 'pending') cases[a.fullName] = a.status === 'passed';
    return { file, cases, ...(Object.keys(cases).length ? {} : { error: (j.testResults?.[0]?.message || 'no tests ran').slice(-300) }) };
  } catch { return { file, cases, error: (r.stderr || r.stdout || '').slice(-300) }; } finally { fs.rmSync(out, { force: true }); }
}

/** Copies the commit's test files over the work in `dir` and runs them: `{ file: { case: passed } }`. */
export function runHidden(task, dir) {
  for (const t of task.tests) {
    const r = spawnSync('git', ['-C', task.repo, 'show', `${task.commit}:${t}`], { maxBuffer: 64 << 20 });
    if (r.status !== 0) continue; // a test file a later commit of the same request removed
    fs.mkdirSync(path.dirname(path.join(dir, t)), { recursive: true });
    fs.writeFileSync(path.join(dir, t), r.stdout);
  }
  const out = {};
  for (const f of task.tests.map((t) => runTestFile(dir, t)).filter(Boolean)) for (const [k, v] of Object.entries(f.cases)) out[`${f.file} :: ${k}`] = v;
  return out;
}

/**
 * Scores a run against the task's `target` (cases that fail on the parent and pass on the commit) and `keep` (cases
 * that pass on both). reward = share of target cases that pass; regressions = keep cases that now fail or are gone.
 */
export function score(task, cases) {
  const passed = task.target.filter((k) => cases[k] === true).length;
  const regressions = task.keep.filter((k) => cases[k] !== true);
  return { reward: task.target.length ? passed / task.target.length : 0, passed, target: task.target.length, regressions: regressions.length, solved: passed === task.target.length && !regressions.length };
}

/** Fail-first check without any model: fixes `target` and `keep` for the task, or says why it cannot be used. */
export function selfCheck(task, work) {
  const at = (rev, name) => {
    const dir = checkout(task.repo, rev, path.join(work, name));
    const b = install(dir);
    return { ...b, cases: runHidden(task, dir) };
  };
  const base = at(task.base, 'base'), done = at(task.commit, 'done');
  const target = Object.keys(done.cases).filter((k) => done.cases[k] && !base.cases[k]);
  const keep = Object.keys(done.cases).filter((k) => done.cases[k] && base.cases[k]);
  const failingOnDone = Object.keys(done.cases).filter((k) => !done.cases[k]);
  const why = !Object.keys(done.cases).length ? 'no test cases ran on the commit' : failingOnDone.length ? `${failingOnDone.length} cases fail on the commit` : !target.length ? 'no case fails on the parent' : '';
  return { ok: !why, why, target, keep, built: { base: base.built, done: done.built } };
}
