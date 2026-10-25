import { describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { hash } from '../recall/shared.mjs';
import { recallSession, sessionHasVectors } from '../recall/recall.mjs';
import { handleMessageAsync, recallTool } from '../recall/mcp-server.mjs';
import { DIM, EMBED_SLOTS, appendVectors, nearest, readVectors, storedKeys, takeEmbedSlot, textKey, vectorFile } from '../recall/vectors.mjs';

/** A unit vector along one axis, so cosines are 1 for the same axis and 0 otherwise. */
const axis = (k: number) => { const v = new Float32Array(DIM); v[k] = 1; return v; };
const vectorsModule = new URL('../recall/vectors.mjs', import.meta.url).href;

function makeIndex(root: string, session: string, texts: string[]) {
  const dir = path.join(root, hash(session));
  const generation = path.join(dir, 'generation-00000001');
  mkdirSync(generation, { recursive: true });
  const rows = texts.map((text, i) => ({ sourceId: `row-${i}`, sourceSessionId: session, position: i * 100, turn: i + 1, role: 'user', tool: '', filePath: '', text }));
  writeFileSync(path.join(generation, 'records.json'), JSON.stringify(rows));
  writeFileSync(path.join(generation, 'manifest.json'), JSON.stringify({ sessionId: session, generation: 1, cutoffPosition: 1000, lineage: [], createdAt: new Date(0).toISOString(), chunkCount: rows.length }));
  writeFileSync(path.join(dir, 'CURRENT'), '1\n');
  return { dir, rows };
}

describe('recall vectors', () => {
  it('caps embedding machine-wide: slots held by live workers block, a released or dead holder frees one', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'recall-slots-'));
    try {
      expect(EMBED_SLOTS).toBe(2);
      const first = takeEmbedSlot(root), second = takeEmbedSlot(root);
      expect(first).toBeTypeOf('function'); expect(second).toBeTypeOf('function');
      expect(takeEmbedSlot(root)).toBeNull();
      first!();
      const third = takeEmbedSlot(root);
      expect(third).toBeTypeOf('function');
      expect(takeEmbedSlot(root)).toBeNull();
      // A worker killed while holding a slot: its pid is gone, so the next worker takes the slot over.
      const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
      second!(); writeFileSync(path.join(root, 'embed-slots', 'slot-1'), dead);
      const fourth = takeEmbedSlot(root);
      expect(fourth).toBeTypeOf('function');
      expect(readdirSync(path.join(root, 'embed-slots')).sort()).toEqual(['slot-0', 'slot-1']);
      third!(); fourth!();
      expect(readdirSync(path.join(root, 'embed-slots'))).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('stores int8 vectors append-only, skips a torn tail, and ranks rows by cosine', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 's4-recall-vectors-'));
    try {
      const file = path.join(tmp, 'v.bin');
      const rows = [{ text: 'alpha' }, { text: 'beta' }, { text: 'gamma' }];
      appendVectors(file, [{ key: textKey('alpha'), vector: axis(0) }, { key: textKey('beta'), vector: axis(1) }]);
      appendFileSync(file, Buffer.alloc(17)); // a worker killed mid-write
      expect(storedKeys(file).size).toBe(2);
      appendVectors(file, [{ key: textKey('gamma'), vector: axis(2) }]);
      expect(statSync(file).size).toBe(3 * (8 + DIM));
      const { list, covered } = nearest(rows, readVectors(file)!, axis(1));
      expect(covered).toBe(3);
      expect(list[0][0]).toBe(1);
      expect(list[0][1]).toBeCloseTo(1, 5);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it('returns 0 from appendVectors within its bound when a live lock holder never releases', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 's4-vector-lock-'));
    try {
      const file = path.join(tmp, 'vectors.bin'), lock = path.join(tmp, 'VECTOR_LOCK');
      writeFileSync(file, '');
      writeFileSync(lock, String(process.pid));
      const source = `import { appendVectors, DIM } from ${JSON.stringify(vectorsModule)}; const vector = new Float32Array(DIM); vector[0] = 1; console.log(appendVectors(${JSON.stringify(file)}, [{ key: '0123456789abcdef', vector }]));`;
      const started = Date.now();
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 3500 });
      expect(result.status, result.error?.message ?? result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('0');
      expect(Date.now() - started).toBeLessThan(3000);
      expect(statSync(file).size).toBe(0);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it('takes over an old vector lock even when its pid is alive', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 's4-vector-lock-'));
    try {
      const lock = path.join(tmp, 'VECTOR_LOCK'), old = Date.now() - 60_000;
      writeFileSync(lock, String(process.pid));
      utimesSync(lock, old / 1000, old / 1000);
      expect(Date.now() - statSync(lock).mtimeMs).toBeGreaterThan(30_000);
      const source = `import fs from 'node:fs'; import { takeVectorLock } from ${JSON.stringify(vectorsModule)}; const dir = ${JSON.stringify(tmp)}; const release = takeVectorLock(dir); console.log(release && fs.readFileSync(${JSON.stringify(lock)}, 'utf8').trim() === String(process.pid) ? 'owned' : 'busy'); release?.();`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 3500 });
      expect(result.status, result.error?.message ?? result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('owned');
      expect(existsSync(lock)).toBe(false);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it('fuses the dense list so a paraphrase with no shared words is found, and reports vector coverage', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 's4-recall-vectors-'));
    try {
      const session = 'vector-session';
      const texts = ['The deploy goes out on Fridays after the freeze.', 'Lunch is at noon in the kitchen.', 'Rollbacks need approval from the on-call lead.'];
      const { dir } = makeIndex(tmp, session, texts);
      const query = 'who signs off reverting a release';
      expect(recallSession(tmp, session, query, 3)!.hits).toHaveLength(0);
      expect(sessionHasVectors(tmp, session)).toBe(false);
      appendVectors(vectorFile(dir), texts.slice(0, 2).map((text, i) => ({ key: textKey(text), vector: axis(i) })));
      appendVectors(vectorFile(dir), [{ key: textKey(texts[2]), vector: axis(7) }]);
      expect(sessionHasVectors(tmp, session)).toBe(true);
      const found = recallSession(tmp, session, query, 1, Infinity, { queryVector: axis(7) })!;
      expect(found.vectors).toBe('3/3');
      expect(found.hits[0].text).toBe(texts[2]);
      // Without an installed model the server answers lexically, with no vectors field.
      const reply = await handleMessageAsync({ id: 1, method: 'tools/call', params: { name: 'search_session', arguments: { query: 'Fridays deploy', session } } },
        { recallRoot: tmp, runtimeDir: path.join(tmp, 'no-runtime'), projectsRoot: path.join(tmp, 'none') });
      expect(reply.result.structuredContent.hits[0].text).toBe(texts[0]);
      expect(reply.result.structuredContent.vectors).toBeUndefined();
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});

const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'recall/build-worker.mjs');
const line = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';

describe('recall index refreshed after every answer', () => {
  it('skips a turn build below 32 KB of growth, keeps three generations, and still resolves a ref one generation old', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 's4-recall-turn-'));
    try {
      const session = 'turn-session', root = path.join(tmp, 'recall'), transcript = path.join(tmp, `${session}.jsonl`);
      const build = (trigger: string) => spawnSync(process.execPath, [worker, transcript, root, session, String(statSync(transcript).size), tmp, 'lexical', trigger]);
      const generations = () => readdirSync(path.join(root, hash(session))).filter((name) => name.startsWith('generation-')).length;
      writeFileSync(transcript, line('The Kestrel station code is KST-48213.'));
      build('turn');
      expect(generations()).toBe(1);
      const ref = recallTool({ query: 'KST-48213', session }, { recallRoot: root, transcript }).hits[0].ref;
      appendFileSync(transcript, line('small follow-up'));
      build('turn');
      expect(generations()).toBe(1);
      for (let i = 0; i < 4; i++) { appendFileSync(transcript, line(`turn ${i} ${'filler words '.repeat(3000)}`)); build('turn'); }
      expect(generations()).toBe(3);
      expect(ref).toBe('g1:0');
      expect(() => recallTool({ around: ref, session }, { recallRoot: root, transcript })).toThrow(/older index/);
      const fresh = recallTool({ query: 'KST-48213', session }, { recallRoot: root, transcript }).hits[0].ref;
      appendFileSync(transcript, line(`last ${'more filler '.repeat(3000)}`)); build('turn');
      expect(recallTool({ around: fresh, session }, { recallRoot: root, transcript }).hits[0].text).toContain('KST-48213');
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
