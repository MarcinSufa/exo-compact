import { SEED_SENTINEL } from './sentinel.js';
import type { SessionMessage } from './types.js';

export interface AgentPressureState {
  compactions: number;
  consecutivePressure: number;
}

export interface AgentPressureResult extends AgentPressureState {
  pressure: number;
  guidance: string | null;
  state: AgentPressureState;
}

export function countToolUsesSinceSummary(messages: readonly SessionMessage[], firstCompaction = false): number {
  if (firstCompaction) return messages.reduce((total, message) => total + (message.role === 'assistant' ? message.toolUses.length : 0), 0);
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user' && (message.text.startsWith('This session is being continued from a previous conversation') || message.text.startsWith(SEED_SENTINEL))) {
      start = index + 1;
      break;
    }
  }
  return messages.slice(start).reduce((total, message) => total + (message.role === 'assistant' ? message.toolUses.length : 0), 0);
}

export function parseAgentPressureState(text: string | null): { state: AgentPressureState | null; unreadable: boolean } {
  if (text === null) return { state: null, unreadable: true };
  try {
    const value = JSON.parse(text) as Partial<AgentPressureState>;
    if (!Number.isSafeInteger(value.compactions) || (value.compactions ?? 0) < 1 || !Number.isSafeInteger(value.consecutivePressure) || (value.consecutivePressure ?? -1) < 0) {
      return { state: null, unreadable: true };
    }
    return { state: { compactions: value.compactions!, consecutivePressure: value.consecutivePressure! }, unreadable: false };
  } catch {
    return { state: null, unreadable: true };
  }
}

export function advanceAgentPressure(previous: AgentPressureState | null, toolUses: number): AgentPressureResult {
  const compactions = (previous?.compactions ?? 0) + 1;
  const isPressured = previous !== null && toolUses < 15;
  const pressure = isPressured ? previous.consecutivePressure + 1 : 0;
  const state = { compactions, consecutivePressure: pressure };
  const guidance = compactions >= 4 || pressure >= 2
    ? 'Stop now. Return to the caller a report of what is done, what remains, and key findings so far. Say this task should be split.'
    : pressure === 1
      ? 'Work in smaller steps. Avoid re-reading whole large files; use Grep and offset reads.'
      : null;
  return { ...state, pressure, guidance, state };
}

export function guidanceForPressure(pressure: number, compactions: number): { role: 'user'; text: string; toolUses: [] } {
  const stop = compactions >= 4 || pressure >= 2;
  const text = stop
    ? '## Compaction pressure\nStop now. Report what is done, what remains, and key findings to the caller. Say this task should be split.'
    : '## Compaction pressure\nWork in smaller steps. Avoid re-reading whole large files; use Grep and offset reads.';
  return { role: 'user', text, toolUses: [] };
}
