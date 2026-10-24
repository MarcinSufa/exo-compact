/**
 * Switches every gate test between the real (stub, throws) implementation under `core/` and a
 * deliberately broken one under `__gate-s4__/broken/` (brief-s4a-gate.md deliverable 3), so
 * `GATE.md` can record separate red runs from the same test files. `broken` seeds a
 * handled-vs-rebuilt defect across every family. `broken-pairs` targets only the tail
 * picker's pair-atomicity invariant (an orphan tool_result would break the API request), so
 * every other family still loads the real `core/` implementation under that mode.
 */
export function gateMode(): 'stub' | 'broken' | 'broken-pairs' {
  const value = process.env.S4_GATE_IMPL;
  return value === 'broken' || value === 'broken-pairs' ? value : 'stub';
}

export function usingBrokenImpl(): boolean {
  return gateMode() === 'broken';
}

export async function loadImpl<T>(family: string): Promise<T> {
  const mode = gateMode();
  const hostFamily = ['capture-path', 'capture-flag', 'capture-order', 'fs-adapter', 'transcript-path'].includes(family);
  const path =
    mode === 'broken' ? `./broken/${family}.js` : mode === 'broken-pairs' && family === 'tail' ? './broken/tail-pairs.js' : hostFamily ? `../host/${family}.js` : `../core/${family}.js`;
  return (await import(path)) as T;
}
