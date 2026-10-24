/**
 * Brief check (3.37.0, CONTRACT S4zj). Dry probes from real post-cut states (w17 cold run 4,
 * 2026-10-02): 0 of 8 agents called search_session or opened the saved task brief after an S4
 * cut, though the seed pointed at both; the seed's checklist looked complete to them, and four
 * exact strings the brief listed went missing from the tests. So the plugin runs the search
 * itself: a cut that had a saved brief writes `armed` to this file and starts
 * recall/brief-check.mjs detached, which replaces it with the found lines (JSON) or `empty`. The
 * main loop's first attempt to stop after the cut reads it and, with lines, is blocked once with
 * the brief lines that name files, tests, checks, exact strings and frozen parts. The stop writes
 * `done` whatever it found, so the check never fires twice for one cut and never loops.
 */
export const BRIEF_CHECK_FILE = 's4-brief-check.json';
export const BRIEF_CHECK_ARMED = 'armed';
export const BRIEF_CHECK_EMPTY = 'empty';
export const BRIEF_CHECK_DONE = 'done';
export const BRIEF_CHECK_TIMEOUT_MS = 20_000;

export type BriefCheckFound = {
  brief: string;
  path: string;
  /** The whole brief (it fit CHECK_FULL_MAX_CHARS), not the lines picked for the check. */
  whole: boolean;
  lines: readonly { line: number; text: string }[];
  text: string;
};

/** The JSON brief-check.mjs prints, or undefined when it holds no usable lines. */
export function parseBriefCheck(stdout: string): BriefCheckFound | undefined {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return undefined; }
  if (!value || typeof value !== 'object') return undefined;
  const found = value as Partial<BriefCheckFound>;
  if (typeof found.path !== 'string' || typeof found.text !== 'string' || !Array.isArray(found.lines) || !found.lines.length) return undefined;
  return { brief: String(found.brief ?? ''), path: found.path, whole: found.whole === true, lines: found.lines, text: found.text };
}

/** The block reason the model reads: the lines, where they come from, and what to do with them. */
export function renderBriefCheckReason(found: BriefCheckFound): string {
  return [
    found.whole
      ? `Before you finish: context was compacted during this task, so check your work against the saved task brief. Here it is in full, from ${found.path} (line: text):`
      : `Before you finish: context was compacted during this task, so check your work against the saved task brief. Lines from ${found.path} about files, tests, final checks, exact strings and frozen parts (line: text):`,
    '',
    found.text,
    '',
    'Check each line against the files themselves, not from memory: where a line lists exact strings, names or values for a file, grep every one of them in that file (one command per file, all strings at once) and add whatever is missing; check counts and limits with a command too. Where the brief gives the exact form (a default value, an explicit comparison, a prop, a literal text), write that form: code that does the same thing in other words does not satisfy the line, and a missing string is a miss to fix, not a pattern to explain away. Then rerun the checks the brief names. Read the full brief at that path, or call search_session, if you need a line\'s context. Then write your final report again, in full, as your last message: this check does not replace it, so it keeps everything the user asked of a final report in this session (its first and last lines, its language, its sections), and it says which brief lines you checked and what you fixed.',
  ].join('\n');
}
