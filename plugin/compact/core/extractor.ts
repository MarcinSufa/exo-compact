import { isSeedMessage } from './sentinel.js';
import { specificTokenList, specificTokens } from './dense.js';
import { workEventsByMessage } from './work-state.js';
import type { CaptureRecord, ContentWatermark, Hasher, SessionMessage } from './types.js';

/**
 * Content identity of a message (spec §3.2): sha256 of role, text and tool_use ids. Not an
 * index and not the engine `handle`, so it survives a rebuild and a restart.
 */
export function contentIdentity(message: SessionMessage, hash: Hasher): string {
  return hash(`${message.role}\u0000${message.text}\u0000${message.toolUses.map((tool) => tool.tool_use_id).join(',')}\u0000${(message.toolResults ?? []).map((result) => `${result.tool_use_id}:${result.text}`).join(',')}`);
}

export { isSeedMessage };

export interface ExtractorDeps {
  hash: Hasher;
  /** Set false to keep Bash tool results out of capture entirely. Defaults to true. */
  toolOutputNotes?: boolean;
  /** E20 experiment: a per-output keep/drop decision by tool_use_id; `drop` leaves the output out. */
  toolOutputDecision?: (toolUseId: string) => 'keep' | 'drop' | undefined;
  /** E20 experiment: lines a `keep` output contributes (default TOOL_OUTPUT_MAX_LINES). */
  toolOutputKeptLines?: number;
}

export interface ExtractorResult {
  records: CaptureRecord[];
  watermark: ContentWatermark;
}

/**
 * S2 (review-opus-r10.md core/extractor.ts:160): Claude Code's own `/compact`-style command
 * wrapper and local-command-output messages land in the transcript as plain `role: 'user'`
 * messages with no `toolResults`, so without this check they were captured as `kind=user`
 * records (confirmed live in the capture stores, `<command-name>/compact</command-name>` and
 * `<local-command-stdout>Compacted ...</local-command-stdout>`). They are not something the user
 * said, so they must not count as a user message for History (compact.ts's `userHistory`),
 * selector D's `lastUserMessages`, or the B1 constraint extractor, all of which read this same
 * `kind=user` capture record. Matched by the wrapper tag opening the text (case-sensitive, as CC
 * emits them), not by substring anywhere in the text, so a real instruction that merely mentions
 * one of these tag names in prose is not swept up by this check.
 */
const CC_WRAPPER_TAGS = 'command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr|task-notification|system-reminder';
// A block counts only where it opens a line: a user quoting `<system-reminder>` mid-sentence keeps it.
const CC_WRAPPER_LINE_OPEN = new RegExp(`^[ \\t]*<(${CC_WRAPPER_TAGS})>`, 'gm');
const CC_WRAPPER_ADJACENT_OPEN = new RegExp(`[ \\t]*<(${CC_WRAPPER_TAGS})>`, 'y');

/**
 * Removes wrapper blocks that open a line, plus any blocks directly after them on that line.
 * A scan with indexOf rather than a lazy regex (review of 3.10.6): the regex re-scanned to the
 * end of the text for every line opening an unclosed tag, 5.9s on 55k such lines. Once a tag has
 * no closing tag after some position it cannot have one after a later position, so each tag's
 * failed search is remembered and the whole scan stays linear.
 */
function stripWrapperBlocks(text: string): string {
  const noCloseFrom = new Map<string, number>();
  const closeOf = (tag: string, from: number): number => {
    const known = noCloseFrom.get(tag);
    if (known !== undefined && from >= known) return -1;
    const at = text.indexOf(`</${tag}>`, from);
    if (at === -1) noCloseFrom.set(tag, from);
    return at;
  };
  let out = '';
  let kept = 0;
  const open = new RegExp(CC_WRAPPER_LINE_OPEN.source, 'gm');
  for (let match = open.exec(text); match !== null; match = open.exec(text)) {
    let close = closeOf(match[1], match.index + match[0].length);
    if (close === -1) continue;
    let end = close + match[1].length + 3;
    for (;;) {
      CC_WRAPPER_ADJACENT_OPEN.lastIndex = end;
      const next = CC_WRAPPER_ADJACENT_OPEN.exec(text);
      if (!next) break;
      close = closeOf(next[1], end + next[0].length);
      if (close === -1) break;
      end = close + next[1].length + 3;
    }
    const trailing = /^[ \t]*/.exec(text.slice(end, end + 256))?.[0].length ?? 0;
    out += text.slice(kept, match.index);
    kept = end + trailing;
    open.lastIndex = kept;
  }
  return kept === 0 ? text : out + text.slice(kept);
}
const CC_WRAPPER_OPEN = new RegExp(`^\\s*<(?:${CC_WRAPPER_TAGS})>`);
/**
 * S4j: other text Claude Code injects with the user role. Measured on 3 days of real-project
 * transcripts: 114 `<task-notification>`, 131 `<local-command-caveat>`, 76 cross-session
 * messages, plus memory and hook attachments wrapped in `<system-reminder>`. Live seeds showed
 * them as Constraints ("<summary>Background command ... completed</summary>") and Key facts
 * (`<task-id>`, `<output-file>`, memory-file frontmatter). These arrive as a message of their own.
 */
const CC_INJECTED_PREFIX = /^\s*(?:Another Claude session sent a message|\[SYSTEM NOTIFICATION)/;
const CC_INTERRUPT_LINE = /^[ \t]*\[Request interrupted by user[^\]\n]*\][ \t]*$/gm;

/**
 * S4j: a request Claude Code could not complete is saved as an assistant message whose text is the
 * error ("API Error: ... safeguards flagged this message ..."). It is not something the model said;
 * kept, it came back in the next seed's Reasoning (seen live on 2026-09-28).
 */
export function isSyntheticApiError(text: string): boolean {
  return /^\s*API Error:/.test(text);
}

/**
 * The user's own words in a user-role message, with what Claude Code injected removed: wrapper
 * blocks (`<system-reminder>...</system-reminder>` and the rest) and interrupt lines anywhere in
 * the text, since `SessionMessage.text` joins all text blocks and a real prompt may share a
 * message with them (review of 3.10.5). A message that opens with an unclosed wrapper tag, a
 * cross-session message or a system notification is injected as a whole. `''` when nothing is left.
 */
export function userAuthoredText(text: string): string {
  if (CC_INJECTED_PREFIX.test(text)) return '';
  let rest = stripWrapperBlocks(text);
  rest = rest.replace(CC_INTERRUPT_LINE, '');
  if (CC_WRAPPER_OPEN.test(rest)) return '';
  return rest.trim() ? (rest === text ? text : rest.trim()) : '';
}

export function isCcCommandWrapperText(text: string): boolean {
  return userAuthoredText(text) === '';
}

/**
 * S4j read side (review of 3.10.5): capture stores written before 3.10.5 still hold injected
 * user records and API-error placeholders; they are cleaned where the seed reads them, so live
 * sessions heal at their next cut. Returns the record to use, or undefined to skip it.
 */
export function cleanCapturedRecord(record: CaptureRecord): CaptureRecord | undefined {
  if (record.kind === 'work_event' && record.body.type === 'cwd_snapshot' && typeof record.body.path === 'string') {
    return { ...record, body: { ...record.body, path: redactHostPath(record.body.path) } };
  }
  const text = typeof record.body.text === 'string' ? record.body.text : undefined;
  if (text === undefined) return record;
  if (record.kind === 'assistant_text') return isSyntheticApiError(text) ? undefined : record;
  if (record.kind !== 'user') return record;
  const own = userAuthoredText(text);
  if (own === '') return undefined;
  return own === text ? record : { ...record, body: { ...record.body, text: own } };
}

/**
 * Broader secret redaction (round 18, brief-s4a-fix18.md F2, review-opus-r17.md finding F2): the
 * original pattern only caught an OpenAI-shaped `sk-...` key. Added, in the review's own order:
 * GitHub PAT/OAuth tokens, Slack tokens, an AWS access key id, a PEM private-key block, a URL
 * carrying inline `user:pass@` credentials, and a generic `password=`/`secret=`/`token=`/
 * `api_key=`-shaped assignment. The generic-assignment pattern is widened from the review's own
 * literal proposal (`(?:password|...)\s*[:=]\s*\S+`) to allow the keyword to sit inside a longer
 * identifier (`[A-Za-z0-9_]*` on both sides): the review's own worked example,
 * `AWS_SECRET_ACCESS_KEY=...`, does not actually match its own literal proposal, since "secret" in
 * that identifier is not immediately followed by `=` (`_ACCESS_KEY=` sits in between); the widened
 * form catches exactly that shape without changing which sentences match the sk-/ghp_/AKIA/PEM/
 * URL patterns above it.
 *
 * Round 19 (brief-s4a-fix19.md F16, review-opus-r18.md finding F16): the last pattern above was
 * too broad in the other direction -- `[A-Za-z0-9_]*` on *both* sides of the keyword let it match
 * anywhere inside a longer identifier, so `Budget in tokens: 6000.`, `max_tokens: 4096` and
 * `tokenizer: tiktoken` all lost their value to `[redacted]`, and `secretary: Anna Nowak` lost the
 * name (the bare word "secretary" contains "secret" as a prefix). Fixed by anchoring the keyword at
 * its *own* identifier's right edge with `\b` (no suffix wildcard any more): the keyword must be the
 * last word-characters before the `[:=]`, not merely present somewhere inside a longer word.
 * `AWS_SECRET_ACCESS_KEY=...` still matches, now via the added `access[_-]?key` alternative (its own
 * trailing edge lines up on "KEY"), not via "secret" (which no longer reaches the trailing `\b`
 * because `_ACCESS_KEY` follows it). The bare `token` keyword is dropped entirely (it is the one
 * that swallowed "tokens"/"max_tokens"/"tokenizer"); `auth[_-]?token` is added in its place so a
 * real `AUTH_TOKEN=...`/`auth-token: ...` assignment is still caught. This is the review's own
 * proposed regex, used as given.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[abp]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /[\w+.-]{1,32}:\/\/[^\s:@]{1,256}:[^\s@]{1,256}@\S+/g,
  /\b[A-Za-z0-9_]*(?:password|passwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token)\b\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|\S+)/gi,
  // S4o review (3.15.2): shapes that show up in command lines and config edits.
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bgh[opsu]_[A-Za-z0-9]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[\w-]{6,}\.[\w-]{6,}(?:\.[\w-]*)?/g,
  /\b(?:proxy-)?authorization\s*:\s*(?:bearer|basic|token)?\s*[^\s"']+/gi,
  /\bbearer\s+[\w.~+/=-]{8,}/gi,
  /\b[A-Z0-9_]*(?:TOKENS?|SECRET|PASSWORD|PASSWD|PASS|PWD|API_?KEY|PRIVATE_KEY|CREDENTIALS?)\s*=\s*(?!\d+\b)(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|]+)/g,
  /(?<![\w-])--?(?:password|passwd|pass|token|auth-token|access-token|api-key|apikey|secret|client-secret)(?:=|\s+)(?!-)[^\s;&|]+/gi,
  /(?<![\w-])(?:-u|--user)(?:\s+|=)[^\s:]+:[^\s;&|]+/g,
  /\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n|;&]*?\s-p(?!\s)\S+/gi,
  // Quoted JSON/YAML keys (S4p: Bash output such as token endpoint responses).
  /["'][\w -]{0,40}(?:token|secret|password|passwd|passphrase|api[_ -]?key|access[_ -]?key|private[_ -]?key|credentials?)[\w -]{0,40}["']\s*[:=]\s*["'][^"'\n]*["']/gi,
  /\bdefine\s*\(\s*['"][^'"]*(?:PASSWORD|KEY|SALT|SECRET|TOKEN)[^'"]*['"]\s*,\s*['"][^'"]*['"]/gi,
  // 3.17.3 review: header names and CLI password flags are not prose.
  /^[ \t<>*]*(?:set-)?cookie[ \t]*:[ \t]*[^\s=;]+=[^\n]*/gim,
  /\bX-[\w-]*(?:Token|Key|Secret|Auth|Signature)[\w-]*\s*:\s*\S+/gi,
  /\b(?:sshpass|redis-cli|docker\s+login|podman\s+login|mysql|mysqldump)\b[^\n|;&]{0,200}?\s-[pa]\s*(?!-)\S+/gi,
  /\bhooks\.slack\.com\/(?:services|workflows)\/\S+/gi,
  /\bdiscord(?:app)?\.com\/api\/webhooks\/\S+/gi,
  // URL credentials with an empty user (redis://:pw@) or a token as the user. Left-anchored so a long
  // line without separators is not rescanned from every position (review 3.17.0 M3).
  /[\w+.-]{1,32}:\/\/[^\s:@/]{0,256}:[^\s@/]{1,256}@/g,
  /https?:\/\/[^\s:@/]{8,256}@/gi,
];

/**
 * High-entropy fragments (S4o review, 3.15.2): tool activity mines tokens by their "specificity",
 * which is exactly what a random key has. A fragment between separators is dropped when it is hex
 * of 20+ characters (except 40 and 64, git and sha256 hashes) or 16+ characters of mixed case or
 * letters with digits where under half the characters sit in lowercase word runs.
 */
const FRAGMENT_SPLIT = /([\s/.:@=,'"`()[\]{}<>;|&*!?#$%^+\\_-]+)/;

export function isHighEntropyFragment(fragment: string): boolean {
  if (/^[0-9a-fA-F]+$/.test(fragment)) return fragment.length >= 20 && fragment.length !== 40 && fragment.length !== 64;
  if (fragment.length < 16 || !/[A-Za-z]/.test(fragment)) return false;
  if (!/\d/.test(fragment) && !(/[a-z]/.test(fragment) && /[A-Z]/.test(fragment))) return false;
  const wordish = (fragment.match(/[a-z]{3,}/g) ?? []).reduce((sum, run) => sum + run.length, 0);
  return wordish / fragment.length < 0.5;
}

export function redactHighEntropy(text: string): string {
  return text.split(FRAGMENT_SPLIT).map((part, index) => (index % 2 === 0 && isHighEntropyFragment(part) ? '[redacted]' : part)).join('');
}

/**
 * Output-only redaction (review 3.17.0 H2, 3.17.1 review H): `key: value` and `key=value` shapes whose
 * key names a secret. They also appear in ordinary prose and code (`Never bypass:`, `token: string`),
 * so this runs on Bash output and tool errors only, never on user, assistant or edit text.
 * It works line by line with a bounded key, so it is linear. See `secretKeyStrength`: a key counts by its
 * segments (`db_pass`, `"API Token"`, glued `accesstoken`), not when its last segment is a descriptor
 * (`token_type`). Strong keys (password, secret, pin ...) keep only type-like values and member calls
 * visible; weak keys (token, cookie ...) also keep numbers, closed calls and plain paths.
 */
// Key segments (split at `_`, `-`, `.`, spaces and camelCase) that make a key secret. Strong ones keep
// their value hidden even when it looks like a number, a path or a call.
const STRONG_KEY_SEGMENTS = new Set(['pass', 'password', 'passwd', 'passphrase', 'pwd', 'secret', 'secrets', 'credential', 'credentials', 'pin', 'hmac', 'privatekey', 'masterkey', 'encryptionkey', 'signingkey', 'secretkey']);
const WEAK_KEY_SEGMENTS = new Set(['token', 'apikey', 'accesskey', 'accesstoken', 'refreshtoken', 'authtoken', 'cookie', 'salt', 'sessionid', 'sid']);
// Glued keys without a boundary (`dbpass`, `accesstoken`); common words that only end like one stay.
const GLUED_KEY = /(?:password|passwd|pass|pwd|secret|token|apikey|accesskey)$/;
const GLUED_EXEMPT = /(?:by|com|over|sur|tres|under)pass$/;
// A last segment that describes the secret instead of holding it (`token_type`, `secret_name`).
const DESCRIPTOR_SEGMENTS = new Set(['type', 'method', 'url', 'uri', 'endpoint', 'name', 'names', 'domain', 'alg', 'algorithm', 'env', 'policy', 'path', 'file', 'ttl', 'expiry', 'expires', 'in', 'at', 'length', 'len', 'header', 'mode', 'enabled', 'required', 'id', 'count', 'budget', 'limit', 'used', 'max', 'min', 'total', 'version', 'format', 'scope', 'scopes', 'kind', 'source', 'store', 'provider', 'dir', 'location', 'prefix', 'issuer', 'hint', 'rotation', 'age', 'strength', 'reset', 'changed', 'set', 'hash', 'hashed', 'threshold', 'hashers', 'hasher', 'validators', 'rate', 'ratio', 'timeout', 'retries', 'field', 'fields', 'label', 'placeholder']);
const KEY_AT = /(?:"([^"\n]{1,64})"|'([^'\n]{1,64})'|([A-Za-z0-9_.-]{1,64}))[ \t]{0,8}[:=][ \t]{0,8}/g;
const TYPE_VALUE = /^(?:string|number|boolean|bigint|object|null|undefined|none|nil|required|optional|true|false|inherit|\[redacted\]|\*+|x+|\.\.\.|<[^>]*>|\$\{?\w+\}?)$/i;
const MEMBER_CALL = /^(?:[\w$]+\.[\w$.]*\([^)]*\)|[\w$]+\(\))$/;

function keySegments(key: string): string[] {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLocaleLowerCase().split(/[\s_.-]+/).filter(Boolean);
}

/** 'strong', 'weak' or undefined: whether a key names a secret, and how strictly its value is kept. */
export function secretKeyStrength(key: string): 'strong' | 'weak' | undefined {
  const segments = keySegments(key);
  // `pwd` / `OLDPWD` alone is the shell's working directory, not a password.
  if (segments.length === 1 && (segments[0] === 'pwd' || segments[0] === 'oldpwd')) return 'weak';
  if (!segments.length || DESCRIPTOR_SEGMENTS.has(segments[segments.length - 1]) && segments.length > 1) return undefined;
  const pairs = segments.slice(1).map((segment, i) => segments[i] + segment);
  const glued = segments.join('');
  if (segments.some((segment) => STRONG_KEY_SEGMENTS.has(segment)) || pairs.some((pair) => STRONG_KEY_SEGMENTS.has(pair))) return 'strong';
  if (segments.some((segment) => WEAK_KEY_SEGMENTS.has(segment)) || pairs.some((pair) => WEAK_KEY_SEGMENTS.has(pair))) return 'weak';
  if (GLUED_KEY.test(glued) && !GLUED_EXEMPT.test(glued)) return /pass|pwd|secret/.test(glued.slice(-8)) ? 'strong' : 'weak';
  return undefined;
}

function keepsValue(value: string, strength: 'strong' | 'weak'): boolean {
  if (value === '' || TYPE_VALUE.test(value) || MEMBER_CALL.test(value)) return true;
  if (strength === 'strong') return false;
  return /^\d+(?:\.\d+)?(?:ms|s|k|m)?$/i.test(value) || /^[A-Za-z_$][\w$.]*\([^)]*\)$/.test(value) || /^\/[\w.-]+(?:\/[\w.-]+)+$/.test(value);
}

/**
 * 3.17.0's output shapes (review 3.17.3): they also match prose (`Never bypass:`), so they run on Bash
 * output, tool errors and the Bash command line only. Output keeps every shape 3.17.0 redacted; the key
 * scanner below only adds to it. Type-like values stay, as in 3.17.3.
 */
const OUTPUT_PATTERNS: readonly RegExp[] = [
  /\b[A-Za-z0-9_]*(?:token|secret[_-]?key|pass|pwd|credentials?)\b\s*[:=]\s*(?!\d+\b)['"]?[^\s'";&]+/gi,
  /\b(?:set-)?cookie\s*:\s*[^\n]+/gi,
  /<(pass(?:word)?|token|secret|api[_-]?key)>[^<\n]*<\/\1>/gi,
  /\bwhsec_[A-Za-z0-9]{10,}/g,
];

/** A value that reads as a secret in prose: letters with digits, or a long unbroken run. */
function secretLooking(value: string): boolean {
  return value.length >= 6 && ((/\d/.test(value) && /[A-Za-z]/.test(value)) || (value.length >= 16 && !/\s/.test(value)));
}

function readValue(text: string, start: number): string {
  const quote = text[start];
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, start + 1);
    const newline = text.indexOf('\n', start + 1);
    return end > start && (newline < 0 || end < newline) ? text.slice(start, end + 1) : '';
  }
  return /^[^\s'";&]+/.exec(text.slice(start, start + 512))?.[0] ?? '';
}

/**
 * Key/value scanner (3.17.3 review HIGH): a key that is not secret does not swallow its value, so
 * `app.yml:3:token: x`, `?page=2&token=x` and `a=1&session_token=x` reach the secret key. In `output`
 * mode a secret key hides every value but type-like ones (see keepsValue). In `prose` mode (user,
 * assistant, edits) it hides only quoted values, `UPPER_SNAKE=value` assignments and values that look like
 * secrets, so `Never bypass: the gate` and `token: string` stay.
 */
export function redactKeyValues(text: string, mode: 'output' | 'prose'): string {
  let out = '';
  let from = 0;
  KEY_AT.lastIndex = 0;
  for (let match = KEY_AT.exec(text); match; match = KEY_AT.exec(text)) {
    const key = match[1] ?? match[2] ?? match[3] ?? '';
    const start = match.index + match[0].length;
    KEY_AT.lastIndex = start;
    const strength = secretKeyStrength(key);
    if (!strength) continue;
    const value = readValue(text, start);
    const quoted = value.startsWith('"') || value.startsWith("'");
    const bare = value.replace(/^["']|["']$/g, '').replace(/,$/, '');
    if (!bare || keepsValue(bare, strength)) continue;
    // `pin` is also an ordinary word (`pin: keep node 20 pinned`): only a numeric PIN or a secret-looking value counts.
    const pin = /(?:^|[_.\s-])pin$/i.test(key);
    const numericPin = pin && /^\d{4,8}$/.test(bare);
    if (pin && !numericPin && !secretLooking(bare)) continue;
    const assignment = /^[A-Z][A-Z0-9_]*$/.test(key) && match[0].trimEnd().endsWith('=');
    if (mode === 'prose' && !quoted && !assignment && !numericPin && !secretLooking(bare)) continue;
    out += `${text.slice(from, match.index)}[redacted]${value.endsWith(',') ? ',' : ''}`;
    from = start + value.length;
    KEY_AT.lastIndex = from;
  }
  return out + text.slice(from);
}

/** Output-only redaction of one line or piece (no high-entropy pass): 3.17.0 shapes plus the key scanner. */
export function redactOutputLine(line: string): string {
  // A type-like value (`token: string`, `token: undefined`) is code, not a secret.
  const safe = OUTPUT_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, (match) => {
    const value = /^[A-Za-z0-9_]+\s*[:=]\s*['"]?([^\s'";&<]+)$/.exec(match)?.[1]?.replace(/[,;)}\]]+$/, '');
    return value && keepsValue(value, 'strong') ? match : '[redacted]';
  }), line);
  return redactKeyValues(safe, 'output');
}

/** Shared redaction plus the output-only shapes, for Bash output, tool errors and Bash command lines. */
export function redactOutputText(text: string): string {
  return redactCapturedText(text, 'output');
}

/**
 * Line-local patterns run per piece of at most REDACT_PIECE characters (a line, or a long line cut at
 * whitespace), so a pattern that backtracks costs at most quadratic in the piece, and the whole pass is
 * linear in the text (3.17.1 review: a 512 KB user message took 40 s). Only the PEM pattern spans
 * lines, and it runs on the whole text first.
 */
const REDACT_PIECE = 4096;
const PEM_BEGIN = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z ]{0,40}PRIVATE KEY-----/g;

/** PEM private keys, BEGIN to the next END, in one linear pass (the lazy regex was quadratic without END). */
function redactPem(text: string): string {
  let out = '';
  let from = 0;
  PEM_BEGIN.lastIndex = 0;
  for (let begin = PEM_BEGIN.exec(text); begin; begin = PEM_BEGIN.exec(text)) {
    PEM_END.lastIndex = begin.index + begin[0].length;
    const end = PEM_END.exec(text);
    if (!end) break;
    out += `${text.slice(from, begin.index)}[redacted]`;
    from = end.index + end[0].length;
    PEM_BEGIN.lastIndex = from;
  }
  return out + text.slice(from);
}

/** Cut point for a long line: the last separator in the second half that does not follow `:` or `=`. */
function pieceCut(line: string): number {
  for (let i = REDACT_PIECE; i > REDACT_PIECE / 2; i -= 1) {
    if (' \t;,&|'.includes(line[i]) && !':= \t'.includes(line[i - 1])) return i;
  }
  return REDACT_PIECE;
}

function redactPieces(text: string, apply: (piece: string) => string): string {
  return text.split('\n').map((line) => {
    if (line.length < 5) return line;
    if (line.length <= REDACT_PIECE) return apply(line);
    const pieces: string[] = [];
    let rest = line;
    while (rest.length > REDACT_PIECE) {
      const at = pieceCut(rest);
      pieces.push(apply(rest.slice(0, at)));
      rest = rest.slice(at);
    }
    pieces.push(apply(rest));
    return pieces.join('');
  }).join('\n');
}

export function redactCapturedText(text: string, mode: 'output' | 'prose' = 'prose'): string {
  const safe = redactPieces(redactPem(text), (piece) => {
    const shared = SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[redacted]'), piece);
    return mode === 'output' ? redactOutputLine(shared) : redactKeyValues(shared, 'prose');
  });
  const final = redactHighEntropy(safe);
  return final.length <= 50000 ? final : `${final.slice(0, 49988)}\n[truncated]`;
}

/** Host-provided directory/probe paths keep random temp names readable while still masking secrets. */
export function redactHostPath(text: string): string {
  const safe = redactPieces(redactPem(text), (piece) => SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[redacted]'), piece));
  return safe.replace(/(https?:\/\/)(?:[^\s/@]+@)/gi, '$1');
}

const redact = redactCapturedText;

/**
 * Secret-looking path denylist (round 18, brief-s4a-fix18.md F2, review-opus-r17.md finding F2):
 * a `Write`/`Edit` targeting one of these is not captured at all (see `writtenTextFromToolUse`
 * below), matched against the path's basename only, so a project directory that happens to be
 * named e.g. `secrets-ui/` does not blanket-deny every file under it.
 *
 * Round 19 (brief-s4a-fix19.md F11, review-opus-r18.md finding F11): `id_[rd]sa` only ever matched
 * `id_rsa`/`id_dsa`, missing an OpenSSH `id_ed25519` or `id_ecdsa` key entirely (GATE.md previously
 * claimed `id_ed25519` was covered; it was not, and no test caught the gap -- see the corrected
 * GATE.md round-18 entry). The review's own proposed replacement, `^id_[a-z0-9]+(?!\.pub$)`, is
 * rejected, not used as given: verified in a real `node -e` run (`/^id_[a-z0-9]+(?!\.pub$)/.test('id_rsa.pub')`
 * returns `true`), the pattern's own backtracking finds the shorter match `id_rs`, which sits before
 * the `.pub` suffix and so never triggers the negative lookahead, so it still flags a `.pub` file it
 * was meant to exempt. Kept simple instead: name every key type explicitly with a trailing `\b`
 * (matching both the bare key and its `.pub` counterpart, same as the pre-existing `id_[rd]sa`
 * behavior, which already made no private/public distinction). Also added, per the review's own
 * "also missing" list: `.pgpass`, `*.keystore`, a `token*.txt` file, and a `service-account*.json`
 * file.
 */
const SECRET_LIKE_PATH_PATTERN =
  /^\.env|\.(pem|key|p12|pfx|pgpass|keystore)$|\bid_(rsa|dsa|ecdsa|ed25519)\b|credential|secret|\.npmrc|\.netrc|settings(\.local)?\.json$|^token.*\.txt$|^service-account.*\.json$/i;

function basenameOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : filePath;
}

/** Directories whose files are credentials whatever their name (S4o review, 3.15.2). */
const SECRET_LIKE_DIR_PATTERN = /(?:^|\/)(?:\.aws|\.kube|\.docker|\.ssh|\.gnupg|\.config\/(?:gh|gcloud))\//i;
const SECRET_LIKE_EXTRA_BASENAME = /^tokens?(?:[._-][\w.-]*)?\.(?:json|txt|ya?ml|env)$|^hosts\.ya?ml$/i;

export function isSecretLikePath(filePath: string): boolean {
  const base = basenameOf(filePath);
  return SECRET_LIKE_PATH_PATTERN.test(base) || SECRET_LIKE_EXTRA_BASENAME.test(base) || SECRET_LIKE_DIR_PATTERN.test(filePath.replace(/\\/g, '/'));
}

/**
 * Prose-only filter (round 18, brief-s4a-fix18.md F3, review-opus-r17.md finding F3): a Write/Edit
 * capture is only useful as a key-facts source (spec v3.3 §3.1.3) when it reads like prose, not
 * source code -- a code file's text is reachable via the transcript pointer already if it is ever
 * needed, and mining it for "sentences" produces noise, not facts. Accepted outright only when the
 * target's own extension says it is prose-shaped (`.md`/`.txt`/`.rst`); every other case, including
 * a path-less write, an extensionless file (`Makefile`, `Dockerfile`, a bare repo `NOTES`/`TODO`
 * file) and a recognized-but-not-prose extension, falls back to the same per-line content check,
 * rejecting when any single line looks code-shaped (an import/export/declaration keyword, a
 * trailing `;`/`{`/`}`, or a SCREAMING_CASE assignment).
 *
 * Round 19 (brief-s4a-fix19.md F12, review-opus-r18.md finding F12): before this round,
 * `!hasKnownExtension` short-circuited straight to `return true` for a path-less or extensionless
 * write, skipping the content check entirely -- a code-shaped `Makefile`/`Dockerfile`, or content
 * that plainly looks like code sent with no `file_path` at all, was always captured. The extension
 * allowlist now only ever grants an early, unconditional pass; everything else runs the same
 * per-line check a recognized-but-non-prose extension already ran.
 */
const PROSE_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'txt', 'rst']);
/** Config formats are key/value data, never prose, whatever their lines look like (S4o review, 3.15.2). */
const CONFIG_EXTENSIONS: ReadonlySet<string> = new Set(['yaml', 'yml', 'json', 'jsonc', 'toml', 'ini', 'env', 'conf', 'cfg', 'properties', 'xml', 'plist', 'tfvars']);
const CODE_SHAPED_LINE = /^\s*(import|export|const|let|var|function|class|def|return|#include)\b|[;{}]\s*$|^[A-Z0-9_]+=/;

export function isProseLikeWrite(filePath: string | undefined, content: string): boolean {
  const extension = filePath ? basenameOf(filePath).split('.').pop() : undefined;
  const hasKnownExtension = filePath !== undefined && basenameOf(filePath).includes('.');
  if (hasKnownExtension && extension !== undefined && PROSE_EXTENSIONS.has(extension.toLowerCase())) return true;
  if (hasKnownExtension && extension !== undefined && CONFIG_EXTENSIONS.has(extension.toLowerCase())) return false;
  return !content.split('\n').some((line) => CODE_SHAPED_LINE.test(line));
}

/**
 * Per-write character cap (round 18, brief-s4a-fix18.md F2/F3: "a 4k-character cap per write"),
 * independent of and much tighter than `redact`'s own 50000-char truncation (that one bounds a
 * single capture record's overall size across every kind, this one specifically bounds how much of
 * one Write/Edit's content this section is willing to treat as a key-facts source at all).
 *
 * Round 19 (brief-s4a-fix19.md F11, review-opus-r18.md finding F11): must run on already-redacted
 * text, never the reverse. Redaction's own PEM pattern is `-----BEGIN...-----END...-----`, requiring
 * both markers to be present in the text it scans; a PEM block pasted inside a `.md` file longer
 * than 4000 characters used to get capped *first* (`writtenTextFromToolUse` below called
 * `capFileWriteText(field)` and only the caller applied `redact` afterward), which could cut the
 * text off before `-----END...-----` ever appeared, so the PEM pattern never matched and the key
 * body was stored verbatim. See `writtenTextFromToolUse`, which now redacts before capping.
 */
const MAX_FILE_WRITE_CHARS = 4000;

function capFileWriteText(text: string): string {
  return text.length <= MAX_FILE_WRITE_CHARS ? text : `${text.slice(0, MAX_FILE_WRITE_CHARS - 12)}\n[truncated]`;
}

/**
 * Spec v3.3 §3.1.3 (round 17, brief-s4a-fix17.md): key-facts extraction's second source, "short
 * text the session itself wrote to files via Write/Edit tool_use inputs" -- the A/B puts some
 * facts in notes files the model itself writes mid-session. This reads the tool_use *input* the
 * assistant sent (what it asked to be written), never a tool *result* (what a Read/Grep call
 * gives back): a result is reachable through the transcript pointer already (spec §3.1.2) and the
 * brief is explicit that results are not a source here. `Write`'s own new content is `input.content`;
 * `Edit`'s is `input.new_string` (the replacement text, not `old_string`, which is what the file
 * already had before this call and so is not new information this session is adding).
 */
const WRITE_EDIT_FACT_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit']);

function writtenTextFromToolUse(use: SessionMessage['toolUses'][number]): string | undefined {
  if (!WRITE_EDIT_FACT_TOOLS.has(use.tool)) return undefined;
  const input = use.input as Record<string, unknown> | undefined;
  if (!input) return undefined;
  const filePath = typeof input.file_path === 'string' ? input.file_path : undefined;
  // Round 18 (brief-s4a-fix18.md F2): a secret-looking target is skipped before its content is
  // even looked at -- nothing from a denied path reaches a capture record, the seed, or anywhere
  // else this module writes to, regardless of what the content-based checks below would have said.
  if (filePath !== undefined && isSecretLikePath(filePath)) return undefined;
  const field = use.tool === 'Write' ? input.content : input.new_string;
  if (typeof field !== 'string' || field.length === 0) return undefined;
  // Round 18 (brief-s4a-fix18.md F3): a non-prose target's content is rejected outright, not
  // truncated or redacted -- redaction only strips a handful of known secret *shapes*, it is not a
  // general defence against an arbitrary code file's contents (env-var defaults, connection
  // strings assembled at runtime, ...) ending up mined as "facts".
  if (!isProseLikeWrite(filePath, field)) return undefined;
  // Round 19 (brief-s4a-fix19.md F11): redact the FULL field before the 4000-char cap runs, not
  // after -- see the doc comment on `MAX_FILE_WRITE_CHARS` above. The caller (`reconcile`) no longer
  // redacts this value a second time; it is already redacted here.
  return capFileWriteText(redact(field));
}

/**
 * Names a code edit declares (S4o review, 3.15.2). Code content is not mined wholesale: string
 * literals and values are where keys and connection strings live, and redaction only knows shapes.
 * Prose edits (the same test the file_write capture uses) are mined for every specific token.
 */
const DECLARED_NAME_PATTERNS: readonly RegExp[] = [
  /\b(?:function\*?|class|interface|type|enum|const|let|var|def|fn|struct|trait|namespace|module)\s+([A-Za-z_$][\w$]*)/g,
  /^[ \t]*(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^()\n]*\)\s*(?::[^{\n]*)?\{/gm,
  /\b(?:table|column|index|view)\s+(?:if\s+not\s+exists\s+)?([A-Za-z_][\w.]*)/gi,
];
const CONTROL_WORDS: ReadonlySet<string> = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with']);

function declaredNames(code: string): string[] {
  const names: string[] = [];
  for (const pattern of DECLARED_NAME_PATTERNS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(code); match !== null; match = pattern.exec(code)) {
      if (match[1].length >= 3 && !CONTROL_WORDS.has(match[1])) names.push(match[1]);
    }
  }
  return names;
}

const isPathToken = (token: string): boolean => token.includes('/') || /\.[a-z]{1,5}$/i.test(token);
const safeToken = (token: string): boolean => !token.includes('[redacted]') && !token.split(FRAGMENT_SPLIT).some((part, index) => index % 2 === 0 && isHighEntropyFragment(part));
/** Redaction runs on the whole text before anything is cut (round 19 F11 applies here too). */
const safeLine = (text: string, maxChars: number): string => redactHighEntropy(redact(text)).split(/\r?\n/, 1)[0].trim().slice(0, maxChars);

export function toolActivityText(use: SessionMessage['toolUses'][number]): string | undefined {
  const input = use.input as Record<string, unknown> | undefined;
  if (!input) return undefined;
  if (use.tool === 'Bash') {
    if (typeof input.command !== 'string') return undefined;
    return `$ ${safeLine(input.command, 200)}`;
  }
  const filePath = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : '';
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(use.tool)) {
    // A secret-looking target keeps only its path: its content never reaches identifier mining.
    if (isSecretLikePath(filePath)) return `edit ${filePath}`;
    const edits = use.tool === 'MultiEdit' && Array.isArray(input.edits)
      ? input.edits.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      : [input];
    const changed = new Set<string>();
    for (const edit of edits) {
      const nextField = [edit.new_string, edit.content, edit.new_source].find((value): value is string => typeof value === 'string') ?? '';
      // Redact before mining identifiers, so a secret value cannot survive as a token.
      const next = redact(nextField.slice(0, 20000));
      const old = redact(typeof edit.old_string === 'string' ? edit.old_string : '');
      const oldTokens = new Set([...specificTokens(old), ...declaredNames(old).map((name) => name.toLocaleLowerCase())]);
      const mined = isProseLikeWrite(filePath || undefined, next)
        ? specificTokenList(next.slice(0, 4000))
        : [...declaredNames(next), ...specificTokenList(next.slice(0, 4000)).filter(isPathToken)];
      for (const token of mined) if (!oldTokens.has(token.toLocaleLowerCase()) && safeToken(token)) changed.add(token);
    }
    const rank = (token: string): number => (/^[\d.,:%\s]+[a-z%]*$/i.test(token) ? 2 : token.includes('/') ? 1 : 0);
    const ordered = [...changed].map((token, index) => ({ token, index })).sort((a, b) => rank(a.token) - rank(b.token) || a.index - b.index);
    return ordered.length ? `edit ${filePath}: ${ordered.slice(0, 25).map((item) => item.token).join(' ')}` : `edit ${filePath}`;
  }
  if (use.tool === 'Read') return `read ${filePath}`;
  if (use.tool === 'Grep' || use.tool === 'Glob') {
    const pattern = typeof input.pattern === 'string' ? safeLine(input.pattern, 80) : '';
    const searchPath = typeof input.path === 'string' ? input.path : filePath;
    return `search ${pattern} in ${searchPath}`;
  }
  return undefined;
}

/**
 * Commands whose output commonly contains credentials or private configuration (S4p; rewritten in
 * 3.17.1 after review H1). 3.16.1 matched unanchored regexes with nested lazy scans, which took cubic
 * time on long commands (64 KB: 473 s, synchronously in the hook). Now the command is capped at 4 KB,
 * split into segments at shell separators and each segment into words, and the rules below look at
 * words only: linear in the command length.
 *
 * "Command position" is the first word of a segment, or the word after a wrapper (`sudo`, `exec`,
 * `bash -lc`, `ssh host` ...). `env` and `history` count only there, so `python -m venv env` or
 * `grep -r history src` keep their output (review L3). A false match only drops one result's lines.
 */
const COMMAND_SCAN_LIMIT = 4096;
// Words after which the next non-flag word runs as a command (sudo -u root env, timeout 5 printenv).
const WRAPPERS = new Set(['sudo', 'doas', 'su', 'runuser', 'command', 'exec', 'nohup', 'time', 'nice', 'ionice', 'timeout', 'stdbuf', 'setsid', 'chroot', 'unbuffer', 'strace', 'xargs', 'watch', 'env', 'eval', 'bash', 'sh', 'zsh', 'dash', 'fish', 'ssh', '--', 'busybox', 'run', 'exec', 'dotenv', 'with-env', 'op']);
// Shell words that start a command without being one (FOO=1 env, then env, ! env).
const SHELL_KEYWORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'coproc']);
const SECRET_VAR = /\$\{?[A-Za-z0-9_]*(?:PASS|PWD|SECRET|TOKEN|KEY|CREDENTIAL|AUTH)[A-Za-z0-9_]*/i;
const SECRET_FILE_NEEDLES = ['.env', 'id_rsa', 'id_ed25519', '.pem', 'credentials', '.ssh/', '.aws/', '.kube/', 'tokens.json', '.pypirc', '.netrc', '.npmrc', '.m2/settings.xml', 'terraform.tfstate', '/etc/environment', '/etc/shadow', '.config/'];

function commandWords(segment: string): string[] {
  return segment.split(/[\s"'`()[\]{}<>=]+/).filter(Boolean).map((word) => word.toLocaleLowerCase());
}

function baseName(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1);
}

/**
 * Words that may run as a command in one segment: the first word after assignments and shell keywords,
 * and every word after a wrapper (so `sudo -u root env` and `ssh -p 22 prod env` count; a false match
 * only drops one result's lines). Quotes and backslashes are removed first (`'e'nv`).
 */
function commandPositions(segment: string): string[] {
  // Quoted words stay whole (`FOO="a b" env`), then quotes and backslashes go (`'e'nv`).
  const tokens = (segment.match(/(?:[^\s"']+|"[^"]*"?|'[^']*'?)+/g) ?? []).map((token) => baseName(token.replace(/['"\\]/g, '').toLocaleLowerCase())).filter(Boolean);
  const out: string[] = [];
  let first = true;
  let wrapped = false;
  for (const token of tokens) {
    if (first && (SHELL_KEYWORDS.has(token) || /^[a-z_][a-z0-9_]*=/.test(token))) continue;
    if (first || wrapped) out.push(token);
    if (WRAPPERS.has(token)) wrapped = true;
    first = false;
  }
  return out;
}

function segmentIsSensitive(segment: string, words: readonly string[]): boolean {
  const has = (word: string) => words.includes(word);
  const any = (list: readonly string[]) => list.some(has);
  const commands = commandPositions(segment);
  const at = (word: string) => commands.includes(word);
  const programs = new Set(words.map(baseName));
  const program = (word: string) => programs.has(word);
  if (commands.some((word) => word === 'env' || word === 'printenv' || word === 'history')) return true;
  // A bare `set` or `export` as the last command word dumps variables (`bash -c set`).
  if (commands.length && ['set', 'export', 'declare', 'typeset'].includes(commands[commands.length - 1]) && words[words.length - 1] === commands[commands.length - 1]) return true;
  if (words.length === 1 && ['set', 'export', 'declare', 'typeset', 'env', 'printenv'].includes(words[0])) return true;
  if ((at('export') && has('-p')) || ((at('declare') || at('typeset')) && words.some((word) => /^-[a-z]*[xp]/.test(word)))) return true;
  if ((at('fc') && has('-l')) || (at('compgen') && has('-v')) || (at('launchctl') && has('getenv')) || (at('systemctl') && has('show-environment'))) return true;
  if ((at('echo') || at('printf')) && SECRET_VAR.test(segment)) return true;
  if (words.some((word) => word.endsWith('_history') || word.includes('/proc/') && word.endsWith('/environ'))) return true;
  // 3.17.3 review: platform CLIs that print env files and script one-liners that print ENV.
  if (any(['vercel', 'netlify', 'cf', 'fly', 'flyctl', 'render', 'eb', 'amplify']) && words.some((word) => word === 'env' || word.startsWith('env:') || word === 'printenv' || word === 'secrets')) return true;
  if (program('infisical') || program('chamber') || program('envchain') || program('dotenvx')) return true;
  if (any(['ruby', 'python', 'python3', 'node', 'perl', 'php', 'deno', 'bun']) && any(['-e', '-c', '-r', 'eval']) && words.some((word) => /\b(?:env|environ|getenv)\b/i.test(word))) return true;
  // Variables assigned in the same command were substituted before (`E=env; $E`). An unresolved one is
  // not a skip reason: segments are not quote-aware, so `echo "$n $(stat) $f"` would end in a bare `$f`.
  if (program('git') && ((has('config') && words.some((word) => word.startsWith('--get') || word === '-l' || word === '--list')) || has('credential'))) return true;
  if (program('gh') && has('auth') && (has('token') || has('--show-token') || has('-t'))) return true;
  if (program('aws') && (any(['configure', 'sts', 'secretsmanager']) || (has('ssm') && words.some((word) => word.startsWith('get-parameter'))))) return true;
  if (program('kubectl') && (has('exec') || ((has('get') || has('describe')) && (has('secret') || has('secrets'))) || (has('get') && (any(['-oyaml', '-ojson']) || ((has('-o') || has('--output')) && any(['yaml', 'json'])))))) return true;
  if (program('docker') && (any(['inspect', 'exec', 'login']) || (has('compose') && any(['config', 'exec'])))) return true;
  if (program('docker-compose') && any(['config', 'exec'])) return true;
  if (program('helm') && has('get') && has('values')) return true;
  if (program('supabase') && has('status')) return true;
  if (program('heroku') && (has('config') || has('auth:token'))) return true;
  if (program('railway') && has('variables')) return true;
  if (program('terraform') && any(['output', 'show', 'state'])) return true;
  if (program('ansible-vault') || program('sops') && has('-d')) return true;
  if ((program('gpg') || program('age')) && any(['-d', '--decrypt'])) return true;
  if (program('openssl') && any(['genrsa', 'genpkey', 'req', 'rsa', 'pkey'])) return true;
  if (program('ssh-keygen') && has('-y')) return true;
  if (program('security') && words.some((word) => /^find-(?:generic|internet)-password$/.test(word))) return true;
  if (program('gcloud') && has('auth') && words.some((word) => /^print-(?:access|identity)-token$/.test(word))) return true;
  if (program('az') && has('get-access-token')) return true;
  if (program('op') && (has('read') || (has('item') && has('get')))) return true;
  if (program('vault') && (has('read') || (has('kv') && has('get')))) return true;
  if (program('npm') && ((has('config') && has('get')) || has('token'))) return true;
  if (program('doppler') && has('secrets')) return true;
  if (at('pass') && has('show')) return true;
  if (program('keyring') && has('get')) return true;
  if (program('base64') && any(['-d', '--decode'])) return true;
  if (at('xxd') || at('hexdump')) return true;
  if (at('ps') && words.slice(words.indexOf('ps') + 1).some((word) => word === 'e' || (!word.startsWith('-') && /^[a-z]*e[a-z]*$/.test(word) && word.length <= 6))) return true;
  return false;
}

/** `G=~/.local/bin/gh; $G api` reads as `~/.local/bin/gh api`, and `E=env; $E` as `env`. */
function substituteVariables(command: string): string {
  const values = new Map<string, string>();
  for (const match of command.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w{0,63})=("[^"\n]{0,256}"|'[^'\n]{0,256}'|[^\s;&|()]{0,256})/g)) values.set(match[1], match[2].replace(/^["']|["']$/g, ''));
  if (!values.size) return command;
  return command.replace(/\$\{?([A-Za-z_]\w{0,63})\}?/g, (whole, name: string) => values.get(name) ?? whole);
}

export function shouldSkipToolOutput(command: string): boolean {
  const scanned = substituteVariables(command.slice(0, COMMAND_SCAN_LIMIT));
  const lowered = scanned.toLocaleLowerCase();
  if (SECRET_FILE_NEEDLES.some((needle) => lowered.includes(needle))) return true;
  // `$(...)`, backticks, `<(...)` and parentheses open a new command as well.
  const segments = scanned.split(/&&|\|\||[;|&\n`()]/);
  for (const segment of segments) {
    const words = commandWords(segment);
    if (words.some((word) => isSecretLikePath(word))) return true;
    if (segmentIsSensitive(segment, words)) return true;
  }
  // A command longer than the scan limit is not trusted: its tail was never looked at.
  return command.length > COMMAND_SCAN_LIMIT;
}

const OUTPUT_ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;

/**
 * Lines a Bash output keeps (3.17.5). E20 replay: 30 lines instead of 10 raised used-item coverage
 * 62.5 -> 62.8% at default budgets and 54.7 -> 55.4% at an 8k seed; the dense selector still picks.
 */
export const TOOL_OUTPUT_MAX_LINES = 30;

function toolOutputLines(text: string, maxLines = TOOL_OUTPUT_MAX_LINES): string[] {
  const chunk = text.slice(0, 64 * 1024).replace(OUTPUT_ANSI, '');
  // Redact before filtering/cutting lines: in particular, PEM markers can straddle the first ten.
  const safe = redactOutputText(chunk);
  // A key cut off before its END line (head -5 deploy_key) is not matched by the PEM pattern.
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(safe)) return [];
  return safe.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length >= 8 && line.length <= 300).slice(0, maxLines);
}

/**
 * Reconciliation extractor (spec §3.2): runs over `messages` newer than `watermark` and adds
 * what per-turn capture missed. Must:
 * - skip any message `isSeedMessage()` (never re-captures a seed as user origin);
 * - read tool-result `text`, never `result` (headless Bash blanks `result`);
 * - be idempotent: running it twice over the same messages from the same watermark yields
 *   the same records, and running it again from the resulting watermark yields none;
 * - survive two compactions plus a restart (only `watermark` persists between calls, so this
 *   must hold with a fresh `ExtractorDeps` and no other state).
 */
/**
 * Round 8 findings 1/2: `identities` holds up to this many trailing content identities, oldest
 * first. 1 collides on any repeated short closer ("Done.", "ok"); a run of 3 consecutive turns
 * (typically alternating user/assistant, so it also pins down role shape) is specific enough
 * that recurring it by coincidence elsewhere in a real session is vanishingly unlikely, while
 * still being short enough that it is almost always fully present in whatever a compaction (S4's
 * own tail, or core's "kept messages") preserves verbatim. Kept as a named constant, not
 * hardcoded at each call site, so `compact.ts` can derive a watermark from its own returned list
 * with the exact same rule `reconcile` uses to consume one.
 */
export const WATERMARK_SEQUENCE_LENGTH = 3;

/**
 * The occurrence (1-based) of `identities[index]` among `identities[0..index]`. No longer part
 * of watermark matching (round 8 findings 1/2 replaced that with the identity sequence above);
 * kept only to key `sourceHash` (below), so two messages sharing one content identity still get
 * distinct, stable, idempotent capture keys.
 */
function occurrencesOf(identities: readonly string[]): number[] {
  const seen = new Map<string, number>();
  return identities.map((identity) => {
    const occurrence = (seen.get(identity) ?? 0) + 1;
    seen.set(identity, occurrence);
    return occurrence;
  });
}

/**
 * Where `watermark.identities` sits in `identities`: the earliest position the whole sequence
 * occurs at, read end-anchored (a candidate position is "the sequence's last message is here",
 * checked against the `sequence.length` identities ending there), tried oldest-window-first.
 * Returns the index of the sequence's last message, or -1 if the whole sequence does not occur
 * anywhere (the caller then knows the watermark's list is gone, not merely stale at one position:
 * either a fork boundary or a core compaction).
 *
 * Earliest, not most recent: with a genuinely growing transcript the old list is a prefix of the
 * new one, so the true boundary is the *first* (oldest) place the sequence matches; a build-up of
 * plain content past it can coincidentally reproduce a short sequence again later (round 6 D1's
 * repeated "Done."), and preferring that later match, as a naive `lastIndexOf` on a single
 * identity would, is exactly the bug: it treats the coincidence as the boundary and skips
 * everything genuinely new in between as already captured (round 8 finding 1's repro loses a
 * `VALUE` this way). `WATERMARK_SEQUENCE_LENGTH` mostly prevents the coincidence from being
 * possible at all; this tie-break is what makes the answer still correct on the rare list short
 * enough that it cannot (fewer than `WATERMARK_SEQUENCE_LENGTH` messages exist yet, so the stored
 * sequence itself is shorter, e.g. length 1).
 */
function findWatermarkIndex(identities: readonly string[], watermark: ContentWatermark): number {
  const sequence = watermark.identities;
  if (!sequence.length) return -1;
  for (let end = sequence.length; end <= identities.length; end += 1) {
    let matched = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (identities[end - sequence.length + offset] !== sequence[offset]) { matched = false; break; }
    }
    if (matched) return end - 1;
  }
  return -1;
}

function sequenceWatermark(identities: readonly string[]): ContentWatermark {
  return { identities: identities.slice(-WATERMARK_SEQUENCE_LENGTH) };
}

/**
 * Round 7 D5: `--fork-session` gets a new session id, so its capture store has no watermark at
 * all (not "stale", genuinely `null`) even though `messages` is the whole resumed transcript,
 * not a fresh session. Without a boundary, a null-watermark reconcile starts at index 0 (correct
 * for an actually-new session) and would instead re-capture the entire parent conversation as
 * brand-new records under the fork's own store. The seed sentinel is the only structural marker
 * this module owns for "an S4 compaction happened here": the last seed message in the list is
 * treated as the boundary, and nothing at or before it is captured. A bare core-fallback summary
 * with no seed anywhere (S4 never ran before the fork) has no equivalent marker, since its text
 * is arbitrary and not owned by this module; that case is not detected here and is a known,
 * documented gap (see round 7 report), not a silent guess.
 */
function lastSeedBoundaryIndex(messages: readonly SessionMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isSeedMessage(messages[index])) return index;
  }
  return -1;
}

export function reconcile(
  messages: readonly SessionMessage[],
  watermark: ContentWatermark | null,
  deps: ExtractorDeps,
): ExtractorResult {
  const identities = messages.map((message) => contentIdentity(message, deps.hash));
  const occurrences = occurrencesOf(identities);
  /**
   * Round 8 findings 1/2 (supersedes round 7 N2's occurrence-based description):
   * - `watermark === null`: no capture state at all, the round 7 D5 fork case; the last seed
   *   message, if any, is the boundary (see `lastSeedBoundaryIndex`).
   * - `watermark` given and its identity sequence is found in `messages`: that is the boundary,
   *   wherever it now sits, whether this list is a plain growing transcript or one where a
   *   compaction preserved that exact tail (in which case `compact.ts` already re-derived the
   *   watermark from its own returned list, so the sequence is found right where it left off).
   * - `watermark` given but its sequence is nowhere in `messages`: the runtime's real call
   *   sequence never gives a separate reconcile call over just a bare core-fallback shape before
   *   the next turn's content arrives; the discarded core summary and any genuinely new content
   *   (a VALUE, a prompt) are in `messages` together, in one call. `messages[0]` is treated as
   *   that boundary (core's synthetic replacement) and is never captured; everything after it is
   *   processed exactly as if the watermark had pointed at `messages[0]`, so content newly
   *   appended in this same call is still captured, not lost.
   */
  let lastWatermarkIndex: number;
  if (watermark === null) {
    lastWatermarkIndex = lastSeedBoundaryIndex(messages);
  } else {
    const found = findWatermarkIndex(identities, watermark);
    lastWatermarkIndex = found === -1 ? 0 : found;
  }
  const records: CaptureRecord[] = [];
  const bashCommands = new Map<string, string>();
  for (let index = lastWatermarkIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (isSeedMessage(message)) continue;
    for (const use of message.toolUses) {
      const input = use.input as Record<string, unknown> | undefined;
      if (use.tool === 'Bash' && typeof input?.command === 'string') bashCommands.set(use.tool_use_id, input.command);
    }
  }
  const capturedWorkEvents = workEventsByMessage(messages.slice(lastWatermarkIndex + 1)).map(({ messageIndex, event }) => ({ messageIndex: messageIndex + lastWatermarkIndex + 1, event }));
  const eventOrdinal = new Map<number, number>();
  for (const { messageIndex, event } of capturedWorkEvents) {
    const index = messageIndex;
    const sourceHash = `${identities[index]}#${occurrences[index]}`;
    const ordinal = eventOrdinal.get(messageIndex) ?? 0;
    eventOrdinal.set(messageIndex, ordinal + 1);
    records.push({ kind: 'work_event', origin: 'reconcile', producedBy: 's4-capture', sourceHash: `${sourceHash}:ws:${ordinal}`, body: event });
  }
  const valuePattern = /^VALUE key=([^:]+):\s*(.*)$/s;
  const todoPattern = /^TODO id=([^\s]+)(?: status=([^\s]+))?( CLEARED)?$/;
  for (let index = lastWatermarkIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (isSeedMessage(message)) continue;
    const sourceHash = `${identities[index]}#${occurrences[index]}`;
    if (message.role === 'user') {
      const value = valuePattern.exec(message.text);
      const todo = todoPattern.exec(message.text);
      if (message.text && (message.toolResults ?? []).length === 0 && !value && !todo && !isCcCommandWrapperText(message.text)) records.push({ kind: 'user', origin: 'reconcile', producedBy: 's4-capture', sourceHash, body: { text: redact(userAuthoredText(message.text)) } });
      if (value) {
        records.push({ kind: 'value', origin: 'reconcile', producedBy: 's4-capture', sourceHash, body: { key: value[1].trim(), content: redact(value[2]) } });
      }
      if (todo) {
        records.push({ kind: 'todo', origin: 'reconcile', producedBy: 's4-capture', sourceHash, body: { id: todo[1], status: todo[3] ? 'cleared' : todo[2] ?? 'pending' } });
      }
    } else if (message.text && !isSyntheticApiError(message.text)) records.push({ kind: 'assistant_text', origin: 'reconcile', producedBy: 's4-capture', sourceHash, body: { text: redact(message.text) } });
    if (deps.toolOutputNotes !== false) for (const result of message.toolResults ?? []) {
      const command = bashCommands.get(result.tool_use_id);
      if (command === undefined || shouldSkipToolOutput(command)) continue;
      const decision = deps.toolOutputDecision?.(result.tool_use_id);
      if (decision === 'drop') continue;
      const lines = toolOutputLines(result.text, decision === 'keep' ? deps.toolOutputKeptLines ?? TOOL_OUTPUT_MAX_LINES : TOOL_OUTPUT_MAX_LINES);
      if (lines.length) records.push({ kind: 'tool_output', origin: 'reconcile', producedBy: 's4-capture', sourceHash: `${sourceHash}:out:${result.tool_use_id}`, body: { text: lines.join('\n'), tool_use_id: result.tool_use_id } });
    }
    const error = (message.toolResults ?? []).find((result) => result.isError);
    if (error) {
      // An error from a skipped command (`env && false`) may print the same dump: keep only that it failed.
      const errorCommand = bashCommands.get(error.tool_use_id);
      const text = errorCommand !== undefined && shouldSkipToolOutput(errorCommand) ? '[output withheld: sensitive command]' : redactOutputText(error.text);
      records.push({ kind: 'error', origin: 'reconcile', producedBy: 's4-capture', sourceHash, body: { tool_use_id: error.tool_use_id, text, isError: true } });
    }
    for (const use of message.toolUses) {
      const activity = toolActivityText(use);
      if (activity !== undefined) records.push({ kind: 'tool_activity', origin: 'reconcile', producedBy: 's4-capture', sourceHash: `${sourceHash}:${use.tool_use_id}`, body: { text: use.tool === 'Bash' ? redactOutputText(activity) : redact(activity) } });
      // Round 19 (brief-s4a-fix19.md F11): `written` is already redacted-then-capped by
      // `writtenTextFromToolUse`, so `text` is not redacted again here (redacting the already-capped
      // text a second time is exactly the bug: it runs the PEM pattern too late to matter).
      const written = writtenTextFromToolUse(use);
      if (written !== undefined) records.push({ kind: 'file_write', origin: 'reconcile', producedBy: 's4-capture', sourceHash: `${sourceHash}:${use.tool_use_id}`, body: { text: written, tool_use_id: use.tool_use_id, tool: use.tool } });
    }
  }
  const folded = new Map<string, CaptureRecord>();
  for (const record of records) {
    const key = record.kind === 'value' ? `${record.kind}:${record.body.key}` : record.kind === 'todo' ? `${record.kind}:${record.body.id}` : `${record.kind}:${record.sourceHash}`;
    folded.set(key, record);
  }
  const finalRecords = [...folded.values()];
  return { records: finalRecords, watermark: identities.length ? sequenceWatermark(identities) : watermark ?? { identities: [] } };
}
