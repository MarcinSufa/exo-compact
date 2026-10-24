import { beforeAll, describe, expect, it } from 'vitest';
import { loadImpl } from './impl.js';
import { countTokens, LEGACY_OPTIONS } from './fixtures/helpers.js';
import type { CompactEvent, SessionMessage } from '../core/types.js';

type AgentPressure = typeof import('../core/agent-pressure.js');
let pressure: AgentPressure;

beforeAll(async () => { pressure = await loadImpl<AgentPressure>('agent-pressure'); });

const tool = (id: number): SessionMessage => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: `t${id}`, tool: 'Read' }] });
const summary: SessionMessage = { role: 'user', text: 'This session is being continued from a previous conversation. Summary: done', toolUses: [] };

describe('subagent compaction pressure', () => {
  it('counts assistant tool uses after the latest compact summary, or everything on the first cut', () => {
    expect(pressure.countToolUsesSinceSummary([tool(1), summary, tool(2), tool(3)], true)).toBe(3);
    expect(pressure.countToolUsesSinceSummary([tool(1), summary, tool(2), tool(3)], false)).toBe(2);
    expect(pressure.countToolUsesSinceSummary([tool(1), tool(2)])).toBe(2);
  });

  it('does not pressure the first compaction, pressures low progress, and resets after high progress', () => {
    const first = pressure.advanceAgentPressure(null, 0);
    expect(first.guidance).toBeNull();
    const second = pressure.advanceAgentPressure(first.state, 14);
    expect(second.pressure).toBe(1);
    expect(second.guidance).toMatch(/smaller steps/i);
    const third = pressure.advanceAgentPressure(second.state, 15);
    expect(third.pressure).toBe(0);
    expect(third.guidance).toBeNull();
  });

  it('always guides from the fourth compaction, even with plenty of progress', () => {
    let state = null as ReturnType<AgentPressure['advanceAgentPressure']>['state'] | null;
    for (let n = 0; n < 3; n += 1) state = pressure.advanceAgentPressure(state, 20).state;
    const fourth = pressure.advanceAgentPressure(state, 20);
    expect(fourth.compactions).toBe(4);
    expect(fourth.guidance).toMatch(/stop now/i);
    expect(fourth.guidance).toMatch(/split/i);
  });

  it('treats missing and corrupt state as unreadable and does not create pressure', () => {
    expect(pressure.parseAgentPressureState(null)).toEqual({ state: null, unreadable: true });
    expect(pressure.parseAgentPressureState('{bad')).toEqual({ state: null, unreadable: true });
    expect(pressure.advanceAgentPressure(null, 0).guidance).toBeNull();
  });

  it('keeps guidance under 120 estimated tokens and starts with the required heading', () => {
    const guidance = pressure.guidanceForPressure(1, 1);
    expect(guidance.role).toBe('user');
    expect(guidance.text.startsWith('## Compaction pressure')).toBe(true);
    expect(guidance.toolUses).toEqual([]);
    expect(countTokens(guidance.text)).toBeLessThan(120);
  });
});

describe('subagent hook routing', () => {
  it('returns native messages plus exactly one guidance message when persisted progress is low', async () => {
    const { register } = await import('../compact.js');
    const files = new Map<string, string>([['/tmp/project/.exovault/s4-capture/s1/agent-pressure/agent_1.json', JSON.stringify({ compactions: 1, consecutivePressure: 0 })]]);
    const $ = fakeHost(files);
    const native: SessionMessage[] = [{ role: 'user', text: 'native summary', toolUses: [] }];
    let handler: ((host: unknown, event: CompactEvent, next: () => Promise<unknown>) => Promise<unknown>) | undefined;
    const catches: Record<string, unknown> = {};
    register(((name: string, fn: typeof handler) => { if (name === 'session.compact') handler = fn; return { catch: (caught: unknown) => { catches[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS } as never);
    const next = async () => ({ messages: native, tokensBefore: 100, tokensAfter: 30 });
    const result = await handler!($, { trigger: 'auto', agentId: 'agent/1', messages: [tool(1)] }, next) as { messages: SessionMessage[] };
    expect(result.messages).toEqual([...native, expect.objectContaining({ role: 'user', text: expect.stringMatching(/^## Compaction pressure/) })]);
    expect(result.messages).toHaveLength(native.length + 1);
  });

  it('passes an unpressured subagent through native unchanged and leaves the main route unchanged', async () => {
    const { register } = await import('../compact.js');
    const files = new Map<string, string>();
    const $ = fakeHost(files);
    const native = { messages: [{ role: 'user', text: 'native', toolUses: [] }], tokensBefore: 100, tokensAfter: 30 };
    const handlers = registerHandlers(register);
    const next = async () => native;
    expect(await handlers($, { trigger: 'auto', agentId: 'first', messages: [tool(1)] }, next)).toBe(native);
    const disabled = fakeHost(new Map(), false);
    expect(await handlers(disabled, { trigger: 'auto', messages: [] }, next)).toBe(native);
  });

  it('keeps native compaction successful when writing pressure state fails', async () => {
    const { register } = await import('../compact.js');
    const $ = fakeHost(new Map());
    $.fs.write = async () => { throw new Error('read-only'); };
    const handlers = registerHandlers(register);
    const native = { messages: [{ role: 'user', text: 'native', toolUses: [] }] };
    const result = await handlers($, { trigger: 'auto', agentId: 'agent', messages: [tool(1)] }, async () => native);
    expect(result).toBe(native);
  });
});

function fakeHost(files: Map<string, string>, enabled = true) {
  return {
    session: { cwd: async () => '/tmp/project', id: async () => 's1' },
    fs: {
      exists: async (path: string) => (enabled && path.endsWith('.exovault/s4-compact-active')) || files.has(path) || [...files.keys()].some((k) => k.startsWith(`${path}/`)),
      read: async (path: string) => files.get(path) ?? Promise.reject(new Error('ENOENT')),
      write: async (path: string, text: string) => { files.set(path, text); },
      list: async (path?: string) => [...files.keys()].filter((k) => path ? k.startsWith(`${path}/`) : true).map((k) => ({ name: k.slice((path?.length ?? 0) + (path ? 1 : 0)), kind: 'file', size: files.get(k)!.length })),
    },
    ui: { log: () => undefined },
    env: { get: () => undefined },
    http: { fetch: async () => ({ ok: false, status: 500, text: async () => '' }) },
    clock: { sleep: async () => undefined },
  };
}

function registerHandlers(register: (typeof import('../compact.js'))['register']) {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  register(((name: string, fn: (...args: unknown[]) => unknown) => { handlers[name] = fn; return { catch: (caught: unknown) => { (handlers as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, { ...LEGACY_OPTIONS } as never);
  return async ($: unknown, event: CompactEvent, next: () => Promise<unknown>) => {
    return handlers['session.compact']($, event, next);
  };
}
