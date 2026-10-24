export function countToolUsesSinceSummary(_messages: readonly unknown[]): number { return 0; }
export function parseAgentPressureState(_text: string | null): { state: null; unreadable: true } { return { state: null, unreadable: true }; }
export function advanceAgentPressure(_previous: unknown, _toolUses: number) {
  return { compactions: 1, consecutivePressure: 0, pressure: 0, guidance: null, state: { compactions: 1, consecutivePressure: 0 } };
}
export function guidanceForPressure(_pressure: number, _compactions: number) { return { role: 'user' as const, text: 'broken', toolUses: [] as [] }; }
