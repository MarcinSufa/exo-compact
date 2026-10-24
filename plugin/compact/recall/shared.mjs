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
// A bare `_KEY` name is also a database or cache key (`PRIMARY_KEY=users.id`), so its value must hold something that
// looks like a key: 16+ key characters with both letters and digits.
const looksLikeKey = (value) => (value.match(/[A-Za-z0-9_+/=.-]{16,}/g) ?? []).some((run) => /\d/.test(run) && /[A-Za-z]/.test(run));
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
  let safe = String(text ?? '');
  for (const pattern of KEY_PATTERNS) safe = safe.replace(pattern, '[redacted]');
  for (const [pattern, secret = () => true] of NAMED_PATTERNS) {
    safe = safe.replace(pattern, (match, value) => (isReference(value) || !secret(value) ? match : '[redacted]'));
  }
  return safe;
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
