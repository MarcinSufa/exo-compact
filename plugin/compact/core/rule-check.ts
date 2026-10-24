/**
 * Rule check (3.48.0, CONTRACT S4zv). With a task card on disk, the main loop's stop no longer pastes the whole
 * brief or the card's acceptance checks: `recall/rule-check.mjs` asks Jev which of the card's rules the turn's final
 * message and uncommitted diff break, and the stop is blocked with those rules alone, or passes when none is broken.
 * w17 w60h (3.47.1): the pasted brief came back 15 times (~80k tokens of context in one chain) and led to a fix 1 time;
 * offline, Jev on the report alone caught 24 of 26 report-rule misses with 3 false alarms in 217 kept rules.
 */
export const RULE_CHECK_TIMEOUT_MS = 10_000;

export type RuleCheckBroken = { rule: string; kind: 'report' | 'work'; score: number };
/** `progress`: 4.2.0, Jev called the message a progress update, so rules judged only on the finished task were skipped. */
export type RuleCheckResult = { broken: RuleCheckBroken[]; units: number; ms: number; progress?: boolean };

/**
 * 4.3.0 (CONTRACT S5c): the rules that already blocked a stop in this task (keyed by the card's brief id), so a later
 * progress update is not blocked for them again; the hand-back still is. 303 recorded stops (2026-10-03..06): after
 * 4.2.0, 31 of 75 blocked stops were progress updates blocked only for rules that had blocked that session before
 * (one orchestrator 15 times for the same rule).
 */
export const RULE_CHECK_SEEN_FILE = 'rule-check-seen.json';

/** The rules already blocked in `task`; another task's list, a missing file or a malformed one is empty. */
export function parseSeenRules(text: string | undefined, task: string): Set<string> {
  let value: unknown;
  try { value = JSON.parse(text ?? ''); } catch { return new Set(); }
  const found = value as { task?: unknown; rules?: unknown } | null;
  if (!found || found.task !== task || !Array.isArray(found.rules)) return new Set();
  return new Set(found.rules.filter((rule): rule is string => typeof rule === 'string'));
}

export function renderSeenRules(task: string, rules: Iterable<string>): string {
  return JSON.stringify({ task, rules: [...new Set(rules)] });
}

/** The rules a stop is blocked with: every broken rule on a hand-back; on a progress update only the new ones. */
export function rulesToBlock(broken: readonly RuleCheckBroken[], progress: boolean, seen: ReadonlySet<string>): RuleCheckBroken[] {
  return progress ? broken.filter((entry) => !seen.has(entry.rule)) : [...broken];
}

/** The JSON rule-check.mjs prints, or undefined when it printed nothing usable. */
/**
 * 4.7.5 (CONTRACT S5o): why rule-check.mjs has no result, read from its `{"skipped": ...}` line: `no_key`, `bad_url`
 * (S5q: EXO_JEV_URL is not an address), `denied` (deny list), `timeout`, or `http_<status>` when Jev refused the call
 * (402 is an account without credit).
 */
export function parseRuleSkip(stdout: string): string | undefined {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return undefined; }
  const skipped = (value as { skipped?: unknown } | null)?.skipped;
  return typeof skipped === 'string' && /^(?:no_key|bad_url|denied|timeout|http_\d{3})$/.test(skipped) ? skipped : undefined;
}

/**
 * 4.7.5 (CONTRACT S5o): the line said once per session when the rule check is on but cannot work until the user acts:
 * no key, a wrong EXO_JEV_URL, a rejected key, an account without credit. A timeout, a server fault and the deny list
 * say nothing.
 */
export function ruleSkipWarning(reason: string): string | undefined {
  const why = reason === 'no_key' ? 'TYPESAFE_API_KEY is not set'
    : reason === 'bad_url' ? 'EXO_JEV_URL is not an http or https address'
    : reason === 'http_401' || reason === 'http_403' ? `Jev rejected the key (HTTP ${reason.slice(5)})`
      : reason === 'http_402' ? 'the TypeSafe account has no credit (HTTP 402)'
        : undefined;
  return why === undefined ? undefined : `rule_check.off=${reason} ruleCheck is on but ${why}, so no rule is checked. Fix it and restart Claude Code, or turn ruleCheck off.`;
}

export function parseRuleCheck(stdout: string): RuleCheckResult | undefined {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return undefined; }
  if (!value || typeof value !== 'object') return undefined;
  const found = value as Partial<RuleCheckResult>;
  if (!Array.isArray(found.broken) || typeof found.units !== 'number') return undefined;
  const broken = found.broken.filter((entry): entry is RuleCheckBroken =>
    !!entry && typeof entry.rule === 'string' && entry.rule.length > 0 && (entry.kind === 'report' || entry.kind === 'work') && typeof entry.score === 'number');
  return { broken, units: found.units, ms: typeof found.ms === 'number' ? found.ms : 0, ...(found.progress === true ? { progress: true } : {}) };
}

/**
 * The block reason: the broken rules alone, and what to do about them. 4.4.0 (CONTRACT S5d): on a progress update it
 * asks for the fix and a line or two, not the final report; in the 154 recorded blocks, 44 of 59 short progress
 * updates (median 184 chars) were followed by a full report (median 1638 chars) for a task not done yet.
 */
export function renderRuleCheckReason(broken: readonly RuleCheckBroken[], cardPath: string, progress = false): string {
  return [
    `Before you finish: an automatic check of your last message and your uncommitted changes against the rules in your task card (${cardPath}) found ${broken.length === 1 ? 'this rule' : 'these rules'} likely broken:`,
    '',
    ...broken.map((entry) => `- ${entry.rule} (${entry.kind === 'report' ? 'your final message' : 'the work'})`),
    '',
    progress
      ? 'The check can be wrong. Look at each one (your message, or the file with a command) and fix only what is really broken. Your last message was a progress update, not your final report, so do not write the report now: say in a line or two what you fixed, if anything, and carry on with the task. Rules about the final report apply when you hand the task back.'
      : 'The check can be wrong. Look at each one (your message, or the file with a command) and fix only what is really broken. Then send your final report again, in full, as your whole last message: it starts with the report\'s own first line, keeps everything the user asked of a final report in this session, and says nothing about this check before or after it (a real fix goes where the report lists changes or deviations).',
  ].join('\n');
}
