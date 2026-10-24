import { bashFileWrites } from './file-pointers.js';
import { isSeedMessage, redactCapturedText, redactOutputText, shouldSkipToolOutput, toolActivityText } from './extractor.js';
import type { SessionMessage, TokenCounter } from './types.js';

/**
 * 4.6.0 (CONTRACT S5f): the seed's "Since the card" section. The task card is written by a background fork at
 * "refresh start" and the cut comes later (median 66 s on 112 recorded cuts); between the card's horizon and the kept
 * tail there is a median of 4 tool calls, 2 file writes and 2 test runs that neither shows. This lists them, one line
 * per step, deterministically: no model call, so the cut stays fast. Pure: the token counter comes from the caller.
 */

export type SinceCardHorizon = 'found' | 'before_cut' | 'missing';

export interface SinceCardSteps {
  horizon: SinceCardHorizon;
  /** True when the card's horizon is not in the messages (it predates an earlier cut). */
  predates: boolean;
  /** Every tool call between the horizon and the tail, read-only ones included. */
  total: number;
  /** One line per step that is not read-only, oldest first. */
  lines: string[];
  /** `plus N read-only calls (Read ×a, Grep ×b)`, or '' when there were none. */
  readOnly: string;
}

type ToolUse = SessionMessage['toolUses'][number];

const LINE_MAX_CHARS = 100;
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch', 'TaskOutput']);
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** The tool use id the card's fork could see, from the horizon file's text; undefined for no file, `{}` or junk. */
export function parseCardHorizon(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    const id = typeof parsed === 'object' && parsed !== null ? (parsed as { toolUseId?: unknown }).toolUseId : undefined;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

const oneLine = (text: string): string => text.replace(ANSI, '').replace(/\s+/g, ' ').trim();
function cut(text: string): string {
  const chars = Array.from(text);
  return chars.length <= LINE_MAX_CHARS ? text : `${chars.slice(0, LINE_MAX_CHARS - 1).join('')}…`;
}

/**
 * The paths joined for a line. Past the line cut each shrinks to `…/` + its last two segments, and only the names that
 * fit whole are listed, then `, +K more`: a name is never cut in the middle.
 */
function joinPaths(paths: readonly string[]): string {
  const whole = paths.join(', ');
  if (Array.from(whole).length <= LINE_MAX_CHARS) return whole;
  const short = paths.map((path) => { const parts = path.split('/'); return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`; });
  for (let kept = short.length; kept >= 1; kept -= 1) {
    const text = `${short.slice(0, kept).join(', ')}${kept < short.length ? `, +${short.length - kept} more` : ''}`;
    if (Array.from(text).length <= LINE_MAX_CHARS) return text;
  }
  return short[0];
}

function isReadOnly(tool: string): boolean {
  if (READ_ONLY_TOOLS.has(tool)) return true;
  if (!tool.startsWith('mcp__')) return false;
  const words = tool.slice(tool.lastIndexOf('__') + 2).replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/);
  return words.some((word) => /^(?:search|read|list|get)$/i.test(word));
}

const LEADING_CD = /^\s*cd\s+(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|'"]+)\s*(?:\n|;|&&)\s*/;
/** The command without its leading `cd <dir>` commands (a bare `cd <dir>` stays). */
function dropLeadingCd(command: string): string {
  let rest = command;
  for (;;) {
    const next = rest.replace(LEADING_CD, '');
    if (next === rest || next.trim() === '') return rest;
    rest = next;
  }
}

function firstErrorLine(text: string): string {
  const first = redactOutputText(text.replace(ANSI, '')).split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? '';
  return cut(oneLine(first));
}

/** The last non-empty line of a Bash output, redacted like the extractor's tool-output lines; none for a private key. */
function lastOutputLine(text: string): string | undefined {
  const safe = redactOutputText(text.slice(-64 * 1024).replace(ANSI, ''));
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(safe)) return undefined;
  return safe.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0).at(-1);
}

function describeStep(use: ToolUse, result: { text: string; isError: boolean } | undefined): string {
  const input = (use.input ?? {}) as Record<string, unknown>;
  const failed = result?.isError === true || (result === undefined && use.isError === true);
  if (EDIT_TOOLS.has(use.tool)) {
    const raw = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : '';
    const path = cut(oneLine(redactCapturedText(raw)));
    if (!path) return use.tool;
    if (failed) return `edit of ${path} failed: ${firstErrorLine(result?.text ?? '') || 'error'}`;
    return `${use.tool === 'Write' ? 'wrote' : 'edited'} ${path}`;
  }
  if (use.tool === 'Bash' && typeof input.command === 'string') {
    const command = input.command.replace(ANSI, '');
    const writes = bashFileWrites(command);
    const files = writes.files.length > 0 ? cut(oneLine(joinPaths(writes.files.map((file) => redactCapturedText(file))))) : '';
    if (files && writes.fileWorkOnly && !failed) return `wrote ${files} (bash)`;
    const activity = toolActivityText({ ...use, input: { ...input, command: dropLeadingCd(command) } });
    const shown = cut(oneLine(redactOutputText((activity ?? '').replace(/^\$ /, ''))).replace(/`/g, "'"));
    const ran = `ran \`${shown}\``;
    const head = files && !failed ? `wrote ${files} (bash, with other commands)` : files ? `${ran} (writes ${files})` : ran;
    if (shouldSkipToolOutput(command)) return `${head} -> [output withheld]`;
    if (result === undefined) return head;
    if (failed) return `${head} -> failed: ${firstErrorLine(result.text) || 'error'}`;
    const last = lastOutputLine(result.text);
    return last === undefined ? head : `${head} -> ${cut(oneLine(last))}`;
  }
  if (use.tool === 'Agent' || use.tool === 'Task') {
    const description = typeof input.description === 'string' && input.description.trim() ? input.description : typeof input.prompt === 'string' ? input.prompt : '';
    return `started agent: ${cut(oneLine(redactCapturedText(description)))}`.trimEnd();
  }
  const activity = toolActivityText(use);
  return activity === undefined ? use.tool : `${use.tool}: ${cut(oneLine(redactOutputText(activity)))}`;
}

/**
 * The steps after the card's horizon and before the kept tail. The horizon is the tool call the card's fork could see
 * last; it counts itself (the fork may not have seen its result). A horizon that is not in `messages` predates an
 * earlier cut: the steps then start after the last seed message. `tailToolUseIds` are the calls the tail shows verbatim.
 */
export function collectSinceCard(messages: readonly SessionMessage[], horizonId: string | undefined, tailToolUseIds: ReadonlySet<string>): SinceCardSteps {
  if (horizonId === undefined) return { horizon: 'missing', predates: false, total: 0, lines: [], readOnly: '' };
  const horizonIndex = messages.findIndex((message) => message.toolUses.some((use) => use.tool_use_id === horizonId));
  let start = horizonIndex;
  if (horizonIndex < 0) {
    start = 0;
    messages.forEach((message, index) => { if (isSeedMessage(message)) start = index + 1; });
  }
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const message of messages) for (const result of message.toolResults ?? []) results.set(result.tool_use_id, { text: result.text, isError: result.isError === true });
  const lines: string[] = [];
  const readOnlyCounts = new Map<string, number>();
  let total = 0;
  for (let index = start; index < messages.length; index += 1) {
    if (isSeedMessage(messages[index])) continue;
    // On the horizon message the steps start at the horizon call itself: calls before it in the same message are covered.
    const uses = index === horizonIndex ? messages[index].toolUses.slice(Math.max(0, messages[index].toolUses.findIndex((use) => use.tool_use_id === horizonId))) : messages[index].toolUses;
    for (const use of uses) {
      if (tailToolUseIds.has(use.tool_use_id)) continue;
      total += 1;
      if (isReadOnly(use.tool)) { readOnlyCounts.set(use.tool, (readOnlyCounts.get(use.tool) ?? 0) + 1); continue; }
      lines.push(describeStep(use, results.get(use.tool_use_id)));
    }
  }
  const readOnlyTotal = [...readOnlyCounts.values()].reduce((sum, count) => sum + count, 0);
  const readOnly = readOnlyTotal ? `plus ${readOnlyTotal} read-only calls (${[...readOnlyCounts].map(([tool, count]) => `${tool} ×${count}`).join(', ')})` : '';
  return { horizon: horizonIndex < 0 ? 'before_cut' : 'found', predates: horizonIndex < 0, total, lines, readOnly };
}

/**
 * The section body (the caller adds the `## Since the card` heading): two sentences and one `- ` line per step. Over
 * `budgetTokens` the oldest step lines go and `- (K earlier steps left out)` leads the list; the floor is the sentences,
 * that line and the read-only line, returned even when they exceed the budget (the caller decides to drop it then).
 * With `minKept` the newest `minKept` step lines stay too (the caller's first shrink step; 0 is the floor above).
 * `listed` is how many steps the text still names: the lines it shows plus the read-only calls it counts. Nothing to say (no step that is not read-only) gives ''.
 */
export function renderSinceCard(steps: SinceCardSteps, budgetTokens: number, countTokens: TokenCounter, minKept = 0): { body: string; listed: number } {
  if (steps.lines.length === 0) return { body: '', listed: 0 };
  const count = steps.total === 1 ? 'this step' : `these ${steps.total} steps`;
  const them = steps.total === 1 ? 'it' : 'them';
  const header = [
    steps.predates
      ? `The task card above predates the last cut; ${count} came after it (oldest first); neither the card nor the kept tail shows ${them}.`
      : `The task card above was written before ${count} (oldest first); neither the card nor the kept tail shows ${them}.`,
    "Where they disagree with the card's Done or Next step, trust them and `git status` / `git diff` over the card.",
  ];
  const build = (kept: number): string => {
    const left = steps.lines.length - kept;
    return [...header, ...(left > 0 ? [`- (${left} earlier steps left out)`] : []), ...steps.lines.slice(left).map((line) => `- ${line}`), ...(steps.readOnly ? [`- ${steps.readOnly}`] : [])].join('\n');
  };
  // `minKept` newest step lines stay even over the budget (all of them when there are fewer).
  let low = Math.min(Math.max(0, Math.floor(minKept)), steps.lines.length);
  const floor = low;
  let high = steps.lines.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (countTokens(build(middle)) <= budgetTokens) low = middle; else high = middle - 1;
    if (high < floor) high = floor;
  }
  return { body: build(low), listed: low + (steps.total - steps.lines.length) };
}
