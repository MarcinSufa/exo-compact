import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../core/budgets.js';
import { capCard, parseCardReply, renderCardSection } from '../core/task-card.js';
import { W72A_CARD, W72A_CARD_PATH } from './fixtures/w72a-card.js';

/** The 4.7.2 capCard, kept here to pin that nothing which fit with one line per section changed (CONTRACT S5m). Undefined where 4.7.2 fell back to a plain line cut. */
function capCard472(text: string, countTokens: (t: string) => number, maxTokens: number, fullPath?: string): string | undefined {
  if (countTokens(text) <= maxTokens) return text;
  const head: string[] = [];
  const sections: { heading: string; body: string[] }[] = [];
  for (const line of text.split('\n')) {
    if (/^#{2,3} /.test(line)) sections.push({ heading: line, body: [] });
    else if (sections.length === 0) head.push(line);
    else sections.at(-1)!.body.push(line);
  }
  if (sections.length < 2) return undefined;
  const at = (limit: number) => [...head, ...sections.flatMap(({ heading, body }) => {
    const kept = body.slice(0, limit);
    const left = body.slice(limit).filter((line) => line.trim()).length;
    return left > 0 ? [heading, ...kept, `- (${left} more line${left === 1 ? '' : 's'}${fullPath ? ` in ${fullPath}` : ' cut'})`] : [heading, ...kept];
  })].join('\n');
  let low = 0;
  let high = Math.max(...sections.map(({ body }) => body.length));
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (countTokens(at(mid)) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return low >= 1 ? at(low) : undefined;
}

const SMALL_CARD = [
  '# Task card', '## Goal', 'Build the lane fit in src/ui/graph-fit.ts.', '## Rules', '- Report line 1 is `SLICE r12 DONE` [user, house rules]', '- `export const LANE_PAD = 16;` [brief line 12]',
  '## Decisions', '- Zoom never goes in.', '## Done', '- graph-fit.ts written.', '## Acceptance checks', '- pnpm --filter @acme/app exec vitest run test/r12 passes', '- grep `padding-left:22px` in the view test',
  '## Next step', 'Write test/r12-lane-fit.test.ts.',
].join('\n');
const LONG_RULES = SMALL_CARD.replace('## Rules\n', `## Rules\n${Array.from({ length: 60 }, (_, i) => `- Rule ${i}: keep \`src/ui/memory/memory-shell-${i}.tsx\` under 120 lines, no colour literals [brief line ${i}]`).join('\n')}\n`);
const BIG_HEAD = `# Task card\n${Array.from({ length: 40 }, (_, i) => `Context ${i}: the shell frame is split over several packages and files.`).join('\n')}\n${SMALL_CARD.split('\n').slice(1).join('\n')}`;

const MARKER = /^- \((?:(\d+) more lines?|.+ left out: (\d+) lines?) (?:in .+|cut)\)$/;
const shownAndMarked = (card: string) => {
  let shown = 0;
  let marked = 0;
  for (const line of card.split('\n')) {
    if (!line.trim() || /^#{1,3} /.test(line)) continue;
    const m = MARKER.exec(line);
    if (m) marked += Number(m[1] ?? m[2]);
    else shown += 1;
  }
  return { shown, marked };
};
const bodyLines = (card: string) => card.split('\n').filter((line) => line.trim() && !/^#{1,3} /.test(line)).length;

describe('4.7.3 (S5m) the card cap never cuts without saying so', () => {
  it('the w72a card does not fit with one full line per section (the cause of the silent cut)', () => {
    // The first lines alone are about 880 tokens and the five markers repeat a 120-character path (about 270 tokens).
    const body = W72A_CARD.replace(/^# Task card\n/, '').replace(/^## /gm, '### ');
    expect(capCard472(body, estimateTokens, 1176, W72A_CARD_PATH)).toBeUndefined();
    expect(capCard472(body, estimateTokens, 1300, W72A_CARD_PATH)).toBeDefined();
  });

  for (const budget of [1250, 1301]) {
    it(`keeps Next step with a line and a marker at a card budget of ${budget} (w72a cuts 10 and 6)`, () => {
      const section = renderCardSection(W72A_CARD, W72A_CARD_PATH, estimateTokens, budget);
      expect(estimateTokens(section)).toBeLessThanOrEqual(budget);
      const lines = section.split('\n');
      const next = lines.indexOf('### Next step');
      expect(next).toBeGreaterThan(-1);
      expect(lines[next + 1].trim().length).toBeGreaterThan(10);
      expect(lines[next + 1].startsWith('Grep the three c2 tests')).toBe(true);
      for (const heading of ['### Goal', '### Acceptance checks']) expect(lines).toContain(heading);
      expect(section).toMatch(/- \(\d+ more lines in \/home\/u\/work\/app\/sandbox\/run-a\/project\/\.exovault\/.+task-card\.md\)/);
      const acceptance = lines[lines.indexOf('### Acceptance checks') + 1];
      expect(acceptance.length).toBeGreaterThan(20);
    });
  }

  it('shortens a first line with an ellipsis and counts the lines left out', () => {
    const card = capCard(W72A_CARD, estimateTokens, 900, '/p/task-card.md');
    expect(estimateTokens(card)).toBeLessThanOrEqual(900);
    expect(card).toContain('…');
    expect(card).toContain('## Next step\nGrep the three c2 tests');
    expect(shownAndMarked(card).shown + shownAndMarked(card).marked).toBe(bodyLines(W72A_CARD));
  });

  it('replaces whole sections by one marker each when even short first lines do not fit, Next step kept longest, then Acceptance, then Goal', () => {
    const order = ['Next step', 'Acceptance checks', 'Goal', 'Rules', 'Decisions', 'Done'];
    let dropping = 0;
    let last: string | undefined;
    for (let budget = 150; budget <= 1100; budget += 5) {
      const card = capCard(W72A_CARD, estimateTokens, budget, W72A_CARD_PATH);
      expect(estimateTokens(card)).toBeLessThanOrEqual(budget);
      if (!card.includes(' left out: ')) continue;
      dropping += 1;
      const kept = order.filter((title) => card.includes(`## ${title}\n`));
      // A section is kept only when every more important one is kept.
      expect(kept).toEqual(order.slice(0, kept.length));
      for (const title of order.slice(kept.length)) expect(card).toContain(`- (${title} left out: `);
      expect(card).toMatch(/## Next step\nGrep the three c2 tests/);
      last = card;
    }
    expect(dropping).toBeGreaterThan(5);
    expect(last).toMatch(/- \(Done left out: 2 lines in \/home\/u\/work\/app\//);
  });

  it('ends the fewer-than-two-sections path with a marker line', () => {
    const one = `# Task card\n## Goal\n${Array.from({ length: 50 }, (_, i) => `- line ${i} of the goal with some words`).join('\n')}`;
    const card = capCard(one, estimateTokens, 120, '/p/c.md');
    expect(estimateTokens(card)).toBeLessThanOrEqual(120);
    const last = card.split('\n').at(-1)!;
    expect(last).toMatch(/^- \(\d+ more lines in \/p\/c\.md\)$/);
    expect(one.startsWith(card.split('\n').slice(0, -1).join('\n'))).toBe(true);
    const counted = shownAndMarked(card);
    expect(counted.shown + counted.marked).toBe(50);
  });

  it('stays within the budget and accounts for every dropped line, budgets 200 to 2500', () => {
    for (const [card, path] of [[W72A_CARD, W72A_CARD_PATH], [LONG_RULES, '/p/task-card.md'], [BIG_HEAD, '/p/task-card.md'], [SMALL_CARD, undefined]] as const) {
      const total = bodyLines(card);
      for (let budget = 200; budget <= 2500; budget += 37) {
        const capped = capCard(card, estimateTokens, budget, path);
        expect(estimateTokens(capped), `capCard ${budget}`).toBeLessThanOrEqual(budget);
        const counted = shownAndMarked(capped);
        if (capped !== card) expect(counted.shown + counted.marked, `accounted at ${budget}`).toBe(total);
        const rendered = renderCardSection(card, path ?? '/p/task-card.md', estimateTokens, budget);
        expect(estimateTokens(rendered), `render ${budget}`).toBeLessThanOrEqual(budget);
        const body = rendered.split('\n').slice(1);
        if (body.length > 0 && rendered.split('\n').length > 1 && !rendered.endsWith('stay on disk.)')) expect(body.join('\n')).toMatch(/^### |^- \(/m);
      }
    }
  });

  it('cuts at a line only for a tiny budget and still ends in a marker', () => {
    const card = parseCardReply(SMALL_CARD, estimateTokens, 30)!;
    expect(estimateTokens(card)).toBeLessThanOrEqual(30);
    const lines = card.split('\n');
    expect(lines.at(-1)).toMatch(/^- \(\d+ more lines? cut\)$/);
    expect(SMALL_CARD.startsWith(lines.slice(0, -1).join('\n'))).toBe(true);
  });

  it('is byte-identical to 4.7.2 for every card and budget that fit with one line per section', () => {
    let compared = 0;
    let fellBack = 0;
    for (const [card, path] of [[W72A_CARD, W72A_CARD_PATH], [LONG_RULES, '/p/task-card.md'], [BIG_HEAD, undefined], [SMALL_CARD, '/p/task-card.md'], [SMALL_CARD, undefined]] as const) {
      for (let budget = 20; budget <= 3200; budget += 7) {
        const old = capCard472(card, estimateTokens, budget, path);
        if (old === undefined) { fellBack += 1; continue; }
        compared += 1;
        expect(capCard(card, estimateTokens, budget, path), `${budget}`).toBe(old);
      }
    }
    expect(compared).toBeGreaterThan(200);
    expect(fellBack).toBeGreaterThan(20);
  });

  it('counts body lines only in the line-cut marker, not the card title (Grok minor)', () => {
    const card = '# Task card\n## Goal\nhello, this goal line is long enough to cost more than the marker.';
    // The budget where only the marker alone (nothing of the card) fits.
    const budget = Array.from({ length: estimateTokens(card) }, (_, i) => i + 1).find((tokens) => capCard(card, estimateTokens, tokens, '/p/c.md').startsWith('- ('));
    expect(budget).toBeDefined();
    expect(capCard(card, estimateTokens, budget!, '/p/c.md')).toBe('- (1 more line in /p/c.md)');
  });

  it('keeps first lines at 24 characters or more and drops the lowest-priority section instead (the floor is deliberate)', () => {
    let budget = 1300;
    while (budget > 200 && !capCard(W72A_CARD, estimateTokens, budget, W72A_CARD_PATH).includes(' left out: ')) budget -= 1;
    // The largest budget at which a section is dropped: all six headings with 12-character first lines would still fit it.
    const sections = W72A_CARD.split('\n## ').slice(1).map((part) => part.split('\n').filter((line) => line.trim()));
    const twelve = ['# Task card', ...sections.flatMap(([heading, first, ...rest]) => ['## ' + heading, `${first.slice(0, 11)}…`, ...(rest.length ? [`- (${rest.length} more lines in ${W72A_CARD_PATH})`] : [])])].join('\n');
    expect(estimateTokens(twelve)).toBeLessThanOrEqual(budget);
    const card = capCard(W72A_CARD, estimateTokens, budget, W72A_CARD_PATH);
    expect(card).toMatch(/- \(Done left out: 2 lines in /);
    expect(card).not.toContain('## Done');
    const lines = card.split('\n');
    const next = lines[lines.indexOf('## Next step') + 1];
    expect(next.length).toBeGreaterThanOrEqual(24);
    for (const [heading, first] of sections.map(([h, f]) => [h, f] as const)) {
      const at = lines.indexOf(`## ${heading}`);
      if (at !== -1) expect(lines[at + 1].length).toBeGreaterThanOrEqual(Math.min(24, first.length));
    }
  });
});
