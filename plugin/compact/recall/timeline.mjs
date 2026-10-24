// A map of a long session: one entry per compaction segment (the stretch between two compact_boundary events),
// built from transcript events alone, with no model. Used by the build worker (timeline.json next to the index)
// and by the offline replay, so both see the same map.
import { redact } from './shared.mjs';

const NOT_HUMAN = /^\s*(<|!|\[\[exovault:|This session is being continued|\[Request interrupted|Caveat:|Another Claude session sent a message)/;
const ASK_CHARS = 90, MIN_ASK_CHARS = 12;

function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some((b) => b?.type === 'tool_result')) return '';
  return content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
}

/** Words a person typed, or '' for harness traffic (tool results, notifications, peers, seeds, summaries). */
export function humanAsk(event) {
  if (event?.type !== 'user' || event.isMeta || event.isCompactSummary || event.isSidechain) return '';
  if (event.origin?.kind && event.origin.kind !== 'human') return '';
  const text = redact(userText(event.message?.content)).replace(/\s+/g, ' ').trim();
  return text.length >= MIN_ASK_CHARS && !NOT_HUMAN.test(text) ? text : '';
}

const commitMessage = (command) => /\bgit\b[^\n]*\bcommit\b[^\n]*?-q?m\s+(["'])([^\n]+?)(?:\1|$)/.exec(String(command ?? ''))?.[2] ?? '';

/** Feed events in transcript order with add(); result() gives [{ segment, from, to, asks, files, commits }]. */
export function timelineBuilder() {
  const segments = [];
  let current = null, segment = 0;
  const open = () => {
    if (!current) { current = { segment, from: '', to: '', asks: [], files: new Map(), commits: [] }; segments.push(current); }
    return current;
  };
  return {
    add(event) {
      if (event?.type === 'system' && event.subtype === 'compact_boundary') { segment++; current = null; return; }
      if (!['user', 'assistant'].includes(event?.type) || event.isSidechain) return;
      const s = open();
      if (typeof event.timestamp === 'string') { s.from ||= event.timestamp; s.to = event.timestamp; }
      const ask = humanAsk(event);
      if (ask) s.asks.push(ask.length > ASK_CHARS ? `${ask.slice(0, ASK_CHARS - 1)}…` : ask);
      if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) return;
      for (const part of event.message.content) {
        if (part?.type !== 'tool_use') continue;
        const file = part.input?.file_path;
        if (typeof file === 'string' && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(part.name ?? '')) {
          const name = file.split(/[\\/]/).pop();
          s.files.set(name, (s.files.get(name) ?? 0) + 1);
        }
        const message = commitMessage(part.input?.command);
        if (message) s.commits.push(message.slice(0, 80));
      }
    },
    result() {
      return segments.map((s) => ({
        segment: s.segment, from: s.from, to: s.to, asks: s.asks,
        files: [...s.files].sort((a, b) => b[1] - a[1]).map(([name]) => name), commits: s.commits,
      }));
    },
  };
}
