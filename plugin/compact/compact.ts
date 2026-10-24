import type { On, PluginOptions, Register } from 'claude-code';
import { checkBudget, estimateTokens, SINCE_CARD_BUDGET_TOKENS, SINCE_CARD_KEEP, REAL_TOTAL_BUDGET_TOKENS, scaledBudgets, TOTAL_BUDGET_TOKENS, tailSpillTokens, JEV_BATCH_MAX_TOKENS, JEV_PER_CALL_TIMEOUT_MS, JEV_QUERY_FIELD_MAX_TOKENS, JEV_TOTAL_BUDGET_MS, KEY_FACTS_BUDGET_TOKENS, MIN_REDUCTION_RATIO, REBUILD_THRESHOLD_TOKENS, SEED_BUDGET_TOKENS, TAIL_BUDGET_TOKENS, WORK_STATE_BUDGET_TOKENS, serializedTokens } from './core/budgets.js';
import { extractStateUpdates, renderStateUpdates } from './core/state-updates.js';
import { applyConstraintOverflow, extractAdoptedFileConstraints, extractConstraints, renderConstraintsSection } from './core/constraints.js';
import { demoteHeadings } from './core/seed.js';
import { cleanCapturedRecord, contentIdentity, isSecretLikePath, reconcile, redactCapturedText, WATERMARK_SEQUENCE_LENGTH } from './core/extractor.js';
import { applyForceTriggerOverride, forceTriggerOverride, routeTrigger, withFallback, withTimeout } from './core/handler.js';
import { briefText, condenseUserHistory, historyOmittedNote } from './core/history.js';
import { ADOPTED_BUDGET_TOKENS, ADOPTED_MAX_CHARS, addAdopted, adoptedFileRefs, parseAdoptedIndex, renderAdoptedFiles, resolveAdoptedPath, revokedAdopted, revokedNames } from './core/adopted.js';
import type { AdoptedEntry } from './core/adopted.js';
import { BRIEF_BUDGET_TOKENS, BRIEF_FULL_MAX_CHARS, BRIEF_HEAD_CHARS, BRIEF_MIN_CHARS, BRIEF_MIN_TAIL_SHARE, parseBriefIndex, renderTaskBriefs } from './core/briefs.js';
import { buildLabelQuestion, capturedUserText, isLabelModel, labelKey, parseLabelAnswer, parseLabels, ruleSentences, submitLabelKey } from './core/labels.js';
import { applyKeyFactsOverflow, extractKeyFactsChunked, renderKeyFactsSection } from './core/key-facts.js';
import { renderGatesAndErrors, renderSeed, type SeedSections } from './core/seed.js';
import { collectFullIds, expandShortIds } from './core/id-expansion.js';
import { collectFilePointers } from './core/file-pointers.js';
import { select } from './core/select.js';
import { defaultJevCriteria, isJevAllowed, renderJevPointer, selectJ } from './core/select-j.js';
import type { JevDecisionLogEntry } from './core/select-j.js';
import { pickTail } from './core/tail.js';
import { CARD_LATE_SHARE, cardAgeLine, countToolCallsSince, lateRefreshDue } from './core/late-card.js';
import { collectRecipes, renderRecipes, RECIPES_BUDGET_TOKENS, type Recipe } from './core/recipes.js';
import { collectSinceCard, parseCardHorizon, renderSinceCard, type SinceCardHorizon, type SinceCardSteps } from './core/since-card.js';
import { renderTranscriptPointer, resolveTranscriptPath } from './core/transcript-pointer.js';
import { advanceCompactionPressure, parseCompactionPressureState, renderCompactionPressure } from './core/compaction-pressure.js';
import { advanceAgentPressure, countToolUsesSinceSummary, guidanceForPressure, parseAgentPressureState } from './core/agent-pressure.js';
import type { CaptureRecord, CompactEvent, SessionMessage } from './core/types.js';
import { listIfPresent, makeFsCaptureStore } from './host/fs-adapter.js';
import { capturePath, ensureCaptureGitignore } from './host/capture-path.js';
import { findCaptureRoot, usableRoot } from './host/capture-flag.js';
import type { FlagHost } from './host/capture-flag.js';
import { captureBeforeNext } from './host/capture-order.js';
import { getJevEndpoint, makeJevAsk, parseDenseJevResponse, parseJevResponse } from './host/jev-client.js';
import { sha256 } from './host/sha256.js';
import { forkReply, type ForkReply, CARD_CUT_SHARE, CARD_TASK_SHARE, CARD_TOTAL_BUDGET_TOKENS, cardBudgets, stretchForTail, TASK_CARD_FILE, TASK_CARD_MAX_TOKENS, TASK_CARD_STATE_FILE, TASK_CARD_BRIEF_FILE, TASK_CARD_HORIZON_FILE, cardAcceptance, cardRefreshDue, parseCardReply, parseTaskCardState, renderCardCheckReason, renderCardPrompt, renderCardSection } from './core/task-card.js';
import { parseRuleCheck, parseRuleSkip, ruleSkipWarning, parseSeenRules, renderRuleCheckReason, renderSeenRules, RULE_CHECK_SEEN_FILE, RULE_CHECK_TIMEOUT_MS, rulesToBlock } from './core/rule-check.js';
import { BRIEF_CHECK_ARMED, BRIEF_CHECK_DONE, BRIEF_CHECK_EMPTY, BRIEF_CHECK_FILE, BRIEF_CHECK_TIMEOUT_MS, parseBriefCheck, renderBriefCheckReason } from './core/brief-check.js';
import { SESSION_PUSH_FILE, SESSION_PUSH_POINTER, SESSION_PUSH_SERVER_TIMEOUT_MS, SESSION_PUSH_TIMEOUT_MS, parsePushPointer, parseSessionPush, renderSessionPush, type SessionPushFound } from './core/session-push.js';
import { BRIEF_LIMITS_TIMEOUT_MS, BRIEF_PUSH_ARMED, BRIEF_PUSH_FILE, BRIEF_PUSH_OFF, BRIEF_PUSH_TIMEOUT_MS, parseBriefLimits, parseBriefPush, pushTarget, renderBriefLimits, renderBriefPush, type BriefPushInput } from './core/brief-push.js';
import { FRESH_CUT_FILE, FRESH_CUT_ANSWERED, FRESH_CUT_OPEN, hasLiveSeed, isClassifierRefusal, REFUSAL_GUARD_FILE, REFUSAL_GUARD_NOTICE, renderRefusalGuardState } from './core/refusal-guard.js';
import { findTranscriptPath } from './host/transcript-path.js';
import { resolveHomeDir } from './host/home-dir.js';
import { attendedSession, formatCutSummary, makeNoticeLog, noticesMode } from './host/notices.js';
import type { NoticeHost, NoticeState } from './host/notices.js';
import { denseCandidates, denseJevCandidates, renderDense, selectDense } from './core/dense.js';
import { buildDenseJevRequests, denseJevQuery, parseDenseJevAnswers } from './core/dense-jev.js';
import { foldWorkState, parseTaskNotifications, renderWorkState, validWorkEvent } from './core/work-state.js';
import type { WorkStateProbe } from './core/work-state.js';
import { runPreflight } from './host/preflight.js';
import { renderSessionMap } from './core/session-map.js';
import type { SessionSegment } from './core/session-map.js';

async function latestCwdSnapshot(fs: { read: (path: string) => Promise<string>; write: (path: string, text: string) => Promise<void>; list?: (path?: string) => Promise<{ name: string; kind: string; size: number }[]>; exists?: (path: string) => Promise<boolean> }, baseDir: string): Promise<{ path: string; sourceHash: string } | undefined> {
  const entries = (await listIfPresent(fs, baseDir)).filter((entry) => entry.kind === 'file' && entry.name.startsWith('segment-')).sort((a, b) => a.name.localeCompare(b.name));
  let latest: { path: string; sourceHash: string } | undefined;
  for (const entry of entries) for (const line of (await fs.read(`${baseDir}/${entry.name}`)).split('\n').filter(Boolean)) {
    try { const record = JSON.parse(line) as CaptureRecord; if (record.kind === 'work_event' && record.body.type === 'cwd_snapshot' && typeof record.body.path === 'string') latest = { path: record.body.path, sourceHash: record.sourceHash }; } catch {}
  }
  return latest;
}

function optionNumber(options: PluginOptions, name: string, fallback: number): number {
  const value = options[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 4.8.1: userConfig retentionDays as the launcher argument; 0 keeps every session's index and captures. */
function retentionDays(options: PluginOptions): string {
  return String(Math.max(0, Math.floor(optionNumber(options, 'retentionDays', 30))));
}

function optionBoolean(options: PluginOptions, name: string, fallback: boolean): boolean {
  const value = options[name];
  return typeof value === 'boolean' ? value : fallback;
}

function optionString(options: PluginOptions, name: string, fallback: string): string {
  const value = options[name];
  return typeof value === 'string' ? value : fallback;
}

/**
 * 4.1.0: the model that writes a saved brief's checklist, or '' for none. With the task card on, a cut never shows
 * the checklist (the card carries the rules; 0 of 29 w61 cuts and 0 of 210 recorded seeds had it, and no session
 * read the file), so the `claude -p` call that wrote it (~$0.76 per 8-task chain) is not made.
 */
function checklistModel(options: PluginOptions): string {
  return optionBoolean(options, 'taskCard', true) ? '' : optionString(options, 'briefDigestModel', 'sonnet');
}

/** 4.7.0: the last 120 characters of an error's message on one line (the tail is where a timeout says how long), for a log line that used to say only `reason=error`. */
function errorTail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(-120);
}

/** 4.6.0 (S5g): replaces each same-id <pasted_content id="X">..</pasted_content id="X"> pair by its inner text (minus one newline each side), then trims newlines at both ends; unmatched or mismatched tags stay. */
export function unwrapPastes(text: string): string {
  return text.replace(/<pasted_content id="([^"]*)">\n?([\s\S]*?)\n?<\/pasted_content id="\1">/g, (_all, _id: string, inner: string) => inner).replace(/^\n+|\n+$/g, '');
}

export const register: Register = (on: On, options: PluginOptions) => {
  /** S4i: transcript path per session id, found once per process (see the use in session.compact). */
  const transcriptPathCache = new Map<string, string>();
  /** Capture roots whose .exovault/.gitignore was already ensured (one check per root, not per turn). */
  const gitignoredRoots = new Set<string>();
  const labelWriteTails = new Map<string, Promise<void>>();
  const workStateWriteTails = new Map<string, Promise<void>>();
  /** 3.34.0: copies and revocations of adopted rules files, in prompt order; a cut waits for it (core/adopted.ts). */
  let adoptedChain: Promise<void> = Promise.resolve();
  const interactiveOnly = optionBoolean(options, 'interactiveOnly', true);
  /** 4.7.0 (CONTRACT S5i): every log line goes through `notice`, built per hook call over that call's `$`; see host/notices.ts. */
  const noticeState: NoticeState = { interactive: undefined, tails: new Map() };
  const noticeLog = (host: NoticeHost) => makeNoticeLog(noticesMode(options.notices), host, noticeState);
  /** 4.6.0 (S5g): set when a held brief was handed back to the prompt box; the next prompt must not be cut again. */
  let briefReturned = false;
  /** 4.7.5 (S5o): sessions already told that their rule check cannot work (no key, rejected key, no credit). */
  const ruleOffSaid = new Set<string>();
  /**
   * 4.8.0: the SessionStart preflight (host/preflight.ts). `inert` is set when Node or Claude Code is below the minimum;
   * every capture-root lookup then answers "off", so the plugin does nothing and native compaction runs. The versions are
   * the same for every session in this process, so one flag is enough; the warning is drawn once per session id.
   */
  const preflight = { inert: false, checked: new Set<string>() };
  on('session.start', async ($, input, next) => {
    try {
      let sessionId = 'unknown';
      try { sessionId = String(await $.session.id()); } catch { /* the id is not bound yet */ }
      if (!preflight.checked.has(sessionId)) {
        preflight.checked.add(sessionId);
        const result = await runPreflight({
          claudeVersion: async () => { const version = await $.session.version(); return version.base ?? version.version; },
          pluginRoot: async () => optionString(options, 'recallPluginRoot', '') || (await $.env.get('CLAUDE_PLUGIN_ROOT')),
          run: (argv: string[], init: { timeoutMs: number }) => $.process.run(argv, init),
        });
        preflight.inert = !result.ok;
        if (!result.ok && result.warning) $.ui.log(result.warning);
      }
    } catch {
      // The preflight may only make the plugin quieter; a failure here leaves it as it was.
    }
    return next(input);
  });
  // 4.9.0: every gating hook (prompt.submit, session.compact, classic.PreToolUse, classic.PostToolUse, classic.Stop)
  // has a .catch: a throw or an overrun budget logs hook.caught=<event> kind=<throw|timeout> and passes the event on.
  on('prompt.submit', async ($, input, next) => {
    const homeDir = () => resolveHomeDir({ home: () => $.env.get('HOME'), userProfile: () => $.env.get('USERPROFILE'), homeDrive: () => $.env.get('HOMEDRIVE'), homePath: () => $.env.get('HOMEPATH') });
    const notice = noticeLog({ emit: (...args: [string, { to: 'debug' }?]) => $.ui.log(...args), surfaces: () => $.session.surfaces(), entrypoint: () => $.env.get('CLAUDE_CODE_ENTRYPOINT'), childSession: () => $.env.get('CLAUDE_CODE_CHILD_SESSION'), briefChild: () => $.env.get('EXOVAULT_BRIEF_CHILD'), logFile: async () => { const noticeRoot = await findCaptureRoot({ cwd: () => $.session.cwd(), exists: (path: string) => $.fs.exists(path), root: () => $.session.root(), home: homeDir, inert: () => preflight.inert }); return noticeRoot === null ? undefined : `${capturePath(String(await $.session.id()), noticeRoot)}/notices.log`; }, read: (path: string) => $.fs.read(path), write: (path: string, text: string) => $.fs.write(path, text), now: () => $.clock.now() });
    // 4.6.0 (CONTRACT S5g): cut completed task history before the next long brief enters the session.
    // The same cleanup and 2,500-character threshold as brief capture keep short follow-ups out. A cut
    // runs only while the main session is idle and already has context to cut; the existing prompt path
    // below then passes this new text through unchanged, whole.
    const cutOnNewBrief = optionBoolean(options, 'cutOnNewBrief', false);
    const captureBriefs = optionBoolean(options, 'recallEnabled', true) && optionBoolean(options, 'taskBriefs', true);
    // A subagent's report to this session (origin peer, `handback` as the transcript records it) is not a task either.
    const eligibleBriefOrigin = input.origin?.kind !== 'task-notification' && (input.origin as { handback?: unknown } | undefined)?.handback !== true && typeof input.text === 'string';
    const incomingBrief = eligibleBriefOrigin && (cutOnNewBrief || captureBriefs) ? briefText(input.text) : undefined;
    if (cutOnNewBrief && incomingBrief !== undefined && incomingBrief.length >= BRIEF_MIN_CHARS) {
      // Only a submit that is itself a cut candidate consumes the flag; a short `ok` typed in the retry window leaves it.
      const returnedBrief = briefReturned;
      briefReturned = false;
      let skipped: string | undefined;
      if (returnedBrief) skipped = 'brief_returned';
      else if (input.turnId !== undefined) skipped = 'turn_running';
      else {
        try {
          const previousMessages = await $.session.messages();
          const hasPreviousContext = previousMessages.some((message) => message.text.trim().length > 0 || message.toolUses.length > 0 || (message.toolResults?.length ?? 0) > 0);
          if (!hasPreviousContext) skipped = 'first_prompt';
        } catch { skipped = 'history_unavailable'; }
      }
      if (skipped !== undefined) notice(`compact.trigger_skipped=${skipped}`);
      else {
        try {
          const compacted = await $.session.compact();
          if (compacted && 'skip' in compacted && compacted.skip !== undefined) notice('compact.trigger_skipped=compaction_veto');
          else notice('compact.trigger=new_brief');
        } catch (error) {
          // 4.6.0 (CONTRACT S5g): live w67, the engine refuses a cut while the turn this prompt is about to run exists
          // ("a turn is running" headless, "this hook is holding" in the interactive hooks worker), so hold the brief,
          // cut between turns, then hand it back to the prompt box.
          const message = error instanceof Error ? error.message : String(error);
          let held: { drop: string } | undefined;
          let headless = false;
          let holdSkipped: string | undefined;
          const insideTurn = (text: string): boolean => text.includes('a turn is running') || text.includes('this hook is holding');
          const clean = (text: string): string => text.replace(/[\r\n]+/g, ' ').slice(0, 120);
          if (insideTurn(message) && input.attachments !== undefined) holdSkipped = `attachments:${input.attachments.map((a) => a.type ?? '?').join(',') || input.attachments.length}`;
          if (insideTurn(message) && input.attachments === undefined) {
            let heldPath: string | undefined;
            try {
              if ((await $.session.surfaces()).length === 0) { headless = true; notice('compact.trigger_skipped=headless'); }
              else {
                const captureRoot = await findCaptureRoot({ cwd: () => $.session.cwd(), exists: (path: string) => $.fs.exists(path), root: () => $.session.root(), home: homeDir, inert: () => preflight.inert });
                if (captureRoot !== null) {
                  heldPath = `${capturePath(String(await $.session.id()), captureRoot)}/held-brief.md`;
                  await $.fs.write(heldPath, unwrapPastes(input.text));
                } else holdSkipped = 'no_capture_root';
              }
            } catch (holdError) { heldPath = undefined; holdSkipped = `hold_error:${clean(holdError instanceof Error ? holdError.message : String(holdError))}`; }
            if (heldPath !== undefined) {
              const text = unwrapPastes(input.text), path = heldPath;
              briefReturned = true;
              void (async () => {
                const signal = new AbortController().signal;
                let last = '';
                let compacted = false;
                for (let attempt = 0; attempt < 100 && !compacted; attempt++) {
                  try {
                    const result = await $.session.compact();
                    notice(result && 'skip' in result && result.skip !== undefined ? 'compact.trigger_skipped=compaction_veto' : 'compact.trigger=new_brief');
                    compacted = true;
                  } catch (retryError) {
                    last = retryError instanceof Error ? retryError.message : String(retryError);
                    if (!insideTurn(last)) break;
                    try { await $.clock.sleep(100, { signal }); } catch { break; }
                  }
                }
                if (!compacted) {
                  notice('compact.trigger_skipped=compact_error');
                  notice(`compact.error=${last.replace(/[\r\n]+/g, ' ').slice(0, 120)}`);
                }
                let filled = false;
                try { filled = (await $.prompt.fill({ text })).isFilled; } catch { filled = false; }
                if (filled) { notice('compact.brief_returned=fill'); return; }
                // A plugin's own submit skips this plugin's hooks, so it never consumes the flag.
                try { await $.prompt.submit({ text }); briefReturned = false; notice('compact.brief_returned=submit'); }
                catch {
                  notice('compact.brief_returned=lost');
                  try { $.ui.toast(`exo-compact: could not return your brief; it is saved in ${path}`); } catch { /* best effort */ }
                }
              })().catch(() => { notice('compact.brief_returned=lost'); });
              held = { drop: 'exo-compact: compacting the finished task first; your brief goes back into the prompt box, press Enter to send it' };
            }
          }
          if (held !== undefined) return held;
          if (!headless) {
            notice('compact.trigger_skipped=compact_error');
            notice(`compact.error=${clean(message)}`);
            if (holdSkipped !== undefined) notice(`compact.hold_skipped=${holdSkipped}`);
          }
        }
      }
    }
    const notifications = typeof input.text === 'string' ? parseTaskNotifications(input.text) : [];
    if (notifications.length) {
      void (async () => {
        const flagHost = { cwd: () => $.session.cwd(), exists: (path: string) => $.fs.exists(path), root: () => $.session.root(), home: homeDir, inert: () => preflight.inert };
        const captureRoot = await findCaptureRoot(flagHost);
        if (captureRoot === null) return;
        const baseDir = capturePath(String(await $.session.id()), captureRoot);
        const path = `${baseDir}/work-events.jsonl`;
        const previousWrite = workStateWriteTails.get(path) ?? Promise.resolve();
        const write = previousWrite.then(async () => {
          let contents = '';
          try { contents = await $.fs.read(path); }
          catch { if (await $.fs.exists(path)) throw new Error('work state read failed'); }
          const lines = notifications.map(({ id, status, summary }) => JSON.stringify({ id, status, ...(summary ? { summary } : {}) }));
          const retained = [...contents.split(/\r?\n/).filter(Boolean), ...lines].slice(-500);
          await $.fs.write(path, retained.join('\n'));
        });
        workStateWriteTails.set(path, write.catch(() => {}));
        await write;
      })().catch(() => { notice('work_state.notification_write=error'); });
    }
    // 3.31.0 (CONTRACT S4ze): a long request (a task brief) is saved verbatim and its checklist is started in the
    // background, so the seed of a later cut can point at the full text. Not awaited, like the labels below.
    if (eligibleBriefOrigin && captureBriefs) {
      const brief = incomingBrief;
      if (brief !== undefined && brief.length >= BRIEF_MIN_CHARS) {
        // 3.40.0: the new task's brief is in context whole until the next cut, so the push of the old one stops.
        void (async () => {
          const captureRoot = await findCaptureRoot({ cwd: () => $.session.cwd(), exists: (path: string) => $.fs.exists(path), root: () => $.session.root(), home: homeDir, inert: () => preflight.inert });
          if (captureRoot === null) return;
          const pushPath = `${capturePath(String(await $.session.id()), captureRoot)}/${BRIEF_PUSH_FILE}`;
          if (await $.fs.exists(pushPath)) await $.fs.write(pushPath, BRIEF_PUSH_OFF);
        })().catch(() => { notice('brief_push.off=error'); });
        void (async () => {
          // The checklist child runs `claude -p` with this variable set; its prompt is the brief again.
          if (await $.env.get('EXOVAULT_BRIEF_CHILD')) return;
          const captureRoot = await findCaptureRoot({ cwd: () => $.session.cwd(), exists: (path: string) => $.fs.exists(path), root: () => $.session.root(), home: homeDir, inert: () => preflight.inert });
          if (captureRoot === null) return;
          if (interactiveOnly && !(await attendedSession({ surfaces: () => $.session.surfaces(), entrypoint: () => $.env.get('CLAUDE_CODE_ENTRYPOINT'), childSession: () => $.env.get('CLAUDE_CODE_CHILD_SESSION'), briefChild: () => $.env.get('EXOVAULT_BRIEF_CHILD') }))) return;
          const pluginRoot = optionString(options, 'recallPluginRoot', '') || (await $.env.get('CLAUDE_PLUGIN_ROOT'));
          if (!pluginRoot) return;
          const recallRoot = `${(await homeDir()) ?? '.'}/.claude/exovault/recall`;
          void $.process.run(['node', `${pluginRoot}/recall/brief.mjs`, 'save', recallRoot, String(await $.session.id()), checklistModel(options)], { stdin: brief, timeoutMs: 5000 })
            .then((saved) => { notice(`brief.saved=${saved.exitCode === 0 ? 1 : 0} brief.chars=${brief.length}`); })
            .catch(() => { notice('brief.saved=0'); });
        })().catch(() => { notice('brief.saved=0'); });
      }
    }
    // 3.34.0: a rules file a person's request adopts is copied now, while it exists, whatever tool the model reads it
    // with later, and every seed quotes the copy (core/adopted.ts). Another session, a schedule or a relay never adopts.
    // The work is queued on one chain in prompt order and not awaited here.
    const adoptOrigin = input.origin?.kind === 'composer' || input.origin?.kind === 'bridge' || input.origin?.kind === 'sdk';
    const adoptText = adoptOrigin && typeof input.text === 'string' && optionBoolean(options, 'adoptedFiles', true) ? briefText(input.text) : undefined;
    const adoptedRefs = adoptText === undefined ? [] : adoptedFileRefs(adoptText);
    if (adoptText !== undefined && (adoptedRefs.length || revokedNames(adoptText).length)) {
      const write = adoptedChain.then(async () => {
        if (await $.env.get('EXOVAULT_BRIEF_CHILD')) return;
        const captureRoot = await findCaptureRoot({ cwd: () => $.session.cwd(), exists: (path: string) => $.fs.exists(path), root: () => $.session.root(), home: homeDir, inert: () => preflight.inert });
        if (captureRoot === null) return;
        if (interactiveOnly && !(await attendedSession({ surfaces: () => $.session.surfaces(), entrypoint: () => $.env.get('CLAUDE_CODE_ENTRYPOINT'), childSession: () => $.env.get('CLAUDE_CODE_CHILD_SESSION'), briefChild: () => $.env.get('EXOVAULT_BRIEF_CHILD') }))) return;
        const baseDir = capturePath(String(await $.session.id()), captureRoot);
        const cwd = await $.session.cwd();
        const home = (await homeDir()) ?? '';
        const indexPath = `${baseDir}/adopted.json`;
        let index: AdoptedEntry[] = [];
        try { if (await $.fs.exists(indexPath)) index = parseAdoptedIndex(await $.fs.read(indexPath)); } catch { index = []; }
        const revoked = revokedAdopted(adoptText, index);
        index = index.filter((entry) => !revoked.includes(entry));
        let copied = 0;
        for (const ref of adoptedRefs) {
          const path = resolveAdoptedPath(ref, cwd, home);
          if (path === undefined || isSecretLikePath(path)) continue;
          let text: string;
          try { if (!(await $.fs.exists(path))) continue; text = await $.fs.read(path); } catch { continue; }
          if (!text.trim()) continue;
          if (text.length > ADOPTED_MAX_CHARS) { notice(`adopted.skipped=too_large chars=${text.length}`); continue; }
          const savedPath = `${baseDir}/adopted/${sha256(path).slice(0, 12)}.md`;
          const safe = redactCapturedText(text);
          await $.fs.write(savedPath, safe);
          index = addAdopted(index, { path, savedPath, chars: safe.length, at: new Date(await $.clock.now()).toISOString() });
          copied += 1;
        }
        if (copied || revoked.length) {
          await $.fs.write(indexPath, JSON.stringify(index));
          notice(`adopted.copied=${copied}${revoked.length ? ` adopted.revoked=${revoked.length}` : ''}`);
        }
      });
      adoptedChain = write.catch(() => { try { notice('adopted.copied=error'); } catch { /* the hook call may have ended */ } });
    }
    // Only what a person typed (terminal or Remote Control) is labelled; `origin` is always set.
    // Skips are silent: `$.ui.log` draws a transcript line, and a line on every prompt of every
    // project is noise. Only an attempted request that failed is logged (review of 3.14.0, 1-2).
    const human = input.origin?.kind === 'composer' || input.origin?.kind === 'bridge';
    const captured = capturedUserText(input.text);
    const key = human ? submitLabelKey(input.text, sha256) : undefined;
    const logLabel = (status: string): void => { notice(`labels.jev=${status}`); };
    if (key !== undefined) {
      // The background promise owns every rejection. The prompt path itself returns next(input)
      // immediately, so a slow classifier cannot hold up the user's turn.
      void (async () => {
        const flagHost = { cwd: () => $.session.cwd(), exists: (path: string) => $.fs.exists(path), root: () => $.session.root(), home: homeDir, inert: () => preflight.inert };
        const captureRoot = await findCaptureRoot(flagHost);
        if (captureRoot === null) return;
        const jevEnabled = optionBoolean(options, 'jevEnabled', false);
        if (!jevEnabled) return;
        const denyList = optionString(options, 'jevDenyList', '').split(',').map((entry) => entry.trim()).filter(Boolean);
        if (!(await jevEgressAllowed(flagHost, true, denyList))) return;
        // 4.7.5 (S5q): EXO_JEV_URL names another address for Jev; without it the address is TypeSafe's.
        const labelEndpoint = await getJevEndpoint({ getTypeSafeApiKey: () => $.env.get('TYPESAFE_API_KEY'), getJevUrl: () => $.env.get('EXO_JEV_URL') });
        if (typeof labelEndpoint === 'string') return;
        const model = optionString(options, 'jevModel', 'jev-latest');
        const built = buildLabelQuestion(captured, (text) => Math.ceil(text.length / 4));
        const requestBody = JSON.stringify({
          model,
          state: built.state,
          questions: { label: { type: 'choice', options: built.question.options, criteria: built.question.criteria, instructions: built.question.instructions } },
        });
        let timer: { cancel: () => void } | undefined;
        const timeout = new Promise<undefined>((resolve) => {
          timer = $.clock.after(10_000, () => resolve(undefined));
        });
        let response: { status: number; ok: boolean; text: string } | undefined;
        try {
          response = await Promise.race([
            $.http.fetch(labelEndpoint.url, { method: 'POST', headers: { Authorization: `Bearer ${labelEndpoint.key}`, 'Content-Type': 'application/json' }, body: requestBody }),
            timeout,
          ]);
        } finally {
          timer?.cancel();
        }
        if (!response) { logLabel('timeout'); return; }
        const parsed = parseJevResponse(response.status, response.ok, response.text);
        if (!isLabelModel(model, parsed.model)) { logLabel('invalid'); return; }
        const answer = parseLabelAnswer(parsed.answers.label);
        if (!answer) { logLabel('invalid'); return; }
        const baseDir = capturePath(String(await $.session.id()), captureRoot);
        const path = `${baseDir}/labels.jsonl`;
        const previousWrite = labelWriteTails.get(path) ?? Promise.resolve();
        const write = previousWrite.then(async () => {
          let contents = '';
          try { contents = await $.fs.read(path); }
          catch { if (await $.fs.exists(path)) throw new Error('labels read failed'); }
          const line = JSON.stringify({ key, label: answer.label, p: answer.probability, model: parsed.model });
          await $.fs.write(path, contents ? `${contents.replace(/\n+$/, '')}\n${line}` : line);
        });
        labelWriteTails.set(path, write.catch(() => {}));
        await write;
      })().catch((error: unknown) => {
        const rawName = error instanceof Object && error.constructor && typeof error.constructor.name === 'string' ? error.constructor.name : 'Unknown';
        logLabel(/^[A-Za-z_$][\w$]{0,63}$/.test(rawName) ? rawName : 'Unknown');
      });
    }
    // 3.40.0 (CONTRACT S4zl): a short message after a cut gets the brief lines for its words, like a write does.
    const pushText = typeof input.text === 'string' && input.origin?.kind !== 'task-notification' ? briefText(input.text) : undefined;
    const briefPushOn = pushText !== undefined && pushText.length < BRIEF_MIN_CHARS && optionBoolean(options, 'briefPush', false);
    // 3.42.0 (CONTRACT S4zn): any message after a cut also gets the compacted-away session lines for its rare terms.
    // 3.43.0: on by default (ctxbench Haiku: 33/39 without it, 37/39 with it, ~1.2k tokens over 125 turns).
    const sessionPushOn = pushText !== undefined && optionBoolean(options, 'recallEnabled', true) && optionBoolean(options, 'sessionPush', true);
    if (briefPushOn || sessionPushOn) {
      const pushHost: BriefPushHost = { cwd: () => $.session.cwd(), root: () => $.session.root(), id: () => $.session.id(), exists: (path: string) => $.fs.exists(path), read: (path: string) => $.fs.read(path), home: homeDir, inert: () => preflight.inert, pluginRoot: () => $.env.get('CLAUDE_PLUGIN_ROOT'), run: (argv: string[], init: { stdin: string; timeoutMs: number }) => $.process.run(argv, init), log: (line: string) => notice(line), fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string; socketPath: string }) => $.http.fetch(url, init), after: (ms: number, fn: () => void) => $.clock.after(ms, fn), now: () => $.clock.now() };
      const pluginRootOption = optionString(options, 'recallPluginRoot', '');
      return Promise.all([
        briefPushOn ? runBriefPush(pushHost, { prompt: pushText! }, pluginRootOption) : Promise.resolve(undefined),
        sessionPushOn ? runSessionPush(pushHost, pushText!, pluginRootOption) : Promise.resolve(undefined),
      ]).then((notes) => {
        const added = notes.filter((note): note is string => Boolean(note));
        return next(added.length ? { ...input, context: [...(input.context ?? []), ...added] } : input);
      });
    }
    return next(input);
  }).catch(($, input, next) => {
    try { $.ui.log(`hook.caught=prompt.submit kind=${next.error.kind}`, { to: 'debug' }); } catch { /* debug logging cannot block the prompt */ }
    return next(input);
  });
  on('session.compact', async ($, input, next) => {
    const homeDir = () => resolveHomeDir({ home: () => $.env.get('HOME'), userProfile: () => $.env.get('USERPROFILE'), homeDrive: () => $.env.get('HOMEDRIVE'), homePath: () => $.env.get('HOMEPATH') });
    const notice = noticeLog({ emit: (...args: [string, { to: 'debug' }?]) => $.ui.log(...args), surfaces: () => $.session.surfaces(), entrypoint: () => $.env.get('CLAUDE_CODE_ENTRYPOINT'), childSession: () => $.env.get('CLAUDE_CODE_CHILD_SESSION'), briefChild: () => $.env.get('EXOVAULT_BRIEF_CHILD'), logFile: async () => { const noticeRoot = await findCaptureRoot({ cwd: () => $.session.cwd(), exists: (path: string) => $.fs.exists(path), root: () => $.session.root(), home: homeDir, inert: () => preflight.inert }); return noticeRoot === null ? undefined : `${capturePath(String(await $.session.id()), noticeRoot)}/notices.log`; }, read: (path: string) => $.fs.read(path), write: (path: string, text: string) => $.fs.write(path, text), now: () => $.clock.now() });
    let nextResult: ReturnType<typeof next> | undefined;
    const fallback = () => nextResult ??= next(input);
    // Round 11 (hook compiler's `$` spelling rule, CONTRACT.md): `$` and `$.fs` may never be
    // handed to an imported function as a bare value; every seam below is a plain closure object
    // built right here, with `$` spelled directly as `$.noun.event(...)` inside each closure.
    const flagHost = { cwd: () => $.session.cwd(), exists: (path: string) => $.fs.exists(path), root: () => $.session.root(), home: homeDir, inert: () => preflight.inert };
    const fsLike = { read: (path: string) => $.fs.read(path), write: (path: string, text: string) => $.fs.write(path, text), list: (path?: string) => $.fs.list(path), exists: (path: string) => $.fs.exists(path) };
    const pressureStateFs = { read: (path: string) => $.fs.read(path), write: (path: string, text: string) => $.fs.write(path, text), exists: (path: string) => $.fs.exists(path) };
    // S4d: transcript pointer (spec §3.1.2) host seam, same in-file-closure convention as above.
    const transcriptPathHost = { cwd: () => $.session.cwd(), home: homeDir, configDir: () => $.env.get('CLAUDE_CONFIG_DIR') };
    const transcriptExists = (path: string) => $.fs.exists(path);
    // Selector J (spec v3.4 §3.3) host seam, same in-file-closure convention as above: `$.http`
    // and `$.env` are never handed to select-j.ts or host/jev-client.ts bare, only through these
    // plain closures built here.
    const httpLike = { fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => $.http.fetch(url, init) };
    // B1 (review-opus-s4b.md): `$.env.get` takes the variable's name as a string literal
    // (types/cc.d.ts:2805-2814); the host statically scans this module's own source for that
    // literal spelling, so a closure that forwards a `name: string` parameter never gets the
    // access it silently appears to grant at the type level. This closure takes no argument at
    // all: it always spells the one literal name selector J needs, right here, at the call site.
    const envLike = { getTypeSafeApiKey: () => $.env.get('TYPESAFE_API_KEY'), getJevUrl: () => $.env.get('EXO_JEV_URL') };
    try {
      // interactiveOnly (set when the plugin is enabled globally in settings): a -p run or the SDK
      // draws on no surface, so scripted runs (task runners, A/B arms) keep native compaction. The VS Code
      // and Cursor extension attaches no surface either but is attended (host/notices.ts, attendedSession).
      const captureRoot = await findCaptureRoot(flagHost);
      if (captureRoot === null) { notice.debug('compact.fallback=not_enabled origin=compact'); return fallback(); }
      if (interactiveOnly && !(await attendedSession({ surfaces: () => $.session.surfaces(), entrypoint: () => $.env.get('CLAUDE_CODE_ENTRYPOINT'), childSession: () => $.env.get('CLAUDE_CODE_CHILD_SESSION'), briefChild: () => $.env.get('EXOVAULT_BRIEF_CHILD') }))) {
        notice(`compact.fallback=interactive_only origin=compact entrypoint=${(await $.env.get('CLAUDE_CODE_ENTRYPOINT')) || 'unset'}`);
        return fallback();
      }
      const override = forceTriggerOverride({ trigger: await $.env.get('EXO_COMPACT_GATE_FORCE_TRIGGER'), agentId: await $.env.get('EXO_COMPACT_GATE_FORCE_AGENT_ID') });
      const event = applyForceTriggerOverride(input as CompactEvent, override);
      const route = routeTrigger(event);
      if (route.kind === 'skip') return { skip: route.reason };
      if (route.kind === 'next') {
        notice('compact.route=next');
        if (event.agentId === undefined) return fallback();
        const nativeResult = await fallback() as import('claude-code').SessionCompactResult;
        const safeAgentId = event.agentId.replace(/[^A-Za-z0-9_-]/g, '_') || 'agent';
        const pressurePath = `${capturePath(String(await $.session.id()), captureRoot)}/agent-pressure/${safeAgentId}.json`;
        let stateText: string | null = null;
        try {
          if (await $.fs.exists(pressurePath)) stateText = await $.fs.read(pressurePath);
        } catch { stateText = null; }
        const parsedState = parseAgentPressureState(stateText);
        const nextPressure = advanceAgentPressure(parsedState.state, countToolUsesSinceSummary(event.messages, parsedState.state === null));
        notice(`agent.compaction_pressure=${parsedState.unreadable ? 'state_unreadable' : nextPressure.pressure} agent=${safeAgentId}`);
        try { await $.fs.write(pressurePath, JSON.stringify(nextPressure.state)); } catch { /* best-effort: never abort native compaction */ }
        if (!nextPressure.guidance || !('messages' in nativeResult) || !nativeResult.messages) return nativeResult;
        return { ...nativeResult, messages: [...nativeResult.messages, guidanceForPressure(nextPressure.pressure, nextPressure.compactions) as import('claude-code').SessionMessage] };
      }
      const sessionId = String(await $.session.id());
      // 3.11.0 refusal guard (core/refusal-guard.ts): a classifier refusal after an S4 cut turned
      // S4 off for this session, so this cut and every later one go to core. An unreadable flag
      // leaves S4 on: the guard only ever narrows what runs.
      let refusalGuarded = false;
      try { refusalGuarded = await $.fs.exists(`${capturePath(sessionId, captureRoot)}/${REFUSAL_GUARD_FILE}`); } catch { refusalGuarded = false; }
      if (refusalGuarded) {
        notice('compact.fallback=refusal_guard origin=compact');
        return fallback();
      }
      const recallEnabled = optionBoolean(options, 'recallEnabled', true);
      const recallVectorsEnabled = optionBoolean(options, 'recallVectors', true);
      const denseNotesEnabled = optionBoolean(options, 'denseNotes', true);
      const workStateEnabled = optionBoolean(options, 'workState', true);
      const toolOutputNotesEnabled = optionBoolean(options, 'toolOutputNotes', true);
      const baseDir = capturePath(sessionId, captureRoot);
      /** 3.37.0 (CONTRACT S4zj): set when this cut's seed points at a saved task brief; arms the Stop-time brief check. */
      let briefCheckArmed = false;
      let briefPushArmed = false;
      const store = makeFsCaptureStore(fsLike, baseDir);
      // 3.46.0 (CONTRACT S4zt): every budget (seed sections, tail, total, the reduction check) counts with the
      // density-aware estimate; chars / 4 read code, paths and JSON at about half their real size, so the 13k total
      // left ~25k real tokens after a cut (w17 w60e/w60f) against native's 13k-18k. `realTokenCount: false` restores it.
      const realTokenCount = optionBoolean(options, 'realTokenCount', true);
      const countTokens = realTokenCount ? estimateTokens : (text: string) => Math.ceil(text.length / 4);
      const tokensBefore = serializedTokens(event.messages, countTokens);
      notice(`compact.sizeBefore=${tokensBefore}`);
      const cutStartedAt = Number(await $.clock.now());
      type Attempt = { messages?: import('claude-code').SessionMessage[]; tokensAfter?: number; fallback?: import('claude-code').SessionCompactResult };
      const result = await withFallback<Attempt>({
        run: async (signal) => {
          // Round 15 (brief-s4a-fix15.md item 3): the hooks worker sends a heartbeat every
          // 5000ms and respawns (unloading this plugin for the rest of the session) if a hook
          // never yields back to the event loop. `core/seed.ts`'s round-15 fix (binary search
          // instead of an O(lineCount^2) shift loop) already keeps every phase well inside a
          // single heartbeat window on the real evidence capture (~950KB, offline repro: 63ms
          // total, no phase over 25ms), but this handler still spans several genuinely separable
          // phases over data whose size is this store's own history, not this handler's control;
          // yielding a macrotask between them costs nothing (each phase is already comfortably
          // under budget) and keeps the heartbeat answerable even if a future session's capture
          // store, or a future phase added here, grows past what today's evidence covers.
          // `$` is spelled directly (`$.clock.sleep(...)`) inside this same-file closure, never
          // forwarded elsewhere, per the hook compiler's spelling rule (CONTRACT.md, dollar-
          // spelling gate).
          const yieldTick = async (): Promise<void> => { await $.clock.sleep(0, { signal }); };
          const hostCwd = String(await $.session.cwd());
          const extracted = reconcile(event.messages, await store.loadWatermark(), { hash: sha256, toolOutputNotes: toolOutputNotesEnabled });
          const previousCwd = await latestCwdSnapshot(fsLike, baseDir);
          if (previousCwd?.path !== hostCwd) extracted.records.push({ kind: 'work_event', origin: 'reconcile', producedBy: 's4-capture', sourceHash: `cwd:${sha256(`${previousCwd?.sourceHash ?? 'root'}:${hostCwd}`)}`, body: { type: 'cwd_snapshot', path: hostCwd } });
          // Round 9 finding 2: persist the reconciled records before anything below that can
          // still throw (the tail/budget computation, seed render, an insufficient-reduction
          // result), so a fallback to core (budget, error, timeout) never discards them. This
          // write's watermark is provisional: `extracted.watermark` describes the pre-compaction
          // list `reconcile` just consumed. If this attempt goes on to succeed, the second write
          // near the bottom overwrites it with the post-compaction position; if it falls back,
          // the `next` callback below overwrites it with core's own kept messages when core
          // returns any (finding 3), or leaves this one standing when it does not.
          if (signal.aborted) throw new Error('aborted');
          await store.appendRecords(extracted.records, extracted.watermark, signal);
          await yieldTick();
          // 3.47.0 (CONTRACT S4zu, core/task-card.ts): the card the session's model kept goes into the seed in place of
          // the whole brief, and the total drops to about what native compaction keeps.
          const taskCardEnabled = optionBoolean(options, 'taskCard', true);
          const cardPath = `${baseDir}/${TASK_CARD_FILE}`;
          let taskCardText: string | undefined;
          let briefIsLastPrompt = false;
          if (taskCardEnabled) {
            // 3.55.0 (external review 5 A3): the card's brief id is read before and after its text; a refresh that landed
            // in between (text and id are two writes) leaves the pair unproven, and the card is left out.
            const cardBriefPath = `${baseDir}/${TASK_CARD_BRIEF_FILE}`;
            const readCardBrief = async (): Promise<string | undefined> => ((await $.fs.exists(cardBriefPath)) ? (await $.fs.read(cardBriefPath)).trim() : undefined);
            try {
              const before = await readCardBrief();
              taskCardText = (await $.fs.exists(cardPath)) ? (await $.fs.read(cardPath)).trim() || undefined : undefined;
              if (taskCardText !== undefined && (await readCardBrief()) !== before) { taskCardText = undefined; notice('seed.task_card_racing=1'); }
            } catch { taskCardText = undefined; }
            // 3.53.0: a card written before the newest saved brief belongs to the previous task. w17 w60m r2: the cut
            // came 5 s after the Task 8 prompt, while the refresh fork for it was still running; the seed led with the
            // Task 7 card, the new brief was one pointer line, and the model redid Task 7. Such a card is left out and
            // the seed falls back to the brief path it had before cards.
            if (taskCardText !== undefined && recallEnabled) {
              try {
                const index = `${(await homeDir()) ?? '.'}/.claude/exovault/recall/${sha256(sessionId)}/briefs/briefs.json`;
                const newestEntry = (await $.fs.exists(index)) ? parseBriefIndex(await $.fs.read(index)).at(-1) : undefined;
                const newestId = newestEntry?.id;
                // A card from before 3.48.1 has no recorded brief and is kept.
                const cardBriefId = await readCardBrief();
                if (newestId !== undefined && cardBriefId !== undefined && newestId !== cardBriefId) {
                  taskCardText = undefined;
                  // 3.54.0: when the cut comes on the new task's prompt itself (the last message, which the tail always
                  // keeps), the brief is already in the tail: the seed stays at the card total with the brief's path
                  // lines. w17 w60n: 2 of 3 stale cuts were this case and carried the brief twice in a 20000 seed.
                  // 3.55.0: the whole saved brief must be in that message, not only its first line (external review 5
                  // B1: a short prompt repeating the brief's heading dropped the stale card and the brief both).
                  const last = event.messages.at(-1);
                  const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
                  const savedBrief = newestEntry !== undefined && (await $.fs.exists(newestEntry.path)) ? flat(await $.fs.read(newestEntry.path)) : '';
                  briefIsLastPrompt = last?.role === 'user' && savedBrief.length >= BRIEF_MIN_CHARS && flat(briefText(last.text) ?? '').includes(savedBrief);
                  notice(`seed.task_card_stale=1 seed.brief_last_prompt=${briefIsLastPrompt ? 1 : 0}`);
                }
              } catch { /* the card stays */ }
            }
          }
          const cardOn = taskCardText !== undefined || briefIsLastPrompt;
          // The card total has its own option: `totalBudgetTokens` always arrives with its manifest default (20000),
          // which held the first live card cut (w17 w60h) at 20000.
          const baseBudgets = cardOn
            ? cardBudgets(optionNumber(options, 'cardTotalBudgetTokens', CARD_TOTAL_BUDGET_TOKENS))
            : scaledBudgets(optionNumber(options, 'totalBudgetTokens', realTokenCount ? REAL_TOTAL_BUDGET_TOKENS : TOTAL_BUDGET_TOKENS));
          notice(`seed.budget_total=${baseBudgets.total} seed.budget_count=${realTokenCount ? 'real' : 'chars4'}`);
          notice(`seed.budget_split seed=${baseBudgets.seed} tail=${baseBudgets.tail} dense=${baseBudgets.dense}`);
          // 3.39.0 (core/briefs.ts BRIEF_FULL_MAX_CHARS): the newest saved brief goes into the seed whole when it fits;
          // the tokens it needs past the usual brief budget come out of the tail budget, so the total stays the same.
          const briefsDir = recallEnabled && optionBoolean(options, 'taskBriefs', true) ? `${(await homeDir()) ?? '.'}/.claude/exovault/recall/${sha256(sessionId)}/briefs` : undefined;
          const baseBriefTokens = Math.min(BRIEF_BUDGET_TOKENS, Math.round(baseBudgets.seed / 3));
          let fullBrief: { path: string; text: string } | undefined;
          let briefShift = 0;
          if (briefsDir !== undefined && !cardOn && optionBoolean(options, 'fullBrief', true)) {
            try {
              const indexPath = `${briefsDir}/briefs.json`;
              const briefEntries = (await $.fs.exists(indexPath)) ? parseBriefIndex(await $.fs.read(indexPath)) : [];
              const newestBrief = briefEntries.at(-1);
              if (newestBrief !== undefined && newestBrief.chars <= BRIEF_FULL_MAX_CHARS && (await $.fs.exists(newestBrief.path))) {
                const text = await $.fs.read(newestBrief.path);
                // 3.55.0: the need is the whole section as rendered (intro, older brief paths, tags). A flat 400 tokens
                // was 180-1060 short on every w17 cut (w60o), so the brief never went in whole and fell to its pointer.
                const need = countTokens(renderTaskBriefs(briefEntries, { sessionId, full: text }, countTokens, Number.MAX_SAFE_INTEGER)) - baseBriefTokens;
                if (text.length <= BRIEF_FULL_MAX_CHARS && need <= baseBudgets.tail - Math.round(baseBudgets.tail * BRIEF_MIN_TAIL_SHARE)) {
                  fullBrief = { path: newestBrief.path, text };
                  briefShift = Math.max(0, need);
                }
              }
            } catch { fullBrief = undefined; briefShift = 0; }
            notice(`seed.full_brief=${fullBrief === undefined ? 0 : 1} seed.brief_tail_shift=${briefShift}`);
          }
          let budgets = { ...baseBudgets, seed: baseBudgets.seed + briefShift, tail: baseBudgets.tail - briefShift };
          let tail = pickTail(event.messages, { budgetTokens: budgets.tail, countTokens, hash: sha256, rebuildThresholdTokens: REBUILD_THRESHOLD_TOKENS, trigger: event.trigger });
          // 3.45.0 (CONTRACT S4zs): the newest messages stay in the tail even past its budget. When they need more
          // than the shift left the tail, the full brief gives that much back (and shrinks in the seed below), so the
          // total stays the same. w17 w60d: 4 of 15 cuts kept a 3.6k-5.7k token tail under a 2.6k-3.5k budget and
          // fell back on `budget` with every seed section already shrunk.
          const keptTailTokens = serializedTokens(tail.messages, countTokens);
          if (briefShift > 0 && keptTailTokens > budgets.tail) {
            const returned = Math.min(briefShift, keptTailTokens - budgets.tail);
            briefShift -= returned;
            budgets = { ...baseBudgets, seed: baseBudgets.seed + briefShift, tail: baseBudgets.tail - briefShift };
            notice(`seed.brief_shift_returned=${returned}`);
          }
          // 3.55.0: without a card, newest messages past the tail budget (with the shift already given back) take
          // the room from the seed instead of failing the tail check with the total unspent; the seed sections
          // shrink below. w60o replay, stale card at cut 4: tail 10845/10769 with the seed at 9196/9231 fell back.
          if (!cardOn && keptTailTokens > budgets.tail) {
            const moved = keptTailTokens - budgets.tail;
            budgets = { ...budgets, seed: Math.max(0, budgets.seed - moved), tail: keptTailTokens };
            notice(`seed.tail_took_seed=${moved}`);
          }
          // S4q: what the tail leaves of its budget goes to the dense notes and the seed cap.
          if (cardOn) budgets = stretchForTail(budgets, keptTailTokens);
          const spillTokens = tailSpillTokens(serializedTokens(tail.messages, countTokens), budgets.tail);
          let seedBudgetTokens = budgets.seed + spillTokens;
          await yieldTick();
          const entries = await listIfPresent(fsLike, baseDir);
          const captured: CaptureRecord[] = [];
          // Round 7 D8: list order is not guaranteed sorted (fs-adapter.ts sorts its own
          // internal read, but this render-time read is separate); without sorting by name, a
          // host that lists an older segment after a newer one lets an older todo/value
          // overwrite a newer one in the `latest` map below. `extracted.records` are already
          // among these segments (written just above), so they need no separate in-memory push.
          const sortedEntries = entries.filter((item) => item.kind === 'file' && item.name.startsWith('segment-')).sort((a, b) => a.name.localeCompare(b.name));
          for (const [entryIndex, entry] of sortedEntries.entries()) {
            const text = await $.fs.read(`${baseDir}/${entry.name}`);
            for (const line of text.split('\n').filter(Boolean)) {
              try { captured.push(JSON.parse(line) as CaptureRecord); } catch {}
            }
            // Round 15: a long-lived session can accumulate many segment files (fs-adapter.ts
            // caps each at 3MB, not their count); yielding every 20 keeps this loop's own
            // duration bounded per heartbeat window regardless of how many segments exist.
            if (entryIndex % 20 === 19) await yieldTick();
          }
          const latest = new Map<string, CaptureRecord>();
          const seenWorkEventHashes = new Set<string>();
          for (const stored of captured) {
            const record = cleanCapturedRecord(stored);
            if (record?.kind === 'work_event') {
              if (seenWorkEventHashes.has(record.sourceHash)) continue;
              seenWorkEventHashes.add(record.sourceHash);
            }
            if (record) latest.set(`${record.kind}:${record.kind === 'work_event' ? record.sourceHash : record.body.key ?? record.body.id ?? record.sourceHash}`, record);
          }
          // S4n labels are optional hints: an absent, corrupt or unreadable sidecar preserves the
          // 3.13.0 behavior exactly. Read the sidecar once for this cut.
          const labelsPath = `${baseDir}/labels.jsonl`;
          let labels = new Map<string, import('./core/labels.js').MessageLabel>();
          try {
            if (await $.fs.exists(labelsPath)) labels = parseLabels(await $.fs.read(labelsPath));
          } catch { labels = new Map(); }
          // Pressure state shares the session capture directory with the immutable record
          // segments. A missing or malformed record disables pressure for this cut; persistence
          // below is best-effort and must never turn a successful compaction into a fallback.
          const pressurePath = `${baseDir}/compaction-pressure.json`;
          let pressureStateText: string | null = null;
          try {
            if (await pressureStateFs.exists(pressurePath)) pressureStateText = await pressureStateFs.read(pressurePath);
          } catch { pressureStateText = null; }
          const parsedPressure = parseCompactionPressureState(pressureStateText);
          const pressureStep = advanceCompactionPressure(parsedPressure.state, captured.length, captured.filter((record) => record.kind === 'user').length, {
            toolUsesSinceCut: countToolUsesSinceSummary(event.messages),
            tailToolUses: tail.messages.reduce((total, message) => total + (message.role === 'assistant' ? message.toolUses.length : 0), 0),
            manual: event.trigger === 'manual',
          });
          const compactionPressure = pressureStep.pressure ? renderCompactionPressure(pressureStep.pressure) : undefined;
          notice(`seed.compaction_pressure=${pressureStateText === null ? 'state_missing' : parsedPressure.unreadable ? 'state_unreadable' : pressureStep.pressure?.consecutive ?? 0}`);
          const values = [...latest.values()].filter((record) => record.kind === 'value').map((record) => JSON.stringify(record.body)).join('\n');
          const todos = [...latest.values()].filter((record) => record.kind === 'todo' && record.body.status !== 'cleared').map((record) => JSON.stringify(record.body)).join('\n');
          let workStateBody = '';
          if (workStateEnabled) {
            try {
            const sessionCwd = String(await $.session.cwd());
            const workEventHashes = new Set<string>();
            const capturedWorkEvents = captured.filter((record) => record.kind === 'work_event').filter((record) => {
              if (workEventHashes.has(record.sourceHash)) return false;
              workEventHashes.add(record.sourceHash);
              return true;
            }).map((record) => record.body).filter(validWorkEvent);
            const workEventsPath = `${baseDir}/work-events.jsonl`;
            try {
              if (await $.fs.exists(workEventsPath)) {
                const lines = (await $.fs.read(workEventsPath)).slice(-1024 * 1024).split(/\r?\n/).filter(Boolean);
                for (const line of lines) {
                  try {
                    const entry = JSON.parse(line) as { id?: unknown; status?: unknown; summary?: unknown };
                    if (typeof entry.id === 'string' && typeof entry.status === 'string') capturedWorkEvents.push({ type: 'bg_end', id: entry.id, status: entry.status, ...(typeof entry.summary === 'string' ? { summary: entry.summary } : {}) });
                  } catch { /* ignore malformed trailing lines */ }
                }
              }
            } catch { /* notification capture is best-effort */ }
            const priorSnapshot = [...capturedWorkEvents].reverse().find((item) => item.type === 'cwd_snapshot');
            if (priorSnapshot?.type !== 'cwd_snapshot' || priorSnapshot.path !== sessionCwd) capturedWorkEvents.push({ type: 'cwd_snapshot', path: sessionCwd });
            const state = foldWorkState(capturedWorkEvents, sessionCwd);
            let probeDir = sessionCwd;
            try { if (await $.fs.exists(state.directory)) probeDir = state.directory; } catch { probeDir = sessionCwd; }
            let probe: WorkStateProbe | undefined;
            if (optionBoolean(options, 'workStateProbe', true)) {
              let probeStatus: 'ok' | 'timeout' | 'error' | 'not_git' = 'ok';
              const env = { GIT_OPTIONAL_LOCKS: '0' };
              const statusPromise = $.process.run(['git', '-C', probeDir, 'status', '--ignore-submodules=all', '--porcelain=v1', '-b', '-uno'], { cwd: sessionCwd, env, timeoutMs: 1500 });
              const worktreePromise = $.process.run(['git', '-C', probeDir, 'worktree', 'list', '--porcelain'], { cwd: sessionCwd, env, timeoutMs: 1500 });
              const [statusResult, worktreeResult] = await Promise.allSettled([statusPromise, worktreePromise]);
              const statusText = (result: PromiseSettledResult<Awaited<typeof statusPromise>>): 'timeout' | 'error' | undefined => result.status === 'rejected' ? (/timeout|timed out/i.test(String(result.reason)) ? 'timeout' : 'error') : undefined;
              const statusFailure = statusText(statusResult) ?? statusText(worktreeResult);
              if (statusFailure) probeStatus = statusFailure;
              if (statusResult.status === 'fulfilled') {
                if (statusResult.value.exitCode !== 0) probeStatus = 'not_git';
                else {
                  const rows = statusResult.value.stdout.trimEnd().split(/\r?\n/);
                  const header = rows.shift() ?? '';
                  const changed = rows.filter(Boolean).length;
                  probe = { ...(probe ?? {}), directory: probeDir, git: `${probeDir}: ${header}; ${changed} changed file${changed === 1 ? '' : 's'}` };
                }
              }
              if (worktreeResult.status === 'fulfilled' && worktreeResult.value.exitCode === 0) {
                const trees: Array<{ path: string; branch?: string }> = [];
                let current: { path?: string; branch?: string } = {};
                for (const line of worktreeResult.value.stdout.split(/\r?\n/)) {
                  if (!line) { if (current.path) trees.push({ path: current.path, ...(current.branch ? { branch: current.branch } : {}) }); current = {}; continue; }
                  if (line.startsWith('worktree ')) current.path = line.slice(9);
                  if (line.startsWith('branch refs/heads/')) current.branch = line.slice('branch refs/heads/'.length);
                }
                if (current.path) trees.push({ path: current.path, ...(current.branch ? { branch: current.branch } : {}) });
                probe = { ...(probe ?? {}), directory: probeDir, worktrees: trees };
              } else if (worktreeResult.status === 'fulfilled' && worktreeResult.value.exitCode !== 0 && probeStatus === 'ok') probeStatus = 'not_git';
              notice(`seed.work_state_probe=${probeStatus}`);
            }
            workStateBody = renderWorkState(state, probe, WORK_STATE_BUDGET_TOKENS, countTokens, sessionCwd);
            notice(`seed.work_state_size=${countTokens(workStateBody)}`);
            } catch { workStateBody = ''; notice('seed.work_state=error'); }
          }
          const userRecords = [...latest.values()].filter((record) => record.kind === 'user');
          // 3.43.0 (CONTRACT S4zo): the newest value of each thing the user changed, so a value moved step by step survives the cuts.
          const currentValuesBody = optionBoolean(options, 'currentValues', true) ? renderStateUpdates(extractStateUpdates(userRecords.map((record) => String(record.body.text ?? ''))), countTokens) : '';
          if (currentValuesBody) notice(`seed.current_values=${currentValuesBody.split('\n').length}`);
          const labelsByRecord = new Map<CaptureRecord, import('./core/labels.js').MessageLabel | undefined>();
          let labelsApplied = 0;
          let labelsMissing = 0;
          for (const record of userRecords) {
            const key = labelKey(String(record.body.text ?? ''), sha256);
            const label = key === undefined ? undefined : labels.get(key);
            labelsByRecord.set(record, label);
            if (label === undefined) labelsMissing += 1;
            else labelsApplied += 1;
          }
          notice(`labels.applied=${labelsApplied} labels.missing=${labelsMissing}`);
          const historyCutoff = Math.max(0, userRecords.length - 3);
          const userHistory = userRecords.filter((record, index) => labelsByRecord.get(record) !== 'chat' || index >= historyCutoff).map((record) => String(record.body.text ?? '')).filter(Boolean);
          await yieldTick();
          // S4d section 0 (spec §3.1.1): pure extractor over `user` capture records only, never
          // tool output or assistant text. `latest.values()` iterates in the same oldest-first
          // segment/line order the render-time read above already assembled (round 7 D8's sort),
          // which is what makes the extractor's own `seq` ordinal (core/constraints.ts) stable.
          // Round 16 (spec v3.2.3 F2, brief-s4a-fix16.md): an over-cap, non-bullet paragraph that
          // still carries a marker is logged instead of dropped silently (core/constraints.ts
          // stays pure, so the counting callback is the only thing crossing the boundary, and this
          // file is the one place allowed to spell `$.ui.event(...)`, per the dollar-spelling rule).
          let skippedParagraphCount = 0;
          // A question or consent keeps only its sentences that still state a hard rule, so one
          // label on a mixed message never drops the rule (review of 3.14.0, finding 4).
          const constraintRecords = userRecords.flatMap((record) => {
            const label = labelsByRecord.get(record);
            if (label === 'chat') return [];
            if (label !== 'question' && label !== 'consent') return [record];
            const rules = ruleSentences(String(record.body.text ?? ''));
            return rules ? [{ ...record, body: { ...record.body, text: rules } }] : [];
          });
          // 3.34.0: copies of adopted rules files are quoted whole above the sentence rules; a file with a copy drops
          // its sentence-level extraction, which would only repeat it.
          // A copy still being written for the prompt that just ran is waited for (at most 2 s); an original that still
          // exists refreshes its copy, so an edited rules file is quoted as it is now.
          const adoptedFiles: { entry: AdoptedEntry; text: string }[] = [];
          if (optionBoolean(options, 'adoptedFiles', true)) {
            await Promise.race([adoptedChain.catch(() => {}), $.clock.sleep(2000, { signal })]);
            let adoptedIndex: AdoptedEntry[] = [];
            try { if (await $.fs.exists(`${baseDir}/adopted.json`)) adoptedIndex = parseAdoptedIndex(await $.fs.read(`${baseDir}/adopted.json`)); } catch { adoptedIndex = []; }
            for (const indexed of adoptedIndex) {
              if (isSecretLikePath(indexed.path)) continue;
              const entry = { ...indexed, savedPath: `${baseDir}/adopted/${sha256(indexed.path).slice(0, 12)}.md` };
              // Each step fails on its own: an unreadable original or a failed write still leaves the saved copy.
              let current: string | undefined;
              try { if (await $.fs.exists(entry.path)) current = await $.fs.read(entry.path); } catch { current = undefined; }
              let saved: string | undefined;
              try { if (await $.fs.exists(entry.savedPath)) saved = await $.fs.read(entry.savedPath); } catch { saved = undefined; }
              let text = saved;
              if (current !== undefined && current.trim()) {
                if (current.length > ADOPTED_MAX_CHARS) notice('adopted.refresh=too_large');
                else if (redactCapturedText(current) !== saved) {
                  text = redactCapturedText(current);
                  notice('adopted.refreshed=1');
                  try { await $.fs.write(entry.savedPath, text); } catch { /* the seed still quotes the current text */ }
                }
              }
              if (text !== undefined) adoptedFiles.push({ entry, text });
            }
          }
          const adoptedBudgetTokens = Math.min(ADOPTED_BUDGET_TOKENS, Math.round(baseBudgets.seed / 4));
          const copiedPaths = new Set(adoptedFiles.map(({ entry }) => entry.path));
          const constraints = [...extractConstraints(constraintRecords, sha256, () => { skippedParagraphCount += 1; }), ...extractAdoptedFileConstraints(event.messages, sha256).filter((constraint) => constraint.sourceFile === undefined || !copiedPaths.has(constraint.sourceFile))];
          if (skippedParagraphCount > 0) notice(`seed.constraints_skipped_paragraph=${skippedParagraphCount}`);
          const constraintsOverflow = applyConstraintOverflow(constraints, countTokens, sha256);
          if (constraintsOverflow.overflowCount > 0) notice(`seed.constraints_overflow=${constraintsOverflow.overflowCount}`);
          const constraintsAt = (adoptedBudget: number): string => [renderAdoptedFiles(adoptedFiles, adoptedBudget, countTokens), renderConstraintsSection(constraintsOverflow.rendered)].filter(Boolean).join('\n');
          const constraintsBody = constraintsAt(adoptedBudgetTokens);
          if (adoptedFiles.length) notice(`seed.adopted_files=${adoptedFiles.length}`);
          await yieldTick();
          // Turning toolOutputNotes off also hides output lines captured before the switch.
          const denseSourceRecords = [...latest.values()].filter((record) => toolOutputNotesEnabled || record.kind !== 'tool_output').map((record) => {
            if (record.kind !== 'user') return record;
            const label = labelsByRecord.get(record);
            return label === undefined ? record : { ...record, body: { ...record.body, label } };
          });
          const denseTailText = tail.messages.map((message) => [message.text, ...message.toolUses.map((use) => JSON.stringify(use.input ?? {})), ...(message.toolResults ?? []).map((result) => result.text)].join('\n')).join('\n');
          const denseCoveredText = `${denseTailText}\n${constraintsBody}\n${workStateBody}\n${historyForSeed(userHistory).userInstructionsVerbatim.join('\n')}\n${values}\n${todos}\n${renderGatesAndErrors([...latest.values()])}`;
          const denseCandidatePool = denseNotesEnabled ? denseCandidates(denseSourceRecords) : [];
          let denseJevScores: Map<string, number> | undefined;
          if (denseNotesEnabled) {
            let startedLogAt = 0;
            let status: 'ok' | 'partial' | 'timeout' | 'error' | 'skipped' = 'skipped';
            let skipped: string | undefined;
            let requestCount = 0;
            let answered = 0;
            let asked = 0;
            let units = 0;
            let wall = 0;
            try {
              startedLogAt = await $.clock.now();
              const rerankEnabled = optionBoolean(options, 'jevDenseRerank', true);
              const jevEnabledForDense = optionBoolean(options, 'jevEnabled', false);
              if (!jevEnabledForDense) skipped = 'disabled';
              else if (!rerankEnabled) skipped = 'option_off';
              else {
                const denyListForDense = optionString(options, 'jevDenyList', '').split(',').map((entry) => entry.trim()).filter(Boolean);
                if (!(await jevEgressAllowed(flagHost, true, denyListForDense))) skipped = 'deny_list';
                else {
                  const candidatesForJev = denseJevCandidates(denseCandidatePool, denseCoveredText);
                  if (!candidatesForJev.length) skipped = 'no_candidates';
                  else {
                    const denseEndpoint = await getJevEndpoint(envLike);
                    if (typeof denseEndpoint === 'string') skipped = denseEndpoint === 'bad_url' ? 'bad_jev_url' : 'no_api_key';
                    else {
                      const jevModelForDense = optionString(options, 'jevModel', 'jev-latest');
                      const queryForDense = denseJevQuery(denseTailText, userHistory.slice(-3));
                      const requests = buildDenseJevRequests(queryForDense, candidatesForJev, jevModelForDense, { perRequest: 150, maxRequestTokens: 48000, countTokens, hash: sha256 });
                      let nextRequest = 0;
                      let firstSendAt: number | undefined;
                      let sawTimeout = false;
                      let failedRequests = 0;
                      denseJevScores = new Map();
                      const runRequest = async (request: typeof requests[number]): Promise<void> => {
                        if (signal.aborted) return;
                        const now = await $.clock.now();
                        if (firstSendAt === undefined) firstSendAt = now;
                        const remaining = Math.max(0, optionNumber(options, 'jevDenseTotalBudgetMs', 5000)) - (now - firstSendAt);
                        if (remaining <= 0) { sawTimeout = true; return; }
                        requestCount += 1;
                        asked += request.keys.length;
                        let timer: { cancel: () => void } | undefined;
                        const timeoutMs = Math.min(Math.max(0, optionNumber(options, 'jevDensePerCallTimeoutMs', 3000)), remaining);
                        const timeout = new Promise<undefined>((resolve) => { timer = $.clock.after(timeoutMs, () => resolve(undefined)); });
                        try {
                          // A rejected fetch or a non-2xx answer (429, 5xx) fails only its own request: the
                          // other requests' scores still count.
                          let response: { status: number; ok: boolean; text: string } | undefined;
                          try {
                            response = await Promise.race([
                              $.http.fetch(denseEndpoint.url, { method: 'POST', headers: { Authorization: `Bearer ${denseEndpoint.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request.body) }),
                              timeout,
                            ]);
                          } catch { failedRequests += 1; return; }
                          if (!response) { sawTimeout = true; return; }
                          if (signal.aborted) return;
                          if (!response.ok) { failedRequests += 1; return; }
                          try {
                            const parsed = parseDenseJevResponse(response.status, response.ok, response.text);
                            const scores = parseDenseJevAnswers(parsed.answers, request.keys);
                            answered += scores.size;
                            units += parsed.usage?.input_tokens ?? 0;
                            for (const [key, score] of scores) denseJevScores?.set(key, score);
                          } catch {
                            // A malformed or non-Noul response contributes no scores; other requests remain usable.
                          }
                        } finally { timer?.cancel(); }
                      };
                      const worker = async (): Promise<void> => {
                        while (!signal.aborted && nextRequest < requests.length) await runRequest(requests[nextRequest++]);
                      };
                      await Promise.all(Array.from({ length: Math.min(8, requests.length) }, () => worker()));
                      const finishedAt = await $.clock.now();
                      wall = firstSendAt === undefined ? 0 : Math.max(0, finishedAt - firstSendAt);
                      if (requestCount === 0 && signal.aborted) sawTimeout = true;
                      status = answered === asked && asked > 0 ? 'ok' : answered > 0 ? 'partial' : sawTimeout ? 'timeout' : failedRequests > 0 ? 'error' : 'partial';
                      if (status !== 'ok' && denseJevScores.size === 0) denseJevScores = undefined;
                    }
                  }
                }
              }
            } catch {
              status = 'error';
              denseJevScores = undefined;
              try { wall = Math.max(0, (await $.clock.now()) - startedLogAt); } catch { wall = 0; }
            }
            if (status === 'skipped') try { wall = Math.max(0, (await $.clock.now()) - startedLogAt); } catch { wall = 0; }
            try { notice(`dense.jev=${status} dense.jev_requests=${requestCount} dense.jev_answered=${answered}/${asked} dense.jev_units=${units} dense.jev_ms=${wall}${skipped ? ` dense.jev_skipped=${skipped}` : ''}`); }
            catch { denseJevScores = undefined; }
          }
          const denseAt = (budgetTokens: number): string => renderDense(selectDense(denseCandidatePool, denseCoveredText, budgetTokens, countTokens, denseJevScores));
          let denseBudgetTokens = budgets.dense + spillTokens;
          const denseBody = denseNotesEnabled ? denseAt(denseBudgetTokens) : '';
          await yieldTick();
          // Key facts (spec v3.3 §3.1.3, round 17, brief-s4a-fix17.md): a single filter pass over
          // `latest.values()` for BOTH source kinds together, not `[...userRecords, ...fileWrites]`
          // concatenated as two separate lists -- that would break true chronological interleaving
          // between a `user` record and a `file_write` record (`extractKeyFacts`'s own `seq` and
          // its chronological-overflow rule both depend on receiving one true time order). "Seed of
          // seed" (brief item 1): a fact captured before compaction #1 is still in this same
          // `latest` map at compaction #3, because `host/fs-adapter.ts`'s capture store never
          // prunes old segments (every compaction re-reads the whole accumulated history above);
          // no extra persistence code is needed here for that requirement.
          const factSourceRecords = [...latest.values()].filter((record) => record.kind === 'file_write' || (record.kind === 'user' && !['question', 'chat'].includes(labelsByRecord.get(record) ?? '')));
          // Round 18 (brief-s4a-fix18.md F6, review-opus-r17.md finding F6): a long-lived
          // session's accumulated `user`/`file_write` history is this store's own size, not this
          // handler's control, same reasoning as the segment-read loop above -- `extractKeyFacts`
          // itself never yields (it stays a plain synchronous function, unaffected, for every
          // existing caller and test), so this uses `extractKeyFactsChunked`'s own generator-driven
          // chunking instead, awaiting a real macrotask between chunks. `$` spelled directly
          // (`$.clock.sleep(...)`, via this same closure's own `yieldTick`), never forwarded into
          // `core/key-facts.ts` itself, per the dollar-spelling rule.
          const keyFacts = await extractKeyFactsChunked(factSourceRecords, sha256, yieldTick);
          const keyFactsOverflow = applyKeyFactsOverflow(keyFacts, countTokens, sha256, KEY_FACTS_BUDGET_TOKENS);
          if (keyFactsOverflow.omittedCount > 0) notice(`seed.facts_omitted=${keyFactsOverflow.omittedCount}`);
          const keyFactsBody = renderKeyFactsSection(keyFactsOverflow.rendered);
          await yieldTick();
          // Constraints and key facts are mandatory and filled first (spec §3.1.1, §3.1.3):
          // selector D and J compete for whatever is left of the 6k seed budget, not the full
          // amount.
          const reasoningBudgetTokens = Math.max(0, baseBudgets.seed - countTokens(constraintsBody) - countTokens(keyFactsBody));
          const reasoning = [...latest.values()].filter((record) => record.kind === 'assistant_text');
          const reasoningCandidates = reasoning.map((record, index) => ({ id: String(index), tokens: countTokens(String(record.body.text ?? '')), alwaysKeep: false, valueDensity: 1, recency: index, text: String(record.body.text ?? '') }));
          const selectQuery = { contract: String(options.contract ?? ''), todo: todos, lastUserMessages: userHistory.slice(-3) };
          // Selector J privacy rule (spec v3.4 §3.3/§privacy): off by default, per-project
          // opt-in, deny list for client repos. `jevAllowed` is checked before any Jev call is
          // even attempted; when it is false, or no API key is configured, this falls straight
          // back to selector D with no network access and no M7 cost.
          const jevEnabled = optionBoolean(options, 'jevEnabled', false);
          const jevDenyList = optionString(options, 'jevDenyList', '').split(',').map((entry) => entry.trim()).filter(Boolean);
          const jevAllowed = await jevEgressAllowed(flagHost, jevEnabled, jevDenyList);
          // B2/F6 (review-opus-s4b.md): the M7 line's key names must never contain "token", "key"
          // or "secret" (commit 1f373a78 redacts any log value whose key contains "token"), and it
          // must be emitted on every path this handler can take through the J decision, not only
          // when a real Jev call happened -- disabled, denied, no key, a genuine throw, and an
          // outer withFallback timeout all still log it, with jev_units=0 wherever nothing was
          // sent. `logJevUnits` is the one place that spells the line, so every path agrees on its
          // exact shape.
          const logJevUnits = (units: number, fallbackCount: number): void => {
            notice(`compact.jev_units=${units} compact.jev_fallback=${fallbackCount}`);
          };
          // F4: one decision log line per distinct Jev call (grouped by the call's own sha256, the
          // same hash `core/select-j.ts` puts on every decision that call produced), holding only
          // counts and the hash, never span text. Written with `$.ui.log`, the same channel M7
          // already uses and the harness already reads.
          const logJevDecisions = (decisions: readonly JevDecisionLogEntry[]): void => {
            const bySha = new Map<string, { spans: number; keep: number; pointer: number; drop: number; model: string }>();
            for (const entry of decisions) {
              if (entry.source !== 'jev') continue;
              const counts = bySha.get(entry.sha256) ?? { spans: 0, keep: 0, pointer: 0, drop: 0, model: entry.model ?? 'unknown' };
              counts.spans += 1;
              if (entry.decision === 'keep_verbatim') counts.keep += 1;
              else if (entry.decision === 'pointer') counts.pointer += 1;
              else counts.drop += 1;
              bySha.set(entry.sha256, counts);
            }
            // jev-live-smoke-20260926.md finding 2: logs the concrete model Jev actually answered
            // with (e.g. "jev-1.13.0"), alongside the call's own sha256, never the requested alias.
            for (const [sha, counts] of bySha) {
              notice(`compact.jev_decision_sha=${sha} compact.jev_decision_model=${counts.model} compact.jev_decision_spans=${counts.spans} compact.jev_decision_keep=${counts.keep} compact.jev_decision_pointer=${counts.pointer} compact.jev_decision_drop=${counts.drop}`);
            }
          };
          let selectedIds: Set<string>;
          // F5: `pointer` renders as a one-line pointer, distinct from `drop`'s nothing. `null`
          // here means "no Jev decisions exist for this run" (J never ran), so the D-only render
          // path below never looks for pointers, exactly matching D's own contract (D has no
          // pointer concept, only keep or drop).
          let jevDecisionById: Map<string, JevDecisionLogEntry> | null = null;
          // B2 (review-opus-s4b-r2.md): the ids whose pointer decision actually earned a slot in
          // the shared budget (see core/select-j.ts's own fill loop). A pointer decision NOT in
          // this set lost the competition for budget and renders as nothing, the same as a drop,
          // rather than unconditionally, which used to push out the newest kept reasoning.
          let jevPointerIds: Set<string> | null = null;
          if (denseNotesEnabled) {
            logJevUnits(0, 0);
            notice('compact.jev_skipped=dense_notes');
            selectedIds = new Set();
          } else if (!jevEnabled || !jevAllowed) {
            logJevUnits(0, 0);
            notice(`compact.jev_skipped=${!jevEnabled ? 'disabled' : 'deny_list'}`);
            selectedIds = new Set(select(reasoningCandidates, selectQuery, reasoningBudgetTokens));
          } else {
            try {
              const jevEndpoint = await getJevEndpoint(envLike);
              if (typeof jevEndpoint === 'string') {
                logJevUnits(0, 0);
                notice(`compact.jev_skipped=${jevEndpoint === 'bad_url' ? 'bad_jev_url' : 'no_api_key'}`);
                selectedIds = new Set(select(reasoningCandidates, selectQuery, reasoningBudgetTokens));
              } else {
                const jevModel = optionString(options, 'jevModel', 'jev-latest');
                const jevResult = await selectJ(reasoningCandidates, selectQuery, reasoningBudgetTokens, {
                  ask: makeJevAsk(httpLike, jevEndpoint.key, jevModel, jevEndpoint.url),
                  hash: sha256,
                  countTokens,
                  sleep: (ms, jevSignal) => $.clock.sleep(ms, { signal: jevSignal }),
                  nowMs: () => $.clock.now(),
                  model: jevModel,
                  criteria: defaultJevCriteria(),
                  perCallTimeoutMs: optionNumber(options, 'jevPerCallTimeoutMs', JEV_PER_CALL_TIMEOUT_MS),
                  totalBudgetMs: optionNumber(options, 'jevTotalBudgetMs', JEV_TOTAL_BUDGET_MS),
                  maxBatchTokens: JEV_BATCH_MAX_TOKENS,
                  // F1: the outer withFallback race's own abort signal, so selectJ starts no new
                  // batch once this attempt has already lost the race.
                  signal,
                });
                selectedIds = new Set(jevResult.ids);
                jevDecisionById = new Map(jevResult.decisions.map((entry) => [entry.id, entry]));
                jevPointerIds = new Set(jevResult.pointerIds);
                // M7 (spec v3.4 §5): estimated input units sent to Jev and the fallback count,
                // logged so an external harness can read the A-J arm's own cost without parsing
                // the returned messages.
                logJevUnits(jevResult.jevTokens, jevResult.fallbackCount);
                logJevDecisions(jevResult.decisions);
                // brief-s4b-fix4.md item 3: selectJ can complete normally (no throw, the M7 line
                // above still fires) and yet have made zero real Jev calls this run -- every span
                // individually oversized, the capped query itself leaving no room for even one
                // question, the outer signal already aborted, the 10s total budget already spent,
                // or nothing to ask about at all. Without this line that state was indistinguishable
                // in the log from a run that made calls and simply got every span back as a
                // fallback. `jevResult.skippedReason`'s own string values already match this line's
                // contract vocabulary (oversized_all, budget_exhausted, aborted, query_too_large)
                // with no translation needed.
                //
                // review-opus-s4b-fix4.md F5: `no_candidates` is not a skip -- D and J produce the
                // identical result when there is nothing to select from, so treating it as
                // `jev_skipped` wrongly invalidates an otherwise-healthy A-J chain in the harness.
                // This logs `compact.jev_candidates=0` instead, distinct from the `jev_skipped`
                // vocabulary entirely.
                if (jevResult.skippedReason === 'no_candidates') notice('compact.jev_candidates=0');
                else if (jevResult.skippedReason) notice(`compact.jev_skipped=${jevResult.skippedReason}`);
              }
            } catch (jevError) {
              // F6: a genuine throw (the key read or selectJ itself) still falls back to D for
              // every reasoning candidate; the M7 line still reports that no units were sent and
              // every candidate fell back.
              logJevUnits(0, reasoningCandidates.length);
              notice('compact.jev_skipped=error');
              // brief-s4b-fix4.md item 4: only the error's constructor name is ever logged, never
              // its message or stack -- a genuine throw here can carry arbitrary session content
              // (a malformed response body, a rejected fetch's own error text), and this log line
              // is read by an external harness, not a private debug channel.
              const rawErrorClassName = jevError instanceof Object && jevError.constructor && typeof jevError.constructor.name === 'string' ? jevError.constructor.name : 'Unknown';
              // review-opus-s4b-fix4.md F6: a code-thrown Error subclass always has a fixed
              // identifier name, but a thrown plain object (or anything built from parsed data)
              // can carry an arbitrary `constructor.name` string. Only a plain-identifier shape is
              // ever logged verbatim; anything else collapses to 'Unknown' so this line can never
              // become an exfiltration channel.
              const errorClassName = /^[A-Za-z_$][\w$]{0,63}$/.test(rawErrorClassName) ? rawErrorClassName : 'Unknown';
              notice(`compact.jev_error_class=${errorClassName}`);
              selectedIds = new Set(select(reasoningCandidates, selectQuery, reasoningBudgetTokens));
            }
          }
          const selectedReasoning = reasoning
            .map((record, index) => {
              const id = String(index);
              const decision = jevDecisionById?.get(id);
              if (decision?.decision === 'pointer') {
                // B2: a pointer decision that did not fit the shared budget renders as nothing,
                // same as a drop, rather than unconditionally; and the rendered sha is the span's
                // own content hash at render time, not the batch's shared call hash (decision.
                // sha256), so two pointers from the same batch print two different, individually
                // resolvable shas.
                if (!jevPointerIds?.has(id)) return undefined;
                return renderJevPointer(id, sha256(String(record.body.text ?? '')));
              }
              if (decision?.decision === 'drop') return undefined;
              if (!selectedIds.has(id)) return undefined;
              // S4j: a reply's own `#`/`##` headings would read as new seed sections ("## Plan"
              // after "## Earlier assistant notes"), so they are demoted to `###`.
              return demoteHeadings(String(record.body.text ?? ''));
            })
            .filter((line): line is string => line !== undefined)
            .join('\n');
          await yieldTick();
          // S4d full-transcript pointer (spec §3.1.2): `runLogTranscriptPath` is always `null`
          // here (CONTRACT.md's S4d section records the finding: no run-log record body anywhere
          // in `exovault-hook.cjs`/`rotation.cjs` carries a bare `transcript_path` field), so this
          // always falls through to the derived path; rendered only if that file exists now.
          // The transcript file never moves during a session, so a path found once (possibly by the
          // project-dir scan) is reused; it is re-checked, and dropped if it stopped existing.
          const cachedPath = transcriptPathCache.get(sessionId);
          const foundPath = cachedPath !== undefined && (await transcriptExists(cachedPath).catch(() => false))
            ? cachedPath
            : await findTranscriptPath(transcriptPathHost, sessionId, { exists: transcriptExists, list: (path) => $.fs.list(path) });
          if (foundPath) transcriptPathCache.set(sessionId, foundPath); else transcriptPathCache.delete(sessionId);
          const transcriptPath = resolveTranscriptPath(null, foundPath);
          const transcriptFileExists = transcriptPath !== null;
          // The harness/userConfig names the plugin dir explicitly: a function hook's process env
          // carries no per-plugin CLAUDE_PLUGIN_ROOT, so the env var is only a fallback.
          const configuredRecallRoot = optionString(options, 'recallPluginRoot', '');
          const recallPluginRoot = recallEnabled ? (configuredRecallRoot || (await $.env.get('CLAUDE_PLUGIN_ROOT'))) : undefined;
          if (recallEnabled && !recallPluginRoot) notice('recall.build_started=0 reason=no_plugin_root');
          if (!transcriptFileExists) notice('seed.transcript_pointer=missing');
          const transcriptPointer = transcriptFileExists && transcriptPath
            ? renderTranscriptPointer(transcriptPath, recallEnabled ? { sessionId } : undefined)
            : undefined;
          if (recallEnabled && recallPluginRoot && transcriptFileExists && transcriptPath) {
            const recallRoot = `${(await homeDir()) ?? '.'}/.claude/exovault/recall`;
            const launcher = `${recallPluginRoot}/recall/launch.mjs`;
            // Start the short launcher without awaiting it. It snapshots the transcript cutoff and
            // starts the indexing worker detached; neither the hook nor its worker heartbeat waits
            // for transcript parsing or ranking work.
            void $.process.run(['node', launcher, transcriptPath, recallRoot, sessionId, recallVectorsEnabled ? 'vectors' : 'lexical', 'cut', retentionDays(options)], { timeoutMs: 5000 })
              .then((started) => { notice(started.exitCode === 0 ? 'recall.build_started=1' : 'recall.build_started=0'); })
              .catch(() => { notice('recall.build_started=0'); });
          }
          // The session map comes from timeline.json, which the recall build worker writes next to the index after
          // every build (per turn and at each cut), so it covers the session up to the last build.
          let sessionMapBody = '';
          if (recallEnabled && optionBoolean(options, 'sessionMap', true)) {
            try {
              const timelinePath = `${(await homeDir()) ?? '.'}/.claude/exovault/recall/${sha256(sessionId)}/timeline.json`;
              if (await $.fs.exists(timelinePath)) {
                const timeline = JSON.parse(await $.fs.read(timelinePath)) as { segments?: SessionSegment[] };
                sessionMapBody = Array.isArray(timeline.segments) ? renderSessionMap(timeline.segments, countTokens) : '';
              }
              notice(`seed.session_map_size=${countTokens(sessionMapBody)}`);
            } catch { sessionMapBody = ''; notice('seed.session_map=error'); }
          }
          // 3.31.0 (CONTRACT S4ze): the task brief section, from the files the prompt hook saved (core/briefs.ts).
          let taskBriefsBody = '';
          let renderBriefAt: ((budgetTokens: number) => string) | undefined;
          // With a card the brief keeps only its path lines: the card carries what the seed needs of it.
          let briefBudgetTokens = cardOn ? 0 : baseBriefTokens + briefShift;
          if (briefsDir !== undefined) {
            try {
              const indexPath = `${briefsDir}/briefs.json`;
              let entries = (await $.fs.exists(indexPath)) ? parseBriefIndex(await $.fs.read(indexPath)) : [];
              let missedHead: string | undefined;
              // No index yet: the prompt hook missed the brief (sent before the plugin loaded). The detached save
              // writes the file at the path brief.mjs derives (sha256 of the text); this seed points at it and shows
              // its start, and the checklist is ready for a later cut. The hook never waits for a process.
              if (!entries.length && recallPluginRoot) {
                const missed = userRecords.map((record) => briefText(String(record.body.text ?? ''))).filter((text): text is string => text !== undefined && text.length >= BRIEF_MIN_CHARS);
                const newestMissed = missed[missed.length - 1];
                if (newestMissed !== undefined) {
                  void $.process.run(['node', `${recallPluginRoot}/recall/brief.mjs`, 'save', `${(await homeDir()) ?? '.'}/.claude/exovault/recall`, sessionId, checklistModel(options)], { stdin: newestMissed, timeoutMs: 5000 })
                    .catch(() => { notice('brief.saved=0 origin=cut'); });
                  const id = sha256(newestMissed).slice(0, 12);
                  entries = [{ id, path: `${briefsDir}/${id}.md`, chars: newestMissed.length, at: new Date(await $.clock.now()).toISOString(), firstLine: newestMissed.split('\n').map((line) => line.trim()).find(Boolean) ?? '' }];
                  missedHead = newestMissed.slice(0, BRIEF_HEAD_CHARS);
                }
              }
              const newest = entries[entries.length - 1];
              if (newest !== undefined) {
                const digestPath = newest.path.replace(/\.md$/, '.digest.md');
                const digest = missedHead === undefined && (await $.fs.exists(digestPath)) ? await $.fs.read(digestPath) : undefined;
                // With a card the seed keeps the brief's path lines only, not its first lines verbatim.
                const head = cardOn ? undefined : missedHead ?? (digest === undefined && (await $.fs.exists(newest.path)) ? (await $.fs.read(newest.path)).slice(0, BRIEF_HEAD_CHARS) : undefined);
                const full = fullBrief !== undefined && fullBrief.path === newest.path ? fullBrief.text : undefined;
                renderBriefAt = (budgetTokens) => renderTaskBriefs(entries, { digest, head, digestPath, sessionId, full }, countTokens, budgetTokens);
                taskBriefsBody = renderBriefAt(briefBudgetTokens);
                briefCheckArmed = optionBoolean(options, 'briefCheck', false);
                briefPushArmed = optionBoolean(options, 'briefPush', false);
                notice(`seed.task_brief_size=${countTokens(taskBriefsBody)} seed.task_brief_digest=${digest !== undefined ? 'ready' : checklistModel(options) ? 'pending' : 'off'} seed.task_brief_whole=${full !== undefined && taskBriefsBody.includes('<task-brief>') ? 1 : 0}`);
              }
            } catch { taskBriefsBody = ''; notice('seed.task_brief=error'); }
          }
          await yieldTick();
          const cardCapTokens = Math.min(TASK_CARD_MAX_TOKENS, Math.round(baseBudgets.seed * 0.6));
          const taskCardBody = taskCardText === undefined ? '' : renderCardSection(taskCardText, cardPath, countTokens, cardCapTokens);
          if (taskCardEnabled) notice(`seed.task_card=${taskCardText === undefined ? 0 : 1} seed.task_card_size=${countTokens(taskCardBody)}`);
          // 4.6.0 (CONTRACT S5f, core/since-card.ts): the steps between the card's horizon and the kept tail, one line each.
          let sinceSteps: SinceCardSteps | undefined;
          let sinceCardBody = '';
          let sinceListed = 0;
          let sinceHorizon: SinceCardHorizon | 'off' = 'off';
          if (taskCardBody && optionBoolean(options, 'sinceCard', true)) {
            try {
              const horizonPath = `${baseDir}/${TASK_CARD_HORIZON_FILE}`;
              const horizonId = (await $.fs.exists(horizonPath)) ? parseCardHorizon(await $.fs.read(horizonPath)) : undefined;
              const tailToolUseIds = new Set(tail.messages.flatMap((message) => message.toolUses.map((toolUse) => toolUse.tool_use_id)));
              sinceSteps = collectSinceCard(event.messages as unknown as SessionMessage[], horizonId, tailToolUseIds);
              sinceHorizon = sinceSteps.horizon;
              ({ body: sinceCardBody, listed: sinceListed } = renderSinceCard(sinceSteps, SINCE_CARD_BUDGET_TOKENS, countTokens));
            } catch { sinceSteps = undefined; sinceCardBody = ''; sinceListed = 0; sinceHorizon = 'missing'; notice('seed.since_card=error'); }
          }
          // 4.7.0 (CONTRACT S5j, core/late-card.ts): with `lateCardRefresh` the card says how many tool calls came after it,
          // unless the "Since the card" section above already lists them.
          let cardAge = '';
          if (taskCardBody && optionBoolean(options, 'lateCardRefresh', false)) {
            try {
              let ageSteps = sinceSteps;
              if (ageSteps === undefined) {
                const horizonPath = `${baseDir}/${TASK_CARD_HORIZON_FILE}`;
                const horizonId = (await $.fs.exists(horizonPath)) ? parseCardHorizon(await $.fs.read(horizonPath)) : undefined;
                ageSteps = collectSinceCard(event.messages as unknown as SessionMessage[], horizonId, new Set(tail.messages.flatMap((message) => message.toolUses.map((toolUse) => toolUse.tool_use_id))));
              }
              cardAge = cardAgeLine(ageSteps, sinceCardBody !== '');
            } catch { cardAge = ''; }
          }
          const withCardAge = (section: string): string => (cardAge ? `${section}\n${cardAge}` : section);
          // 4.7.0 (CONTRACT S5k, core/recipes.ts): with `recipes` the commands that worked earlier, no model call.
          const recipesOn = optionBoolean(options, 'recipes', true);
          let recipeList: Recipe[] = [];
          let recipesBody = '';
          if (recipesOn) {
            try {
              const tailIds = new Set(tail.messages.flatMap((message) => message.toolUses.map((toolUse) => toolUse.tool_use_id)));
              recipeList = collectRecipes(event.messages as unknown as SessionMessage[], tailIds, { sessionCwd: String(await $.session.cwd()), outputText: toolOutputNotesEnabled });
              recipesBody = renderRecipes(recipeList, RECIPES_BUDGET_TOKENS, countTokens);
            } catch { recipeList = []; recipesBody = ''; notice('seed.recipes=error'); }
          }
          let seedSections: SeedSections = { constraints: constraintsBody, ...(taskCardBody ? { taskCard: withCardAge(taskCardBody) } : {}), ...(sinceCardBody ? { sinceCard: sinceCardBody } : {}), ...(taskBriefsBody ? { taskBriefs: taskBriefsBody } : {}), ...(workStateBody ? { workState: workStateBody } : {}), ...(sessionMapBody ? { sessionMap: sessionMapBody } : {}), ...(currentValuesBody ? { currentValues: currentValuesBody } : {}), ...(denseNotesEnabled ? { denseNotes: denseBody } : { keyFacts: keyFactsBody }), compactionPressure, contract: String(options.contract ?? ''), todo: todos, ...historyForSeed(userHistory), values, selectedReasoning: denseNotesEnabled ? '' : selectedReasoning, gatesAndErrors: renderGatesAndErrors([...latest.values()]), filePointers: [...[...latest.values()].filter((record) => record.kind === 'file').map((record) => JSON.stringify(record.body)), ...collectFilePointers(event.messages as unknown as SessionMessage[])].join('\n'), transcriptPointer, ...(event.instructions !== undefined ? { compactInstructions: event.instructions } : {}) };
          if (recipesBody) seedSections = { ...seedSections, recipes: recipesBody };
          let rendered = renderSeed(seedSections, tail.omittedCount, seedBudgetTokens, countTokens);
          // 3.32.1 (CONTRACT S4zf): never-reduced sections can sum past the budget (t3: dense notes plus a full brief
          // checklist), which threw `budget` and handed 3 of 7 cuts to native compaction. The brief shrinks to fit;
          // at worst it keeps only its path lines.
          const tailTokensForBudget = serializedTokens(tail.messages, countTokens);
          // 3.47.0 (CONTRACT S4zu): with the card the working notes shrink first (they are picked from the history the
          // card and the index already cover), down to none, before the brief path lines and the adopted rules.
          // 3.55.0: so do they ahead of a whole brief, the current task's specification (w60o: the brief went whole
          // and the shrink below cut it back to its pointer on all four stale-card cuts).
          const briefWhole = fullBrief !== undefined && taskBriefsBody.includes('<task-brief>');
          for (let attempt = 0; (cardOn || briefWhole) && denseBody && attempt < 3 && !checkBudget(rendered.tokens, tailTokensForBudget, budgets).ok; attempt += 1) {
            const over = Math.max(rendered.tokens - seedBudgetTokens, rendered.tokens + tailTokensForBudget - budgets.total, 0);
            denseBudgetTokens = attempt === 2 ? 0 : Math.max(0, denseBudgetTokens - over - 100);
            seedSections = { ...seedSections, denseNotes: denseAt(denseBudgetTokens) };
            rendered = renderSeed(seedSections, tail.omittedCount, seedBudgetTokens, countTokens);
            notice(`seed.dense_shrunk=${denseBudgetTokens}`);
          }
          // 4.7.1 (S5k): the recipes give way after the working notes (down to none) and before the brief, the card and the rules.
          // 4.7.0 cut them first, so in a cut that was over budget they never reached the model.
          if (recipesBody && !checkBudget(rendered.tokens, tailTokensForBudget, budgets).ok) {
            const over = Math.max(rendered.tokens - seedBudgetTokens, rendered.tokens + tailTokensForBudget - budgets.total, 0);
            const recipesTokens = Math.max(0, countTokens(recipesBody) - over - 20);
            recipesBody = renderRecipes(recipeList, recipesTokens, countTokens);
            const { recipes: _shrunk, ...withoutRecipes } = seedSections;
            seedSections = recipesBody ? { ...withoutRecipes, recipes: recipesBody } : withoutRecipes;
            rendered = renderSeed(seedSections, tail.omittedCount, seedBudgetTokens, countTokens);
            notice(`seed.recipes_shrunk=${recipesTokens}`);
            if (!recipesBody) notice('seed.recipes_dropped=1');
          }
          for (let attempt = 0; renderBriefAt !== undefined && attempt < 4 && !checkBudget(rendered.tokens, tailTokensForBudget, budgets).ok; attempt += 1) {
            const over = Math.max(rendered.tokens - seedBudgetTokens, rendered.tokens + tailTokensForBudget - budgets.total, 0);
            briefBudgetTokens = attempt === 3 ? 0 : Math.max(0, briefBudgetTokens - over - 100);
            seedSections = { ...seedSections, taskBriefs: renderBriefAt(briefBudgetTokens) };
            rendered = renderSeed(seedSections, tail.omittedCount, seedBudgetTokens, countTokens);
            notice(`seed.task_brief_shrunk=${briefBudgetTokens}`);
          }
          // 4.6.0 (S5f): the since-card section gives way before the card does (after the working notes and the brief, which
          // are the usual slack: shrinking it first emptied it on every replayed cut), but only down to its newest
          // SINCE_CARD_KEEP step lines (it holds the newest information; the card's older tail lines go first). If the card
          // has given what it can (below) and the seed is still over, it shrinks on to its two sentences and the left-out
          // line, and is dropped only after that, so its floors are the old ones and it adds no budget fallback the seed
          // without it did not have.
          const shrinkSince = (minKept: number): void => {
            const over = Math.max(rendered.tokens - seedBudgetTokens, rendered.tokens + tailTokensForBudget - budgets.total, 0);
            const sinceTokens = Math.max(0, countTokens(sinceCardBody) - over - 50);
            const shrunk = renderSinceCard(sinceSteps!, sinceTokens, countTokens, minKept);
            seedSections = { ...seedSections, sinceCard: shrunk.body };
            sinceCardBody = shrunk.body;
            sinceListed = shrunk.listed;
            rendered = renderSeed(seedSections, tail.omittedCount, seedBudgetTokens, countTokens);
            notice(`seed.since_card_shrunk=${sinceTokens}`);
          };
          if (sinceSteps !== undefined && sinceCardBody && !checkBudget(rendered.tokens, tailTokensForBudget, budgets).ok) shrinkSince(SINCE_CARD_KEEP);
          // Then the card's own tail lines, by at most half its cap (w17 w60g replay: one cut 154 tokens over with the
          // notes and the brief already at their floor).
          if (taskCardText !== undefined && !checkBudget(rendered.tokens, tailTokensForBudget, budgets).ok) {
            const over = Math.max(rendered.tokens - seedBudgetTokens, rendered.tokens + tailTokensForBudget - budgets.total, 0);
            const cardTokens = Math.max(Math.round(cardCapTokens / 2), countTokens(taskCardBody) - over - 50);
            seedSections = { ...seedSections, taskCard: withCardAge(renderCardSection(taskCardText, cardPath, countTokens, cardTokens)) };
            rendered = renderSeed(seedSections, tail.omittedCount, seedBudgetTokens, countTokens);
            notice(`seed.task_card_shrunk=${cardTokens}`);
          }
          if (sinceSteps !== undefined && sinceCardBody && !checkBudget(rendered.tokens, tailTokensForBudget, budgets).ok) shrinkSince(0);
          if (sinceCardBody && !checkBudget(rendered.tokens, tailTokensForBudget, budgets).ok) {
            const { sinceCard: _dropped, ...withoutSince } = seedSections;
            seedSections = withoutSince;
            sinceCardBody = '';
            sinceListed = 0;
            rendered = renderSeed(seedSections, tail.omittedCount, seedBudgetTokens, countTokens);
            notice('seed.since_card_dropped=1');
          }
          // 3.34.0: last, adopted rules files, to half their budget and at last to their headers and copy paths.
          // 3.57.0: after the card, not before it. The user's own rules file is what the card's Rules section paraphrases
          // and trims (w17 w61e: every card cut quoted the house rules as a path only and the card kept 2 of its 10 Rules
          // lines, so the r3 and r2 reports lost the `SLICE <id> DONE` header).
          for (const adoptedBudget of adoptedFiles.length ? [Math.floor(adoptedBudgetTokens / 2), 0] : []) {
            if (checkBudget(rendered.tokens, tailTokensForBudget, budgets).ok) break;
            seedSections = { ...seedSections, constraints: constraintsAt(adoptedBudget) };
            rendered = renderSeed(seedSections, tail.omittedCount, seedBudgetTokens, countTokens);
            notice(`seed.adopted_shrunk=${adoptedBudget}`);
          }
          // 4.6.0: a seed still over its budget after every shrink above takes the missing tokens from the kept tail (down to
          // the brief floor) before the cut falls back to the native summary (w65b: seed 5289/5000, tail 7082/7082).
          if (rendered.tokens > seedBudgetTokens) {
            const keptTokens = serializedTokens(tail.messages, countTokens);
            const over = Math.max(rendered.tokens - seedBudgetTokens, rendered.tokens + keptTokens - budgets.total);
            if (keptTokens - over >= Math.round(baseBudgets.tail * BRIEF_MIN_TAIL_SHARE)) {
              const smaller = pickTail(event.messages, { budgetTokens: keptTokens - over, countTokens, hash: sha256, rebuildThresholdTokens: REBUILD_THRESHOLD_TOKENS, trigger: event.trigger });
              const smallerTokens = serializedTokens(smaller.messages, countTokens);
              if (smallerTokens <= keptTokens - over) {
                tail = smaller;
                budgets = { ...budgets, seed: budgets.seed + budgets.tail - (keptTokens - over), tail: keptTokens - over };
                seedBudgetTokens = budgets.seed + tailSpillTokens(smallerTokens, budgets.tail);
                rendered = renderSeed(seedSections, tail.omittedCount, seedBudgetTokens, countTokens);
                notice(`seed.tail_shrunk_for_seed=${over}`);
              }
            }
          }
          if (recipesOn) notice(`seed.recipes=${recipesBody ? recipesBody.split('\n').filter((line) => line.startsWith('- ')).length : 0} seed.recipes_size=${recipesBody ? countTokens(recipesBody) : 0}`);
          notice(`seed.since_card=${sinceListed} seed.since_card_size=${sinceCardBody ? countTokens(sinceCardBody) : 0} seed.since_card_horizon=${sinceHorizon}`);
          if (briefWhole) notice(`seed.task_brief_kept_whole=${String(seedSections.taskBriefs ?? '').includes('<task-brief>') ? 1 : 0}`);
          // S4g: expand short ids the model will still see (seed + kept tail) to the full ids found
          // anywhere in the pre-cut messages, including a previous seed's own IDs section.
          // Full ids come from raw tool results, so each line is redacted like captured text. After
          // the second render the reduction may have dropped the text that quoted a short id; the
          // lines are recomputed on that render and only the ones still quoted are kept (one extra
          // render, no loop).
          const tailText = tail.messages.map((message) => JSON.stringify(message)).join('\n');
          const fullIds = collectFullIds(event.messages.map((message) => JSON.stringify(message)));
          const idLines = expandShortIds(`${rendered.message.text}\n${tailText}`, fullIds).map((line) => redactCapturedText(line)).filter((line) => !line.includes('[redacted]'));
          if (idLines.length) {
            const withIds = renderSeed({ ...seedSections, ids: idLines.join('\n') }, tail.omittedCount, seedBudgetTokens, countTokens);
            const idsHeading = withIds.message.text.lastIndexOf('\n## IDs (short = full)\n');
            const stillQuoted = new Set(expandShortIds(`${idsHeading === -1 ? withIds.message.text : withIds.message.text.slice(0, idsHeading)}\n${tailText}`, fullIds));
            const keptLines = idLines.filter((line) => stillQuoted.has(line));
            rendered = keptLines.length === idLines.length ? withIds : renderSeed({ ...seedSections, ...(keptLines.length ? { ids: keptLines.join('\n') } : {}) }, tail.omittedCount, seedBudgetTokens, countTokens);
            notice(`seed.ids_expanded=${keptLines.length}`);
          }
          const messages = [rendered.message, ...tail.messages];
          const tokensAfter = serializedTokens(messages, countTokens);
          const withinBudget = checkBudget(rendered.tokens, serializedTokens(tail.messages, countTokens), budgets).ok;
          if (!withinBudget) {
            notice(`seed.budget_over seed=${rendered.tokens}/${seedBudgetTokens} tail=${serializedTokens(tail.messages, countTokens)}/${budgets.tail} total=${budgets.total}`);
            throw new Error('budget');
          }
          // Round 8 findings 1/2: the watermark for next time must describe the list this
          // compaction is about to return, not the list it was reconciling from (event.messages
          // is discarded by core once this handler returns). Deriving it here, from `messages`
          // with the exact same rule `reconcile` uses to consume a watermark, guarantees the next
          // `turn.complete` finds this sequence intact at the position core actually kept it.
          const returnedIdentities = messages.map((message) => contentIdentity(message, sha256));
          const watermarkAfterCompaction = { identities: returnedIdentities.slice(-WATERMARK_SEQUENCE_LENGTH) };
          // Round 7 D7: losing the withFallback race does not stop this function; check the
          // signal before this write (records are already persisted above) so an orphaned run()
          // cannot move the watermark past core's own boundary after next() has already started
          // core compaction.
          if (signal.aborted) throw new Error('aborted');
          await store.appendRecords([], watermarkAfterCompaction, signal);
          try { await pressureStateFs.write(pressurePath, JSON.stringify(pressureStep.state)); }
          catch { notice('seed.compaction_pressure=state_unreadable'); }
          return { messages: messages as unknown as import('claude-code').SessionMessage[], tokensAfter };
        },
        next: async () => {
          const fellBack = await fallback();
          // Round 9 finding 3 (reviewer's fix, also closes should-fix 6): when core actually ran
          // and handed back `messages` (cc.d.ts SessionCompacted: "from core, its summary and the
          // messages it kept"), the boundary between core's summary and real content is exactly
          // this list's own tail, so deriving the watermark from it, with the same rule
          // `reconcile` uses to consume one, makes the next `turn.complete` start right after
          // core's own output. It never captures the summary as a `user` record (the not-found
          // heuristic in `reconcile` is only needed when core's result carries no watermark-usable
          // list at all, which does not happen here). No abort guard: `withFallback` calls `next`
          // only once, after its own race has already settled, so there is nothing to race here.
          const coreMessages = (fellBack as { messages?: readonly import('claude-code').SessionMessage[] } | undefined)?.messages;
          if (coreMessages && coreMessages.length) {
            const identities = coreMessages.map((message) => contentIdentity(message as unknown as SessionMessage, sha256));
            await store.appendRecords([], { identities: identities.slice(-WATERMARK_SEQUENCE_LENGTH) });
          }
          return { fallback: fellBack };
        },
        minReductionRatio: MIN_REDUCTION_RATIO,
        timeoutMs: optionNumber(options, 'timeoutMs', 30000),
        log: (line) => notice(line),
        tokensBefore,
        tokensAfterOf: (value) => value.tokensAfter ?? tokensBefore,
        sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
      });
      if (result.fallback) return result.fallback;
      // M7 (spec v3.4 §5): SessionCompacted (cc.d.ts:7198) is a closed shape with no room for
      // extra fields, so Jev units sent and fallback count are exposed only via the
      // `compact.jev_units=... compact.jev_fallback=...` log line above (B2: renamed from
      // `jev_tokens`, since the CC debug log redacts any value whose key contains "token", commit
      // 1f373a78; emitted on every J-configured path, F6), which is the brief's other explicit
      // option ("the handler result or log so the harness can read it").
      // 3.11.0 refusal guard: mark the cut fresh until the main loop's next answer, so only a
      // refusal of the cut's own first reply trips the guard. Best-effort, like pressure state.
      try { await $.fs.write(`${baseDir}/${FRESH_CUT_FILE}`, FRESH_CUT_OPEN); } catch { /* guard stays idle */ }
      // 3.37.0 (CONTRACT S4zj): the brief search runs detached now and leaves its lines in the flag file; the
      // main loop's first stop reads them (classic.Stop below). Not awaited, like every process the hook starts.
      if (briefCheckArmed) {
        const briefCheckPath = `${baseDir}/${BRIEF_CHECK_FILE}`;
        const briefCheckRoot = optionString(options, 'recallPluginRoot', '') || (await $.env.get('CLAUDE_PLUGIN_ROOT'));
        try {
          await $.fs.write(briefCheckPath, BRIEF_CHECK_ARMED);
          if (!briefCheckRoot) throw new Error('no plugin root');
          void $.process.run(['node', `${briefCheckRoot}/recall/brief-check.mjs`, `${(await homeDir()) ?? '.'}/.claude/exovault/recall`, sessionId], { timeoutMs: BRIEF_CHECK_TIMEOUT_MS })
            .then(async (ran) => {
              const found = ran.exitCode === 0 ? parseBriefCheck(String(ran.stdout)) : undefined;
              if ((await $.fs.read(briefCheckPath)).trim() !== BRIEF_CHECK_ARMED) return;
              await $.fs.write(briefCheckPath, found ? JSON.stringify(found) : BRIEF_CHECK_EMPTY);
              notice(`brief_check.ready=${found ? found.lines.length : 0}`);
            })
            .catch(() => { notice('brief_check.ready=error'); });
          notice('brief_check.armed=1');
        } catch { notice('brief_check.armed=0'); }
      }
      // 3.40.0 (CONTRACT S4zl): every cut starts the push afresh: what was shown before it was compacted away.
      if (briefPushArmed) {
        try { await $.fs.write(`${baseDir}/${BRIEF_PUSH_FILE}`, BRIEF_PUSH_ARMED); notice('brief_push.armed=1'); } catch { notice('brief_push.armed=0'); }
      }
      await notice.summary(formatCutSummary(tokensBefore, result.tokensAfter ?? tokensBefore, Number(await $.clock.now()) - cutStartedAt)).catch(() => undefined);
      return { messages: result.messages ?? [], tokensBefore, tokensAfter: result.tokensAfter };
    } catch (error) {
      // Round 9 finding 7: `fallback()` below is `next(input)`, i.e. core, so this is a genuine
      // "core ran" line; tagged `origin=compact` so lib.mjs's coreRan() can tell it apart from the
      // same `compact.fallback=` prefix logged by turn.complete (below) and trigger.ts, neither of
      // which means core ran.
      notice(`compact.fallback=${error instanceof Error && error.message === 'budget' ? 'budget' : 'error'} origin=compact`);
      return fallback();
    }
  }).catch(($, input, next) => {
    try { $.ui.log(`hook.caught=session.compact kind=${next.error.kind}`, { to: 'debug' }); } catch { /* debug logging cannot block compaction */ }
    return next(input);
  });
  on('turn.complete', async ($, event, next) => {
    const homeDir = () => resolveHomeDir({ home: () => $.env.get('HOME'), userProfile: () => $.env.get('USERPROFILE'), homeDrive: () => $.env.get('HOMEDRIVE'), homePath: () => $.env.get('HOMEPATH') });
    const notice = noticeLog({ emit: (...args: [string, { to: 'debug' }?]) => $.ui.log(...args), surfaces: () => $.session.surfaces(), entrypoint: () => $.env.get('CLAUDE_CODE_ENTRYPOINT'), childSession: () => $.env.get('CLAUDE_CODE_CHILD_SESSION'), briefChild: () => $.env.get('EXOVAULT_BRIEF_CHILD'), logFile: async () => { const noticeRoot = await findCaptureRoot({ cwd: () => $.session.cwd(), exists: (path: string) => $.fs.exists(path), root: () => $.session.root(), home: homeDir, inert: () => preflight.inert }); return noticeRoot === null ? undefined : `${capturePath(String(await $.session.id()), noticeRoot)}/notices.log`; }, read: (path: string) => $.fs.read(path), write: (path: string, text: string) => $.fs.write(path, text), now: () => $.clock.now() });
    let refusalGuardTripped = false;
    const result = await captureBeforeNext(async () => {
      // Round 11: same in-file closure convention as session.compact above; see that handler's
      // opening comment.
      const flagHost = { cwd: () => $.session.cwd(), exists: (path: string) => $.fs.exists(path), root: () => $.session.root(), home: homeDir, inert: () => preflight.inert };
      const captureRoot = await findCaptureRoot(flagHost);
      if (captureRoot === null || event.agentId) return;
      if (event.reason !== 'answer' && !isClassifierRefusal(event)) return;
      if (interactiveOnly && !(await attendedSession({ surfaces: () => $.session.surfaces(), entrypoint: () => $.env.get('CLAUDE_CODE_ENTRYPOINT'), childSession: () => $.env.get('CLAUDE_CODE_CHILD_SESSION'), briefChild: () => $.env.get('EXOVAULT_BRIEF_CHILD') }))) return;
      const guardDir = capturePath(String(await $.session.id()), captureRoot);
      const freshPath = `${guardDir}/${FRESH_CUT_FILE}`;
      let freshCut = false;
      try { freshCut = await $.fs.exists(freshPath) && (await $.fs.read(freshPath)).trim() === FRESH_CUT_OPEN; } catch { freshCut = false; }
      if (event.reason !== 'answer') {
        // 3.11.0 refusal guard: only a refusal before the main loop answered once since an S4 cut,
        // with that seed still in context, trips it. A later refusal is the conversation's own,
        // and one after a native cut or before any cut is not ours to act on. Written once.
        if (!freshCut) return;
        if (!hasLiveSeed(await $.session.messages() as unknown as SessionMessage[])) return;
        const guardPath = `${guardDir}/${REFUSAL_GUARD_FILE}`;
        if (await $.fs.exists(guardPath)) return;
        await $.fs.write(guardPath, renderRefusalGuardState(event, new Date(await $.clock.now()).toISOString()));
        notice(`compact.refusal_guard=tripped reason=${event.reason}`);
        refusalGuardTripped = true;
        return;
      }
      if (freshCut) {
        try { await $.fs.write(freshPath, FRESH_CUT_ANSWERED); } catch { /* guard stays armed: fails toward native only on a refusal */ }
      }
      // Round 7 D4: bound per-turn capture in a $.clock timeout so a long-tail reconcile (a
      // first capture over a resumed, long transcript) cannot stall the turn. A timeout skips
      // capture for this turn without advancing the watermark, logged distinctly from a real
      // capture error so the two are not confused in the log.
      const outcome = await withTimeout({
        run: async (signal) => {
          const fsLike = { read: (path: string) => $.fs.read(path), write: (path: string, text: string) => $.fs.write(path, text), list: (path?: string) => $.fs.list(path), exists: (path: string) => $.fs.exists(path) };
          const store = makeFsCaptureStore(fsLike, capturePath(String(await $.session.id()), captureRoot));
          const baseDir = capturePath(String(await $.session.id()), captureRoot);
          const watermark = await store.loadWatermark();
          const hostCwd = String(await $.session.cwd());
          const captured = reconcile(await $.session.messages() as unknown as SessionMessage[], watermark, { hash: sha256, toolOutputNotes: optionBoolean(options, 'toolOutputNotes', true) });
          const previousCwd = await latestCwdSnapshot(fsLike, baseDir);
          if (previousCwd?.path !== hostCwd) captured.records.push({ kind: 'work_event', origin: 'turn', producedBy: 's4-capture', sourceHash: `cwd:${sha256(`${previousCwd?.sourceHash ?? 'root'}:${hostCwd}`)}`, body: { type: 'cwd_snapshot', path: hostCwd } });
          // Round 15 (brief-s4a-fix15.md item 3): same macrotask-yield reasoning as
          // `session.compact` above -- reconcile's cost tracks this turn's message text (sha256
          // over every message), not this handler's own control, so yielding once before the
          // write keeps the heartbeat answerable without adding a real phase boundary of its own
          // (there is only the one write below). `$` spelled directly, same-file, per the
          // dollar-spelling gate.
          await $.clock.sleep(0, { signal });
          // Round 8 finding 9: withTimeout does not cancel an orphaned run() that lost the race;
          // it keeps executing after capture.timeout was already logged. Checking the signal
          // here, before the one write this attempt makes, stops it from landing concurrently
          // with the next turn's read-modify-write of the same segment or moving the watermark
          // backwards under it.
          if (signal.aborted) throw new Error('aborted');
          await store.appendRecords(captured.records.map((record) => ({ ...record, origin: 'turn' as const })), captured.watermark, signal);
          // 4.8.1: once a capture landed, its directory gets .exovault/.gitignore (one check per root per process).
          if (!gitignoredRoots.has(captureRoot) && !signal.aborted) { gitignoredRoots.add(captureRoot); await ensureCaptureGitignore(fsLike, captureRoot); }
        },
        timeoutMs: optionNumber(options, 'timeoutMs', 30000),
        sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
      });
      if (outcome.timedOut) notice('capture.timeout');
      if (optionBoolean(options, 'taskCard', true)) {
        void refreshTaskCard({ cwd: () => $.session.cwd(), root: () => $.session.root(), id: () => $.session.id(), exists: (path: string) => $.fs.exists(path), read: (path: string) => $.fs.read(path), write: (path: string, text: string) => $.fs.write(path, text), home: homeDir, inert: () => preflight.inert, usage: async (withWindow: boolean) => { const usage = await $.session.usage(withWindow ? { breakdown: 'summary' } : undefined); return { tokens: usage.context.tokens, window: usage.context.breakdown?.rawMaxTokens ?? usage.context.window }; }, fork: async (prompt: string) => forkReply(await $.model.fork({ prompt })), horizon: async () => lastToolUseId(await $.session.messages() as unknown as SessionMessage[]), late: optionBoolean(options, 'lateCardRefresh', false) ? { messages: async () => await $.session.messages() as unknown as SessionMessage[] } : undefined, now: async () => Number(await $.clock.now()), log: (line: string) => notice(line) });
      }
      // 3.25.0 (CONTRACT S4x): refresh the recall index and its vectors after every answer, so a cut finds
      // them ready instead of starting a build. The worker skips small growth; the launch is not awaited.
      if (optionBoolean(options, 'recallEnabled', true)) {
        const recallPluginRootForTurn = optionString(options, 'recallPluginRoot', '') || (await $.env.get('CLAUDE_PLUGIN_ROOT'));
        const sessionIdForTurn = String(await $.session.id());
        const cachedTurnPath = transcriptPathCache.get(sessionIdForTurn);
        const turnTranscript = cachedTurnPath ?? await findTranscriptPath({ cwd: () => $.session.cwd(), home: homeDir, configDir: () => $.env.get('CLAUDE_CONFIG_DIR') }, sessionIdForTurn, { exists: (path) => $.fs.exists(path), list: (path) => $.fs.list(path) });
        if (turnTranscript) transcriptPathCache.set(sessionIdForTurn, turnTranscript);
        if (recallPluginRootForTurn && turnTranscript) {
          const recallRootForTurn = `${(await homeDir()) ?? '.'}/.claude/exovault/recall`;
          void $.process.run(['node', `${recallPluginRootForTurn}/recall/launch.mjs`, turnTranscript, recallRootForTurn, sessionIdForTurn, optionBoolean(options, 'recallVectors', true) ? 'vectors' : 'lexical', 'turn', retentionDays(options)], { timeoutMs: 5000 })
            .catch(() => { notice('recall.turn_build_started=0'); });
        }
      }
      // Round 9 finding 7: a per-turn capture failure, not a session.compact fallback to core;
      // tagged `origin=turn-capture` so lib.mjs's coreRan() does not mistake it for core running.
    }, () => next(event), () => notice('compact.fallback=error origin=turn-capture'));
    // cc.d.ts: a text other than the main-loop answer is shown beneath it, so the notice alone.
    if (!refusalGuardTripped || !result || typeof result.text !== 'string') return result;
    return { ...result, text: REFUSAL_GUARD_NOTICE };
  });
  // 3.40.0 (CONTRACT S4zl, core/brief-push.ts): after a cut, a call that writes a file gets the newest brief's lines
  // for that file, found by recall/brief-push.mjs, as context. Any failure or timeout lets the call pass unchanged.
  on('classic.PreToolUse', async ($, call, next) => {
    const homeDir = () => resolveHomeDir({ home: () => $.env.get('HOME'), userProfile: () => $.env.get('USERPROFILE'), homeDrive: () => $.env.get('HOMEDRIVE'), homePath: () => $.env.get('HOMEPATH') });
    const notice = noticeLog({ emit: (...args: [string, { to: 'debug' }?]) => $.ui.log(...args), surfaces: () => $.session.surfaces(), entrypoint: () => $.env.get('CLAUDE_CODE_ENTRYPOINT'), childSession: () => $.env.get('CLAUDE_CODE_CHILD_SESSION'), briefChild: () => $.env.get('EXOVAULT_BRIEF_CHILD'), logFile: async () => { const noticeRoot = await findCaptureRoot({ cwd: () => $.session.cwd(), exists: (path: string) => $.fs.exists(path), root: () => $.session.root(), home: homeDir, inert: () => preflight.inert }); return noticeRoot === null ? undefined : `${capturePath(String(await $.session.id()), noticeRoot)}/notices.log`; }, read: (path: string) => $.fs.read(path), write: (path: string, text: string) => $.fs.write(path, text), now: () => $.clock.now() });
    const target = optionBoolean(options, 'briefPush', false) ? pushTarget(call as { tool: string; [argument: string]: unknown }) : undefined;
    if (!target) return next(call);
    const note = await runBriefPush({ cwd: () => $.session.cwd(), root: () => $.session.root(), id: () => $.session.id(), exists: (path: string) => $.fs.exists(path), read: (path: string) => $.fs.read(path), home: homeDir, inert: () => preflight.inert, pluginRoot: () => $.env.get('CLAUDE_PLUGIN_ROOT'), run: (argv: string[], init: { stdin: string; timeoutMs: number }) => $.process.run(argv, init), log: (line: string) => notice(line) }, target, optionString(options, 'recallPluginRoot', ''));
    const below = await next(call);
    return note ? { ...below, additionalContext: [...(below.additionalContext ?? []), note] } : below;
  }).catch(($, call, next) => {
    try { $.ui.log(`hook.caught=classic.PreToolUse kind=${next.error.kind}`, { to: 'debug' }); } catch { /* debug logging cannot block a tool call */ }
    return next(call);
  });
  // 3.41.0 (CONTRACT S4zm, core/brief-push.ts): after a write, the lines it added are checked against the newest
  // brief's line-length limits; only a broken limit adds context. Any failure or timeout adds nothing.
  on('classic.PostToolUse', async ($, input, next) => {
    const homeDir = () => resolveHomeDir({ home: () => $.env.get('HOME'), userProfile: () => $.env.get('USERPROFILE'), homeDrive: () => $.env.get('HOMEDRIVE'), homePath: () => $.env.get('HOMEPATH') });
    const notice = noticeLog({ emit: (...args: [string, { to: 'debug' }?]) => $.ui.log(...args), surfaces: () => $.session.surfaces(), entrypoint: () => $.env.get('CLAUDE_CODE_ENTRYPOINT'), childSession: () => $.env.get('CLAUDE_CODE_CHILD_SESSION'), briefChild: () => $.env.get('EXOVAULT_BRIEF_CHILD'), logFile: async () => { const noticeRoot = await findCaptureRoot({ cwd: () => $.session.cwd(), exists: (path: string) => $.fs.exists(path), root: () => $.session.root(), home: homeDir, inert: () => preflight.inert }); return noticeRoot === null ? undefined : `${capturePath(String(await $.session.id()), noticeRoot)}/notices.log`; }, read: (path: string) => $.fs.read(path), write: (path: string, text: string) => $.fs.write(path, text), now: () => $.clock.now() });
    const below = await next(input);
    if (optionBoolean(options, 'taskCard', true) && !(input as { agent_id?: string }).agent_id) {
      void refreshTaskCard({ cwd: () => $.session.cwd(), root: () => $.session.root(), id: () => $.session.id(), exists: (path: string) => $.fs.exists(path), read: (path: string) => $.fs.read(path), write: (path: string, text: string) => $.fs.write(path, text), home: homeDir, inert: () => preflight.inert, usage: async (withWindow: boolean) => { const usage = await $.session.usage(withWindow ? { breakdown: 'summary' } : undefined); return { tokens: usage.context.tokens, window: usage.context.breakdown?.rawMaxTokens ?? usage.context.window }; }, fork: async (prompt: string) => forkReply(await $.model.fork({ prompt })), horizon: async () => (input as { tool_use_id?: string }).tool_use_id || undefined, late: optionBoolean(options, 'lateCardRefresh', false) ? { messages: async () => await $.session.messages() as unknown as SessionMessage[] } : undefined, now: async () => Number(await $.clock.now()), log: (line: string) => notice(line) });
    }
    if (!optionBoolean(options, 'recallEnabled', true) || !optionBoolean(options, 'briefLimits', true)) return below;
    const target = pushTarget({ ...((input.tool_input ?? {}) as Record<string, unknown>), tool: input.tool_name });
    if (!target) return below;
    const note = await runBriefLimits({ cwd: () => $.session.cwd(), root: () => $.session.root(), id: () => $.session.id(), exists: (path: string) => $.fs.exists(path), read: (path: string) => $.fs.read(path), home: homeDir, inert: () => preflight.inert, pluginRoot: () => $.env.get('CLAUDE_PLUGIN_ROOT'), run: (argv: string[], init: { stdin: string; timeoutMs: number }) => $.process.run(argv, init), log: (line: string) => notice(line) }, target.files, optionString(options, 'recallPluginRoot', ''));
    return note ? { ...below, additionalContext: [...(below.additionalContext ?? []), note] } : below;
  }).catch(($, input, next) => {
    try { $.ui.log(`hook.caught=classic.PostToolUse kind=${next.error.kind}`, { to: 'debug' }); } catch { /* debug logging cannot block a tool result */ }
    return next(input);
  });
  // 3.37.0 (CONTRACT S4zj, core/brief-check.ts): the main loop's first stop after a cut with a saved brief is
  // blocked once with the brief lines recall/brief-check.mjs finds. The flag is removed before the search, so a
  // failure, a timeout or a second stop never blocks again; subagents and a stop already continued pass through.
  on('classic.Stop', async ($, input, next) => {
    const homeDir = () => resolveHomeDir({ home: () => $.env.get('HOME'), userProfile: () => $.env.get('USERPROFILE'), homeDrive: () => $.env.get('HOMEDRIVE'), homePath: () => $.env.get('HOMEPATH') });
    const notice = noticeLog({ emit: (...args: [string, { to: 'debug' }?]) => $.ui.log(...args), surfaces: () => $.session.surfaces(), entrypoint: () => $.env.get('CLAUDE_CODE_ENTRYPOINT'), childSession: () => $.env.get('CLAUDE_CODE_CHILD_SESSION'), briefChild: () => $.env.get('EXOVAULT_BRIEF_CHILD'), logFile: async () => { const noticeRoot = await findCaptureRoot({ cwd: () => $.session.cwd(), exists: (path: string) => $.fs.exists(path), root: () => $.session.root(), home: homeDir, inert: () => preflight.inert }); return noticeRoot === null ? undefined : `${capturePath(String(await $.session.id()), noticeRoot)}/notices.log`; }, read: (path: string) => $.fs.read(path), write: (path: string, text: string) => $.fs.write(path, text), now: () => $.clock.now() });
    if (input.agent_id || input.stop_hook_active) return next(input);
    try {
      const flagHost = { cwd: () => $.session.cwd(), exists: (path: string) => $.fs.exists(path), root: () => $.session.root(), home: homeDir, inert: () => preflight.inert };
      const captureRoot = await findCaptureRoot(flagHost);
      if (captureRoot === null) return next(input);
      // 3.48.0 (CONTRACT S4zv, core/rule-check.ts): with a task card and `ruleCheck` on (its own Jev opt-in, apart from
      // `jevEnabled`, which also drives selector J and the dense rerank), every main-loop stop asks
      // recall/rule-check.mjs which card rules the final message and the uncommitted diff break, and blocks with those
      // alone; a clean turn passes with nothing pasted. A failure falls through to the 3.47 check below.
      const ruleCardFile = `${capturePath(String(await $.session.id()), captureRoot)}/${TASK_CARD_FILE}`;
      const ruleCheckOn = optionBoolean(options, 'taskCard', true) && optionBoolean(options, 'ruleCheck', false);
      const ruleDenyList = optionString(options, 'jevDenyList', '').split(',').map((entry) => entry.trim()).filter(Boolean);
      // 3.48.1: a card written before the newest saved brief belongs to an earlier task (w60i: an r4 report checked
      // against the r5 card was told its last line must be r5's review id), so it is not checked against.
      const ruleBriefIndex = `${(await homeDir()) ?? '.'}/.claude/exovault/recall/${sha256(String(await $.session.id()))}/briefs/briefs.json`;
      const newestBriefId = (await $.fs.exists(ruleBriefIndex)) ? parseBriefIndex(await $.fs.read(ruleBriefIndex)).at(-1)?.id : undefined;
      const cardBriefFile = `${capturePath(String(await $.session.id()), captureRoot)}/${TASK_CARD_BRIEF_FILE}`;
      const readCardBriefId = async (): Promise<string> => ((await $.fs.exists(cardBriefFile)) ? (await $.fs.read(cardBriefFile)).trim() : '');
      const cardBriefId = await readCardBriefId();
      // 3.55.0 (A3): the card text is read once here, and the id again after it, so text and id are one refresh's.
      const stopCardText = (await $.fs.exists(ruleCardFile)) ? await $.fs.read(ruleCardFile) : undefined;
      const cardStale = (newestBriefId !== undefined && newestBriefId !== cardBriefId) || (await readCardBriefId()) !== cardBriefId;
      if (ruleCheckOn && cardStale && stopCardText !== undefined) notice('rule_check.fired=0 reason=card_stale');
      if (ruleCheckOn && !cardStale && (await jevEgressAllowed(flagHost, true, ruleDenyList)) && stopCardText !== undefined) {
        const ruleRoot = optionString(options, 'recallPluginRoot', '') || (await $.env.get('CLAUDE_PLUGIN_ROOT'));
        const ranPromise = ruleRoot
          ? $.process.run(['node', `${ruleRoot}/recall/rule-check.mjs`, String(await $.session.cwd())], {
            stdin: JSON.stringify({ card: stopCardText, report: input.last_assistant_message ?? '' }),
            env: { EXO_JEV_MODEL: optionString(options, 'jevModel', 'jev-latest') },
            timeoutMs: RULE_CHECK_TIMEOUT_MS,
          }).catch(() => undefined)
          : undefined;
        const ran = await ranPromise;
        const checked = ran?.exitCode === 0 ? parseRuleCheck(String(ran.stdout)) : undefined;
        if (checked) {
          // 4.3.0 (CONTRACT S5c): a progress update is not blocked again for a rule that already blocked in this task.
          const seenFile = `${capturePath(String(await $.session.id()), captureRoot)}/${RULE_CHECK_SEEN_FILE}`;
          const seen = parseSeenRules((await $.fs.exists(seenFile)) ? await $.fs.read(seenFile) : undefined, cardBriefId);
          const toBlock = rulesToBlock(checked.broken, checked.progress === true, seen);
          const repeated = checked.broken.length - toBlock.length;
          notice(`rule_check.fired=${toBlock.length ? 1 : 0} broken=${checked.broken.length} units=${checked.units} ms=${checked.ms}${checked.progress ? ' progress=1' : ''}${repeated ? ` repeat=${repeated}` : ''}`);
          const flagFile = `${capturePath(String(await $.session.id()), captureRoot)}/${BRIEF_CHECK_FILE}`;
          if (await $.fs.exists(flagFile)) await $.fs.write(flagFile, BRIEF_CHECK_DONE);
          if (!toBlock.length) return next(input);
          await $.fs.write(seenFile, renderSeenRules(cardBriefId, [...seen, ...toBlock.map((entry) => entry.rule)]));
          const below = await next(input);
          return { ...below, block: renderRuleCheckReason(toBlock, ruleCardFile, checked.progress === true) };
        }
        const ruleSkip = ran?.exitCode === 0 ? parseRuleSkip(String(ran.stdout)) : undefined;
        notice(`rule_check.fired=0 reason=${!ruleRoot ? 'no_root' : ran === undefined ? 'error' : ruleSkip ?? 'no_result'}`);
        const ruleOff = ruleSkip === undefined ? undefined : ruleSkipWarning(ruleSkip);
        const ruleSession = String(await $.session.id());
        if (ruleOff !== undefined && !ruleOffSaid.has(ruleSession)) {
          ruleOffSaid.add(ruleSession);
          notice(ruleOff);
        }
      }
      const flagPath = `${capturePath(String(await $.session.id()), captureRoot)}/${BRIEF_CHECK_FILE}`;
      if (!(await $.fs.exists(flagPath))) return next(input);
      const state = (await $.fs.read(flagPath)).trim();
      if (state === BRIEF_CHECK_DONE) return next(input);
      await $.fs.write(flagPath, BRIEF_CHECK_DONE);
      // 3.47.0 (CONTRACT S4zu): with a task card, the check is the card's acceptance checks, not the whole brief.
      // 3.55.0 (external review 5 A2): a stale card's checks are the previous task's; the stop then checks the brief.
      const cardFile = ruleCardFile;
      if (optionBoolean(options, 'taskCard', true) && !cardStale && stopCardText !== undefined) {
        const acceptance = cardAcceptance(stopCardText);
        if (acceptance !== undefined) {
          const foundForPath = parseBriefCheck(state);
          notice(`brief_check.fired=1 source=card chars=${acceptance.length}`);
          const below = await next(input);
          return { ...below, block: renderCardCheckReason(acceptance, cardFile, foundForPath?.path) };
        }
      }
      const found = parseBriefCheck(state);
      if (!found) { notice(`brief_check.fired=0 reason=${state === BRIEF_CHECK_ARMED ? 'not_ready' : 'no_lines'}`); return next(input); }
      notice(`brief_check.fired=1 brief=${found.brief} lines=${found.lines.length}`);
      const below = await next(input);
      return { ...below, block: renderBriefCheckReason(found) };
    } catch {
      notice('brief_check.fired=0 reason=error');
      return next(input);
    }
  }).catch(($, input, next) => {
    try { $.ui.log(`hook.caught=classic.Stop kind=${next.error.kind}`, { to: 'debug' }); } catch { /* debug logging cannot block the stop */ }
    return next(input);
  });
};

/**
 * 3.41.0 (CONTRACT S4zm): the note for a write whose added lines break the newest brief's line-length limit, from
 * `recall/brief-push.mjs limits`, or undefined (clean write, no brief or limit, any failure or timeout).
 */
async function runBriefLimits(host: BriefPushHost, files: readonly string[], pluginRootOption: string): Promise<string | undefined> {
  try {
    const pluginRoot = pluginRootOption || (await host.pluginRoot());
    if (!pluginRoot) return undefined;
    const recallRoot = `${(await host.home()) ?? '.'}/.claude/exovault/recall`;
    const ran = await host.run(['node', `${pluginRoot}/recall/brief-push.mjs`, 'limits', recallRoot, String(await host.id()), await host.cwd()], { stdin: JSON.stringify({ files }), timeoutMs: BRIEF_LIMITS_TIMEOUT_MS });
    const warnings = ran.exitCode === 0 ? parseBriefLimits(String(ran.stdout)) : [];
    if (!warnings.length) return undefined;
    host.log(`brief_limits.fired=1 files=${warnings.length}`);
    return renderBriefLimits(warnings);
  } catch (error) {
    host.log(`brief_limits.fired=0 reason=error error=${errorTail(error)}`);
    return undefined;
  }
}

/** What runBriefPush calls, as closures each hook builds over its own `$` (the hook compiler's $ rule). */
type BriefPushHost = {
  cwd: () => Promise<string>;
  root: () => Promise<string>;
  id: () => Promise<string>;
  exists: (path: string) => Promise<boolean>;
  read: (path: string) => Promise<string>;
  home: () => Promise<string | undefined>;
  /** True after a failed SessionStart preflight (host/preflight.ts). */
  inert: () => boolean;
  pluginRoot: () => Promise<string | undefined>;
  run: (argv: string[], init: { stdin: string; timeoutMs: number }) => Promise<{ exitCode: number; stdout: string }>;
  log: (line: string) => void;
  /** 4.8.2 (CONTRACT S5s): the recall server's socket, for session push only. */
  fetch?: (url: string, init: { method: string; headers: Record<string, string>; body: string; socketPath: string }) => Promise<{ status: number; ok: boolean; text: string }>;
  after?: (ms: number, fn: () => void) => { cancel: () => void };
  now?: () => Promise<number>;
};

/**
 * 3.40.0 (CONTRACT S4zl): the brief lines to push for a write or a prompt, as the note the model reads, or
 * undefined (no cut yet, push off for this task, nothing new found, any failure). brief-push.mjs keeps the state.
 */
async function runBriefPush(host: BriefPushHost, input: BriefPushInput, pluginRootOption: string): Promise<string | undefined> {
  try {
    const captureRoot = await findCaptureRoot({ cwd: host.cwd, exists: host.exists, root: host.root, home: host.home, inert: host.inert });
    if (captureRoot === null) return undefined;
    const sessionId = String(await host.id());
    const statePath = `${capturePath(sessionId, captureRoot)}/${BRIEF_PUSH_FILE}`;
    if (!(await host.exists(statePath)) || (await host.read(statePath)).trim() === BRIEF_PUSH_OFF) return undefined;
    const pluginRoot = pluginRootOption || (await host.pluginRoot());
    if (!pluginRoot) return undefined;
    const recallRoot = `${(await host.home()) ?? '.'}/.claude/exovault/recall`;
    const ran = await host.run(['node', `${pluginRoot}/recall/brief-push.mjs`, recallRoot, sessionId, statePath], { stdin: JSON.stringify(input), timeoutMs: BRIEF_PUSH_TIMEOUT_MS });
    const found = ran.exitCode === 0 ? parseBriefPush(String(ran.stdout)) : undefined;
    host.log(`brief_push.fired=${found ? 1 : 0}${found ? ` brief=${found.brief} lines=${found.lines.map((line) => line.line).join(',')}` : ''} on=${'prompt' in input ? 'prompt' : 'write'}`);
    return found ? renderBriefPush(found, 'prompt' in input ? { prompt: true } : { files: input.files }) : undefined;
  } catch (error) {
    host.log(`brief_push.fired=0 reason=error error=${errorTail(error)}`);
    return undefined;
  }
}

/**
 * 3.42.0 (CONTRACT S4zn): the compacted-away session lines for a prompt, as the note the model reads, or undefined
 * (no capture, no cut yet, nothing rare in the prompt, all shown since the last cut, any failure).
 */
async function runSessionPush(host: BriefPushHost, prompt: string, pluginRootOption: string): Promise<string | undefined> {
  try {
    const captureRoot = await findCaptureRoot({ cwd: host.cwd, exists: host.exists, root: host.root, home: host.home, inert: host.inert });
    if (captureRoot === null) return undefined;
    const sessionId = String(await host.id());
    const pluginRoot = pluginRootOption || (await host.pluginRoot());
    if (!pluginRoot) return undefined;
    const recallRoot = `${(await host.home()) ?? '.'}/.claude/exovault/recall`;
    const statePath = `${capturePath(sessionId, captureRoot)}/${SESSION_PUSH_FILE}`;
    const served = await askPushServer(host, recallRoot, sessionId, { session: sessionId, prompt, stateFile: statePath });
    if (served === 'timeout') { host.log('session_push.fired=0 via=server reason=timeout'); return undefined; }
    let found: SessionPushFound | undefined, via = '';
    if (served && served !== 'failed') { found = served.found; via = ' via=server'; }
    else {
      const ran = await host.run(['node', `${pluginRoot}/recall/session-push.mjs`, recallRoot, sessionId, statePath], { stdin: JSON.stringify({ prompt }), timeoutMs: SESSION_PUSH_TIMEOUT_MS });
      found = ran.exitCode === 0 ? parseSessionPush(String(ran.stdout)) : undefined;
      if (served === 'failed') via = ' via=spawn';
    }
    host.log(`session_push.fired=${found ? 1 : 0}${found ? ` lines=${found.lines.length} chars=${found.text.length} cuts=${found.cuts}` : ''}${via}`);
    return found ? renderSessionPush(found) : undefined;
  } catch (error) {
    host.log(`session_push.fired=0 reason=error error=${errorTail(error)}`);
    return undefined;
  }
}

/**
 * 4.8.2 (CONTRACT S5s): the session's recall MCP server answers a session push from the index it already holds,
 * which saves starting node and preparing the index for every prompt. Resolves undefined when the session has no
 * server pointer (the hook spawns), 'failed' when the pointer is broken or the server refused or is gone (the hook
 * spawns), 'timeout' when the server took too long (given up for this prompt: a spawned search would race it for the
 * state file; the request's deadline keeps the server from marking those lines shown), or the server's answer.
 */
async function askPushServer(host: BriefPushHost, recallRoot: string, sessionId: string, request: { session: string; prompt: string; stateFile: string }): Promise<{ found: SessionPushFound | undefined } | 'failed' | 'timeout' | undefined> {
  const fetch = host.fetch, after = host.after, now = host.now;
  if (!fetch || !after || !now) return undefined;
  const pointerPath = `${recallRoot}/${sha256(sessionId)}/${SESSION_PUSH_POINTER}`;
  if (!(await host.exists(pointerPath))) return undefined;
  let pointer;
  try { pointer = parsePushPointer(await host.read(pointerPath)); } catch { return 'failed'; }
  if (!pointer) return 'failed';
  let timer: { cancel: () => void } | undefined;
  const timeout = new Promise<'timeout'>((resolve) => { timer = after(SESSION_PUSH_SERVER_TIMEOUT_MS, () => resolve('timeout')); });
  try {
    const response = await Promise.race([
      fetch('http://recall/session-push', { method: 'POST', headers: { 'content-type': 'application/json', 'x-exo-token': pointer.token }, body: JSON.stringify({ ...request, deadline: (await now()) + SESSION_PUSH_SERVER_TIMEOUT_MS }), socketPath: pointer.socket }),
      timeout,
    ]);
    if (response === 'timeout') return 'timeout';
    if (!response.ok) return 'failed';
    if (response.text.trim() === 'null') return { found: undefined };
    const found = parseSessionPush(response.text);
    return found ? { found } : 'failed';
  } catch {
    return 'failed';
  } finally {
    timer?.cancel();
  }
}

/**
 * 4.7.6 (CONTRACT S5r): Jev and rule-check send text off the machine, including session and capture-store content,
 * and rule-check also sends the working directory's diff, so they run only while a walk from the working directory
 * alone is enabled and the working directory passes the deny list; a usable session root is tested against the deny
 * list too, a host without one keeps the working-directory test only.
 */
async function jevEgressAllowed(flags: FlagHost, enabled: boolean, denyList: readonly string[]): Promise<boolean> {
  if (!enabled) return false;
  if (!isJevAllowed(String(await flags.cwd()), true, denyList)) return false;
  if ((await findCaptureRoot({ cwd: flags.cwd, exists: flags.exists, home: flags.home, inert: flags.inert })) === null) return false;
  const root = await usableRoot(flags);
  return root === undefined || isJevAllowed(root, true, denyList);
}

/** 3.13.0 (CONTRACT S4m): short, recent, typed-by-the-user history for the seed. */
function historyForSeed(userHistory: readonly string[]): { userInstructionsVerbatim: string[]; userHistoryNote?: string } {
  const { messages, omittedCount } = condenseUserHistory(userHistory);
  return { userInstructionsVerbatim: messages, ...(omittedCount > 0 ? { userHistoryNote: historyOmittedNote(omittedCount) } : {}) };
}

/** What refreshTaskCard calls, as closures each hook builds over its own `$` (the hook compiler's $ rule). */
type TaskCardHost = {
  cwd: () => Promise<string>;
  root: () => Promise<string>;
  id: () => Promise<string>;
  exists: (path: string) => Promise<boolean>;
  read: (path: string) => Promise<string>;
  write: (path: string, text: string) => Promise<void>;
  home: () => Promise<string | undefined>;
  /** True after a failed SessionStart preflight (host/preflight.ts). */
  inert: () => boolean;
  /** Context tokens of the last response and the compaction window (the breakdown's rawMaxTokens, else the model's window). */
  usage: (withWindow: boolean) => Promise<{ tokens?: number; window?: number }>;
  /** 4.7.1 (S5l): a reply, or no reply with its reason (`null` for the old `null` result); see `forkReply`. */
  fork: (prompt: string) => Promise<ForkReply>;
  /** 4.6.0 (S5f): the id of the newest tool call the fork can see, read when the refresh starts. */
  horizon: () => Promise<string | undefined>;
  /** 4.7.0 (S5j): the session's messages, read only past the late share of the window; with `late` the late refresh step is on. */
  late?: { messages: () => Promise<SessionMessage[]> };
  /** Milliseconds since the epoch. */
  now: () => Promise<number>;
  log: (line: string) => void;
};

/** The `tool_use_id` of the newest tool call in a message list, scanned from the end. */
function lastToolUseId(messages: readonly SessionMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const uses = messages[index].toolUses;
    if (uses.length > 0) return uses[uses.length - 1].tool_use_id;
  }
  return undefined;
}

/** One refresh at a time per session, and the compaction window read once per session. */
const cardRefreshing = new Set<string>();
const cardWindows = new Map<string, number>();

/**
 * 3.47.0 (CONTRACT S4zu, core/task-card.ts): when the context has grown enough since the last refresh, forks the
 * main thread in the background to rewrite the task card. Never awaited by the hook's result: the fork's reply
 * lands in the card file whenever it comes, and any failure leaves the previous card in place.
 */
async function refreshTaskCard(host: TaskCardHost): Promise<void> {
  try {
    const captureRoot = await findCaptureRoot({ cwd: host.cwd, exists: host.exists, root: host.root, home: host.home, inert: host.inert });
    if (captureRoot === null) return;
    const sessionId = String(await host.id());
    if (cardRefreshing.has(sessionId)) return;
    // 3.55.0 (external review 5 A1): taken before the first await below, so two hooks at once cannot both fork; given
    // back here unless a fork took it over.
    cardRefreshing.add(sessionId);
    let forked = false;
    try {
      const known = cardWindows.get(sessionId);
      const usage = await host.usage(known === undefined);
      const windowTokens = known ?? usage.window ?? 0;
      if (known === undefined && windowTokens > 0) cardWindows.set(sessionId, windowTokens);
      const baseDir = capturePath(sessionId, captureRoot);
      const statePath = `${baseDir}/${TASK_CARD_STATE_FILE}`;
      const previous = parseTaskCardState((await host.exists(statePath)) ? await host.read(statePath) : undefined);
      const tokens = usage.tokens ?? 0;
      // Below both shares nothing can be due, so the brief index is read only past the lower one.
      const briefIndex = `${(await host.home()) ?? '.'}/.claude/exovault/recall/${sha256(sessionId)}/briefs/briefs.json`;
      const newestBrief = windowTokens > 0 && tokens >= windowTokens * Math.min(CARD_TASK_SHARE, CARD_CUT_SHARE) && (await host.exists(briefIndex)) ? parseBriefIndex(await host.read(briefIndex)).at(-1) : undefined;
      let step = cardRefreshDue(previous, tokens, windowTokens, newestBrief?.id);
      // 4.7.0 (S5j, core/late-card.ts): a second refresh close to the cut when the card has fallen behind. The calls since the
      // card's horizon are counted only past the late share, so the common tool call stays as cheap as before.
      let lateCalls: number | undefined;
      if (!step.due && host.late && step.state.stretchDone === true && step.state.lateDone !== true && windowTokens > 0 && tokens >= windowTokens * CARD_LATE_SHARE) {
        const horizonPath = `${baseDir}/${TASK_CARD_HORIZON_FILE}`;
        const cardHorizon = (await host.exists(horizonPath)) ? parseCardHorizon(await host.read(horizonPath)) : undefined;
        lateCalls = countToolCallsSince(await host.late.messages(), cardHorizon);
        step = lateRefreshDue(step.state, tokens, windowTokens, lateCalls);
      }
      if (JSON.stringify(step.state) !== JSON.stringify(previous)) await host.write(statePath, JSON.stringify(step.state));
      if (!step.due) return;
      const cardPath = `${baseDir}/${TASK_CARD_FILE}`;
      const current = (await host.exists(cardPath)) ? (await host.read(cardPath)).trim() || undefined : undefined;
      const briefPath = newestBrief?.path;
      host.log(`task_card.refresh=start ctx=${usage.tokens} window=${windowTokens} n=${step.state.refreshes}${lateCalls === undefined ? '' : ` late=1 calls=${lateCalls}`}`);
      // 4.6.0 (S5f): what the fork can see is fixed here, before it starts; the cut lists the calls after it.
      let horizonId: string | undefined;
      try { horizonId = (await host.horizon()) || undefined; } catch { horizonId = undefined; }
      forked = true;
      // 3.52.0: a fork that never ran (w60k: the first prompt of a resumed process has no main-thread response to fork
      // yet) gives the refresh back, so the next tool call retries it; before, the new task kept the old task's card
      // until the next stretch and its stop found the card stale. A reply that is not a card keeps the step spent.
      // Given back only while the state is still the one this refresh wrote (another process may have moved on).
      const giveBack = async () => {
        try { if ((await host.read(statePath)) === JSON.stringify(step.state)) await host.write(statePath, JSON.stringify(previous)); } catch { /* the step stays spent */ }
      };
      void Promise.resolve().then(() => host.fork(renderCardPrompt(current, briefPath)))
        .then(async (reply) => {
          const card = 'text' in reply ? parseCardReply(reply.text, estimateTokens) : undefined;
          if (card) {
            await host.write(cardPath, `${card}\n`);
            await host.write(`${baseDir}/${TASK_CARD_BRIEF_FILE}`, newestBrief?.id ?? '');
            // Only together with a written card; `{}` when no tool call was visible, so an old horizon never pairs with this card.
            try {
              const at = await host.now().then((ms) => new Date(ms).toISOString(), () => undefined);
              await host.write(`${baseDir}/${TASK_CARD_HORIZON_FILE}`, horizonId === undefined ? '{}' : JSON.stringify({ toolUseId: horizonId, ...(at === undefined ? {} : { at }), tokens }));
            } catch { host.log('task_card.horizon=error'); }
          } else if (!('text' in reply)) await giveBack();
          host.log('text' in reply ? `task_card.refresh=${card ? 'written' : 'unparsed'} size=${card ? estimateTokens(card) : 0}` : `task_card.refresh=no_reply reason=${reply.reason}`);
        })
        .catch(async () => { await giveBack(); host.log('task_card.refresh=error'); })
        .finally(() => { cardRefreshing.delete(sessionId); });
    } finally {
      if (!forked) cardRefreshing.delete(sessionId);
    }
  } catch {
    host.log('task_card.refresh=error');
  }
}
