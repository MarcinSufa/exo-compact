import { isSeedMessage, redactOutputText, shouldSkipToolOutput } from './extractor.js';
import type { SessionMessage, TokenCounter } from './types.js';

/**
 * 4.7.0 (CONTRACT S5k): the seed's "Recipes" section. After a cut the session often searches for how it ran something
 * ("how did I start the server", "which command verifies this"): 179 recall calls after 97 recorded cuts were mostly
 * that. This lists the last working run/test/build/verify/deploy commands from the Bash calls before the cut, with a
 * short outcome, deterministically (no model call). Pure: the token counter comes from the caller.
 */

export interface Recipe {
  /** The command as shown: redacted, whitespace collapsed, a long one shortened in the middle. */
  command: string;
  /** `62 files passed`, `background bk7m2x9; localhost:3100`, ...; may carry `in <dir>`. */
  outcome: string;
}

/** The list cap; the section has to stay small because it is on top of the seed's budget. */
export const RECIPES_MAX_LINES = 8;
/** The section's token cap (about 8 lines of 100 characters plus the header). */
export const RECIPES_BUDGET_TOKENS = 400;
const COMMAND_MAX_CHARS = 120;
const COMMAND_HEAD_CHARS = 78;
const OUTCOME_MAX_CHARS = 60;
const SCAN_LIMIT = 4000;

const RECIPES_HEADER = 'Re-run these instead of searching for how; they worked before the cut, so check that they still apply.';

const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const WRAPPERS = new Set(['nice', 'nohup', 'time', 'timeout', 'setsid', 'env', 'sudo', 'exec', 'command', 'stdbuf']);
const RUN_BINS = new Set(['node', 'nodejs', 'python', 'python3', 'bash', 'sh', 'zsh', 'tsx', 'ts-node', 'deno', 'cargo', 'go', 'make', 'cmake', 'docker', 'docker-compose', 'kubectl', 'helm', 'terraform', 'vitest', 'jest', 'pytest', 'playwright', 'tsc', 'eslint', 'uvicorn', 'gunicorn', 'flask', 'next', 'vite', 'ruby', 'rails', 'bundle', 'mvn', 'gradle', 'dotnet', 'java', 'supabase', 'vercel', 'npx', 'pnpx', 'uv']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PACKAGE_VERB = /^(?:run|test|build|dev|start|serve|launch|deploy|verify|check|typecheck|lint|e2e|exec|dlx|x|migrate|seed|bench|compile|preview)(?::[\w:-]+)?$/;
const LOCAL_URL = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{2,5})?/;
const SECRET_FLAG = /(--?(?:token|api[-_]?key|apikey|password|passwd|secret|auth|bearer)(?:[= ]|\s+))(?!\[redacted\])(\S+)/gi;
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g;

function shorten(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/** The command as shown and keyed: one line, filters like `| tail -20` and `2>&1` dropped, redacted, shortened in the middle. */
function displayCommand(raw: string): string {
  let text = raw.replace(ANSI, '').replace(/\\\r?\n\s*/g, ' ').replace(/\s*\r?\n\s*/g, '; ').replace(/\s+/g, ' ').trim();
  for (let again = true; again;) {
    const next = text.replace(/\s*\|\s*(?:tail|head|tee)\b[^|;&]*$/, '').replace(/\s+2>&1$/, '').replace(/;\s*$/, '').trim();
    again = next !== text;
    text = next;
  }
  text = redactOutputText(text.replace(SECRET_ASSIGNMENT, '$1=[redacted]').replace(SECRET_FLAG, '$1[redacted]'));
  const chars = Array.from(text);
  if (chars.length <= COMMAND_MAX_CHARS) return text;
  return `${chars.slice(0, COMMAND_HEAD_CHARS).join('')}…${chars.slice(-(COMMAND_MAX_CHARS - COMMAND_HEAD_CHARS - 1)).join('')}`;
}

/** The words of a shell segment after leading `VAR=value` assignments and wrappers such as `nice -n 10`. */
function commandWords(segment: string): string[] {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  let at = 0;
  while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at])) at += 1;
  while (at < words.length && WRAPPERS.has(words[at])) {
    at += 1;
    while (at < words.length && (words[at].startsWith('-') || /^\d+[smhd]?$/.test(words[at]))) at += 1;
    while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at])) at += 1;
  }
  return words.slice(at);
}

/** A path-shaped command word (`./x`, `../x`, `/x`) under a system binary directory or a Windows System32: a tool, not a project script. */
const SYSTEM_BIN_DIR = /^(?:\/(?:usr\/(?:local\/)?)?s?bin\/|\/opt\/homebrew\/s?bin\/|[A-Za-z]:[\\/]+Windows[\\/]+System32[\\/])/i;
const EVAL_FLAG = /^-(?:e|p|c|v|-version|-eval)$/;

function isRunSegment(segment: string): boolean {
  const words = commandWords(segment);
  if (words.length === 0) return false;
  const bin = words[0].split(/[\\/]/).at(-1) ?? words[0];
  if (PACKAGE_MANAGERS.has(bin)) return words.slice(1, 7).some((word) => PACKAGE_VERB.test(word) || RUN_BINS.has(word));
  if (bin === 'curl' || bin === 'wget' || bin === 'http') return LOCAL_URL.test(segment);
  if (RUN_BINS.has(bin)) {
    if (bin === 'node' || bin === 'nodejs' || bin === 'python' || bin === 'python3') {
      // Only the flags before the script count: `node dist/server.js -p 3000` is a run, `node -p '...'` is not.
      for (const word of words.slice(1)) {
        if (!word.startsWith('-')) break;
        if (EVAL_FLAG.test(word)) return false;
      }
    }
    return true;
  }
  // Any other path-shaped command is a run only when it is a project script (not a system binary, not a document).
  return /^\.{0,2}[\\/]/.test(words[0]) && !SYSTEM_BIN_DIR.test(words[0]) && !/\.(?:md|txt|json|log)$/.test(words[0]);
}

/** Whether a command is a run/launch/test/build/verify/deploy command (not a read, git inspection or file work). */
function looksLikeRecipe(command: string): boolean {
  if (/<<-?\s*['"]?\w+/.test(command)) return false;
  return command.split(/&&|\|\||[;|\n]/).some((segment) => isRunSegment(segment));
}

function isFailure(result: { text: string; isError: boolean }): boolean {
  return result.isError || /^\s*Exit code (?!0\b)\d+/.test(result.text);
}

function outcomeLine(text: string): string {
  const lines = redactOutputText(text.slice(-8192).replace(ANSI, '')).split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && !/^[>$#]\s/.test(line));
  if (lines.length === 0) return 'ok';
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const counted = /\b(\d+\s+(?:passed|passing)\b.*)$/i.exec(lines[index]);
    if (counted) return shorten(counted[1].trim(), OUTCOME_MAX_CHARS);
  }
  return shorten(lines.at(-1)!, OUTCOME_MAX_CHARS);
}

function ports(...texts: string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/(?:\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)|\b(?:PORT|--port|-p)[= ])\s*:?(\d{2,5})\b/gi)) {
      const prefix = /^(?:127\.0\.0\.1|0\.0\.0\.0)/i.exec(match[0])?.[0] ?? 'localhost';
      found.add(`${prefix}:${match[1]}`);
    }
  }
  return [...found];
}

/** The `- command  (outcome)` lines of every `## Recipes` section in earlier seed messages, oldest first. */
function carriedRecipes(messages: readonly SessionMessage[]): Recipe[] {
  const out: Recipe[] = [];
  for (const message of messages) {
    if (!isSeedMessage(message)) continue;
    const start = message.text.indexOf('\n## Recipes');
    if (start < 0) continue;
    const end = message.text.indexOf('\n\n## ', start + 1);
    for (const line of message.text.slice(start, end < 0 ? undefined : end).split('\n')) {
      const match = /^- (.+?) {2}\((.*)\)$/.exec(line);
      if (match) out.push({ command: match[1], outcome: match[2] });
    }
  }
  return out;
}

/**
 * The recipes for a cut, oldest first, at most RECIPES_MAX_LINES: the newest successful run-like Bash command per
 * display form. `tailToolUseIds` are the calls the kept tail shows verbatim; a command the tail ran is left out.
 * Recipes in an earlier seed's section carry forward as older entries (the segment's own history starts after that cut).
 */
export function collectRecipes(messages: readonly SessionMessage[], tailToolUseIds: ReadonlySet<string>, options: { sessionCwd?: string; outputText?: boolean } = {}): Recipe[] {
  const outputText = options.outputText !== false;
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const message of messages) for (const result of message.toolResults ?? []) if (!results.has(result.tool_use_id)) results.set(result.tool_use_id, { text: result.text, isError: result.isError === true });
  const tailKeys = new Set<string>();
  for (const message of messages) for (const use of message.toolUses) {
    const command = (use.input as { command?: unknown } | undefined)?.command;
    if (use.tool === 'Bash' && typeof command === 'string' && tailToolUseIds.has(use.tool_use_id)) tailKeys.add(displayCommand(command));
  }
  // outputText false (toolOutputNotes off): a carried outcome keeps only our own background marker, ports recomputed from the command and the cwd part; any other text is output text, so `ok`.
  const entries: Recipe[] = carriedRecipes(messages).map((entry) => {
    if (outputText) return entry;
    const [first, ...rest] = entry.outcome.split('; ');
    if (!/^background [A-Za-z0-9_-]+$/.test(first) && first !== 'started in background') return { ...entry, outcome: 'ok' };
    const cwdPart = rest.at(-1)?.startsWith('in ') ? [rest.at(-1)!] : [];
    return { ...entry, outcome: [first, ...ports(entry.command), ...cwdPart].join('; ') };
  });
  let cwd: string | undefined;
  for (const message of messages) {
    if (isSeedMessage(message)) continue;
    for (const use of message.toolUses) {
      const input = (use.input ?? {}) as Record<string, unknown>;
      if (use.tool !== 'Bash' || typeof input.command !== 'string') continue;
      const raw = input.command;
      const result = results.get(use.tool_use_id);
      if (!result || isFailure(result)) continue;
      const bare = /^\s*cd\s+("[^"\n]+"|'[^'\n]+'|[^\s;&|]+)\s*$/.exec(raw);
      if (bare && input.run_in_background !== true) { cwd = bare[1].replace(/^["']|["']$/g, ''); continue; }
      if (tailToolUseIds.has(use.tool_use_id) || raw.length > SCAN_LIMIT || shouldSkipToolOutput(raw) || !looksLikeRecipe(raw)) continue;
      const command = displayCommand(raw);
      if (command === '' || tailKeys.has(command)) continue;
      const background = input.run_in_background === true;
      const parts: string[] = [];
      if (background) {
        const id = /with ID:\s*([A-Za-z0-9_-]+)/.exec(result.text)?.[1];
        parts.push(id ? `background ${id}` : 'started in background');
        parts.push(...(outputText ? ports(raw, result.text) : ports(raw)));
      } else parts.push(outputText ? outcomeLine(result.text) : 'ok');
      if (cwd !== undefined && !/^\s*cd\s/.test(raw) && cwd !== options.sessionCwd) parts.push(`in ${redactOutputText(cwd)}`);
      entries.push({ command, outcome: parts.join('; ') });
    }
  }
  const newest = new Map<string, number>();
  entries.forEach((entry, index) => newest.set(entry.command, index));
  return entries.filter((entry, index) => newest.get(entry.command) === index && !tailKeys.has(entry.command)).slice(-RECIPES_MAX_LINES);
}

/**
 * The section body (the caller adds the heading): one header line and one `- command  (outcome)` line per recipe.
 * Over `budgetTokens` the oldest lines go; '' when nothing is left (no recipes, or not even the newest fits).
 */
export function renderRecipes(recipes: readonly Recipe[], budgetTokens: number, countTokens: TokenCounter): string {
  for (let kept = Math.min(recipes.length, RECIPES_MAX_LINES); kept >= 1; kept -= 1) {
    const body = [RECIPES_HEADER, ...recipes.slice(-kept).map((recipe) => `- ${recipe.command}  (${recipe.outcome})`)].join('\n');
    if (countTokens(body) <= budgetTokens) return body;
  }
  return '';
}
