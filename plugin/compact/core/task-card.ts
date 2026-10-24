/**
 * Task card (3.47.0, CONTRACT S4zu). The session's own model keeps a short card of the task (goal, rules with
 * their source, decisions, done, acceptance checks, next step) while the context still holds everything:
 * `compact.ts` forks the main thread (`$.model.fork`, same model and prompt cache, no tools) in the background
 * (3.49.0) once per stretch between cuts, when the context passes CARD_CUT_SHARE of the compaction window, and
 * once when a new task arrives (a newer saved brief) past CARD_TASK_SHARE. A cut then puts the newest card in the seed instead of the whole brief, so the seed fits a native-sized
 * budget (w17 w60g: the whole brief and a 20k seed + tail left ~34k after each cut, 17 cuts vs native's 8), and
 * the stop-time check reads the card's acceptance checks instead of the whole brief again.
 */
import type { Budgets } from './budgets.js';
import type { TokenCounter } from './types.js';

export const TASK_CARD_FILE = 'task-card.md';
export const TASK_CARD_STATE_FILE = 'task-card.json';
/** The id of the newest saved brief when the card was written (3.48.1): a newer brief means the card is from an earlier task. */
export const TASK_CARD_BRIEF_FILE = 'task-card.brief';
/** 4.6.0 (S5f): the newest tool call the card's fork could see, `{ toolUseId, at, tokens }`, or `{}` when it saw none (core/since-card.ts). */
export const TASK_CARD_HORIZON_FILE = 'task-card.horizon.json';
/** The card's cap in the seed. */
export const TASK_CARD_MAX_TOKENS = 2500;
/**
 * The cap of the fork's answer in the card file (3.50.0): room for every section, so the stop check and a later read
 * see them all; the seed shows what fits its own cap, every section trimmed alike (`capCard`).
 */
export const TASK_CARD_FILE_MAX_TOKENS = 4000;
/**
 * The once-per-stretch refresh, close to the cut. 3.47-3.48 refreshed at 45% and every 15% after: 15 forks for
 * 9 cuts in w17 w60i (~$1.6 of $5.88). This schedule, replayed on the recorded token readings of w60i and w60h,
 * gives 9 and 11 forks with the card from the current task at the same cuts (8/9, 11/13).
 */
export const CARD_CUT_SHARE = 0.6;
/** A new task (a newer saved brief than the card's) refreshes once the context passes this share. */
export const CARD_TASK_SHARE = 0.45;
/** Total seed + tail budget (real tokens) while the card is on: about what native compaction keeps. */
export const CARD_TOTAL_BUDGET_TOKENS = 8000;
/**
 * The split of that total: the tail gets 3/8 (3k of 8k) and the working notes 1/8; the seed holds the rest (card,
 * the user's own instructions, work state). The generic split (`scaledBudgets`) gives the tail 54%, which left a
 * 3.7k seed for a 2.2k card plus the always-kept sections (w17 w60g replay: 17 of 17 cuts over budget).
 */
export function cardBudgets(totalTokens: number = CARD_TOTAL_BUDGET_TOKENS): Budgets {
  const total = Number.isFinite(totalTokens) && totalTokens >= 2000 ? Math.round(totalTokens) : CARD_TOTAL_BUDGET_TOKENS;
  const tail = Math.round((total * 3) / 8);
  return { seed: total - tail, dense: Math.round(total / 8), tail, total };
}

/**
 * The budgets a cut is checked against once the tail is picked. The newest exchange stays whole even past the tail
 * budget (a pasted task of 5.7k-6.9k tokens, or the open turn's 3.7k-5.1k `Write` input, w17 w60g), as native
 * compaction keeps it too; the total then grows by that overage and the seed gets no more than its own budget.
 */
export function stretchForTail(budgets: Budgets, tailTokens: number): Budgets {
  const over = Math.max(0, tailTokens - budgets.tail);
  return over === 0 ? budgets : { ...budgets, tail: tailTokens, total: budgets.total + over };
}

export const CARD_HEADING = '# Task card';
export const CARD_ACCEPTANCE_HEADING = '## Acceptance checks';

export interface TaskCardState {
  /** Context tokens when the last refresh started; a lower reading later means a cut happened. */
  lastTokens: number;
  refreshes: number;
  /** A refresh already ran since the last cut. */
  stretchDone?: boolean;
  /** 4.7.0 (S5j): the late refresh (core/late-card.ts) already ran since the last cut. */
  lateDone?: boolean;
  /** The id of the newest saved brief when the last refresh started. */
  briefId?: string;
}

export function parseTaskCardState(raw: string | undefined): TaskCardState {
  try {
    const value = JSON.parse(raw ?? '') as Partial<TaskCardState>;
    return {
      lastTokens: Number.isFinite(value.lastTokens) ? Number(value.lastTokens) : 0,
      refreshes: Number.isInteger(value.refreshes) ? Number(value.refreshes) : 0,
      ...(value.stretchDone === true ? { stretchDone: true } : {}),
      ...(value.lateDone === true ? { lateDone: true } : {}),
      ...(typeof value.briefId === 'string' ? { briefId: value.briefId } : {}),
    };
  } catch {
    return { lastTokens: 0, refreshes: 0 };
  }
}

/**
 * Whether to refresh the card now, and the state to write first. A reading below the last refresh means a cut
 * came in between, which opens a new stretch. Due once per stretch past CARD_CUT_SHARE, or when the newest brief
 * is not the one the last refresh saw and the context is past CARD_TASK_SHARE (that refresh counts for the stretch).
 */
export function cardRefreshDue(state: TaskCardState, tokens: number, windowTokens: number, briefId?: string): { due: boolean; state: TaskCardState } {
  if (!(tokens > 0) || !(windowTokens > 0)) return { due: false, state };
  const cut = tokens < state.lastTokens;
  const { lateDone: _lateDone, ...kept } = state;
  const current: TaskCardState = cut ? { ...kept, lastTokens: 0, stretchDone: false } : state;
  const newTask = briefId !== undefined && briefId !== current.briefId && tokens >= windowTokens * CARD_TASK_SHARE;
  const nearCut = !current.stretchDone && tokens >= windowTokens * CARD_CUT_SHARE;
  if (!newTask && !nearCut) return { due: false, state: current };
  return { due: true, state: { lastTokens: tokens, refreshes: current.refreshes + 1, stretchDone: true, ...(briefId !== undefined ? { briefId } : current.briefId !== undefined ? { briefId: current.briefId } : {}) } };
}

/** The one message the fork answers. The current card, when there is one, is carried forward. */
export function renderCardPrompt(current: string | undefined, briefPath: string | undefined, maxTokens: number = TASK_CARD_MAX_TOKENS): string {
  // 3.50.0: 0.6 words per token asked for ~1500 words, about twice what the 2500-token cap holds (estimateTokens
  // counts ~1.9 characters per token on card text): every w60h/w60i seed but two lost the sections after Rules.
  const words = Math.round(maxTokens * 0.26);
  return [
    'The conversation context will be compacted soon. Write the task card that the compacted context will keep. It replaces your memory of this conversation, so it must hold everything you need to continue the work correctly. Reply with the card alone, no preamble, in this exact form:',
    '',
    CARD_HEADING,
    '## Goal',
    '(what the user wants done now, one to three lines)',
    '## Rules',
    '(the instructions that apply to the current task: the session-wide ones (report format and language, test rules, limits) and this task\'s own (scope, files not to touch, naming). Leave out rules that applied only to an earlier, finished task. One line each, with its source in brackets, e.g. [brief line 40] or [user, turn about X]. Copy exact strings, names, paths and numbers character for character. At most 25 lines.)',
    '## Decisions',
    '(what was decided and why, including corrections: write only the current value)',
    '## Done',
    '(what is finished and verified, with file paths)',
    CARD_ACCEPTANCE_HEADING,
    '(the checks the work must pass before it is done: commands, exact strings that must be present, limits)',
    '## Next step',
    '(the very next action)',
    '',
    `Stay under ${words} words. Leave out what is already done and no longer constrains the work. Do not invent anything: write only what this conversation says.`,
    ...(briefPath ? ['', `The full task brief is saved at ${briefPath}; cite its lines in Rules rather than paraphrasing them loosely.`] : []),
    ...(current ? ['', 'Your previous card is below. Keep every rule and decision in it that still applies to the current task, unless the conversation since then changed it, and update the rest:', '', current] : []),
  ].join('\n');
}

/** The fork's reply as a card, or undefined when it is not one. Text before the heading is dropped; over the cap, every section is trimmed alike. */
export function parseCardReply(reply: string, countTokens: TokenCounter, maxTokens: number = TASK_CARD_FILE_MAX_TOKENS): string | undefined {
  const start = reply.indexOf(CARD_HEADING);
  if (start === -1) return undefined;
  const card = reply.slice(start).trim();
  if (!card.includes('\n## ')) return undefined;
  return capCard(card, countTokens, maxTokens);
}

/** The card for the seed, every section trimmed alike to the budget, with a pointer to the whole card. */
export function renderCardSection(card: string, cardPath: string, countTokens: TokenCounter, budgetTokens: number): string {
  const pointer = `(Kept current by this session's model before the cut; file: ${cardPath}. The full task brief and the transcript stay on disk.)`;
  // The card's own `## ` headings sit one level below the seed's `## Task card`.
  const body = card.replace(/^# Task card\s*\n/, '').replace(/^## /gm, '### ');
  // The counter is not additive across the join, so the room shrinks by whatever the joined text is still over.
  let room = budgetTokens - countTokens(pointer) - 10;
  for (let attempt = 0; attempt < 4 && room > 0; attempt += 1) {
    const section = `${pointer}\n${capCard(body, countTokens, room, cardPath)}`;
    const over = countTokens(section) - budgetTokens;
    if (over <= 0) return section;
    room -= over + 5;
  }
  return pointer;
}

/**
 * The card under the cap with every section kept (3.50.0). The longest sections lose their last lines first: each
 * section keeps at most the same number of lines, the largest number that fits, and says how many it left out. A
 * plain line cut kept only Goal and Rules in 20 of the 22 w60h/w60i seeds, so the acceptance checks and the next
 * step never reached the model. 4.7.3 (S5m): when even one line per section does not fit, nothing is cut unannounced
 * any more (w72a cuts 6 and 10 lost Done, Acceptance and Next step whole): every heading keeps its first line, shortened
 * to the longest that fits; then whole sections are replaced by one marker line each, Next step last, then Acceptance, then Goal.
 */
export function capCard(text: string, countTokens: TokenCounter, maxTokens: number, fullPath?: string): string {
  if (countTokens(text) <= maxTokens) return text;
  const lines = text.split('\n');
  const head: string[] = [];
  const sections: { heading: string; body: string[] }[] = [];
  for (const line of lines) {
    if (/^#{2,3} /.test(line)) sections.push({ heading: line, body: [] });
    else if (sections.length === 0) head.push(line);
    else sections.at(-1)!.body.push(line);
  }
  if (sections.length < 2) return cutAtLine(lines, countTokens, maxTokens, fullPath);
  const at = (limit: number) => [...head, ...sections.flatMap(({ heading, body }) => {
    const kept = body.slice(0, limit);
    const left = body.slice(limit).filter((line) => line.trim()).length;
    return left > 0 ? [heading, ...kept, moreMarker(left, fullPath)] : [heading, ...kept];
  })].join('\n');
  let low = 0;
  let high = Math.max(...sections.map(({ body }) => body.length));
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (countTokens(at(mid)) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  if (low >= 1) return at(low);
  return headingsCard(head, sections, countTokens, maxTokens, fullPath) ?? cutAtLine(lines, countTokens, maxTokens, fullPath);
}

const MIN_FIRST_LINE_CHARS = 24;

function moreMarker(left: number, fullPath: string | undefined): string {
  return `- (${left} more line${left === 1 ? '' : 's'}${fullPath ? ` in ${fullPath}` : ' cut'})`;
}

/**
 * 4.7.3 (S5m): the headings with a shortened first line, then fewer sections; undefined when even Next step alone does not fit.
 * First lines are shortened down to MIN_FIRST_LINE_CHARS (24) and no further, on purpose: a fragment under 24 characters carries almost
 * no information and a left-out marker costs about the same, so below the floor whole sections become markers, least important first.
 */
function headingsCard(head: string[], sections: { heading: string; body: string[] }[], countTokens: TokenCounter, maxTokens: number, fullPath: string | undefined): string | undefined {
  const rank = (heading: string, index: number) => (/next step/i.test(heading) ? 0 : /acceptance/i.test(heading) ? 1 : /goal/i.test(heading) ? 2 : 3 + index);
  const order = sections.map((_, index) => index).sort((a, b) => rank(sections[a].heading, a) - rank(sections[b].heading, b));
  const bodies = sections.map(({ body }) => body.filter((line) => line.trim()));
  const render = (kept: number, chars: number) => {
    const keep = new Set(order.slice(0, kept));
    return [...head, ...sections.flatMap(({ heading }, index) => {
      const body = bodies[index];
      const title = heading.replace(/^#+ /, '');
      if (!keep.has(index)) return [`- (${title} left out: ${body.length} line${body.length === 1 ? '' : 's'}${fullPath ? ` in ${fullPath}` : ' cut'})`];
      if (body.length === 0) return [heading];
      const first = Array.from(body[0]);
      return [heading, first.length <= chars ? body[0] : `${first.slice(0, chars - 1).join('')}…`, ...(body.length > 1 ? [moreMarker(body.length - 1, fullPath)] : [])];
    })].join('\n');
  };
  for (let kept = sections.length; kept >= 1; kept -= 1) {
    if (countTokens(render(kept, MIN_FIRST_LINE_CHARS)) > maxTokens) continue;
    let low = MIN_FIRST_LINE_CHARS;
    let high = Math.max(MIN_FIRST_LINE_CHARS, ...bodies.map((body) => Array.from(body[0] ?? '').length));
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (countTokens(render(kept, mid)) <= maxTokens) low = mid;
      else high = mid - 1;
    }
    return render(kept, low);
  }
  return undefined;
}

/** A prefix of the lines, the longest that fits, ending in a marker that counts the body lines left out (4.7.3 S5m: it was a silent cut). */
function cutAtLine(lines: string[], countTokens: TokenCounter, maxTokens: number, fullPath: string | undefined): string {
  const text = lines.join('\n');
  if (countTokens(text) <= maxTokens) return text;
  const at = (count: number) => [...lines.slice(0, count), moreMarker(lines.slice(count).filter((line) => line.trim() && !/^#{1,3} /.test(line)).length, fullPath)].join('\n');
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (countTokens(at(mid)) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  const out = at(low);
  return countTokens(out) <= maxTokens ? out : '';
}

/** The card's acceptance checks, or undefined when it has none. */
export function cardAcceptance(card: string): string | undefined {
  const start = card.indexOf(CARD_ACCEPTANCE_HEADING);
  if (start === -1) return undefined;
  const body = card.slice(start + CARD_ACCEPTANCE_HEADING.length);
  const end = body.search(/\n## /);
  const text = (end === -1 ? body : body.slice(0, end)).trim();
  return text || undefined;
}

/** The stop-time check from the card: its acceptance checks, then the report the user expects. */
export function renderCardCheckReason(acceptance: string, cardPath: string, briefPath: string | undefined): string {
  return [
    `Before you finish: context was compacted during this task. Check your work against the acceptance checks in your task card (${cardPath}):`,
    '',
    acceptance,
    '',
    `Check each one with a command against the files themselves, not from memory, and fix what is missing.${briefPath ? ` The full brief is at ${briefPath} if a check needs its context.` : ''} Then write your final report again, in full, as your last message: it keeps everything the user asked of a final report in this session (its first and last lines, its language, its sections).`,
  ].join('\n');
}

/** 4.7.1 (S5l): what the card refresh gets from the fork: the reply text, or no reply and why (`null` when the host did not say). */
export type ForkReply = { text: string } | { reason: string | null };

/**
 * `$.model.fork` is `{ isAnswered: true, text, usage }` or `{ isAnswered: false, reason }` since Claude Code 2.1.287 and was
 * `{ text, usage } | null` before. Both shapes end up as a reply or as no reply with a reason; anything else is no reply.
 */
export function forkReply(raw: unknown): ForkReply {
  if (raw === null || typeof raw !== 'object') return { reason: null };
  const { isAnswered, text, reason } = raw as { isAnswered?: unknown; text?: unknown; reason?: unknown };
  if (isAnswered !== false && typeof text === 'string') return { text };
  return { reason: typeof reason === 'string' ? reason : null };
}
