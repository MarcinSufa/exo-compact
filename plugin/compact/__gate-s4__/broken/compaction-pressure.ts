import type { CompactionPressureState } from '../../core/compaction-pressure.js';

export const PRESSURE_USER_TURNS = 3;
export function parseCompactionPressureState(raw: string | null): { state: CompactionPressureState | null; unreadable: boolean } {
  if (raw === null) return { state: null, unreadable: true };
  try { return { state: JSON.parse(raw) as CompactionPressureState, unreadable: false }; }
  catch { return { state: null, unreadable: true }; }
}
export function advanceCompactionPressure(previous: CompactionPressureState | null, captureSeq: number, userRecordCount: number) {
  return {
    state: { ordinal: (previous?.ordinal ?? 0) + 1, captureSeq, userRecordCount, userRecordsSincePreviousCompaction: 0, consecutivePressure: 0 },
    pressure: null,
  };
}
export function renderCompactionPressure(): string { return ''; }
