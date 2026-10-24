import { omittedHistoryMarker, SEED_SENTINEL } from '../../core/sentinel.js';
import type { SeedRenderResult, SeedSections } from '../../core/seed.js';
import type { TokenCounter } from '../../core/types.js';

function section(label: string, content: string): string {
  return `## ${label}\n${content.trim().length > 0 ? content : '(none)'}`;
}

/**
 * Mutation-proof defect (spec §3.1 "with no such item the next step is not invented"): when
 * `sections.nextStep` is absent, a fallback line is rendered anyway instead of omitting the
 * section, fabricating a next step from nothing. Sentinel, section order, contract-verbatim
 * append and the closing marker are otherwise correct, so the family still discriminates on
 * this one defect.
 *
 * Second seeded defect (round 19, brief-s4a-fix19.md F13, review-opus-r18.md finding F13, spec
 * v3.3.1 / round 18 B1): this variant still merges the transcript pointer into the file-pointers
 * body, the exact pre-round-18 shape, and (unlike the version of this file that shipped before
 * round 19) actually applies a budget shrink to that merged body -- first, before ever touching
 * history -- when the render is over `budgetTokens`. Before round 19 this file never shrank
 * anything at all, so `seed.gate.test.ts:147`'s 20k-line-history-at-a-tight-budget test passed
 * under `S4_GATE_IMPL=broken` for the wrong reason (nothing was ever reduced, so the pointer
 * trivially survived): a vacuous pass, not a real check that the pointer is protected from the
 * reduction loop. Reducing file pointers before history reproduces the actual bug 4dfdf2dc: a
 * merged section that is shrunk early, ahead of the section that is actually huge, gets cut to
 * nothing before the loop ever reaches the section that would have been enough to shrink on its
 * own, dropping the pointer.
 */
export function renderSeed(
  sections: SeedSections,
  omittedCount: number,
  budgetTokens: number,
  countTokens: TokenCounter,
): SeedRenderResult {
  const contract = sections.compactInstructions
    ? `${sections.contract}\n\n${sections.compactInstructions}`
    : sections.contract;
  const historyLines = sections.userInstructionsVerbatim.map((line) => `> ${line}`).join('\n');
  const filePointersBody = [sections.transcriptPointer, sections.filePointers].filter((part) => part !== undefined && part.length > 0).join('\n\n');

  const bodies = [filePointersBody, historyLines];
  const render = () =>
    [
      SEED_SENTINEL,
      section('Constraints (history)', sections.constraints),
      section('Contract', contract),
      section('Todo', sections.todo),
      section('History (verbatim user records)', bodies[1]),
      section('Values', sections.values),
      section('Reasoning', sections.selectedReasoning),
      section('Gates and errors', sections.gatesAndErrors),
      section('File pointers', bodies[0]),
      section('Next step', sections.nextStep ?? 'Continue with the current plan.'),
      omittedHistoryMarker(omittedCount),
    ].join('\n\n');

  let text = render();
  // File pointers (index 0, holding the merged-in pointer) is reduced before history (index 1),
  // matching the pre-round-18 order in `core/seed.ts` that caused 4dfdf2dc.
  for (const index of [0, 1]) {
    if (countTokens(text) <= budgetTokens) break;
    const current = bodies[index];
    let low = 0;
    let high = current.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      bodies[index] = current.slice(0, middle);
      if (countTokens(render()) <= budgetTokens) low = middle;
      else high = middle - 1;
    }
    bodies[index] = current.slice(0, low);
    text = render();
  }

  const tokens = countTokens(text);
  return {
    message: { role: 'user', text, toolUses: [] },
    tokens,
    overflowed: tokens > budgetTokens,
  };
}
