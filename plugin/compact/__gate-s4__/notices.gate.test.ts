import { describe, expect, it, vi } from 'vitest';
import { register } from '../compact.js';
import { formatCutSummary, formatTokens, isWarningLine, makeNoticeLog, noticesMode, type NoticeHost } from '../host/notices.js';
import { assistantText, fakeHost, humanPrompt, withStrippedRuntimeGlobals, LEGACY_OPTIONS, passHarden } from './fixtures/helpers.js';
import type { SessionMessage } from '../core/types.js';
import { BRIEF_PUSH_ARMED, BRIEF_PUSH_FILE } from '../core/brief-push.js';

// 4.7.0 (CONTRACT S5i): `notices` = quiet | all. Quiet draws a summary per cut and warnings only, in an interactive
// session; every other line goes to <capture dir>/notices.log. Headless runs and "all" draw every line as before.

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('isWarningLine: the quiet-mode transcript list', () => {
  const shown = [
    'compact.fallback=budget origin=compact', 'compact.fallback=error origin=turn-capture', 'compact.fallback=refusal_guard origin=compact',
    'compact.fallback=insufficient_reduction origin=compact', 'compact.error=Request failed', 'compact.trigger_skipped=compact_error',
    'compact.trigger=new_brief', 'compact.brief_returned=fill', 'compact.brief_returned=submit', 'compact.brief_returned=lost',
    'compact.hold_skipped=hold_error:EACCES', 'compact.hold_skipped=attachments:image', 'compact.refusal_guard=tripped reason=refusal',
    'session_push.fired=0 reason=error', 'rule_check.fired=0 reason=error', 'brief_push.fired=0 reason=error', 'brief_check.fired=0 reason=error',
    'brief_limits.fired=0 reason=error', 'task_card.refresh=error', 'adopted.copied=error', 'work_state.notification_write=error',
    'compact.jev_skipped=error', 'seed.task_brief=error', 'brief.saved=0 brief.chars=100', 'brief.saved=0', 'capture.timeout',
    'labels.jev=error', 'brief_check.ready=error',
    "exo-compact: set Claude Code's auto-compact window to 200k tokens (it was the model's window); turned auto-compact on. Change it with /plugin configure exo-compact.",
    'exo-compact: DISABLE_AUTO_COMPACT is set, so auto-compact stays off and exo-compact does not run when the window fills. Unset it to turn auto-compact on.',
    'exo-compact: auto-compact settings not checked (timed out after 3000 ms).',
  ];
  const hidden = [
    'rule_check.fired=0 broken=0', 'rule_check.fired=0 reason=no_result', 'rule_check.fired=0 reason=card_stale', 'brief_push.fired=0 on=write',
    'brief_push.fired=0 on=prompt', 'brief_push.fired=1 brief=a lines=3 on=write', 'session_push.fired=0', 'session_push.fired=1 lines=2 chars=30 cuts=1',
    'task_card.refresh=start ctx=100 window=200 n=1', 'task_card.refresh=written size=900', 'brief.saved=1 brief.chars=4000',
    'compact.sizeBefore=217000', 'seed.budget_total=20000 seed.budget_count=real', 'seed.task_card=1 seed.task_card_size=900', 'dense.jev=skipped',
    'labels.applied=2 labels.missing=0', 'recall.build_started=1', 'compact.trigger_skipped=first_prompt', 'compact.jev_skipped=disabled', 'brief_push.armed=1',
    'compact.route=next', 'seed.compaction_pressure=2', 'exo-compact: compacting the finished task first',
  ];
  it.each(shown)('shows %s', (line) => { expect(isWarningLine(line)).toBe(true); });
  it.each(hidden)('hides %s', (line) => { expect(isWarningLine(line)).toBe(false); });
});

describe('notices option and the cut summary', () => {
  it('quiet unless exactly "all"', () => {
    expect(noticesMode(undefined)).toBe('quiet');
    expect(noticesMode('quiet')).toBe('quiet');
    expect(noticesMode('bogus')).toBe('quiet');
    expect(noticesMode('all')).toBe('all');
  });
  it('formats tokens and the summary line', () => {
    expect(formatTokens(217_500)).toBe('218k');
    expect(formatTokens(5400)).toBe('5.4k');
    expect(formatTokens(5000)).toBe('5k');
    expect(formatTokens(842)).toBe('842');
    expect(formatCutSummary(217_500, 5400, 420)).toBe('compacted 218k -> 5.4k tokens in 0.4 s');
    expect(formatCutSummary(1000, 500, 12_000)).toBe('compacted 1k -> 500 tokens in 12 s');
  });
});

function noticeHost(surfaces: () => Promise<readonly unknown[]>, extra: Partial<NoticeHost> = {}) {
  const drawn: string[] = [];
  const files = new Map<string, string>();
  const host: NoticeHost = {
    emit: (line) => { drawn.push(line); },
    surfaces,
    logFile: async () => '/cap/notices.log',
    read: async (path) => { const text = files.get(path); if (text === undefined) throw new Error('ENOENT'); return text; },
    write: async (path, text) => { files.set(path, text); },
    now: async () => Date.UTC(2026, 9, 9, 12, 0, 0),
    ...extra,
  };
  return { host, drawn, files };
}

describe('makeNoticeLog', () => {
  it('all: every line is drawn at once and nothing is written', async () => {
    const { host, drawn, files } = noticeHost(async () => ['terminal']);
    const log = makeNoticeLog('all', host, { interactive: undefined, tails: new Map() });
    log('brief_push.fired=0 on=write');
    expect(drawn).toEqual(['brief_push.fired=0 on=write']);
    await log.settled();
    expect(files.size).toBe(0);
  });

  it('quiet and interactive: a warning is drawn, the rest is recorded with an ISO timestamp (warnings too)', async () => {
    const { host, drawn, files } = noticeHost(async () => ['terminal']);
    const log = makeNoticeLog('quiet', host, { interactive: undefined, tails: new Map() });
    log('brief_push.fired=0 on=write');
    log('compact.fallback=budget origin=compact');
    log('rule_check.fired=0 broken=0');
    await log.settled();
    expect(drawn).toEqual(['compact.fallback=budget origin=compact']);
    expect(files.get('/cap/notices.log')).toBe([
      '2026-10-09T12:00:00.000Z brief_push.fired=0 on=write',
      '2026-10-09T12:00:00.000Z compact.fallback=budget origin=compact',
      '2026-10-09T12:00:00.000Z rule_check.fired=0 broken=0',
    ].join('\n') + '\n');
  });

  it('quiet and headless (no surface), or surfaces failing: every line is drawn, in order, nothing is written', async () => {
    for (const surfaces of [async () => [], async () => { throw new Error('no surfaces'); }]) {
      const { host, drawn, files } = noticeHost(surfaces);
      const log = makeNoticeLog('quiet', host, { interactive: undefined, tails: new Map() });
      log('brief_push.fired=0 on=write');
      log('compact.error=x');
      log('session_push.fired=0');
      await log.settled();
      expect(drawn).toEqual(['brief_push.fired=0 on=write', 'compact.error=x', 'session_push.fired=0']);
      expect(files.size).toBe(0);
    }
  });

  it('4.7.5: quiet and headless, in a session that already has a notices.log: a fallback line is drawn and also recorded, nothing else is', async () => {
    const { host, drawn, files } = noticeHost(async () => []);
    files.set('/cap/notices.log', '2026-10-09T11:00:00.000Z compact.fired=1\n');
    const log = makeNoticeLog('quiet', host, { interactive: undefined, tails: new Map() });
    log('brief_push.fired=0 on=write');
    log('compact.fallback=interactive_only origin=compact entrypoint=sdk-cli');
    log('compact.error=x');
    await log.settled();
    expect(drawn).toEqual(['brief_push.fired=0 on=write', 'compact.fallback=interactive_only origin=compact entrypoint=sdk-cli', 'compact.error=x']);
    expect(files.get('/cap/notices.log')).toBe('2026-10-09T11:00:00.000Z compact.fired=1\n2026-10-09T12:00:00.000Z compact.fallback=interactive_only origin=compact entrypoint=sdk-cli\n');
  });

  it('4.7.5: all, in a session that already has a notices.log: a fallback line is drawn and the file is left alone', async () => {
    const { host, drawn, files } = noticeHost(async () => ['terminal']);
    files.set('/cap/notices.log', '2026-10-09T11:00:00.000Z compact.fired=1\n');
    const log = makeNoticeLog('all', host, { interactive: undefined, tails: new Map() });
    log('compact.fallback=interactive_only origin=compact entrypoint=sdk-cli');
    await log.settled();
    expect(drawn).toEqual(['compact.fallback=interactive_only origin=compact entrypoint=sdk-cli']);
    expect(files.get('/cap/notices.log')).toBe('2026-10-09T11:00:00.000Z compact.fired=1\n');
  });

  it('4.7.5: quiet and headless without a notices.log: a fallback line creates no file', async () => {
    const { host, drawn, files } = noticeHost(async () => []);
    const log = makeNoticeLog('quiet', host, { interactive: undefined, tails: new Map() });
    log('compact.fallback=interactive_only origin=compact entrypoint=sdk-cli');
    await log.settled();
    expect(drawn).toEqual(['compact.fallback=interactive_only origin=compact entrypoint=sdk-cli']);
    expect(files.size).toBe(0);
  });

  async function quiet(surfaces: () => Promise<readonly unknown[]>, extra: Partial<NoticeHost> = {}) {
    const { host, drawn, files } = noticeHost(surfaces, extra);
    const log = makeNoticeLog('quiet', host, { interactive: undefined, tails: new Map() });
    log('brief_push.fired=0 on=write');
    log('compact.fallback=budget origin=compact');
    await log.settled();
    return { drawn, files };
  }

  const recorded = [
    '2026-10-09T12:00:00.000Z brief_push.fired=0 on=write',
    '2026-10-09T12:00:00.000Z compact.fallback=budget origin=compact',
  ].join('\n') + '\n';

  it('quiet and an extension session with no surface: the warning is emitted and every line is recorded', async () => {
    const { drawn, files } = await quiet(async () => [], { entrypoint: async () => 'claude-vscode' });
    expect(drawn).toEqual(['compact.fallback=budget origin=compact']);
    expect(files.get('/cap/notices.log')).toBe(recorded);
  });

  it('quiet and claude-vscode with empty child markers: recorded the same way', async () => {
    const { drawn, files } = await quiet(async () => [], {
      entrypoint: async () => 'claude-vscode',
      childSession: async () => '',
      briefChild: async () => '',
    });
    expect(drawn).toEqual(['compact.fallback=budget origin=compact']);
    expect(files.get('/cap/notices.log')).toBe(recorded);
  });

  it('quiet when surfaces throw and the entrypoint is claude-vscode: recorded the same way', async () => {
    const { drawn, files } = await quiet(async () => { throw new Error('no surfaces'); }, { entrypoint: async () => 'claude-vscode' });
    expect(drawn).toEqual(['compact.fallback=budget origin=compact']);
    expect(files.get('/cap/notices.log')).toBe(recorded);
  });

  it('quiet and sdk-cli with no surface stays headless', async () => {
    const { drawn, files } = await quiet(async () => [], { entrypoint: async () => 'sdk-cli' });
    expect(drawn).toEqual(['brief_push.fired=0 on=write', 'compact.fallback=budget origin=compact']);
    expect(files.size).toBe(0);
  });

  it('quiet and an extension child stays headless', async () => {
    const { drawn, files } = await quiet(async () => [], {
      entrypoint: async () => 'claude-vscode',
      childSession: async () => '1',
    });
    expect(drawn).toEqual(['brief_push.fired=0 on=write', 'compact.fallback=budget origin=compact']);
    expect(files.size).toBe(0);
  });

  it('quiet and a brief child of an extension session stays headless', async () => {
    const { drawn, files } = await quiet(async () => [], {
      entrypoint: async () => 'claude-vscode',
      briefChild: async () => '1',
    });
    expect(drawn).toEqual(['brief_push.fired=0 on=write', 'compact.fallback=budget origin=compact']);
    expect(files.size).toBe(0);
  });

  it('the summary is drawn only in quiet interactive sessions', async () => {
    const quiet = noticeHost(async () => ['terminal']);
    await makeNoticeLog('quiet', quiet.host, { interactive: undefined, tails: new Map() }).summary('compacted 10k -> 2k tokens in 0.1 s');
    expect(quiet.drawn).toEqual(['compacted 10k -> 2k tokens in 0.1 s']);
    for (const [mode, surfaces] of [['quiet', async () => []], ['all', async () => ['terminal']]] as const) {
      const other = noticeHost(surfaces);
      await makeNoticeLog(mode, other.host, { interactive: undefined, tails: new Map() }).summary('compacted 10k -> 2k tokens in 0.1 s');
      expect(other.drawn).toEqual([]);
    }
  });

  it('never throws or rejects when the log cannot be read or written, and keeps only the newest lines', async () => {
    const broken = noticeHost(async () => ['terminal'], { write: async () => { throw new Error('EACCES'); }, logFile: async () => { throw new Error('boom'); } });
    const log = makeNoticeLog('quiet', broken.host, { interactive: undefined, tails: new Map() });
    expect(() => log('seed.a=1')).not.toThrow();
    await expect(log.settled()).resolves.toBeUndefined();
    const { host, files } = noticeHost(async () => ['terminal']);
    const many = makeNoticeLog('quiet', host, { interactive: undefined, tails: new Map() });
    for (let i = 0; i < 1700; i += 1) many(`seed.n=${i}`);
    await many.settled();
    const lines = files.get('/cap/notices.log')!.trim().split('\n');
    expect(lines).toHaveLength(1500);
    expect(lines[0]).toContain('seed.n=200');
    expect(lines.at(-1)).toContain('seed.n=1699');
  });

  it('does not write at all when the session has no capture dir', async () => {
    const { host, drawn, files } = noticeHost(async () => ['terminal'], { logFile: async () => undefined });
    const log = makeNoticeLog('quiet', host, { interactive: undefined, tails: new Map() });
    log('seed.a=1');
    await log.settled();
    expect(drawn).toEqual([]);
    expect(files.size).toBe(0);
  });
});

const FLAG = '.exovault/s4-compact-active';
const LOG = '/project/.exovault/s4-capture/session-default/notices.log';

function conversation(): SessionMessage[] {
  const messages: SessionMessage[] = [];
  for (let i = 0; i < 60; i += 1) {
    messages.push(humanPrompt(`turn ${i}: check packages/app/src/part-${i}.ts`));
    messages.push(assistantText(`Updated packages/app/src/part-${i}.ts:${i * 7} ${'x[1]=2; '.repeat(300)}`));
  }
  return messages;
}

function session(options: Record<string, unknown>, surfaces: readonly string[] | 'missing') {
  const drawn: string[] = [];
  const files = new Map<string, string>();
  const base = fakeHost({
    fsExists: async (path) => path.endsWith(`/${FLAG}`) || files.has(path),
    fsRead: async (path) => { if (files.has(path)) return files.get(path)!; if (path.endsWith(`/${FLAG}`)) return '1'; throw new Error(`ENOENT: ${path}`); },
    fsWrite: async (path, text) => { files.set(path, text); },
    uiLog: (line: string) => drawn.push(line),
    clockNow: async () => 1_000_000,
  });
  const $ = surfaces === 'missing' ? base : { ...base, session: { ...base.session, surfaces: async () => surfaces } };
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  register(((name: string, handler: never) => { handlers[name] = handler; return { catch: (caught: unknown) => { (handlers as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS, denseNotes: true, ...options } as never);
  return { $, drawn, files, handlers };
}

describe('session.compact with notices', () => {
  const cut = async (options: Record<string, unknown>, surfaces: readonly string[] | 'missing') => {
    const s = session(options, surfaces);
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const result = await withStrippedRuntimeGlobals(() => s.handlers['session.compact']!(s.$, { trigger: 'auto', messages: conversation() }, next));
    await settle();
    return { ...s, result: result as { messages?: SessionMessage[]; tokensBefore?: number; tokensAfter?: number }, next };
  };

  it('quiet and interactive: one summary line, no diagnostics, the diagnostics in notices.log', async () => {
    const { drawn, files, result, next } = await cut({}, ['terminal']);
    expect(next).not.toHaveBeenCalled();
    expect(drawn).toHaveLength(1);
    expect(drawn[0]).toMatch(/^compacted \S+ -> \S+ tokens in \d+(\.\d)? s$/);
    expect(result.tokensBefore).toBeGreaterThan(result.tokensAfter ?? 0);
    const recorded = files.get(LOG) ?? '';
    expect(recorded).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z compact\.sizeBefore=\d+$/m);
    expect(recorded).toContain('seed.budget_total=');
    expect(recorded).toMatch(/Z compacted \S+ -> \S+ tokens in /);
  });

  it('quiet and interactive: a fallback to native compaction is drawn', async () => {
    const s = session({ timeoutMs: 1 }, ['terminal']);
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    // A conversation too small to reduce: core falls back with insufficient_reduction.
    await withStrippedRuntimeGlobals(() => s.handlers['session.compact']!(s.$, { trigger: 'auto', messages: [humanPrompt('hi'), assistantText('hello')] }, next));
    await settle();
    expect(next).toHaveBeenCalled();
    expect(s.drawn.some((line) => line.startsWith('compact.fallback='))).toBe(true);
    expect(s.drawn.some((line) => line.startsWith('compact.sizeBefore='))).toBe(false);
  });

  it('notices "all": today\'s lines, no summary, no notices.log', async () => {
    const { drawn, files } = await cut({ notices: 'all' }, ['terminal']);
    expect(drawn.some((line) => line.startsWith('compact.sizeBefore='))).toBe(true);
    expect(drawn.some((line) => line.startsWith('seed.budget_total='))).toBe(true);
    expect(drawn.some((line) => line.startsWith('compacted '))).toBe(false);
    expect(files.has(LOG)).toBe(false);
  });

  it('headless (no surface) and a host without surfaces keep every line, as before', async () => {
    for (const surfaces of [[], 'missing'] as const) {
      const { drawn, files } = await cut({}, surfaces);
      expect(drawn.some((line) => line.startsWith('compact.sizeBefore='))).toBe(true);
      expect(drawn.some((line) => line.startsWith('compacted '))).toBe(false);
      expect(files.has(LOG)).toBe(false);
    }
  });
});

describe('the other hooks route through the same policy', () => {
  it('a no-op brief_push line goes to notices.log in an interactive quiet session, and is drawn headless', async () => {
    const heredoc = { tool: 'Bash', tool_use_id: 't1', command: "cat > a/b.ts <<'EOF'\nx\nEOF" };
    const run = async (surfaces: readonly string[]) => {
      const s = session({ recallPluginRoot: '/plugin' }, surfaces);
      s.files.set(`/project/.exovault/s4-capture/session-default/${BRIEF_PUSH_FILE}`, BRIEF_PUSH_ARMED);
      const $ = { ...s.$, process: { run: passHarden(async () => ({ exitCode: 0, stdout: 'null', stderr: '' })) } };
      await s.handlers['classic.PreToolUse']!($, heredoc, async () => ({}));
      await settle();
      return s;
    };
    const interactive = await run(['terminal']);
    expect(interactive.drawn).toEqual([]);
    expect(interactive.files.get(LOG)).toMatch(/Z brief_push\.fired=0 on=write\n/);
    const headless = await run([]);
    expect(headless.drawn).toEqual(['brief_push.fired=0 on=write']);
  });
});

describe('compact.ts has one logging function', () => {
  it('spells $.ui.log once per handler (the notice host)', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../compact.ts', import.meta.url), 'utf8');
    expect(source.match(/\$\.ui\.log\(/g)?.length ?? 0).toBe(13); // n = seven notice hosts (session.start's for S5x), five gating catch notices and session.start's preflight warning
  });
});

describe('push failures say what failed (4.7.0)', () => {
  // Session 27aaceb0 logged `session_push.fired=0 reason=error` eight times, each ~3.0 s after the prompt: the 3 s
  // timeout of session-push.mjs rejected `$.process.run`, and the catch dropped the message.
  const failing = async (message: string) => {
    const s = session({ recallPluginRoot: '/plugin', recallEnabled: true }, []);
    const $ = { ...s.$, process: { run: passHarden(async () => { throw new Error(message); }) } };
    await s.handlers['prompt.submit']!($, { text: 'is the css test complete?', origin: { kind: 'composer' } }, async (e: unknown) => e);
    await settle();
    return s.drawn.filter((line) => line.startsWith('session_push.'));
  };
  it('logs the last 120 characters of the error on one line', async () => {
    expect(await failing('process timed out\nafter 3000 ms')).toEqual(['session_push.fired=0 reason=error error=process timed out after 3000 ms']);
    const long = await failing(`node session-push.mjs: ${'x'.repeat(200)} timed out after 3000 ms`);
    const prefix = 'session_push.fired=0 reason=error error=';
    expect(long[0]!.startsWith(prefix)).toBe(true);
    const tail = long[0]!.slice(prefix.length);
    expect(tail).toHaveLength(120);
    expect(tail.endsWith('timed out after 3000 ms')).toBe(true);
    expect(tail.startsWith('x')).toBe(true);
  });

  it('brief_push and brief_limits log the same reason and error tail', async () => {
    const message = `node brief-push.mjs: ${'x'.repeat(200)} timed out after 3000 ms`;
    const run = async (hook: string, event: unknown, prefix: string) => {
      const s = session({ recallPluginRoot: '/plugin', recallEnabled: true }, []);
      s.files.set(`/project/.exovault/s4-capture/session-default/${BRIEF_PUSH_FILE}`, BRIEF_PUSH_ARMED);
      const $ = { ...s.$, process: { run: passHarden(async () => { throw new Error(message); }) } };
      await s.handlers[hook]!($, event, async () => ({}));
      await settle();
      return s.drawn.filter((line) => line.startsWith(prefix));
    };
    const heredoc = { tool: 'Bash', tool_use_id: 't1', command: "cat > a/b.ts <<'EOF'\nx\nEOF" };
    const post = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: heredoc.command }, tool_response: {}, tool_use_id: 't1' };
    for (const [hook, event, name] of [['classic.PreToolUse', heredoc, 'brief_push.'], ['classic.PostToolUse', post, 'brief_limits.']] as const) {
      const lines = await run(hook, event, name);
      expect(lines).toHaveLength(1);
      const prefix = `${name}fired=0 reason=error error=`;
      expect(lines[0]!.startsWith(prefix)).toBe(true);
      const tail = lines[0]!.slice(prefix.length);
      expect(tail).toHaveLength(120);
      expect(tail.endsWith('timed out after 3000 ms')).toBe(true);
    }
  });
});
