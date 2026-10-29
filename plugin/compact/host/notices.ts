/**
 * 4.7.0 (CONTRACT S5i): the transcript notice policy, in one place. Every `exo-compact: ...` line the hooks log is
 * drawn by Claude Code as a dim system notice, about 16 an hour in a working session, most of them no-ops. With
 * `notices: "quiet"` (the default) an interactive session draws only a summary per cut and the warning lines below;
 * every other line goes, with an ISO timestamp, to `<capture dir>/notices.log`. `notices: "all"`, and any headless
 * run (`-p`, the SDK: no surface; the host gets the lines as `ui_log` and A/B tooling may parse them), draws every
 * line exactly as before. 4.7.5: a headless run of a session that already has a notices.log also appends its
 * `compact.fallback=` lines there.
 *
 * `$` never enters this file (the hook compiler's rule): each hook builds a NoticeHost of closures over its own `$`.
 */
export type NoticesMode = 'quiet' | 'all';

export function noticesMode(value: unknown): NoticesMode {
  return value === 'all' ? 'all' : 'quiet';
}

/** Lines that still reach the transcript in quiet mode: fallbacks to native compaction, errors, held-brief steps, lost data, a rule check that cannot work (4.7.5), a change to the auto-compact settings (S5x). */
const WARNING_LINES: readonly RegExp[] = [
  /^compact\.(?:fallback|error)=/,
  /^compact\.trigger=new_brief$/,
  /^compact\.brief_returned=/,
  /^compact\.hold_skipped=/,
  /^compact\.refusal_guard=/,
  /^brief\.saved=0/,
  /^capture\.timeout$/,
  /^rule_check\.off=/,
  // 4.10.0 (CONTRACT S5x): what the session-start step changed in Claude Code's auto-compact settings.
  /^exo-compact: .*\bauto-compact\b/,
  /error/,
];

/** A cut handed to native compaction. */
const FALLBACK_LINE = /^compact\.fallback=/;

export function isWarningLine(line: string): boolean {
  return WARNING_LINES.some((pattern) => pattern.test(line));
}

/** 217500 -> "218k", 5400 -> "5.4k", 5000 -> "5k", 842 -> "842". */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '?';
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 10_000) return `${(Math.round(tokens / 100) / 10).toString()}k`;
  return `${Math.round(tokens / 1000)}k`;
}

export function formatCutSummary(tokensBefore: number, tokensAfter: number, ms: number): string {
  const seconds = ms / 1000;
  return `compacted ${formatTokens(tokensBefore)} -> ${formatTokens(tokensAfter)} tokens in ${seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))} s`;
}

export interface SessionSignals {
  /** `$.session.surfaces()`; empty or failing means headless. */
  surfaces: () => Promise<readonly unknown[]>;
  entrypoint?: () => Promise<string | undefined>;
  /** `CLAUDE_CODE_CHILD_SESSION`: set by the Bash tool for its children. */
  childSession?: () => Promise<string | undefined>;
  /** `EXOVAULT_BRIEF_CHILD`: set by recall/brief.mjs for its `claude -p` child. */
  briefChild?: () => Promise<string | undefined>;
}

/**
 * 4.7.4 (CONTRACT S5n): attended when a surface is attached, or when the process was started by the VS Code or Cursor
 * extension (`claude-vscode`, which attaches no surface) and is not a child of another session. A failing `surfaces()`
 * counts as no surface; a failing env read counts as not attended.
 */
export async function attendedSession(signals: SessionSignals): Promise<boolean> {
  let surfaces: readonly unknown[] = [];
  try { surfaces = await signals.surfaces(); } catch { surfaces = []; }
  if (surfaces.length > 0) return true;
  if (!signals.entrypoint) return false;
  try {
    if ((await signals.entrypoint()) !== 'claude-vscode') return false;
    if (await signals.childSession?.()) return false;
    if (await signals.briefChild?.()) return false;
    return true;
  } catch {
    return false;
  }
}

export interface NoticeHost extends SessionSignals {
  /** `$.ui.log`: draws one notice line. */
  emit: (line: string, extra?: { to: 'debug' }) => unknown;
  /** The session's notices.log path, or undefined without a capture dir. */
  logFile: () => Promise<string | undefined>;
  read: (path: string) => Promise<string>;
  write: (path: string, text: string) => Promise<void>;
  /** Milliseconds since the epoch. */
  now: () => Promise<number | string>;
}

/** Shared by the hooks of one registration: the last known surface state and the per-file write chains. */
export interface NoticeState {
  /** true once a surface was seen (sticky); false/undefined until then. */
  interactive: boolean | undefined;
  tails: Map<string, Promise<void>>;
}

export interface NoticeLog {
  (line: string): void;
  /** The cut summary: drawn in quiet interactive sessions only (recorded there too), nothing otherwise. */
  summary: (line: string) => Promise<void>;
  /** Straight to the debug log (`$.ui.log(line, { to: 'debug' })`): never drawn, never recorded, in every mode. */
  debug: (line: string) => void;
  /** Resolves when every recording started so far has finished; never rejects. For tests and shutdown. */
  settled: () => Promise<void>;
}

const MAX_LOG_LINES = 1500;

export function makeNoticeLog(mode: NoticesMode, host: NoticeHost, state: NoticeState): NoticeLog {
  const pending = new Set<Promise<unknown>>();
  const track = (work: Promise<unknown>): void => {
    const safe = work.catch(() => undefined).then(() => { pending.delete(safe); });
    pending.add(safe);
  };
  /** Sticky true; otherwise asked once per hook call (`attendedSession`). */
  let asked: Promise<boolean> | undefined;
  const interactive = (): Promise<boolean> => {
    if (state.interactive === true) return Promise.resolve(true);
    asked ??= attendedSession(host).then((yes) => { if (yes) state.interactive = true; return yes; }, () => false);
    return asked;
  };
  let file: Promise<string | undefined> | undefined;
  const record = async (line: string): Promise<void> => {
    file ??= Promise.resolve().then(() => host.logFile());
    const path = await file;
    if (!path) return;
    const raw = Number(await host.now());
    const stamp = new Date(Number.isFinite(raw) && raw > 0 ? raw : 0).toISOString();
    const previous = state.tails.get(path) ?? Promise.resolve();
    const write = previous.then(async () => {
      let text = '';
      try { text = await host.read(path); } catch { text = ''; }
      const lines = text.split('\n').filter(Boolean);
      lines.push(`${stamp} ${line}`);
      await host.write(path, `${lines.slice(-MAX_LOG_LINES).join('\n')}\n`);
    });
    state.tails.set(path, write.catch(() => undefined));
    await write;
  };
  /**
   * 4.7.5: an unattended run of a session that an attended one already recorded (`-p --resume`, the SDK) adds its
   * fallback lines to that notices.log, so tools/status.mjs can show `reason=`. It never creates the file.
   */
  const recordIfLogged = async (line: string): Promise<void> => {
    file ??= Promise.resolve().then(() => host.logFile());
    const path = await file;
    if (!path) return;
    try { await host.read(path); } catch { return; }
    await record(line);
  };
  /** Lines logged before the surface check answered; flushed in order once it has. */
  let queued: string[] = [];
  let decided: boolean | undefined = mode === 'all' ? false : state.interactive === true ? true : undefined;
  const place = (line: string, yes: boolean): void => {
    if (yes) { if (isWarningLine(line)) host.emit(line); track(record(line)); return; }
    host.emit(line);
    if (FALLBACK_LINE.test(line)) track(recordIfLogged(line));
  };
  // The check starts when the hook call starts, so by the first log line the answer is usually in and no line waits.
  if (decided === undefined) {
    track(interactive().then((yes) => {
      decided = yes;
      const lines = queued;
      queued = [];
      for (const queuedLine of lines) place(queuedLine, yes);
    }));
  }
  const log = ((line: string): void => {
    if (mode === 'all') { host.emit(line); return; }
    if (decided === undefined) { queued.push(line); return; }
    place(line, decided);
  }) as NoticeLog;
  log.summary = async (line: string): Promise<void> => {
    if (mode === 'all' || !(await interactive())) return;
    host.emit(line);
    track(record(line));
  };
  log.debug = (line: string): void => { host.emit(line, { to: 'debug' }); };
  log.settled = async (): Promise<void> => {
    while (pending.size) await Promise.all([...pending]);
  };
  return log;
}
