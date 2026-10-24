import { describe, it, expect, vi } from 'vitest';
import { register } from '../compact.js';
import { bashFileReads, collectFilePointers, FILE_POINTERS_MAX_ENTRIES } from '../core/file-pointers.js';
import { fakeHost, humanPrompt, assistantText, assistantCall, toolResultsMessage, withStrippedRuntimeGlobals, LEGACY_OPTIONS } from './fixtures/helpers.js';
import type { CompactEvent, SessionMessage } from '../core/types.js';
import type { FakeHost } from './fixtures/helpers.js';

const call = (tool: string, input: Record<string, unknown>): SessionMessage => assistantCall(tool, { input });

describe('S4h file pointers', () => {
  it('reads cat/sed -n/head paths from Bash, resolved against a leading cd', () => {
    expect(bashFileReads("cd proxy && sed -n 60,260p src/connect.ts; head -n 30 README.md; git log -3")).toEqual([
      ['proxy/src/connect.ts', '60-260'],
      ['proxy/README.md', '1-30'],
    ]);
    expect(bashFileReads('pnpm exec vitest run src/a.test.ts 2>&1 | tail -8')).toEqual([]);
  });

  it('lists files most recent first, with Read ranges, sed ranges and edits merged per file', () => {
    const lines = collectFilePointers([
      call('Read', { file_path: '/r/a.ts' }),
      call('Bash', { command: "sed -n '10,20p' /r/b.ts" }),
      call('Read', { file_path: '/r/a.ts', offset: 100, limit: 50 }),
      call('Edit', { file_path: '/r/a.ts', old_string: 'x', new_string: 'y' }),
    ]);
    expect(lines).toEqual(['/r/a.ts (edited; read whole, 100-149)', '/r/b.ts (read 10-20)']);
  });

  it('caps the entries and never carries content', () => {
    const messages = Array.from({ length: 30 }, (_, i) => call('Read', { file_path: `/r/f${i}.ts` }));
    const lines = collectFilePointers(messages);
    expect(lines).toHaveLength(FILE_POINTERS_MAX_ENTRIES);
    expect(lines[0]).toBe('/r/f29.ts (read whole)');
  });

  it('reaches the seed through session.compact', async () => {
    const handlers: Record<string, ($: FakeHost, event: unknown, next: (event: unknown) => Promise<unknown>) => Promise<unknown>> = {};
    register(((name: string, handler: (typeof handlers)[string]) => { handlers[name] = handler; return { catch: (caught: unknown) => { (handlers as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS } as never);
    const messages: SessionMessage[] = [];
    for (let i = 0; i < 40; i += 1) {
      const read = call('Read', { file_path: `/repo/src/f${i}.ts` });
      messages.push(read, toolResultsMessage([{ toolUseId: read.toolUses[0].tool_use_id, options: { text: 'line '.repeat(400) } }]));
    }
    messages.push(humanPrompt('status?'), assistantText('done'));
    const fsRead = vi.fn(async (path: string) => {
      if (path === '.exovault/s4-compact-active') return '1';
      throw new Error(`ENOENT: ${path}`);
    });
    const $ = fakeHost({ fsList: vi.fn(async () => []), fsRead });
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const event: CompactEvent = { trigger: 'auto', messages };
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, event, next))) as { messages?: SessionMessage[] };
    expect(next).not.toHaveBeenCalled();
    expect(result.messages?.[0].text).toContain('## File pointers\n/repo/src/f39.ts (read whole)');
  });
});
