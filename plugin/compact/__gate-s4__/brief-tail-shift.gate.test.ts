import { describe, it, expect, vi } from 'vitest';
import { register } from '../compact.js';
import { fakeHost, humanPrompt, assistantText, withStrippedRuntimeGlobals, sha256, LEGACY_OPTIONS } from './fixtures/helpers.js';
import type { SessionMessage } from '../core/types.js';

const FLAG_PATH = '.exovault/s4-compact-active';
const SESSION = 'session-tail-shift';
const BRIEFS = `/home/u/.claude/exovault/recall/${sha256(SESSION)}/briefs`;

/** 3.45.0 (CONTRACT S4zs): a full brief gives its tail shift back when the newest messages need it. */
describe('compact.ts: the full brief returns its tail shift to an oversized tail (S4zs)', () => {
  const briefText = Array.from({ length: 160 }, (_, i) => `- step ${i}: change packages/app/src/part-${i}.ts and keep its test green`).join('\n');
  const files: Record<string, string> = {
    [FLAG_PATH]: '1',
    [`${BRIEFS}/briefs.json`]: JSON.stringify([{ id: '0123456789ab', path: `${BRIEFS}/0123456789ab.md`, chars: briefText.length, at: '2026-10-03T09:00:00.000Z', firstLine: '- step 0' }]),
    [`${BRIEFS}/0123456789ab.md`]: briefText,
  };

  function conversation(lastPromptChars: number): SessionMessage[] {
    const old: SessionMessage[] = [];
    for (let i = 0; i < 30; i += 1) {
      old.push(humanPrompt(`turn ${i}: ${'detail '.repeat(600)}`));
      old.push(assistantText(`reply ${i}: ${'detail '.repeat(600)}`));
    }
    // w17 w60d: the cut came right after a new 20k-23k character task prompt, which the tail must keep.
    return [...old, humanPrompt(`Task 5 of 8. ${'Change the panel and keep its tests green. '.repeat(Math.ceil(lastPromptChars / 42))}`)];
  }

  async function cut(lastPromptChars: number) {
    const lines: string[] = [];
    const $ = fakeHost({
      sessionId: async () => SESSION,
      envGet: async (name) => (name === 'HOME' ? '/home/u' : undefined),
      fsExists: async (path) => path in files || path.endsWith(`/${FLAG_PATH}`),
      fsRead: async (path) => { if (path in files) return files[path]; if (path.endsWith(`/${FLAG_PATH}`)) return '1'; throw new Error(`ENOENT: ${path}`); },
      uiLog: (line: string) => lines.push(line),
    });
    const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    register(((name: string, handler: never) => { handlers[name] = handler; return { catch: (caught: unknown) => { (handlers as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS, denseNotes: true, recallEnabled: true, totalBudgetTokens: 13000 } as never);
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, { trigger: 'auto', messages: conversation(lastPromptChars) }, next))) as { messages?: SessionMessage[] };
    return { lines, next, seed: result.messages?.[0]?.text ?? '', tail: (result.messages ?? []).slice(1).map((message) => message.text).join('\n') };
  }

  it('keeps the cut and the brief when the newest prompt is larger than the shifted tail budget', async () => {
    const { lines, next, seed, tail } = await cut(25500);
    expect(lines.some((line) => /^seed\.full_brief=1 seed\.brief_tail_shift=[1-9]/.test(line))).toBe(true);
    expect(lines.join('\n')).not.toContain('compact.fallback=budget');
    expect(next).not.toHaveBeenCalled();
    expect(lines.some((line) => /^seed\.brief_shift_returned=[1-9]/.test(line))).toBe(true);
    expect(seed).toContain('0123456789ab.md');
    // external review 4 (B1): the newest prompt itself stays verbatim in the tail.
    expect(tail).toContain('Task 5 of 8. Change the panel');
  });

  it('leaves the shift alone when the tail fits it', async () => {
    const { lines, next } = await cut(2000);
    expect(next).not.toHaveBeenCalled();
    expect(lines.some((line) => line.startsWith('seed.brief_shift_returned='))).toBe(false);
  });
});

/** 3.55.0: the full brief's need is its whole rendered section, and the working notes shrink before it. */
describe('compact.ts: the newest brief stays whole when older briefs are listed (3.55.0)', () => {
  const session = 'session-brief-whole';
  const dir = `/home/u/.claude/exovault/recall/${sha256(session)}/briefs`;
  const newest = Array.from({ length: 120 }, (_, i) => `- rule ${i}: packages/app/src/panel-${i}.tsx keeps data-testid="panel-${i}" and at most ${i + 3} lines`).join('\n');
  const older = (n: number) => ({ id: `00000000000${n}`, path: `${dir}/00000000000${n}.md`, chars: 18000, at: `2026-10-04T0${n}:00:00.000Z`, firstLine: `Task ${n} of 8. The harness committed your previous task and started this one; read every rule below before editing ${'packages/app/src/'.repeat(4)}` });
  const files: Record<string, string> = {
    [FLAG_PATH]: '1',
    [`${dir}/briefs.json`]: JSON.stringify([older(1), older(2), { id: '0000000000b3', path: `${dir}/0000000000b3.md`, chars: newest.length, at: '2026-10-04T03:00:00.000Z', firstLine: '- rule 0' }]),
    [`${dir}/0000000000b3.md`]: newest,
  };

  it('puts the newest brief in the seed verbatim to its last line', async () => {
    const lines: string[] = [];
    const $ = fakeHost({
      sessionId: async () => session,
      envGet: async (name) => (name === 'HOME' ? '/home/u' : undefined),
      fsExists: async (path) => path in files || path.endsWith(`/${FLAG_PATH}`),
      fsRead: async (path) => { if (path in files) return files[path]; if (path.endsWith(`/${FLAG_PATH}`)) return '1'; throw new Error(`ENOENT: ${path}`); },
      uiLog: (line: string) => lines.push(line),
    });
    const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    register(((name: string, handler: never) => { handlers[name] = handler; return { catch: (caught: unknown) => { (handlers as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS, denseNotes: true, recallEnabled: true, realTokenCount: true, totalBudgetTokens: 20000 } as never);
    const messages: SessionMessage[] = [];
    for (let i = 0; i < 40; i += 1) {
      messages.push(humanPrompt(`step ${i}: edit packages/app/src/panel-${i}.tsx and run the tests`));
      messages.push(assistantText(`done ${i}: ${'changed the panel, kept its tests green, noted the file and the decision. '.repeat(40)}`));
    }
    const next = vi.fn(async () => ({ fellBack: true }) as unknown);
    const result = (await withStrippedRuntimeGlobals(() => handlers['session.compact']($, { trigger: 'auto', messages }, next))) as { messages?: SessionMessage[] };
    expect(next).not.toHaveBeenCalled();
    const seed = result.messages?.[0]?.text ?? '';
    expect(seed).toContain('<task-brief>');
    expect(seed).toContain('- rule 119: packages/app/src/panel-119.tsx keeps data-testid="panel-119"');
    expect(lines).toContain('seed.task_brief_kept_whole=1');
  });
});
