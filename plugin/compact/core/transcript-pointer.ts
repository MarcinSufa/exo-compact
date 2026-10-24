/**
 * Full-transcript pointer (spec §3.1.2). Why: a pointer the model cannot resolve is a dead end
 * (oh-my-pi `history://current/full`, Cursor's searchable history).
 */

/** Legacy v3.4.6 instruction retained exactly while recall is disabled. */
export const TRANSCRIPT_POINTER_INSTRUCTION =
  'This seed is a filtered subset: a fact delivered via a file read or a tool result is not ' +
  'in it. Before answering UNKNOWN or guessing about an earlier detail, Grep this file with a ' +
  'bounded pattern, e.g. `.{0,200}TERM.{0,200}` (lines are very long), content mode, not count mode.';

/**
 * Picks the transcript path (spec §3.1.2): `transcript_path` of the newest classic-hook input
 * recorded in the run log, if the run log has it; otherwise the path derived from
 * `$.session.id()` under the project transcript dir. Pure: both candidates are already-resolved
 * strings (or `null`), so the caller (a host closure in `compact.ts`) does the actual lookup and
 * derivation, per `core/`'s no-I/O rule.
 *
 * CONTRACT.md's S4d section records the finding this priority order is built for: as of this
 * slice, no run-log record body anywhere in `proxy/hooks/exovault-hook.cjs` or
 * `proxy/hooks/rotation.cjs` carries a bare `transcript_path` field (only a derived `version`
 * string, or the *separate*, non-run-log rotation state file), so `runLogTranscriptPath` is
 * always `null` in practice today and this always falls through to `derivedPath`. The parameter
 * stays so a run log that starts recording it needs no change here.
 */
export function resolveTranscriptPath(runLogTranscriptPath: string | null, derivedPath: string | null): string | null {
  return runLogTranscriptPath ?? derivedPath;
}

/** Absolute transcript path followed by recall instructions or the disabled-mode fallback. */
export function renderTranscriptPointer(path: string, recall?: { sessionId: string }): string {
  const instruction = recall
    ? `Context note: this seed keeps only part of the earlier session; file contents read earlier, command output, exact values, ids and decisions are searchable with the search_session tool (server recall) using session "${recall.sessionId}": ask a short question in plain words and include any specific name you know (a path, an id, a setting). Its short excerpts cost far less than re-reading files, so it is the first place to look for an earlier detail, including before answering UNKNOWN or acting on an earlier setting, value or decision; a later message wins over an older seed fact. The transcript path above is the fallback.`
    : TRANSCRIPT_POINTER_INSTRUCTION;
  return `${path}\n\n${instruction}`;
}
