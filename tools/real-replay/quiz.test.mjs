import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { armMemory, bootstrap, claudeArgs, jailArgs, parseJsonObject, parseStream, prefixLines, quickVerdict, RECALL_TOOL, specific, validateQuestions } from './quiz.mjs';

// The jail paths are POSIX and the stand-in claude is a shebang script, so these runs skip Windows.
const noWindows = process.platform === 'win32' ? 'POSIX jail paths and a shebang stand-in claude' : false;

const QUIZ = fileURLToPath(new URL('./quiz.mjs', import.meta.url));
const ev = (o) => JSON.stringify(o);

test('prefixLines keeps exactly the parsed events before the boundary and checks its uuid', () => {
  const text = [ev({ uuid: 'a' }), '', 'not json', ev({ uuid: 'b' }), ev({ uuid: 'B', type: 'system', subtype: 'compact_boundary' }), ev({ uuid: 'c' })].join('\n');
  assert.equal(prefixLines(text, 2, 'B'), `${ev({ uuid: 'a' })}\n${ev({ uuid: 'b' })}\n`);
  assert.throws(() => prefixLines(text, 1, 'B'), /boundary mismatch/);
});

test('armMemory points both arms at the cut transcript, and s4 gets the plugin pointer with search_session', () => {
  const cut = { sessionId: 'S1', nativeFull: 'Summary.\nread the full transcript at: /home/u/.claude/projects/p/S1.jsonl', s4Full: '## Key facts\nx\n\n## Transcript\n/home/u/old.jsonl\n\n## Recent\ny' };
  const native = armMemory(cut, 'native', '/tmp/q/S1.jsonl');
  assert.match(native, /full transcript at: \/tmp\/q\/S1\.jsonl/);
  assert.doesNotMatch(native, /\/home\/u/);
  const s4 = armMemory(cut, 's4', '/tmp/q/S1.jsonl');
  assert.match(s4, /## Transcript\n\/tmp\/q\/S1\.jsonl\n\n.*search_session.*"S1"/s);
  assert.doesNotMatch(s4, /old\.jsonl/);
  assert.match(s4, /## Recent\ny$/);
  assert.match(armMemory({ ...cut, s4Full: 'seed only' }, 's4', '/tmp/q/S1.jsonl'), /^seed only\n\n## Transcript\n\/tmp\/q\/S1\.jsonl/);
});

test('validateQuestions keeps only answerable, non-leaking questions and truly absent "none" questions', () => {
  const cands = [{ item: 'infra/gw.yaml' }, { item: 'upstreamTimeout' }];
  const pre = 'grep upstreamTimeout infra/gw.yaml';
  const whole = `${pre} later FUTUREONLY-flag`;
  const { questions, rejected } = validateQuestions([
    { type: 'value', q: 'Which file holds the gateway timeout?', gold: 'infra/gw.yaml', item: 'infra/gw.yaml' },
    { type: 'value', q: 'Is upstreamTimeout in infra/gw.yaml?', gold: 'infra/gw.yaml', item: 'infra/gw.yaml' },
    { type: 'value', q: 'Which unknown file was used?', gold: 'other.yaml', item: 'other.yaml' },
    { type: 'why', q: 'Why was the gateway timeout raised?', gold: 'Uploads were timing out.', item: 'upstreamTimeout' },
    { type: 'none', q: 'Which value did the --zz-retry flag get?', gold: 'x', absent: ['--zz-retry'] },
    { type: 'none', q: 'What did the session set FUTUREONLY-flag to?', gold: 'x', absent: ['FUTUREONLY-flag'] },
    { type: 'none', q: 'What port did the qq-proxy use?', gold: 'x', absent: ['qq-proxy'] },
    { type: 'none', q: 'What port did the rr-proxy use?', gold: 'x', absent: ['rr-proxy'] },
  ], cands, pre, whole);
  assert.deepEqual(questions.map((q) => q.type), ['value', 'why', 'none', 'none']);
  assert.deepEqual(rejected.map((r) => r.why), ['answer in question', 'item not a candidate', 'absent term occurs in session', 'too many none']);
  assert.equal(questions[2].gold, 'not in session');
});

test('specific keeps values with one right answer and drops plain words and code shards', () => {
  assert.deepEqual(['infra/gw.yaml', 'upstreamTimeout', '--max-spend 3', 'v3.5.0', 'start', ', prompt:', 'abc'].filter(specific), ['infra/gw.yaml', 'upstreamTimeout', '--max-spend 3', 'v3.5.0']);
});

test('quickVerdict decides exact values and abstentions, and leaves the rest to the judge', () => {
  assert.equal(quickVerdict({ type: 'value', gold: 'infra/gw.yaml' }, '`infra/gw.yaml`'), 'correct');
  assert.equal(quickVerdict({ type: 'value', gold: 'infra/gw.yaml' }, 'UNKNOWN'), 'abstain');
  assert.equal(quickVerdict({ type: 'none', gold: 'not in session' }, 'unknown'), 'correct');
  assert.equal(quickVerdict({ type: 'none', gold: 'not in session' }, '8443'), undefined);
  assert.equal(quickVerdict({ type: 'value', gold: 'infra/gw.yaml' }, 'infra/api.yaml'), undefined);
  assert.equal(quickVerdict({ type: 'why', gold: 'x' }, 'because y'), undefined);
});

test('open runs may read only the sandbox; s4 alone gets search_session; closed runs get no tools', () => {
  const sandbox = { home: '/tmp/q/c1/home' };
  const open = claudeArgs({ model: 'haiku', mode: 'open', arm: 's4', sandbox });
  const settings = JSON.parse(open[open.indexOf('--settings') + 1]);
  assert.ok(settings.disableAllHooks);
  assert.ok(settings.permissions.deny.includes('Read(//home/**)'));
  assert.ok(settings.permissions.allow.includes('Read(//tmp/q/c1/home/**)'));
  assert.ok(open.includes(RECALL_TOOL));
  assert.equal(JSON.parse(open[open.indexOf('--mcp-config') + 1]).mcpServers['exovault-recall'].env.HOME, '/tmp/q/c1/home');
  const native = claudeArgs({ model: 'haiku', mode: 'open', arm: 'native', sandbox });
  assert.deepEqual(JSON.parse(native[native.indexOf('--mcp-config') + 1]).mcpServers, {});
  assert.ok(!native.includes(RECALL_TOOL));
  assert.equal(open[open.indexOf('--tools') + 1], 'Bash,Read,Grep,Glob');
  const closed = claudeArgs({ model: 'haiku', mode: 'closed', arm: 's4', sandbox });
  assert.equal(closed[closed.indexOf('--tools') + 1], '');
  assert.ok(closed.includes('--strict-mcp-config'));
});

test('the jail hides home, /work and /tmp, brings back only the cut sandbox and login files, and isolates PIDs', { skip: noWindows }, () => {
  const a = jailArgs('/tmp/q/c1', '/tmp/q/c1/work-s4', '/home/u');
  const pairs = (flag) => a.flatMap((x, i) => (x === flag ? [a[i + 1]] : []));
  assert.deepEqual(pairs('--tmpfs').slice(0, 3), ['/home/u', '/work', '/tmp']);
  assert.ok(a.includes('--unshare-pid'));
  assert.ok(pairs('--bind').includes('/tmp/q/c1'));
  assert.ok(pairs('--ro-bind').some((p) => p.endsWith('/plugin/compact/recall')));
  assert.equal(a[a.indexOf('--chdir') + 1], '/tmp/q/c1/work-s4');
  // Mounts apply in order: every bind must come after the tmpfs it re-opens, or the tmpfs would hide it.
  assert.ok(a.lastIndexOf('--tmpfs') < a.indexOf('--ro-bind'));
});

test('bootstrap resamples whole cuts and returns a 95% interval', () => {
  const cut = (ok, n) => ({ verdicts: Array.from({ length: n }, (_, i) => ({ verdict: i < ok ? 'correct' : 'wrong' })) });
  assert.deepEqual(bootstrap([cut(5, 10)]), ['-', '-']);
  assert.deepEqual(bootstrap([cut(10, 10), cut(10, 10), cut(10, 10)]), ['100%', '100%']);
  const [lo, hi] = bootstrap([cut(10, 10), cut(0, 10), cut(5, 10), cut(5, 10)]).map((x) => parseInt(x, 10));
  assert.ok(lo < 50 && hi > 50 && lo >= 0 && hi <= 100);
});

test('parseStream and parseJsonObject read the CLI stream and a trailing JSON answer', () => {
  const stream = [
    ev({ type: 'system', subtype: 'init', tools: ['Read'], mcp_servers: [] }),
    ev({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep' }, { type: 'tool_use', name: RECALL_TOOL }] } }),
    ev({ type: 'result', is_error: false, result: 'Found it.\n{"1": "a {b}"}', total_cost_usd: 0.01, num_turns: 3, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } }),
  ].join('\n');
  const r = parseStream(stream);
  assert.equal(r.toolCalls, 2); assert.equal(r.inputTokens, 100); assert.equal(r.turns, 3);
  assert.deepEqual(parseJsonObject(r.text), { 1: 'a {b}' });
  // Notes after the answer quote an API error body: the answer object still wins.
  const noted = '```json\n{"1": "aef37e2", "2": "UNKNOWN"}\n```\n- **1**: Apple returned `400 {"reason":"BadWebPushTopic"}`.';
  assert.deepEqual(parseJsonObject(noted, '1'), { 1: 'aef37e2', 2: 'UNKNOWN' });
  assert.deepEqual(parseJsonObject(noted), { reason: 'BadWebPushTopic' });
  assert.deepEqual(parseJsonObject('only {"reason": "x"}', '1'), { reason: 'x' });
});

test('end to end with a fake claude: nothing from after the cut reaches a prompt, and the report is written', { skip: noWindows }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-e2e-'));
  try {
    const source = path.join(dir, 'S1.jsonl');
    const lines = [
      { type: 'user', uuid: 'u1', sessionId: 'S1', message: { role: 'user', content: 'check the gateway timeout' } },
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'grep -n upstreamTimeout infra/gw.yaml' } }] } },
      { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '41: upstreamTimeout: 37s' }] } },
      { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: 'The gateway in infra/gw.yaml waits 37 seconds.' } },
      { type: 'system', subtype: 'compact_boundary', uuid: 'B' },
      { type: 'user', uuid: 's', isCompactSummary: true, message: { role: 'user', content: 'Summary: worked on the gateway.' } },
      { type: 'assistant', uuid: 'a3', message: { role: 'assistant', content: 'SECRET-FUTURE-MARKER: raising upstreamTimeout in infra/gw.yaml' } },
    ];
    fs.writeFileSync(source, lines.map(ev).join('\n') + '\n');
    const dump = path.join(dir, 'dump'); fs.mkdirSync(dump);
    fs.writeFileSync(path.join(dump, 'cut-S1-01.json'), ev({
      id: 'S1-01', source, boundaryUuid: 'B', boundaryLine: 4, sessionId: 'S1',
      native: 'Summary: worked on the gateway.', nativeFull: 'Summary: worked on the gateway.\nread the full transcript at: /home/u/.claude/projects/p/S1.jsonl', s4Full: '## Key facts\n- gateway timeout checked',
      items: ['infra/gw.yaml', 'upstreamTimeout', 'upstreamTimeout: 37s', 'gw-a'].map((item) => ({ item, context: `SECRET-FUTURE-MARKER uses ${item}` })),
    }));
    const fake = path.join(dir, 'fake-claude.mjs');
    const log = path.join(dir, 'calls.jsonl');
    fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
let input = ''; process.stdin.on('data', (d) => { input += d; }).on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), input }) + '\\n');
  let result;
  if (input.includes('You write a memory quiz')) result = JSON.stringify({ questions: [
    { type: 'value', q: 'Which file holds the gateway timeout?', gold: 'infra/gw.yaml', item: 'infra/gw.yaml' },
    { type: 'why', q: 'Why look at the gateway setting?', gold: 'To check the timeout.', item: 'upstreamTimeout' },
    { type: 'none', q: 'Which port did the qq-proxy use?', gold: 'x', absent: ['qq-proxy'] } ] });
  else if (input.includes('Grade each answer')) result = JSON.stringify(Object.fromEntries([...input.matchAll(/^\\s+Answer: (.*)$/gm)].map((m, i) => [String(i + 1), m[1].includes('8080') ? 'wrong' : 'correct'])));
  else if (process.argv.includes('Bash,Read,Grep,Glob')) result = 'Looked it up.\\n{"1": "infra/gw.yaml", "2": "to check the timeout", "3": "UNKNOWN"}';
  else result = '{"1": "UNKNOWN", "2": "UNKNOWN", "3": "port 8080"}';
  const out = [{ type: 'system', subtype: 'init', tools: [] }, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep' }] } },
    { type: 'result', is_error: false, result, total_cost_usd: 0.001, num_turns: 2, usage: { input_tokens: 100, output_tokens: 10 } }];
  process.stdout.write(out.map((x) => JSON.stringify(x)).join('\\n') + '\\n');
});
`);
    fs.chmodSync(fake, 0o755);
    const out = path.join(dir, 'out');
    const run = spawnSync(process.execPath, ['--experimental-strip-types', QUIZ, dump, '--out', out, '--all', '--cleanup'], {
      encoding: 'utf8', env: { ...process.env, QUIZ_CLAUDE: fake, QUIZ_SANDBOX: path.join(dir, 'sandbox'), QUIZ_JOBS: '2', QUIZ_JAIL: '0', QUIZ_VECTORS: '0' },
    });
    assert.equal(run.status, 0, run.stderr);
    // No npm install from the network inside a unit test: it failed CI on a registry hiccup (Node 22.15, 2026-10-23).
    assert.ok(!fs.existsSync(path.join(dir, 'sandbox', '.recall-runtime')), 'the test installs no vector runtime');
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(calls.length, 1 + 4 + 4, 'gen, 2 arms x 2 modes, and a judge call per arm/mode for the why question');
    const answering = calls.filter((c) => c.input.includes('<context-after-compaction>'));
    assert.equal(answering.length, 4);
    for (const c of answering) {
      assert.doesNotMatch(c.input, /SECRET-FUTURE-MARKER/);
      assert.doesNotMatch(c.input, /\/home\/u\//);
      assert.ok(c.cwd.startsWith(path.join(dir, 'sandbox')));
    }
    assert.doesNotMatch(calls[0].input, /SECRET-FUTURE-MARKER: raising/, 'evidence for the generator comes from before the cut only');
    const report = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
    assert.match(report, /\| native \| closed \| all \| 3 \| 0\.0% \(---\) \| 33\.3% \| 66\.7% \| 1\/1 \|/);
    assert.match(report, /\| s4 \| open \| all \| 3 \| 100\.0% \(---\) \| 0\.0% \| 0\.0% \| 0\/1 \|/);
    assert.ok(!fs.existsSync(path.join(dir, 'sandbox', 'S1-01')), '--cleanup removes the transcript copy');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the s4tree arm answers from its own work dir, and a CLI that cannot start fails one job instead of the run', { skip: noWindows }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-tree-e2e-'));
  try {
    const source = path.join(dir, 'S1.jsonl');
    fs.writeFileSync(source, [
      { type: 'user', uuid: 'u1', sessionId: 'S1', message: { role: 'user', content: 'check infra/gw.yaml' } },
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: 'infra/gw.yaml waits 37 seconds.' } },
      { type: 'system', subtype: 'compact_boundary', uuid: 'B' },
    ].map(ev).join('\n') + '\n');
    const dump = path.join(dir, 'dump'); fs.mkdirSync(dump);
    fs.writeFileSync(path.join(dump, 'cut-S1-01.json'), ev({ id: 'S1-01', source, boundaryUuid: 'B', boundaryLine: 2, sessionId: 'S1', s4Full: '## Key facts\n- gateway', items: [] }));
    const trees = path.join(dir, 'trees'); fs.mkdirSync(trees);
    fs.writeFileSync(path.join(trees, 'cut-S1-01.view.txt'), '[n1 L0 user] check infra/gw.yaml');
    const out = path.join(dir, 'out'); fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'S1-01.questions.json'), ev([{ type: 'value', q: 'Which file?', gold: 'infra/gw.yaml', item: 'infra/gw.yaml' }]));
    const log = path.join(dir, 'calls.jsonl');
    const fake = path.join(dir, 'fake-claude.mjs');
    fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
let input = ''; process.stdin.on('data', (d) => { input += d; }).on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), input }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: '{"1": "infra/gw.yaml"}', total_cost_usd: 0.001, num_turns: 1, usage: {} }) + '\\n');
});
`);
    fs.chmodSync(fake, 0o755);
    const env = { ...process.env, QUIZ_SANDBOX: path.join(dir, 'sandbox'), QUIZ_TREE_DIR: trees, QUIZ_JOBS: '1', QUIZ_JAIL: '0', QUIZ_VECTORS: '0' };
    const args = ['--experimental-strip-types', QUIZ, dump, '--out', out, '--arms', 's4,s4tree', '--answer', 'closed'];
    const missing = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...env, QUIZ_CLAUDE: path.join(dir, 'no-such-claude') } });
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(missing.stdout, /S1-01 s4tree closed: FAILED/);
    const run = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...env, QUIZ_CLAUDE: fake } });
    assert.equal(run.status, 0, run.stderr);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const tree = calls.filter((c) => c.input.includes('## Session tree'));
    assert.equal(tree.length, 1);
    assert.equal(path.basename(tree[0].cwd), 'work-s4tree');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
