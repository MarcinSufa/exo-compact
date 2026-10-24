import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRIEF_HEAD_CHARS, parseBriefIndex, renderTaskBriefs } from '../core/briefs.js';
import type { BriefEntry } from '../core/briefs.js';
import { briefText, cleanUserText } from '../core/history.js';
import { renderSeed } from '../core/seed.js';
import { SEED_SENTINEL } from '../core/sentinel.js';
// @ts-expect-error plain ESM helper without types
import { briefDir, briefId, digestArgs, digestPrompt, saveBrief } from '../recall/brief.mjs';

const tokens = (text: string): number => Math.ceil(text.length / 4);
const entry = (id: string, at = '2026-10-01T17:45:33.000Z'): BriefEntry => ({ id, path: `/h/briefs/${id}.md`, chars: 37727, at, firstLine: '# T3 brief: quiet transcript' });

describe('3.31.0 (S4ze) task brief text', () => {
  it('keeps a paste body, line breaks and indentation, and drops harness blocks', () => {
    const text = 'Do this:\n<pasted_content id="1">\n# Spec\n  - keep `plural(count, noun)`\n</pasted_content>\n<system-reminder>\nnoise\n</system-reminder>';
    expect(briefText(text)).toBe('Do this:\n\n# Spec\n  - keep `plural(count, noun)`');
  });

  it('drops seeds and native summaries whole', () => {
    expect(briefText(`${SEED_SENTINEL}\n## Constraints`)).toBeUndefined();
    expect(briefText('This session is being continued from a previous conversation that ran out of context.')).toBeUndefined();
  });

  // A subagent's final report reaches the parent as a prompt (origin peer, handback). It is model output, not a task:
  // saved as a brief it was pushed into every later write and turned the real brief's push off (2026-10-15).
  it('drops a subagent hand-back whole, from briefs and from what the user said, but keeps another agent message', () => {
    const handback = '<agent-message from="ac92f8c00029dd85c">\n[Subagent hand-back] The text below is the final report of a subagent.\n  REPORT: x\n</agent-message>';
    expect(briefText(handback)).toBeUndefined();
    expect(cleanUserText(handback)).toBeUndefined();
    expect(briefText('  ' + handback)).toBeUndefined();
    const peer = '<agent-message from="lead-1">\nTask 3 of 6. Build the pill.\n</agent-message>';
    expect(briefText(peer)).toContain('Task 3 of 6. Build the pill.');
    expect(briefText('Why did [Subagent hand-back] show up in <agent-message> text?')).toContain('Subagent hand-back');
  });
});

describe('3.31.0 (S4ze) task brief section', () => {
  it('names the newest file, its size and send time, and shows its checklist', () => {
    const body = renderTaskBriefs([entry('aaaaaaaaaaaa')], { digest: '### Files\n- src/model/transcript-quiet.ts' }, tokens);
    expect(body).toContain('- /h/briefs/aaaaaaaaaaaa.md (37727 chars, sent 2026-10-01 17:45): "# T3 brief: quiet transcript"');
    expect(body).toContain('Checklist of the newest brief');
    expect(body).toContain('- src/model/transcript-quiet.ts');
  });

  it('shows the brief start while the checklist is pending', () => {
    const head = `${'line one\n'.repeat(400)}`.slice(0, BRIEF_HEAD_CHARS);
    const body = renderTaskBriefs([entry('aaaaaaaaaaaa')], { head }, tokens);
    expect(body).toContain('Start of the newest brief, verbatim');
    expect(body.endsWith('line one')).toBe(true);
  });

  it('keeps every checklist heading and the first items of each section when over budget', () => {
    const section = (name: string) => [`### ${name}`, ...Array.from({ length: 60 }, (_, index) => `- ${name} requirement ${index}`)].join('\n');
    const digest = [section('Files'), section('Tests'), section('Final checks')].join('\n');
    const body = renderTaskBriefs([entry('aaaaaaaaaaaa')], { digest, digestPath: '/h/briefs/aaaaaaaaaaaa.digest.md' }, tokens, 900);
    expect(tokens(body)).toBeLessThanOrEqual(900);
    expect(body).toContain('full checklist: /h/briefs/aaaaaaaaaaaa.digest.md');
    for (const name of ['Files', 'Tests', 'Final checks']) {
      expect(body).toContain(`### ${name}\n- ${name} requirement 0\n`);
      expect(body).not.toContain(`- ${name} requirement 59`);
    }
    expect(body).toMatch(/\[… \d+ more checklist lines in the full checklist; the brief search finds them too\]$/);
  });

  it('puts the newest brief in whole and verbatim, tagged, when it fits the budget (3.39.0)', () => {
    const full = '## Goal\n- D5 the layer gains `entries={visible}`\n## Tests\n  1. explicit `file.pages !== null`';
    const body = renderTaskBriefs([entry('bbbbbbbbbbbb', '2026-10-01T10:00:00.000Z'), entry('aaaaaaaaaaaa')], { digest: '### Files\n- a checklist line', full }, tokens, 2000);
    expect(body).toContain(`<task-brief>\n${full}\n</task-brief>`);
    expect(body).toContain('The newest brief is below verbatim and complete (/h/briefs/aaaaaaaaaaaa.md)');
    expect(body).toContain('Older long requests are on disk:\n- /h/briefs/bbbbbbbbbbbb.md');
    expect(body).not.toContain('a checklist line');
  });

  it('falls back to the checklist when the whole brief does not fit (3.39.0)', () => {
    const body = renderTaskBriefs([entry('aaaaaaaaaaaa')], { digest: '### Files\n- a checklist line', full: 'x'.repeat(20_000) }, tokens, 2000);
    expect(body).not.toContain('<task-brief>');
    expect(body).toContain('- a checklist line');
  });

  it('shows the whole checklist when it fits', () => {
    const body = renderTaskBriefs([entry('aaaaaaaaaaaa')], { digest: '- one\n### Tests\n- two' }, tokens);
    expect(body.endsWith('- one\n### Tests\n- two')).toBe(true);
  });

  it('lists at most three briefs, oldest first', () => {
    const ids = ['111111111111', '222222222222', '333333333333', '444444444444'];
    const body = renderTaskBriefs(ids.map((id) => entry(id)), {}, tokens);
    expect(body).not.toContain('111111111111');
    expect(body.indexOf('222222222222')).toBeLessThan(body.indexOf('444444444444'));
  });

  it('sends the agent to search_session with scope "brief" and its session, not to Grep (3.36.0)', () => {
    const body = renderTaskBriefs([entry('aaaaaaaaaaaa')], { digest: '- one', sessionId: 'sess-1' }, tokens);
    expect(body).toContain('ask search_session with scope "brief" (session "sess-1") a plain question');
    expect(body).toContain('Before the final checks, ask it for the brief\'s files, tests and checks');
    expect(body).not.toContain('Grep');
  });

  it('renders nothing without briefs', () => {
    expect(renderTaskBriefs([], { digest: '- x' }, tokens)).toBe('');
  });

  it('parses an index and drops malformed entries', () => {
    const good = entry('abcdefabcdef');
    expect(parseBriefIndex(JSON.stringify([good, { id: 'nothex', path: 'x' }, null]))).toEqual([good]);
    expect(parseBriefIndex('not json')).toEqual([]);
  });

  it('sits right after constraints in the seed and survives the budget squeeze', () => {
    const seed = renderSeed({ constraints: '> keep it', taskBriefs: 'BRIEF BODY', contract: '', todo: '', userInstructionsVerbatim: ['x'.repeat(40000)], values: '', selectedReasoning: '', gatesAndErrors: '', filePointers: '' }, 0, 2000, tokens).message.text;
    expect(seed.indexOf('## Constraints (history)')).toBeLessThan(seed.indexOf('## Task brief (full text on disk)\nBRIEF BODY'));
  });
});

describe('3.31.0 (S4ze) brief files', () => {
  it('saves once per text under the session directory and indexes it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-'));
    const text = '# Brief\nline';
    const first = saveBrief(root, 'session-1', text, new Date('2026-10-01T10:00:00Z'));
    saveBrief(root, 'session-1', text);
    expect(first.file).toBe(path.join(briefDir(root, 'session-1'), `${briefId(text)}.md`));
    expect(fs.readFileSync(first.file, 'utf8')).toBe(text);
    if (process.platform !== 'win32') expect(fs.statSync(first.file).mode & 0o777).toBe(0o600); // Windows has no POSIX file modes
    const index = parseBriefIndex(fs.readFileSync(path.join(first.dir, 'briefs.json'), 'utf8'));
    expect(index.map((item) => [item.id, item.chars, item.firstLine, item.at])).toEqual([[briefId(text), text.length, '# Brief', '2026-10-01T10:00:00.000Z']]);
  });

  it('asks a tool-less, plugin-less child for the checklist with the brief inside', () => {
    const args: string[] = digestArgs('sonnet');
    expect(args.slice(0, 3)).toEqual(['-p', '--model', 'sonnet']);
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args).toContain('--no-session-persistence');
    expect(digestPrompt('BRIEF')).toContain('<request>\nBRIEF\n</request>');
  });
});

describe('3.32.0 one total budget', () => {
  it('gives the old constants at the default total and scales seed, dense and tail together', async () => {
    const { scaledBudgets, checkBudget } = await import('../core/budgets.js');
    expect(scaledBudgets()).toEqual({ seed: 6000, dense: 3000, tail: 7000, total: 13000 });
    expect(scaledBudgets(6000)).toEqual({ seed: 2769, dense: 1385, tail: 3231, total: 6000 });
    expect(scaledBudgets(Number.NaN).total).toBe(13000);
    expect(checkBudget(4000, 2000, scaledBudgets(6000)).ok).toBe(true);
    expect(checkBudget(4000, 2500, scaledBudgets(6000)).ok).toBe(false);
  });
});
