import { describe, it, expect, beforeAll, vi } from 'vitest';
import { loadImpl } from './impl.js';
import { humanPrompt, assistantText, sha256 } from './fixtures/helpers.js';
import type { SessionMessage } from '../core/types.js';
import type { capturePath as CapturePath } from '../host/capture-path.js';
import type { isCaptureEnabled as IsCaptureEnabled } from '../host/capture-flag.js';
import type { makeFsCaptureStore as MakeFsCaptureStore } from '../host/fs-adapter.js';
import type { captureBeforeNext as CaptureBeforeNext } from '../host/capture-order.js';
import type { reconcile as Reconcile } from '../core/extractor.js';

let capturePath: typeof CapturePath;
let isCaptureEnabled: typeof IsCaptureEnabled;
let makeFsCaptureStore: typeof MakeFsCaptureStore;
let captureBeforeNext: typeof CaptureBeforeNext;
let reconcile: typeof Reconcile;

beforeAll(async () => {
  const [pathImpl, flagImpl, storeImpl, orderImpl, extractorImpl] = await Promise.all([
    loadImpl<typeof CapturePath>('capture-path'),
    loadImpl<typeof IsCaptureEnabled>('capture-flag'),
    loadImpl<typeof MakeFsCaptureStore>('fs-adapter'),
    loadImpl<typeof CaptureBeforeNext>('capture-order'),
    loadImpl<{ reconcile: typeof Reconcile }>('extractor'),
  ]);
  capturePath = pathImpl.capturePath;
  isCaptureEnabled = flagImpl.isCaptureEnabled;
  makeFsCaptureStore = storeImpl.makeFsCaptureStore;
  captureBeforeNext = orderImpl.captureBeforeNext;
  reconcile = extractorImpl.reconcile;
});

describe('capture persistence wiring', () => {
  it('keys storage by sanitized session id', () => {
    const first = capturePath('one/session');
    const second = capturePath('two/session');
    expect(first).toMatch(/^\.exovault\/s4-capture\/[A-Za-z0-9._-]+$/);
    expect(second).toMatch(/^\.exovault\/s4-capture\/[A-Za-z0-9._-]+$/);
    expect(second).not.toBe(first);
  });

  it('finds the S4 flag at a parent of the session cwd', async () => {
    const checks: string[] = [];
    const enabled = await isCaptureEnabled({
      cwd: async () => '/workspace/project',
      exists: async (path) => { checks.push(path); return path === '/workspace/.exovault/s4-compact-active'; },
    });
    expect(enabled).toBe(true);
    expect(checks).toContain('/workspace/.exovault/s4-compact-active');
  });

  it('does not replace an existing capture segment after its read rejects', async () => {
    const segment = '.exovault/s4-capture/session/segment-000001.json';
    const contents = new Map([[segment, 'previous bytes']]);
    const store = makeFsCaptureStore({
      read: async () => { throw new Error('EIO'); },
      write: async (path, text) => { contents.set(path, text); },
      exists: async () => true,
      list: async () => [{ name: 'segment-000001.json', kind: 'file', size: 13 }],
    }, '.exovault/s4-capture/session');
    await expect(store.appendRecords([{ kind: 'user', origin: 'turn', producedBy: 's4-capture', sourceHash: 'h', body: { text: 'new' } }], { identities: ['w'] })).rejects.toThrow('EIO');
    expect(contents.get(segment)).toBe('previous bytes');
  });

  it('starts capture on the very first turn, when the capture directory does not exist yet (round 7 D2)', async () => {
    const files = new Map<string, string>();
    const fs = {
      read: async (path: string) => files.get(path) ?? Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })),
      write: async (path: string, text: string) => { files.set(path, text); },
      exists: async (path: string) => files.has(path) || [...files.keys()].some((key) => key.startsWith(`${path}/`)),
      list: async (path: string) => {
        if (![...files.keys()].some((key) => key.startsWith(`${path}/`))) {
          throw Object.assign(new Error(`ENOENT: no such directory '${path}'`), { code: 'ENOENT' });
        }
        return [...files.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => ({ name: key.slice(path.length + 1), kind: 'file', size: files.get(key)!.length }));
      },
    };
    const store = makeFsCaptureStore(fs, '.exovault/s4-capture/fresh-session');
    await expect(store.appendRecords([{ kind: 'user', origin: 'turn', producedBy: 's4-capture', sourceHash: 'h', body: { text: 'first ever capture' } }], { identities: ['w'] })).resolves.toBeUndefined();
    expect([...files.keys()].some((path) => path.includes('/segment-'))).toBe(true);
  });

  it('does not drop a second identical user prompt at a different position (round 7 D1, fs-adapter dedupe)', async () => {
    const files = new Map<string, string>();
    const fs = {
      read: async (path: string) => files.get(path) ?? Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })),
      write: async (path: string, text: string) => { files.set(path, text); },
      exists: async (path: string) => files.has(path) || [...files.keys()].some((key) => key.startsWith(`${path}/`)),
      list: async (path: string) => [...files.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => ({ name: key.slice(path.length + 1), kind: 'file', size: files.get(key)!.length })),
    };
    const store = makeFsCaptureStore(fs, '.exovault/s4-capture/session');
    const turn1 = reconcile([humanPrompt('continue')], null, { hash: sha256 });
    await store.appendRecords(turn1.records, turn1.watermark);
    const turn2Messages: SessionMessage[] = [humanPrompt('continue'), assistantText('ok'), humanPrompt('continue')];
    const turn2 = reconcile(turn2Messages, turn1.watermark, { hash: sha256 });
    await store.appendRecords(turn2.records, turn2.watermark);
    const userRecords = [...files.entries()]
      .filter(([path]) => path.includes('/segment-'))
      .flatMap(([, text]) => text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { kind: string }))
      .filter((record) => record.kind === 'user');
    expect(userRecords, 'both occurrences of the identically-worded prompt must persist, not collide on a position-blind sourceHash').toHaveLength(2);
  });

  it('does not drop a value or todo whose content differs from the latest stored record for the same key, across an occurrence reset (round 9 finding 1)', async () => {
    const files = new Map<string, string>();
    const fs = {
      read: async (path: string) => files.get(path) ?? Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })),
      write: async (path: string, text: string) => { files.set(path, text); },
      exists: async (path: string) => files.has(path) || [...files.keys()].some((key) => key.startsWith(`${path}/`)),
      list: async (path: string) => [...files.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => ({ name: key.slice(path.length + 1), kind: 'file', size: files.get(key)!.length })),
    };
    const store = makeFsCaptureStore(fs, '.exovault/s4-capture/session');
    // Same sourceHash on purpose: an occurrence restart after a compaction can make a much later
    // record collide with an earlier one for the same key, even though its content differs.
    const stale = { kind: 'value' as const, origin: 'reconcile' as const, producedBy: 's4-capture' as const, sourceHash: 'deadbeef#1', body: { key: 'port', content: '5432' } };
    await store.appendRecords([stale], { identities: ['w1'] });
    const reset = { kind: 'value' as const, origin: 'reconcile' as const, producedBy: 's4-capture' as const, sourceHash: 'deadbeef#1', body: { key: 'port', content: '5432_then_changed_to_5433_then_back' } };
    await store.appendRecords([reset], { identities: ['w2'] });
    const values = [...files.entries()]
      .filter(([path]) => path.includes('/segment-'))
      .flatMap(([, text]) => text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { kind: string; body: { key?: string; content?: string } }))
      .filter((record) => record.kind === 'value' && record.body.key === 'port');
    expect(values, 'a value with different content must never be skipped merely because it shares a sourceHash with an earlier, different record for the same key').toHaveLength(2);
  });

  it('treats an old-format watermark.json ({sha256, occurrence}, written by an r7 build) as absent instead of throwing (round 9 note, finding 9)', async () => {
    const files = new Map<string, string>([['.exovault/s4-capture/session/watermark.json', JSON.stringify({ watermark: { sha256: 'deadbeef', occurrence: 1 } })]]);
    const fs = {
      read: async (path: string) => files.get(path) ?? Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })),
      write: async (path: string, text: string) => { files.set(path, text); },
      exists: async (path: string) => files.has(path) || [...files.keys()].some((key) => key.startsWith(`${path}/`)),
      list: async (path: string) => [...files.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => ({ name: key.slice(path.length + 1), kind: 'file', size: files.get(key)!.length })),
    };
    const store = makeFsCaptureStore(fs, '.exovault/s4-capture/session');
    await expect(store.loadWatermark()).resolves.toBeNull();
  });

  it('does not write anything when the signal is already aborted before the call (round 9 finding 5, D7/finding-9 defense-in-depth)', async () => {
    const files = new Map<string, string>();
    const write = vi.fn(async (path: string, text: string) => { files.set(path, text); });
    const fs = {
      read: async (path: string) => files.get(path) ?? Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })),
      write,
      exists: async (path: string) => files.has(path) || [...files.keys()].some((key) => key.startsWith(`${path}/`)),
      list: async (path: string) => [...files.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => ({ name: key.slice(path.length + 1), kind: 'file', size: files.get(key)!.length })),
    };
    const store = makeFsCaptureStore(fs, '.exovault/s4-capture/session');
    const controller = new AbortController();
    controller.abort();
    await expect(store.appendRecords([{ kind: 'user', origin: 'turn', producedBy: 's4-capture', sourceHash: 'h', body: { text: 'late' } }], { identities: ['w'] }, controller.signal)).rejects.toThrow();
    expect(write, 'an already-aborted signal must stop appendRecords before its first write, an orphaned run() resuming after a lost withFallback/withTimeout race must not persist anything').not.toHaveBeenCalled();
  });

  it('stops writing further segments once the signal aborts mid-append, instead of finishing the whole batch (round 9 finding 5)', async () => {
    const files = new Map<string, string>();
    const controller = new AbortController();
    const write = vi.fn(async (path: string, text: string) => {
      files.set(path, text);
      if (path.endsWith('segment-000001.json')) controller.abort();
    });
    const fs = {
      read: async (path: string) => files.get(path) ?? Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })),
      write,
      exists: async (path: string) => files.has(path) || [...files.keys()].some((key) => key.startsWith(`${path}/`)),
      list: async (path: string) => [...files.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => ({ name: key.slice(path.length + 1), kind: 'file', size: files.get(key)!.length })),
    };
    const store = makeFsCaptureStore(fs, '.exovault/s4-capture/session');
    // Force a segment rollover so more than one segment write is needed in a single call: the
    // first record fills segment-000001 to the cap, the second lands in segment-000002.
    const big = { kind: 'user' as const, origin: 'reconcile' as const, producedBy: 's4-capture' as const, sourceHash: 'h1', body: { text: 'x'.repeat(3 * 1024 * 1024 - 200) } };
    const overflow = { kind: 'user' as const, origin: 'reconcile' as const, producedBy: 's4-capture' as const, sourceHash: 'h2', body: { text: 'y' } };
    await expect(store.appendRecords([big, overflow], { identities: ['w'] }, controller.signal)).rejects.toThrow('aborted');
    expect(files.has('.exovault/s4-capture/session/segment-000001.json')).toBe(true);
    expect(files.has('.exovault/s4-capture/session/segment-000002.json'), 'the abort fired after segment-000001 was written; segment-000002 and the watermark must never be written after that').toBe(false);
    expect(files.has('.exovault/s4-capture/session/watermark.json')).toBe(false);
  });

  it('writes at most one file per changed segment plus the watermark, not once per record (round 7 D4)', async () => {
    const files = new Map<string, string>();
    let writeCalls = 0;
    const fs = {
      read: async (path: string) => files.get(path) ?? Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })),
      write: async (path: string, text: string) => { writeCalls += 1; files.set(path, text); },
      exists: async (path: string) => files.has(path) || [...files.keys()].some((key) => key.startsWith(`${path}/`)),
      list: async (path: string) => [...files.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => ({ name: key.slice(path.length + 1), kind: 'file', size: files.get(key)!.length })),
    };
    const store = makeFsCaptureStore(fs, '.exovault/s4-capture/busy-session');
    const records = Array.from({ length: 2000 }, (_, index) => ({
      kind: 'user' as const,
      origin: 'reconcile' as const,
      producedBy: 's4-capture' as const,
      sourceHash: `hash-${index}`,
      body: { text: `x`.repeat(400) },
    }));
    await store.appendRecords(records, { identities: ['final'] });
    const segmentsTouched = new Set([...files.keys()].filter((path) => path.includes('/segment-'))).size;
    expect(writeCalls, `expected at most ${segmentsTouched} segment write(s) plus one watermark write, got ${writeCalls}`).toBeLessThanOrEqual(segmentsTouched + 1);
  });

  it('persists completed-turn capture before calling the next hook module', async () => {
    const order: string[] = [];
    const result = await captureBeforeNext(
      async () => { order.push('capture'); },
      async () => { order.push('next'); return 'done'; },
      () => { order.push('error'); },
    );
    expect(result).toBe('done');
    expect(order).toEqual(['capture', 'next']);
  });
});
