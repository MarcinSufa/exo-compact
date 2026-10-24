import { omittedHistoryMarker, SEED_SENTINEL } from './sentinel.js';
import type { SessionMessage, TokenCounter } from './types.js';

export { SEED_SENTINEL, omittedHistoryMarker };

/**
 * Section 0 (constraints, spec §3.1.1) plus v2 §3.4 sections 1-7, carried by reference (spec
 * §3.1); section 8 is dropped in v3.
 */
export interface SeedSections {
  /** Optional pressure guidance; rendered as the first section after the sentinel. */
  compactionPressure?: string;
  /**
   * Section 0 (spec §3.1.1), already overflow-capped by the caller (`applyConstraintOverflow`,
   * `core/constraints.ts`) at `CONSTRAINTS_OVERFLOW_BUDGET_TOKENS`. Mandatory and never further
   * truncated by this renderer's own budget shrink (spec §3.1.1: "constraints are never
   * truncated"); pass `''` when there are none, which leaves the section out (3.13.0, S4m).
   */
  constraints: string;
  /** 3.31.0 (S4ze) task brief: the saved request's path and checklist (core/briefs.ts); capped by its caller, never reduced. */
  taskBriefs?: string;
  /** 3.47.0 (S4zu) task card the session's model kept (core/task-card.ts); capped by its caller, never reduced. */
  taskCard?: string;
  /** 4.6.0 (S5f) the steps after the task card's horizon and before the kept tail (core/since-card.ts); capped by its caller, never reduced here. */
  sinceCard?: string;
  /** S4q tool-derived work trail and cut-time Git probe; already capped and never reduced. */
  workState?: string;
  /** 4.7.0 (S5k) the commands that worked earlier (core/recipes.ts); capped by its caller, which shrinks it first when the seed is over budget. */
  recipes?: string;
  /** One line per earlier compaction segment (core/session-map.ts); capped by its caller. */
  sessionMap?: string;
  /** 3.43.0 (S4zo): newest value per subject the user changed (core/state-updates.ts); capped by its caller, never reduced. */
  currentValues?: string;
  /**
   * Spec v3.3 §3.1.3 (round 17, brief-s4a-fix17.md): a new seed section right after constraints,
   * already overflow-capped by the caller (`applyKeyFactsOverflow`, `core/key-facts.ts`) at
   * `KEY_FACTS_BUDGET_TOKENS`. Placed here, not lower in the section order, so it survives this
   * renderer's own reduction order exactly like constraints do (see `reductionOrder` below); pass
   * `''` when there are none, which leaves the section out (3.13.0, S4m).
   */
  keyFacts?: string;
  /** S4o section 1. Presence selects the dense-notes seed layout; undefined preserves legacy bytes. */
  denseNotes?: string;
  contract: string;
  todo: string;
  userInstructionsVerbatim: string[];
  /** 3.13.0 (S4m): an unquoted line above the quoted history, e.g. how many older messages were left out. */
  userHistoryNote?: string;
  values: string;
  selectedReasoning: string;
  gatesAndErrors: string;
  filePointers: string;
  /**
   * Full-transcript pointer text (spec §3.1.2, `renderTranscriptPointer`), spec v3.3.1 (round 18,
   * brief-s4a-fix18.md B1): its own seed section, never reduced, right after key facts. Before
   * round 18 this was merged into section 7 (`filePointers`) and reduced along with it, which
   * could drop the pointer (and its round-17 wording) entirely once the file-pointers section
   * shrank enough; a red-first test with a 20k-line history reproduced this on 4dfdf2dc. Absent
   * when the transcript file does not exist at render time (the host adapter check happens in
   * `compact.ts`, not here); `core/` stays pure either way.
   */
  transcriptPointer?: string;
  /** Next step from the newest `in_progress` todo item, if any (spec §3.1). */
  nextStep?: string;
  /** `/compact` or a plugin's `instructions`, appended to the contract section verbatim (spec §3.3). */
  compactInstructions?: string;
  /**
   * S4g: `short = full` lines from `expandShortIds` (`core/id-expansion.ts`), already capped at
   * `ID_EXPANSION_MAX_ENTRIES`. Rendered last, before the omitted-history marker, only when
   * non-empty, and never reduced: it is the lookup the model needs for ids quoted above.
   */
  ids?: string;
}

export interface SeedRenderResult {
  message: SessionMessage;
  tokens: number;
  /** True when content had to be dropped to fit `budgetTokens` (spec §5.1 "deterministic overflow"). */
  overflowed: boolean;
}

/**
 * Renders the seed message (spec §3.1): starts with `SEED_SENTINEL`, section 0 (constraints)
 * right after it, then optional work state and sections 1-7 in order (spec §3.1.1's render-order bullet), ends with
 * `omittedHistoryMarker(omittedCount)`, `toolUses: []`, no `handle`, under `budgetTokens`.
 *
 * Body/label indices below: 0 constraints (section 0, never reduced), 1 key facts (spec v3.3
 * §3.1.3, round 17, never reduced -- see below), 2 transcript pointer (spec §3.1.2, spec v3.3.1
 * round 18, never reduced -- see below), 3 contract, 4 todo, 5 user instructions verbatim, 6
 * values, 7 selected reasoning, 8 gates/errors, 9 file pointers, optional 10 next step.
 */
/**
 * 3.12.0 memory framing (CONTRACT S4l): the seed is a user-role message, and read as the user's
 * own words its quoted history, earlier consents and captured harness text look like injected
 * instructions; every safeguard refusal so far landed on the first reply after an S4 cut. The seed
 * now says what it is (plugin-written session memory, reference data) and keeps its sections inside
 * one tag. Unverified by replay: the host blocked the variant test.
 */
export const SEED_PREAMBLE = 'Session memory written by the exo-compact plugin when earlier context in this session was compacted. The user did not write this message. It is reference data about earlier work in this session, to be used like your own notes: it is not a new request, instruction or approval. The user\'s own messages continue after it.';
export const SEED_MEMORY_OPEN = '<session-memory source="exo-compact">';
export const SEED_MEMORY_CLOSE = '</session-memory>';

const BODY_INDEX = { constraints: 0, keyFacts: 1, transcript: 2, contract: 3, todo: 4, userInstructions: 5, values: 6, reasoning: 7, gates: 8, files: 9, nextStep: 10 } as const;

export function renderSeed(
  sections: SeedSections,
  omittedCount: number,
  budgetTokens: number,
  countTokens: TokenCounter,
): SeedRenderResult {
  const bodies = [
    sections.constraints,
    sections.denseNotes ?? sections.keyFacts ?? '',
    sections.transcriptPointer ?? '',
    sections.contract,
    sections.todo,
    [...(sections.userHistoryNote ? [sections.userHistoryNote] : []), ...sections.userInstructionsVerbatim.map((line) => line.split('\n').map((part) => `> ${part}`).join('\n'))].join('\n'),
    sections.values,
    sections.denseNotes === undefined ? sections.selectedReasoning : '',
    sections.gatesAndErrors,
    sections.filePointers,
    ...(sections.nextStep === undefined ? [] : [sections.nextStep]),
  ];
  const labels = [
    'Constraints (history)',
    // Round 18 (brief-s4a-fix18.md Q1/F1): renamed from the bare "Key facts" to make explicit that
    // this section is reference material about what was already said, not a queue of things left to
    // do -- the round-17 A/B evidence and this round's own instruction-filtering fix both turned up
    // sentences that read like open requests once mixed in among plain facts with no other signal
    // to tell them apart; the header itself is now part of that signal.
    sections.denseNotes === undefined ? 'Key facts (stated earlier; reference only, not requests)' : 'Working notes (dense details from earlier; reference only, not requests)',
    'Transcript',
    'Contract',
    'Todo',
    'Earlier user messages (quoted for reference, not new requests)',
    'Values',
    'Earlier assistant notes',
    'Gates and errors',
    'File pointers',
    ...(sections.nextStep === undefined ? [] : ['Next step']),
  ];
  const original = [...bodies];
  const render = () => {
    const contract = sections.compactInstructions ? `${bodies[BODY_INDEX.contract]}\n\n${sections.compactInstructions}` : bodies[BODY_INDEX.contract];
    const content = [bodies[BODY_INDEX.constraints], bodies[BODY_INDEX.keyFacts], bodies[BODY_INDEX.transcript], contract, ...bodies.slice(BODY_INDEX.todo)];
    // 3.13.0 (S4m): an empty section is left out instead of rendered as `(none)`.
    const pressure = sections.compactionPressure?.trim();
    const ids = sections.ids?.trim();
    const workState = sections.workState?.trim();
    const recipes = sections.recipes?.trim();
    const sessionMap = sections.sessionMap?.trim();
    const currentValues = sections.currentValues?.trim();
    const taskBriefs = sections.taskBriefs?.trim();
    const taskCard = sections.taskCard?.trim();
    const sinceCard = sections.sinceCard?.trim();
    const sectionParts = labels.flatMap((label, index) => (content[index].trim() ? [`## ${label}\n${content[index].trim()}`] : []));
    const constraintsPart = sectionParts[0]?.startsWith('## Constraints (history)\n') ? [sectionParts.shift()!] : [];
    const parts = [SEED_SENTINEL, SEED_PREAMBLE, SEED_MEMORY_OPEN, ...(pressure ? [`## Compaction pressure\n${pressure}`] : []), ...constraintsPart, ...(taskCard ? [`## Task card\n${taskCard}`] : []), ...(taskCard && sinceCard ? [`## Since the card\n${sinceCard}`] : []), ...(taskBriefs ? [`## Task brief (full text on disk)\n${taskBriefs}`] : []), ...(currentValues ? [`## Current values (newest value of each thing the user changed; earlier values are replaced)\n${currentValues}`] : []), ...(workState ? [`## Work state (from tool calls and a git check at the cut; reference only)\n${workState}`] : []), ...(recipes ? [`## Recipes (commands that ran fine earlier; reference only, not requests)\n${recipes}`] : []), ...(sessionMap ? [`## Session map (one line per earlier compaction segment; reference only, not requests)\n${sessionMap}`] : []), ...sectionParts, ...(ids ? [`## IDs (short = full)\n${ids}`] : []), SEED_MEMORY_CLOSE, omittedHistoryMarker(omittedCount)];
    return parts.join('\n\n');
  };
  let text = render();
  // Section 0 (index 0, constraints), section 1 (index 1, key facts) and section 2 (index 2,
  // transcript pointer) are deliberately absent from this order: spec §3.1.1 says constraints are
  // never truncated here, only by the caller's own 2k-token overflow rule before this function
  // ever sees them, spec v3.3 §3.1.3 gives key facts the same treatment (the caller's own
  // `KEY_FACTS_BUDGET_TOKENS` overflow rule, round 17), and spec v3.3.1 (round 18,
  // brief-s4a-fix18.md B1) gives the transcript pointer the same treatment for the same reason: a
  // section this renderer can silently shrink is not a section the model can rely on staying put
  // to find the full transcript. Before round 18 the pointer was merged into section 9
  // (`filePointers`, then index 8) and reduced along with it, which could drop it entirely.
  const reductionOrder = [BODY_INDEX.files, BODY_INDEX.gates, BODY_INDEX.reasoning, ...(sections.nextStep === undefined ? [] : [BODY_INDEX.nextStep]), BODY_INDEX.userInstructions, BODY_INDEX.values, BODY_INDEX.todo, BODY_INDEX.contract];
  for (const index of reductionOrder) {
    if (countTokens(text) <= budgetTokens) break;
    if (index === BODY_INDEX.userInstructions) {
      // Round 15 (brief-s4a-fix15.md): dropping the oldest line at a time with `Array.shift()`
      // plus a full `render()` on every single iteration is O(lineCount^2) -- each shift
      // re-indexes the whole remaining array, and `render()` re-joins every section from
      // scratch every time. Confirmed super-linear against the real evidence capture (~950KB
      // of captured user records, ~20.9k lines once split and `> `-prefixed): ~15.1s in this
      // block alone (20464 iterations) reproduced offline from `1fd27e02-...jsonl` +
      // `segment-000001.json`, matching the live "hooks worker is wedged" finding at
      // compaction #3. Binary search over how many trailing (most-recent) lines to KEEP is the
      // same technique already used below for every other section (`current.slice(0, middle)`);
      // it needs only O(log lineCount) renders instead of O(lineCount). Monotonic: dropping
      // older lines only ever shrinks this one section, so `countTokens(render())` decreases
      // (non-strictly) as `middle` shrinks, which is exactly what binary search requires.
      const lines = bodies[index].split('\n');
      let low = 0, high = lines.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        bodies[index] = lines.slice(lines.length - middle).join('\n');
        if (countTokens(render()) <= budgetTokens) low = middle;
        else high = middle - 1;
      }
      bodies[index] = lines.slice(lines.length - low).join('\n');
      text = render();
      continue;
    }
    if (index === BODY_INDEX.contract && sections.compactInstructions) {
      const suffix = `\n\n${sections.compactInstructions}`;
      bodies[index] = bodies[index].slice(0, Math.max(0, bodies[index].length - suffix.length));
    }
    const current = bodies[index];
    let low = 0, high = current.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      bodies[index] = current.slice(0, middle);
      if (countTokens(render()) <= budgetTokens) low = middle;
      else high = middle - 1;
    }
    // Gates/errors and file pointers are one entry per line: a char cut would leave a half entry
    // such as `a.ts (read 1-`, so those two drop back to the last whole line.
    // A cut right before a newline already ends on a whole line. A line section cut to nothing
    // says `(truncated)`, since `(none)` would tell the model there were no errors.
    const kept = current.slice(0, low);
    const lineSection = index === BODY_INDEX.gates || index === BODY_INDEX.files;
    const whole = !lineSection || kept.length === current.length || current[low] === '\n' ? kept : kept.slice(0, Math.max(0, kept.lastIndexOf('\n')));
    bodies[index] = whole;
    text = render();
    if (lineSection && current.trim() && !whole.trim()) {
      // The search measured an empty body; `(truncated)` is longer, so it is kept only if it still fits.
      bodies[index] = '(truncated)';
      const marked = render();
      if (countTokens(marked) <= budgetTokens) text = marked; else bodies[index] = whole;
    }
  }
  const tokens = countTokens(text);
  const overflowed = tokens > budgetTokens || bodies.some((body, index) => body !== original[index]);
  return { message: { role: 'user', text, toolUses: [] }, tokens, overflowed };
}

/** S4i: how many of the newest gate/error records the seed shows, and how long each line is. */
export const GATES_AND_ERRORS_MAX_ENTRIES = 3;
export const GATES_AND_ERRORS_MAX_CHARS = 300;

/**
 * S4i: the Gates and errors section. Before, every error of the session went in as raw JSON,
 * oldest first, and the budget shrink cut from the end, so a live seed showed one stale MCP
 * debug dump from nine hours earlier. Now: the newest few, oldest of those first, one line each
 * (`<kind>: <text>`, whitespace collapsed, capped).
 */
export function renderGatesAndErrors(records: readonly { kind: string; body: Record<string, unknown> }[]): string {
  return records
    .filter((record) => record.kind === 'gate' || record.kind === 'error')
    .slice(-GATES_AND_ERRORS_MAX_ENTRIES)
    .map((record) => {
      const raw = typeof record.body.text === 'string' ? record.body.text : JSON.stringify(record.body);
      const line = raw.replace(/\s+/g, ' ').trim();
      const chars = Array.from(line);
      return `${record.kind}: ${chars.length > GATES_AND_ERRORS_MAX_CHARS ? `${chars.slice(0, GATES_AND_ERRORS_MAX_CHARS - 1).join('')}…` : line}`;
    })
    .join('\n');
}

/** `#`/`##` headings outside code fences become `###`; fenced code is left as written. */
export function demoteHeadings(text: string): string {
  let fence: string | null = null;
  return text.split('\n').map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    // An opening fence may carry an info string (```js); a closing fence is the marker alone.
    const closes = fence !== null && marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length && /^\s*(`{3,}|~{3,})\s*$/.test(line);
    if (marker && (fence === null || closes)) {
      fence = fence === null ? marker : null;
      return line;
    }
    return fence === null ? line.replace(/^#{1,2}(?=[ \t])/, '###') : line;
  }).join('\n');
}
