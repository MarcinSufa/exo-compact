// Vendored from MarcinSufa/skills hooks/lib/is-real-user-prompt.mjs (prompt-source guard v1, sha256 d19583acb0fe); edit there first.
// Prompt-source guard v1: was this prompt typed by a person, or injected by the host?
// UserPromptSubmit (command hook) and prompt.submit (JS mod) also fire for Code Mode code output and
// Poll, scheduled tasks, /loop wakeups, subagent reports and peer messages. Only "user" may be ingested.
// Omitted or unrecognised signals are "unknown" and skipped: Claude Code 2.1.327 omits `source` on
// typed prompts too, so ingest pauses there until it sends source "user". Never throws.

export type PromptSource = 'user' | 'non-user' | 'unknown';

const NON_USER_SOURCES = new Set<unknown>(['sdk', 'system', 'loop_wakeup', 'schedule_wakeup', 'poll_event']);
const USER_ORIGIN_KINDS = new Set<unknown>(['composer', 'bridge']);
const NON_USER_ORIGIN_KINDS = new Set<unknown>([
  'auto-continuation', 'channel', 'coordinator', 'observer', 'observer-activity', 'peer', 'peer-send-message',
  'plugin', 'projects-relay', 'scheduled-trigger', 'sdk', 'slack-ping', 'task-notification',
]);

function fromSource(source: unknown): PromptSource | undefined {
  if (source === undefined) return undefined;
  if (source === 'user') return 'user';
  return NON_USER_SOURCES.has(source) ? 'non-user' : 'unknown';
}

function fromOrigin(origin: unknown): PromptSource | undefined {
  if (origin === undefined) return undefined;
  const record = origin as { kind?: unknown; handback?: unknown } | null;
  const kind = typeof origin === 'string' ? origin : record?.kind;
  if (record?.handback === true) return 'non-user';
  if (USER_ORIGIN_KINDS.has(kind)) return 'user';
  return NON_USER_ORIGIN_KINDS.has(kind) ? 'non-user' : 'unknown';
}

export function classifyPromptSource(input: unknown): PromptSource {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'unknown';
    const fields = input as { isMeta?: unknown; source?: unknown; origin?: unknown };
    if (fields.isMeta === true) return 'non-user';
    const verdicts = [fromSource(fields.source), fromOrigin(fields.origin)].filter((verdict) => verdict !== undefined);
    if (verdicts.includes('non-user')) return 'non-user';
    if (verdicts.length > 0 && verdicts.every((verdict) => verdict === 'user')) return 'user';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export function isRealUserPrompt(input: unknown): boolean {
  return classifyPromptSource(input) === 'user';
}

export function shouldSkipPrompt(input: unknown): boolean {
  return !isRealUserPrompt(input);
}
