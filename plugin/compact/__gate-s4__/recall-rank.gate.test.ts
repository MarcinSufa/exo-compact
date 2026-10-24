import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { entities, needles, neighbours, prepare, rank, search, terms } from '../recall/rank.mjs';
import { recallTool } from '../recall/mcp-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const worker = path.join(root, 'recall/build-worker.mjs');

type Row = { text: string; position: number };
const rows = (texts: string[]): Row[] => texts.map((text, position) => ({ text, position }));
const top = (texts: string[], query: string, k = 5) => rank(prepare(rows(texts)), query, k).map((hit: Row) => hit.text);

describe('hybrid recall ranking', () => {
  it('drops English and Polish stop words but keeps ids, paths and versions whole', () => {
    expect(terms('Czy to jest plik src/lib/a.ts w wersji 3.19.0?')).toEqual(['plik', 'src/lib/a.ts', 'src', 'lib', 'ts', 'wersji', '3.19.0', '19']);
    expect(entities('Run KST-48213 on port 8443 in denseCandidates, not here.')).toEqual(['kst-48213', '8443', 'densecandidates']);
  });

  it('also counts a compound token as its parts, so a plain question finds it (3.36.0)', () => {
    expect(terms('test/r17-host-inbox.test.tsx')).toEqual(['test/r17-host-inbox.test.tsx', 'test', 'r17', 'host', 'inbox', 'test', 'tsx']);
    expect(terms('memory_learned')).toEqual(['memory_learned', 'memory', 'learned']);
    const hits = top([
      'the inbox count stays in the header for now',
      'write test/r17-host-inbox.test.tsx with at least 5 cases',
    ], 'host inbox test file');
    expect(hits[0]).toContain('r17-host-inbox');
  });

  it('ranks the chunk with the exact identifier above chunks that only share common words', () => {
    const hits = top([
      'the deploy config for the service was changed and the config was reviewed',
      'the deploy config lives in infra/deploy/prod.yaml with replicas 3',
      'unrelated note about lunch',
    ], 'deploy config prod.yaml');
    expect(hits[0]).toContain('infra/deploy/prod.yaml');
  });

  it('prefers a chunk covering more distinct query terms over one repeating a single term', () => {
    const hits = top([
      'timeout timeout timeout timeout timeout timeout',
      'the gateway timeout is 30 seconds for the upload endpoint',
    ], 'gateway upload timeout');
    expect(hits[0]).toContain('gateway timeout is 30 seconds');
  });

  it('breaks ties toward the newer chunk so a corrected value wins over the stale one', () => {
    const hits = top(['the retention period is 90 days', 'filler one', 'the retention period is 180 days'], 'retention period');
    expect(hits[0]).toContain('180 days');
  });

  it('suppresses near-duplicate chunks so the hits are different evidence', () => {
    const hits = top([
      'build failed in packages/core with TS2345 at line 10',
      'build failed in packages/core with TS2345 at line 10',
      'TS2345 fixed by widening the type in packages/core/src/a.ts',
    ], 'TS2345 packages/core', 3);
    expect(hits).toHaveLength(2);
    expect(new Set(hits).size).toBe(2);
  });

  it('returns nothing for a query made only of stop words', () => {
    expect(top(['some text here'], 'czy to jest the and')).toEqual([]);
  });
});

describe('exact values (hash prefixes, numbers in any notation, quoted phrases)', () => {
  const texts = [
    'The ctx-s4 working tree is clean at 1f373a78e30b1a645ff00cf39e06447e4b228247 after the review.',
    'Call the vendor on +48 600-123-456 before Friday.',
    'Invoice INV-2026/0042 was paid; the customer id is 7731 2208 19.',
    'the tree was not clean, something else was clean at another time',
  ];
  it('finds a full hash from its short prefix, which is not a token of its own', () => {
    expect(top(texts, '1f373a7')[0]).toContain('1f373a78e30b');
  });
  it('matches numbers of 6+ digits whatever their separators', () => {
    expect(top(texts, '600123456')[0]).toContain('+48 600-123-456');
    expect(top(texts, 'customer 773122081')[0]).toContain('7731 2208 19');
    expect(needles('call 48 600 123 456').map((n: { text: string }) => n.text)).toContain('48600123456');
  });
  it('ranks a chunk holding a quoted phrase verbatim above one holding its words apart', () => {
    expect(top(texts, '"working tree is clean"')[0]).toContain('working tree is clean at');
  });
  it('reports a verbatim value no chunk contains, keeping its spelling, and which query parts each hit matched', () => {
    const out = search(prepare(rows(texts)), 'S4_GATE_RETRY_LIMIT tree clean', 5);
    expect(out.missing).toEqual(['S4_GATE_RETRY_LIMIT']);
    // 3.36.0: the identifier's parts count too ('s4' is in a chunk), the whole identifier stays missing.
    expect(out.hits[0].matched).toEqual(['s4', 'tree', 'clean']);
    const alone = search(prepare(rows(texts)), 'S4_GATE_RETRY_LIMIT', 5);
    expect(alone.missing).toEqual(['S4_GATE_RETRY_LIMIT']);
    for (const hit of alone.hits) expect(hit.matched).toEqual(['s4']);
  });
});

describe('recall index includes tool calls', () => {
  it('indexes Bash commands and edit text with the tool name and path', () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 's4-rank-'));
    try {
      const transcript = path.join(temp, 't.jsonl');
      const line = (message: unknown, type: string) => JSON.stringify({ type, message }) + '\n';
      writeFileSync(transcript, [
        line({ role: 'user', content: 'deploy it' }, 'user'),
        line({ role: 'assistant', content: [
          { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'kubectl rollout restart deploy/api-gw -n prod-eu', description: 'Restart gateway' } },
          { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/repo/src/limits.ts', old_string: 'x', new_string: 'export const MAX_UPLOAD_MB = 64;' } },
        ] }, 'assistant'),
      ].join(''));
      const run = spawnSync(process.execPath, [worker, transcript, path.join(temp, 'index'), 's', String(statSync(transcript).size)], { encoding: 'utf8' });
      expect(run.status).toBe(0);
      const dir = path.join(temp, 'index', crypto.createHash('sha256').update('s').digest('hex'));
      const gen = Number(readFileSync(path.join(dir, 'CURRENT'), 'utf8').trim());
      const indexed = JSON.parse(readFileSync(path.join(dir, `generation-${String(gen).padStart(8, '0')}`, 'records.json'), 'utf8'));
      expect(indexed).toEqual(expect.arrayContaining([
        expect.objectContaining({ tool: 'Bash:call', text: expect.stringContaining('kubectl rollout restart deploy/api-gw -n prod-eu') }),
        expect.objectContaining({ tool: 'Edit:call', filePath: '/repo/src/limits.ts', text: expect.stringContaining('MAX_UPLOAD_MB = 64') }),
      ]));
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});

describe('recall navigation (ExoVault-style links between excerpts)', () => {
  it('links a command to its output, and around=<ref> returns that output', () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 's4-nav-'));
    try {
      const transcript = path.join(temp, 't.jsonl');
      const line = (message: unknown, type: string) => JSON.stringify({ type, message }) + '\n';
      writeFileSync(transcript, [
        line({ role: 'user', content: 'check the gateway timeout' }, 'user'),
        line({ role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'grep -n upstreamTimeout infra/gw.yaml' } }] }, 'assistant'),
        line({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: '41: upstreamTimeout: 37s' }] }, 'user'),
        line({ role: 'assistant', content: 'The gateway waits 37 seconds.' }, 'assistant'),
      ].join(''));
      const recallRoot = path.join(temp, 'index');
      const run = spawnSync(process.execPath, [worker, transcript, recallRoot, 's', String(statSync(transcript).size)], { encoding: 'utf8' });
      expect(run.status).toBe(0);
      const found = recallTool({ query: 'grep upstreamTimeout command', session: 's', k: 5 }, { recallRoot, transcript });
      const command = found.hits.find((hit: { tool: string }) => hit.tool === 'Bash:call');
      expect(command.ref).toMatch(/^g\d+:\d+$/);
      expect(command.links.output).toMatch(/^g\d+:\d+$/);
      const around = recallTool({ around: command.ref, session: 's', k: 3 }, { recallRoot, transcript });
      expect(around.hits[0]).toMatchObject({ ref: command.ref, relation: 'self' });
      expect(around.hits).toEqual(expect.arrayContaining([
        expect.objectContaining({ ref: command.links.output, relation: 'output', text: expect.stringContaining('upstreamTimeout: 37s') }),
      ]));
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('links chunks of one long command as parts, never as its output', () => {
    const prepared = prepare([
      { text: 'part one of a long heredoc', position: 10, callId: 'c1' },
      { text: 'part two of a long heredoc', position: 10, callId: 'c1' },
      { text: 'the command output', position: 20, callId: 'c1' },
    ]);
    expect([...neighbours(prepared, 0)]).toEqual(expect.arrayContaining([[1, 'message'], [2, 'call']]));
    expect(neighbours(prepared, 0).get(1)).toBe('message');
  });

  it('refuses a malformed ref, and a ref from an older index generation instead of returning the wrong excerpt', () => {
    expect(() => recallTool({ around: 'x', session: 's' }, { recallRoot: '/nonexistent', transcript: '/nonexistent' })).toThrow(/ref must look like/);
    const temp = mkdtempSync(path.join(os.tmpdir(), 's4-nav-'));
    try {
      const transcript = path.join(temp, 't.jsonl');
      writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'alpha beta gamma' } }) + '\n');
      const recallRoot = path.join(temp, 'index');
      expect(spawnSync(process.execPath, [worker, transcript, recallRoot, 's', String(statSync(transcript).size)]).status).toBe(0);
      expect(() => recallTool({ around: 'g99:0', session: 's' }, { recallRoot, transcript })).toThrow(/older index/);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
