import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// trigger: 'cut' (a compaction: always build) or 'turn' (after an answer: build only when the transcript grew enough).
// retentionDays: userConfig retentionDays, passed on to the build worker's retention (recall/cleanup.mjs pruneOld).
const [transcript, root, sessionId, mode = 'lexical', trigger = 'cut', retentionDays = '30'] = process.argv.slice(2);
try {
  const cutoff = fs.statSync(transcript).size;
  const worker = fileURLToPath(new URL('./build-worker.mjs', import.meta.url));
  const child = spawn(process.execPath, [worker, transcript, root, sessionId, String(cutoff), path.dirname(transcript), mode, trigger, retentionDays], { detached: true, stdio: 'ignore' });
  child.unref();
} catch { /* the next compaction or transcript fallback can recover */ }
