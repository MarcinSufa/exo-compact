import type { CaptureRecord } from './types.js';

/**
 * v2 spec:63, 143 and v3.1 §5.1's sync-exclusion bullet: a record's `kind` does not decide
 * this on its own (`gate`, `error` and `file` each name both an S4-produced record and a
 * pre-existing S3 one, spec §3.1/§3.2). The discriminator is `producedBy`: `'s4-capture'`
 * (this module's own `user`/`todo`/`value`/`assistant_text`/`gate`/`error`/`file` records)
 * never leaves the machine through `syncBatch`, a gap-retry resend, or an outbox replay;
 * `'s3-existing'` (the pre-existing `intent`/`step`/`gate`/`pointer` records, and the
 * model-written `decision`/`thread`/`correction`) keeps syncing unchanged.
 */
export function isLocalOnly(record: Pick<CaptureRecord, 'producedBy'>): boolean {
  return record.producedBy === 's4-capture';
}

/** Filters a batch (built for `/api/agent/run-log/append`, a gap-retry resend, or an outbox replay). */
export function excludeLocalOnly<T extends Pick<CaptureRecord, 'producedBy'>>(
  records: readonly T[],
): T[] {
  return records.filter((record) => !isLocalOnly(record));
}
