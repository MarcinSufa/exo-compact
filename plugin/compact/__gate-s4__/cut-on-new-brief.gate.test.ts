import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { register } from '../compact.js';
import { fakeHost, humanPrompt, assistantText, withStrippedRuntimeGlobals, LEGACY_OPTIONS } from './fixtures/helpers.js';
import type { SessionMessage } from '../core/types.js';

type Handler = (host: unknown, event: unknown, next: (event?: unknown) => Promise<unknown>) => Promise<unknown>;
type HookMap = Record<string, Handler>;
const FLAG_PATH = '/tmp/project/.exovault/s4-compact-active';

function handlers(options: Record<string, unknown> = {}): HookMap {
  const on: HookMap = {};
  register(((name: string, fn: Handler) => { on[name] = fn; return { catch: (caught: unknown) => { (on as Record<string, unknown>)[name + '.catch'] = caught; } }; }) as never, {
    ...LEGACY_OPTIONS,
    cutOnNewBrief: true,
    denseNotes: false,
    realTokenCount: false,
    totalBudgetTokens: 2000,
    taskCard: false,
    workState: false,
    workStateProbe: false,
    currentValues: false,
    sessionMap: false,
    toolOutputNotes: false,
    recallEnabled: false,
    adoptedFiles: false,
    timeoutMs: 30000,
    ...options,
  } as never);
  return on;
}

const longBrief = (label: string): string => `${label}\n\n${Array.from({ length: 80 }, (_, i) => `- Requirement ${i + 1}: preserve the existing API and verify the complete task output.`).join('\n')}`;
const previousHistory = (): SessionMessage[] => Array.from({ length: 14 }, (_, i) => [
  humanPrompt(`Previous task ${i + 1}\n${"The prior task's detailed requirement and implementation context. ".repeat(20)}`),
  assistantText(`Work completed for prior task ${i + 1}. ${'Files changed and checks passed. '.repeat(20)}`),
]).flat();

/** Drives prompt.submit -> $.session.compact() -> this plugin's actual session.compact hook. */
function harness(options: Record<string, unknown> = {}, initial: SessionMessage[] = previousHistory()) {
  const on = handlers(options);
  const state: {
    messages: SessionMessage[];
    compactInputs: SessionMessage[][];
    compactResults: unknown[];
    logs: string[];
    order: string[];
  } = { messages: initial, compactInputs: [], compactResults: [], logs: [], order: [] };
  const files = new Map<string, string>();
  let host: ReturnType<typeof fakeHost>;
  host = fakeHost({
    sessionId: async () => 's1',
    sessionCwd: async () => '/tmp/project',
    sessionMessages: async () => state.messages,
    sessionCompact: async () => {
      const messages = [...state.messages];
      state.order.push('compact');
      state.compactInputs.push(messages);
      const result = await on['session.compact']!(host, { trigger: 'plugin', messages }, async () => ({
        messages: [assistantText('Core summary'), ...messages.slice(-2)],
      }));
      state.compactResults.push(result);
      const compactedMessages = (result as { messages?: SessionMessage[] } | undefined)?.messages;
      if (compactedMessages) state.messages = [...compactedMessages];
    },
    fsExists: async (path) => path === FLAG_PATH || files.has(path),
    fsRead: async (path) => {
      if (path === FLAG_PATH) return '1';
      const text = files.get(path);
      if (text !== undefined) return text;
      throw new Error(`ENOENT: ${path}`);
    },
    fsWrite: async (path, text) => { files.set(path, text); },
    fsList: async (path = '') => [...files.entries()]
      .filter(([file]) => file.slice(0, file.lastIndexOf('/')) === path)
      .map(([file, text]) => ({ name: file.slice(file.lastIndexOf('/') + 1), kind: 'file', size: text.length })),
    uiLog: (line) => state.logs.push(line),
  });
  return { on, host, state };
}

async function submit(h: ReturnType<typeof harness>, text: string, options: { turnId?: string } = {}) {
  const input = { text, origin: { kind: 'composer' }, wait: false, ...options };
  let received: unknown;
  const next = vi.fn(async (event: unknown) => {
    h.state.order.push('next');
    received = event;
    return event;
  });
  await withStrippedRuntimeGlobals(() => h.on['prompt.submit']!(h.host, input, next));
  return { input, next, received };
}

describe('4.6.0 (S5g) cutOnNewBrief', () => {
  it('is declared off by default in the compact plugin manifest', () => {
    const manifest = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')) as {
      userConfig?: Record<string, { type?: string; default?: unknown }>;
    };
    expect(manifest.userConfig?.cutOnNewBrief?.type).toBe('boolean');
    expect(manifest.userConfig?.cutOnNewBrief?.default).toBe(false);
  });

  it('compacts the previous transcript before passing the new brief through whole', async () => {
    const prior = previousHistory();
    const h = harness({}, prior);
    const prompt = longBrief('Task 2: the complete new task specification');
    const { input, next, received } = await submit(h, prompt);

    expect(h.state.compactInputs).toHaveLength(1);
    expect(h.state.compactInputs[0]).toEqual(prior);
    expect(h.state.compactInputs[0]?.some((message) => message.text.includes('Task 2: the complete new task specification'))).toBe(false);
    expect(h.state.compactResults).toHaveLength(1);
    expect((h.state.compactResults[0] as { messages?: SessionMessage[] }).messages?.[0]?.text).toContain('[[exovault:s4-seed:v1]]');
    expect(h.state.order).toEqual(['compact', 'next']);
    expect(next).toHaveBeenCalledTimes(1);
    expect(received).toBe(input);
    expect((received as typeof input).text).toBe(prompt);
    expect(h.state.logs).toContain('compact.trigger=new_brief');
  });

  it('does not compact a short follow-up prompt', async () => {
    const h = harness();
    const followUp = 'Before you stop: run every final check the brief lists, re-read the rules, fix anything missing, then report.';
    const { received, input } = await submit(h, followUp);

    expect(h.state.compactInputs).toHaveLength(0);
    expect(received).toBe(input);
    expect(h.state.logs.some((line) => line.startsWith('compact.trigger'))).toBe(false);
  });

  it('skips the first long prompt because the session has no earlier user prompt to cut', async () => {
    const h = harness({}, []);
    const prompt = longBrief('Task 1: first task in this session');
    await submit(h, prompt);

    expect(h.state.compactInputs).toHaveLength(0);
    expect(h.state.logs).toContain('compact.trigger_skipped=first_prompt');
  });

  it('leaves prompts unchanged when the option is off', async () => {
    const h = harness({ cutOnNewBrief: false });
    const prompt = longBrief('Task 2: option disabled');
    const { received, input } = await submit(h, prompt);

    expect(h.state.compactInputs).toHaveLength(0);
    expect(received).toBe(input);
    expect(h.state.logs.some((line) => line.startsWith('compact.trigger'))).toBe(false);
  });

  it('does not try to compact while a turn is still running', async () => {
    const h = harness();
    await submit(h, longBrief('Queued task brief'), { turnId: 'running-turn' });

    expect(h.state.compactInputs).toHaveLength(0);
    expect(h.state.logs).toContain('compact.trigger_skipped=turn_running');
  });
});
