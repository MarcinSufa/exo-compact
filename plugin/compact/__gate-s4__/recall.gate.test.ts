import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recallSession, transcriptFallback } from '../recall/recall.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const worker = path.join(root, 'recall/build-worker.mjs');
const hookPath = path.join(root, 'compact.ts');
const pluginRoot = root;
const node = process.execPath;

function event(role: 'user' | 'assistant', text: string, blocks?: unknown[]) {
  return JSON.stringify({ type: role, message: { role, content: blocks ?? [{ type: 'text', text }] } }) + '\n';
}
function build(temp: string, transcript: string, session: string, cutoff = statSync(transcript).size) {
  return spawnSync(node, [worker, transcript, path.join(temp, 'index'), session, String(cutoff)], { encoding: 'utf8' });
}
function current(temp: string, session: string) {
  const dir = path.join(temp, 'index', createHash(session));
  const generation = Number(readFileSync(path.join(dir, 'CURRENT'), 'utf8').trim());
  const base = path.join(dir, `generation-${String(generation).padStart(8, '0')}`);
  return { dir, base, manifest: JSON.parse(readFileSync(path.join(base, 'manifest.json'), 'utf8')), rows: JSON.parse(readFileSync(path.join(base, 'records.json'), 'utf8')) };
}
function createHash(s: string) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
function recall(temp: string, session: string, query: string, transcript?: string, k = 5) {
  const result = recallSession(path.join(temp, 'index'), session, query, k);
  return result ?? (transcript ? transcriptFallback(transcript, query, k) : undefined);
}

describe('session recall generations', () => {
  it('bounds transcript fallback to the requested byte cutoff', () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 's4-recall-cutoff-'));
    try {
      const transcript = path.join(temp, 'session.jsonl');
      const prefix = event('user', 'The recorded Kestrel token is KST-48213.');
      writeFileSync(transcript, prefix + event('user', 'Future Kestrel token is FUTURE-900.'));
      const bounded = transcriptFallback(transcript, 'Kestrel token', 5, Buffer.byteLength(prefix));
      expect(bounded.hits.map((hit: { text: string }) => hit.text).join(' ')).toContain('KST-48213');
      expect(bounded.hits.map((hit: { text: string }) => hit.text).join(' ')).not.toContain('FUTURE-900');
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('appends a second compaction generation and honors each byte cutoff', () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 's4-recall-'));
    try {
      const transcript = path.join(temp, 'session.jsonl');
      const first = event('user', 'The Kestrel station code is KST-48213.');
      writeFileSync(transcript, first);
      build(temp, transcript, 's1');
      const cutoff = statSync(transcript).size;
      writeFileSync(transcript, first + event('user', 'The Rillwater test uses Polyglotta.'));
      build(temp, transcript, 's1', cutoff);
      expect(current(temp, 's1').manifest.chunkCount).toBe(1);
      writeFileSync(transcript, first + event('user', 'The Rillwater test uses Polyglotta.'));
      build(temp, transcript, 's1');
      const latest = current(temp, 's1');
      expect(latest.manifest.generation).toBe(2);
      expect(latest.rows.map((row: { text: string }) => row.text).join(' ')).toContain('Rillwater');
      expect(latest.manifest.cutoffPosition).toBe(statSync(transcript).size);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('keeps the first segment searchable after many compactions and labels each hit with its segment', () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 's4-recall-seg-'));
    try {
      const transcript = path.join(temp, 'session.jsonl');
      const boundary = JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' }) + '\n';
      let text = event('user', 'The Kestrel station code is KST-48213.');
      for (let i = 1; i <= 20; i++) text += boundary + event('user', `Segment ${i} note: the Rillwater build ${i} passed.`);
      writeFileSync(transcript, text);
      build(temp, transcript, 's-seg');
      expect(current(temp, 's-seg').manifest.compactions).toBe(20);
      const first = recall(temp, 's-seg', 'Kestrel station code');
      expect(first.hits[0].text).toContain('KST-48213');
      expect(first.hits[0].segment).toBe(0);
      const later = recall(temp, 's-seg', 'Rillwater build 17');
      expect(later.hits[0].segment).toBe(17);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('gives rows from an index built before segments existed their segment on the next build', () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 's4-recall-seg-old-'));
    try {
      const transcript = path.join(temp, 'session.jsonl');
      const boundary = JSON.stringify({ type: 'system', subtype: 'compact_boundary' }) + '\n';
      const head = event('user', 'The Kestrel station code is KST-48213.') + boundary + event('user', 'Rillwater uses Polyglotta.');
      writeFileSync(transcript, head);
      build(temp, transcript, 's-old');
      const { base, rows } = current(temp, 's-old');
      writeFileSync(path.join(base, 'records.json'), JSON.stringify(rows.map(({ segment, ...row }: { segment: number }) => row)));
      writeFileSync(transcript, head + boundary + event('user', 'Later note about Ostrava.'));
      build(temp, transcript, 's-old');
      const segments = Object.fromEntries(current(temp, 's-old').rows.map((row: { text: string; segment: number }) => [row.text.split(' ')[1], row.segment]));
      expect(segments).toEqual({ Kestrel: 0, uses: 1, note: 2 });
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('isolates fork and sibling session IDs to their own authorized transcript prefix', () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 's4-recall-'));
    try {
      const parent = path.join(temp, 'parent.jsonl'), child = path.join(temp, 'fork.jsonl'), sibling = path.join(temp, 'sibling.jsonl');
      const prefix = JSON.stringify({ type: 'user', sessionId: 'parent', uuid: 'parent-user-1', message: { role: 'user', content: [{ type: 'text', text: 'Parent prefix stores the code N-48213.' }] } }) + '\n';
      const boundary = JSON.stringify({ type: 'system', sessionId: 'parent', uuid: 'parent-boundary', subtype: 'compact_boundary' }) + '\n';
      writeFileSync(parent, prefix + boundary + event('user', 'Parent future secret is SIB-900.'));
      writeFileSync(child, JSON.stringify({ type: 'user', sessionId: 'fork', parentUuid: 'parent-boundary', message: { role: 'user', content: [{ type: 'text', text: 'Fork adds BIRCH-4 only.' }] } }) + '\n');
      writeFileSync(sibling, event('user', 'Other sibling has MAPLE-9.'));
      build(temp, child, 'fork'); build(temp, sibling, 'sibling');
      const fork = recall(temp, 'fork', 'code BIRCH-4')!;
      const siblingResult = recall(temp, 'sibling', 'code BIRCH-4')!;
      expect(fork.hits.map((hit: { text: string }) => hit.text).join(' ')).toContain('N-48213');
      expect(current(temp, 'fork').manifest.lineage).toEqual([{ sessionId: 'parent', cutoffPosition: Buffer.byteLength(prefix + boundary) }]);
      expect(siblingResult.hits.map((hit: { text: string }) => hit.text).join(' ')).not.toContain('SIB-900');
      expect(current(temp, 'fork').rows.map((row: { text: string }) => row.text).join(' ')).toContain('BIRCH-4');
      expect(current(temp, 'fork').rows.map((row: { text: string }) => row.text).join(' ')).not.toContain('SIB-900');
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('stores user/assistant text and tool-result provenance including the Read file path', () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 's4-recall-'));
    try {
      const transcript = path.join(temp, 'tools.jsonl');
      const rows = [
        event('user', 'This session is being continued from a previous conversation. Summary: old summary.'),
        event('user', 'Remember the API retention policy.'),
        event('assistant', '', [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: './docs/policy.md' } }]),
        event('user', '', [{ type: 'tool_result', tool_use_id: 'read-1', content: [{ type: 'text', text: 'Keep audit records for 180 days.' }] }]),
        event('assistant', 'I will keep the audit records for 180 days.'),
      ];
      writeFileSync(transcript, rows.join(''));
      build(temp, transcript, 'tools');
      const latest = current(temp, 'tools');
      const result = latest.rows.find((row: { tool: string }) => row.tool === 'Read');
      expect(result).toMatchObject({ role: 'user', tool: 'Read', filePath: './docs/policy.md' });
      expect(result.text).toContain('180 days');
      expect(latest.rows.some((row: { role: string; text: string }) => row.role === 'assistant' && row.text.includes('I will keep'))).toBe(true);
      expect(latest.rows.some((row: { text: string }) => row.text.includes('old summary'))).toBe(false);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('publishes an atomic manifest and retains the last known good generation on a failed build', () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 's4-recall-'));
    try {
      const transcript = path.join(temp, 's.jsonl'); writeFileSync(transcript, event('user', 'A stable generation value R-5.'));
      build(temp, transcript, 's'); const before = current(temp, 's');
      if (process.platform !== 'win32') { // Windows has no POSIX file modes
        expect(statSync(before.dir).mode & 0o777).toBe(0o700);
        expect(statSync(path.join(before.base, 'manifest.json')).mode & 0o777).toBe(0o600);
      }
      const failed = spawnSync(node, [worker, path.join(temp, 'missing.jsonl'), path.join(temp, 'index'), 's', '900'], { encoding: 'utf8' });
      expect(failed.status).toBe(0);
      expect(readFileSync(path.join(before.dir, 'CURRENT'), 'utf8')).toBe('1\n');
      expect(current(temp, 's').manifest.generation).toBe(1);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('falls back on absent and corrupt indexes, and applies S4-style secret redaction before storage', () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 's4-recall-'));
    try {
      const transcript = path.join(temp, 's.jsonl');
      writeFileSync(transcript, event('user', 'Use password=shh now; limit=-5 and limit=5 remain different.'));
      build(temp, transcript, 's');
      const indexed = current(temp, 's');
      expect(indexed.rows[0].text).toContain('[redacted]');
      expect(indexed.rows[0].text).toContain('limit=-5'); expect(indexed.rows[0].text).toContain('limit=5');
      writeFileSync(transcript, [
        event('user', 'limit=-5'), event('user', 'limit=-5'), event('user', 'limit=5'), event('user', 'Limit=-5'),
      ].join(''));
      build(temp, transcript, 'exact');
      expect(current(temp, 'exact').rows.map((row: { text: string }) => row.text)).toEqual(['limit=-5', 'limit=5', 'Limit=-5']);
      writeFileSync(path.join(indexed.base, 'records.json'), '{broken');
      const result = recall(temp, 's', 'password', transcript)!;
      expect(result.source).toBe('bounded-transcript-fallback');
      const absent = recall(temp, 'missing', 'limit', transcript)!;
      expect(absent.source).toBe('bounded-transcript-fallback');
      expect(recallSession(path.join(temp, 'index'), 's', 'password', 5, 1)).toBeUndefined();
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('caps recall results at five chunks and approximately 750 tokens', () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 's4-recall-'));
    try {
      const transcript = path.join(temp, 's.jsonl');
      writeFileSync(transcript, Array.from({ length: 20 }, (_, i) => event('user', `Project Kestrel station port ${40000 + i} uses station Kestrel.`)).join(''));
      build(temp, transcript, 's');
      const output = recall(temp, 's', 'Kestrel station port', undefined, 5)!;
      expect(output.hits.length).toBeLessThanOrEqual(5);
      expect(output.hits.reduce((sum: number, row: { text: string }) => sum + Math.ceil(row.text.length / 4) + 24, 0)).toBeLessThanOrEqual(750);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});

it('the hook uses only same-file $.noun.event call sites and hands indexing to a detached worker', () => {
  const source = readFileSync(hookPath, 'utf8');
  const hooks = JSON.parse(readFileSync(path.join(pluginRoot, 'hooks/hooks.json'), 'utf8'));
  expect(hooks.modules).toHaveLength(1);
  expect(source).not.toMatch(/\b(?:const|let|var)\s+\w+\s*=\s*\$\s*;/);
  expect(source).not.toMatch(/\b\w+\(\s*\$\s*\)/);
  expect(source).toContain("$.process.run(['node', launcher, transcriptPath, recallRoot, sessionId, recallVectorsEnabled ? 'vectors' : 'lexical', 'cut', retentionDays(options)]");
  expect(source).toContain('void $.process.run');
  expect(source).not.toMatch(/await\s+\$\.process\.run/);
  expect(readFileSync(path.join(pluginRoot, 'recall/launch.mjs'), 'utf8')).toContain('detached: true');
});

it('a large realistic transcript can be handed to the detached index worker without blocking an event-loop heartbeat for one second', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 's4-recall-lag-'));
  try {
    const transcript = path.join(temp, 'large.jsonl');
    const turn = event('user', `The Kestrel station ${'has a realistic multiline result '.repeat(20)} code 48213.`);
    writeFileSync(transcript, turn.repeat(12000));
    const launcher = path.join(pluginRoot, 'recall/launch.mjs');
    let maxLag = 0, expectedAt = Date.now() + 20;
    const timer = setInterval(() => { const lag = Date.now() - expectedAt; maxLag = Math.max(maxLag, lag); expectedAt = Date.now() + 20; }, 20);
    const started = Date.now();
    const result = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
      const child = spawn(node, [launcher, transcript, path.join(temp, 'index'), 'lag-session'], { stdio: 'ignore' });
      child.once('error', (error) => resolve({ code: null, error }));
      child.once('exit', (code) => resolve({ code }));
    });
    clearInterval(timer);
    expect(result.error).toBeUndefined(); expect(result.code).toBe(0); expect(Date.now() - started).toBeLessThan(1000); expect(maxLag).toBeLessThan(1000);
  } finally { rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

describe('recall chunker keeps exact values intact', () => {
  it('never splits inside decimals, versions or punctuated ids in long paragraphs', async () => {
    const { chunk } = await import('../recall/shared.mjs');
    const para = `${'Filler sentence here. '.repeat(60)}The rate is 0.08 and the key is PX/7!b on v1.2.3 now.`;
    const joined = chunk(para).join('\n');
    for (const value of ['0.08', 'PX/7!b', 'v1.2.3']) expect(joined).toContain(value);
  });
});
