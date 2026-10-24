/** Pure bookkeeping for repeated compactions with too few intervening user turns. */
export const PRESSURE_USER_TURNS = 3;
/**
 * Assistant tool uses since the previous cut, not counting the ones in the tail that cut kept.
 * Narration is not work (review-opus-s4e P2): a re-read loop that narrates still does few tool
 * calls, while a quiet autonomous run that reads many files does many.
 */
export const PRESSURE_TOOL_USES = 15;

export interface CompactionWork {
  /** Assistant tool uses in the compacted messages after the most recent seed or summary. */
  toolUsesSinceCut: number;
  /** Assistant tool uses in the tail this cut keeps; subtracted at the next cut. */
  tailToolUses: number;
  /** A manual /compact is the user's choice, never pressure. */
  manual: boolean;
}

export interface CompactionPressureState {
  ordinal: number;
  captureSeq: number;
  userRecordCount: number;
  userRecordsSincePreviousCompaction: number;
  consecutivePressure: number;
  /** Absent in state written before v3.6.0; read as 0. */
  tailToolUses?: number;
}

export interface CompactionPressure {
  userTurns: number;
  consecutive: number;
}

export function parseCompactionPressureState(raw: string | null): { state: CompactionPressureState | null; unreadable: boolean } {
  if (raw === null) return { state: null, unreadable: true };
  try {
    const value = JSON.parse(raw) as Partial<CompactionPressureState>;
    if (!Number.isInteger(value.ordinal) || value.ordinal! < 1 || !Number.isInteger(value.captureSeq) || value.captureSeq! < 0 ||
      !Number.isInteger(value.userRecordCount) || value.userRecordCount! < 0 || !Number.isInteger(value.userRecordsSincePreviousCompaction) ||
      value.userRecordsSincePreviousCompaction! < 0 || !Number.isInteger(value.consecutivePressure) || value.consecutivePressure! < 0) {
      return { state: null, unreadable: true };
    }
    return { state: value as CompactionPressureState, unreadable: false };
  } catch {
    return { state: null, unreadable: true };
  }
}

export function advanceCompactionPressure(
  previous: CompactionPressureState | null,
  captureSeq: number,
  userRecordCount: number,
  work: CompactionWork,
): { state: CompactionPressureState; pressure: CompactionPressure | null } {
  const userTurns = previous ? Math.max(0, userRecordCount - previous.userRecordCount) : 0;
  const toolUses = Math.max(0, work.toolUsesSinceCut - (previous?.tailToolUses ?? 0));
  const pressured = previous !== null && !work.manual && userTurns < PRESSURE_USER_TURNS && toolUses < PRESSURE_TOOL_USES;
  const consecutive = pressured ? previous.consecutivePressure + 1 : 0;
  return {
    state: {
      ordinal: (previous?.ordinal ?? 0) + 1,
      captureSeq,
      userRecordCount,
      userRecordsSincePreviousCompaction: userTurns,
      consecutivePressure: consecutive,
      tailToolUses: work.tailToolUses,
    },
    pressure: pressured ? { userTurns, consecutive } : null,
  };
}

export function renderCompactionPressure(pressure: CompactionPressure): string {
  const base = `Context was compacted again after only ${pressure.userTurns} user turns. Read files with a line range or bounded Grep, use recall instead of re-reading, and finish this step and report progress before starting the next.`;
  return pressure.consecutive >= 3
    ? `${base} Stop and tell the user or calling agent that the task does not fit the context and should be split; list what is done and what remains.`
    : base;
}
