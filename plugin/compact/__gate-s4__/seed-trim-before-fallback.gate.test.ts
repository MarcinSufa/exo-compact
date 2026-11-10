import { describe, it, expect, vi } from 'vitest';
import { register } from '../compact.js';
import { renderAdoptedFiles } from '../core/adopted.js';
import { BRIEF_MIN_TAIL_SHARE } from '../core/briefs.js';
import { applyConstraintOverflow, CONSTRAINTS_MIN_BUDGET_TOKENS, extractConstraints, renderConstraintsSection } from '../core/constraints.js';
import { SESSION_MAP_BUDGET_TOKENS, serializedTokens, tailSpillTokens } from '../core/budgets.js';
import { TASK_CARD_FILE } from '../core/task-card.js';
import { renderSessionMap } from '../core/session-map.js';
import { fakeHost, humanPrompt, assistantText, assistantCall, toolResultsMessage, withStrippedRuntimeGlobals, sha256, countTokens, LEGACY_OPTIONS } from './fixtures/helpers.js';
import type { CaptureRecord, SessionMessage } from '../core/types.js';
import type { SessionSegment } from '../core/session-map.js';

const SESSION = 'session-seed-trim-before-fallback';
const FLAG = '/project/.exovault/s4-compact-active';
const CAPTURE = `/project/.exovault/s4-capture/${SESSION}`;
const TIMELINE = `/home/u/.claude/exovault/recall/${sha256(SESSION)}/timeline.json`;
const CARD = ['# Task card', '## Goal', 'Continue the active task.', '## Rules', '- Keep the newest constraint.', '## Acceptance checks', '- Tests pass.', '## Next step', 'Continue implementation.'].join('\n');
const FULL_ID = 'bdbc6713-0123-4567-89ab-cdef01234567';

function oldConstraints(count: number, bodyChars?: number, shortIdReference = false): string {
  return Array.from({ length: count }, (_, index) => JSON.stringify({
    kind: 'user',
    origin: 'turn',
    producedBy: 's4-capture',
    sourceHash: sha256(`seed-trim-constraint-${index}`),
    body: { text: bodyChars === undefined
      ? shortIdReference && index === count - 1
        ? `Rule ${index}: You must preserve task reference bdbc6713 and keep constraint-marker-${index} aligned with the exact protocol field ${index} through every recovery cycle.`
        : `Rule ${index}: you must keep constraint-marker-${index} aligned with the exact protocol field ${index} and preserve its stable request routing behavior through every restart and recovery cycle.`
      : `You must preserve constraint-marker-${index} ${'x'.repeat(Math.max(0, bodyChars - `You must preserve constraint-marker-${index} `.length - 1))}.` },
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

function replaceSectionBody(seed: string, heading: string, body: string): string {
  const headingAt = seed.indexOf(heading);
  if (headingAt < 0) return seed;
  const headingEnd = seed.indexOf('\n', headingAt);
  if (headingEnd < 0) return seed;
  const bodyStart = headingEnd + 1;
  const nextHeading = seed.indexOf('\n\n## ', bodyStart);
  const closing = seed.indexOf('\n\n</session-memory>', bodyStart);
  const bodyEnd = nextHeading < 0 ? closing : closing < 0 ? nextHeading : Math.min(nextHeading, closing);
  return bodyEnd < 0 ? seed : `${seed.slice(0, bodyStart)}${body}${seed.slice(bodyEnd)}`;
}

interface CutOptions {
  taskCard?: boolean;
  constraintCount?: number;
  constraintBodyChars?: number;
  mapCount?: number;
  cardTotal?: number;
  totalBudget?: number;
  lastPromptTokens?: number;
  instructions?: string;
  fullId?: boolean;
  sessionMap?: boolean;
  priorContextTokens?: number;
  oldContextTokens?: number;
  omittedMessages?: number;
  tailTool?: boolean;
  keyFactCount?: number;
  denseNotes?: boolean;
  adoptedRules?: string;
  idBeforePriorContext?: boolean;
  shortIdReference?: boolean;
}

const ADOPTED_PATH = '/project/house-rules.md';
const ADOPTED_AT = '2026-10-04T12:00:00.000Z';

function keyFacts(count: number): string {
  return Array.from({ length: count }, (_, index) => JSON.stringify({
    kind: 'user',
    origin: 'turn',
    producedBy: 's4-capture',
    sourceHash: sha256(`seed-trim-key-fact-${index}`),
    body: { text: `The deployment label ${String(index).padStart(3, '0')} is RAVEN-${String(index).padStart(3, '0')} and the endpoint is relay-${index}.example.test.` },
  })).join('\n');
}

async function cut({ taskCard = true, constraintCount = 0, constraintBodyChars, mapCount = 0, cardTotal = 8000, totalBudget = 13000, lastPromptTokens = 3000, instructions, fullId = false, sessionMap = true, priorContextTokens = 0, oldContextTokens = 0, omittedMessages = 0, tailTool = false, keyFactCount = 0, denseNotes = true, adoptedRules, idBeforePriorContext = false, shortIdReference = false }: CutOptions = {}) {
  const files = new Map<string, string>([[FLAG, '1']]);
  if (taskCard) files.set(`${CAPTURE}/${TASK_CARD_FILE}`, CARD);
  if (constraintCount) files.set(`${CAPTURE}/segment-000001.json`, oldConstraints(constraintCount, constraintBodyChars, shortIdReference));
  if (keyFactCount) files.set(`${CAPTURE}/segment-000002.json`, keyFacts(keyFactCount));
  if (mapCount) files.set(TIMELINE, JSON.stringify({ segments: segments(mapCount) }));
  const adoptedEntry = adoptedRules === undefined ? undefined : { path: ADOPTED_PATH, savedPath: `${CAPTURE}/adopted/${sha256(ADOPTED_PATH).slice(0, 12)}.md`, chars: adoptedRules.length, at: ADOPTED_AT };
  if (adoptedEntry) {
    files.set(`${CAPTURE}/adopted.json`, JSON.stringify([adoptedEntry]));
    files.set(`${CAPTURE}/adopted/${sha256(ADOPTED_PATH).slice(0, 12)}.md`, adoptedRules);
  }
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
    denseNotes,
    recallEnabled: true,
    realTokenCount: false,
    workState: false,
    currentValues: false,
    recipes: false,
    taskBriefs: false,
    sinceCard: false,
    sessionMap,
    cardTotalBudgetTokens: cardTotal,
    totalBudgetTokens: totalBudget,
    ...({ adoptedFiles: true, toolOutputNotes: false } as Record<string, unknown>),
  } as never);
  const messages: SessionMessage[] = [];
  for (let index = 0; index < omittedMessages; index += 1) messages.push(assistantText('Earlier context.'));
  if (oldContextTokens) {
    messages.push(assistantText('o'.repeat(oldContextTokens * 4)));
    messages.push(humanPrompt('Prior context checkpoint.'));
  }
  const addFullId = () => {
    messages.push(assistantCall('Bash', { tool_use_id: 'hidden-id-call', input: { command: 'true' } }));
    messages.push(toolResultsMessage([{ toolUseId: 'hidden-id-call', options: { text: `The stored artifact id is ${FULL_ID}.` } }]));
  };
  if (fullId && idBeforePriorContext) addFullId();
  if (priorContextTokens) messages.push(assistantText('p'.repeat(priorContextTokens * 4)));
  if (fullId && !idBeforePriorContext) addFullId();
  if (tailTool) {
    messages.push(toolResultsMessage([{ toolUseId: 'separator-call', options: { text: 'Unpaired result separates the prior context.' } }]));
    messages.push(assistantCall('Bash', { tool_use_id: 'tail-call', input: { command: 'true' } }));
    messages.push(toolResultsMessage([{ toolUseId: 'tail-call', options: { text: 'x'.repeat(lastPromptTokens * 4) } }]));
  } else messages.push(humanPrompt('x'.repeat(lastPromptTokens * 4)));
  const next = vi.fn(async () => ({ fellBack: true }) as unknown);
  const event = { trigger: 'auto', messages, ...(instructions === undefined ? {} : { instructions }) };
  const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next))) as { messages?: SessionMessage[] };
  return { lines, next, seed: result.messages?.[0]?.text ?? '', messages, tailMessages: result.messages?.slice(1) ?? [], adoptedEntry };
}

describe('4.11.0 (S5z): a card cut trims the map and oldest constraints before falling back', () => {
  it('does not trim the map, constraints or IDs without a task card', async () => {
    const { lines } = await cut({
      taskCard: false,
      constraintCount: 80,
      mapCount: 80,
      totalBudget: 6000,
      lastPromptTokens: 3000,
      priorContextTokens: 12000,
      instructions: `Keep these event instructions verbatim. ${'x '.repeat(5000)}`,
    });
    const log = lines.join('\n');
    expect(log).toContain('seed.task_card=0');
    expect(log).not.toMatch(/seed\.(?:session_map_shrunk|session_map_dropped|constraints_shrunk|ids_dropped_for_budget)=/);
  });

  it('falls back when IDs push an otherwise fitting no-card seed over budget', async () => {
    const calibration = {
      taskCard: false,
      lastPromptTokens: 3000,
      priorContextTokens: 10000,
      constraintCount: 80,
      keyFactCount: 250,
      denseNotes: false,
      sessionMap: false,
      idBeforePriorContext: true,
    };
    let low = 6400;
    let high = 6800;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = await cut({ ...calibration, totalBudget: middle, shortIdReference: true });
      if (candidate.next.mock.calls.length) low = middle + 1;
      else high = middle;
    }
    const totalBudget = low;
    const baseline = await cut({ ...calibration, totalBudget, shortIdReference: true });
    const baselineTailTokens = serializedTokens(baseline.tailMessages, countTokens);
    const remainingBudget = totalBudget - countTokens(baseline.seed) - baselineTailTokens;
    const addedIdSectionTokens = countTokens(`## IDs (short = full)\nbdbc6713 = ${FULL_ID}`);
    expect(baseline.next).not.toHaveBeenCalled();
    expect(baseline.seed).toContain('bdbc6713');
    expect(remainingBudget).toBeGreaterThanOrEqual(0);
    expect(remainingBudget).toBeLessThan(addedIdSectionTokens);

    const { lines, next } = await cut({ ...calibration, totalBudget, shortIdReference: true, fullId: true });
    const log = lines.join('\n');
    expect(log).toContain('compact.fallback=budget');
    expect(log).toContain('seed.ids_expanded=1');
    expect(log).not.toContain('seed.ids_dropped_for_budget=1');
    expect(next).toHaveBeenCalledOnce();
  });

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

  it('partially shrinks the map and keeps its newest segment line', async () => {
    const { lines, seed } = await cut({ constraintCount: 80, mapCount: 80, cardTotal: 3500, lastPromptTokens: 937, priorContextTokens: 8000 });
    const log = lines.join('\n');
    expect(log).toMatch(/seed\.session_map_shrunk=\d+/);
    expect(log).not.toContain('seed.session_map_dropped=1');
    const map = seed.match(/## Session map[^\n]*\n([\s\S]*?)(?=\n\n## |\n\n<\/session-memory>)/)?.[1];
    expect(map).toBeDefined();
    expect(map).toContain('S79:');
  });

  it('shrinks the map before the tail when both reductions are needed', async () => {
    const { lines, next } = await cut({
      constraintCount: 80,
      mapCount: 80,
      cardTotal: 8000,
      lastPromptTokens: 1500,
      priorContextTokens: 120,
      oldContextTokens: 15000,
      omittedMessages: 200,
      instructions: `Keep instructions. ${'x '.repeat(8500)}`,
    });
    const log = lines.join('\n');
    const mapAt = log.indexOf('seed.session_map_shrunk=');
    const tailAt = log.indexOf('seed.tail_shrunk_for_seed=');
    expect(mapAt).toBeGreaterThanOrEqual(0);
    expect(tailAt).toBeGreaterThan(mapAt);
    expect(log).not.toContain('seed.constraints_shrunk=');
    expect(log).not.toContain('compact.fallback=');
    expect(next).not.toHaveBeenCalled();
  });

  it('shrinks the tail before constraints when the tail can absorb the overrun', async () => {
    const { lines, next } = await cut({
      constraintCount: 80,
      cardTotal: 8000,
      lastPromptTokens: 500,
      priorContextTokens: 2000,
      oldContextTokens: 15000,
      omittedMessages: 200,
      instructions: `Keep instructions. ${'x '.repeat(9000)}`,
    });
    const log = lines.join('\n');
    expect(log).toMatch(/seed\.tail_shrunk_for_seed=/);
    expect(log).not.toContain('seed.constraints_shrunk=');
    expect(log).not.toContain('compact.fallback=');
    expect(next).not.toHaveBeenCalled();
  });

  it('shrinks constraints when the tail cannot absorb the overrun above its floor', async () => {
    const constraintCount = 80;
    const { lines, next, seed, tailMessages } = await cut({
      constraintCount,
      cardTotal: 2500,
      lastPromptTokens: 937,
      sessionMap: false,
      oldContextTokens: 8000,
      instructions: `Keep instructions. ${'x '.repeat(1200)}`,
    });
    const log = lines.join('\n');
    const constraintsBudget = Number(log.match(/seed\.constraints_shrunk=(\d+)/)?.[1]);
    const records = oldConstraints(constraintCount).split('\n').map((line) => JSON.parse(line)) as CaptureRecord[];
    const constraints = extractConstraints(records, sha256);
    const fullConstraints = renderConstraintsSection(applyConstraintOverflow(constraints, countTokens, sha256).rendered);
    const beforeConstraintTrim = replaceSectionBody(seed, '## Constraints (history)', fullConstraints);
    const keptTailTokens = serializedTokens(tailMessages, countTokens);
    const totalBudget = Number(log.match(/seed\.budget_total=(\d+)/)?.[1]);
    const seedBudget = Number(log.match(/seed\.budget_split seed=(\d+)/)?.[1]);
    const tailBudget = Number(log.match(/seed\.budget_split seed=\d+ tail=(\d+)/)?.[1]);
    const effectiveTailBudget = Math.max(tailBudget, keptTailTokens);
    const effectiveTotalBudget = totalBudget + effectiveTailBudget - tailBudget;
    const overAtConstraints = Math.max(
      countTokens(beforeConstraintTrim) - seedBudget - tailSpillTokens(keptTailTokens, effectiveTailBudget),
      countTokens(beforeConstraintTrim) + keptTailTokens - effectiveTotalBudget,
      0,
    );
    const currentConstraintsTokens = countTokens(fullConstraints);
    const expectedConstraintsBudget = Math.max(CONSTRAINTS_MIN_BUDGET_TOKENS, currentConstraintsTokens - overAtConstraints - 50);
    const tailFloor = Math.round(tailBudget * BRIEF_MIN_TAIL_SHARE);
    expect(log).not.toContain('seed.session_map_shrunk=');
    expect(log).not.toContain('seed.tail_shrunk_for_seed=');
    expect(seed).not.toContain('## Session map');
    expect(keptTailTokens - overAtConstraints).toBeLessThan(tailFloor);
    expect(log).toMatch(/seed\.constraints_shrunk=\d+ seed\.constraints_omitted=\d+/);
    expect(constraintsBudget).toBe(expectedConstraintsBudget);
    expect(log).not.toContain('compact.fallback=');
    expect(next).not.toHaveBeenCalled();
  });

  it('sizes the map render budget from its current size and the observed seed overrun', async () => {
    const mapCount = 80;
    const { lines, seed, tailMessages, next } = await cut({
      mapCount,
      keyFactCount: 250,
      denseNotes: false,
      cardTotal: 3500,
      lastPromptTokens: 1280,
      priorContextTokens: 5000,
    });
    const log = lines.join('\n');
    const mapSize = Number(log.match(/seed\.session_map_size=(\d+)/)?.[1]);
    const mapBudget = Number(log.match(/seed\.session_map_shrunk=(\d+)/)?.[1]);
    const initialMap = renderSessionMap(segments(mapCount), countTokens, SESSION_MAP_BUDGET_TOKENS);
    const beforeMapTrim = replaceSectionBody(seed, '## Session map', initialMap);
    const totalBudget = Number(log.match(/seed\.budget_total=(\d+)/)?.[1]);
    const keptTailTokens = serializedTokens(tailMessages, countTokens);
    const overAtMap = Math.max(0, countTokens(beforeMapTrim) + keptTailTokens - totalBudget);
    expect(next).not.toHaveBeenCalled();
    expect(mapSize).toBe(countTokens(initialMap));
    expect(mapBudget).toBe(Math.max(0, mapSize - overAtMap - 50));
    expect(mapBudget).toBeGreaterThan(0);
    expect(mapBudget).toBeLessThan(mapSize);
  });

  it('keeps adopted rules at their earlier shrink budget when constraints shrink afterward', async () => {
    const rules = ['# Session rules', '1. Keep each change within its stated acceptance checks.', '2. Report the result in one concise paragraph.'].join('\n');
    const { lines, seed, next, adoptedEntry } = await cut({
      constraintCount: 80,
      adoptedRules: rules,
      cardTotal: 3500,
      lastPromptTokens: 937,
      sessionMap: false,
      oldContextTokens: 10000,
      instructions: `Keep these event instructions verbatim. ${'x '.repeat(1800)}`,
    });
    const log = lines.join('\n');
    const adoptedBudget = Number([...log.matchAll(/seed\.adopted_shrunk=(\d+)/g)].at(-1)?.[1]);
    const constraintsBudget = Number(log.match(/seed\.constraints_shrunk=(\d+)/)?.[1]);
    const constraintsStart = seed.indexOf('## Constraints (history)\n');
    const constraintsBody = constraintsStart < 0 ? '' : seed.slice(constraintsStart + '## Constraints (history)\n'.length, seed.indexOf('\n\n## ', constraintsStart + 1) < 0 ? undefined : seed.indexOf('\n\n## ', constraintsStart + 1));
    const adoptedFooter = 'Later user messages override these files where they conflict.';
    const footerEnd = constraintsBody.indexOf(adoptedFooter);
    const adoptedBlock = footerEnd < 0 ? undefined : constraintsBody.slice(0, footerEnd + adoptedFooter.length);
    const expectedAdoptedBlock = renderAdoptedFiles([{ entry: adoptedEntry!, text: rules }], adoptedBudget, countTokens);
    expect(log).toMatch(/seed\.adopted_shrunk=/);
    expect(log).toMatch(/seed\.constraints_shrunk=/);
    expect(constraintsBudget).toBeGreaterThanOrEqual(CONSTRAINTS_MIN_BUDGET_TOKENS);
    expect(adoptedBlock).toBeDefined();
    expect(adoptedBlock).toBe(expectedAdoptedBlock);
    expect(next).not.toHaveBeenCalled();
  });

  it('skips a constraints shrink notice when the computed budget equals the current section size', async () => {
    const bodyChars = Array.from({ length: 601 }, (_, size) => size).find((size) => {
      const records = oldConstraints(4, size).split('\n').map((line) => JSON.parse(line)) as CaptureRecord[];
      const constraints = extractConstraints(records, sha256);
      return countTokens(renderConstraintsSection(applyConstraintOverflow(constraints, countTokens, sha256).rendered)) === CONSTRAINTS_MIN_BUDGET_TOKENS;
    });
    expect(bodyChars).toBeDefined();
    const { lines, next } = await cut({
      constraintCount: 4,
      constraintBodyChars: bodyChars ?? 0,
      cardTotal: 2500,
      lastPromptTokens: 937,
      sessionMap: false,
      instructions: `Keep these event instructions verbatim. ${'x '.repeat(1800)}`,
    });
    const log = lines.join('\n');
    expect(log).toContain('seed.budget_over');
    expect(log).not.toMatch(/seed\.constraints_shrunk=/);
    expect(next).toHaveBeenCalledOnce();
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
