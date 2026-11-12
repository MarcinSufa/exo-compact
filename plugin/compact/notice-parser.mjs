/** Parse one timestamped notices.log line without retaining its free-form text. */
export function parseNoticeLine(line) {
  const match = /^(\S+)\s+(.+)$/.exec(line);
  if (!match) return null;
  const [first, ...tokens] = match[2].trim().split(/\s+/);
  const equals = first.indexOf('=');
  const fields = {};
  for (const token of tokens) {
    const at = token.indexOf('=');
    if (at > 0) fields[token.slice(0, at)] = token.slice(at + 1);
  }
  return {
    at: match[1],
    kind: equals < 0 ? first : first.slice(0, equals),
    ...(equals < 0 ? {} : { value: first.slice(equals + 1) }),
    fields,
  };
}

export function isErrorNotice(notice) {
  return /(?:^|[._-])error(?:$|[._-])/.test(notice.kind)
    || notice.value === 'error'
    || Object.values(notice.fields).includes('error');
}

/** The fallback reasons status.mjs attaches to native transcript compactions. */
export function parseFallbackNotices(text) {
  const lines = [];
  let sizeBefore;
  for (const line of text.split('\n')) {
    const notice = parseNoticeLine(line);
    if (!notice) continue;
    if (notice.kind === 'compact.sizeBefore' && /^\d+$/.test(notice.value ?? '')) sizeBefore = Number(notice.value);
    if (notice.kind !== 'compact.fallback' || notice.fields.origin !== 'compact') continue;
    lines.push({
      at: notice.at,
      reason: notice.value,
      ...(sizeBefore !== undefined ? { sizeBefore } : {}),
      ...(typeof notice.fields.sizeAfter === 'string' && /^\d+$/.test(notice.fields.sizeAfter) ? { sizeAfter: Number(notice.fields.sizeAfter) } : {}),
    });
    sizeBefore = undefined;
  }
  return lines;
}
