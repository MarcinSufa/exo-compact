#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { fakeHost } from '../../plugin/compact/__gate-s4__/fixtures/helpers.ts';

const HOME = os.homedir();
const CAPTURE_ROOT = path.join(HOME, '.exovault/s4-capture');
const PROJECTS_ROOT = path.join(HOME, '.claude/projects');
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const isoMs = (value) => typeof value === 'number' ? value : Date.parse(value);

function textBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (part?.type === 'text') return part.text ?? '';
    if (part?.type === 'tool_result') return typeof part.content === 'string' ? part.content : (part.content ?? []).map((child) => child.text ?? '').join('\n');
    return '';
  }).filter(Boolean).join('\n');
}

function messageFromEvent(event) {
  const content = event?.message?.content;
  const parts = Array.isArray(content) ? content : [];
  const toolUses = parts.filter((part) => part?.type === 'tool_use').map((part) => ({ tool_use_id: part.id, tool: part.name, input: part.input }));
  const toolResults = parts.filter((part) => part?.type === 'tool_result').map((part) => ({ tool_use_id: part.tool_use_id, isError: Boolean(part.is_error), text: textBlocks(part.content) }));
  return {
    role: event.type === 'assistant' ? 'assistant' : 'user',
    text: typeof content === 'string' ? content : parts.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n'),
    ...(typeof event.cwd === 'string' ? { cwd: event.cwd } : {}),
    toolUses,
    ...(toolResults.length ? { toolResults } : {}),
  };
}

/** Returns the session messages before this boundary, beginning after the preceding boundary. */
function messagesAtBoundaryDetails(events, boundaryIndex) {
  let previous = boundaryIndex - 1;
  while (previous >= 0 && !(events[previous]?.type === 'system' && events[previous]?.subtype === 'compact_boundary')) previous--;
  const previousBoundary = events[previous];
  const boundary = events[boundaryIndex];
  if (previousBoundary?.uuid && boundary) {
    let byUuid = eventIndexes.get(events);
    if (!byUuid) {
      byUuid = new Map(events.filter((event) => event.uuid).map((event) => [event.uuid, event]));
      eventIndexes.set(events, byUuid);
    }
    const chain = [];
    let cursor = boundary.logicalParentUuid ?? boundary.parentUuid;
    let reachedPreviousBoundary = false;
    let guard = 0;
    while (cursor && guard++ < events.length) {
      if (cursor === previousBoundary.uuid) { reachedPreviousBoundary = true; break; }
      const event = byUuid.get(cursor);
      if (!event) break;
      chain.push(event);
      cursor = event.parentUuid ?? event.logicalParentUuid;
    }
    if (reachedPreviousBoundary) return {
      messages: chain.toReversed()
        .filter((event) => (event.type === 'user' || event.type === 'assistant') && !event.isSidechain)
        .map(messageFromEvent),
      source: 'parent_chain',
    };
  }
  return {
    messages: events.slice(previous + 1, boundaryIndex)
      .filter((event) => (event.type === 'user' || event.type === 'assistant') && !event.isSidechain)
      .map(messageFromEvent),
    source: 'interval_fallback',
  };
}

export function messagesAtBoundary(events, boundaryIndex) {
  return messagesAtBoundaryDetails(events, boundaryIndex).messages;
}

/** All messages on the active transcript branch before a boundary, including earlier compact segments. */
export function messagesThroughBoundary(events, boundaryIndex) {
  const boundary = events[boundaryIndex];
  if (!boundary) return [];
  if (boundary.uuid) {
    let byUuid = eventIndexes.get(events);
    if (!byUuid) {
      byUuid = new Map(events.filter((event) => event.uuid).map((event) => [event.uuid, event]));
      eventIndexes.set(events, byUuid);
    }
    const chain = [];
    let cursor = boundary.logicalParentUuid ?? boundary.parentUuid;
    let complete = false;
    let guard = 0;
    while (cursor && guard++ < events.length) {
      const event = byUuid.get(cursor);
      if (!event) break;
      chain.push(event);
      cursor = event.parentUuid ?? event.logicalParentUuid;
    }
    complete = !cursor && guard <= events.length;
    if (complete) return chain.toReversed()
      .filter((event) => (event.type === 'user' || event.type === 'assistant') && !event.isSidechain)
      .map(messageFromEvent);
  }
  // Parent links can be absent in older transcripts. Keep the available history rather than
  // silently discarding the records from earlier capture segments.
  return events.slice(0, boundaryIndex)
    .filter((event) => (event.type === 'user' || event.type === 'assistant') && !event.isSidechain)
    .map(messageFromEvent);
}

const eventIndexes = new WeakMap();

/** Use the token counter recorded for this production cut; older cuts without it use today's default. */
export function realTokenCountForCut(cut) {
  for (const entry of cut?.noticeLines ?? []) {
    const match = /\bseed\.budget_count=(real|chars4)\b/.exec(String(entry?.body ?? ''));
    if (match) return match[1] === 'real';
  }
  return true;
}

/** Read the original card signals instead of inferring card state from the replay snapshot. */
export function originalCardNotice(cut) {
  const bodies = (cut?.noticeLines ?? []).map((entry) => String(entry?.body ?? ''));
  const cardNotice = bodies.map((body) => /^seed\.task_card=(\d+)(?:\s|$)/.exec(body)).find(Boolean);
  const totalNotice = bodies.map((body) => /\bseed\.budget_total=(\d+)/.exec(body)).find(Boolean);
  const splitNotice = bodies.map((body) => /\bseed\.budget_split seed=(\d+) tail=(\d+) dense=(\d+)/.exec(body)).find(Boolean);
  const budgetTotal = totalNotice ? Number(totalNotice[1]) : null;
  const splitTotal = splitNotice ? Number(splitNotice[1]) + Number(splitNotice[2]) : null;
  const cardTextPresent = cardNotice?.[1] === '1';
  return {
    hasCard: cardTextPresent || (budgetTotal !== null && splitTotal !== null && budgetTotal === splitTotal),
    cardTextPresent,
    budgetTotal,
    budgetSplit: splitNotice ? { seed: Number(splitNotice[1]), tail: Number(splitNotice[2]), dense: Number(splitNotice[3]) } : null,
  };
}

/** Add only card text supported by original notices and a real recovered/current source. */
export function restoreTaskCardForCut({ cut, snapshot, historicalCard, currentText }) {
  const nextSnapshot = new Map(snapshot);
  if (!originalCardNotice(cut).hasCard) {
    nextSnapshot.delete('task-card.md');
    return { snapshot: nextSnapshot, cardSource: 'none' };
  }
  const inSnapshot = nextSnapshot.get('task-card.md');
  if (typeof inSnapshot === 'string' && inSnapshot.trim()) return { snapshot: nextSnapshot, cardSource: 'snapshot' };
  nextSnapshot.delete('task-card.md');
  if (historicalCard && typeof historicalCard.text === 'string' && historicalCard.text.trim()) {
    nextSnapshot.set('task-card.md', historicalCard.text);
    return { snapshot: nextSnapshot, cardSource: historicalCard.source };
  }
  if (typeof currentText === 'string' && currentText.trim()) {
    nextSnapshot.set('task-card.md', currentText);
    return { snapshot: nextSnapshot, cardSource: 'current' };
  }
  return { snapshot: nextSnapshot, cardSource: 'unavailable' };
}

/** Restore an overwritten card horizon only when the original cut and transcript support it. */
export function restoreTaskCardHorizonForCut({ cut, snapshot, noticeText, events, activeToolUseIds }) {
  const nextSnapshot = new Map(snapshot);
  const horizonPath = 'task-card.horizon.json';
  if (nextSnapshot.has(horizonPath)) return { snapshot: nextSnapshot, horizonSource: 'snapshot' };
  if (!originalCardNotice(cut).hasCard || !(cut?.noticeLines ?? []).some(({ body = '' }) => /\bseed\.since_card=\d+\s+seed\.since_card_size=\d+\s+seed\.since_card_horizon=found\b/.test(String(body)))) {
    return { snapshot: nextSnapshot, horizonSource: 'none' };
  }
  const cutoff = isoMs(cut.startedAt);
  const notices = String(noticeText ?? '').split(/\r?\n/).map((line) => {
    const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z)\s+(.*)$/.exec(line);
    return match ? { at: match[1], ms: Date.parse(match[1]), body: match[2] } : null;
  }).filter((entry) => entry && Number.isFinite(entry.ms) && entry.ms <= cutoff);
  const writes = notices.filter((entry) => /^task_card\.refresh=written\b/.test(entry.body));
  const toolUseIds = activeToolUseIds instanceof Set ? activeToolUseIds : new Set(activeToolUseIds ?? []);
  for (const write of writes.toReversed()) {
    const start = notices.toReversed().find((entry) => entry.ms < write.ms && /^task_card\.refresh=start\b/.test(entry.body));
    if (!start) continue;
    const tokens = /\bctx=(\d+)/.exec(start.body)?.[1];
    const startMs = start.ms;
    const nearbyResults = [];
    for (const event of events ?? []) {
      if (event?.type !== 'user') continue;
      const at = Date.parse(event.timestamp ?? '');
      if (!Number.isFinite(at) || Math.abs(at - startMs) > 2_000) continue;
      for (const part of Array.isArray(event.message?.content) ? event.message.content : []) {
        if (part?.type === 'tool_result' && toolUseIds.has(part.tool_use_id)) nearbyResults.push({ id: part.tool_use_id, distance: Math.abs(at - startMs) });
      }
    }
    nearbyResults.sort((a, b) => a.distance - b.distance);
    const closestDistance = nearbyResults[0]?.distance;
    const closestIds = [...new Set(nearbyResults.filter((row) => row.distance === closestDistance).map((row) => row.id))];
    let toolUseId = closestIds.length === 1 ? closestIds[0] : undefined;
    if (!toolUseId && nearbyResults.length === 0) {
      // Stop hooks use the latest tool call visible in the session, just like the production callback.
      const priorUses = [];
      for (const [eventIndex, event] of (events ?? []).entries()) {
        if (event?.type !== 'assistant') continue;
        const at = Date.parse(event.timestamp ?? '');
        if (!Number.isFinite(at) || at > startMs) continue;
        for (const part of Array.isArray(event.message?.content) ? event.message.content : []) {
          if (part?.type === 'tool_use' && toolUseIds.has(part.id)) priorUses.push({ id: part.id, at, eventIndex });
        }
      }
      priorUses.sort((a, b) => a.at - b.at || a.eventIndex - b.eventIndex);
      toolUseId = priorUses.at(-1)?.id;
    }
    if (!toolUseId) continue;
    nextSnapshot.set(horizonPath, JSON.stringify({ toolUseId, at: write.at, ...(tokens ? { tokens: Number(tokens) } : {}) }));
    return { snapshot: nextSnapshot, horizonSource: 'transcript' };
  }
  return { snapshot: nextSnapshot, horizonSource: 'unavailable' };
}

function sectionSizes(noticeLines) {
  const sizes = {};
  for (const { body = '' } of noticeLines ?? []) {
    for (const match of String(body).matchAll(/\b(seed\.[a-z0-9_]+_size)=(\d+)/g)) {
      if (match[1] !== 'seed.rendered_size') sizes[match[1]] = Number(match[2]);
    }
  }
  return sizes;
}

function sectionNotices(noticeLines) {
  return (noticeLines ?? []).map((entry) => typeof entry === 'string' ? entry : String(entry?.body ?? ''))
    .filter((body) => /^seed\.(?:budget_|work_state|session_map|task_brief|task_card|since_card|recipes|dense|constraints|adopted|facts|key_facts|current_values|ids)/.test(body));
}

/** File rows whose snapshot timestamp (or mtime fallback) is at or before the cut. */
export function captureSnapshotAt(files, cutAt) {
  const cutoff = isoMs(cutAt);
  return new Map(files.filter((file) => Number(file.snapshotMs ?? file.mtimeMs) <= cutoff).sort((a, b) => a.name.localeCompare(b.name)).map((file) => [file.name, file.text]));
}

/** An overlay whose writes never reach the backing reader or the filesystem. */
export function createMemoryOverlay(readBase) {
  const writes = new Map();
  return {
    writes,
    async read(file) {
      if (writes.has(file)) return writes.get(file);
      return readBase(file);
    },
    async write(file, text) { writes.set(file, String(text)); },
  };
}

async function readJsonl(file) {
  const events = [];
  let malformed = 0;
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  let pending = '';
  for await (const chunk of input) {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { malformed++; }
    }
  }
  if (pending.trim()) { try { events.push(JSON.parse(pending)); } catch { malformed++; } }
  return { events, malformed };
}

function parseNoticeCuts(text) {
  const lines = text.split(/\r?\n/).map((line) => {
    const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z)\s+(.*)$/.exec(line);
    return match ? { at: match[1], body: match[2] } : null;
  }).filter(Boolean);
  const starts = [];
  for (const [index, line] of lines.entries()) if (line.body.startsWith('compact.sizeBefore=')) starts.push(index);
  const cuts = starts.map((start, number) => {
    const end = starts[number + 1] ?? lines.length;
    const terminal = lines.findIndex((entry, index) => index > start && index < end && (entry.body.startsWith('compact.fallback=') || entry.body.startsWith('compacted ')));
    const entries = lines.slice(start, terminal >= 0 ? terminal + 1 : end);
    const find = (pattern) => entries.find((entry) => pattern.test(entry.body));
    const fallback = find(/^compact\.fallback=/);
    const completion = fallback ?? [...entries].reverse().find((entry) => entry.body.startsWith('compacted '));
    const size = /^compact\.sizeBefore=(\d+)/.exec(entries[0].body);
    const over = find(/^seed\.budget_over\s/);
    const card = originalCardNotice({ noticeLines: entries });
    const since = find(/^seed\.since_card=/);
    const adopted = entries.some((entry) => /^seed\.adopted_/.test(entry.body));
    return {
      ordinal: number + 1,
      startedAt: entries[0].at,
      completedAt: completion?.at ?? entries.at(-1)?.at ?? entries[0].at,
      originalSizeBefore: size ? Number(size[1]) : null,
      originalFallback: fallback ? (/^compact\.fallback=([^\s]+)/.exec(fallback.body)?.[1] ?? 'unknown') : null,
      originalBudgetOver: over?.body ?? null,
      card: card.hasCard,
      cardSignals: card,
      sinceCard: since?.body ?? null,
      adopted,
      noticeLines: entries.map(({ at, body }) => ({ at, body })),
    };
  });
  const claimedFallbacks = new Set(cuts.filter((cut) => cut.originalFallback !== null).map((cut) => cut.completedAt));
  for (const [index, line] of lines.entries()) {
    if (!line.body.startsWith('compact.fallback=budget') || claimedFallbacks.has(line.at)) continue;
    // A bounded notices.log can begin in the middle of a cut. Keep that fallback with its
    // surviving seed notices instead of silently losing it because compact.sizeBefore rolled off.
    let start = index - 1;
    while (start >= 0 && !lines[start].body.startsWith('compact.fallback=') && !lines[start].body.startsWith('compacted ')) start--;
    const entries = lines.slice(start + 1, index + 1);
    const card = originalCardNotice({ noticeLines: entries });
    const over = entries.find((entry) => /^seed\.budget_over\s/.test(entry.body));
    const fallbackReason = /^compact\.fallback=([^\s]+)/.exec(line.body)?.[1] ?? 'unknown';
    cuts.push({
      ordinal: 0,
      startedAt: entries[0]?.at ?? line.at,
      completedAt: line.at,
      originalSizeBefore: null,
      originalFallback: fallbackReason,
      originalBudgetOver: over?.body ?? null,
      card: card.hasCard,
      cardSignals: card,
      sinceCard: entries.find((entry) => /^seed\.since_card=/.test(entry.body))?.body ?? null,
      adopted: entries.some((entry) => /^seed\.adopted_/.test(entry.body)),
      noticeLines: entries.map(({ at, body }) => ({ at, body })),
    });
  }
  cuts.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  cuts.forEach((cut, index) => { cut.ordinal = index + 1; });
  return cuts;
}

function collectTranscriptFiles(projectsRoot) {
  const found = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync(projectsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch {}
  for (const dir of dirs) {
    const projectDir = path.join(projectsRoot, dir);
    let files = [];
    try { files = fs.readdirSync(projectDir); } catch { continue; }
    for (const name of files) if (name.endsWith('.jsonl')) found.set(name.slice(0, -6), path.join(projectDir, name));
  }
  return found;
}

function walkFiles(root, directory = root, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(root, file, out);
    else if (entry.isFile()) {
      try {
        const stat = fs.statSync(file);
        out.push({ path: file, name: path.relative(root, file).split(path.sep).join('/'), mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs, text: fs.readFileSync(file, 'utf8') });
      } catch {}
    }
  }
  return out;
}

function identityCutoff(messages, extractor) {
  const identities = new Set();
  for (const message of messages) identities.add(extractor.contentIdentity(message, sha256));
  return identities;
}

function recordIdentity(sourceHash) {
  return /^([a-f0-9]{64})#\d+(?::|$)/.exec(String(sourceHash ?? ''))?.[1];
}

export function historicalCaptureFiles(files, cutAt, identities) {
  const cutoff = isoMs(cutAt);
  const visibleFiles = new Set(captureSnapshotAt(files.map((file) => ({
    ...file,
    // Segment birth time tells whether the numbered file existed at the cut, even if a later
    // turn appended more lines and moved its mtime. Other capture files are overwritten in place.
    snapshotMs: /^segment-\d+\.json$/.test(file.name) ? (file.birthtimeMs ?? file.mtimeMs) : file.mtimeMs,
  })), cutAt).keys());
  const byName = new Map();
  const omittedAfterCut = [];
  const identityFilter = { tagged: 0, matched: 0, dropped: 0, opaque: 0, opaqueIncluded: 0 };
  for (const file of files) {
    if (!visibleFiles.has(file.name)) { omittedAfterCut.push(file.name); continue; }
    if (/^segment-\d+\.json$/.test(file.name)) {
      const kept = [];
      for (const line of file.text.split('\n').filter(Boolean)) {
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        const identity = recordIdentity(record.sourceHash);
        if (identity) {
          identityFilter.tagged++;
          if (identities.has(identity)) {
            identityFilter.matched++;
            kept.push(JSON.stringify(record));
          } else identityFilter.dropped++;
        } else {
          identityFilter.opaque++;
          if (file.mtimeMs <= cutoff) {
            identityFilter.opaqueIncluded++;
            kept.push(JSON.stringify(record));
          }
        }
      }
      if (kept.length) byName.set(file.name, kept.join('\n'));
    } else byName.set(file.name, file.text);
  }
  return { byName, omittedAfterCut, identityFilter };
}

export function cardFromSeedText(value) {
  const text = String(value ?? '').trim();
  if (!text.startsWith('[[exovault:s4-seed:v1]]')) return undefined;
  const start = text.indexOf('\n## Task card\n');
  if (start < 0) return undefined;
  const bodyStart = start + '\n## Task card\n'.length;
  const nextSection = text.indexOf('\n## ', bodyStart);
  let body = (nextSection < 0 ? text.slice(bodyStart) : text.slice(bodyStart, nextSection)).trim();
  body = body.replace(/^\(Kept current by this session's model before the cut; file:[^\n]*\)\s*/u, '').replace(/^### /gm, '## ');
  if (!body) return undefined;
  const truncated = /^\s*-\s+\(\d+ more lines? in [^\n]*task-card\.md\)\s*$/m.test(body)
    || /^\s*-\s+\([^\n]* left out: \d+ lines? in [^\n]*task-card\.md\)\s*$/m.test(body);
  return { text: `# Task card\n${body}`, complete: !truncated };
}

function transcriptCardPathMatches(toolUse, cardPath) {
  const input = toolUse?.input ?? {};
  for (const key of ['file_path', 'path', 'filename', 'target']) {
    if (typeof input[key] !== 'string') continue;
    if (path.resolve(input[key]) === path.resolve(cardPath)) return true;
  }
  return typeof input.command === 'string' && input.command.includes(cardPath);
}

function commandWritesTaskCard(command) {
  return /(?:>>?|\btee\b)\s*[^;\n]*task-card\.md/.test(command)
    || /\bsed\b[^;\n]*\s-i\b[^;\n]*task-card\.md/.test(command)
    || /\bpython\d*\b[\s\S]*task-card\.md[\s\S]*(?:open\s*\(|write\s*\(|\.write_text\s*\()/i.test(command)
    || /\b(?:mv|cp)\b[^;\n]*\s[^;\n]*task-card\.md\s*(?:$|[;&|])/.test(command);
}

function backupCardFromCommand(command, cardPath, cutAt, cwd) {
  const assignment = [...command.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*['"]?([^\s;'"`]*task-card\.md)['"]?/g)]
    .find((match) => path.resolve(match[2]) === path.resolve(cardPath));
  const sourceVar = assignment?.[1];
  let destination;
  if (sourceVar) {
    const escaped = sourceVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const copy = new RegExp(`\\bcp\\s+\\$\\{?${escaped}\\}?\\s+(?:'([^']+)'|"([^"]+)"|([^\\s;|&]+))`).exec(command);
    destination = copy?.[1] ?? copy?.[2] ?? copy?.[3];
  } else {
    const copy = /\bcp\s+(?:'([^']*task-card\.md)'|"([^"]*task-card\.md)"|([^\s;|&]*task-card\.md))\s+(?:'([^']+)'|"([^"]+)"|([^\s;|&]+))/.exec(command);
    if (copy) destination = copy[4] ?? copy[5] ?? copy[6];
  }
  if (!destination || !/task-card/i.test(destination)) return undefined;
  const expanded = destination.replace(/^~(?=\/)/, HOME).replaceAll('$HOME', HOME);
  if (/[${}]/.test(expanded)) return undefined;
  const file = path.resolve(cwd || '/', expanded);
  try {
    const stat = fs.statSync(file);
    if (stat.mtimeMs > isoMs(cutAt)) return undefined;
    const text = fs.readFileSync(file, 'utf8');
    return /^# Task card(?:\r?\n|$)/.test(text) ? text : undefined;
  } catch { return undefined; }
}

/** Recover a cut-era card from a seed or transcript read/write tool exchange when one survives. */
function findTranscriptCard(messages, cardPath, cutAt) {
  let found;
  const pendingReads = new Set();
  for (const message of messages) {
    const fromSeed = cardFromSeedText(message.text);
    if (fromSeed) found = fromSeed.complete ? { text: fromSeed.text, source: 'seed' } : undefined;
    for (const toolUse of message.toolUses ?? []) {
      if (!transcriptCardPathMatches(toolUse, cardPath)) continue;
      const input = toolUse.input ?? {};
      const name = String(toolUse.tool ?? '').toLowerCase();
      if (['write', 'createfile', 'write_file'].includes(name) && typeof input.content === 'string') {
        found = { text: input.content, source: 'transcript' };
      } else if (name === 'edit' && found?.text && typeof input.old_string === 'string' && typeof input.new_string === 'string' && found.text.includes(input.old_string)) {
        found = { text: found.text.replace(input.old_string, input.new_string), source: 'transcript' };
      } else if (name === 'bash') {
        const command = String(input.command ?? '');
        const backup = backupCardFromCommand(command, cardPath, cutAt, message.cwd);
        if (backup) found = { text: backup, source: 'backup' };
        if (commandWritesTaskCard(command)) found = undefined;
        else if (/\b(?:cat|sed|head|tail)\b/.test(command)) pendingReads.add(toolUse.tool_use_id);
      }
    }
    for (const toolResult of message.toolResults ?? []) {
      if (!pendingReads.has(toolResult.tool_use_id)) continue;
      pendingReads.delete(toolResult.tool_use_id);
      const text = String(toolResult.text ?? '').trim();
      if (/^# Task card(?:\r?\n|$)/.test(text)) found = { text, source: 'transcript' };
    }
  }
  return found;
}

function statusProbeOutput(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('## '));
  if (start < 0) return undefined;
  const rows = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) break;
    if (/^(?:\?\?|[ MADRCU?!]{2}\s)/.test(line)) rows.push(line);
    else break;
  }
  return rows.join('\n');
}

function worktreeProbeOutput(text) {
  const value = String(text ?? '');
  if (/^worktree\s+/m.test(value)) return value;
  const blocks = [];
  for (const line of value.split(/\r?\n/)) {
    const match = /^(\S+)\s+([a-f0-9]{7,40})(?:\s+\[([^\]]+)\])?\s*$/.exec(line.trim());
    if (!match) continue;
    blocks.push(`worktree ${match[1]}\nHEAD ${match[2]}${match[3] ? `\nbranch refs/heads/${match[3]}` : ''}`);
  }
  return blocks.length ? blocks.join('\n\n') : undefined;
}

/** Reuse prior Git probe output from this branch's transcript; never claim an empty probe succeeded. */
function historicalGitProbe(messages) {
  const pending = new Map();
  let status;
  let worktrees;
  for (const message of messages) {
    for (const toolUse of message.toolUses ?? []) {
      if (String(toolUse.tool ?? '').toLowerCase() !== 'bash') continue;
      const command = String(toolUse.input?.command ?? '');
      if (/\bgit\b[\s\S]*\bstatus\b/.test(command) && /(?:\s-b\b|\s-sb\b)/.test(command)) pending.set(toolUse.tool_use_id, 'status');
      if (/\bgit\b[\s\S]*\bworktree\s+list\b/.test(command)) pending.set(toolUse.tool_use_id, 'worktrees');
    }
    for (const toolResult of message.toolResults ?? []) {
      const kind = pending.get(toolResult.tool_use_id);
      if (!kind) continue;
      pending.delete(toolResult.tool_use_id);
      if (toolResult.isError) continue;
      if (kind === 'status') status = statusProbeOutput(toolResult.text) ?? status;
      else worktrees = worktreeProbeOutput(toolResult.text) ?? worktrees;
    }
  }
  return { status, worktrees };
}

function boundaryRows(events) {
  return events.map((event, index) => event.type === 'system' && event.subtype === 'compact_boundary'
    ? { index, at: Date.parse(event.timestamp ?? ''), event }
    : null).filter(Boolean);
}

export function matchBoundaries(cuts, boundaries, allCuts = cuts) {
  const available = [...boundaries];
  const matched = new Map();
  const allByStart = [...allCuts].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  for (const cut of [...cuts].sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))) {
    const target = Date.parse(cut.completedAt);
    const startedAt = Date.parse(cut.startedAt);
    const cutPosition = allByStart.indexOf(cut);
    const nextCutStart = cutPosition >= 0 && allByStart[cutPosition + 1]
      ? Date.parse(allByStart[cutPosition + 1].startedAt)
      : Infinity;
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (const [index, boundary] of available.entries()) {
      if (!Number.isFinite(boundary.at)) continue;
      // 400 ms allows measured skew up to 300 ms plus headroom; completion order, the next-cut bound, and durationMs alignment keep earlier boundaries out.
      if (!Number.isFinite(startedAt) || boundary.at < startedAt - 400 || boundary.at >= nextCutStart) continue;
      const durationValue = boundary.event?.compactMetadata?.durationMs;
      if (durationValue !== undefined && durationValue !== null) {
        const durationMs = Number(durationValue);
        if (!Number.isFinite(durationMs) || Math.abs(boundary.at - durationMs - startedAt) > 10_000) continue;
      }
      const distance = Math.abs(boundary.at - target);
      if (distance > 5 * 60_000) continue;
      if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
    }
    if (bestIndex >= 0) matched.set(cut, available.splice(bestIndex, 1)[0]);
  }
  return matched;
}

export function matchSessionBoundaries(session, cuts, boundaries) {
  return matchBoundaries(cuts, boundaries, session.allCuts ?? session.cuts ?? cuts);
}

export function discoverData(captureRoot, projectsRoot, noticesBefore) {
  const transcripts = collectTranscriptFiles(projectsRoot);
  const sessions = [];
  let dirs = [];
  try { dirs = fs.readdirSync(captureRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); } catch {}
  for (const sessionId of dirs) {
    const sessionDir = path.join(captureRoot, sessionId);
    const noticePath = path.join(sessionDir, 'notices.log');
    let notices;
    try { notices = fs.readFileSync(noticePath, 'utf8'); } catch { continue; }
    const parsedCuts = parseNoticeCuts(notices);
    const cuts = Number.isFinite(noticesBefore) ? parsedCuts.filter((cut) => Date.parse(cut.completedAt) <= noticesBefore) : parsedCuts;
    const fallbacks = cuts.filter((cut) => cut.originalFallback === 'budget');
    if (!fallbacks.length) continue;
    sessions.push({ sessionId, sessionDir, transcriptPath: transcripts.get(sessionId), cuts, allCuts: parsedCuts, fallbacks, captureFiles: walkFiles(sessionDir) });
  }
  return sessions;
}

function controlsBeforeFallbacks(cuts) {
  const selected = new Set();
  for (const fallback of cuts.filter((cut) => cut.originalFallback === 'budget')) {
    const prior = cuts[fallback.ordinal - 2];
    if (prior?.card && prior.originalFallback === null) selected.add(prior);
  }
  return [...selected].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

function localOptions(pluginDir, settingsFile) {
  const manifestPath = path.join(pluginDir, '.claude-plugin/plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const options = Object.fromEntries(Object.entries(manifest.userConfig ?? {}).filter(([, setting]) => Object.hasOwn(setting, 'default')).map(([name, setting]) => [name, setting.default]));
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const configs = Object.entries(settings.pluginConfigs ?? {}).filter(([name]) => name === 'exo-compact' || name.startsWith('exo-compact@'));
    const config = configs.find(([name]) => name === 'exo-compact@exo-compact') ?? configs[0];
    Object.assign(options, config?.[1]?.options ?? {});
  } catch {}
  // Replay-only bounds: no network/model process or external token service. The cut notice selects its counter.
  Object.assign(options, {
    recallVectors: false,
    jevEnabled: false,
    jevDenseRerank: false,
    ruleCheck: false,
    briefCheck: false,
    briefPush: false,
    notices: 'all',
    recallPluginRoot: pluginDir,
  });
  return options;
}

async function loadPlugin(pluginDir) {
  const pluginUrl = pathToFileURL(`${path.resolve(pluginDir)}${path.sep}`).href;
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(pluginUrl) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const candidate = path.resolve(path.dirname(new URL(context.parentURL).pathname), `${specifier.slice(0, -3)}.ts`);
      if (candidate.startsWith(path.resolve(pluginDir) + path.sep) && fs.existsSync(candidate)) return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    return nextResolve(specifier, context);
  } });
  const module = await import(pathToFileURL(path.join(pluginDir, 'compact.ts')));
  const extractor = await import(pathToFileURL(path.join(pluginDir, 'core/extractor.ts')));
  const budgetCore = await import(pathToFileURL(path.join(pluginDir, 'core/budgets.ts')));
  return { register: module.register, extractor, budgetCore };
}

function handlersFor(register, options) {
  const handlers = new Map();
  const on = (name, handler) => {
    const entry = { handler, catcher: undefined };
    handlers.set(name, entry);
    const builder = { catch(catcher) { entry.catcher = catcher; return builder; } };
    return builder;
  };
  register(on, options);
  return handlers;
}

function listSnapshot(snapshot, memoryWrites, directory) {
  const prefix = `${path.resolve(directory).replace(/[\\/]$/, '')}${path.sep}`;
  const names = new Map();
  const addPath = (absolute, size) => {
    if (!absolute.startsWith(prefix)) return;
    const rest = absolute.slice(prefix.length);
    if (!rest) return;
    const [name, ...tail] = rest.split(path.sep);
    const isDir = tail.length > 0;
    const previous = names.get(name);
    if (!previous || isDir) names.set(name, { name, kind: isDir ? 'dir' : 'file', size: isDir ? 0 : size });
  };
  for (const [file, text] of snapshot) addPath(file, Buffer.byteLength(text));
  for (const [file, text] of memoryWrites) addPath(file, Buffer.byteLength(text));
  return [...names.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function physicalStat(file) {
  try { return fs.statSync(file); } catch { return null; }
}

function timelineAtCut(text, cutAt) {
  try {
    const value = JSON.parse(text);
    if (!Array.isArray(value.segments)) return text;
    const cutoff = Date.parse(cutAt);
    value.segments = value.segments.filter((segment) => Date.parse(segment.to) <= cutoff);
    return JSON.stringify(value);
  } catch { return text; }
}

function briefIndexAtCut(text, cutAt) {
  try {
    const value = JSON.parse(text);
    if (!Array.isArray(value)) return text;
    const cutoff = Date.parse(cutAt);
    return JSON.stringify(value.filter((entry) => Date.parse(entry.at) <= cutoff));
  } catch { return text; }
}

function budgetParts(text) {
  const match = /seed\.budget_over seed=(\d+)\/(\d+) tail=(\d+)\/(\d+) total=(\d+)/.exec(String(text ?? ''));
  return match ? match.slice(1).map(Number) : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function ratioRange(values) {
  return values.length ? { min: Math.min(...values), max: Math.max(...values) } : null;
}

function noticeNumber(logs, pattern) {
  for (const line of logs) {
    const match = pattern.exec(line);
    if (match) return Number(match[1]);
  }
  return null;
}

export function replaySeedMetrics({ result, logs, realTokenCount, budgetCore, fellBack = false }) {
  const seedMessage = Array.isArray(result?.messages) ? result.messages[0] : undefined;
  const countTokens = realTokenCount ? budgetCore.estimateTokens : (text) => Math.ceil(String(text ?? '').length / 4);
  const seedTokens = !fellBack && seedMessage ? budgetCore.serializedTokens([seedMessage], countTokens) : null;
  const tokensAfter = Number.isFinite(result?.tokensAfter) ? result.tokensAfter : null;
  const over = budgetParts(logs.find((line) => line.startsWith('seed.budget_over ')));
  const baseTotal = noticeNumber(logs, /\bseed\.budget_total=(\d+)/);
  const baseSeed = noticeNumber(logs, /\bseed\.budget_split seed=(\d+)/);
  const baseTail = noticeNumber(logs, /\bseed\.budget_split seed=\d+ tail=(\d+)/);
  const shifted = noticeNumber(logs, /\bseed\.brief_tail_shift=(\d+)/) ?? 0;
  const returned = noticeNumber(logs, /\bseed\.brief_shift_returned=(\d+)/) ?? 0;
  const effectiveTailBudget = baseTail === null ? null : Math.max(0, baseTail - Math.max(0, shifted - returned));
  const taskCard = noticeNumber(logs, /^seed\.task_card=(\d+)/);
  const briefLastPrompt = noticeNumber(logs, /\bseed\.brief_last_prompt=(\d+)/);
  const cardOn = taskCard === 1 || briefLastPrompt === 1;
  let seedBudget = over?.[1] ?? null;
  if (seedBudget === null && Number.isFinite(baseTotal) && Number.isFinite(baseSeed) && Number.isFinite(baseTail) && Number.isFinite(seedTokens) && Number.isFinite(tokensAfter)) {
    const tailTokens = Math.max(0, tokensAfter - seedTokens);
    seedBudget = cardOn && tailTokens > effectiveTailBudget
      ? baseTotal - effectiveTailBudget
      : baseTotal - tailTokens;
  }
  if (seedBudget === null && Number.isFinite(baseSeed)) seedBudget = baseSeed;
  return {
    seedTokens,
    tokensAfter,
    seedBudget,
    seedMargin: Number.isFinite(seedBudget) && Number.isFinite(seedTokens) ? seedBudget - seedTokens : null,
  };
}

export function makeHost({ sessionId, sessionDir, cwd, cut, snapshot: snapshotFiles, pluginDir, gitProbe }) {
  const snapshot = new Map([...snapshotFiles].map(([name, text]) => [path.resolve(sessionDir, name), text]));
  const overlay = createMemoryOverlay(async (file) => {
    if (snapshot.has(path.resolve(file))) return snapshot.get(path.resolve(file));
    if (file.endsWith('/timeline.json')) {
      const base = fs.readFileSync(file, 'utf8');
      return timelineAtCut(base, cut.startedAt);
    }
    if (file.endsWith('/briefs/briefs.json')) {
      const base = fs.readFileSync(file, 'utf8');
      return briefIndexAtCut(base, cut.startedAt);
    }
    const isRecall = file.includes(`${path.sep}.claude${path.sep}exovault${path.sep}recall${path.sep}`);
    if (isRecall) {
      const stat = physicalStat(file);
      if (!stat || stat.mtimeMs > Date.parse(cut.startedAt)) throw Object.assign(new Error(`ENOENT: historical file unavailable: ${file}`), { code: 'ENOENT' });
    }
    return fs.readFileSync(file, 'utf8');
  });
  const sessionCaptureDir = path.resolve(sessionDir);
  const memoryWrites = overlay.writes;
  const isCapturePath = (file) => {
    const resolved = path.resolve(file);
    return resolved === sessionCaptureDir || resolved.startsWith(`${sessionCaptureDir}${path.sep}`);
  };
  const fsRead = async (file) => {
    if (isCapturePath(file) && !snapshot.has(path.resolve(file)) && !memoryWrites.has(path.resolve(file))) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    return overlay.read(path.resolve(file));
  };
  const fsWrite = async (file, text) => overlay.write(path.resolve(file), text);
  const fsExists = async (file) => {
    const resolved = path.resolve(file);
    if (snapshot.has(resolved) || memoryWrites.has(resolved)) return true;
    if (isCapturePath(resolved)) return false;
    if (resolved.endsWith('/timeline.json') || resolved.endsWith('/briefs/briefs.json')) return fs.existsSync(resolved);
    if (resolved.includes(`${path.sep}.claude${path.sep}exovault${path.sep}recall${path.sep}`)) {
      const stat = physicalStat(resolved);
      return Boolean(stat && stat.mtimeMs <= Date.parse(cut.startedAt));
    }
    return fs.existsSync(resolved);
  };
  const fsList = async (directory) => {
    if (isCapturePath(directory)) return listSnapshot(snapshot, memoryWrites, directory);
    return fs.readdirSync(directory, { withFileTypes: true }).map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? 'dir' : 'file', size: entry.isFile() ? fs.statSync(path.join(directory, entry.name)).size : 0 }));
  };
  const time = Date.parse(cut.startedAt);
  let clockTicks = 0;
  const logs = [];
  const host = fakeHost({
    pluginRoot: pluginDir,
    fsRead,
    fsWrite,
    fsList,
    fsExists,
    uiLog: (line) => logs.push(String(line)),
    sessionId: async () => sessionId,
    sessionCwd: async () => cwd,
    envGet: async (name) => ({ HOME, CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'), CLAUDE_CODE_ENTRYPOINT: 'terminal' })[name],
    processRun: async (argv = []) => {
      if (argv[0] === 'git' && argv.includes('status')) return gitProbe.status ? { exitCode: 0, stdout: gitProbe.status, stderr: '' } : { exitCode: 1, stdout: '', stderr: 'historical Git status unavailable in transcript' };
      if (argv[0] === 'git' && argv.includes('worktree') && argv.includes('list')) return gitProbe.worktrees ? { exitCode: 0, stdout: gitProbe.worktrees, stderr: '' } : { exitCode: 1, stdout: '', stderr: 'historical Git worktree list unavailable in transcript' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    httpFetch: async () => {
      throw Object.assign(new Error('fallback-replay: HTTP fetch is disabled'), { code: 'REPLAY_HTTP_DISABLED' });
    },
    clockNow: async () => time + clockTicks++ * 25,
  });
  host.session.root = async () => HOME;
  host.session.surfaces = async () => [{ type: 'terminal' }];
  return { host, logs, writes: memoryWrites, snapshot };
}

export async function replayCut({ plugin, register, extractor, budgetCore, session, cut, boundary, options }) {
  if (!session.transcriptPath) return { sessionId: session.sessionId, ordinal: cut.ordinal, type: cut.type, eligible: false, reason: 'transcript missing' };
  if (!boundary) return { sessionId: session.sessionId, ordinal: cut.ordinal, type: cut.type, eligible: false, reason: 'no compact boundary matched cut start, duration, and five-minute notice window' };
  const events = session.events;
  const eventMessageDetails = messagesAtBoundaryDetails(events, boundary.index);
  const eventMessages = eventMessageDetails.messages;
  const branchMessages = messagesThroughBoundary(events, boundary.index);
  const identities = identityCutoff(branchMessages, extractor);
  const historical = historicalCaptureFiles(session.captureFiles, cut.startedAt, identities);
  const cardPath = path.join(session.sessionDir, 'task-card.md');
  const currentCard = session.captureFiles.find((file) => file.name === 'task-card.md')?.text;
  const historicalCard = findTranscriptCard(branchMessages, cardPath, cut.startedAt);
  const gitProbe = historicalGitProbe(branchMessages);
  const cardState = restoreTaskCardForCut({
    cut,
    snapshot: historical.byName,
    historicalCard,
    currentText: currentCard,
  });
  const fullNotices = session.captureFiles.find((file) => file.name === 'notices.log')?.text ?? '';
  const activeToolUseIds = new Set(branchMessages.flatMap((message) => (message.toolUses ?? []).map((toolUse) => toolUse.tool_use_id)));
  const cardHorizon = restoreTaskCardHorizonForCut({
    cut,
    snapshot: cardState.snapshot,
    noticeText: fullNotices,
    events,
    activeToolUseIds,
  });
  historical.byName = cardHorizon.snapshot;
  const { host, logs, snapshot } = makeHost({
    sessionId: session.sessionId,
    sessionDir: session.sessionDir,
    cwd: events.slice(0, boundary.index).toReversed().find((event) => typeof event.cwd === 'string')?.cwd ?? '/project',
    cut,
    snapshot: historical.byName,
    pluginDir: plugin,
    gitProbe,
  });
  const input = { trigger: ['auto', 'manual', 'plugin'].includes(boundary.event.compactMetadata?.trigger) ? boundary.event.compactMetadata.trigger : 'auto', messages: eventMessages };
  const cutOptions = { ...options, realTokenCount: realTokenCountForCut(cut) };
  const handlers = handlersFor(register, cutOptions);
  let nextCalls = 0;
  const next = async () => { nextCalls++; return { messages: input.messages }; };
  const entry = handlers.get('session.compact');
  if (!entry) return { sessionId: session.sessionId, ordinal: cut.ordinal, type: cut.type, eligible: false, reason: 'plugin did not register session.compact' };
  let result;
  try {
    result = await entry.handler(host, input, next);
  } catch (error) {
    if (entry.catcher) result = await entry.catcher(host, input, Object.assign(next, { error: { kind: 'throw' }, cause: error }));
    else throw error;
  }
  const fallbackLine = logs.find((line) => line.startsWith('compact.fallback='));
  const reason = fallbackLine ? (/^compact\.fallback=([^\s]+)/.exec(fallbackLine)?.[1] ?? 'unknown') : null;
  const sizeLine = logs.find((line) => line.startsWith('compact.sizeBefore='));
  const budgetOver = logs.find((line) => line.startsWith('seed.budget_over '));
  const seedMetrics = replaySeedMetrics({ result, logs, realTokenCount: cutOptions.realTokenCount, budgetCore, fellBack: nextCalls > 0 });
  const s5zPrefixes = ['seed.session_map_shrunk=', 'seed.constraints_shrunk=', 'seed.ids_dropped_for_budget='];
  const replay = {
    fellBack: nextCalls > 0,
    reason,
    realTokenCount: cutOptions.realTokenCount,
    sizeBefore: sizeLine ? Number(/^compact\.sizeBefore=(\d+)/.exec(sizeLine)?.[1]) : null,
    ...seedMetrics,
    budgetOver: budgetOver ?? null,
    sectionSizes: sectionSizes(logs.map((body) => ({ body }))),
    sectionNotices: sectionNotices(logs),
    workStateProbe: { statusRecovered: Boolean(gitProbe.status), worktreesRecovered: Boolean(gitProbe.worktrees) },
    s5z: Object.fromEntries(s5zPrefixes.map((prefix) => [prefix.slice(0, -1), logs.find((line) => line.startsWith(prefix)) ?? null])),
    s5zNotices: logs.filter((line) => s5zPrefixes.some((prefix) => line.startsWith(prefix))),
    resultShape: result && typeof result === 'object' ? Object.keys(result) : [],
  };
  const reproduced = cut.type === 'fallback' ? replay.fellBack && replay.reason === 'budget' : !replay.fellBack;
  const excludedReason = reproduced ? null : cut.type === 'fallback'
    ? (replay.fellBack ? `replay fell back for ${replay.reason ?? 'unknown'}` : 'replay did not fall back')
    : `control fell back for ${replay.reason ?? 'unknown'}`;
  return {
    sessionId: session.sessionId,
    ordinal: cut.ordinal,
    type: cut.type,
    eligible: true,
    cutAt: cut.startedAt,
    boundaryAt: boundary.event.timestamp,
    boundaryIndex: boundary.index,
    messageCount: eventMessages.length,
    activeBranchMessageCount: branchMessages.length,
    original: {
      sizeBefore: cut.originalSizeBefore,
      fallback: cut.originalFallback,
      budgetOver: cut.originalBudgetOver,
      card: cut.card,
      cardSignals: cut.cardSignals,
      sectionSizes: sectionSizes(cut.noticeLines),
      sectionNotices: sectionNotices(cut.noticeLines),
    },
    replay,
    fidelity: {
      transcriptMessageSource: eventMessageDetails.source,
      captureIdentityFilter: {
        taggedRecords: historical.identityFilter.tagged,
        matchedRecords: historical.identityFilter.matched,
        droppedRecords: historical.identityFilter.dropped,
        droppedRatio: historical.identityFilter.tagged ? historical.identityFilter.dropped / historical.identityFilter.tagged : null,
        opaqueRecords: historical.identityFilter.opaque,
        opaqueIncludedRecords: historical.identityFilter.opaqueIncluded,
      },
    },
    reproduced,
    excludedReason,
    snapshot: {
      files: snapshot.size,
      omittedAfterCut: historical.omittedAfterCut.length,
      taskCardRecovered: cut.card && !session.captureFiles.some((file) => file.name === 'task-card.md' && file.mtimeMs <= Date.parse(cut.startedAt)) && snapshot.has(cardPath),
      cardSource: cardState.cardSource,
      cardHorizonSource: cardHorizon.horizonSource,
    },
  };
}

function parseArgs(argv) {
  const args = { plugin: path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../plugin/compact'), out: undefined, noticesBefore: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--plugin') args.plugin = path.resolve(argv[++i]);
    else if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
    else if (argv[i] === '--notices-before') args.noticesBefore = argv[++i];
    else if (argv[i] === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function shortTable(rows) {
  const out = ['| Session | Cuts replayed | Original budget fallbacks | Replay budget fallbacks | Controls newly falling back |', '|---|---:|---:|---:|---:|'];
  for (const row of rows) out.push(`| ${row.sessionId} | ${row.replayed}/${row.candidateCuts} | ${row.originalFallbacks} | ${row.replayBudgetFallbacks} | ${row.newControlFallbacks} |`);
  const total = rows.reduce((acc, row) => ({
    replayed: acc.replayed + row.replayed,
    candidateCuts: acc.candidateCuts + row.candidateCuts,
    originalFallbacks: acc.originalFallbacks + row.originalFallbacks,
    replayBudgetFallbacks: acc.replayBudgetFallbacks + row.replayBudgetFallbacks,
    newControlFallbacks: acc.newControlFallbacks + row.newControlFallbacks,
  }), { replayed: 0, candidateCuts: 0, originalFallbacks: 0, replayBudgetFallbacks: 0, newControlFallbacks: 0 });
  out.push(`| **Total** | **${total.replayed}/${total.candidateCuts}** | **${total.originalFallbacks}** | **${total.replayBudgetFallbacks}** | **${total.newControlFallbacks}** |`);
  return out.join('\n');
}

export async function runReplay({ pluginDir, captureRoot = CAPTURE_ROOT, projectsRoot = PROJECTS_ROOT, settingsFile = path.join(HOME, '.claude/settings.json'), noticesBefore }) {
  const plugin = path.resolve(pluginDir);
  const options = localOptions(plugin, settingsFile);
  const { register, extractor, budgetCore } = await loadPlugin(plugin);
  const cutoff = noticesBefore === undefined ? undefined : Date.parse(noticesBefore);
  if (cutoff !== undefined && !Number.isFinite(cutoff)) throw new Error(`Invalid --notices-before timestamp: ${noticesBefore}`);
  const sessions = discoverData(captureRoot, projectsRoot, cutoff);
  const results = [];
  for (const session of sessions) {
    const selected = new Set([...session.fallbacks, ...controlsBeforeFallbacks(session.cuts)]);
    if (!session.transcriptPath) {
      for (const cut of selected) results.push({ sessionId: session.sessionId, ordinal: cut.ordinal, type: cut.originalFallback === 'budget' ? 'fallback' : 'control', eligible: false, reason: 'transcript missing' });
      continue;
    }
    const transcript = await readJsonl(session.transcriptPath);
    session.events = transcript.events;
    const boundaries = boundaryRows(session.events);
    const byCut = matchSessionBoundaries(session, [...selected], boundaries);
    for (const cut of [...selected].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))) {
      cut.type = cut.originalFallback === 'budget' ? 'fallback' : 'control';
      results.push(await replayCut({ plugin, register, extractor, budgetCore, session, cut, boundary: byCut.get(cut), options }));
    }
  }
  const sessionsSummary = sessions.map((session) => {
    const rows = results.filter((row) => row.sessionId === session.sessionId);
    const eligible = rows.filter((row) => row.eligible);
    return {
      sessionId: session.sessionId,
      candidateCuts: session.fallbacks.length + controlsBeforeFallbacks(session.cuts).length,
      replayed: eligible.length,
      originalFallbacks: session.fallbacks.length,
      reproducedFallbacks: eligible.filter((row) => row.type === 'fallback' && row.replay.fellBack && row.replay.reason === 'budget').length,
      controls: controlsBeforeFallbacks(session.cuts).length,
      reproducedControls: eligible.filter((row) => row.type === 'control' && !row.replay.fellBack).length,
      replayBudgetFallbacks: eligible.filter((row) => row.replay.fellBack && row.replay.reason === 'budget').length,
      newControlFallbacks: eligible.filter((row) => row.type === 'control' && row.replay.fellBack).length,
    };
  });
  const fallbackCuts = results.filter((row) => row.type === 'fallback');
  const controls = results.filter((row) => row.type === 'control');
  const sizePairs = results.filter((row) => row.eligible && row.original.sizeBefore !== null && row.replay.sizeBefore !== null);
  const budgetPairs = results.filter((row) => row.eligible && row.original.budgetOver !== null && row.replay.budgetOver !== null);
  const sizeRatios = sizePairs.map((row) => row.replay.sizeBefore / row.original.sizeBefore);
  const seedRatios = budgetPairs.map((row) => budgetParts(row.replay.budgetOver)?.[0] / budgetParts(row.original.budgetOver)?.[0]).filter(Number.isFinite);
  const tailRatios = budgetPairs.map((row) => budgetParts(row.replay.budgetOver)?.[2] / budgetParts(row.original.budgetOver)?.[2]).filter(Number.isFinite);
  const totalRatios = budgetPairs.map((row) => budgetParts(row.replay.budgetOver)?.[4] / budgetParts(row.original.budgetOver)?.[4]).filter(Number.isFinite);
  const seedSizePairs = fallbackCuts.filter((row) => row.eligible && !row.replay.fellBack && budgetParts(row.original.budgetOver) && Number.isFinite(row.replay.seedTokens)).map((row) => {
    const loggedSeed = budgetParts(row.original.budgetOver)[0];
    const sectionDifferences = {};
    for (const key of Object.keys(row.original.sectionSizes)) {
      if (!Object.hasOwn(row.replay.sectionSizes, key)) continue;
      const original = row.original.sectionSizes[key];
      const replay = row.replay.sectionSizes[key];
      if (original !== replay) sectionDifferences[key] = { original, replay, delta: replay - original };
    }
    return {
      sessionId: row.sessionId,
      ordinal: row.ordinal,
      originalSeed: loggedSeed,
      replaySeed: row.replay.seedTokens,
      ratio: row.replay.seedTokens / loggedSeed,
      gap: row.replay.seedTokens - loggedSeed,
      cardSource: row.snapshot.cardSource,
      sectionDifferences,
    };
  });
  const keptSeedMargins = results
    .filter((row) => row.eligible && !row.replay.fellBack && Number.isFinite(row.replay.seedMargin))
    .map((row) => row.replay.seedMargin);
  const cardSourceCounts = {};
  for (const row of results.filter((item) => item.eligible)) {
    const source = row.snapshot.cardSource ?? 'unavailable';
    cardSourceCounts[source] = (cardSourceCounts[source] ?? 0) + 1;
  }
  const cardCutCount = results.filter((row) => row.eligible && row.original.card).length;
  const seedSizeRatios = seedSizePairs.map((row) => row.ratio);
  const report = {
    pluginDir: plugin,
    pluginVersion: JSON.parse(fs.readFileSync(path.join(plugin, '.claude-plugin/plugin.json'), 'utf8')).version,
    runAt: new Date().toISOString(),
    noticesBefore: noticesBefore ?? null,
    settingsSource: settingsFile,
    options: Object.fromEntries(['recallEnabled', 'interactiveOnly', 'taskCard', 'sessionMap', 'cardTotalBudgetTokens', 'realTokenCount', 'jevEnabled', 'recallVectors', 'workStateProbe', 'notices'].map((key) => [key, options[key]])),
    method: {
      captureRule: 'Overwritten capture sidecars are admitted by mtime at the cut. A numbered segment is visible only if its birthtime is at or before the cut; its sourceHash records are then filtered to the active transcript branch through the target boundary, while opaque records also need mtime at or before the cut. Original task-card notices and the card budget split determine whether a cut had a card. When the snapshot lacks it, a surviving transcript seed/read/write is used when available, then the current task-card.md text. A missing card horizon is rebuilt only when the original cut logged a found horizon and its refresh/write notices pair with an active-branch tool result. timeline.json segments and briefs.json entries are filtered by their to/at timestamps.',
      transcriptRule: 'Use the parentUuid chain from the matched boundary logicalParentUuid back to the preceding compact_boundary when complete, excluding sidechains; fall back to the intervening user/assistant events when links are missing. A boundary may start up to 400 ms before the cut for measured clock skew up to 300 ms plus headroom; greedy completion order, the next-cut bound in the full notice log, and durationMs alignment within ten seconds of the logged cut start (when present) keep an earlier cut boundary out. The boundary must be within five minutes of the notice completion time.',
      seedSize: 'diagnostics.seedSize compares replay seed tokens with the logged over-budget seed. This measures replay fidelity only when the replayed plugin is the one that logged the cut; with a fixed plugin, it measures trim against the logged seed.',
      writes: 'All $.fs.write operations are held in an in-memory map; process.run does not launch commands, but supplies preceding transcript output for Git status/worktree probes. Other process calls are inert, HTTP fetch throws, and no capture or transcript paths are written.',
      limits: [
        'Replay reads the current default capture and transcript roots; rolling notices and later input updates can change selected cuts or ordinals between runs.',
        'Replay reconstructs messages from transcript branches and does not model compactMetadata.preservedMessages, so a native preserved tail is not reproduced.',
        'Capture segments have no per-record timestamp; sourceHash-to-transcript matching can misclassify identical repeated messages, and opaque synthetic records in a pre-existing segment are limited by the whole file mtime. Transcript parent chains are missing for some cuts, so those cuts use the interval fallback.',
        'Transcript-derived task-card text can lag a refresh when the transcript contains a shell edit that cannot be replayed safely; such cuts use the current file and report cardSource=current. Other overwritten sidecars are only available when their mtime is at or before the target cut.',
        'A card horizon is unavailable when notices do not show a successful pre-cut refresh or the refresh cannot be paired with an active-branch tool call. Those cuts retain the original horizon-missing behavior.',
        'Each replay uses the cut\'s seed.budget_count notice (real or chars4); cuts without that notice default to realTokenCount=true.',
        'Current settings are merged with manifest defaults; replay disables recall vectors, Jev, rule checks, brief checks and brief pushes. The active settings report jevEnabled=false; ruleCheck=true was disabled to keep the replay offline.',
        'Git work-state probes reuse the latest preceding status and worktree output found in the selected transcript branch. If the transcript has no usable output, that part of the probe is unavailable instead of being synthesized as an empty successful result.',
      ],
    },
    fidelity: {
      fallbacks: { expected: fallbackCuts.length, eligible: fallbackCuts.filter((row) => row.eligible).length, reproducedBudget: fallbackCuts.filter((row) => row.eligible && row.reproduced).length },
      controls: { expected: controls.length, eligible: controls.filter((row) => row.eligible).length, reproducedNoFallback: controls.filter((row) => row.eligible && row.reproduced).length },
    },
    diagnostics: {
      cardSources: { selectedCuts: results.filter((row) => row.eligible).length, cardCuts: cardCutCount, counts: cardSourceCounts },
      sizeBefore: {
        compared: sizePairs.length,
        exact: sizePairs.filter((row) => row.original.sizeBefore === row.replay.sizeBefore).length,
        medianReplayToLoggedRatio: median(sizeRatios),
        replayToLoggedRatioRange: ratioRange(sizeRatios),
      },
      budgetOver: {
        compared: budgetPairs.length,
        exact: budgetPairs.filter((row) => JSON.stringify(budgetParts(row.original.budgetOver)) === JSON.stringify(budgetParts(row.replay.budgetOver))).length,
        medianReplayToLoggedSeedRatio: median(seedRatios),
        replayToLoggedSeedRatioRange: ratioRange(seedRatios),
        medianReplayToLoggedTailRatio: median(tailRatios),
        replayToLoggedTailRatioRange: ratioRange(tailRatios),
        medianReplayToLoggedTotalRatio: median(totalRatios),
        replayToLoggedTotalRatioRange: ratioRange(totalRatios),
      },
      seedSize: {
        note: 'Replay seed versus logged over-budget seed: fidelity only for the plugin that logged the cut; with a fixed plugin, this reflects trim against that seed.',
        compared: seedSizePairs.length,
        medianReplayToLoggedRatio: median(seedSizeRatios),
        replayToLoggedRatioRange: ratioRange(seedSizeRatios),
        largestGaps: [...seedSizePairs].sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 12),
      },
      keptSeedMargin: {
        compared: keptSeedMargins.length,
        median: median(keptSeedMargins),
        range: keptSeedMargins.length ? { min: Math.min(...keptSeedMargins), max: Math.max(...keptSeedMargins) } : null,
        method: 'Effective seed allowance minus replay seed tokens; derived from the returned seed/tokensAfter and replay budget notices.',
      },
    },
    sessions: sessionsSummary,
    cuts: results,
    excluded: results.filter((row) => !row.eligible || !row.reproduced),
    table: shortTable(sessionsSummary),
  };
  return report;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('Usage: node --experimental-strip-types tools/real-replay/fallback-replay.mjs [--plugin <plugin/compact>] [--notices-before <ISO timestamp>] [--out <summary.json>]\n');
    return;
  }
  const report = await runReplay({ pluginDir: args.plugin, noticesBefore: args.noticesBefore });
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${report.table}\n`);
  process.stdout.write(`Fidelity: ${report.fidelity.fallbacks.reproducedBudget}/${report.fidelity.fallbacks.expected} fallbacks; ${report.fidelity.controls.reproducedNoFallback}/${report.fidelity.controls.expected} controls.\n`);
  if (args.out) process.stdout.write(`JSON: ${args.out}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
}
