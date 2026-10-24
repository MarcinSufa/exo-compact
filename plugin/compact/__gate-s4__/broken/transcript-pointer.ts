export const TRANSCRIPT_POINTER_INSTRUCTION =
  'History before the omitted-history marker above is in this file. Search it with Grep for an ' +
  'exact term before re-reading source files or asking the user. Tool-result pointers name a ' +
  'tool_use_id; grep the file for it, not a line number.';

/**
 * Mutation-proof defect (spec §3.1.2, "the run log's `transcript_path`, if the run log has it,
 * otherwise derived from `$.session.id()`"): the run-log candidate is dropped, so the derived
 * path always wins even when a real recorded `transcript_path` was available. `renderTranscriptPointer`
 * is otherwise the same working copy as `core/transcript-pointer.ts`.
 */
export function resolveTranscriptPath(_runLogTranscriptPath: string | null, derivedPath: string | null): string | null {
  return derivedPath;
}

export function renderTranscriptPointer(path: string): string {
  return `${path}\n\n${TRANSCRIPT_POINTER_INSTRUCTION}`;
}
