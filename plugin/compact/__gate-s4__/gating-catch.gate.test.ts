import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { LEGACY_OPTIONS } from './fixtures/helpers.js';

type Hook = (host: unknown, event: unknown, next: unknown) => unknown;
type CatchHandler = (host: unknown, event: unknown, next: unknown) => unknown;

const GATING_EVENTS = [
  'prompt.submit',
  'session.compact',
  'classic.PreToolUse',
  'classic.PostToolUse',
  'classic.Stop',
] as const;

function harness() {
  const hooks: Record<string, Hook> = {};
  const caught: Record<string, CatchHandler> = {};
  const on = (event: string, hook: Hook) => {
    hooks[event] = hook;
    return { catch: (handler: CatchHandler) => { caught[event] = handler; } };
  };
  return import('../compact.js').then(({ register }) => {
    register(on as never, { ...LEGACY_OPTIONS } as never);
    return { hooks, caught };
  });
}

describe('gating hook catch handlers', () => {
  it('registers a catch handler on each gating hook', async () => {
    const { caught } = await harness();
    expect(Object.keys(caught).sort()).toEqual([...GATING_EVENTS].sort());
  });

  it.each(['classic.Stop', 'prompt.submit'] as const)('%s logs a caught throw and returns next(event)', async (event) => {
    const { caught } = await harness();
    const logs: Array<[string, unknown]> = [];
    const $ = { ui: { log: (line: string, options: unknown) => { logs.push([line, options]); } } };
    const input = { text: 'keep this event' };
    const result = { passed: true };
    let forwarded: unknown;
    const next = Object.assign(async (value: unknown) => {
      forwarded = value;
      return result;
    }, { error: { kind: 'throw', budget: 1000 } });

    await expect(caught[event]($, input, next)).resolves.toBe(result);
    expect(forwarded).toBe(input);
    expect(logs).toEqual([[`hook.caught=${event} kind=throw`, { to: 'debug' }]]);
  });

  it('continues when writing the debug notice throws', async () => {
    const { caught } = await harness();
    const $ = { ui: { log: () => { throw new Error('debug log unavailable'); } } };
    const input = { stop_hook_active: false };
    const result = { passed: true };
    const next = Object.assign(async () => result, { error: { kind: 'timeout', budget: 10000 } });

    await expect(caught['classic.Stop']($, input, next)).resolves.toBe(result);
  });

  it('chains .catch directly on every gating on() registration', () => {
    const source = readFileSync(new URL('../compact.ts', import.meta.url), 'utf8');
    const sourceFile = ts.createSourceFile('compact.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const registrations = new Map<string, ts.CallExpression[]>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'on') {
        const event = node.arguments[0];
        if (event && ts.isStringLiteral(event) && GATING_EVENTS.includes(event.text as typeof GATING_EVENTS[number])) {
          registrations.set(event.text, [...(registrations.get(event.text) ?? []), node]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    for (const event of GATING_EVENTS) {
      const calls = registrations.get(event) ?? [];
      expect(calls, `${event} should have one registration`).toHaveLength(1);
      const registration = calls[0];
      const catchAccess = registration.parent;
      expect(catchAccess && ts.isPropertyAccessExpression(catchAccess) && catchAccess.expression === registration && catchAccess.name.text === 'catch', `${event} must chain .catch directly`).toBe(true);
      const catchCall = catchAccess?.parent;
      expect(catchCall && ts.isCallExpression(catchCall) && catchCall.expression === catchAccess, `${event} must call .catch(handler)`).toBe(true);
    }
  });
});
