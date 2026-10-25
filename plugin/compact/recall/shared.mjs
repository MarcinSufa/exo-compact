import crypto from 'node:crypto';

export const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
// Secrets hidden before session text is indexed. Keys go by their provider prefix; named values (env lines, JSON
// keys, headers) by their name. No high-entropy pass, unlike capture (core/extractor.ts): recall must keep hashes and
// ids findable.
const KEY_PATTERNS = [
  // Anthropic, OpenAI (project, service account, admin), OpenRouter; then legacy OpenAI and DeepSeek without dashes.
  // Only known dashed prefixes, so `sk-learn-...-v1.2` stays and no lookahead rescans a run of `sk-`.
  /\bsk-(?:(?:ant|proj|svcacct|admin|or)-[A-Za-z0-9_-]{16,}|[A-Za-z0-9]{16,})/g,
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}/g,
  /\bgh[opsur]_[A-Za-z0-9]{20,}/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[a-z]-[A-Za-z0-9-]{10,}/g, /\bxapp-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,}/g, /\bwhsec_[A-Za-z0-9]{16,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g, /\bnpm_[A-Za-z0-9]{30,}/g, /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\beyJ[\w-]{6,}\.[\w-]{6,}(?:\.[\w-]*)?/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // URL credentials, unless the password is only a reference (`${DB_PASSWORD}`, `$PASS`). The scheme starts where a
  // run of scheme characters starts, so the pattern is not retried at every character of a word.
  /(?<![\w+.-])[\w+.-]{1,32}:\/\/[^\s:@]{0,256}:(?!\$\{[^}\s]{1,64}\}@|\$[A-Za-z_]\w{0,64}@)[^\s@]{1,256}@\S+/g,
  /\bbearer\s+[\w.~+/=-]{8,}/gi,
];
// Values found by their name. One that only refers to a secret (`${apiKey}`, `$TOKEN`, `process.env.X`, a call, a
// type) is code worth finding, not a secret, and stays, as does a flag or status (`BUILD_PASS=passed`). The whole
// value must be the reference: `hunter2$TOKEN` is not.
const REFERENCE = /^(?:\$\{[^}]*\}|\$[A-Za-z_]\w*|process\.env\.\w+|\[redacted\]|(?:await\s+|new\s+)?[A-Za-z_$][\w.$]*\(.*|await|new|string|number|boolean|unknown|any|undefined|null|true|false|yes|no|on|off|passed|failed|skipped)$/i;
const isReference = (value) => REFERENCE.test(value.replace(/^[`"']|[`"']?[,;)]*$/g, '').replace(/^(?:bearer|basic|token)\s+/i, ''));
// 4.9.1: No supported credential value is longer than 64 KiB; longer named values fail closed before regex matching.
const MAX_CREDENTIAL_RUN_CHARS = 64 * 1024;
const isWhitespaceCode = (code) => code === 32 || (code >= 9 && code <= 13) || code === 160 || code === 5760 || (code >= 8192 && code <= 8202) || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279;
const isWordCode = (code) => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
const END_ASCII_ALNUM = /[^A-Za-z0-9]/g;
const END_KEY_DASH = /[^A-Za-z0-9_-]/g;
const END_WORD_DASH = /[^\w-]/g;
const END_GITHUB_PAT = /[^A-Za-z0-9_]/g;
const END_XOX = /[^A-Za-z0-9-]/g;
const END_BEARER = /[^\w.~+/=-]/g;
const END_SPACE = /\s/g;
const END_VALUE = /[\s;&|]/g;
const END_AUTHORIZATION = /[\s"'`]/g;
const END_URL_PASSWORD = /[\s@]/g;
const NAMED_DELIMITER = /[=:]/;
const ANY_WHITESPACE = /\s/;
const OVERSIZED_LINE = /(?:^|\r\n|[\r\n\u2028\u2029])[^\r\n\u2028\u2029]{65535}[^\r\n\u2028\u2029]{2}/;
// `sk-` values use their unchanged key regex; its overflow fallback hides the oversized line.
const OVERSIZED_KEY_CANDIDATE = /\b(?:sb_(?:secret|publishable)_[A-Za-z0-9_-]{16}|gh[opsur]_[A-Za-z0-9]{20}|github_pat_[A-Za-z0-9_]{20}|xox[a-z]-[A-Za-z0-9-]{10}|xapp-[A-Za-z0-9-]{10}|AIza[0-9A-Za-z_-]{30}|[rs]k_(?:live|test)_[A-Za-z0-9]{10}|whsec_[A-Za-z0-9]{16}|hf_[A-Za-z0-9]{30}|npm_[A-Za-z0-9]{30}|glpat-[A-Za-z0-9_-]{20})/g;
const OVERSIZED_JWT_CANDIDATE = /\beyJ(?=[\w-]{6,}\.[\w-]{6,})/g;
const OVERSIZED_NAMED_MARKER = /(?:authorization|password|passwd|secret|api[_ -]?key|access[_ -]?key|auth[_ -]?token|token|credentials?|private[_ -]?key|[_ -]key|_pass|_pwd)/i;
const OVERSIZED_NAMED_PREFIX = /(?<authorization>\b(?:proxy-)?authorization["']?\s*:\s*[`"']?(?:(?:bearer|basic|token)\s+)?)|(?<space>\b[A-Za-z0-9_]*(?:password|passwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token)\b\??\s*[:=]\s*)|(?<token>\b[A-Za-z0-9_]*token\b\??\s*[:=]\s*)|(?<value>\b[A-Z0-9_]*(?:TOKENS?|SECRET|PASSWORD|PASSWD|_PWD|_PASS|API_?KEY|PRIVATE_KEY|CREDENTIALS?)\s*=\s*(?!\d+\b))|(?<key>\b[A-Z0-9_]*_KEY\s*=\s*(?!\d+\b))|(?<quoted>["'][\w -]{0,40}(?:token|secret|password|passwd|passphrase|api[_ -]?key|access[_ -]?key|private[_ -]?key|credentials?)[\w -]{0,40}["']\s*[:=]\s*)|(?<quotedKey>["'][\w -]{0,40}[_ -]key[\w -]{0,40}["']\s*[:=]\s*)/gi;
const UPPERCASE_NAMED_PREFIX = /\b[A-Z0-9_]*(?:TOKENS?|SECRET|PASSWORD|PASSWD|_PWD|_PASS|API_?KEY|PRIVATE_KEY|CREDENTIALS?)\s*=\s*(?!\d+\b)/y;
const UPPERCASE_KEY_PREFIX = /\b[A-Z0-9_]*_KEY\s*=\s*(?!\d+\b)/y;
const BEARER_CANDIDATE = /\bbearer/gi;
const BEARER_MARKER = /\bbearer(?=\s)/i;
const OVERSIZED_ANY_MARKER = /(?:authorization|password|passwd|secret|api[_ -]?key|access[_ -]?key|auth[_ -]?token|token|credentials?|private[_ -]?key|[_ -]key|_pass|_pwd|sk-|sb_(?:secret|publishable)_|gh[opsur]_|github_pat_|xox[a-z]-|xapp-|AIza|[rs]k_(?:live|test)_|whsec_|hf_|npm_|glpat-|eyJ|bearer\s|@)/i;
const URL_CREDENTIAL_PREFIX = /(?<![\w+.-])[\w+.-]{1,32}:\/\/[^\s:@]{0,256}:/g;
const LINE_TERMINATOR = /\r\n|[\r\n\u2028\u2029]/g;
const isQuoteEndBoundary = (code) => isWhitespaceCode(code) || code === 44 || code === 59 || code === 41 || code === 125 || code === 93 || code === 38 || code === 124 || code === 60 || code === 62;
const lineTerminatorLength = (text, at) => {
  const code = text.charCodeAt(at);
  if (code === 13) return text.charCodeAt(at + 1) === 10 ? 2 : 1;
  return code === 10 || code === 0x2028 || code === 0x2029 ? 1 : 0;
};
const lineEndAt = (text, start) => {
  LINE_TERMINATOR.lastIndex = start;
  return LINE_TERMINATOR.exec(text)?.index ?? text.length;
};
const classEndAt = (text, start, pattern) => {
  pattern.lastIndex = start;
  return pattern.exec(text)?.index ?? text.length;
};
const scanLongLineShape = (text) => {
  const hasWhitespace = ANY_WHITESPACE.test(text);
  if (!hasWhitespace) return { hasLongRunOrQuote: text.length >= 65535, hasWhitespace };
  let run = 0, hasQuote = false;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code === 34 || code === 39) hasQuote = true;
    if (isWhitespaceCode(code)) run = 0;
    else if (++run >= 65535) return { hasLongRunOrQuote: true, hasWhitespace };
  }
  return { hasLongRunOrQuote: hasQuote, hasWhitespace };
};
const providerKeyEndAt = (line, start) => {
  for (const [prefix, endPattern] of [
    ['sb_secret_', END_KEY_DASH], ['sb_publishable_', END_KEY_DASH], ['ghp_', END_ASCII_ALNUM], ['gho_', END_ASCII_ALNUM], ['ghs_', END_ASCII_ALNUM],
    ['ghu_', END_ASCII_ALNUM], ['ghr_', END_ASCII_ALNUM], ['github_pat_', END_GITHUB_PAT], ['xapp-', END_XOX],
    ['AIza', END_KEY_DASH], ['sk_live_', END_ASCII_ALNUM], ['sk_test_', END_ASCII_ALNUM],
    ['whsec_', END_ASCII_ALNUM], ['hf_', END_ASCII_ALNUM], ['npm_', END_ASCII_ALNUM], ['glpat-', END_KEY_DASH],
  ]) {
    if (line.startsWith(prefix, start)) return classEndAt(line, start + prefix.length, endPattern);
  }
  if (line.startsWith('xox', start) && line.charCodeAt(start + 3) >= 97 && line.charCodeAt(start + 3) <= 122 && line.charCodeAt(start + 4) === 45) {
    return classEndAt(line, start + 5, END_XOX);
  }
  if (line.startsWith('eyJ', start)) {
    let at = classEndAt(line, start + 3, END_WORD_DASH);
    if (at - start < 9 || line.charCodeAt(at) !== 46) return start;
    const secondStart = ++at;
    at = classEndAt(line, at, END_WORD_DASH);
    if (at - secondStart < 6) return start;
    if (line.charCodeAt(at) === 46) at = classEndAt(line, at + 1, END_WORD_DASH);
    return at;
  }
  return start;
};
const quoteEndPositions = (text) => {
  const positions = { 34: [], 39: [] };
  let backslashes = 0;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if ((code === 34 || code === 39) && backslashes % 2 === 0 && (at + 1 === text.length || isQuoteEndBoundary(text.charCodeAt(at + 1)))) positions[code].push(at + 1);
    backslashes = code === 92 ? backslashes + 1 : 0;
  }
  return positions;
};
const findQuotedValueEnd = (positions, start, quote, firstLineEnd) => {
  const ends = positions[quote];
  let low = 0, high = ends.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (ends[middle] <= start + 1) low = middle + 1;
    else high = middle;
  }
  return low < ends.length ? ends[low] : firstLineEnd;
};
const strictPrefixMatches = (pattern, line, start, length) => {
  pattern.lastIndex = start;
  const match = pattern.exec(line);
  return match?.index === start && match[0].length === length;
};
const scanLongLine = (text, lineStart, lineEnd, spans, quotePositions) => {
  const line = text.slice(lineStart, lineEnd);
  if (!OVERSIZED_ANY_MARKER.test(line)) return;
  const { hasLongRunOrQuote, hasWhitespace } = scanLongLineShape(line);
  if (!hasLongRunOrQuote) return;
  if (NAMED_DELIMITER.test(line) && OVERSIZED_NAMED_MARKER.test(line)) {
    OVERSIZED_NAMED_PREFIX.lastIndex = 0;
    for (let match; (match = OVERSIZED_NAMED_PREFIX.exec(line));) {
      const groups = match.groups;
      const kind = groups.authorization !== undefined ? 'authorization' : groups.space !== undefined ? 'space' : groups.token !== undefined ? 'token'
        : groups.value !== undefined ? 'value' : groups.key !== undefined ? 'key' : groups.quoted !== undefined ? 'quoted' : 'quotedKey';
      const localStart = OVERSIZED_NAMED_PREFIX.lastIndex;
      if ((kind === 'value' && !strictPrefixMatches(UPPERCASE_NAMED_PREFIX, line, match.index, match[0].length)) ||
        (kind === 'key' && !strictPrefixMatches(UPPERCASE_KEY_PREFIX, line, match.index, match[0].length))) continue;
      if ((kind === 'quoted' || kind === 'quotedKey') && line.charCodeAt(localStart) !== 34 && line.charCodeAt(localStart) !== 39) continue;
      let localEnd = localStart;
      const quote = line.charCodeAt(localStart);
      if ((kind === 'space' || kind === 'token' || kind === 'value' || kind === 'quoted' || kind === 'quotedKey') && (quote === 34 || quote === 39)) {
        quotePositions.positions ??= quoteEndPositions(text);
        localEnd = findQuotedValueEnd(quotePositions.positions, lineStart + localStart, quote, lineEnd) - lineStart;
      } else {
        const endPattern = kind === 'value' ? END_VALUE : kind === 'authorization' ? END_AUTHORIZATION : END_SPACE;
        localEnd = classEndAt(line, localStart, endPattern);
      }
      if (localEnd - localStart > MAX_CREDENTIAL_RUN_CHARS) {
        spans.push({ start: lineStart + localStart, end: lineStart + localEnd });
        OVERSIZED_NAMED_PREFIX.lastIndex = Math.max(OVERSIZED_NAMED_PREFIX.lastIndex, localEnd);
      }
    }
  }
  OVERSIZED_KEY_CANDIDATE.lastIndex = 0;
  for (let match; (match = OVERSIZED_KEY_CANDIDATE.exec(line));) {
    const end = providerKeyEndAt(line, match.index);
    if (end - match.index > MAX_CREDENTIAL_RUN_CHARS) {
      spans.push({ start: lineStart + match.index, end: lineStart + end });
      OVERSIZED_KEY_CANDIDATE.lastIndex = end;
    }
    if (end === line.length && end - match.index > MAX_CREDENTIAL_RUN_CHARS) return;
  }
  if (line.includes('.')) {
    OVERSIZED_JWT_CANDIDATE.lastIndex = 0;
    for (let match; (match = OVERSIZED_JWT_CANDIDATE.exec(line));) {
      const end = providerKeyEndAt(line, match.index);
      if (end - match.index > MAX_CREDENTIAL_RUN_CHARS) {
        spans.push({ start: lineStart + match.index, end: lineStart + end });
        OVERSIZED_JWT_CANDIDATE.lastIndex = end;
      }
      if (end === line.length && end - match.index > MAX_CREDENTIAL_RUN_CHARS) return;
    }
  }
  if (hasWhitespace && BEARER_MARKER.test(line)) {
    BEARER_CANDIDATE.lastIndex = 0;
    for (let match; (match = BEARER_CANDIDATE.exec(line));) {
      let start = BEARER_CANDIDATE.lastIndex;
      if (start >= line.length || !isWhitespaceCode(line.charCodeAt(start))) continue;
      while (start < line.length && isWhitespaceCode(line.charCodeAt(start))) start++;
      const end = classEndAt(line, start, END_BEARER);
      if (end - start > MAX_CREDENTIAL_RUN_CHARS) {
        spans.push({ start: lineStart + start, end: lineStart + end });
        BEARER_CANDIDATE.lastIndex = end;
      }
    }
  }
  if (line.includes('@')) {
    URL_CREDENTIAL_PREFIX.lastIndex = 0;
    for (let match; (match = URL_CREDENTIAL_PREFIX.exec(line));) {
      const start = URL_CREDENTIAL_PREFIX.lastIndex;
      const end = classEndAt(line, start, END_URL_PASSWORD);
      if (line.charCodeAt(end) === 64 && end - start > MAX_CREDENTIAL_RUN_CHARS) {
        spans.push({ start: lineStart + start, end: lineStart + end });
        URL_CREDENTIAL_PREFIX.lastIndex = end + 1;
      }
    }
  }
};
// 4.9.1: The prescan skips every line at or below 64 KiB; on longer lines it follows the named regex's value class.
// A quoted value opened on a longer line may close on a later line, so its valid closing quote is checked across lines;
// if none exists, the span ends at the first line terminator and leaves that terminator in place.
const redactOversizedCredentialRuns = (text) => {
  if (text.length <= MAX_CREDENTIAL_RUN_CHARS || !OVERSIZED_LINE.test(text)) return text;
  const spans = [], quotePositions = { positions: null };
  let lineStart = 0;
  while (lineStart < text.length) {
    const lineEnd = lineEndAt(text, lineStart);
    if (lineEnd - lineStart > MAX_CREDENTIAL_RUN_CHARS) scanLongLine(text, lineStart, lineEnd, spans, quotePositions);
    lineStart = lineEnd + (lineEnd < text.length ? lineTerminatorLength(text, lineEnd) : 0);
  }
  if (!spans.length) return text;
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const pieces = [];
  let sourceAt = 0;
  for (const span of spans) {
    if (span.end <= sourceAt) continue;
    if (span.start > sourceAt) pieces.push(text.slice(sourceAt, span.start));
    pieces.push('[redacted]');
    sourceAt = span.end;
  }
  pieces.push(text.slice(sourceAt));
  return pieces.join('');
};
const redactOversizedLines = (text) => {
  const pieces = [];
  let sourceAt = 0, lineStart = 0, changed = false;
  while (lineStart < text.length) {
    const lineEnd = lineEndAt(text, lineStart);
    if (lineEnd - lineStart > MAX_CREDENTIAL_RUN_CHARS) {
      pieces.push(text.slice(sourceAt, lineStart), '[redacted]');
      sourceAt = lineEnd; changed = true;
    }
    lineStart = lineEnd + (lineEnd < text.length ? lineTerminatorLength(text, lineEnd) : 0);
  }
  return changed ? pieces.concat(text.slice(sourceAt)).join('') : text;
};
const replaceWithFailClosed = (text, pattern, replacement) => {
  try { pattern.lastIndex = 0; return text.replace(pattern, replacement); }
  catch {
    const fallback = redactOversizedLines(text);
    try { pattern.lastIndex = 0; return fallback.replace(pattern, replacement); }
    catch { return fallback === text ? (text ? '[redacted]' : text) : fallback; }
  }
};
// A bare `_KEY` name is also a database or cache key (`PRIMARY_KEY=users.id`), so its value must hold something that
// looks like a key: 16+ key characters with both letters and digits.
const looksLikeKey = (value) => value.length > MAX_CREDENTIAL_RUN_CHARS || (value.match(/[A-Za-z0-9_+/=.-]{16,}/g) ?? []).some((run) => /\d/.test(run) && /[A-Za-z]/.test(run));
// A quoted value runs to its closing quote, across lines too (bounded), so a multi-line value is not cut after its
// first line. The closing quote must end the value (space, punctuation or a shell operator after it); a quote that
// opens the next key (an unclosed value in a grep listing) does not count, so the next line stays. An unclosed or
// longer value is hidden to the end of its line only.
const QUOTED = String.raw`(?:"(?:[^"\\]|\\[\s\S]){0,2048}"|'(?:[^'\\]|\\[\s\S]){0,2048}')(?=[\s,;)}\]&|<>]|$)`;
const VALUE = `(${QUOTED}|[^\\s;&|]+)`;
const NAMED_PATTERNS = [
  [/\b(?:proxy-)?authorization["']?\s*:\s*[`"']?(?:(?:bearer|basic|token)\s+)?([^\s"'`]+)/gi],
  [new RegExp(String.raw`\b[A-Za-z0-9_]*(?:password|passwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token)\b\??\s*[:=]\s*(${QUOTED}|\S+)`, 'gi')],
  // A bare `token` name is also a counter or a parser token (`max_token = 4000`, `token = next()`), so its value
  // must look like a key.
  [new RegExp(String.raw`\b[A-Za-z0-9_]*token\b\??\s*[:=]\s*(${QUOTED}|\S+)`, 'gi'), looksLikeKey],
  // UPPER_SNAKE assignments: `EXOVAULT_AGENT_KEY=...`, `export X_TOKEN="..."`; `MAX_TOKENS=4000` keeps its number and
  // `PWD`/`OLDPWD` (the working directory) their path.
  [new RegExp(String.raw`\b[A-Z0-9_]*(?:TOKENS?|SECRET|PASSWORD|PASSWD|_PWD|_PASS|API_?KEY|PRIVATE_KEY|CREDENTIALS?)\s*=\s*(?!\d+\b)` + VALUE, 'g')],
  [new RegExp(String.raw`\b[A-Z0-9_]*_KEY\s*=\s*(?!\d+\b)` + VALUE, 'g'), looksLikeKey],
  // Quoted JSON/YAML keys: `"apiKey": "..."`, `"EXOVAULT_AGENT_KEY": "..."`.
  [new RegExp(String.raw`["'][\w -]{0,40}(?:token|secret|password|passwd|passphrase|api[_ -]?key|access[_ -]?key|private[_ -]?key|credentials?)[\w -]{0,40}["']\s*[:=]\s*(${QUOTED})`, 'gi')],
  [new RegExp(String.raw`["'][\w -]{0,40}[_ -]key[\w -]{0,40}["']\s*[:=]\s*(${QUOTED})`, 'gi'), looksLikeKey],
];
/** The keys of `text` replaced, nothing else changed: for stored files (briefs, digests) that must keep every line. */
export const redactAll = (text) => {
  try {
    const original = String(text ?? '');
    let safe = redactOversizedCredentialRuns(original);
    for (const pattern of KEY_PATTERNS) safe = replaceWithFailClosed(safe, pattern, '[redacted]');
    for (const [pattern, secret = () => true] of NAMED_PATTERNS) {
      safe = replaceWithFailClosed(safe, pattern, (match, value) => (isReference(value) || !secret(value) ? match : '[redacted]'));
    }
    return safe;
  } catch {
    return '[redacted]';
  }
};
/** redactAll, cut to 50000 characters: for index chunks. */
export const redact = (text) => {
  const safe = redactAll(text);
  return safe.length <= 50000 ? safe : `${safe.slice(0, 49988)}\n[truncated]`;
};

const SYSTEM_NOISE = /<system-reminder>|<local-command-caveat>|\[\[exovault:s4-seed:v\d+\]\]/i;
export function clean(text) {
  let body = String(text ?? '').replace(/\r/g, '');
  if (/^\s*This session is being continued from a previous conversation\./i.test(body)) return '';
  for (const marker of ['<system-reminder>', '<local-command-caveat>', '[[exovault:s4-seed:']) {
    const at = body.toLowerCase().indexOf(marker.toLowerCase());
    if (at >= 0) body = body.slice(0, at);
  }
  if (SYSTEM_NOISE.test(body)) return '';
  return redact(body).trim();
}

export function blocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => {
    if (b?.type === 'text') return b.text ?? '';
    if (b?.type === 'tool_result') return typeof b.content === 'string' ? b.content : (b.content ?? []).map((x) => x.text ?? '').join('\n');
    return '';
  }).filter(Boolean).join('\n');
}

export function chunk(text, maxChars = 900) {
  const out = [];
  const paragraphs = text.split(/\n{2,}/);
  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChars) { if (paragraph.trim()) out.push(paragraph.trim()); continue; }
    const sentences = paragraph.split(/(?<=[.!?])\s+/) ?? [paragraph];
    let current = '';
    for (const sentenceRaw of sentences) {
      const sentence = sentenceRaw.trim();
      if (!sentence) continue;
      if (sentence.length > maxChars) {
        if (current) { out.push(current); current = ''; }
        for (let i = 0; i < sentence.length; i += maxChars) out.push(sentence.slice(i, i + maxChars));
      } else if (current && current.length + sentence.length + 1 > maxChars) {
        out.push(current); current = sentence;
      } else current = current ? `${current} ${sentence}` : sentence;
    }
    if (current) out.push(current);
  }
  return out;
}

export function contentTerms(text) {
  return (String(text).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.:/@+-]*/gu) ?? [])
    .filter((t) => t.length > 1 && !STOP.has(t));
}
const STOP = new Set('a an and are as at be because can does for from how in is it its of on or over that the this to was we what when where which who why with'.split(' '));
