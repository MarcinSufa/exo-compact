/**
 * Brief push (3.40.0, CONTRACT S4zl). After a cut the agent never searches for what it lost (0 search_session calls
 * in ~10 long w17 runs), so the plugin searches for it: a cut that had a saved brief creates this state file, and
 * from then on every write (Write, Edit, MultiEdit, NotebookEdit, or a Bash command that writes a file: after a cut
 * the w17 agents wrote every file through Bash heredocs) runs recall/brief-push.mjs, which returns the newest brief's
 * lines for the files being written that were not shown yet; they go to the model with the call
 * (additionalContext). A short prompt after a cut gets the lines for its words the same way. A new brief (a long
 * prompt) removes the file: the new task's brief is in context, whole, until the next cut. Offline replay of the
 * w17 post-cut writes: the pushed lines held 99.3% (dev) and 97.1% (held-out) of the strings the gate greps for in
 * the files written.
 */
export const BRIEF_PUSH_FILE = 's4-brief-push.json';
export const BRIEF_PUSH_ARMED = '{}';
export const BRIEF_PUSH_OFF = 'off';
export const BRIEF_PUSH_TIMEOUT_MS = 4000;

export type BriefPushInput = { files: string[]; text: string } | { prompt: string };

export type BriefPushFound = {
  brief: string;
  path: string;
  lines: readonly { line: number; text: string }[];
  text: string;
};

const FILE = /[\w./-]+\.(?:tsx?|jsx?|mjs|cjs|css|scss|json|md|ya?ml|sh|py|html|sql|toml)\b/g;
const OUTSIDE = /^\/(?:tmp|dev|proc)\//;

/** The files a Bash command writes (redirect and tee targets; every file it names when it edits in place), max 4. */
export function bashWrites(command: string): string[] {
  const targets = [...command.matchAll(/(?:>>?|\btee(?:\s+-a)?)\s*['"]?([\w./-]+\.\w+)/g)].map((m) => m[1]!);
  const inPlace = /\bsed\s+(?:-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-z]*i|writeFileSync|write_text|\.write\(|open\([^)]*['"][wa]|\bgit\s+apply|\bpatch\b/.test(command);
  const files = inPlace ? [...targets, ...(command.match(FILE) ?? [])] : targets;
  const out: string[] = [];
  for (const file of files) {
    if (OUTSIDE.test(file) || file.startsWith('../') || !new RegExp(FILE.source).test(file) || out.includes(file)) continue;
    out.push(file);
  }
  return out.slice(0, 4);
}

/** What a tool call writes ({ files, text }), or undefined for a call that writes no file. */
export function pushTarget(call: { tool: string; [argument: string]: unknown }): { files: string[]; text: string } | undefined {
  const str = (value: unknown) => (typeof value === 'string' ? value : '');
  if (call.tool === 'Bash') {
    const command = str(call.command);
    const files = bashWrites(command);
    return files.length ? { files, text: command } : undefined;
  }
  if (call.tool === 'Write' || call.tool === 'Edit' || call.tool === 'MultiEdit' || call.tool === 'NotebookEdit') {
    const file = str(call.file_path) || str(call.notebook_path);
    if (!file) return undefined;
    const edits = Array.isArray(call.edits) ? call.edits.map((edit) => str((edit as { new_string?: unknown } | null)?.new_string)) : [];
    return { files: [file], text: [str(call.content), str(call.new_string), str(call.new_source), ...edits].filter(Boolean).join('\n') };
  }
  return undefined;
}

/** The JSON brief-push.mjs prints, or undefined when it holds no lines. */
export function parseBriefPush(stdout: string): BriefPushFound | undefined {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return undefined; }
  if (!value || typeof value !== 'object') return undefined;
  const found = value as Partial<BriefPushFound>;
  if (typeof found.path !== 'string' || typeof found.text !== 'string' || !found.text || !Array.isArray(found.lines) || !found.lines.length) return undefined;
  return { brief: String(found.brief ?? ''), path: found.path, lines: found.lines, text: found.text };
}

/** The note the model reads with the call: what the lines are, that they apply now, and what to do with them. */
export function renderBriefPush(found: BriefPushFound, what: { files: readonly string[] } | { prompt: true }): string {
  const about = 'files' in what ? `for ${what.files.join(', ')}, the file${what.files.length > 1 ? 's' : ''} this call writes` : 'for this message';
  return [
    `Task brief lines ${about} (context was compacted; these are the saved brief's own words, from ${found.path}, line: text):`,
    found.text,
    'They apply now: the code must contain their exact names, strings, numbers and limits, in the form they give. Compare before you continue and fix any difference.',
  ].join('\n');
}

/**
 * Brief limits (3.41.0, CONTRACT S4zm). The model breaks a limit it has been shown: w17 r17 with the push shipped a
 * 161-character test line under the brief's "no line over 160 characters" (gate 32/33). So after a write, the lines
 * the call added (git diff against HEAD, an untracked file whole) are checked against the line-length limits the
 * newest brief states, by `recall/brief-push.mjs limits`; a sentence per file over the limit goes to the model. A
 * clean write adds nothing.
 */
export const BRIEF_LIMITS_TIMEOUT_MS = 3000;

/** The sentences `brief-push.mjs limits` prints, or [] for anything else. */
export function parseBriefLimits(stdout: string): string[] {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return []; }
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0).slice(0, 6) : [];
}

/** The note the model reads after a write that broke a line-length limit of the brief. */
export function renderBriefLimits(warnings: readonly string[]): string {
  return [`Limit check after this write: ${warnings.join(' ')}`, 'Shorten those lines now (split the string or the call), then continue.'].join('\n');
}
