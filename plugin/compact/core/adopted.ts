import type { TokenCounter } from './types.js';

/**
 * 3.34.0: rules files the user adopted. Live A/B wave 17 cold run (a multi-package monorepo, r16 → r13, 2026-10-02): the user said
 * "read <dir>/house-rules.md (my rules for this whole session; the file is deleted after this task)". The model read it
 * with `cat` in Bash, the rules have no marker words ("The first line of every final report is ..."), and the adoption
 * phrase named neither "follow" nor "obey", so `extractAdoptedFileConstraints` found nothing. After the first cut the
 * seed held two rules as stray output fragments, and the next report broke both rules it lost. Now a rules file named
 * in a request is copied when the request is sent, however the model reads it later, and every seed quotes the copy.
 * Pure: the host resolves paths, redacts, reads and writes the files.
 */
export const ADOPTED_MAX_FILES = 3;
/** A file this large is a document, not a rules list; nothing is copied. */
export const ADOPTED_MAX_CHARS = 12000;
/** Upper bound for the quoted block; the caller lowers it with the seed budget. */
export const ADOPTED_BUDGET_TOKENS = 1500;

const DOC_PATH = /(?<![\p{L}\p{N}_.\/~-])(?:~?\.{0,2}\/)?[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)*\.(?:md|mdc|txt|rst)(?![\p{L}\p{N}_\/-]|\.[\p{L}\p{N}_])/giu;
// Polish cues: the plugin also reads rules written in Polish.
const READ_CUE = /(?<![\p{L}\p{N}_])(?:read|re-read|look at|open|load|przeczytaj|zobacz|otwórz|wczytaj)(?![\p{L}\p{N}_])/iu;
/** Tested with the paths taken out, so `eslint-rules.md` never calls itself rules. */
const RULE_CUE = /(?<![\p{L}\p{N}_])(?:rules|instructions|guidelines|conventions|follow (?:it|them|this|these|that|those|its|the (?:rules|instructions|guidelines|conventions))|obey|adhere to|remember (?:it|its contents|them|this|these|everything)|zasady|reguły|regulamin|wytyczne|instrukcje|stosuj się|przestrzegaj|zapamiętaj)(?![\p{L}\p{N}_])/iu;
/** A revoking phrase governs a path only right before it ("stop following house-rules.md") or right after it ("STYLE.md no longer applies"). */
const REVOKE_BEFORE = /(?<![\p{L}\p{N}_])(?:stop following|stop using|don't follow|do not follow|no longer follow|ignore|przestań stosować|nie stosuj|już nie stosuj|zignoruj|zapomnij o)\s+(?:the\s+|plik\s+|file\s+)?[`'"]?$/iu;
const REVOKE_AFTER = /^[`'"]?\s*(?:no longer applies|is no longer (?:valid|in force|needed)|does not apply|doesn't apply|is obsolete|już nie obowiązuje|nie obowiązuje|jest nieaktualn\p{L}*)(?![\p{L}\p{N}_])/iu;

/** Paths a sentence revokes. */
function revokedInSentence(sentence: string): string[] {
  const revoked: string[] = [];
  for (const match of sentence.matchAll(DOC_PATH)) {
    const before = sentence.slice(Math.max(0, match.index - 40), match.index);
    const after = sentence.slice(match.index + match[0].length, match.index + match[0].length + 40);
    if (REVOKE_BEFORE.test(before) || REVOKE_AFTER.test(after)) revoked.push(match[0]);
  }
  return revoked;
}

/** Sentences of a user request split on end punctuation and line breaks; paths keep their dots. */
function requestSentences(text: string): string[] {
  return text.split(/\n\s*\n|(?<=[.!?])\s+(?=[\p{Lu}(`])|\n(?=\s*(?:[-*]|\d+[.)])\s)/u).map((part) => part.trim()).filter(Boolean);
}

/** Paths named in a sentence; a URL never matches, since its path segments follow a `/`. */
const pathsIn = (sentence: string): string[] => sentence.match(DOC_PATH) ?? [];
const withoutPaths = (sentence: string): string => sentence.replace(DOC_PATH, ' ');

/**
 * Paths of rules files a request adopts: a sentence that names a `.md`/`.mdc`/`.txt`/`.rst` file, asks to read it, and
 * calls it rules or instructions (or asks to follow, obey or remember it). A brief that lists source files to edit names
 * none of these. Order kept, duplicates dropped, at most `ADOPTED_MAX_FILES`.
 */
export function adoptedFileRefs(text: string): string[] {
  const refs: string[] = [];
  for (const sentence of requestSentences(text)) {
    if (sentence.length > 1200) continue;
    const rest = withoutPaths(sentence);
    if (!READ_CUE.test(rest) || !RULE_CUE.test(rest)) continue;
    const revoked = revokedInSentence(sentence);
    for (const path of pathsIn(sentence)) if (!refs.includes(path) && !revoked.includes(path)) refs.push(path);
  }
  return refs.slice(0, ADOPTED_MAX_FILES);
}

export interface AdoptedEntry {
  /** The path as the user wrote it, resolved against the session directory. */
  path: string;
  /** Where the copy is saved. */
  savedPath: string;
  chars: number;
  /** ISO time of the copy. */
  at: string;
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1).toLowerCase();

/** The entries a request revokes: a sentence with a revoking phrase that names the file ("stop following house-rules.md"). */
export function revokedAdopted(text: string, index: readonly AdoptedEntry[]): AdoptedEntry[] {
  const named = new Set(revokedNames(text));
  return index.filter((entry) => named.has(basename(entry.path)));
}

/** Lower-cased file names that a sentence with a revoking phrase names; empty for most requests. */
export function revokedNames(text: string): string[] {
  const names: string[] = [];
  for (const sentence of requestSentences(text)) {
    if (sentence.length > 1200) continue;
    for (const name of revokedInSentence(sentence).map(basename)) if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Parses adopted.json; anything malformed is dropped, never thrown. */
export function parseAdoptedIndex(text: string): AdoptedEntry[] {
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is AdoptedEntry => entry !== null && typeof entry === 'object'
      && typeof entry.path === 'string' && typeof entry.savedPath === 'string' && typeof entry.chars === 'number' && typeof entry.at === 'string');
  } catch { return []; }
}

/** The index after adopting `entry`: a newer copy of the same path replaces the older one; the newest `ADOPTED_MAX_FILES` stay. */
export function addAdopted(index: readonly AdoptedEntry[], entry: AdoptedEntry): AdoptedEntry[] {
  return [...index.filter((old) => old.path !== entry.path), entry].slice(-ADOPTED_MAX_FILES);
}

/**
 * The block at the top of the constraints section, or '' without copies. Every file is quoted whole while the whole
 * rendered block fits `budgetTokens`; past that each file keeps as many of its first lines as fit an equal share and
 * names its saved copy for the rest (at budget 0, only the header and the copy's path). Quoted lines are tag-neutralized,
 * so a file cannot close the seed's wrapper.
 */
export function renderAdoptedFiles(files: readonly { entry: AdoptedEntry; text: string }[], budgetTokens: number, countTokens: TokenCounter): string {
  if (!files.length) return '';
  const quote = (lines: readonly string[]) => lines.map((line) => (line ? `> ${neutralizeTags(line)}` : '>')).join('\n');
  const header = (entry: AdoptedEntry) => `Rules file the user adopted: ${entry.path} (copied ${entry.at.slice(0, 16).replace('T', ' ')}; the original may be gone):`;
  const footer = 'Later user messages override these files where they conflict.';
  const whole = `${files.map(({ entry, text }) => `${header(entry)}\n${quote(text.trimEnd().split('\n'))}`).join('\n\n')}\n${footer}`;
  if (countTokens(whole) <= budgetTokens) return whole;
  const share = Math.floor(budgetTokens / files.length);
  const blocks = files.map(({ entry, text }) => {
    const lines = text.trimEnd().split('\n');
    const block = (kept: number) => `${header(entry)}\n${kept ? `${quote(lines.slice(0, kept))}\n` : ''}(${kept ? `first ${kept} of ${lines.length} lines` : 'not quoted here'}; full copy: ${entry.savedPath})`;
    let low = 0;
    let high = lines.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (countTokens(block(middle)) <= share) low = middle;
      else high = middle - 1;
    }
    return block(low);
  });
  return `${blocks.join('\n\n')}\n${footer}`;
}

/**
 * Closing tags and harness or memory tags lose their `<`, so a quoted file cannot close the seed's wrapper or pose as a
 * harness block; a placeholder such as `SLICE <id> DONE` stays as written (`neutralizeMemoryTags` in dense.ts would
 * turn it into `‹id>`, which changes the rule).
 */
export function neutralizeTags(line: string): string {
  return line
    .replace(/(?:<|\uFF1C|\uFE64|&lt;|&#0*60;|&#x0*3c;)\//gi, '‹/')
    .replace(/(?:<|\uFF1C|\uFE64|&lt;|&#0*60;|&#x0*3c;)(?=(?:session-memory|system-reminder|system|task-notification|pasted_content|antml|function_calls|function_results|invoke|parameter|command-[\w-]+|local-command-[\w-]+|user-prompt-submit-hook)(?![\w-]))/gi, '‹');
}

/** `ref` as an absolute path: `~/` from `home`, a relative path from `cwd`; `.` and `..` segments folded. Undefined for `~/` without a home. */
export function resolveAdoptedPath(ref: string, cwd: string, home: string): string | undefined {
  if (ref.startsWith('~/') && !home) return undefined;
  const joined = ref.startsWith('/') ? ref : ref.startsWith('~/') ? `${home}/${ref.slice(2)}` : `${cwd}/${ref}`;
  const parts: string[] = [];
  for (const part of joined.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  return `/${parts.join('/')}`;
}
