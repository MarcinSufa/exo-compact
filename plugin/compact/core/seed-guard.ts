/**
 * 4.9.2 (CONTRACT S5v): the last guard on every seed section body, applied where `seed.ts` joins the sections.
 *
 * A body quotes text the plugin did not write: tool output, the model's own notes (which can echo a read file or a web
 * page), paths, commit subjects, the task card. Each section already escapes in its own way (dense demotes headings and
 * drops forged turn frames, work state and adopted copies neutralize tags), but `demoteHeadings` leaves fenced code as
 * written, so an unclosed fence in a tool output used to carry a `## Constraints (history)` line into the seed. This
 * guard does not depend on any section's escaping:
 * - a `#` or `##` heading that names a seed section becomes `###`, inside a code fence, a quote, a table row or a list
 *   item too, and after NFKC folding (fullwidth number signs) and with zero-width characters removed; a setext underline
 *   (`===`, `---`) under such a name is dropped;
 * - `<session-memory>`, `</session-memory>` and `<system-reminder>` tags (also fullwidth or as entities) lose their `<`,
 *   so a body can neither close the seed's wrapper nor open a reminder;
 * - every other Unicode line break becomes `\n`, so the line tests above see the lines a reader sees.
 * The seed's own headings are added by `seed.ts` after this guard ran, so they are never touched.
 */
const SEED_SECTION_NAMES = [
  'constraints', 'task card', 'since the card', 'task brief', 'compaction pressure', 'key facts', 'working notes', 'transcript',
  'contract', 'todo', 'earlier user messages', 'values', 'current values', 'earlier assistant notes', 'gates and errors',
  'file pointers', 'next step', 'work state', 'recipes', 'session map', 'ids',
];

const FORMAT_CHARACTERS = /[\p{Cf}\p{Mn}]/gu;
const LINE_BREAKS = /\r\n?|[\u000b\u000c\u0085\u2028\u2029]/g;
const WRAPPER_TAG = /(?:<|\uff1c|\ufe64|&lt;|&#0*60;|&#x0*3c;)(\s*\/?\s*(?:session-memory|system-reminder)\b)/gi;
const HEADING = /^([\s>|]*(?:(?:[-*+\u2022]|\d{1,3}[.)])\s+)?)(#{1,6})[ \t]*(.*)$/;
const SETEXT_UNDERLINE = /^[\s>|]*(?:={2,}|-{2,})\s*$/;

function fold(line: string): string {
  return line.normalize('NFKC').replace(FORMAT_CHARACTERS, '');
}

/** True when `heading` (the text after the `#` marks) names one of the seed's sections. */
export function isSeedSectionName(heading: string): boolean {
  const text = fold(heading).replace(/[*_`~]+/g, '').replace(/[\s|#]+$/, '').trim().toLowerCase();
  return SEED_SECTION_NAMES.some((name) => text === name || text.startsWith(`${name} (`) || text.startsWith(`${name}:`));
}

export function guardSectionBody(body: string): string {
  const lines = body.replace(LINE_BREAKS, '\n').split('\n');
  return lines.map((line, index) => {
    const folded = fold(line);
    const heading = HEADING.exec(folded);
    let safe = line;
    if (heading && heading[2].length <= 2 && isSeedSectionName(heading[3])) safe = `${heading[1]}### ${heading[3]}`;
    else if (index > 0 && SETEXT_UNDERLINE.test(folded) && isSeedSectionName(fold(lines[index - 1]).replace(/^[\s>|]+/, ''))) safe = '';
    return safe.replace(WRAPPER_TAG, '\u2039$1');
  }).join('\n');
}
