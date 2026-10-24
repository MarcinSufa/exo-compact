import type { CaptureRecord } from '../../core/types.js';

/** Mutation-proof defect: never excludes anything, so local-only records would leak into sync. */
export function isLocalOnly(_record: Pick<CaptureRecord, 'producedBy'>): boolean {
  return false;
}

export function excludeLocalOnly<T extends Pick<CaptureRecord, 'producedBy'>>(records: readonly T[]): T[] {
  return records.filter((record) => !isLocalOnly(record));
}
