import { describe, it, expect, beforeAll } from 'vitest';
import { loadImpl } from './impl.js';
import type { CaptureRecord } from '../core/types.js';
import type { isLocalOnly as IsLocalOnly, excludeLocalOnly as ExcludeLocalOnly } from '../core/sync-exclusion.js';

let isLocalOnly: typeof IsLocalOnly;
let excludeLocalOnly: typeof ExcludeLocalOnly;

beforeAll(async () => {
  ({ isLocalOnly, excludeLocalOnly } = await loadImpl<{
    isLocalOnly: typeof IsLocalOnly;
    excludeLocalOnly: typeof ExcludeLocalOnly;
  }>('sync-exclusion'));
});

function record(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return { kind: 'value', origin: 'turn', producedBy: 's4-capture', body: {}, sourceHash: 'h', ...overrides };
}

describe('sync exclusion: isLocalOnly (v2 spec:63, 143)', () => {
  it('an S4-captured user record is local-only', () => {
    expect(isLocalOnly(record({ kind: 'user', producedBy: 's4-capture' }))).toBe(true);
  });

  it('an S4-captured todo/value/assistant_text record is local-only', () => {
    for (const kind of ['todo', 'value', 'assistant_text'] as const) {
      expect(isLocalOnly(record({ kind, producedBy: 's4-capture' })), `${kind} should be local-only`).toBe(true);
    }
  });

  it('a gate/error/file record produced by S4 capture is local-only', () => {
    for (const kind of ['gate', 'error', 'file'] as const) {
      expect(isLocalOnly(record({ kind, producedBy: 's4-capture' })), `S4-produced ${kind} should be local-only`).toBe(
        true,
      );
    }
  });

  it('the same kind name (gate) from the pre-existing S3 path is not local-only: kind alone does not decide this', () => {
    expect(isLocalOnly(record({ kind: 'gate', producedBy: 's3-existing' }))).toBe(false);
  });

  it('the existing S3 intent/step/pointer records keep syncing unchanged', () => {
    expect(isLocalOnly({ producedBy: 's3-existing' })).toBe(false);
  });
});

describe('sync exclusion: excludeLocalOnly filters the first sync batch', () => {
  it('drops S4-capture records but keeps S3-existing ones, preserving order', () => {
    const batch: CaptureRecord[] = [
      record({ kind: 'value', producedBy: 's4-capture', sourceHash: 'a' }),
      record({ kind: 'gate', producedBy: 's3-existing', sourceHash: 'b' }),
      record({ kind: 'file', producedBy: 's4-capture', sourceHash: 'c' }),
    ];
    const filtered = excludeLocalOnly(batch);
    expect(filtered.map((r) => r.sourceHash)).toEqual(['b']);
  });
});

describe('sync exclusion: gap-retry resend', () => {
  it('a gap-retry resend reloading records straight from disk (exovault-hook.cjs:686 pattern) is filtered the same way', () => {
    const reloadedFromDisk: CaptureRecord[] = [
      record({ kind: 'file', producedBy: 's4-capture', sourceHash: 'p1' }),
      record({ kind: 'todo', producedBy: 's4-capture', sourceHash: 't1' }),
      record({ kind: 'gate', producedBy: 's3-existing', sourceHash: 'g1' }),
    ];
    const resend = excludeLocalOnly(reloadedFromDisk);
    expect(resend.map((r) => r.sourceHash)).toEqual(['g1']);
  });
});

describe('sync exclusion: outbox replay', () => {
  it('an outbox replay never re-leaks a local-only record even if it was queued before the machine restarted', () => {
    const outbox: CaptureRecord[] = [
      record({ kind: 'error', producedBy: 's4-capture', sourceHash: 'e1' }),
      record({ kind: 'gate', producedBy: 's3-existing', sourceHash: 'g2' }),
    ];
    const replayed = excludeLocalOnly(outbox);
    expect(replayed.some((r) => r.producedBy === 's4-capture')).toBe(false);
    expect(replayed.map((r) => r.sourceHash)).toEqual(['g2']);
  });

  it('an empty batch stays empty', () => {
    expect(excludeLocalOnly([])).toEqual([]);
  });
});
