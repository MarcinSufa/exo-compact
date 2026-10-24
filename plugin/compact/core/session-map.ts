import type { TokenCounter } from './types.js';
import { SESSION_MAP_BUDGET_TOKENS } from './budgets.js';

/** One compaction segment of the session, as `recall/timeline.mjs` writes it to `timeline.json`. */
export interface SessionSegment {
  segment: number;
  from: string;
  to: string;
  asks: string[];
  files: string[];
  commits: string[];
}

const when = (iso: string) => (/^\d{4}-(\d\d-\d\d)T(\d\d:\d\d)/.exec(iso) ?? []).slice(1).join(' ');

/** Detail 0 is the full line; each higher level keeps less, the oldest lines are degraded first. */
function line(s: SessionSegment, detail: number): string {
  const asks = detail >= 2 ? s.asks.slice(0, 1).map((a) => (a.length > 50 ? `${a.slice(0, 49)}…` : a)) : s.asks.slice(0, 2);
  const parts = [
    when(s.from),
    asks.length ? `asks: ${asks.join(' / ')}` : '',
    detail <= 1 && s.files.length ? `edited: ${s.files.slice(0, detail ? 2 : 3).join(', ')}` : '',
    detail === 0 && s.commits.length ? `commits: ${s.commits.slice(0, 2).join('; ')}` : '',
  ].filter(Boolean);
  return `S${s.segment}: ${parts.join(' | ') || '(tool work only)'}`;
}

/**
 * The session map for the seed: one line per earlier segment, so the model knows what happened before
 * the compactions it cannot see and can search one segment (`segment` on the search tool). Over budget,
 * the oldest lines lose detail first, then the oldest are folded into one pointer line.
 */
export function renderSessionMap(segments: readonly SessionSegment[], countTokens: TokenCounter, budgetTokens = SESSION_MAP_BUDGET_TOKENS): string {
  const kept = segments.filter((s) => s.asks.length || s.files.length || s.commits.length);
  if (kept.length < 2) return '';
  const detail = kept.map(() => 0);
  let folded = 0;
  const render = () => [
    ...(folded ? [`S${kept[0].segment}-S${kept[folded - 1].segment}: ${folded} older segments, not listed; search them with the segment filter.`] : []),
    ...kept.slice(folded).map((s, i) => line(s, detail[folded + i])),
  ].join('\n');
  let text = render();
  for (let level = 1; level <= 2 && countTokens(text) > budgetTokens; level++) {
    for (let i = 0; i < kept.length && countTokens(text) > budgetTokens; i++) {
      if (detail[i] < level) { detail[i] = level; text = render(); }
    }
  }
  while (countTokens(text) > budgetTokens && folded < kept.length - 1) { folded++; text = render(); }
  return text;
}
