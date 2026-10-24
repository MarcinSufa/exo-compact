import { LEGACY_OPTIONS } from './fixtures/helpers.js';
import { describe, expect, it } from 'vitest';
import { hasLiveSeed, isClassifierRefusal, REFUSAL_GUARD_NOTICE } from '../core/refusal-guard.js';
import { SEED_SENTINEL } from '../core/sentinel.js';
import type { CompactEvent } from '../core/types.js';

type Handler = (host: unknown, event: unknown, next: () => Promise<unknown>) => Promise<unknown>;

async function handlers(options: Record<string, unknown> = {}) {
  const { register } = await import('../compact.js');
  const on: Record<string, Handler> = {};
  register(((name: string, fn: Handler) => { on[name] = fn; return { catch: (caught: unknown) => { (on as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS, notices: 'all', ...options } as never);
  return on;
}

const FLAG = '/tmp/project/.exovault/s4-compact-active';
const GUARD_SUFFIX = '/s4-disabled.json';
const seed = { role: 'user', text: `${SEED_SENTINEL}\n## Constraints\n- none`, toolUses: [] };
const plain = { role: 'user', text: 'hello', toolUses: [] };

const FRESH = 's4-cut-fresh.json';

function fakeHost(messages: unknown[], files: Set<string> = new Set(), fresh: string | null = 'open', surfaces: string[] = ['terminal']) {
  const calls: string[] = [];
  const written = new Map<string, string>();
  return {
    calls,
    written,
    session: {
      cwd: async () => '/tmp/project',
      id: async () => 's1',
      surfaces: async () => surfaces,
      messages: async () => messages,
    },
    fs: {
      exists: async (path: string) => path === FLAG || written.has(path) || [...files].some((file) => path.endsWith(file)) || (fresh !== null && path.endsWith(`/${FRESH}`)),
      read: async (path: string) => {
        if (written.has(path)) return written.get(path)!;
        if (fresh !== null && path.endsWith(`/${FRESH}`)) return fresh;
        throw new Error('ENOENT');
      },
      write: async (path: string, text: string) => { written.set(path, text); },
      list: async () => [],
    },
    ui: { log: (line: string) => { calls.push(line); } },
    env: { get: () => undefined },
    http: { fetch: async () => ({ ok: false, status: 500, text: '' }) },
    clock: { sleep: async () => undefined, now: async () => Date.parse('2026-09-29T17:00:00Z') },
  };
}

const guardWrites = (host: ReturnType<typeof fakeHost>) => [...host.written.keys()].filter((path) => path.endsWith(GUARD_SUFFIX));
const freshWrites = (host: ReturnType<typeof fakeHost>) => [...host.written.entries()].filter(([path]) => path.endsWith(`/${FRESH}`)).map(([, text]) => text);
const refusal = { reason: 'refusal', refusal: { category: null, explanation: null }, answer: '' };

describe('refusal guard: detection', () => {
  it('counts a refusal and an error carrying the classifier text, nothing else', () => {
    expect(isClassifierRefusal({ reason: 'refusal', refusal: { category: 'x', explanation: null } })).toBe(true);
    expect(isClassifierRefusal({ reason: 'error', answer: "API Error: Sonnet 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup)." })).toBe(true);
    expect(isClassifierRefusal({ reason: 'error', answer: '' })).toBe(false);
    expect(isClassifierRefusal({ reason: 'error', answer: 'API Error: 529 overloaded' })).toBe(false);
    expect(isClassifierRefusal({ reason: 'aborted', answer: 'safeguards flagged this message' })).toBe(false);
    expect(isClassifierRefusal({ reason: 'answer', answer: 'we discussed "safeguards flagged this message" earlier' })).toBe(false);
  });

  it('sees a seed only when it is still in the conversation', () => {
    expect(hasLiveSeed([plain, seed, plain])).toBe(true);
    expect(hasLiveSeed([plain, { role: 'assistant', text: SEED_SENTINEL }])).toBe(false);
    expect(hasLiveSeed([])).toBe(false);
  });
});

describe('refusal guard: turn.complete', () => {
  it('trips on a refusal with a live seed: writes the flag once, logs, shows the notice', async () => {
    const on = await handlers();
    const $ = fakeHost([seed, plain]);
    const out = await on['turn.complete']($, { reason: 'refusal', refusal: { category: 'aup', explanation: null }, answer: '' }, async () => ({ text: '' })) as { text: string };
    expect(guardWrites($)).toHaveLength(1);
    expect(JSON.parse($.written.get(guardWrites($)[0])!)).toEqual({ reason: 'classifier_refusal', category: 'aup', at: '2026-09-29T17:00:00.000Z' });
    expect($.calls).toContain('compact.refusal_guard=tripped reason=refusal');
    expect(out.text).toBe(REFUSAL_GUARD_NOTICE);
  });

  it('shows the notice alone beneath the answer, not the answer again', async () => {
    const on = await handlers();
    const $ = fakeHost([seed]);
    const out = await on['turn.complete']($, { reason: 'error', answer: 'API Error: safeguards flagged this message' }, async () => ({ text: 'API Error: safeguards flagged this message' })) as { text: string };
    expect(out.text).toBe(REFUSAL_GUARD_NOTICE);
  });

  it('does nothing on a refusal once the main loop answered after the cut', async () => {
    const on = await handlers();
    const $ = fakeHost([seed], new Set(), 'answered');
    await on['turn.complete']($, refusal, async () => ({ text: '' }));
    expect(guardWrites($)).toHaveLength(0);
  });

  it('does nothing on a refusal with no fresh-cut marker (no S4 cut yet in this session)', async () => {
    const on = await handlers();
    const $ = fakeHost([seed], new Set(), null);
    await on['turn.complete']($, refusal, async () => ({ text: '' }));
    expect(guardWrites($)).toHaveLength(0);
  });

  it('closes the fresh-cut window on the first answer, without tripping', async () => {
    const on = await handlers();
    const $ = fakeHost([seed]);
    await on['turn.complete']($, { reason: 'answer', answer: 'ok' }, async () => ({ text: 'ok' }));
    expect(guardWrites($)).toHaveLength(0);
    expect(freshWrites($)).toEqual(['answered']);
    await on['turn.complete']($, refusal, async () => ({ text: '' }));
    expect(guardWrites($)).toHaveLength(0);
  });

  it('does not touch the marker on an answer when it is already closed', async () => {
    const on = await handlers();
    const $ = fakeHost([seed], new Set(), 'answered');
    await on['turn.complete']($, { reason: 'answer', answer: 'ok' }, async () => ({ text: 'ok' }));
    expect(freshWrites($)).toEqual([]);
  });

  it('skips the guard for a run with no surface under interactiveOnly', async () => {
    const on = await handlers({ interactiveOnly: true });
    const $ = fakeHost([seed], new Set(), 'open', []);
    await on['turn.complete']($, refusal, async () => ({ text: '' }));
    expect(guardWrites($)).toHaveLength(0);
  });

  it('does not skip the guard for an extension session with no surface under interactiveOnly', async () => {
    const on = await handlers({ interactiveOnly: true });
    const $ = fakeHost([seed], new Set(), 'open', []);
    $.env.get = (name: string) => (name === 'CLAUDE_CODE_ENTRYPOINT' ? 'claude-vscode' : undefined);
    await on['turn.complete']($, refusal, async () => ({ text: '' }));
    expect(guardWrites($)).toHaveLength(1);
  });

  it('does nothing on a refusal without a live seed (native cut or no cut)', async () => {
    const on = await handlers();
    const $ = fakeHost([plain]);
    const native = { text: '' };
    expect(await on['turn.complete']($, { reason: 'refusal', refusal: { category: null, explanation: null }, answer: '' }, async () => native)).toBe(native);
    expect(guardWrites($)).toHaveLength(0);
  });

  it('does nothing on an unrelated API error', async () => {
    const on = await handlers();
    const $ = fakeHost([seed]);
    await on['turn.complete']($, { reason: 'error', answer: 'API Error: 529 overloaded' }, async () => ({ text: '' }));
    expect(guardWrites($)).toHaveLength(0);
  });

  it('ignores a subagent refusal', async () => {
    const on = await handlers();
    const $ = fakeHost([seed]);
    await on['turn.complete']($, { reason: 'refusal', agentId: 'a1', refusal: { category: null, explanation: null }, answer: '' }, async () => ({ text: '' }));
    expect(guardWrites($)).toHaveLength(0);
  });

  it('does not rewrite the flag or repeat the notice once tripped', async () => {
    const on = await handlers();
    const $ = fakeHost([seed], new Set([GUARD_SUFFIX]));
    const out = await on['turn.complete']($, { reason: 'refusal', refusal: { category: null, explanation: null }, answer: '' }, async () => ({ text: '' })) as { text: string };
    expect(guardWrites($)).toHaveLength(0);
    expect(out.text).toBe('');
  });

  it('still calls next when the flag write fails', async () => {
    const on = await handlers();
    const $ = fakeHost([seed]);
    $.fs.write = async () => { throw new Error('EACCES'); };
    let nextCalled = false;
    const out = await on['turn.complete']($, { reason: 'refusal', refusal: { category: null, explanation: null }, answer: '' }, async () => { nextCalled = true; return { text: '' }; }) as { text: string };
    expect(nextCalled).toBe(true);
    expect(out.text).toBe('');
    expect($.calls).toContain('compact.fallback=error origin=turn-capture');
  });
});

describe('refusal guard: session.compact', () => {
  const event: CompactEvent = { trigger: 'manual', messages: [] };

  it('hands the cut to core once the guard tripped', async () => {
    const on = await handlers();
    const $ = fakeHost([seed], new Set([GUARD_SUFFIX]));
    const native = { messages: [] };
    expect(await on['session.compact']($, event, async () => native)).toBe(native);
    expect($.calls).toContain('compact.fallback=refusal_guard origin=compact');
    expect($.calls).not.toContain('compact.sizeBefore=0');
  });

  it('keeps S4 on when reading the flag throws', async () => {
    const on = await handlers();
    const $ = fakeHost([seed]);
    const exists = $.fs.exists;
    $.fs.exists = async (path: string) => { if (path.endsWith(GUARD_SUFFIX)) throw new Error('EIO'); return exists(path); };
    await on['session.compact']($, event, async () => ({ messages: [] }));
    expect($.calls).toContain('compact.sizeBefore=0');
  });

  it('runs S4 as before without the flag', async () => {
    const on = await handlers();
    const $ = fakeHost([seed]);
    await on['session.compact']($, event, async () => ({ messages: [] }));
    expect($.calls).toContain('compact.sizeBefore=0');
    expect($.calls).not.toContain('compact.fallback=refusal_guard origin=compact');
  });
});
