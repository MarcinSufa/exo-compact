import { readFile } from 'node:fs/promises';
import { bigFixtureFiles, report, runClaude, sendCompact, sessionIdFrom, transcriptEntries } from './lib.mjs';

/**
 * G7 (spec §5.1): after a hook compaction, the transcript file named in the seed (spec §3.1.2's
 * pointer, opening section 7) still holds the omitted history, and a Grep for a fact placed only
 * before the cut finds it. Style follows g6-module-loads-and-writes.mjs (one call, script-side
 * checks against the debug log and the on-disk transcript, no second turn needed: the property
 * under test is that the file is there and greppable, not that the model chooses to grep it).
 */
const SEED_SENTINEL = '[[exovault:s4-seed:v1]]';
const FACT = 'CRIMSON-YETI-509';

// Headless: the soft trigger rejects under -p (GATE.md round 12), so the hook compaction is a
// scripted /compact into the same session, as in G1.
const result = await runClaude({
  prompt: 'Read files a.txt, b.txt, c.txt, d.txt, and e.txt. Compare their contents and say one short sentence.',
  files: bigFixtureFiles(['a', 'b', 'c', 'd', 'e'], 900, ` ${FACT}`),
  options: {},
});

const session = sessionIdFrom(result);
const compacted = session ? await sendCompact({ sessionId: session, projectDir: result.cwd, options: {} }) : undefined;
const entries = await transcriptEntries(session);

function messageText(entry) {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n');
  return '';
}

const seedEntry = entries.find((entry) => messageText(entry).includes(SEED_SENTINEL));
const seedText = seedEntry ? messageText(seedEntry) : '';
// Section 7's opening line (spec §3.1.2): an absolute path ending in .jsonl, right after the
// omitted-history sections above it and before the fixed Grep instruction.
const pathMatch = seedText.match(/\/\S+\.jsonl/);
const pointedPath = pathMatch ? pathMatch[0] : undefined;

let pointedFileText = '';
let readError;
if (pointedPath) {
  try {
    pointedFileText = await readFile(pointedPath, 'utf8');
  } catch (error) {
    readError = error;
  }
}

report('G7', [
  { name: 'a hook compaction happened (seed sentinel present in the transcript)', pass: Boolean(seedEntry), detail: `session=${session ?? 'unknown'}` },
  { name: 'the seed names an absolute transcript path in section 7', pass: Boolean(pointedPath), detail: `path=${pointedPath ?? 'none'}` },
  { name: 'the named file exists on disk and is readable', pass: pointedFileText.length > 0, detail: readError ? String(readError) : `bytes=${pointedFileText.length}` },
  { name: 'grepping the named file for a fact placed only before the cut finds it', pass: pointedFileText.includes(FACT), detail: `fact=${FACT}` },
]);

await compacted?.dispose();
await result.dispose();
