import { describe, expect, it } from 'vitest';
import { attendedSession, type SessionSignals } from '../host/notices.js';

type Env = string | undefined | 'throw' | 'absent';

function closure(value: Env): (() => Promise<string | undefined>) | undefined {
  if (value === 'absent') return undefined;
  if (value === 'throw') return async () => { throw new Error('env'); };
  return async () => value;
}

function signals(surfaces: readonly unknown[] | 'throw', entrypoint: Env = 'absent', childSession: Env = 'absent', briefChild: Env = 'absent'): SessionSignals {
  const bag: SessionSignals = {
    surfaces: surfaces === 'throw' ? async () => { throw new Error('no surfaces'); } : async () => surfaces,
  };
  const entry = closure(entrypoint);
  const child = closure(childSession);
  const brief = closure(briefChild);
  if (entry) bag.entrypoint = entry;
  if (child) bag.childSession = child;
  if (brief) bag.briefChild = brief;
  return bag;
}

describe('attendedSession', () => {
  it.each([
    { name: 'a terminal surface with entrypoint cli', surfaces: ['terminal'] as readonly unknown[], entrypoint: 'cli' as Env, child: undefined as Env, brief: undefined as Env, attended: true },
    { name: 'a surface even when the entrypoint is anything and a child marker is set', surfaces: ['terminal'], entrypoint: 'sdk-cli', child: '1', brief: undefined, attended: true },
    { name: 'no surface and entrypoint claude-vscode', surfaces: [], entrypoint: 'claude-vscode', child: undefined, brief: undefined, attended: true },
    { name: 'no surface and claude-vscode when both child markers are empty strings', surfaces: [], entrypoint: 'claude-vscode', child: '', brief: '', attended: true },
    { name: 'no surface and claude-vscode with CLAUDE_CODE_CHILD_SESSION set', surfaces: [], entrypoint: 'claude-vscode', child: '1', brief: undefined, attended: false },
    { name: 'no surface and claude-vscode with EXOVAULT_BRIEF_CHILD set', surfaces: [], entrypoint: 'claude-vscode', child: undefined, brief: '1', attended: false },
    { name: 'no surface and entrypoint sdk-cli', surfaces: [], entrypoint: 'sdk-cli', child: undefined, brief: undefined, attended: false },
    { name: 'no surface and entrypoint sdk-ts', surfaces: [], entrypoint: 'sdk-ts', child: undefined, brief: undefined, attended: false },
    { name: 'no surface and entrypoint sdk-py', surfaces: [], entrypoint: 'sdk-py', child: undefined, brief: undefined, attended: false },
    { name: 'no surface and entrypoint cli', surfaces: [], entrypoint: 'cli', child: undefined, brief: undefined, attended: false },
    { name: 'no surface and an unset entrypoint', surfaces: [], entrypoint: undefined, child: undefined, brief: undefined, attended: false },
    { name: 'a vscode surface', surfaces: ['vscode'], entrypoint: 'claude-vscode', child: undefined, brief: undefined, attended: true },
  ])('$name', async ({ surfaces, entrypoint, child, brief, attended }) => {
    await expect(attendedSession(signals(surfaces, entrypoint, child, brief))).resolves.toBe(attended);
  });

  it('counts a failing surfaces() as no surface, so claude-vscode is still attended', async () => {
    await expect(attendedSession(signals('throw', 'claude-vscode', undefined, undefined))).resolves.toBe(true);
  });

  it('counts a throwing entrypoint read as not attended', async () => {
    await expect(attendedSession(signals([], 'throw', undefined, undefined))).resolves.toBe(false);
  });

  it('is not attended when the three env closures are absent and there is no surface', async () => {
    await expect(attendedSession(signals([]))).resolves.toBe(false);
  });
});
