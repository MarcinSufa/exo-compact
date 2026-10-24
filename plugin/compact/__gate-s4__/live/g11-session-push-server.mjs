import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bigFixtureFiles, COMPACT_PROMPT, coreRan, pluginDir, PROBE_FIXTURES, report, runClaudeStream, s4Stood } from './lib.mjs';

/**
 * G11 (CONTRACT S5s): after a hook compaction, a prompt's session push is answered by the session's own recall MCP
 * server over its socket (`session_push.fired=... via=server` in the notice log), not by a spawned session-push.mjs.
 * One stream-json session, so the server is up long before the third turn: fixture reads (a small session leaves the
 * seed no smaller, and native compaction takes over) with a note holding a rare id, /compact, then a question naming
 * the id. The first prompt after a cut starts the index build, so a one-word turn comes before the question.
 * --strict-mcp-config leaves plugin servers out, so the probe hands the recall server in, and an inline
 * --plugin-dir sets no CLAUDE_PLUGIN_ROOT, so `recallPluginRoot` names the plugin for the index build.
 */
const fixture = PROBE_FIXTURES.G11;
const TICKET = 'OPS-8813';
const run = await runClaudeStream({
  turns: [
    `Read files ${fixture.names.map((name) => `${name}.txt`).join(', ')} and say one short sentence about them.\nNote: the payouts canary rollback ticket is ${TICKET}, owned by the ledger team.`,
    COMPACT_PROMPT,
    'Reply with the single word ok.',
    `Which team owns ${TICKET}? Answer from what you know, in one short sentence, without tools.`,
  ],
  files: bigFixtureFiles(fixture.names, fixture.repeat),
  options: { recallPluginRoot: pluginDir() },
  settings: { permissions: { allow: ['Read', 'Read(*)'] } },
  timeoutMs: 240000,
  mcpServers: { recall: { command: 'node', args: [path.join(pluginDir(), 'recall', 'mcp-server.mjs')] } },
});

try {
  const sessionId = (run.results ?? []).map((event) => event.session_id).find(Boolean);
  let notices = '';
  if (sessionId) try { notices = await readFile(path.join(run.cwd, '.exovault', 's4-capture', String(sessionId), 'notices.log'), 'utf8'); } catch {}
  const pushLines = `${notices}\n${run.debugLog ?? ''}`.split('\n').map((line) => /session_push\.fired=.*/.exec(line)?.[0]).filter(Boolean);
  const viaServer = pushLines.filter((line) => line.includes('via=server'));
  const answer = String((run.results ?? []).at(-1)?.result ?? '');
  report('G11', [
    { name: 'the session ran four turns', pass: (run.results ?? []).length === 4, detail: `results=${(run.results ?? []).length} session=${sessionId ?? 'missing'}` },
    { name: 'S4 compaction stood (core never ran)', pass: s4Stood(run.debugLog ?? '') && !coreRan(run.debugLog ?? ''), detail: `stood=${s4Stood(run.debugLog ?? '')} coreRan=${coreRan(run.debugLog ?? '')}` },
    { name: 'a session push after the cut was answered by the recall server', pass: viaServer.length > 0, detail: pushLines.join(' | ') || 'no session_push line' },
    { name: 'the server pushed the compacted-away note', pass: viaServer.some((line) => line.startsWith('session_push.fired=1')), detail: viaServer.join(' | ') || 'none' },
    { name: 'the answer names the owning team', pass: /ledger/i.test(answer), detail: JSON.stringify(answer.slice(0, 200)) },
  ]);
} finally {
  await run.dispose();
}
