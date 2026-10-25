import type { CaptureRecord, ContentWatermark } from '../core/types.js';

/** The slice of `$` a `session.compact` or `turn.complete` hook actually gets (cc.d.ts:2600-2631). */
export interface FsLike {
  read: (path: string) => Promise<string>;
  write: (path: string, text: string) => Promise<void>;
  list?: (path?: string) => Promise<{ name: string; kind: string; size: number }[]>;
  exists?: (path: string) => Promise<boolean>;
}

/**
 * Persists capture through `$.fs` (spec §3.6): no shared append, no `node:fs` lock, so each
 * write replaces one whole per-segment file, each kept under the 4 MiB cap `$.fs.write`
 * rejects past. Segment naming and rollover are the implementer's to pick; this is the seam
 * G6 probes.
 */
export interface CaptureStore {
  loadWatermark: () => Promise<ContentWatermark | null>;
  /**
   * Round 9 finding 5: `signal`, when given, is checked before the first write and again before
   * each segment write and the final watermark write, so a caller whose own `withFallback`/
   * `withTimeout` race has already been lost (an orphaned `run()` that resumes after core has
   * started, or after `capture.timeout` was already logged) cannot land a write mid-append, not
   * only at the call site's own check before calling this at all.
   */
  appendRecords: (records: readonly CaptureRecord[], watermark: ContentWatermark, signal?: AbortSignal) => Promise<void>;
}

/**
 * `fs.list` on a directory that has never been written to rejects on a real host (Node
 * `readdir` behavior; cc.d.ts:2618-2624 does not promise an empty result for a missing path).
 * The first `appendRecords` of every session lists a capture directory that does not exist
 * yet (round 7 D2), so a bare `await fs.list(dir)` there throws and every S4 compaction falls
 * back with `compact.fallback=error` forever, invisibly, because every fake `list` used to
 * return `[]` for a missing path. Only a rejection confirmed by `fs.exists` reporting the
 * directory absent is swallowed; any other rejection (a real read failure) still propagates.
 */
export async function listIfPresent(fs: FsLike, dir: string): Promise<{ name: string; kind: string; size: number }[]> {
  if (!fs.list) return [];
  try {
    return await fs.list(dir);
  } catch (error) {
    if (fs.exists && !(await fs.exists(dir))) return [];
    throw error;
  }
}

export function makeFsCaptureStore(fs: FsLike, baseDir: string): CaptureStore {
  const watermarkPath = `${baseDir}/watermark.json`;
  const segmentPrefix = 'segment-';
  const isPresent = async (path: string): Promise<boolean> => {
    if (fs.exists) return fs.exists(path);
    if (!fs.list) return true;
    const slash = path.lastIndexOf('/');
    const parent = slash < 0 ? '' : path.slice(0, slash);
    const name = path.slice(slash + 1);
    return (await fs.list(parent)).some((entry) => entry.name === name && entry.kind === 'file');
  };
  const readJson = async <T>(path: string): Promise<T | null> => {
    if (!(await isPresent(path))) return null;
    return JSON.parse(await fs.read(path)) as T;
  };
  return {
    async loadWatermark() {
      const state = await readJson<{ watermark: unknown }>(watermarkPath);
      const watermark = state?.watermark;
      /**
       * Round 9 note (finding 9): an r7 build wrote `{ sha256, occurrence }` instead of today's
       * `{ identities }`. Reading that shape back as a `ContentWatermark` makes
       * `findWatermarkIndex` throw on `watermark.identities.length` (extractor.ts), which then
       * falls back to core on every single compaction for the rest of that store's life. Any
       * shape that is not today's `{ identities: string[] }` is treated the same as no watermark
       * at all (never as a crash), so an old dev or probe store just re-derives capture from
       * scratch on its next reconcile instead of wedging.
       */
      if (!watermark || typeof watermark !== 'object' || !Array.isArray((watermark as { identities?: unknown }).identities)) return null;
      return watermark as ContentWatermark;
    },
    async appendRecords(records, watermark, signal) {
      const checkAbort = (): void => {
        if (signal?.aborted) throw new Error('aborted');
      };
      checkAbort();
      if (!records.length) {
        checkAbort();
        await fs.write(watermarkPath, JSON.stringify({ watermark }));
        return;
      }
      let segments: { name: string; kind: string; size: number }[] = [];
      let contents = new Map<string, string>();
      // 4.9.1: retention can rename a listed segment before read; restart the read pass once from the canonical listing.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        checkAbort();
        const entries = await listIfPresent(fs, baseDir);
        segments = entries.filter((entry) => entry.kind === 'file' && entry.name.startsWith(segmentPrefix)).sort((a, b) => a.name.localeCompare(b.name));
        contents = new Map<string, string>();
        try {
          for (const entry of segments) {
            checkAbort();
            contents.set(entry.name, await fs.read(`${baseDir}/${entry.name}`));
          }
          break;
        } catch (error) {
          checkAbort();
          if (attempt === 0 && error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
          throw error;
        }
      }
      let name = segments.at(-1)?.name ?? `${segmentPrefix}000001.json`;
      const known = new Set<string>();
      /**
       * Round 9 finding 1: `sourceHash` is `identity#occurrence`, and `occurrence` is only
       * unique against the exact message list `reconcile` last saw it in. A compaction rewrites
       * that list, so occurrence counting restarts, and a `value`/`todo` re-asserted with the
       * same content it had much earlier (a port reset back to a prior value, a todo reopened
       * with the text it had before) can land on the same `sourceHash` as that earlier record and
       * get silently skipped below. `value`/`todo` are keyed by their own stable `key`/`id`
       * instead: a new record for that key is only skipped when it repeats the *latest already
       * stored* record for that same key verbatim, never merely because some sourceHash
       * collided. This mirrors the `latest` fold `compact.ts` already does at render time.
       */
      const latestByStateKey = new Map<string, CaptureRecord>();
      const stateKeyOf = (record: CaptureRecord): string | null =>
        record.kind === 'value' ? `value:${String(record.body.key)}` : record.kind === 'todo' ? `todo:${String(record.body.id)}` : null;
      for (const entry of segments) {
        const segment = contents.get(entry.name) ?? '';
        for (const line of segment.split('\n').filter(Boolean)) {
          try {
            const record = JSON.parse(line) as CaptureRecord;
            known.add(`${record.kind}:${record.sourceHash}`);
            const stateKey = stateKeyOf(record);
            if (stateKey) latestByStateKey.set(stateKey, record);
          } catch {}
        }
      }
      /**
       * Round 7 D4: build every touched segment's lines in memory and write each one at most
       * once at the end, instead of re-serializing and `fs.write`-ing the whole segment after
       * every single record (a 2000-record turn used to cost ~2000 whole-file writes).
       */
      const encoder = new TextEncoder();
      const segmentLines = new Map<string, string[]>();
      const segmentBytes = new Map<string, number>();
      for (const entry of segments) {
        const text = contents.get(entry.name) ?? '';
        const lines = text ? text.split('\n') : [];
        segmentLines.set(entry.name, lines);
        segmentBytes.set(entry.name, encoder.encode(text).length);
      }
      if (!segmentLines.has(name)) { segmentLines.set(name, []); segmentBytes.set(name, 0); }
      let segmentNumber = Number(name.match(/(\d+)\.json$/)?.[1] ?? 1);
      const changed = new Set<string>();
      const cap = 3 * 1024 * 1024;
      for (const record of records) {
        const stateKey = stateKeyOf(record);
        const key = `${record.kind}:${record.sourceHash}`;
        if (stateKey) {
          const latest = latestByStateKey.get(stateKey);
          if (latest && JSON.stringify(latest.body) === JSON.stringify(record.body)) continue;
          latestByStateKey.set(stateKey, record);
        } else if (known.has(key)) continue;
        const line = JSON.stringify(record);
        const lineBytes = encoder.encode(line).length;
        if (lineBytes > cap) throw new RangeError('capture record exceeds segment limit');
        const lines = segmentLines.get(name)!;
        const additional = lines.length ? lineBytes + 1 : lineBytes;
        if (segmentBytes.get(name)! + additional > cap) {
          segmentNumber += 1;
          name = `${segmentPrefix}${String(segmentNumber).padStart(6, '0')}.json`;
          segmentLines.set(name, [line]);
          segmentBytes.set(name, lineBytes);
        } else {
          lines.push(line);
          segmentBytes.set(name, segmentBytes.get(name)! + additional);
        }
        changed.add(name);
        known.add(key);
      }
      for (const segmentName of changed) {
        checkAbort();
        await fs.write(`${baseDir}/${segmentName}`, segmentLines.get(segmentName)!.join('\n'));
      }
      checkAbort();
      await fs.write(watermarkPath, JSON.stringify({ watermark }));
    },
  };
}
