import type { TokenCounter } from './types.js';

/**
 * 3.31.0 (CONTRACT S4ze): the task brief. Live A/B on a real 10k-token brief (a monorepo task t3, 2026-10-01):
 * the seed kept ~3k tokens of it, the agent said it "could not re-read the brief's numbered file list",
 * never called search_session, and failed the brief's size caps and test pins. A long user request is
 * saved verbatim to a file when it is sent (recall/brief.mjs), a model writes its checklist in the
 * background, and the seed carries the path, the checklist (or the brief's start) and a line saying
 * the file is the full text. Pure: the host reads the index and the files.
 */
export const BRIEF_MIN_CHARS = 2500;
export const BRIEF_BUDGET_TOKENS = 3000;
export const BRIEF_HEAD_CHARS = 1500;
export const BRIEF_MAX_LISTED = 3;
/**
 * 3.39.0: the newest brief goes into the seed whole, verbatim, when it is at most this long (about 6k tokens).
 * W17 at a 60k window (2026-10-02): the seed carried a model-written checklist of the r4 brief that named "D5"
 * without its content and lost every exact string the gate pinned (`entries={visible}`, `entries = []`,
 * `!== null`, "is not in this view"); native compaction's summary kept all of them (r4 native 28/28, plugin 25/28).
 */
export const BRIEF_FULL_MAX_CHARS = 24_000;
/** The tail keeps at least this share of its budget when a whole brief takes tokens from it. */
export const BRIEF_MIN_TAIL_SHARE = 0.3;

export interface BriefEntry {
  /** First 12 hex characters of sha256 of the saved text; the file is `<dir>/<id>.md`. */
  id: string;
  path: string;
  chars: number;
  /** ISO time the brief was saved. */
  at: string;
  firstLine: string;
}

/** Parses briefs.json; anything malformed is dropped, never thrown. */
export function parseBriefIndex(text: string): BriefEntry[] {
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is BriefEntry => entry !== null && typeof entry === 'object'
      && typeof entry.id === 'string' && /^[0-9a-f]{12}$/.test(entry.id) && typeof entry.path === 'string'
      && typeof entry.chars === 'number' && typeof entry.at === 'string' && typeof entry.firstLine === 'string');
  } catch { return []; }
}

const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** A checklist split at its `### ` headings; lines before the first heading form a section without one. */
function checklistSections(digest: string): { heading?: string; items: string[] }[] {
  const sections: { heading?: string; items: string[] }[] = [];
  for (const line of digest.split('\n')) {
    if (line.startsWith('### ')) sections.push({ heading: line, items: [] });
    else if (line.trim()) {
      if (!sections.length) sections.push({ items: [] });
      sections[sections.length - 1]!.items.push(line);
    }
  }
  return sections;
}

/**
 * The seed section body, or '' without briefs. The newest brief gets its checklist (`digest`) or, while
 * that is not written yet, its first `BRIEF_HEAD_CHARS` characters (`head`); older ones get a path line.
 * A checklist over `budgetTokens` keeps every heading and the first k items of each section, k as large
 * as fits (a real checklist ran 8k tokens: cutting from the end lost its test and check sections); the
 * full checklist file (`digestPath`) is named for the rest.
 * 3.36.0 (S4zi): the intro sends the agent to search_session with scope "brief" (line-level search of the
 * saved briefs, recall/brief-search.mjs) instead of Grep: in w17 the agent grepped a guessed word and
 * missed the line naming a test file. `sessionId` goes into the call it shows.
 * 3.39.0: with `full` (the newest brief's text) and room for it, the section is that text whole and verbatim;
 * otherwise the checklist as above.
 */
export function renderTaskBriefs(
  entries: readonly BriefEntry[],
  newest: { digest?: string; head?: string; digestPath?: string; sessionId?: string; full?: string },
  countTokens: TokenCounter,
  budgetTokens: number = BRIEF_BUDGET_TOKENS,
): string {
  const listed = entries.slice(-BRIEF_MAX_LISTED);
  if (!listed.length) return '';
  const call = `search_session with scope "brief"${newest.sessionId ? ` (session "${newest.sessionId}")` : ''}`;
  const saved = listed.length === 1
    ? 'The user\'s task brief was saved verbatim when it was sent; this memory keeps only part of it.'
    : 'The user\'s long requests were saved verbatim when they were sent; this memory keeps only part of them.';
  const intro = `${saved} For a requirement that is not here word for word (a file name, a cap, a count, an exact string, a check to run), ask ${call} a plain question: it searches the saved briefs line by line, newest first, and gives file:line, so you Read only those lines. Before the final checks, ask it for the brief's files, tests and checks and compare them with your work.`;
  const lines = listed.map((entry) => `- ${entry.path} (${entry.chars} chars, sent ${entry.at.slice(0, 16).replace('T', ' ')}): "${oneLine(entry.firstLine, 120)}"`);
  const head = [intro, ...lines].join('\n');
  const full = newest.full?.trim();
  if (full) {
    const whole = [`The newest brief is below verbatim and complete (${listed[listed.length - 1]!.path}); it is the task's specification, so follow its exact names, strings, values and forms.${listed.length > 1 ? ' Older long requests are on disk:' : ''}`, ...lines.slice(0, -1)].join('\n');
    // Tagged so the brief's own `## ` headings read as part of it, not as seed sections.
    const text = `${whole}\n\n<task-brief>\n${full}\n</task-brief>`;
    if (countTokens(text) <= budgetTokens) return text;
  }
  const digest = newest.digest?.trim();
  if (!digest) {
    const start = oneLineSafe(newest.head ?? '');
    return start.trim() ? `${head}\n\nStart of the newest brief, verbatim (its checklist is not written yet):\n${start}` : head;
  }
  const label = `Checklist of the newest brief (written by a model from the file; the file wins where they differ)${newest.digestPath ? `; full checklist: ${newest.digestPath}` : ''}:`;
  const sections = checklistSections(digest);
  const total = sections.reduce((sum, section) => sum + section.items.length, 0);
  const build = (perSection: number): string => {
    const shown = sections.flatMap((section) => [...(section.heading ? [section.heading] : []), ...section.items.slice(0, perSection)]);
    const hidden = total - sections.reduce((sum, section) => sum + Math.min(section.items.length, perSection), 0);
    return `${head}\n\n${label}\n${shown.join('\n')}${hidden > 0 ? `\n[… ${hidden} more checklist lines in the full checklist; the brief search finds them too]` : ''}`;
  };
  const most = Math.max(0, ...sections.map((section) => section.items.length));
  let perSection = most;
  while (perSection > 0 && countTokens(build(perSection)) > budgetTokens) perSection -= 1;
  return countTokens(build(perSection)) <= budgetTokens ? build(perSection) : head;
}

/** The head as given, trimmed to whole lines when it was cut mid-line. */
function oneLineSafe(head: string): string {
  const trimmed = head.trimEnd();
  if (trimmed.length < BRIEF_HEAD_CHARS) return trimmed;
  const lastBreak = trimmed.lastIndexOf('\n');
  return lastBreak > BRIEF_HEAD_CHARS / 2 ? trimmed.slice(0, lastBreak) : trimmed;
}
