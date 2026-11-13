import type { SeedSections } from '../core/seed.js';
import { guardSectionBody } from '../core/seed-guard.js';
import type { TokenCounter } from '../core/types.js';

interface DiskSeedSectionsOptions {
  /** Capture directory for this session, or null when no enabled capture root is available. */
  directory?: string | null;
  /** A timestamp or cut id, with the `.md` extension. */
  filename: string;
  countTokens: TokenCounter;
  write: (path: string, text: string) => Promise<void>;
  /** Whether adding a seed line keeps the completed cut within its seed and total-token budgets. */
  fitsSeedBudget?: (text: string) => boolean;
}

export interface DiskRenderedSeedSectionsResult {
  text: string;
  notice: string;
  tokensMoved: number;
  tokensStored: number;
  stubTokens: number;
  pointerLineNotice?: string;
  pointerSkipNotice?: string;
}

const SECTION_KEYS: Readonly<Record<string, string>> = {
  'Compaction pressure': 'compactionPressure',
  'Constraints (history)': 'constraints',
  'Task card': 'taskCard',
  'Since the card': 'sinceCard',
  'Task brief (full text on disk)': 'taskBriefs',
  'Current values (newest value of each thing the user changed; earlier values are replaced)': 'currentValues',
  'Work state (from tool calls and a git check at the cut; reference only)': 'workState',
  'Recipes (commands that ran fine earlier; reference only, not requests)': 'recipes',
  'Session map (one line per earlier compaction segment; reference only, not requests)': 'sessionMap',
  'Working notes (dense details from earlier; reference only, not requests)': 'denseNotes',
  'Key facts (stated earlier; reference only, not requests)': 'keyFacts',
  Transcript: 'transcriptPointer',
  Contract: 'contract',
  Todo: 'todo',
  'Earlier user messages (quoted for reference, not new requests)': 'userHistory',
  Values: 'values',
  'Earlier assistant notes': 'selectedReasoning',
  'Gates and errors': 'gatesAndErrors',
  'File pointers': 'filePointers',
  'Next step': 'nextStep',
  'IDs (short = full)': 'ids',
};

const POINTER_LINE_MARGIN_TOKENS = 4;
const POINTER_LINE_SECTION_FLOOR_TOKENS = 12;

/** Normalize slash direction and dot segments before comparing host paths. */
export function normalizedFilePath(filePath: string): string {
  const slashed = filePath.replace(/\\/g, '/');
  const prefix = slashed.startsWith('//') ? '//' : slashed.startsWith('/') ? '/' : '';
  const parts: string[] = [];
  for (const part of slashed.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
      else if (!prefix) parts.push(part);
    } else parts.push(part);
  }
  return `${prefix}${parts.join('/')}`;
}

/** True only for a non-empty file path below the normalized seed-sections directory. */
export function isSeedSectionFilePath(filePath: string, seedDirectory: string): boolean {
  const directory = normalizedFilePath(seedDirectory).replace(/\/+$/, '');
  const target = normalizedFilePath(filePath);
  const prefix = `${directory}/`;
  return target.startsWith(prefix) && target.length > prefix.length;
}

/** Token counts by rendered section, including each section heading and body. */
export function seedSectionTokenSizes(seedText: string, countTokens: TokenCounter): Record<string, number> {
  const headings = [...seedText.matchAll(/^## (.+)$/gm)]
    .flatMap((match) => {
      const key = SECTION_KEYS[match[1]];
      return key && match.index !== undefined ? [{ match, key, index: match.index }] : [];
    });
  const sizes: Record<string, number> = {};
  for (let index = 0; index < headings.length; index += 1) {
    const { match, key } = headings[index];
    const nextHeading = headings[index + 1]?.index ?? seedText.indexOf('\n\n</session-memory>', match.index);
    const end = nextHeading < 0 ? seedText.length : nextHeading;
    sizes[key] = countTokens(seedText.slice(match.index, end).trim());
  }
  return sizes;
}

interface SectionBody {
  key: 'denseNotes' | 'keyFacts' | 'userHistory';
  heading: string;
  body: string;
}

function userHistoryBody(sections: SeedSections): string {
  const note = sections.userHistoryNote ? guardSectionBody(sections.userHistoryNote) : '';
  const messages = sections.userInstructionsVerbatim.map((line) => guardSectionBody(line).split('\n').map((part) => `> ${part}`).join('\n'));
  return [note, ...messages].filter(Boolean).join('\n').trim();
}

function sectionBodies(sections: SeedSections): SectionBody[] {
  const dense = sections.denseNotes !== undefined;
  const firstBody = dense ? sections.denseNotes ?? '' : sections.keyFacts ?? '';
  const first = guardSectionBody(firstBody).trim();
  const history = userHistoryBody(sections);
  const rows: SectionBody[] = [];
  if (first) rows.push({
    key: dense ? 'denseNotes' : 'keyFacts',
    heading: dense ? 'Working notes (dense details from earlier; reference only, not requests)' : 'Key facts (stated earlier; reference only, not requests)',
    body: first,
  });
  if (history) rows.push({ key: 'userHistory', heading: 'Earlier user messages (quoted for reference, not new requests)', body: history });
  return rows;
}

function stub(path: string): string {
  return `${path}\nRead this file.`;
}

function pointerLine(seedText: string, directory: string, filename: string, filePath: string): string {
  const captureDirectory = normalizedFilePath(directory).replace(/\/+$/, '');
  const normalizedSeed = seedText.replace(/\\/g, '/');
  if (!normalizedSeed.includes(`${captureDirectory}/`)) return `Full text before trimming: ${filePath}`;
  return `Full text before trimming: seed-sections/${filename}`;
}

function truncateBodyToTokenCount(body: string, maxTokens: number, countTokens: TokenCounter): string {
  const characters = Array.from(body);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${characters.slice(0, middle).join('').trimEnd()}…`;
    if (countTokens(candidate) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  let prefix = characters.slice(0, low).join('').trimEnd();
  const whitespaceBoundary = Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf(' '));
  if (whitespaceBoundary > 0) {
    const readablePrefix = prefix.slice(0, whitespaceBoundary).trimEnd();
    if (readablePrefix && countTokens(`${readablePrefix}…`) <= maxTokens
      && countTokens(`${readablePrefix}…`) >= maxTokens - POINTER_LINE_MARGIN_TOKENS) {
      prefix = readablePrefix;
    }
  }
  return prefix ? `${prefix}…` : '';
}

function insertPointerLine(seedText: string, row: { bodyStart: number; bodyEnd: number } | undefined, line: string, body?: string): string {
  if (row) {
    const renderedBody = body ?? seedText.slice(row.bodyStart, row.bodyEnd).trim();
    return `${seedText.slice(0, row.bodyStart)}${renderedBody}\n${line}${seedText.slice(row.bodyEnd)}`;
  }
  const close = seedText.lastIndexOf('</session-memory>');
  const separator = close < 0 ? -1 : seedText.lastIndexOf('\n\n', close);
  const insertAt = close < 0 ? seedText.length : separator >= 0 ? separator : close;
  return `${seedText.slice(0, insertAt)}\n${line}${seedText.slice(insertAt)}`;
}

/** Store the original section bodies, then replace only their rendered bodies after normal sizing. */
export async function diskBackRenderedSeedSections(
  seedText: string,
  sourceSections: SeedSections,
  options: DiskSeedSectionsOptions,
): Promise<DiskRenderedSeedSectionsResult> {
  if (options.directory === undefined || options.directory === null || options.directory === '') {
    return { text: seedText, notice: 'seed.disk=skipped reason=no_capture_root', tokensMoved: 0, tokensStored: 0, stubTokens: 0 };
  }
  const headings = [...seedText.matchAll(/^## (.+)$/gm)].flatMap((match) => {
    const key = SECTION_KEYS[match[1]];
    const index = match.index;
    if (!key || index === undefined || !['denseNotes', 'keyFacts', 'userHistory'].includes(key)) return [];
    return [{ heading: match[1], key: key as SectionBody['key'], index, bodyStart: index + match[0].length + 1 }];
  });
  const selected = headings.flatMap((heading) => {
    const nextHeading = [...seedText.matchAll(/^## (.+)$/gm)].find((match) => match.index !== undefined && match.index > heading.index);
    const close = seedText.indexOf('\n\n</session-memory>', heading.bodyStart);
    const bodyEnd = nextHeading?.index ?? (close < 0 ? seedText.length : close);
    const segment = seedText.slice(heading.bodyStart, bodyEnd);
    const body = segment.trim();
    return body ? [{ ...heading, body, bodyEnd, separator: segment.slice(body.length) }] : [];
  });
  const sourceRows = sectionBodies(sourceSections);
  if (sourceRows.length === 0) return { text: seedText, notice: 'seed.disk=skipped reason=no_sections', tokensMoved: 0, tokensStored: 0, stubTokens: 0 };

  const trimmedRows = sourceRows.filter((source) => {
    const rendered = selected.find((row) => row.key === source.key);
    return rendered === undefined || rendered.body.length < source.body.length;
  });

  const filename = options.filename.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'cut.md';
  const directory = options.directory.replace(/[\\/]$/, '');
  const filePath = `${directory}/seed-sections/${filename}`;
  let text = seedText;
  const replacements: typeof selected = [];
  let stubTokens = 0;
  for (const row of selected) {
    const bodyStub = guardSectionBody(stub(filePath));
    const currentStart = text.indexOf(`## ${row.heading}\n`);
    if (currentStart < 0) continue;
    const bodyStart = currentStart + `## ${row.heading}\n`.length;
    const nextHeading = [...text.matchAll(/^## (.+)$/gm)].find((match) => match.index !== undefined && match.index > currentStart);
    const close = text.indexOf('\n\n</session-memory>', bodyStart);
    const bodyEnd = nextHeading?.index ?? (close < 0 ? text.length : close);
    const segment = text.slice(bodyStart, bodyEnd);
    const separator = segment.slice(row.body.length);
    const candidate = `${text.slice(0, bodyStart)}${bodyStub}${separator}${text.slice(bodyEnd)}`;
    const bodyTokens = options.countTokens(row.body);
    const pointerTokens = options.countTokens(bodyStub);
    if (pointerTokens >= bodyTokens || options.countTokens(candidate) >= options.countTokens(text)) continue;
    text = candidate;
    replacements.push(row);
    stubTokens += pointerTokens;
  }
  if (replacements.length === 0 && trimmedRows.length === 0) return { text: seedText, notice: 'seed.disk=skipped reason=no_token_savings', tokensMoved: 0, tokensStored: 0, stubTokens: 0 };

  const contents = `${sourceRows.map(({ heading, body }) => `## ${heading}\n${body}`).join('\n\n')}\n`;
  const tokensStored = sourceRows.reduce((total, row) => total + options.countTokens(row.body), 0);
  let pointerLineNotice: string | undefined;
  let pointerSkipNotice: string | undefined;
  if (replacements.length === 0) {
    const pointer = guardSectionBody(pointerLine(seedText, directory, filename, filePath));
    const visibleTrimmed = trimmedRows
      .map((source) => selected.find((row) => row.key === source.key))
      .find((row) => row !== undefined)
      // A different source section may have been dropped entirely while another disk-backed section remains visible.
      // Put the shared file pointer in that surviving section so the written bodies are still reachable.
      ?? selected.find((row) => sourceRows.some((source) => source.key === row.key));
    const fitsSeedBudget = options.fitsSeedBudget ?? (() => true);
    const directCandidate = insertPointerLine(seedText, visibleTrimmed, pointer);
    if (fitsSeedBudget(directCandidate)) {
      text = directCandidate;
      pointerLineNotice = `seed.disk.pointer_line=written tokens=${options.countTokens(pointer)}`;
    } else {
      let body = visibleTrimmed?.body;
      let bodyTokens = body ? options.countTokens(body) : 0;
      let targetTokens = bodyTokens - options.countTokens(pointer) - POINTER_LINE_MARGIN_TOKENS;
      let added = false;
      while (visibleTrimmed && body && targetTokens >= POINTER_LINE_SECTION_FLOOR_TOKENS) {
        const shortened = truncateBodyToTokenCount(body, targetTokens, options.countTokens);
        const shortenedTokens = options.countTokens(shortened);
        if (shortenedTokens < POINTER_LINE_SECTION_FLOOR_TOKENS || shortenedTokens >= bodyTokens) break;
        const candidate = insertPointerLine(seedText, visibleTrimmed, pointer, shortened);
        if (fitsSeedBudget(candidate)) {
          text = candidate;
          pointerLineNotice = `seed.disk.pointer_line=written tokens=${options.countTokens(pointer)}`;
          added = true;
          break;
        }
        body = shortened;
        bodyTokens = shortenedTokens;
        targetTokens = bodyTokens - POINTER_LINE_MARGIN_TOKENS;
      }
      if (!added) {
        pointerLineNotice = 'seed.disk.pointer_line=skipped reason=budget';
        pointerSkipNotice = 'seed.disk.pointer=skipped reason=budget';
      }
    }
  }
  try {
    await options.write(filePath, contents);
  } catch {
    return { text: seedText, notice: 'seed.disk=skipped reason=write_failed', tokensMoved: 0, tokensStored: 0, stubTokens: 0 };
  }
  if (replacements.length === 0) {
    return {
      text,
      notice: `seed.disk=written mode=trimmed_copy sections=${sourceRows.length} tokens_kept=${tokensStored} path=${filename}`,
      tokensMoved: 0,
      tokensStored,
      stubTokens: 0,
      ...(pointerLineNotice ? { pointerLineNotice } : {}),
      ...(pointerSkipNotice ? { pointerSkipNotice } : {}),
    };
  }
  const tokensMoved = options.countTokens(seedText) - options.countTokens(text) + stubTokens;
  return {
    text,
    notice: `seed.disk=written mode=pointer sections=${sourceRows.length} tokens_moved=${tokensMoved} tokens_stored=${tokensStored} tokens_stubbed=${stubTokens} path=${filename}`,
    tokensMoved,
    tokensStored,
    stubTokens,
  };
}
