import type { SessionMessage } from './types.js';

/**
 * S4h: the seed's File pointers section, built from the tool calls in the pre-cut messages.
 *
 * Paths and line ranges only, never content: measured on 34 real cuts (tools/reread-measure.mjs),
 * re-attaching file content cost 2-3x the tokens it saved, so the seed only tells the model where
 * it already looked. With that it can re-read the one range it needs instead of the whole file.
 */

export const FILE_POINTERS_MAX_ENTRIES = 20;
const MAX_RANGES_PER_FILE = 4;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|bmp|svg|ico|tiff?|avif|heic)$/i;
const READ_VERBS = new Set(['cat', 'head', 'tail', 'nl', 'sed']);
const PATHISH = /^[~./\w-][\w./~@+-]*\.[A-Za-z0-9]{1,8}$/;

interface Entry { path: string; edited: boolean; ranges: string[]; order: number }

function joinPath(base: string | undefined, file: string): string {
  if (!base || file.startsWith('/') || file.startsWith('~')) return file;
  return `${base.replace(/\/$/, '')}/${file.replace(/^\.\//, '')}`;
}

function sedRange(script: string): string {
  const match = /^(\d+)(?:,(\d+|\$))?p$/.exec(script);
  if (!match) return 'partial';
  return match[2] ? `${match[1]}-${match[2] === '$' ? 'end' : match[2]}` : match[1];
}

/** Drops heredoc bodies (`<<EOF ... EOF`, `<<-'X' ... X`), which are data, not commands. */
function stripHeredocs(command: string): string {
  const lines = command.split('\n');
  const out: string[] = [];
  let terminator: string | null = null;
  for (const line of lines) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null;
      continue;
    }
    out.push(line);
    // `<<<` is a here-string, not a heredoc; a `<<` inside quotes is still a known false negative.
    const heredoc = /(?<!<)<<-?(?!<)\s*(['"]?)([A-Za-z_]\w*)\1/.exec(line);
    if (heredoc) terminator = heredoc[2];
  }
  return out.join('\n');
}

const REDIRECT_OUT = '\0>';
const REDIRECT_IN = '\0<';
const HEREDOC_WORD = '\0<<';
const SUBSHELL_OPEN = '\0(';
const SUBSHELL_CLOSE = '\0)';

/**
 * Minimal shell split: segments at `;`, `&&`, `||`, `|`, `&` and newlines outside quotes, each a
 * list of words with quotes removed. A quoted string is one word, so text inside a commit
 * message or an echo never reaches command position. Redirections become marker words
 * (`> x`, `>> x`, `2> x`, `&> x` write; `< x` reads; `<<`/`<<<` take a delimiter or string),
 * and `(` / `)` become marker segments so a `cd` inside a subshell does not leak out.
 */
function segments(command: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: string | null = null;
  const endWord = () => { if (inWord) words.push(word); word = ''; inWord = false; };
  const endSegment = () => { endWord(); if (words.length) out.push(words); words = []; };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; inWord = true; continue; }
    if (c === '\\' && i + 1 < command.length) { word += command[++i]; inWord = true; continue; }
    if (c === '>' || (c === '&' && command[i + 1] === '>')) {
      if (c === '&') i += 1;
      else if (inWord && /^\d+$/.test(word)) { word = ''; inWord = false; }
      endWord();
      while (command[i + 1] === '>' || command[i + 1] === '&' || command[i + 1] === '|') i += 1;
      words.push(REDIRECT_OUT);
      continue;
    }
    if (c === '<') {
      endWord();
      let run = 1;
      while (command[i + 1] === '<') { run += 1; i += 1; }
      if (command[i + 1] === '-') i += 1;
      words.push(run === 1 ? REDIRECT_IN : HEREDOC_WORD);
      continue;
    }
    if (c === '(' || c === ')') { endSegment(); out.push([c === '(' ? SUBSHELL_OPEN : SUBSHELL_CLOSE]); continue; }
    if (c === ';' || c === '\n' || c === '|' || c === '&') { endSegment(); continue; }
    if (c === ' ' || c === '\t') { endWord(); continue; }
    word += c; inWord = true;
  }
  endSegment();
  return out;
}

/** `[path, range | undefined]` for each file a Bash command reads, `cd` applied in order. */
export function bashFileReads(command: string): Array<[string, string | undefined]> {
  const out: Array<[string, string | undefined]> = [];
  let base: string | undefined;
  const saved: Array<string | undefined> = [];
  for (const raw of segments(stripHeredocs(command))) {
    if (raw[0] === SUBSHELL_OPEN) { saved.push(base); continue; }
    if (raw[0] === SUBSHELL_CLOSE) { if (saved.length) base = saved.pop(); continue; }
    const words: string[] = [];
    const inputs: string[] = [];
    for (let i = 0; i < raw.length; i += 1) {
      if (raw[i] === REDIRECT_OUT || raw[i] === HEREDOC_WORD) { i += 1; continue; }
      if (raw[i] === REDIRECT_IN) { if (i + 1 < raw.length) inputs.push(raw[++i]); continue; }
      words.push(raw[i]);
    }
    let at = 0;
    while (at < words.length && /^[A-Za-z_]\w*=/.test(words[at])) at += 1;
    const verb = words[at];
    const args = words.slice(at + 1);
    if (verb === 'cd') {
      const dir = args[0];
      // `cd -` and a bare `cd` go somewhere this parser cannot know, so relative paths stop resolving.
      base = dir === undefined || dir === '-' ? undefined : dir.startsWith('/') || dir.startsWith('~') ? dir : joinPath(base, dir);
      continue;
    }
    if (!READ_VERBS.has(verb)) continue;
    let range: string | undefined = verb === 'tail' ? 'tail' : undefined;
    const files: string[] = [...inputs];
    if (verb === 'sed') {
      if (!args.includes('-n')) continue;
      let script: string | undefined;
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '-e' && i + 1 < args.length) { script ??= args[++i]; continue; }
        if (arg.startsWith('-')) continue;
        if (script === undefined) { script = arg; continue; }
        files.push(arg);
      }
      range = sedRange(script ?? '');
    } else {
      if (verb === 'head') range = '1-10';
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '-c' || arg.startsWith('-c') || arg.startsWith('--bytes')) { range = 'partial'; if (arg === '-c') i += 1; continue; }
        // `-n` is a line count only for head/tail; for cat/nl it numbers lines and takes no value.
        const lines = verb === 'head' || verb === 'tail' ? /^(?:-n|--lines=?)(\S*)$/.exec(arg) : null;
        if (lines) {
          const count = lines[1] || args[++i] || '';
          if (verb === 'head') range = /^\d+$/.test(count) ? `1-${count}` : 'partial';
          continue;
        }
        const numeric = /^-(\d+)$/.exec(arg);
        if (numeric) { if (verb === 'head') range = `1-${numeric[1]}`; continue; }
        if (arg.startsWith('-')) continue;
        files.push(arg);
      }
    }
    for (const file of files) if (PATHISH.test(file) && !file.endsWith('.log')) out.push([joinPath(base, file), range]);
  }
  return out;
}

/** Verbs that write what a `>` redirect names (a test runner with `> log` is not a file write). */
const REDIRECT_WRITERS = new Set(['cat', 'echo', 'printf', 'true', ':', 'head', 'tail', 'sed', 'sort', 'jq', 'tr', 'cut', 'awk', 'base64']);
/** Verbs a command made only of file work may use; anything else (a test, a build) makes it a run. */
const FILE_WORK_VERBS = new Set([...REDIRECT_WRITERS, 'tee', 'mv', 'cp', 'cd', 'mkdir', 'chmod', 'touch', 'rm', 'export', 'set']);
/** Verbs that only read unless a `>` redirect (or `sed -i`) gives them a file to write; then they are other commands. */
const READ_UNLESS_WRITING = new Set(['sed', 'head', 'tail', 'cat']);

/** The files `sed -i` edits: its operands less the script, which is the first operand unless `-e`/`-f` gave it. */
function sedInPlaceFiles(args: readonly string[]): string[] {
  const operands: string[] = [];
  let scripted = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-e' || arg === '-f' || arg === '--expression' || arg === '--file') { scripted = true; i += 1; continue; }
    if (/^(?:-[ef].|--expression=|--file=)/.test(arg)) { scripted = true; continue; }
    if (!arg.startsWith('-')) operands.push(arg);
  }
  return scripted ? operands : operands.slice(1);
}

/**
 * 4.6.0 (S5f): the files a Bash command writes (`> f`, `>> f`, heredoc into `cat > f`, `tee`, `sed -i`, `mv`, `cp`) and
 * whether the command is nothing but file work. Detection is simple on purpose: a `>` counts only after a verb that
 * writes what it is given, so `pnpm test > out.log 2>&1` is a run, not a write.
 */
export function bashFileWrites(command: string): { files: string[]; fileWorkOnly: boolean } {
  const files: string[] = [];
  let fileWorkOnly = true;
  let base: string | undefined;
  const saved: Array<string | undefined> = [];
  for (const raw of segments(stripHeredocs(command))) {
    if (raw[0] === SUBSHELL_OPEN) { saved.push(base); continue; }
    if (raw[0] === SUBSHELL_CLOSE) { if (saved.length) base = saved.pop(); continue; }
    const words: string[] = [];
    const targets: string[] = [];
    for (let i = 0; i < raw.length; i += 1) {
      if (raw[i] === REDIRECT_OUT) { if (i + 1 < raw.length) targets.push(raw[++i]); continue; }
      if (raw[i] === HEREDOC_WORD || raw[i] === REDIRECT_IN) { i += 1; continue; }
      words.push(raw[i]);
    }
    let at = 0;
    while (at < words.length && /^[A-Za-z_]\w*=/.test(words[at])) at += 1;
    const verb = words[at];
    const args = words.slice(at + 1);
    const redirected = targets.filter((target) => !/^\d+$|^-$|^\/dev\/(?:null|stdout|stderr)$/.test(target));
    const inPlace = verb === 'sed' && args.some((arg) => /^-i|^--in-place/.test(arg));
    if (verb !== undefined && (!FILE_WORK_VERBS.has(verb) || (READ_UNLESS_WRITING.has(verb) && redirected.length === 0 && !inPlace))) fileWorkOnly = false;
    if (verb === 'cd') {
      const dir = args[0];
      base = dir === undefined || dir === '-' ? undefined : dir.startsWith('/') || dir.startsWith('~') ? dir : joinPath(base, dir);
      continue;
    }
    const written: string[] = [];
    if (verb === undefined || REDIRECT_WRITERS.has(verb)) written.push(...redirected);
    const plain = args.filter((arg) => !arg.startsWith('-'));
    if (verb === 'tee') written.push(...plain);
    else if (inPlace) written.push(...sedInPlaceFiles(args));
    else if ((verb === 'mv' || verb === 'cp') && plain.length >= 2) written.push(plain[plain.length - 1]);
    for (const file of written) files.push(joinPath(base, file));
  }
  return { files: [...new Set(files)], fileWorkOnly };
}

function readRange(input: Record<string, unknown>): string | undefined {
  const offset = typeof input.offset === 'number' ? input.offset : undefined;
  const limit = typeof input.limit === 'number' ? input.limit : undefined;
  if (offset === undefined && limit === undefined) return undefined;
  const start = offset ?? 1;
  return limit === undefined ? `${start}-end` : `${start}-${start + limit - 1}`;
}

/** Most recently touched first, at most `maxEntries` lines like `a/b.ts (edited; read 60-260)`. */
export function collectFilePointers(messages: readonly SessionMessage[], maxEntries = FILE_POINTERS_MAX_ENTRIES): string[] {
  const entries = new Map<string, Entry>();
  let order = 0;
  const touch = (path: string, edited: boolean, range: string | undefined) => {
    // S4j: a screenshot the model looked at is not something it will re-read to continue; on a
    // live cut they took 7 of 16 slots. An image it wrote is kept.
    if (!edited && IMAGE_FILE.test(path)) return;
    const entry = entries.get(path) ?? { path, edited: false, ranges: [], order: 0 };
    entry.order = ++order;
    entry.edited ||= edited;
    if (!edited) {
      const label = range ?? 'whole';
      entry.ranges = [...entry.ranges.filter((r) => r !== label), label].slice(-MAX_RANGES_PER_FILE);
    }
    entries.set(path, entry);
  };
  for (const message of messages) {
    for (const use of message.toolUses ?? []) {
      if (!use.input || typeof use.input !== 'object') continue;
      const input = use.input as Record<string, unknown>;
      const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined;
      if (use.tool === 'Read' && file) touch(file, false, readRange(input));
      else if (EDIT_TOOLS.has(use.tool) && file) touch(file, true, undefined);
      else if (use.tool === 'Bash' && typeof input.command === 'string') for (const [path, range] of bashFileReads(input.command)) touch(path, false, range);
    }
  }
  return [...entries.values()]
    .sort((a, b) => b.order - a.order)
    .slice(0, maxEntries)
    .map((entry) => {
      const parts = [...(entry.edited ? ['edited'] : []), ...(entry.ranges.length ? [`read ${entry.ranges.join(', ')}`] : [])];
      return `${entry.path} (${parts.join('; ')})`;
    });
}
