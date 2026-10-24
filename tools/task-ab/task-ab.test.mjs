import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { askLine, cutFor, report, sinceCut, taskPrompt } from './task-ab.mjs';
import { isolatedCheckout, score, selfCheck } from './verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sh = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const line = (o) => JSON.stringify(o);
const user = (text, ts) => line({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const said = (text) => line({ type: 'assistant', message: { role: 'assistant', model: 'claude-test-1', content: [{ type: 'text', text }] } });

/** A repository whose second commit adds `twice` and its test, and a session that asked for it after one compaction. */
function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'taskab-'));
  const repo = path.join(temp, 'repo');
  fs.mkdirSync(repo);
  sh(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'lib.mjs'), 'export const once = (x) => x;\n');
  fs.writeFileSync(path.join(repo, 'lib.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { once } from './lib.mjs';\ntest('once', () => assert.equal(once(2), 2));\n");
  sh(repo, 'add', '-A'); sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  const base = sh(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'lib.mjs'), 'export const once = (x) => x;\nexport const twice = (x) => 2 * x;\n');
  fs.writeFileSync(path.join(repo, 'lib.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport * as lib from './lib.mjs';\ntest('once', () => assert.equal(lib.once(2), 2));\ntest('twice', () => assert.equal(lib.twice(2), 4));\n");
  sh(repo, 'add', '-A'); sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'add twice');
  const commit = sh(repo, 'rev-parse', 'HEAD');
  const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
  const transcript = path.join(temp, `${sessionId}.jsonl`);
  const lines = [user('we will need a doubling helper in lib.mjs called twice', '2026-10-01T10:00:00Z'), said('Noted: twice(x) in lib.mjs.'),
    line({ type: 'system', subtype: 'compact_boundary', uuid: 'b1' }), line({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'summary' } }),
    said('Back after the compaction.'), user('ok add it now please, with the name we agreed', '2026-10-01T11:00:00Z'), said('Done.')];
  fs.writeFileSync(transcript, `${lines.join('\n')}\n`);
  const dump = path.join(temp, 'dump');
  fs.mkdirSync(dump);
  fs.writeFileSync(path.join(dump, 'cut-aaaaaaaa-01.json'), line({ id: 'aaaaaaaa-01', sessionId, source: transcript, boundaryLine: 2, boundaryUuid: 'b1',
    native: 'NATIVE SUMMARY: the helper is called twice', nativeFull: 'NATIVE SUMMARY: the helper is called twice', s4Full: 'S4 SEED: helper twice(x) in lib.mjs' }));
  const task = { id: commit.slice(0, 8), repo, base, commit, tests: ['lib.test.mjs'], ask: 'ok add it now please, with the name we agreed', askTs: '2026-10-01T11:00:00Z', transcript, cwd: repo, cutsBefore: 1 };
  return { temp, repo, base, commit, transcript, dump, task, lines };
}

test('selfCheck finds the target and kept cases; score counts them', () => {
  const f = fixture();
  try {
    const r = selfCheck(f.task, path.join(f.temp, 'sc'));
    assert.equal(r.ok, true, r.why);
    assert.deepEqual(r.target, ['lib.test.mjs :: twice']);
    assert.deepEqual(r.keep, ['lib.test.mjs :: once']);
    const task = { ...f.task, target: r.target, keep: r.keep };
    assert.deepEqual(score(task, { 'lib.test.mjs :: twice': true, 'lib.test.mjs :: once': true }), { reward: 1, passed: 1, target: 1, regressions: 0, solved: true });
    assert.equal(score(task, { 'lib.test.mjs :: twice': true }).solved, false);
  } finally { fs.rmSync(f.temp, { recursive: true, force: true }); }
});

test('isolatedCheckout holds the parent and its history, but not the answer', () => {
  const f = fixture();
  try {
    const dir = isolatedCheckout(f.repo, f.base, path.join(f.temp, 'iso'));
    assert.equal(sh(dir, 'rev-parse', 'HEAD'), f.base);
    assert.notEqual(spawnSync('git', ['cat-file', '-t', f.commit], { cwd: dir }).status, 0);
    assert.equal(sh(dir, 'remote'), '');
    assert.equal(fs.existsSync(path.join(dir, '.git', 'objects', 'info', 'alternates')), false);
  } finally { fs.rmSync(f.temp, { recursive: true, force: true }); }
});

test('the request is placed after the right compaction, with only the conversation since it', () => {
  const f = fixture();
  try {
    const ask = askLine(f.lines, f.task);
    assert.equal(ask, 5);
    assert.equal(cutFor([{ sessionId: 's', boundaryLine: 2 }, { sessionId: 's', boundaryLine: 9 }, { sessionId: 'x', boundaryLine: 4 }], 's', 5).boundaryLine, 2);
    const since = sinceCut(f.lines, 2, ask);
    assert.equal(since, 'Assistant: Back after the compaction.');
    assert.equal(sinceCut([...f.lines.slice(0, 5), said('x'.repeat(400)), ...f.lines.slice(5)], 2, 6, 105), `[1 earlier events since the compaction are not shown]\nAssistant: ${'x'.repeat(400)}`);
    const p = taskPrompt('MEMORY', since, f.task.ask);
    assert.ok(p.indexOf('MEMORY') < p.indexOf('Back after') && p.indexOf('Back after') < p.indexOf('with the name we agreed'));
  } finally { fs.rmSync(f.temp, { recursive: true, force: true }); }
});

test('end to end with a stand-in claude: each arm gets its own memory, work is verified, report gates', { skip: process.platform === 'win32' ? 'the stand-in claude is a shebang script found through bash' : false }, () => {
  const f = fixture();
  try {
    const sc = selfCheck(f.task, path.join(f.temp, 'sc'));
    const tasksFile = path.join(f.temp, 'tasks.json');
    fs.writeFileSync(tasksFile, JSON.stringify([{ ...f.task, usable: true, target: sc.target, keep: sc.keep }]));
    // Writes the helper only when its memory names it, and records which memory it saw.
    const fake = path.join(f.temp, 'fake-claude.mjs');
    fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
let input = ''; process.stdin.on('data', (d) => { input += d; }).on('end', () => {
  fs.appendFileSync(${JSON.stringify(path.join(f.temp, 'seen.txt'))}, (input.includes('S4 SEED') ? 's4' : input.includes('NATIVE SUMMARY') ? 'native' : '?') + (process.argv.includes('mcp__exovault-recall__search_session') ? '+recall' : '') + '\\n');
  if (input.includes('S4 SEED')) fs.writeFileSync('lib.mjs', 'export const once = (x) => x;\\nexport const twice = (x) => 2 * x;\\n');
  else fs.writeFileSync('lib.mjs', 'export const twice = (x) => 2 * x;\\n');
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } }));
  console.log(JSON.stringify({ type: 'result', is_error: false, result: 'done', total_cost_usd: 0.5, num_turns: 3, duration_ms: 10, usage: { input_tokens: 1000, cache_read_input_tokens: 9000, output_tokens: 50 } }));
});
`);
    fs.chmodSync(fake, 0o755);
    const out = path.join(f.temp, 'out');
    const run = (...extra) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(here, 'task-ab.mjs'), tasksFile, '--dump', f.dump, '--out', out, '--reps', '1', ...extra],
      { encoding: 'utf8', env: { ...process.env, TASKAB_CLAUDE: fake, TASKAB_JAIL: '0', TASKAB_SANDBOX: path.join(f.temp, 'sandbox') } });
    const r = run('--run');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /native #1: reward 100% regressions 1/);
    assert.match(r.stdout, /s4 #1: SOLVED regressions 0/);
    assert.deepEqual(fs.readFileSync(path.join(f.temp, 'seen.txt'), 'utf8').trim().split('\n').sort(), ['native', 's4+recall']);
    assert.equal(sh(f.repo, 'rev-parse', 'HEAD'), f.commit, 'the source repository is untouched');
    const rec = JSON.parse(fs.readFileSync(path.join(out, `${f.task.id}.s4.1.json`), 'utf8'));
    assert.equal(rec.inputTokens, 10000); assert.equal(rec.changed, 1);
    const rep = run('--report');
    assert.match(rep.stdout, /\| native \| 1 \| 1 \| 0\.0% \| 100\.0% \| 1\.00 \|/);
    assert.match(rep.stdout, /\| s4 \| 1 \| 1 \| 100\.0% \| 100\.0% \| 0\.00 \|/);
    assert.match(report([]), /# Task A\/B/);
  } finally { fs.rmSync(f.temp, { recursive: true, force: true }); }
});
