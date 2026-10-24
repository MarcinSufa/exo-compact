// Background worker started by build-worker.mjs after it publishes a generation: embeds the chunks that have no vector
// yet, in batches, at the lowest CPU priority. One worker per session (EMBED_LOCK); a newer generation published
// while it runs is picked up before it exits. Before loading the model it waits for one of the machine-wide embedding
// slots (takeEmbedSlot); after SLOT_WAIT_MS it gives up, and the next turn's build starts a worker that catches up.
// Then it embeds the saved task brief lines (brief-search.mjs embedBriefs) for search_session scope "brief".
// Failures only cost the dense list; lexical recall is unaffected.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { embedBriefs } from './brief-search.mjs';
import { hash } from './shared.mjs';
import { EMBED_THREADS, PASSAGE, appendVectors, ensureRuntime, loadEmbedder, runtimeDir, storedKeys, takeEmbedSlot, textKey, vectorFile } from './vectors.mjs';

const BATCH = 16, SLOT_WAIT_MS = 15 * 60 * 1000, SLOT_POLL_MS = 5000;
const [root, sessionId] = process.argv.slice(2);
const dir = path.join(root, hash(sessionId));
const lock = path.join(dir, 'EMBED_LOCK');
const log = (line) => { try { fs.appendFileSync(path.join(dir, 'embed.log'), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); } catch {} };

function ownerAlive() { try { const pid = Number(fs.readFileSync(lock, 'utf8').trim()); if (!pid) return false; process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } }
function takeLock() { try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); return true; } catch { return false; } }

function currentRows() {
  const current = Number(fs.readFileSync(path.join(dir, 'CURRENT'), 'utf8').trim());
  const rows = JSON.parse(fs.readFileSync(path.join(dir, `generation-${String(current).padStart(8, '0')}`, 'records.json'), 'utf8'));
  return { current, rows: Array.isArray(rows) ? rows : [] };
}

async function waitForSlot() {
  for (const until = Date.now() + SLOT_WAIT_MS; ;) {
    const release = takeEmbedSlot(root);
    if (release || Date.now() >= until) return release;
    await new Promise((resolve) => setTimeout(resolve, SLOT_POLL_MS));
  }
}

async function main() {
  if (!sessionId || !fs.existsSync(dir)) return;
  let locked = takeLock();
  if (!locked && !ownerAlive()) { try { fs.unlinkSync(lock); } catch {} locked = takeLock(); }
  if (!locked) return; // the running worker re-reads CURRENT before it exits
  let release = null;
  try {
    try { os.setPriority(19); } catch {}
    const runtime = runtimeDir(root);
    let embed;
    const loadOnce = async (pending) => {
      if (embed) return embed;
      release = await waitForSlot();
      if (!release) { log(`no free embedding slot, ${pending} left for a later worker`); return undefined; }
      if (!(await ensureRuntime(runtime, log))) return undefined;
      embed = await loadEmbedder(runtime, { threads: Math.max(1, Math.min(EMBED_THREADS, Math.floor(os.cpus().length / 4))) });
      return embed;
    };
    const file = vectorFile(dir);
    let done = -1;
    for (let round = 0; round < 10; round++) {
      const { current, rows } = currentRows();
      if (current === done) break;
      const have = storedKeys(file);
      const todo = new Map();
      for (const row of rows) { const key = textKey(row.text); if (!have.has(key) && !todo.has(key)) todo.set(key, row.text); }
      const started = Date.now(), entries = [...todo];
      if (entries.length && !(await loadOnce(`generation ${current}: ${entries.length} chunks`))) return;
      for (let i = 0; i < entries.length; i += BATCH) {
        const batch = entries.slice(i, i + BATCH);
        const vectors = await embed(batch.map(([, text]) => PASSAGE + text));
        appendVectors(file, batch.map(([key], j) => ({ key, vector: vectors[j] })));
      }
      if (entries.length) log(`generation ${current}: embedded ${entries.length} of ${rows.length} chunks in ${Math.round((Date.now() - started) / 1000)} s`);
      done = current;
    }
    const started = Date.now();
    const briefLines = await embedBriefs(root, sessionId, async (texts) => {
      const loaded = await loadOnce('brief lines');
      if (!loaded) throw new Error('brief lines not embedded: no embedder');
      return loaded(texts);
    }, BATCH);
    if (briefLines) log(`briefs: embedded ${briefLines} lines in ${Math.round((Date.now() - started) / 1000)} s`);
  } catch (error) {
    log(`failed: ${error?.message ?? error}`);
  } finally { release?.(); try { fs.unlinkSync(lock); } catch {} }
}

await main();
