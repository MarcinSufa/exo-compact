import fs from 'node:fs';
import { blocks, clean } from '../../plugin/compact/recall/shared.mjs';

export async function parseJsonl(file) {
  const events = [];
  let malformed = 0;
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  let pending = '';
  for await (const chunk of input) {
    pending += chunk;
    let nl;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).replace(/\r$/, ''); pending = pending.slice(nl + 1);
      if (!line.trim()) continue;
      try { events.push({ event: JSON.parse(line), line }); } catch { malformed++; }
    }
  }
  if (pending.trim()) { try { events.push({ event: JSON.parse(pending), line: pending }); } catch { malformed++; } }
  return { events, malformed };
}

export function eventText(event) {
  return clean(blocks(event?.message?.content));
}

export function eventContentText(event) {
  const content = event?.message?.content;
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((block) => block?.text ?? (typeof block?.content === 'string' ? block.content : '')).join('\n')
      : '';
}

export function sessionMessage(event) {
  const content = event.message?.content;
  const parts = Array.isArray(content) ? content : [];
  const toolUses = parts.filter((x) => x?.type === 'tool_use').map((x) => ({ tool_use_id: x.id, tool: x.name, input: x.input }));
  const toolResults = parts.filter((x) => x?.type === 'tool_result').map((x) => ({ tool_use_id: x.tool_use_id, isError: !!x.is_error, text: blocks(x.content) }));
  return { role: event.type === 'assistant' ? 'assistant' : 'user', text: typeof content === 'string' ? content : parts.filter((x) => x?.type === 'text').map((x) => x.text ?? '').join('\n'), toolUses, ...(toolResults.length ? { toolResults } : {}) };
}

export function isSummaryEvent(event) {
  return event.type === 'user' && (event.isCompactSummary === true || event.message?.isCompactSummary === true);
}

export function isBoundary(event) {
  return event.type === 'system' && event.subtype === 'compact_boundary';
}

export function splitBoundaries(events) {
  const indices = events.map((item, index) => isBoundary(item.event ?? item) ? index : -1).filter((index) => index >= 0);
  return indices.map((index, n) => ({ start: index, end: indices[n + 1] ?? events.length }));
}

export function toolUses(event) {
  return event.type === 'assistant' && Array.isArray(event.message?.content)
    ? event.message.content.filter((block) => block?.type === 'tool_use')
    : [];
}

export function toolCalls(event) {
  return Array.isArray(event.message?.content) ? event.message.content.filter((block) => block?.type === 'tool_use') : [];
}

const SEARCH = new Set(['Grep', 'Glob']);
const SEARCH_BASH = /(^|[;&|(]\s*)(grep|rg|find|ls|git (log|grep|ls-files))\b/;
const READ_BASH = /(?:^|[;&|(]\s*)(?:cat|head|tail|sed -n \S+|less|wc -l)(?:\s+-\S+)*\s+([^\s|;&<>]+)/g;

export function readPaths(toolUse) {
  const input = toolUse.input ?? {};
  if (toolUse.name === 'Read' || toolUse.name === 'NotebookRead') return [String(input.file_path ?? '')].filter(Boolean);
  if (/^(?:[^ ]+__)?(?:read|read_file)$/i.test(toolUse.name ?? '')) return [String(input.file_path ?? input.path ?? '')].filter(Boolean);
  if (toolUse.name === 'Bash') {
    READ_BASH.lastIndex = 0;
    return [...String(input.command ?? '').matchAll(READ_BASH)].map((match) => match[1]).filter((value) => /[/.]/.test(value));
  }
  return [];
}

export function isSearch(toolUse) {
  return SEARCH.has(toolUse.name) || (toolUse.name === 'Bash' && SEARCH_BASH.test(String(toolUse.input?.command ?? '')));
}

export function isSearchSession(toolUse) {
  return /(?:^|[_/])search_session$/i.test(String(toolUse.name ?? ''));
}
