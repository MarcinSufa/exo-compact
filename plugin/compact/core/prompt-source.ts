// Vendored from MarcinSufa/skills hooks/lib/is-real-user-prompt.mjs (prompt-source guard v2 fail-open, sha256 3d69a9b22334); edit there first.
// Prompt-source guard v2 (fail-open): was this prompt typed by a person, or injected by the host?
// UserPromptSubmit (command hook) and prompt.submit (JS mod) also fire for Code Mode code output and
// Poll, scheduled tasks, /loop wakeups, subagent reports and peer messages. Only explicit non-user
// signals are skipped. Omitted or unrecognised signals count as user: Claude Code 2.1.327 omits
// `source` on typed prompts, so failing closed would drop every typed prompt. Never throws.

export type PromptSource = 'user' | 'non-user' | 'unknown';

const NON_USER_SOURCES = new Set<unknown>(['sdk', 'system', 'loop_wakeup', 'schedule_wakeup', 'poll_event']);
const USER_ORIGIN_KINDS = new Set<unknown>(['composer', 'bridge']);

function fromSource(source: unknown): PromptSource {
  if (source === 'user') return 'user';
  return NON_USER_SOURCES.has(source) ? 'non-user' : 'unknown';
}

function fromOrigin(origin: unknown): PromptSource {
  const kind = typeof origin === 'string' ? origin : (origin !== null && typeof origin === 'object' ? (origin as { kind?: unknown }).kind : undefined);
  if (typeof kind !== 'string' || kind === '') return 'unknown';
  return USER_ORIGIN_KINDS.has(kind) ? 'user' : 'non-user';
}

export function classifyPromptSource(input: unknown): PromptSource {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'unknown';
    const fields = input as { isMeta?: unknown; source?: unknown; origin?: unknown };
    if (fields.isMeta === true) return 'non-user';
    const verdicts = [fromSource(fields.source), fromOrigin(fields.origin)];
    if (verdicts.includes('non-user')) return 'non-user';
    if (verdicts.includes('user')) return 'user';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export function isRealUserPrompt(input: unknown): boolean {
  return classifyPromptSource(input) !== 'non-user';
}

export function shouldSkipPrompt(input: unknown): boolean {
  return !isRealUserPrompt(input);
}
