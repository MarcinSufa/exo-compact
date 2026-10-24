import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { collect, render } from './status.mjs';

function write(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));
}

test('classifies S4 and native compactions, fallbacks, recall use and headless runs', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exo-status-'));
  const at = (m) => `2026-09-28T10:${String(m).padStart(2, '0')}:00.000Z`;
  const boundary = (m, durationMs) => ({ type: 'system', subtype: 'compact_boundary', timestamp: at(m), compactMetadata: { trigger: 'auto', preTokens: 217000, postTokens: 12000, durationMs } });
  write(path.join(home, '.claude/projects/p/s4sess.jsonl'), [
    { type: 'user', cwd: `${home}/repo`, entrypoint: 'cli', timestamp: at(0), message: { content: 'hi' } },
    boundary(1, 300),
    { type: 'user', timestamp: at(1), message: { content: '[[exovault:s4-seed:v1]]\n## Constraints' } },
    { type: 'assistant', timestamp: at(2), message: { content: [{ type: 'tool_use', name: 'mcp__plugin_exovault-s4-compact_exovault-recall__search_session' }] } },
    boundary(3, 66000),
    { type: 'user', timestamp: at(3), isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation' } },
  ]);
  write(path.join(home, '.claude/projects/p/headless.jsonl'), [{ type: 'user', cwd: `${home}/repo`, entrypoint: 'sdk-cli', timestamp: at(0) }]);
  write(path.join(home, '.claude/projects/p/plain.jsonl'), [{ type: 'user', cwd: '/elsewhere', entrypoint: 'cli', timestamp: at(0) }]);
  for (const id of ['s4sess', 'headless']) fs.mkdirSync(path.join(home, '.exovault/s4-capture', id), { recursive: true });

  const sessions = await collect({ home });
  assert.deepEqual(sessions.map((s) => s.id), ['s4sess']);
  assert.deepEqual(sessions[0].compactions.map((c) => c.kind), ['s4', 'native']);
  assert.equal(sessions[0].recallCalls, 1);
  const text = render(sessions, home);
  assert.match(text, /S4 fell back to native/);
  assert.match(text, /S4 compactions: 1, native fallbacks: 1 \(1 after an S4 cut\)/);

  assert.equal((await collect({ home, headless: true })).length, 2);
  assert.equal((await collect({ home, all: true, headless: true })).length, 3);
});

test('reads transcripts from CLAUDE_CONFIG_DIR when set, and from USERPROFILE when HOME is unset', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exo-status-cfg-'));
  const at = '2026-09-28T10:00:00.000Z';
  const home = path.join(root, 'home');
  const cfg = path.join(root, 'cfg');
  write(path.join(cfg, 'projects/p/inCfg.jsonl'), [{ type: 'user', cwd: `${home}/repo`, entrypoint: 'cli', timestamp: at, message: { content: 'hi' } }]);
  fs.mkdirSync(path.join(home, '.exovault/s4-capture/inCfg'), { recursive: true });
  const now = Date.parse(at) + 3600_000;
  assert.deepEqual((await collect({ home, now, env: { CLAUDE_CONFIG_DIR: cfg } })).map((s) => s.id), ['inCfg']);
  assert.deepEqual(await collect({ home, now, env: {} }), []);
  // No HOME: the default home is USERPROFILE (the same chain the plugin uses).
  write(path.join(home, '.claude/projects/p/inProfile.jsonl'), [{ type: 'user', cwd: `${home}/repo`, entrypoint: 'cli', timestamp: at, message: { content: 'hi' } }]);
  fs.mkdirSync(path.join(home, '.exovault/s4-capture/inProfile'), { recursive: true });
  assert.deepEqual((await collect({ now, env: { USERPROFILE: home } })).map((s) => s.id), ['inProfile']);
});

test('the empty message does not suggest a flag that was already given', () => {
  assert.match(render([]), /--all to list every session, --headless to include -p \/ SDK runs, --days N/);
  const withAll = render([], undefined, { all: true });
  assert.doesNotMatch(withAll, /--all/);
  assert.match(withAll, /--headless to include -p \/ SDK runs, --days N/);
  const both = render([], undefined, { all: true, headless: true });
  assert.doesNotMatch(both, /--all|--headless/);
  assert.match(both, /--days N/);
});

test('lists a claude-vscode capture without --headless and keeps an sdk-cli capture behind it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exo-status-ext-'));
  const at = '2026-09-28T10:00:00.000Z';
  write(path.join(home, '.claude/projects/p/vscode-sess.jsonl'), [{ type: 'user', cwd: `${home}/repo`, entrypoint: 'claude-vscode', timestamp: at, message: { content: 'hi' } }]);
  write(path.join(home, '.claude/projects/p/sdk-sess.jsonl'), [{ type: 'user', cwd: `${home}/repo`, entrypoint: 'sdk-cli', timestamp: '2026-09-28T09:00:00.000Z', message: { content: 'hi' } }]);
  fs.mkdirSync(path.join(home, '.exovault/s4-capture/vscode-sess'), { recursive: true });
  fs.mkdirSync(path.join(home, '.exovault/s4-capture/sdk-sess'), { recursive: true });
  assert.deepEqual((await collect({ home })).map((s) => s.id).sort(), ['vscode-sess']);
  assert.deepEqual((await collect({ home, headless: true })).map((s) => s.id).sort(), ['sdk-sess', 'vscode-sess']);
});

test('an sdk-cli capture stays hidden unless --headless', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exo-status-sdk-'));
  const at = '2026-09-28T10:00:00.000Z';
  write(path.join(home, '.claude/projects/p/sdk-only.jsonl'), [{ type: 'user', cwd: `${home}/repo`, entrypoint: 'sdk-cli', timestamp: at, message: { content: 'hi' } }]);
  fs.mkdirSync(path.join(home, '.exovault/s4-capture/sdk-only'), { recursive: true });
  assert.deepEqual((await collect({ home })).map((s) => s.id), []);
  assert.deepEqual((await collect({ home, headless: true })).map((s) => s.id), ['sdk-only']);
});

test('puts the notices.log fallback reason on the matching native compaction', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exo-status-reason-'));
  const at = (m, s = 0) => `2026-09-28T10:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;
  const boundary = (m) => ({ type: 'system', subtype: 'compact_boundary', timestamp: at(m), compactMetadata: { trigger: 'auto', preTokens: 217000, postTokens: 12000, durationMs: 300 } });
  const native = (m) => ({ type: 'user', timestamp: at(m), isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation' } });
  write(path.join(home, '.claude/projects/p/reason-sess.jsonl'), [
    { type: 'user', cwd: `${home}/repo`, entrypoint: 'cli', timestamp: at(0), message: { content: 'hi' } },
    boundary(1),
    native(1),
    boundary(5),
    native(5),
    boundary(8),
    native(8),
  ]);
  const capture = path.join(home, '.exovault/s4-capture/reason-sess');
  fs.mkdirSync(capture, { recursive: true });
  fs.writeFileSync(path.join(capture, 'notices.log'), [
    `${at(0, 30)} compact.fallback=error origin=compact`,
    `${at(2)} compact.fallback=error origin=compact`,
    `${at(3)} compact.sizeBefore=10`,
    `${at(4)} compact.fallback=budget origin=compact`,
    `${at(9)} compact.fallback=refusal_guard origin=compact`,
    '',
  ].join('\n'));

  const sessions = await collect({ home });
  assert.equal(sessions.length, 1);
  const compactions = sessions[0].compactions;
  assert.equal(compactions.length, 3);
  assert.equal(compactions[0].reason, 'error');
  assert.equal(compactions[1].reason, 'budget');
  assert.equal(compactions[2].reason ?? null, null);

  const rows = render(sessions, home).split('\n').filter((line) => line.includes('compact ') && line.includes('native'));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].includes('error'), true);
  assert.equal(rows[0].includes('budget'), false);
  assert.equal(rows[1].includes('budget'), true);
  assert.equal(rows[1].includes('error'), false);
  assert.equal(rows[2].includes('budget'), false);
  assert.equal(rows[2].includes('error'), false);
  assert.equal(rows[2].includes('refusal_guard'), false);
});

test('takes the latest fallback line when a session has two capture dirs', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exo-status-two-dir-'));
  const at = (m, s = 0) => `2026-09-28T10:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;
  const boundary = (m) => ({ type: 'system', subtype: 'compact_boundary', timestamp: at(m), compactMetadata: { trigger: 'auto', preTokens: 217000, postTokens: 12000, durationMs: 300 } });
  const native = (m) => ({ type: 'user', timestamp: at(m), isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation' } });
  const cwd = path.join(home, 'repo');
  const session = 'two-dir-sess';
  write(path.join(home, '.claude/projects/p', `${session}.jsonl`), [
    { type: 'user', cwd, entrypoint: 'cli', timestamp: at(0), message: { content: 'hi' } },
    boundary(5),
    native(5),
  ]);
  const homeCapture = path.join(home, '.exovault/s4-capture', session);
  const projectCapture = path.join(cwd, '.exovault/s4-capture', session);
  fs.mkdirSync(homeCapture, { recursive: true });
  fs.mkdirSync(projectCapture, { recursive: true });
  fs.writeFileSync(path.join(homeCapture, 'notices.log'), [
    `${at(4)} compact.fallback=budget origin=compact`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(projectCapture, 'notices.log'), [
    `${at(2)} compact.fallback=error origin=compact`,
    '',
  ].join('\n'));

  const sessions = await collect({ home });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].captureDirs.length, 2);
  const compactions = sessions[0].compactions;
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].reason, 'budget');
});

test('on Windows a capture dir reached twice with a different drive-letter case is one dir, and both shorten to ~', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'exo-status-case-'));
  // On Windows Home and home are the same folder; here they are two, so both exist as they would there.
  const home = path.join(base, 'Home');
  const cwd = path.join(base, 'home', 'repo');
  const session = 'case-sess';
  write(path.join(home, '.claude/projects/p', `${session}.jsonl`), [
    { type: 'user', cwd, entrypoint: 'claude-vscode', timestamp: '2026-09-28T10:00:00.000Z', message: { content: 'hi' } },
  ]);
  fs.mkdirSync(path.join(home, '.exovault/s4-capture', session), { recursive: true });
  fs.mkdirSync(path.join(base, 'home', '.exovault/s4-capture', session), { recursive: true });

  const sessions = await collect({ home, platform: 'win32', now: Date.parse('2026-09-28T11:00:00.000Z') });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].captureDirs.length, 1);
  const text = render(sessions, home, { platform: 'win32' });
  assert.doesNotMatch(text, /split across dirs/);
  assert.match(text, /~[\\/]repo/); // the real Windows path keeps its separator
  assert.match(text, /in ~[\\/]\.exovault[\\/]s4-capture[\\/]case-sess/);
  assert.equal((await collect({ home, now: Date.parse('2026-09-28T11:00:00.000Z') }))[0].captureDirs.length, process.platform === 'win32' ? 1 : 2);
});

test('a fallback for a too-short session shows the message tokens S4 saw, what it would have left, and says it is expected', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exo-status-short-'));
  const at = (m) => `2026-09-28T10:${String(m).padStart(2, '0')}:00.000Z`;
  const session = 'short-sess';
  const cwd = path.join(home, 'repo');
  write(path.join(home, '.claude/projects/p', `${session}.jsonl`), [
    { type: 'user', cwd, entrypoint: 'cli', timestamp: at(0), message: { content: 'hi' } },
    { type: 'system', subtype: 'compact_boundary', timestamp: at(5), compactMetadata: { trigger: 'manual', preTokens: 76000, postTokens: 12000, durationMs: 300 } },
    { type: 'user', timestamp: at(5), isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation' } },
    { type: 'system', subtype: 'compact_boundary', timestamp: at(9), compactMetadata: { trigger: 'manual', preTokens: 80000, postTokens: 13000, durationMs: 300 } },
    { type: 'user', timestamp: at(9), isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation' } },
  ]);
  const capture = path.join(home, '.exovault/s4-capture', session);
  fs.mkdirSync(capture, { recursive: true });
  fs.writeFileSync(path.join(capture, 'notices.log'), [
    `${at(4)} compact.sizeBefore=7510`,
    `${at(4)} compact.fallback=insufficient_reduction origin=compact sizeAfter=6120`,
    // A line from before 4.8.0 has no sizeAfter.
    `${at(8)} compact.sizeBefore=8020`,
    `${at(8)} compact.fallback=insufficient_reduction origin=compact`,
    '',
  ].join('\n'));

  const sessions = await collect({ home, now: Date.parse('2026-09-28T11:00:00.000Z') });
  assert.equal(sessions[0].compactions[0].sizeBefore, 7510);
  assert.equal(sessions[0].compactions[0].sizeAfter, 6120);
  const lines = render(sessions, home).split('\n').filter((line) => line.includes('reason=insufficient_reduction'));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /76k -> 12k .*reason=insufficient_reduction \(S4: 7.5k message tokens -> 6.1k, under the 25% cut; too short a session, expected\)/);
  assert.match(lines[1], /reason=insufficient_reduction \(S4: 8.0k message tokens, under the 25% cut; too short a session, expected\)/);
  // S4 declined both cuts before it ever cut, so they count as fallbacks, none of them after an S4 cut.
  assert.match(render(sessions, home), /S4 compactions: 0, native fallbacks: 2 \(0 after an S4 cut\)/);
});
