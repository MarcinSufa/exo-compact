import { LEGACY_OPTIONS } from './fixtures/helpers.js';
import { execFileSync } from 'node:child_process';
import { SCRUBBED_ENV } from '../host/node-run.js';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { register } from '../compact.js';
import { BRIEF_CHECK_DONE, BRIEF_CHECK_FILE } from '../core/brief-check.js';
import { parseRuleCheck, parseRuleSkip, parseSeenRules, ruleSkipWarning, renderRuleCheckReason, renderSeenRules, RULE_CHECK_SEEN_FILE, rulesToBlock } from '../core/rule-check.js';
import { TASK_CARD_BRIEF_FILE, TASK_CARD_FILE } from '../core/task-card.js';
import { isWarningLine } from '../host/notices.js';
import { sha256 } from '../host/sha256.js';
// @ts-expect-error plain ESM module without types, run by node outside the hook
import { CHECKABLE_THRESHOLD, FINISHED_THRESHOLD, HANDBACK_THRESHOLD, REPORT_THRESHOLD, WORK_THRESHOLD, buildRuleRequests, cardRules, decideBroken, lineLimit, reportLines, ruleCheck, ruleCheckSkipReason, splitLimitRules, workDiff } from '../recall/rule-check.mjs';

type Handler = (...args: never[]) => unknown;

const CARD = [
  '# Task card',
  '## Goal',
  'Build the lane fit.',
  '## Rules',
  '- Final report, at most 14 lines [brief line 69; user house rules]:',
  '  - Line 1: `SLICE r2 DONE` if every check is green.',
  '  - The report lists:',
  '    - Files created or changed, with line counts.',
  '- Test file prefix is `r2` [user, task 5 message]. Plain `it(` blocks',
  '  [brief line 47].',
  '## Decisions',
  '- Zoom never goes in.',
  '## Acceptance checks',
  '- pnpm test passes',
].join('\n');

describe('3.48.0 (S4zv) rule units from the task card', () => {
  it('turns each Rules bullet into one unit, nested ones led by short parent headings, source tags dropped', () => {
    expect(cardRules(CARD)).toEqual([
      'Final report, at most 14 lines',
      'Final report > Line 1: `SLICE r2 DONE` if every check is green.',
      'Final report > The report lists > Files created or changed, with line counts.',
      'Test file prefix is `r2`. Plain `it(` blocks.',
    ]);
  });

  it('keeps brackets inside code spans and quotes, and drops only source tags', () => {
    const card = '## Rules\n- Titles start with the id: `describe("[r12] lane fit")` [user, house rules]\n- SCOPE [l.48]: a.ts [brief line 4; G2]\n- Ask cites "[v1]" ids';
    expect(cardRules(card)).toEqual(['Titles start with the id: `describe("[r12] lane fit")`', 'SCOPE: a.ts', 'Ask cites "[v1]" ids']);
  });

  it('has no units without a Rules section', () => {
    expect(cardRules('# Task card\n## Goal\nx')).toEqual([]);
  });
});

describe('3.48.0 (S4zv) Jev decision per rule', () => {
  const units = ['report rule', 'work rule', 'unanswered rule'];

  it('judges a report rule on the report score and a work rule on the work score, each at its own bar', () => {
    const report = { c0: { noul: 0.9 }, k0: { noul: 0.9 }, r0: { noul: REPORT_THRESHOLD }, c1: { noul: 0.9 }, k1: { noul: 0.1 }, r1: { noul: 0.99 }, c2: { noul: 0.9 }, k2: { noul: 0.9 } };
    const work = { w0: { noul: 0.99 }, w1: { noul: WORK_THRESHOLD } };
    expect(decideBroken(units, report, work)).toEqual([
      { rule: 'report rule', kind: 'report', score: REPORT_THRESHOLD },
      { rule: 'work rule', kind: 'work', score: WORK_THRESHOLD },
    ]);
  });

  it('keeps a rule just under its bar, and a rule without a kind answer', () => {
    const report = { c0: { noul: 0.9 }, k0: { noul: 0.9 }, r0: { noul: REPORT_THRESHOLD - 0.01 }, c1: { noul: 0.9 }, k1: { noul: 0.1 }, c2: { noul: 0.9 }, r2: { noul: 1 } };
    expect(decideBroken(units, report, { w1: { noul: WORK_THRESHOLD - 0.01 }, w2: { noul: 1 } })).toEqual([]);
  });

  it('never counts a bullet Jev does not see as a checkable rule (a pointer, a baseline, a heading)', () => {
    const report = { c0: { noul: CHECKABLE_THRESHOLD - 0.01 }, k0: { noul: 0.9 }, r0: { noul: 1 }, k1: { noul: 0.1 } };
    expect(decideBroken(['Brief (authority): /r/briefs/a.md', 'no answer on checkable'], report, { w1: { noul: 1 } })).toEqual([]);
  });

  it('3.51.0: decides a report rule with a line limit by counting non-blank lines, whatever Jev scored (w60j)', () => {
    const rule = 'Final reply at most 12 lines in total: files created or changed with line counts, any BLOCKER.';
    const answers = { c0: { noul: 0.9 }, k0: { noul: 0.95 }, r0: { noul: 0.88 } };
    const eight = ['SLICE r4 DONE', 'Tests: 1627 passed, 33 new', '', 'a', 'b', 'c', 'd', 'e', '', 'Review: W17-5307'].join('\n');
    expect(decideBroken([rule], answers, {}, eight)).toEqual([]);
    const seventeen = Array.from({ length: 17 }, (_, i) => `line ${i}`).join('\n');
    expect(decideBroken([rule], { ...answers, r0: { noul: 0 }, c0: { noul: 0 } }, {}, seventeen)).toEqual([{ rule, kind: 'report', score: 1 }]);
  });

  it('3.51.0: leaves a file line limit (a work rule) and calls without the report to Jev', () => {
    const rule = 'graph.tsx stays at most 250 lines';
    const answers = { c0: { noul: 0.9 }, k0: { noul: 0.1 } };
    expect(decideBroken([rule], answers, { w0: { noul: 0.99 } }, 'one line')).toEqual([{ rule, kind: 'work', score: 0.99 }]);
    expect(decideBroken(['Report at most 2 lines'], { c0: { noul: 0.9 }, k0: { noul: 0.9 }, r0: { noul: 0.1 } }, {})).toEqual([]);
  });

  it('3.51.0: reads the strictest limit and counts non-blank lines', () => {
    expect(lineLimit('Final reply at most 14 lines by the brief; no more than 12 lines to be safe')).toBe(12);
    expect(lineLimit('Report: max 10 lines.')).toBe(10);
    expect(lineLimit('No em dashes.')).toBeUndefined();
    expect(reportLines('a\n\n  \nb\n')).toBe(2);
  });

  it('sends the report alone to the report questions and the diff only to the work questions', () => {
    const { reportBody, workBody } = buildRuleRequests(['r'], 'SLICE r2 DONE', '+const a = 1;', 'jev-latest');
    expect(JSON.stringify(reportBody)).not.toContain('const a = 1');
    expect(workBody.state.work).toContain('+const a = 1;');
    expect(Object.keys(reportBody.questions)).toEqual(['m', 'c0', 'k0', 'r0', 'f0']);
    expect(Object.keys(workBody.questions)).toEqual(['w0']);
  });

  it('returns nothing on a Jev failure, an empty report or no rules', async () => {
    const config = { key: 'k', model: 'jev-latest', timeoutMs: 1000 };
    const failing = async () => ({ ok: false, status: 500, json: async () => ({}) });
    expect(await ruleCheck({ rules: ['r'], report: 'x' }, config, '', failing)).toBeUndefined();
    expect(await ruleCheck({ rules: ['r'], report: ' ' }, config, '', failing)).toBeUndefined();
    expect(await ruleCheck({ rules: [], report: 'x' }, config, '', failing)).toBeUndefined();
  });
});

describe('3.48.0 (S4zv) result and block text', () => {
  it('drops malformed entries and rejects output without broken and units', () => {
    const parsed = parseRuleCheck(JSON.stringify({ broken: [{ rule: 'a', kind: 'report', score: 0.9 }, { rule: '', kind: 'report', score: 1 }, { rule: 'b', kind: 'x', score: 1 }], units: 3, ms: 400 }));
    expect(parsed).toEqual({ broken: [{ rule: 'a', kind: 'report', score: 0.9 }], units: 3, ms: 400 });
    expect(parseRuleCheck('{"broken":[]}')).toBeUndefined();
    expect(parseRuleCheck('')).toBeUndefined();
  });

  it('lists only the broken rules and asks for the full final message again', () => {
    const text = renderRuleCheckReason([{ rule: 'Final report > Line 1: `SLICE r2 DONE`', kind: 'report', score: 0.96 }], '/c/task-card.md');
    expect(text).toContain('- Final report > Line 1: `SLICE r2 DONE` (your final message)');
    expect(text).toContain('/c/task-card.md');
    expect(text).toMatch(/The check can be wrong/);
    expect(text).toMatch(/send your final report again, in full, as your whole last message: it starts with the report's own first line/);
    expect(text).toMatch(/says nothing about this check before or after it/);
  });
});

const CAPTURE = '/tmp/project/.exovault/s4-capture/s1';
const FLAG = '/tmp/project/.exovault/s4-compact-active';

function handlers(options: Record<string, unknown> = {}): Record<string, Handler> {
  const on: Record<string, Handler> = {};
  register(((name: string, fn: Handler) => { on[name] = fn; return { catch: (caught: unknown) => { (on as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS, recallPluginRoot: '/plugin', ruleCheck: true, ...options } as never);
  return on;
}

function host(options: { files?: Record<string, string>; ran?: { exitCode: number; stdout: string } | 'throw' } = {}) {
  const files = new Map<string, string>(Object.entries(options.files ?? { [`${CAPTURE}/${TASK_CARD_FILE}`]: CARD }));
  const logs: string[] = [];
  const runs: { argv: readonly string[]; init: { stdin?: string; env?: Record<string, string>; timeoutMs?: number } }[] = [];
  return {
    files, logs, runs,
    session: { cwd: async () => '/tmp/project', id: async () => 's1' },
    fs: {
      exists: async (p: string) => p === FLAG || files.has(p),
      read: async (p: string) => { if (files.has(p)) return files.get(p)!; throw new Error('ENOENT'); },
      write: async (p: string, text: string) => { files.set(p, text); },
      list: async () => [],
    },
    env: { get: async () => undefined },
    process: {
      run: async (argv: readonly string[], init: { stdin?: string }) => {
        // 4.9.2 review: the capture guard's harden.mjs run is not a rule check.
        if (String(argv[1]).endsWith('/harden.mjs')) return { exitCode: 0, stdout: '', stderr: '' };
        runs.push({ argv, init });
        if (options.ran === 'throw') throw new Error('timeout');
        return { stderr: '', ...(options.ran ?? { exitCode: 0, stdout: JSON.stringify({ broken: [], units: 4, ms: 380 }) }) };
      },
    },
    ui: { log: (line: string) => { logs.push(line); } },
  };
}

const stop = { hook_event_name: 'Stop', session_id: 's1', transcript_path: '/t.jsonl', cwd: '/tmp/project', stop_hook_active: false, last_assistant_message: 'SLICE r2 DONE\nTests: 3 passed, 1 new' };
const pass = async () => ({});
const brokenOut = JSON.stringify({ broken: [{ rule: 'Final report > Last line: `Review: W17-5307`', kind: 'report', score: 0.97 }], units: 4, ms: 410 });

describe('3.48.0 (S4zv) stop hook', () => {
  it('runs with jevEnabled off and passes a clean turn with nothing pasted, and sends the card and the final message to rule-check.mjs', async () => {
    const h = host();
    const result = await handlers({ jevEnabled: false })['classic.Stop']!(h as never, stop as never, pass as never) as { block?: string };
    expect(result.block).toBeUndefined();
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]!.argv).toEqual(['node', '/plugin/recall/rule-check.mjs', '/tmp/project']);
    expect(JSON.parse(h.runs[0]!.init.stdin!)).toEqual({ card: CARD, report: stop.last_assistant_message });
    expect(h.runs[0]!.init.env).toEqual({ ...SCRUBBED_ENV, EXO_JEV_MODEL: 'jev-latest' });
    expect(h.logs).toContain('rule_check.fired=0 broken=0 units=4 ms=380');
  });

  it('blocks with the broken rules alone, not the card acceptance checks or the brief', async () => {
    const h = host({ ran: { exitCode: 0, stdout: brokenOut } });
    const result = await handlers()['classic.Stop']!(h as never, stop as never, pass as never) as { block?: string };
    expect(result.block).toContain('- Final report > Last line: `Review: W17-5307` (your final message)');
    expect(result.block).not.toContain('pnpm test passes');
    expect(h.logs).toContain('rule_check.fired=1 broken=1 units=4 ms=410');
  });

  it('marks a pending post-cut brief check done, so the same stop does not also paste the card checks', async () => {
    const h = host({ files: { [`${CAPTURE}/${TASK_CARD_FILE}`]: CARD, [`${CAPTURE}/${BRIEF_CHECK_FILE}`]: '{"brief":"abc","path":"/b.md","whole":true,"lines":[{"line":1,"text":"x"}],"text":"1: x"}' } });
    await handlers()['classic.Stop']!(h as never, stop as never, pass as never);
    expect(h.files.get(`${CAPTURE}/${BRIEF_CHECK_FILE}`)).toBe(BRIEF_CHECK_DONE);
  });

  it('skips a card written before the newest saved brief (an earlier task), and checks one written for it', async () => {
    const index = `./.claude/exovault/recall/${sha256('s1')}/briefs/briefs.json`;
    const brief = (id: string) => ({ id, path: `/r/briefs/${id}.md`, chars: 900, at: '2026-10-03T21:14:35.121Z', firstLine: 'Task 3 of 8.' });
    const briefs = JSON.stringify([brief('0079b6e175c9'), brief('653bdcf9b439')]);
    for (const [cardBrief, runs] of [[undefined, 0], ['0079b6e175c9', 0], ['653bdcf9b439', 1]] as const) {
      const files: Record<string, string> = { [`${CAPTURE}/${TASK_CARD_FILE}`]: CARD, [index]: briefs };
      if (cardBrief) files[`${CAPTURE}/${TASK_CARD_BRIEF_FILE}`] = cardBrief;
      const h = host({ files });
      await handlers()['classic.Stop']!(h as never, stop as never, pass as never);
      expect(h.runs).toHaveLength(runs);
      if (!runs) expect(h.logs).toContain('rule_check.fired=0 reason=card_stale');
    }
  });

  it('falls back to the 3.47 card check when rule-check.mjs fails or prints nothing', async () => {
    for (const ran of ['throw', { exitCode: 0, stdout: '' }, { exitCode: 1, stdout: brokenOut }] as const) {
      const h = host({ ran, files: { [`${CAPTURE}/${TASK_CARD_FILE}`]: CARD, [`${CAPTURE}/${BRIEF_CHECK_FILE}`]: '{"brief":"abc","path":"/b.md","whole":true,"lines":[{"line":1,"text":"x"}],"text":"1: x"}' } });
      const result = await handlers()['classic.Stop']!(h as never, stop as never, pass as never) as { block?: string };
      expect(result.block).toContain('pnpm test passes');
      expect(h.logs.some((line) => /^rule_check\.fired=0 reason=(error|no_result)$/.test(line))).toBe(true);
    }
  });

  it('does not run by default, with the option off, in a denied directory, without a card, in a subagent or on a continued stop', async () => {
    const cases: [Record<string, unknown>, ReturnType<typeof host>, Record<string, unknown>][] = [
      [{ ruleCheck: undefined }, host(), stop],
      [{ ruleCheck: false }, host(), stop],
      [{ jevDenyList: '/tmp/project' }, host(), stop],
      [{}, host({ files: {} }), stop],
      [{}, host(), { ...stop, agent_id: 'a1' }],
      [{}, host(), { ...stop, stop_hook_active: true }],
    ];
    for (const [options, h, input] of cases) {
      await handlers(options)['classic.Stop']!(h as never, input as never, pass as never);
      expect(h.runs).toHaveLength(0);
    }
  });
});

describe('3.56.0 rule check fixes (external review 5 C1, C3-C5)', () => {
  const config = { key: 'k', model: 'jev-latest', timeoutMs: 1000 };
  const answerAll = (body: { questions: Record<string, unknown> }, score: (id: string) => number) => ({ ok: true, status: 200, json: async () => ({ answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { noul: score(id) }])) }) });

  it('splits a line-limit rule so its other clauses are still judged, and leaves length restatements to the count', () => {
    expect(splitLimitRules(['Final report at most 12 lines; first line must be SLICE r2 DONE; list changed files.'])).toEqual(['Final report at most 12 lines', 'first line must be SLICE r2 DONE', 'list changed files']);
    expect(splitLimitRules(['Final reply at most 14 lines. Keep it at 12 or fewer counting header lines. Cover the files changed'])).toEqual(['Final reply at most 14 lines', 'Cover the files changed']);
    expect(splitLimitRules(['Final reply at most 10 lines: files, verify results, deviations'])).toEqual(['Final reply at most 10 lines: files, verify results, deviations']);
    expect(splitLimitRules(['No em dashes; plain it( blocks'])).toEqual(['No em dashes; plain it( blocks']);
  });

  it('catches a wrong header in a compound rule with a report under its line limit', async () => {
    const fetchImpl = async (_url: string, init: { body: string }) => answerAll(JSON.parse(init.body), () => 1);
    const result = await ruleCheck({ rules: ['Final report at most 12 lines; first line must be SLICE r2 DONE'], report: 'Done.' }, config, '', fetchImpl);
    expect(result.broken.map((entry: { rule: string }) => entry.rule)).toEqual(['first line must be SLICE r2 DONE']);
  });

  it('keeps the report verdicts when the work request fails', async () => {
    const fetchImpl = async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      return 'w0' in body.questions ? { ok: false, status: 500, json: async () => ({}) } : answerAll(body, () => 1);
    };
    const result = await ruleCheck({ rules: ['Line 1 is SLICE r2 DONE'], report: 'hello' }, config, '', fetchImpl);
    expect(result.broken).toHaveLength(1);
    expect(result.workFailed).toBe(true);
  });

  it('reads new files of the whole repository from a subdirectory, without secret paths, symlinks out, or secret values', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-diff-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base');
    fs.mkdirSync(path.join(root, 'a'));
    fs.mkdirSync(path.join(root, 'b'));
    fs.writeFileSync(path.join(root, 'b', 'new.txt'), 'SIBLING_CANARY\nAPI_KEY=canary-value-123\n');
    fs.writeFileSync(path.join(root, 'a', '.env.local'), 'ENV_CANARY\n');
    fs.writeFileSync(path.join(os.tmpdir(), 'outside-canary.txt'), 'OUTSIDE_CANARY\n');
    try { fs.symlinkSync(path.join(os.tmpdir(), 'outside-canary.txt'), path.join(root, 'a', 'link.txt')); } catch (error) {
      if (process.platform !== 'win32') throw error; // a symlink needs Developer Mode on Windows
    }
    const diff = workDiff(path.join(root, 'a'));
    expect(diff).toContain('SIBLING_CANARY');
    expect(diff).not.toContain('canary-value-123');
    expect(diff).not.toContain('ENV_CANARY');
    expect(diff).not.toContain('OUTSIDE_CANARY');
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('4.2.0 (S5b) no hand-back rules on a progress update', () => {
  const config = { key: 'k', model: 'jev-latest', timeoutMs: 1000 };
  const units = ['DONE line: PR URL plus a 5-line summary', 'No em dashes in messages', 'UI slices ship Playwright specs', 'Never push .github/workflows/*', 'Final reply at most 2 lines'];
  const report = {
    c0: { noul: 0.9 }, k0: { noul: 0.9 }, r0: { noul: 0.95 }, f0: { noul: 0.9 },
    c1: { noul: 0.9 }, k1: { noul: 0.9 }, r1: { noul: 0.95 }, f1: { noul: 0.1 },
    c2: { noul: 0.9 }, k2: { noul: 0.1 }, f2: { noul: FINISHED_THRESHOLD },
    c3: { noul: 0.9 }, k3: { noul: 0.1 }, f3: { noul: FINISHED_THRESHOLD - 0.01 },
    c4: { noul: 0.9 }, k4: { noul: 0.9 }, f4: { noul: 0.9 },
  };
  const work = { w2: { noul: 0.99 }, w3: { noul: 0.99 } };
  const progressMessage = 'Reviewer round 2 is running.\nI will re-run the gate when it finishes.\nThen the review.';

  it('skips rules judged only on the finished task, report and work alike, and still checks rules that always hold', () => {
    expect(decideBroken(units, { ...report, m: { noul: HANDBACK_THRESHOLD - 0.01 } }, work, progressMessage).map((entry) => entry.rule))
      .toEqual(['No em dashes in messages', 'Never push .github/workflows/*']);
  });

  it('checks every rule on the hand-back, and when Jev gave no hand-back answer', () => {
    expect(decideBroken(units, { ...report, m: { noul: HANDBACK_THRESHOLD } }, work, progressMessage).map((entry) => entry.rule)).toEqual(units);
    expect(decideBroken(units, report, work, progressMessage).map((entry) => entry.rule)).toEqual(units);
  });

  it('checks a rule on a progress update when Jev gave no finished answer for it', () => {
    expect(decideBroken(['No em dashes in messages'], { c0: { noul: 0.9 }, k0: { noul: 0.9 }, r0: { noul: 0.95 }, m: { noul: 0 } }, {}, progressMessage)).toHaveLength(1);
  });

  it('marks the result as a progress update, and the hook parses the mark', async () => {
    const fetchImpl = async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { noul: id === 'm' ? 0.1 : id.startsWith('f') ? 0.9 : 1 }])) }) };
    };
    const result = await ruleCheck({ rules: ['DONE line: PR URL plus a 5-line summary'], report: progressMessage }, config, '', fetchImpl);
    expect(result).toMatchObject({ broken: [], units: 1, progress: true });
    expect(parseRuleCheck(JSON.stringify(result))?.progress).toBe(true);
    expect(parseRuleCheck(JSON.stringify({ broken: [], units: 1, ms: 1 }))?.progress).toBeUndefined();
  });
});

describe('4.3.0 (S5c) a rule blocks a progress update once per task', () => {
  const ruleA = { rule: 'Reply in Polish', kind: 'report' as const, score: 0.9 };
  const ruleB = { rule: 'No em dashes in messages', kind: 'report' as const, score: 0.8 };
  const out = (broken: object[], progress: boolean) => ({ exitCode: 0, stdout: JSON.stringify({ broken, units: 4, ms: 300, ...(progress ? { progress: true } : {}) }) });
  const run = async (h: ReturnType<typeof host>) => (await handlers()['classic.Stop']!(h as never, stop as never, pass as never) as { block?: string }).block;

  it('blocks a progress update for a rule once, then only for rules that have not blocked yet', async () => {
    const h = host();
    h.process.run = async () => out([ruleA], true) as never;
    expect(await run(h)).toContain('- Reply in Polish');
    expect(await run(h)).toBeUndefined();
    expect(h.logs.at(-1)).toBe('rule_check.fired=0 broken=1 units=4 ms=300 progress=1 repeat=1');
    h.process.run = async () => out([ruleA, ruleB], true) as never;
    const block = await run(h);
    expect(block).toContain('- No em dashes in messages');
    expect(block).not.toContain('Reply in Polish');
    expect(h.logs.at(-1)).toBe('rule_check.fired=1 broken=2 units=4 ms=300 progress=1 repeat=1');
  });

  it('still blocks the hand-back for a rule that blocked before, and a new task starts a new list', async () => {
    const h = host();
    h.process.run = async () => out([ruleA], true) as never;
    await run(h);
    h.process.run = async () => out([ruleA], false) as never;
    expect(await run(h)).toContain('- Reply in Polish');
    h.files.set(`${CAPTURE}/${TASK_CARD_BRIEF_FILE}`, 'b2');
    h.process.run = async () => out([ruleA], true) as never;
    expect(await run(h)).toContain('- Reply in Polish');
    expect(JSON.parse(h.files.get(`${CAPTURE}/${RULE_CHECK_SEEN_FILE}`)!)).toEqual({ task: 'b2', rules: ['Reply in Polish'] });
  });

  it('reads only its own task list and keeps every rule on a hand-back', () => {
    expect([...parseSeenRules(renderSeenRules('t1', ['a', 'a', 'b']), 't1')]).toEqual(['a', 'b']);
    expect(parseSeenRules(renderSeenRules('t1', ['a']), 't2').size).toBe(0);
    expect(parseSeenRules('{oops', 't1').size).toBe(0);
    expect(parseSeenRules(undefined, '').size).toBe(0);
    expect(rulesToBlock([ruleA, ruleB], false, new Set(['Reply in Polish']))).toEqual([ruleA, ruleB]);
    expect(rulesToBlock([ruleA, ruleB], true, new Set(['Reply in Polish']))).toEqual([ruleB]);
  });
});

describe('4.4.0 (S5d) the block on a progress update does not ask for the final report', () => {
  const broken = [{ rule: 'No em dashes in messages', kind: 'report' as const, score: 0.8 }];

  it('asks for the fix and a line or two on a progress update, and for the full report on the hand-back', () => {
    const progress = renderRuleCheckReason(broken, '/c/task-card.md', true);
    expect(progress).toContain('- No em dashes in messages (your final message)');
    expect(progress).toMatch(/progress update, not your final report, so do not write the report now/);
    expect(progress).not.toMatch(/send your final report again/);
    expect(renderRuleCheckReason(broken, '/c/task-card.md')).toMatch(/send your final report again, in full/);
  });

  it('the hook picks the text by the progress mark', async () => {
    for (const progress of [true, false]) {
      const h = host({ ran: { exitCode: 0, stdout: JSON.stringify({ broken, units: 4, ms: 300, ...(progress ? { progress: true } : {}) }) } });
      const block = (await handlers()['classic.Stop']!(h as never, stop as never, pass as never) as { block?: string }).block!;
      expect(/do not write the report now/.test(block)).toBe(progress);
    }
  });
});

describe('4.5.0 (S5e) a rule part about something the message lacks is followed', () => {
  it('tells Jev that a part about questions, errors, links or code holds when the message has none', () => {
    const { reportBody } = buildRuleRequests(['Reply in Polish. Questions use ❓ Qn plus a ➡️ recommendation.'], 'Port 7420 works correctly.', '', 'jev-latest');
    const r0 = reportBody.questions.r0 as { instructions: { question: string }; criteria: { false: string } };
    expect(r0.instructions.question).toMatch(/is followed when the message has no such thing/);
    expect(r0.criteria.false).toMatch(/applies only to something the message does not contain/);
  });
});

describe('4.7.5 (S5o) a rule check that cannot ask Jev says why', () => {
  it('rule-check.mjs names a missing key and a denied directory', () => {
    expect(ruleCheckSkipReason({}, '/w/p')).toBe('no_key');
    expect(ruleCheckSkipReason({ TYPESAFE_API_KEY: '${TYPESAFE_API_KEY:-}' }, '/w/p')).toBe('no_key');
    expect(ruleCheckSkipReason({ TYPESAFE_API_KEY: 'k', EXO_JEV_DENY_LIST: 'client-a' }, '/w/client-a/x')).toBe('denied');
    expect(ruleCheckSkipReason({ TYPESAFE_API_KEY: 'k' }, '/w/p')).toBeUndefined();
  });

  it('run without a key it prints the reason and nothing else', () => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.TYPESAFE_API_KEY;
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'recall', 'rule-check.mjs');
    const out = execFileSync(process.execPath, [script, os.tmpdir()], { input: JSON.stringify({ card: CARD, report: 'done' }), encoding: 'utf8', env });
    expect(out).toBe('{"skipped":"no_key"}');
  });

  it('parseRuleSkip reads only the known reasons', () => {
    for (const reason of ['no_key', 'denied', 'http_402', 'http_500', 'timeout']) expect(parseRuleSkip(JSON.stringify({ skipped: reason }))).toBe(reason);
    for (const text of ['', '{', '{"skipped":"other"}', '{"skipped":"http_4022"}', '{"skipped":"http_ab"}', '{"skipped":7}', '{"broken":[],"units":1}', 'null']) expect(parseRuleSkip(text)).toBeUndefined();
  });

  it('a failed Jev call reports its HTTP status or a timeout, and still returns nothing', async () => {
    const config = { key: 'k', model: 'jev-latest', timeoutMs: 1000 };
    const input = { rules: ['Line 1 is SLICE r2 DONE'], report: 'hello' };
    const reasons: string[] = [];
    const say = (reason: string) => { reasons.push(reason); };
    expect(await ruleCheck(input, config, '', async () => ({ ok: false, status: 402, json: async () => ({}) }), say)).toBeUndefined();
    expect(await ruleCheck(input, config, '', async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }, say)).toBeUndefined();
    expect(await ruleCheck(input, config, '', async () => { throw new Error('getaddrinfo ENOTFOUND'); }, say)).toBeUndefined();
    expect(await ruleCheck(input, config, '', async () => ({ ok: true, status: 200, json: async () => ({}) }), say)).toBeUndefined();
    expect(reasons).toEqual(['http_402', 'timeout']);
  });

  it('the stop hook logs the HTTP status of a refused Jev call', async () => {
    const h = host({ ran: { exitCode: 0, stdout: '{"skipped":"http_402"}' } });
    await handlers()['classic.Stop']!(h as never, stop as never, pass as never);
    expect(h.logs).toContain('rule_check.fired=0 reason=http_402');
  });

  it('the stop hook logs reason=no_key and falls back to the card check', async () => {
    const h = host({ ran: { exitCode: 0, stdout: '{"skipped":"no_key"}' }, files: { [`${CAPTURE}/${TASK_CARD_FILE}`]: CARD, [`${CAPTURE}/${BRIEF_CHECK_FILE}`]: '{"brief":"abc","path":"/b.md","whole":true,"lines":[{"line":1,"text":"x"}],"text":"1: x"}' } });
    const result = await handlers()['classic.Stop']!(h as never, stop as never, pass as never) as { block?: string };
    expect(h.logs).toContain('rule_check.fired=0 reason=no_key');
    expect(result.block).toContain('pnpm test passes');
  });

  it('a rule check that cannot work is said once per session, in a line that quiet mode still draws', async () => {
    for (const [reason, words] of [['no_key', 'TYPESAFE_API_KEY is not set'], ['http_401', 'Jev rejected the key (HTTP 401)'], ['http_403', 'Jev rejected the key (HTTP 403)'], ['http_402', 'the TypeSafe account has no credit (HTTP 402)']] as const) {
      const h = host({ ran: { exitCode: 0, stdout: JSON.stringify({ skipped: reason }) } });
      const on = handlers();
      await on['classic.Stop']!(h as never, stop as never, pass as never);
      await on['classic.Stop']!(h as never, stop as never, pass as never);
      const said = h.logs.filter((line) => line.startsWith('rule_check.off='));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain(`rule_check.off=${reason} ruleCheck is on but ${words}, so no rule is checked.`);
      expect(isWarningLine(said[0]!)).toBe(true);
      expect(h.logs.filter((line) => line === `rule_check.fired=0 reason=${reason}`)).toHaveLength(2);
    }
    expect(isWarningLine('rule_check.fired=0 reason=no_key')).toBe(false);
  });

  it('a passing failure (a timeout, a server fault, the deny list) is logged but not said', async () => {
    for (const reason of ['timeout', 'http_500', 'denied']) {
      expect(ruleSkipWarning(reason)).toBeUndefined();
      const h = host({ ran: { exitCode: 0, stdout: JSON.stringify({ skipped: reason }) } });
      await handlers()['classic.Stop']!(h as never, stop as never, pass as never);
      expect(h.logs.some((line) => line.startsWith('rule_check.off='))).toBe(false);
    }
  });
});
