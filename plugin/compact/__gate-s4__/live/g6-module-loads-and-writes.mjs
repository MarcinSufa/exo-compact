import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { report, runClaude, sessionIdFrom } from './lib.mjs';

// Round 12: lib.mjs's default is now a single --plugin-dir (the compact plugin only), since a
// headless run cannot use the trigger plugin's own $.session.compact() call anyway (see
// sendCompact's doc comment / GATE.md's round 12 section). G6's whole point (GATE.md: "both
// plugins load without error") is unrelated to whether compaction ever fires here, so it keeps
// loading both plugins explicitly rather than inheriting the new one-plugin default.
const result = await runClaude({
  prompt: 'Read files a.txt, b.txt, and c.txt. Compare their contents and say one sentence.',
  files: Object.fromEntries(['a','b','c'].map((name) => [`${name}.txt`, `${name}: ${'module load fixture '.repeat(500)}`])),
  options: {},
  includeTriggerPlugin: true,
});
const session = sessionIdFrom(result);
const captureDir = path.join(result.cwd, '.exovault', 's4-capture', String(session ?? 'missing'));
let segments = [];
try { segments = (await readdir(captureDir)).filter((name) => name.startsWith('segment-')); } catch {}
let records = [];
for (const segment of segments) {
  try { records.push(...(await readFile(path.join(captureDir, segment), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))); } catch {}
}
// Round 8 finding 7: sourceHash is `${contentIdentity}#${occurrence}` (extractor.ts), not a bare
// 64-hex identity; the occurrence suffix keys idempotent capture for two messages that hash the
// same content identity (see CONTRACT.md's ContentWatermark note).
const valid = records.filter((record) => /^[0-9a-f]{64}#\d+$/i.test(String(record.sourceHash ?? '')));
const loadErrors = result.debugLog.match(/(?:failed to load|cannot find module|module resolution error)[^\n]*/gi) ?? [];
report('G6', [
  { name: 'plugin bundle loaded without error and Claude exited successfully', pass: loadErrors.length === 0 && result.code === 0, detail: `exit=${result.code} loadErrors=${loadErrors.length}` },
  { name: 'a capture segment exists on disk', pass: segments.length > 0, detail: `segments=${segments.length}` },
  { name: 'capture segment has a record with a 64-hex sourceHash', pass: valid.length > 0, detail: `matchingRecords=${valid.length}` },
]);
await result.dispose();
