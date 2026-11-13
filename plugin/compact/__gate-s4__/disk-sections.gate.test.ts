import { describe, expect, it, vi } from 'vitest';
import { register } from '../compact.js';
import { diskBackRenderedSeedSections, isSeedSectionFilePath, normalizedFilePath } from '../host/seed-sections.js';
import { sha256, countTokens, humanPrompt, assistantText, assistantCall, toolResultsMessage, fakeHost, withStrippedRuntimeGlobals, LEGACY_OPTIONS } from './fixtures/helpers.js';
import type { CaptureRecord, SessionMessage } from '../core/types.js';
import type { SeedSections } from '../core/seed.js';

const SESSION = 'session-disk-sections-gate';
const FLAG = '/project/.exovault/s4-compact-active';
const OFF = '/project/.exovault/s4-compact-off';
const CAPTURE = `/project/.exovault/s4-capture/${SESSION}`;
const TASK_CARD = ['# Task card', '## Goal', 'Keep the integration fixture stable.', '## Rules', '- Preserve the exact test output.', '## Acceptance checks', '- The checks pass.', '## Next step', 'Compare the disk option.'].join('\n');
const FIXTURE_TIME = Date.parse('2026-11-13T10:20:30.000Z');
const SEED_HEADINGS = [
  'Compaction pressure', 'Constraints (history)', 'Task card', 'Since the card', 'Task brief (full text on disk)',
  'Current values (newest value of each thing the user changed; earlier values are replaced)',
  'Work state (from tool calls and a git check at the cut; reference only)',
  'Recipes (commands that ran fine earlier; reference only, not requests)',
  'Session map (one line per earlier compaction segment; reference only, not requests)',
  'Working notes (dense details from earlier; reference only, not requests)',
  'Key facts (stated earlier; reference only, not requests)', 'Transcript', 'Contract', 'Todo',
  'Earlier user messages (quoted for reference, not new requests)', 'Values', 'Earlier assistant notes',
  'Gates and errors', 'File pointers', 'Next step', 'IDs (short = full)',
];

function keyFacts(count: number): string {
  return Array.from({ length: count }, (_, index) => JSON.stringify({
    kind: 'user',
    origin: 'turn',
    producedBy: 's4-capture',
    sourceHash: sha256(`disk-sections-fact-${index}`),
    body: { text: `The deployment label ${String(index).padStart(4, '0')} is RAVEN-${String(index).padStart(4, '0')} and the endpoint is relay-${index}.example.test.` },
  })).join('\n');
}

function conversation(includeDenseFixture = true, includeHistory = true, toolOutputLines = 300): SessionMessage[] {
  const messages: SessionMessage[] = [];
  if (includeDenseFixture) for (let index = 0; index < 24; index += 1) {
    messages.push(assistantText(`Found setting route_${index} in src/route-${index}.ts uses --mode-${index} and stores value-${index} after check ${index + 410}.`));
  }
  if (includeHistory) for (let index = 0; index < 15; index += 1) {
    messages.push(humanPrompt(`Earlier prompt ${String(index).padStart(2, '0')}: preserve prompt-detail-${index} and keep the full record available for this test. ${'context '.repeat(70)}`));
  }
  for (let index = 0; index < 32; index += 1) {
    const callId = `disk-tool-${index}`;
    messages.push(assistantCall('Bash', { tool_use_id: callId, input: { command: `printf run-${index}` } }));
    messages.push(toolResultsMessage([{ toolUseId: callId, options: { text: `output-${index} ${'line '.repeat(toolOutputLines)}` } }]));
  }
  if (includeHistory) messages.push(humanPrompt('Continue with the current task.'));
  messages.push(assistantText('The current task is ready to continue.'));
  return messages;
}

function handlers(options: Record<string, unknown> = {}): Record<string, (...args: never[]) => Promise<unknown>> {
  const registered: Record<string, (...args: never[]) => Promise<unknown>> = {};
  register(((name: string, handler: never) => {
    registered[name] = handler;
    return { catch: (caught: unknown) => { (registered as Record<string, unknown>)[`${name}.catch`] = caught; } };
  }) as never, {
    ...LEGACY_OPTIONS,
    notices: 'all',
    recallEnabled: false,
    denseNotes: false,
    realTokenCount: false,
    taskCard: true,
    sinceCard: false,
    workState: false,
    currentValues: false,
    recipes: false,
    taskBriefs: false,
    sessionMap: false,
    toolOutputNotes: false,
    totalBudgetTokens: 13000,
    cardTotalBudgetTokens: 8000,
    ...options,
  } as never);
  return registered;
}

async function compactCut(options: Record<string, unknown> = {}, config: { cardTotal?: number; failDiskWrite?: boolean; facts?: number; denseFixture?: boolean; historyFixture?: boolean; largeToolFixture?: boolean; noCaptureRoot?: boolean } = {}) {
  const files = new Map<string, string>([
    ...(config.noCaptureRoot ? [[OFF, '1'] as const] : [[FLAG, '1'] as const]),
    [`${CAPTURE}/segment-000001.json`, keyFacts(config.facts ?? 1800)],
    [`${CAPTURE}/task-card.md`, TASK_CARD],
  ]);
  const logs: string[] = [];
  const debugLogs: string[] = [];
  const diskWrites: Array<{ path: string; text: string }> = [];
  const exists = (path: string): boolean => (path === FLAG && !config.noCaptureRoot) || files.has(path) || [...files.keys()].some((file) => file.startsWith(`${path.replace(/\/$/, '')}/`));
  const host = fakeHost({
    sessionId: async () => SESSION,
    sessionCwd: async () => '/project',
    envGet: async (name) => name === 'HOME' ? '/home/u' : undefined,
    clockNow: async () => FIXTURE_TIME,
    fsExists: async (path) => exists(path),
    fsRead: async (path) => {
      const body = files.get(path);
      if (body === undefined) throw new Error(`ENOENT: ${path}`);
      return body;
    },
    fsWrite: async (path, body) => {
      if (path.includes('/seed-sections/') && config.failDiskWrite) throw new Error('disk full');
      files.set(path, body);
      if (path.includes('/seed-sections/')) diskWrites.push({ path, text: body });
    },
    fsList: async (directory = '') => {
      const prefix = `${directory.replace(/\/$/, '')}/`;
      return [...files.entries()]
        .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
        .map(([path, body]) => ({ name: path.slice(path.lastIndexOf('/') + 1), kind: 'file', size: body.length }));
    },
    uiLog: ((line: string, target?: { to: 'debug' }) => {
      (target?.to === 'debug' ? debugLogs : logs).push(line);
    }) as never,
  });
  Object.assign(host.session, { root: async () => '/project', surfaces: async () => [{ type: 'terminal' }] });
  const messages = conversation(config.denseFixture !== false, config.historyFixture !== false, config.largeToolFixture ? 1200 : 300);
  const next = vi.fn(async () => ({ fellBack: true, messages }) as unknown);
  const result = await withStrippedRuntimeGlobals(() => handlers({ cardTotalBudgetTokens: config.cardTotal ?? 8000, ...options })['session.compact'](host as never, { trigger: 'auto', messages } as never, next as never)) as { messages?: SessionMessage[] };
  return { seed: result.messages?.[0]?.text ?? '', fellBack: next.mock.calls.length > 0, files, logs, debugLogs, diskWrites, messages, returnedMessages: result.messages ?? [] };
}

function sectionBody(seed: string, heading: string): string {
  const start = seed.indexOf(`## ${heading}\n`);
  if (start < 0) return '';
  const bodyStart = start + `## ${heading}\n`.length;
  const nextHeading = SEED_HEADINGS.map((label) => seed.indexOf(`\n\n## ${label}\n`, bodyStart)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? -1;
  const closing = seed.indexOf('\n\n</session-memory>', bodyStart);
  const end = nextHeading < 0 ? closing : closing < 0 ? nextHeading : Math.min(nextHeading, closing);
  return seed.slice(bodyStart, end < 0 ? undefined : end).trim();
}

function pointerBudgetCounter(pointerLine: string, stub: string, pointerTokens: number, stubTokens: number): (text: string) => number {
  return (text) => countTokens(text
    .replaceAll(pointerLine, 'x'.repeat(pointerTokens * 4))
    .replaceAll(stub, 'x'.repeat(stubTokens * 4)));
}

describe('disk-backed seed sections (opt-in)', () => {
  it('leaves the existing compact fixture byte-identical when the option is absent', async () => {
    const result = await compactCut({ diskSections: undefined });
    expect(result.fellBack).toBe(false);
    expect(sha256(result.seed)).toBe('9be2ca5efb5219aac459c8b906008dd55f8df79c02f870aaa31f9ace64d62da9');
    expect(result.logs.some((line) => line.startsWith('seed.disk='))).toBe(false);
  });

  it('stores the full sections and replaces them with short pointers when enabled', async () => {
    const off = await compactCut({ denseNotes: true });
    const on = await compactCut({ denseNotes: true, diskSections: true });
    const seedPath = on.diskWrites[0]?.path;
    const stored = on.diskWrites[0]?.text ?? '';
    expect(on.fellBack).toBe(false);
    expect(on.diskWrites).toHaveLength(1);
    expect(seedPath).toMatch(/\/seed-sections\/[^/]+\.md$/);
    expect(stored).toContain('## Working notes (dense details from earlier; reference only, not requests)');
    expect(stored).toContain('## Earlier user messages (quoted for reference, not new requests)');
    expect(stored).toContain('Found setting route_0 in src/route-0.ts');
    expect(stored).toContain('Earlier prompt 14: preserve prompt-detail-14');
    expect(on.seed).toContain(seedPath ?? '');
    expect(on.seed).toContain('Working notes (dense details from earlier; reference only, not requests)');
    expect(on.seed).toContain('Earlier user messages (quoted for reference, not new requests)');
    expect(on.seed).toContain('Read this file.');
    expect(on.seed).not.toContain('Earlier prompt 14: preserve prompt-detail-14');
    expect(on.seed).not.toContain('Found setting route_0 in src/route-0.ts');
    const notice = on.logs.find((line) => line.startsWith('seed.disk=written '));
    expect(notice).toMatch(/^seed\.disk=written mode=pointer sections=2 tokens_moved=\d+ tokens_stored=\d+ tokens_stubbed=\d+ path=[^/]+$/);
    const moved = Number(notice?.match(/tokens_moved=(\d+)/)?.[1]);
    const stubTokens = countTokens(sectionBody(on.seed, 'Working notes (dense details from earlier; reference only, not requests)'))
      + countTokens(sectionBody(on.seed, 'Earlier user messages (quoted for reference, not new requests)'));
    expect(Math.abs(countTokens(on.seed) - (countTokens(off.seed) - moved + stubTokens))).toBeLessThanOrEqual(10);
    for (const heading of [
      'Task card',
      'Since the card',
      'Task brief (full text on disk)',
      'Current values (newest value of each thing the user changed; earlier values are replaced)',
      'Work state (from tool calls and a git check at the cut; reference only)',
      'Recipes (commands that ran fine earlier; reference only, not requests)',
      'Session map (one line per earlier compaction segment; reference only, not requests)',
      'Constraints (history)',
      'Transcript',
      'Contract',
      'Todo',
      'Values',
      'Earlier assistant notes',
      'Gates and errors',
      'File pointers',
      'Next step',
      'IDs (short = full)',
    ]) {
      expect(sectionBody(on.seed, heading), `${heading} should be unchanged`).toBe(sectionBody(off.seed, heading));
    }
    expect(on.returnedMessages.slice(1)).toEqual(off.returnedMessages.slice(1));
  });

  it('keeps a trimmed working-notes remnant inline and stores its full source when the pointer does not save tokens', async () => {
    const heading = 'Working notes (dense details from earlier; reference only, not requests)';
    const full = 'FULL-WORKING-NOTE '.repeat(40).trim();
    const remnant = 'short remnant';
    const seed = `<session-memory source="exo-compact">\n\n## ${heading}\n${remnant}\n\n</session-memory>`;
    const sections: SeedSections = { constraints: '', denseNotes: full, contract: '', todo: '', userInstructionsVerbatim: [], values: '', selectedReasoning: '', gatesAndErrors: '', filePointers: '' };
    const write = vi.fn(async () => {});
    const result = await diskBackRenderedSeedSections(seed, sections, {
      directory: CAPTURE,
      filename: 'trimmed.md',
      countTokens,
      write,
      fitsSeedBudget: () => true,
    });
    const filePath = `${CAPTURE}/seed-sections/trimmed.md`;
    const pointerLine = `Full text before trimming: ${filePath}`;

    expect(write).toHaveBeenCalledWith(filePath, `## ${heading}\n${full}\n`);
    expect(result.text).toBe(seed.replace(`${remnant}\n\n</session-memory>`, `${remnant}\n${pointerLine}\n\n</session-memory>`));
    expect(result.notice).toBe(`seed.disk=written mode=trimmed_copy sections=1 tokens_kept=${countTokens(full)} path=trimmed.md`);
    expect(result.pointerLineNotice).toBe(`seed.disk.pointer_line=written tokens=${countTokens(pointerLine)}`);
  });

  it('uses a relative pointer when the seed names the capture directory and a full path otherwise', async () => {
    const heading = 'Working notes (dense details from earlier; reference only, not requests)';
    const full = 'FULL-WORKING-NOTE '.repeat(40).trim();
    const remnant = 'short remnant';
    const taskCard = `## Task card\n(Kept current by this session's model before the cut; file: ${CAPTURE}/task-card.md.)`;
    const seed = `<session-memory source="exo-compact">\n\n${taskCard}\n\n## ${heading}\n${remnant}\n\n</session-memory>`;
    const sections: SeedSections = { constraints: '', denseNotes: full, contract: '', todo: '', userInstructionsVerbatim: [], values: '', selectedReasoning: '', gatesAndErrors: '', filePointers: '' };
    const write = vi.fn(async () => {});
    const relative = await diskBackRenderedSeedSections(seed, sections, {
      directory: CAPTURE,
      filename: 'relative.md',
      countTokens,
      write,
      fitsSeedBudget: () => true,
    });
    const noCapturePath = await diskBackRenderedSeedSections(seed.replace(taskCard, '## Task card\nNo path is shown.'), sections, {
      directory: CAPTURE,
      filename: 'absolute.md',
      countTokens,
      write,
      fitsSeedBudget: () => true,
    });

    expect(relative.text).toContain('Full text before trimming: seed-sections/relative.md');
    expect(relative.text).not.toContain(`${CAPTURE}/seed-sections/relative.md`);
    expect(noCapturePath.text).toContain(`Full text before trimming: ${CAPTURE}/seed-sections/absolute.md`);
  });

  it('does not write a file when no source content was trimmed and the pointer does not save tokens', async () => {
    const heading = 'Working notes (dense details from earlier; reference only, not requests)';
    const body = 'short note';
    const seed = `<session-memory source="exo-compact">\n\n## ${heading}\n${body}\n\n</session-memory>`;
    const sections: SeedSections = { constraints: '', denseNotes: body, contract: '', todo: '', userInstructionsVerbatim: [], values: '', selectedReasoning: '', gatesAndErrors: '', filePointers: '' };
    const write = vi.fn(async () => {});
    const result = await diskBackRenderedSeedSections(seed, sections, { directory: CAPTURE, filename: 'plain.md', countTokens, write });

    expect(write).not.toHaveBeenCalled();
    expect(result.text).toBe(seed);
    expect(result.notice).toBe('seed.disk=skipped reason=no_token_savings');
  });

  it('writes a trimmed source when its pointer line would exceed the seed budget', async () => {
    const heading = 'Working notes (dense details from earlier; reference only, not requests)';
    const full = 'FULL-WORKING-NOTE '.repeat(40).trim();
    const remnant = 'short remnant';
    const seed = `<session-memory source="exo-compact">\n\n## ${heading}\n${remnant}\n\n</session-memory>`;
    const sections: SeedSections = { constraints: '', denseNotes: full, contract: '', todo: '', userInstructionsVerbatim: [], values: '', selectedReasoning: '', gatesAndErrors: '', filePointers: '' };
    const write = vi.fn(async () => {});
    const result = await diskBackRenderedSeedSections(seed, sections, {
      directory: CAPTURE,
      filename: 'over-budget.md',
      countTokens,
      write,
      fitsSeedBudget: () => false,
    });
    const filePath = `${CAPTURE}/seed-sections/over-budget.md`;

    expect(write).toHaveBeenCalledWith(filePath, `## ${heading}\n${full}\n`);
    expect(result.text).toBe(seed);
    expect(result.notice).toBe(`seed.disk=written mode=trimmed_copy sections=1 tokens_kept=${countTokens(full)} path=over-budget.md`);
    expect(result.pointerLineNotice).toBe('seed.disk.pointer_line=skipped reason=budget');
  });

  it('shortens the rendered section to make room for its pointer line within the seed budget', async () => {
    const heading = 'Working notes (dense details from earlier; reference only, not requests)';
    const full = 'FULL-WORKING-NOTE '.repeat(80).trim();
    const remnant = `${'RENDERED-WORKING-NOTE detail '.repeat(6).trim()} abcdefghijklmnopqrst`;
    const taskCard = `## Task card\n(file: ${CAPTURE}/task-card.md)`;
    const seed = `<session-memory source="exo-compact">\n\n${taskCard}\n\n## ${heading}\n${remnant}\n\n</session-memory>`;
    const sections: SeedSections = { constraints: '', denseNotes: full, contract: '', todo: '', userInstructionsVerbatim: [], values: '', selectedReasoning: '', gatesAndErrors: '', filePointers: '' };
    const write = vi.fn(async () => {});
    const pointerLine = 'Full text before trimming: seed-sections/tight.md';
    const stub = `${CAPTURE}/seed-sections/tight.md\nRead this file.`;
    const countTestTokens = pointerBudgetCounter(pointerLine, stub, 10, 60);
    const seedBudget = countTestTokens(seed);
    const fitCandidateTokens: number[] = [];
    const result = await diskBackRenderedSeedSections(seed, sections, {
      directory: CAPTURE,
      filename: 'tight.md',
      countTokens: countTestTokens,
      write,
      fitsSeedBudget: (text) => {
        fitCandidateTokens.push(countTestTokens(text));
        return countTestTokens(text) <= seedBudget;
      },
    });
    const body = sectionBody(result.text, heading).replace(`\n${pointerLine}`, '');

    expect(result.text, `${result.pointerLineNotice}; candidate sizes=${fitCandidateTokens.join(',')}`).toContain(pointerLine);
    expect(body.length).toBeLessThan(remnant.length);
    expect(countTestTokens(result.text)).toBeLessThanOrEqual(seedBudget);
    expect(result.pointerLineNotice).toMatch(/^seed\.disk\.pointer_line=written tokens=\d+$/);
  });

  it('skips the pointer and logs budget when fitting it would take the rendered section below its floor', async () => {
    const heading = 'Working notes (dense details from earlier; reference only, not requests)';
    const floorTokens = 12;
    const full = 'FULL-WORKING-NOTE '.repeat(80).trim();
    const remnant = `${'RENDERED-WORKING-NOTE detail '.repeat(6).trim()} abcdefghijklmnopqrst`;
    const taskCard = `## Task card\n(file: ${CAPTURE}/task-card.md)`;
    const seed = `<session-memory source="exo-compact">\n\n${taskCard}\n\n## ${heading}\n${remnant}\n\n</session-memory>`;
    const sections: SeedSections = { constraints: '', denseNotes: full, contract: '', todo: '', userInstructionsVerbatim: [], values: '', selectedReasoning: '', gatesAndErrors: '', filePointers: '' };
    const write = vi.fn(async () => {});
    const pointerLine = 'Full text before trimming: seed-sections/floor.md';
    const stub = `${CAPTURE}/seed-sections/floor.md\nRead this file.`;
    const countTestTokens = pointerBudgetCounter(pointerLine, stub, 10, 60);
    const bodySizesChecked: number[] = [];
    const result = await diskBackRenderedSeedSections(seed, sections, {
      directory: CAPTURE,
      filename: 'floor.md',
      countTokens: countTestTokens,
      write,
      fitsSeedBudget: (text) => {
        const size = countTestTokens(sectionBody(text, heading).replace(`\n${pointerLine}`, ''));
        bodySizesChecked.push(size);
        return size < floorTokens;
      },
    });

    expect(bodySizesChecked.some((size) => size < countTokens(remnant)), JSON.stringify(bodySizesChecked)).toBe(true);
    expect(Math.min(...bodySizesChecked)).toBeGreaterThanOrEqual(floorTokens);
    expect(result.text).toBe(seed);
    expect(result.pointerLineNotice).toBe('seed.disk.pointer_line=skipped reason=budget');
    expect(result.pointerSkipNotice).toBe('seed.disk.pointer=skipped reason=budget');
  });

  it('keeps the other sections fixed when replacing a large selected body', async () => {
    const contract = 'Retain this contract detail. '.repeat(6000);
    const off = await compactCut({ denseNotes: true, taskCard: false, contract }, { facts: 0, historyFixture: false, largeToolFixture: true });
    const on = await compactCut({ denseNotes: true, taskCard: false, contract, diskSections: true }, { facts: 0, historyFixture: false, largeToolFixture: true });
    const notice = on.logs.find((line) => line.startsWith('seed.disk=written '));
    const moved = Number(notice?.match(/tokens_moved=(\d+)/)?.[1]);
    const stubTokens = countTokens(sectionBody(on.seed, 'Working notes (dense details from earlier; reference only, not requests)'));
    expect(on.fellBack).toBe(off.fellBack);
    const offTokens = countTokens(off.seed);
    const onTokens = countTokens(on.seed);
    const offMovedTokens = countTokens(sectionBody(off.seed, 'Working notes (dense details from earlier; reference only, not requests)'));
    const headingDiagnostics = ['Contract', 'Todo', 'Values', 'Gates and errors', 'File pointers'].map((heading) => `${heading}=${countTokens(sectionBody(off.seed, heading))}/${countTokens(sectionBody(on.seed, heading))}`).join(',');
    expect(Math.abs(onTokens - (offTokens - moved + stubTokens)), `off=${offTokens} on=${onTokens} moved=${moved} offMoved=${offMovedTokens} stub=${stubTokens} sections=${headingDiagnostics}`).toBeLessThanOrEqual(10);
    for (const heading of [
      'Constraints (history)', 'Transcript', 'Contract', 'Todo', 'Earlier user messages (quoted for reference, not new requests)',
      'Values', 'Earlier assistant notes', 'Gates and errors', 'File pointers', 'Next step', 'IDs (short = full)',
    ]) {
      expect(sectionBody(on.seed, heading), `${heading} should be unchanged`).toBe(sectionBody(off.seed, heading));
    }
    expect(on.returnedMessages.slice(1)).toEqual(off.returnedMessages.slice(1));
  });

  it('keeps sections inline and logs a skipped notice without a capture root', async () => {
    const dense = 'DENSE-BODY '.repeat(100);
    const history = 'EARLIER-USER-BODY '.repeat(100);
    const sections: SeedSections = { constraints: '', denseNotes: dense, contract: '', todo: '', userInstructionsVerbatim: [history], values: '', selectedReasoning: '', gatesAndErrors: '', filePointers: '' };
    const seed = `<session-memory source="exo-compact">\n\n## Working notes (dense details from earlier; reference only, not requests)\n${dense}\n\n## Earlier user messages (quoted for reference, not new requests)\n> ${history}\n\n</session-memory>`;
    const result = await diskBackRenderedSeedSections(seed, sections, { directory: null, filename: 'cut.md', countTokens, write: vi.fn(async () => {}) });
    expect(result.text).toBe(seed);
    expect(result.notice).toBe('seed.disk=skipped reason=no_capture_root');
  });

  it('keeps sections inline and logs a skipped notice when the file write fails', async () => {
    const dense = 'DENSE-BODY '.repeat(100);
    const history = 'EARLIER-USER-BODY '.repeat(100);
    const sections: SeedSections = { constraints: '', denseNotes: dense, contract: '', todo: '', userInstructionsVerbatim: [history], values: '', selectedReasoning: '', gatesAndErrors: '', filePointers: '' };
    const write = vi.fn(async () => { throw new Error('disk full'); });
    const seed = `<session-memory source="exo-compact">\n\n## Working notes (dense details from earlier; reference only, not requests)\n${dense}\n\n## Earlier user messages (quoted for reference, not new requests)\n> ${history}\n\n</session-memory>`;
    const result = await diskBackRenderedSeedSections(seed, sections, { directory: CAPTURE, filename: 'cut.md', countTokens, write });
    expect(result.text).toBe(seed);
    expect(write).toHaveBeenCalledOnce();
    expect(result.notice).toBe('seed.disk=skipped reason=write_failed');
  });

  it('keeps the original messages and logs a skipped notice when there is no capture root', async () => {
    const result = await compactCut({ denseNotes: true, diskSections: true }, { noCaptureRoot: true });
    expect(result.fellBack).toBe(true);
    expect(result.diskWrites).toHaveLength(0);
    expect(result.logs).not.toContain('seed.disk=skipped reason=no_capture_root');
    expect(result.debugLogs).toContain('seed.disk=skipped reason=no_capture_root');
    expect(result.returnedMessages).toEqual(result.messages);
    expect(result.returnedMessages.some((message) => JSON.stringify(message).includes('Earlier prompt 14: preserve prompt-detail-14'))).toBe(true);
    expect(result.returnedMessages.some((message) => JSON.stringify(message).includes('Found setting route_0 in src/route-0.ts'))).toBe(true);
  });

  it('keeps both seed section bodies inline and logs a skipped notice when disk write fails', async () => {
    const result = await compactCut({ denseNotes: true, diskSections: true }, { failDiskWrite: true });
    expect(result.fellBack).toBe(false);
    expect(result.diskWrites).toHaveLength(0);
    expect(result.seed).toContain('Earlier prompt 14: preserve prompt-detail-14');
    expect(result.seed).toContain('Found setting route_0 in src/route-0.ts');
    expect(result.logs).toContain('seed.disk=skipped reason=write_failed');
  });

  it('normalizes seed section paths and does not match the sibling seed-sections-old directory', () => {
    expect(normalizedFilePath('/project/seed-sections/./nested/../cut.md')).toBe('/project/seed-sections/cut.md');
    expect(normalizedFilePath('\\project\\seed-sections\\cut.md')).toBe('/project/seed-sections/cut.md');
    expect(isSeedSectionFilePath('/project/seed-sections/../seed-sections/./cut.md', '/project/seed-sections')).toBe(true);
    expect(isSeedSectionFilePath('\\project\\seed-sections\\nested\\..\\cut.md', '/project/seed-sections')).toBe(true);
    expect(isSeedSectionFilePath('/project/seed-sections-old/cut.md', '/project/seed-sections')).toBe(false);
    expect(isSeedSectionFilePath('/project/seed-sections/../../project/seed-sections-old/cut.md', '/project/seed-sections')).toBe(false);
  });

});

describe('disk-backed seed fetch notices', () => {
  async function postRead(filePath: string, uiLog: (line: string) => void) {
    const host = fakeHost({
      uiLog,
      fsExists: async (path) => path === FLAG,
      sessionId: async () => SESSION,
      sessionCwd: async () => '/project',
    });
    Object.assign(host.session, { root: async () => '/project', surfaces: async () => [{ type: 'terminal' }] });
    const next = vi.fn(async () => ({ ok: true }) as unknown);
    const result = await handlers({ diskSections: true, taskCard: false, recallEnabled: false, notices: 'all' })['classic.PostToolUse'](
      host as never,
      { tool_name: 'Read', tool_input: { file_path: filePath } } as never,
      next as never,
    );
    return { result, next };
  }

  it('logs a fetch for a Read inside seed-sections and ignores other paths', async () => {
    const logs: string[] = [];
    const inside = await postRead(`${CAPTURE}/seed-sections/cut-1.md`, (line) => logs.push(line));
    expect(inside.result).toEqual({ ok: true });
    expect(logs).toContain('seed.disk.fetched file=cut-1.md');
    logs.length = 0;
    await postRead(`${CAPTURE}/task-card.md`, (line) => logs.push(line));
    expect(logs.some((line) => line.startsWith('seed.disk.fetched '))).toBe(false);
  });

  it('does not reject PostToolUse if the notice logger throws', async () => {
    const throwingLogger = vi.fn(() => { throw new Error('logger failed'); });
    await expect(postRead(`${CAPTURE}/seed-sections/cut-2.md`, throwingLogger)).resolves.toMatchObject({ result: { ok: true } });
  });
});
