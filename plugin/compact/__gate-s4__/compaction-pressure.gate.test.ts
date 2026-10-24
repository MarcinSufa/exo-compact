import { beforeAll, describe, expect, it } from 'vitest';
import { loadImpl } from './impl.js';
import { countTokens } from './fixtures/helpers.js';
import type {
  advanceCompactionPressure as AdvanceCompactionPressure,
  parseCompactionPressureState as ParseCompactionPressureState,
  renderCompactionPressure as RenderCompactionPressure,
  CompactionPressureState,
} from '../core/compaction-pressure.js';

let advanceCompactionPressure: typeof AdvanceCompactionPressure;
let parseCompactionPressureState: typeof ParseCompactionPressureState;
let renderCompactionPressure: typeof RenderCompactionPressure;
const idle = { toolUsesSinceCut: 3, tailToolUses: 0, manual: false };

beforeAll(async () => {
  ({ advanceCompactionPressure, parseCompactionPressureState, renderCompactionPressure } =
    await loadImpl('compaction-pressure'));
});

describe('compaction pressure state', () => {
  it('starts without pressure when there is no previous state', () => {
    const result = advanceCompactionPressure(null, 12, 4, idle);
    expect(result.pressure).toBeNull();
    expect(result.state).toMatchObject({ ordinal: 1, captureSeq: 12, userRecordCount: 4, userRecordsSincePreviousCompaction: 0, consecutivePressure: 0 });
  });

  it('resets the consecutive count when the gap is at least three user records', () => {
    const previous: CompactionPressureState = { ordinal: 2, captureSeq: 10, userRecordCount: 5, userRecordsSincePreviousCompaction: 2, consecutivePressure: 1 };
    const result = advanceCompactionPressure(previous, 20, 8, idle);
    expect(result.pressure).toBeNull();
    expect(result.state.userRecordsSincePreviousCompaction).toBe(3);
    expect(result.state.consecutivePressure).toBe(0);
  });

  it('counts one pressured compaction and increments the ordinal', () => {
    const previous: CompactionPressureState = { ordinal: 4, captureSeq: 20, userRecordCount: 8, userRecordsSincePreviousCompaction: 3, consecutivePressure: 0 };
    const result = advanceCompactionPressure(previous, 24, 10, idle);
    expect(result.pressure).toEqual({ userTurns: 2, consecutive: 1 });
    expect(result.state).toMatchObject({ ordinal: 5, captureSeq: 24, userRecordsSincePreviousCompaction: 2, consecutivePressure: 1 });
  });

  it('asks the model to stop on the third consecutive pressured compaction', () => {
    const previous: CompactionPressureState = { ordinal: 6, captureSeq: 30, userRecordCount: 12, userRecordsSincePreviousCompaction: 1, consecutivePressure: 2 };
    const { pressure } = advanceCompactionPressure(previous, 32, 14, idle);
    const section = renderCompactionPressure(pressure!);
    expect(pressure?.consecutive).toBe(3);
    expect(section).toMatch(/stop and tell the user or calling agent/i);
    expect(section).toMatch(/should be split/i);
    expect(section).toMatch(/what is done and what remains/i);
    expect(countTokens(`## Compaction pressure\n${section}`)).toBeLessThan(150);
  });

  it('does not pressure a long autonomous run that made many tool calls between cuts', () => {
    const previous: CompactionPressureState = { ordinal: 3, captureSeq: 100, userRecordCount: 2, userRecordsSincePreviousCompaction: 0, consecutivePressure: 2, tailToolUses: 4 };
    const result = advanceCompactionPressure(previous, 103, 2, { toolUsesSinceCut: 40, tailToolUses: 5, manual: false });
    expect(result.pressure).toBeNull();
    expect(result.state.consecutivePressure).toBe(0);
    expect(result.state.tailToolUses).toBe(5);
  });

  it('review-opus-s4e P2: narration is not work; few tool calls beyond the kept tail is pressure', () => {
    // Many captured assistant_text records (captureSeq +60) but only 3 new tool calls.
    const previous: CompactionPressureState = { ordinal: 3, captureSeq: 100, userRecordCount: 2, userRecordsSincePreviousCompaction: 0, consecutivePressure: 1, tailToolUses: 9 };
    expect(advanceCompactionPressure(previous, 160, 2, { toolUsesSinceCut: 12, tailToolUses: 2, manual: false }).pressure).toEqual({ userTurns: 0, consecutive: 2 });
  });

  it('review-opus-s4e P2: a manual /compact is never pressure', () => {
    const previous: CompactionPressureState = { ordinal: 3, captureSeq: 100, userRecordCount: 2, userRecordsSincePreviousCompaction: 0, consecutivePressure: 2 };
    const result = advanceCompactionPressure(previous, 101, 2, { toolUsesSinceCut: 0, tailToolUses: 0, manual: true });
    expect(result.pressure).toBeNull();
    expect(result.state.consecutivePressure).toBe(0);
  });

  it('treats absent and corrupt persisted state as unreadable', () => {
    expect(parseCompactionPressureState(null)).toEqual({ state: null, unreadable: true });
    expect(parseCompactionPressureState('{bad json')).toEqual({ state: null, unreadable: true });
  });

  it('does not pressure on corrupt state', () => {
    const { state, unreadable } = parseCompactionPressureState('{"ordinal":1}');
    expect(unreadable).toBe(true);
    expect(advanceCompactionPressure(state, 50, 20, idle).pressure).toBeNull();
  });
});
