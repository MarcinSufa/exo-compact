import { describe, expect, it, vi } from 'vitest';
import { fastestCpuMs } from './fixtures/helpers.js';

describe('fastestCpuMs: timing guards take the best CPU time of several runs', () => {
  it('runs the work three times by default and returns the fastest run in CPU milliseconds', () => {
    const used = [{ user: 400_000, system: 100_000 }, { user: 100_000, system: 20_000 }, { user: 250_000, system: 50_000 }];
    const cpu = vi.spyOn(process, 'cpuUsage').mockImplementation((previous?: NodeJS.CpuUsage) => (previous ? used.shift()! : { user: 0, system: 0 }));
    const work = vi.fn();
    try {
      expect(fastestCpuMs(work)).toBe(120);
      expect(work).toHaveBeenCalledTimes(3);
    } finally {
      cpu.mockRestore();
    }
  });

  it('does not count time the process spends waiting for the CPU', () => {
    const end = Date.now() + 60;
    expect(fastestCpuMs(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, end - Date.now())), 1)).toBeLessThan(40);
  });

  it('honours an explicit run count', () => {
    const work = vi.fn();
    fastestCpuMs(work, 5);
    expect(work).toHaveBeenCalledTimes(5);
  });
});
