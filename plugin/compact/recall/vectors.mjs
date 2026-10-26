// Local embeddings for session recall: a small multilingual model (multilingual-e5-small, int8) run on the CPU with
// transformers.js. Nothing leaves the machine. The runtime (about 160 MB) and the model (about 115 MB) are not shipped
// with the plugin: the first embedding worker installs them once into <recall root>/../recall-runtime.
// Vectors live next to the session's index in one append-only file of fixed-size records
// (8-byte key = sha256(text) prefix, then DIM int8 values), so the worker can publish them in batches and a reader
// ignores a half-written tail. Readers use whatever is there; chunks without a vector are still found lexically.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const MODEL = 'Xenova/multilingual-e5-small';
export const TRANSFORMERS = '@huggingface/transformers@4.3.0';
export const DIM = 384;
const KEY = 8, RECORD = KEY + DIM;
const FILE = 'vectors-e5-small-q8.bin';
const RETRY_INSTALL_MS = 24 * 3600 * 1000;
const VECTOR_LOCK_WAIT_MS = 2000, VECTOR_LOCK_STALE_MS = 30_000, VECTOR_LOCK_POLL_MS = 10;
const vectorLockWaiter = new Int32Array(new SharedArrayBuffer(4));
// e5 is trained with these prefixes; without them the cosines are much flatter.
export const PASSAGE = 'passage: ', QUERY = 'query: ';

export const runtimeDir = (recallRoot) => path.join(path.dirname(path.resolve(recallRoot)), 'recall-runtime');
export const vectorFile = (sessionDir) => path.join(sessionDir, FILE);
export const textKey = (text) => crypto.createHash('sha256').update(text).digest().subarray(0, KEY).toString('hex');

// 4.9.1: vector appends and redaction drops share a bounded per-index lock; locks older than 30 seconds are taken over.
export function takeVectorLock(dir) {
  if (!fs.existsSync(dir)) return null;
  const file = path.join(dir, 'VECTOR_LOCK');
  const until = Date.now() + VECTOR_LOCK_WAIT_MS;
  for (;;) {
    if (Date.now() >= until) return null;
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      const owned = fs.statSync(file);
      return () => {
        try {
          const current = fs.statSync(file);
          if (current.dev === owned.dev && current.ino === owned.ino && fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file);
        } catch {}
      };
    } catch {
      if (!fs.existsSync(dir)) return null;
      let holder = 0, observed;
      try { observed = fs.statSync(file); holder = Number(fs.readFileSync(file, 'utf8').trim()); }
      catch {
        const remaining = until - Date.now();
        if (remaining <= 0) return null;
        Atomics.wait(vectorLockWaiter, 0, 0, Math.min(VECTOR_LOCK_POLL_MS, remaining));
        continue;
      }
      const stale = Date.now() - observed.mtimeMs >= VECTOR_LOCK_STALE_MS;
      if (stale || !holder || !pidAlive(holder)) {
        let removed = false;
        try {
          const current = fs.statSync(file), currentHolder = Number(fs.readFileSync(file, 'utf8').trim());
          if (current.dev === observed.dev && current.ino === observed.ino && current.mtimeMs === observed.mtimeMs && currentHolder === holder &&
            (Date.now() - current.mtimeMs >= VECTOR_LOCK_STALE_MS || !currentHolder || !pidAlive(currentHolder))) { fs.unlinkSync(file); removed = true; }
        } catch {}
        if (!removed) {
          const remaining = until - Date.now();
          if (remaining <= 0) return null;
          Atomics.wait(vectorLockWaiter, 0, 0, Math.min(VECTOR_LOCK_POLL_MS, remaining));
        }
        continue;
      }
      const remaining = until - Date.now();
      if (remaining <= 0) return null;
      Atomics.wait(vectorLockWaiter, 0, 0, Math.min(VECTOR_LOCK_POLL_MS, remaining));
    }
  }
}

// Machine-wide cap on embedding: a session's worker takes one of EMBED_SLOTS pid files under the recall root before
// it loads the model, so any number of sessions embed on at most EMBED_SLOTS x EMBED_THREADS cores (and as many
// model copies in memory). A slot whose pid is gone is from a killed worker and is taken over.
export const EMBED_SLOTS = 2, EMBED_THREADS = 2;
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } }
/** Takes a free slot and returns its release function, or null when all slots are held by live workers. */
export function takeEmbedSlot(recallRoot, slots = EMBED_SLOTS, pid = process.pid) {
  const dir = path.join(recallRoot, 'embed-slots');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let i = 0; i < slots; i++) {
    const file = path.join(dir, `slot-${i}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(file, String(pid), { flag: 'wx', mode: 0o600 });
        return () => { try { if (fs.readFileSync(file, 'utf8').trim() === String(pid)) fs.unlinkSync(file); } catch {} };
      } catch {
        let holder = 0;
        try { holder = Number(fs.readFileSync(file, 'utf8').trim()); } catch { continue; }
        if (holder && pidAlive(holder)) break;
        try { if (Number(fs.readFileSync(file, 'utf8').trim()) === holder) fs.unlinkSync(file); } catch {}
      }
    }
  }
  return null;
}

export function runtimeReady(dir) { return fs.existsSync(path.join(dir, 'READY')); }

/**
 * Installs transformers.js and the model into `dir` once (npm, then one model download). Prunes onnxruntime binaries
 * for other platforms and the GPU providers (744 MB -> about 160 MB). A failure is remembered for a day so every
 * compaction does not retry a broken install.
 */
export async function ensureRuntime(dir, log = () => {}) {
  if (runtimeReady(dir)) return true;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const failed = path.join(dir, 'FAILED');
  try { if (Date.now() - fs.statSync(failed).mtimeMs < RETRY_INSTALL_MS) return false; } catch {}
  const lock = path.join(dir, 'INSTALL_LOCK');
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch {
    // Another worker installs; a lock older than 20 minutes is from a killed install.
    try { if (Date.now() - fs.statSync(lock).mtimeMs < 20 * 60 * 1000) return false; fs.unlinkSync(lock); return ensureRuntime(dir, log); } catch { return false; }
  }
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module' }), { mode: 0o600 });
    const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund', '--omit=dev', TRANSFORMERS], { cwd: dir, stdio: 'ignore', timeout: 15 * 60 * 1000, shell: process.platform === 'win32' });
    if (npm.status !== 0) throw new Error(`npm install exited ${npm.status ?? npm.signal ?? npm.error?.code}`);
    prune(dir);
    const embed = await loadEmbedder(dir, { download: true });
    await embed([`${QUERY}ok`]);
    fs.writeFileSync(path.join(dir, 'READY'), JSON.stringify({ model: MODEL, runtime: TRANSFORMERS, at: new Date().toISOString() }), { mode: 0o600 });
    try { fs.unlinkSync(failed); } catch {}
    log('runtime installed');
    return true;
  } catch (error) {
    fs.writeFileSync(failed, `${error?.message ?? error}\n`, { mode: 0o600 });
    log(`runtime install failed: ${error?.message ?? error}`);
    return false;
  } finally { try { fs.unlinkSync(lock); } catch {} }
}

function prune(dir) {
  const bin = path.join(dir, 'node_modules/onnxruntime-node/bin/napi-v6');
  try {
    for (const os of fs.readdirSync(bin)) for (const arch of fs.readdirSync(path.join(bin, os))) {
      const here = path.join(bin, os, arch);
      if (os !== process.platform || arch !== process.arch) { fs.rmSync(here, { recursive: true, force: true }); continue; }
      for (const lib of fs.readdirSync(here)) if (/providers_(cuda|tensorrt)/.test(lib)) fs.rmSync(path.join(here, lib), { force: true });
    }
  } catch {}
  // The browser build's wasm files are never loaded under Node.
  const web = path.join(dir, 'node_modules/onnxruntime-web/dist');
  try { for (const f of fs.readdirSync(web)) if (/\.(wasm|map)$/.test(f)) fs.rmSync(path.join(web, f), { force: true }); } catch {}
}

/** Returns `embed(texts) -> Float32Array[]` (unit length). `download` lets the model come from the hub (install only). */
export async function loadEmbedder(dir, { download = false, threads } = {}) {
  const require = createRequire(path.join(dir, 'package.json'));
  const mod = await import(pathToFileURL(require.resolve('@huggingface/transformers')).href);
  const t = mod.pipeline ? mod : mod.default;
  t.env.cacheDir = path.join(dir, 'models');
  t.env.allowRemoteModels = download;
  const ext = await t.pipeline('feature-extraction', MODEL, { dtype: 'q8', ...(threads ? { session_options: { intraOpNumThreads: threads } } : {}) });
  return async (texts) => {
    const out = await ext(texts, { pooling: 'mean', normalize: true });
    const dim = out.dims[1];
    return texts.map((_, i) => Float32Array.from(out.data.subarray(i * dim, (i + 1) * dim)));
  };
}

/** Keys already stored, in file order. */
export function storedKeys(file) {
  let buf; try { buf = fs.readFileSync(file); } catch { return new Set(); }
  const keys = new Set();
  for (let at = 0; at + RECORD <= buf.length; at += RECORD) keys.add(buf.toString('hex', at, at + KEY));
  return keys;
}

export function appendVectors(file, items, keep = () => true) {
  const release = takeVectorLock(path.dirname(file));
  if (!release) return 0;
  try {
    const selected = items.filter(keep);
    if (!selected.length) return 0;
    const buf = Buffer.alloc(selected.length * RECORD);
    selected.forEach(({ key, vector }, n) => {
      const at = n * RECORD;
      buf.write(key, at, KEY, 'hex');
      for (let k = 0; k < DIM; k++) buf.writeInt8(Math.max(-127, Math.min(127, Math.round(vector[k] * 127))), at + KEY + k);
    });
    // A worker killed mid-write leaves a partial record; cut it so later records stay aligned.
    try { const size = fs.statSync(file).size; if (size % RECORD) fs.truncateSync(file, size - (size % RECORD)); } catch {}
    fs.appendFileSync(file, buf, { mode: 0o600 });
    return selected.length;
  } finally { release(); }
}

/** Number of complete stored vector records whose text keys are in `keys`. */
export function countVectors(file, keys) {
  if (!keys.size) return 0;
  let buf; try { buf = fs.readFileSync(file); } catch { return 0; }
  let count = 0;
  for (let at = 0; at + RECORD <= buf.length; at += RECORD) if (keys.has(buf.toString('hex', at, at + KEY))) count++;
  return count;
}

/** Removes every matching append from a file. The caller holds that index's VECTOR_LOCK. */
export function dropVectorsLocked(file, keys) {
  if (!keys.size) return 0;
  let buf; try { buf = fs.readFileSync(file); } catch { return 0; }
  const kept = Buffer.alloc(buf.length), end = buf.length - (buf.length % RECORD);
  let removed = 0, offset = 0;
  for (let at = 0; at < end; at += RECORD) {
    if (keys.has(buf.toString('hex', at, at + KEY))) { removed++; continue; }
    buf.copy(kept, offset, at, at + RECORD); offset += RECORD;
  }
  if (!removed) return 0;
  buf.copy(kept, offset, end);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, kept.subarray(0, offset + (buf.length - end)), { mode: 0o600 });
  fs.renameSync(temp, file);
  cache.delete(file);
  return removed;
}

const cache = new Map();
/** key -> Int8Array view, reloaded when the file grows. */
export function readVectors(file) {
  let size; try { size = fs.statSync(file).size; } catch { return undefined; }
  const hit = cache.get(file);
  if (hit && hit.size === size) return hit.map;
  const buf = fs.readFileSync(file);
  const map = new Map();
  for (let at = 0; at + RECORD <= buf.length; at += RECORD) map.set(buf.toString('hex', at, at + KEY), new Int8Array(buf.buffer, buf.byteOffset + at + KEY, DIM));
  cache.set(file, { size, map });
  return map;
}

const rowKeys = new WeakMap();
/** Rows nearest to the query vector, best first, as `[row index, cosine]`, plus how many rows have a vector. */
export function nearest(rows, vectors, queryVector, limit = 200) {
  let keys = rowKeys.get(rows);
  if (!keys) { keys = rows.map((row) => textKey(row.text)); rowKeys.set(rows, keys); }
  const scored = []; let covered = 0;
  for (let i = 0; i < rows.length; i++) {
    const v = vectors.get(keys[i]);
    if (!v) continue;
    covered++;
    let s = 0; for (let k = 0; k < DIM; k++) s += v[k] * queryVector[k];
    scored.push([i, s / 127]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  return { list: scored.slice(0, limit), covered };
}
