import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepare } from '../recall/rank.mjs';
import { generationKey, readPublished, segmentKey } from '../recall/recall.mjs';

// A long-lived recall server used to keep the last 8 prepared generations of the same session index: every compaction
// publishes a new generation, so a long session held 8 stale copies (about 210 MB each for an 18k-chunk index).
const rows = (texts: string[]) => texts.map((text, position) => ({ text, position }));

describe('recall prepare cache', () => {
  it('keeps only the newest generation of a store', () => {
    const r = rows(['first chunk S4_CACHE_A', 'second chunk S4_CACHE_B']);
    const first = prepare(r, '/idx/one#1');
    expect(prepare(r, '/idx/one#1')).toBe(first);
    const second = prepare(r, '/idx/one#2');
    expect(prepare(r, '/idx/one#2')).toBe(second);
    expect(prepare(r, '/idx/one#1')).not.toBe(first);
  });

  it('keeps stores side by side and evicts the least recently used one past 8', () => {
    const r = rows(['chunk S4_CACHE_LRU']);
    const first = prepare(r, '/idx/lru-0#1');
    const next = prepare(r, '/idx/lru-1#1');
    for (let i = 2; i < 8; i++) prepare(r, `/idx/lru-${i}#1`);
    expect(prepare(r, '/idx/lru-0#1')).toBe(first);
    prepare(r, '/idx/lru-8#1');
    expect(prepare(r, '/idx/lru-0#1')).toBe(first);
    expect(prepare(r, '/idx/lru-1#1')).not.toBe(next);
  });

  it('replaces the whole-index and segment entries of a session index dir on a new generation', () => {
    const r = rows(['chunk S4_CACHE_SEGMENT']);
    const dir = '/idx/session-dir';
    const whole = prepare(r, generationKey(dir, 1));
    const three = prepare(r, segmentKey(dir, 3, 1));
    const four = prepare(r, segmentKey(dir, 4, 1));
    expect(prepare(r, generationKey(dir, 1))).toBe(whole);
    expect(prepare(r, segmentKey(dir, 3, 1))).toBe(three);
    expect(prepare(r, segmentKey(dir, 4, 1))).toBe(four);
    prepare(r, generationKey(dir, 2));
    prepare(r, segmentKey(dir, 3, 2));
    expect(prepare(r, generationKey(dir, 1))).not.toBe(whole);
    expect(prepare(r, segmentKey(dir, 3, 1))).not.toBe(three);
    expect(prepare(r, segmentKey(dir, 4, 1))).toBe(four);
  });

  it('does not cache a call without a key', () => {
    const r = rows(['chunk S4_CACHE_NOKEY']);
    expect(prepare(r)).not.toBe(prepare(r));
  });
});

describe('published generation reads', () => {
  function publish(dir: string, generation: number, texts: string[]) {
    const gen = path.join(dir, `generation-${String(generation).padStart(8, '0')}`);
    mkdirSync(gen, { recursive: true });
    writeFileSync(path.join(gen, 'records.json'), JSON.stringify(rows(texts)));
    writeFileSync(path.join(gen, 'manifest.json'), JSON.stringify({ generation, cutoffPosition: 100, chunkCount: texts.length }));
    writeFileSync(path.join(dir, 'CURRENT'), String(generation));
    return path.join(gen, 'records.json');
  }

  it('parses the records once per generation and again when CURRENT moves or the file changes', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 's4-recall-cache-'));
    try {
      publish(dir, 1, ['a chunk', 'b chunk']);
      const first = readPublished(dir);
      expect(readPublished(dir).rows).toBe(first.rows);

      publish(dir, 2, ['a chunk', 'b chunk', 'c chunk']);
      const second = readPublished(dir);
      expect(second.manifest.generation).toBe(2);
      expect(second.rows).toHaveLength(3);

      const records = publish(dir, 2, ['w chunk', 'x chunk', 'y chunk', 'z chunk']);
      expect(readPublished(dir).rows.map((row: { text: string }) => row.text)).toEqual(['w chunk', 'x chunk', 'y chunk', 'z chunk']);

      writeFileSync(records, '[');
      expect(() => readPublished(dir)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
