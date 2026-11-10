import { describe, it, expect, vi } from 'vitest';
import { register } from '../compact.js';
import { applyConstraintOverflow, CONSTRAINTS_MIN_BUDGET_TOKENS, extractConstraints, renderConstraintsSection } from '../core/constraints.js';
import { TASK_CARD_FILE } from '../core/task-card.js';
import { fakeHost, humanPrompt, assistantText, assistantCall, toolResultsMessage, withStrippedRuntimeGlobals, sha256, countTokens, LEGACY_OPTIONS } from './fixtures/helpers.js';
import type { CaptureRecord, SessionMessage } from '../core/types.js';
import type { SessionSegment } from '../core/session-map.js';

const SESSION = 'session-seed-trim-before-fallback';
const FLAG = '/project/.exovault/s4-compact-active';
const CAPTURE = `/project/.exovault/s4-capture/${SESSION}`;
const TIMELINE = `/home/u/.claude/exovault/recall/${sha256(SESSION)}/timeline.json`;
const CARD = ['# Task card', '## Goal', 'Continue the active task.', '## Rules', '- Keep the newest constraint.', '## Acceptance checks', '- Tests pass.', '## Next step', 'Continue implementation.'].join('\n');
const FULL_ID = 'bdbc6713-0123-4567-89ab-cdef01234567';

function oldConstraints(count: number): string {
  return Array.from({ length: count }, (_, index) => JSON.stringify({
    kind: 'user',
    origin: 'turn',
    producedBy: 's4-capture',
    sourceHash: sha256(`seed-trim-constraint-${index}`),
    body: { text: `Rule ${index}: you must keep constraint-marker-${index} aligned with the exact protocol field ${index} and preserve its stable request routing behavior through every restart and recovery cycle.` },
  })).join('\n');
}

function segments(count: number): SessionSegment[] {
  return Array.from({ length: count }, (_, index) => ({
    segment: index,
    from: `2026-10-${String((index % 28) + 1).padStart(2, '0')}T08:00:00Z`,
    to: '',
    asks: [`Review session-map entry ${index} and preserve its newest task and decisions for the next cut.`],
    files: [`src/session-map-${index}.ts`, `src/compact-${index}.ts`, `tests/session-map-${index}.test.ts`],
    commits: [`4.${index}.0: preserve segment ${index}`],
  }));
}

interface CutOptions {
  constraintCount?: number;
  mapCount?: number;
  cardTotal?: number;
  lastPromptTokens?: number;
  instructions?: string;
  fullId?: boolean;
  sessionMap?: boolean;
  priorContextTokens?: number;
  tailTool?: boolean;
}

async function cut({ constraintCount = 0, mapCount = 0, cardTotal = 8000, lastPromptTokens = 3000, instructions, fullId = false, sessionMap = true, priorContextTokens = 0, tailTool = false }: CutOptions = {}) {
  const files = new Map<string, string>([[FLAG, '1'], [`${CAPTURE}/${TASK_CARD_FILE}`, CARD]]);
  if (constraintCount) files.set(`${CAPTURE}/segment-000001.json`, oldConstraints(constraintCount));
  if (mapCount) files.set(TIMELINE, JSON.stringify({ segments: segments(mapCount) }));
  const fileExists = (path: string): boolean => files.has(path) || [...files.keys()].some((file) => file.startsWith(`${path.replace(/\/$/, '')}/`));
  const lines: string[] = [];
  const $ = fakeHost({
    sessionId: async () => SESSION,
    sessionCwd: async () => '/project',
    envGet: async (name) => name === 'HOME' ? '/home/u' : undefined,
    fsExists: async (path) => fileExists(path),
    fsRead: async (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    },
    fsWrite: async (path, text) => { files.set(path, text); },
    fsList: async (dir = '') => [...files.entries()]
      .filter(([path]) => path.startsWith(`${dir.replace(/\/$/, '')}/`) && !path.slice(dir.length + 1).includes('/'))
      .map(([path, text]) => ({ name: path.slice(path.lastIndexOf('/') + 1), kind: 'file', size: text.length })),
    uiLog: (line: string) => lines.push(line),
  });
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  register(((name: string, handler: never) => { handlers[name] = handler; return { catch: (caught: unknown) => { (handlers as Record<string, unknown>)[`${name}.catch`] = caught; } }; }) as never, {
    ...LEGACY_OPTIONS,
    denseNotes: true,
    recallEnabled: true,
    realTokenCount: false,
    workState: false,
    currentValues: false,
    recipes: false,
    taskBriefs: false,
    sinceCard: false,
    sessionMap,
    cardTotalBudgetTokens: cardTotal,
    ...({ adoptedFiles: true, toolOutputNotes: false } as Record<string, unknown>),
  } as never);
  const messages: SessionMessage[] = [];
  if (priorContextTokens) messages.push(assistantText('p'.repeat(priorContextTokens * 4)));
  if (fullId) {
    messages.push(assistantCall('Bash', { tool_use_id: 'hidden-id-call', input: { command: 'true' } }));
    messages.push(toolResultsMessage([{ toolUseId: 'hidden-id-call', options: { text: `The stored artifact id is ${FULL_ID}.` } }]));
  }
  if (tailTool) {
    messages.push(toolResultsMessage([{ toolUseId: 'separator-call', options: { text: 'Unpaired result separates the prior context.' } }]));
    messages.push(assistantCall('Bash', { tool_use_id: 'tail-call', input: { command: 'true' } }));
    messages.push(toolResultsMessage([{ toolUseId: 'tail-call', options: { text: 'x'.repeat(lastPromptTokens * 4) } }]));
  } else messages.push(humanPrompt('x'.repeat(lastPromptTokens * 4)));
  const next = vi.fn(async () => ({ fellBack: true }) as unknown);
  const event = { trigger: 'auto', messages, ...(instructions === undefined ? {} : { instructions }) };
  const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next))) as { messages?: SessionMessage[] };
  return { lines, next, seed: result.messages?.[0]?.text ?? '', messages };
}

describe('4.11.0 (S5z): a card cut trims the map and oldest constraints before falling back', () => {
  it('sizes an under-cap constraints trim from the section size', async () => {
    const constraintCount = 36;
    const records = oldConstraints(constraintCount).split('\n').map((line) => JSON.parse(line)) as CaptureRecord[];
    const constraints = extractConstraints(records, sha256);
    const currentSectionTokens = countTokens(renderConstraintsSection(applyConstraintOverflow(constraints, countTokens, sha256).rendered));
    // This instruction payload leaves the constraints-stage overrun above 2000 minus the current section size.
    const { lines, next, seed } = await cut({
      constraintCount,
      cardTotal: 2500,
      lastPromptTokens: 937,
      sessionMap: false,
      priorContextTokens: 2500,
      instructions: `Keep this event instruction verbatim. ${'x '.repeat(600)}`,
    });
    const log = lines.join('\n');
    expect(currentSectionTokens).toBeGreaterThan(1500);
    expect(currentSectionTokens).toBeLessThan(1800);
    expect(log).not.toContain('seed.constraints_overflow=');
    expect(log).not.toContain('compact.fallback=budget');
    expect(next).not.toHaveBeenCalled();
    expect(log).toMatch(/seed\.constraints_shrunk=\d+ seed\.constraints_omitted=\d+/);
    expect(seed).toContain('constraint-marker-35');
    expect(seed).toMatch(/\[\d+ older constraints omitted; full text in the transcript\]/);
  });

  it('keeps a large map and constraint history within the seed budget after the earlier shrink floors', async () => {
    const { lines, next, seed } = await cut({ constraintCount: 80, mapCount: 80, cardTotal: 2500, lastPromptTokens: 937, priorContextTokens: 2500 });
    const log = lines.join('\n');
    expect(log).not.toContain('compact.fallback=budget');
    expect(next).not.toHaveBeenCalled();
    expect(countTokens(seed)).toBeLessThanOrEqual(Number(log.match(/seed\.budget_split seed=(\d+)/)?.[1]));
    expect(log).toMatch(/seed\.session_map_shrunk=\d+/);
    expect(log).toMatch(/seed\.constraints_shrunk=\d+ seed\.constraints_omitted=\d+/);
    expect(seed).toContain('constraint-marker-79');
    expect(seed).toMatch(/\[\d+ older constraints omitted; full text in the transcript\]/);
    const map = seed.match(/## Session map[^\n]*\n([\s\S]*?)(?=\n\n## |\n\n<\/session-memory>)/)?.[1];
    if (map) expect(map).toMatch(/S79:|S0-S\d+: \d+ older segments, not listed; search them with the segment filter\./);
  });

  it('does not emit trim notices or change the map and constraints when the card seed fits', async () => {
    const { lines, next, seed } = await cut({ constraintCount: 2, mapCount: 3, cardTotal: 2500, lastPromptTokens: 937, priorContextTokens: 1500 });
    const log = lines.join('\n');
    expect(next).not.toHaveBeenCalled();
    expect(seed).toContain('## Session map');
    expect(seed).toContain('constraint-marker-1');
    expect(log).not.toMatch(/seed\.(?:session_map_shrunk|session_map_dropped|constraints_shrunk|ids_dropped_for_budget)=/);
  });

  it('keeps the constraint budget at its floor and falls back when a smaller budget would fit', async () => {
    const { lines, next } = await cut({
      constraintCount: 80,
      cardTotal: 2500,
      lastPromptTokens: 937,
      sessionMap: false,
      instructions: `Keep these event instructions verbatim. ${'x '.repeat(1800)}`,
    });
    const log = lines.join('\n');
    const budget = Number(log.match(/seed\.constraints_shrunk=(\d+)/)?.[1]);
    const over = log.match(/seed\.budget_over seed=(\d+)\/(\d+)/);
    const records = oldConstraints(80).split('\n').map((line) => JSON.parse(line)) as CaptureRecord[];
    const constraints = extractConstraints(records, sha256);
    const atFloor = applyConstraintOverflow(constraints, countTokens, sha256, CONSTRAINTS_MIN_BUDGET_TOKENS);
    const belowFloor = applyConstraintOverflow(constraints, countTokens, sha256, 0);
    const hypotheticalSavings = countTokens(renderConstraintsSection(atFloor.rendered)) - countTokens(renderConstraintsSection(belowFloor.rendered));
    expect(budget).toBeGreaterThanOrEqual(CONSTRAINTS_MIN_BUDGET_TOKENS);
    expect(budget).toBe(CONSTRAINTS_MIN_BUDGET_TOKENS);
    expect(over).not.toBeNull();
    expect(hypotheticalSavings).toBeGreaterThan(Number(over?.[1]) - Number(over?.[2]) + 50);
    expect(log).toMatch(/seed\.budget_over /);
    expect(log).toContain('compact.fallback=budget');
    expect(next).toHaveBeenCalledOnce();
  });

  it('drops IDs when they alone push a fitting seed over its budget', async () => {
    const seedBudget = 1562;
    const calibration = { cardTotal: 2500, lastPromptTokens: 937, sessionMap: false, priorContextTokens: 2500, tailTool: true };
    const instructionsAt = (repeats: number) => `Continue task bdbc6713. ${'x '.repeat(repeats)}`;
    const empty = await cut({ ...calibration, instructions: instructionsAt(0), fullId: false });
    let repeats = Math.max(0, (seedBudget - countTokens(empty.seed) - 1) * 2);
    let baseline = await cut({ ...calibration, instructions: instructionsAt(repeats), fullId: false });
    for (let attempt = 0; attempt < 2 && countTokens(baseline.seed) < seedBudget - 2; attempt += 1) {
      repeats += Math.max(1, (seedBudget - countTokens(baseline.seed) - 1) * 2);
      baseline = await cut({ ...calibration, instructions: instructionsAt(repeats), fullId: false });
    }
    expect(baseline.next).not.toHaveBeenCalled();
    expect(countTokens(baseline.seed)).toBeLessThanOrEqual(seedBudget);
    expect(countTokens(baseline.seed)).toBeGreaterThan(seedBudget - 3);

    const withId = await cut({ ...calibration, instructions: instructionsAt(repeats), fullId: true });
    expect(withId.lines.join('\n')).not.toContain('compact.fallback=budget');
    expect(withId.next).not.toHaveBeenCalled();
    expect(withId.lines.join('\n')).toContain('seed.ids_dropped_for_budget=1');
    expect(withId.seed).not.toContain('## IDs (short = full)');
  });
});
