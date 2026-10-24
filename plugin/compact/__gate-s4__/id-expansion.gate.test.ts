import { describe, it, expect, vi } from 'vitest';
import { register } from '../compact.js';
import { collectFullIds, expandShortIds, ID_EXPANSION_MAX_ENTRIES } from '../core/id-expansion.js';
import { renderSeed, type SeedSections } from '../core/seed.js';
import { fakeHost, humanPrompt, assistantText, assistantCall, toolResultsMessage, withStrippedRuntimeGlobals, countTokens, LEGACY_OPTIONS } from './fixtures/helpers.js';
import type { CompactEvent, SessionMessage } from '../core/types.js';
import type { FakeHost } from './fixtures/helpers.js';

const TASK = 'bdbc6713-3d93-428b-b8e3-dd92b32ed182';
const SHA = '94d7f1b0c3a1e2d4f5a6b7c8d9e0f1a2b3c4d5e6';

describe('S4g id expansion', () => {
  it('collects full UUIDs and 40-hex shas, not fragments of longer hex runs', () => {
    const ids = collectFullIds([`task ${TASK} and commit ${SHA}`, `hash ${'a'.repeat(64)}`]);
    expect([...ids].sort()).toEqual([SHA, TASK].sort());
  });

  it('maps a short id to its unique full id', () => {
    expect(expandShortIds('task `bdbc6713` and commit 94d7f1b0', collectFullIds([TASK, SHA]))).toEqual([`bdbc6713 = ${TASK}`, `94d7f1b0 = ${SHA}`]);
  });

  it('skips short ids whose full form is already visible, ambiguous prefixes, plain numbers and hex-only words', () => {
    const other = 'bdbc6713-0000-4000-8000-000000000000';
    expect(expandShortIds(`task bdbc6713 (${TASK})`, collectFullIds([TASK]))).toEqual([]);
    expect(expandShortIds('task bdbc6713', collectFullIds([TASK, other]))).toEqual([]);
    expect(expandShortIds('ran 12345678 tests on the facade', collectFullIds(['12345678-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'facade00-aaaa-4aaa-8aaa-aaaaaaaaaaaa']))).toEqual([]);
  });

  it('does not treat the head of a full id as a short id', () => {
    expect(expandShortIds(`see ${TASK}`, collectFullIds([TASK]))).toEqual([]);
  });

  it('caps the number of entries', () => {
    const fulls = Array.from({ length: 30 }, (_, i) => `${(0x1a000000 + i).toString(16)}-3d93-428b-b8e3-dd92b32ed182`);
    const text = fulls.map((full) => full.slice(0, 8)).join(' ');
    expect(expandShortIds(text, collectFullIds(fulls))).toHaveLength(ID_EXPANSION_MAX_ENTRIES);
  });

  it('renders an IDs section only when there is something to expand', () => {
    const base: SeedSections = { constraints: '', contract: '', todo: '', userInstructionsVerbatim: [], values: '', selectedReasoning: '', gatesAndErrors: '', filePointers: '' };
    expect(renderSeed(base, 0, 6000, countTokens).message.text).not.toContain('## IDs');
    const text = renderSeed({ ...base, ids: `bdbc6713 = ${TASK}` }, 0, 6000, countTokens).message.text;
    expect(text).toContain(`## IDs (short = full)\nbdbc6713 = ${TASK}`);
  });
});

describe('S4g id expansion, end to end through session.compact', () => {
  type Handler = ($: FakeHost, event: unknown, next: (event: unknown) => Promise<unknown>) => Promise<unknown>;

  function conversation(): SessionMessage[] {
    const old: SessionMessage[] = [];
    const create = assistantCall('mcp__exo-vault__create_task', { input: { title: 'x' } });
    old.push(create, toolResultsMessage([{ toolUseId: create.toolUses[0].tool_use_id, options: { text: `{"id":"${TASK}"}` } }]));
    for (let i = 0; i < 40; i += 1) {
      old.push(assistantCall('Read', { input: { file: `f${i}.ts` } }));
      old.push(toolResultsMessage([{ toolUseId: (old.at(-1) as SessionMessage).toolUses[0].tool_use_id, options: { text: 'line '.repeat(400) } }]));
    }
    return [...old, humanPrompt('what is the status now'), assistantText('Task `bdbc6713` is in_progress.')];
  }

  it('the seed maps a short task id quoted in the kept tail to the full UUID that was only in a cut tool result', async () => {
    const handlers: Record<string, Handler> = {};
    register(((name: string, handler: Handler) => { handlers[name] = handler; return { catch: (caught: unknown) => { (handlers as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS } as never);
    const fsRead = vi.fn(async (path: string) => {
      if (path === '.exovault/s4-compact-active') return '1';
      throw new Error(`ENOENT: ${path}`);
    });
    const $ = fakeHost({ fsList: vi.fn(async () => []), fsRead });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages: conversation() };
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next))) as { messages?: SessionMessage[] };
    expect(next).not.toHaveBeenCalled();
    expect(result.messages?.[0].text).toContain(`bdbc6713 = ${TASK}`);
  });
});
