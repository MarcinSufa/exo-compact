/**
 * S4g: expand short ids quoted in the seed back to their full form.
 *
 * Agents write short ids in prose (`task bdbc6713`, `commit 94d7f1b0`) while the full UUID or
 * commit sha only ever appears in a tool result, which the seed does not carry. After a cut the
 * agent then has to look the id up again. This scans the text the model will still see for short
 * hex ids, and maps each one that is the prefix of exactly one full id seen in the pre-cut
 * messages. Carried forward across cuts because the rendered section is itself part of the next
 * cut's messages.
 */

/** Full UUIDs (any version) and full 40-hex git shas. */
const FULL_ID = /(?<![0-9a-fA-F-])(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{40})(?![0-9a-fA-F-])/g;
/** Standalone 7-12 hex chars, not part of a longer hex/UUID run. */
const SHORT_ID = /(?<![0-9a-zA-Z_-])[0-9a-fA-F]{7,12}(?![0-9a-zA-Z_-])/g;

export const ID_EXPANSION_MAX_ENTRIES = 20;
/** Distinct short-looking tokens looked up at most, so a hex-heavy tail stays cheap. */
export const ID_EXPANSION_MAX_SHORTS_EXAMINED = 2000;

export function collectFullIds(texts: Iterable<string>): Set<string> {
  const ids = new Set<string>();
  for (const text of texts) for (const match of text.matchAll(FULL_ID)) ids.add(match[0].toLowerCase());
  return ids;
}

/**
 * Returns `short = full` lines, one per short id in `visibleText` (first-seen order) that has a
 * unique full id among `fullIds` and whose full form is not already visible. A short id needs at
 * least one digit and one letter, so plain numbers and hex-only words ("facade") never match.
 */
export function expandShortIds(visibleText: string, fullIds: ReadonlySet<string>, maxEntries = ID_EXPANSION_MAX_ENTRIES): string[] {
  if (fullIds.size === 0) return [];
  // Index on the 7-char prefix every short id shares, so a lookup scans only its own bucket
  // (review: a flat scan was O(shorts x fullIds), 1.27s at 20k x 20k).
  const byPrefix = new Map<string, string[]>();
  for (const full of fullIds) {
    const key = full.slice(0, 7);
    const bucket = byPrefix.get(key);
    if (bucket) bucket.push(full); else byPrefix.set(key, [full]);
  }
  const visibleLower = visibleText.toLowerCase();
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const match of visibleText.matchAll(SHORT_ID)) {
    const short = match[0].toLowerCase();
    if (seen.has(short) || !/\d/.test(short) || !/[a-f]/.test(short)) continue;
    seen.add(short);
    if (seen.size > ID_EXPANSION_MAX_SHORTS_EXAMINED) break;
    const matches = (byPrefix.get(short.slice(0, 7)) ?? []).filter((candidate) => candidate.startsWith(short));
    if (matches.length !== 1 || visibleLower.includes(matches[0])) continue;
    lines.push(`${short} = ${matches[0]}`);
    if (lines.length >= maxEntries) break;
  }
  return lines;
}
