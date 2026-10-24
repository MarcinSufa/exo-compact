import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handleMessage } from '../recall/mcp-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.join(root, 'recall/mcp-server.mjs');
const node = process.execPath;
const spawnProbe = spawnSync(node, ['-e', ''], { encoding: 'utf8' });
const event = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';

function makeIndex(home: string, session: string, text: string) {
  const projects = path.join(home, '.claude/projects/project');
  const transcript = path.join(projects, `${session}.jsonl`);
  mkdirSync(projects, { recursive: true });
  writeFileSync(transcript, text);
  const generationDir = path.join(home, '.claude/exovault/recall', hashedSessionDir(session), 'generation-00000001');
  mkdirSync(generationDir, { recursive: true });
  const row = { sourceId: 'fixture-row', sourceSessionId: session, position: 0, turn: 1, role: 'user', tool: '', filePath: '', text };
  writeFileSync(path.join(generationDir, 'records.json'), JSON.stringify([row]));
  writeFileSync(path.join(generationDir, 'manifest.json'), JSON.stringify({ sessionId: session, generation: 1, cutoffPosition: statSync(transcript).size, lineage: [], createdAt: new Date(0).toISOString(), chunkCount: 1 }));
  writeFileSync(path.join(path.dirname(generationDir), 'CURRENT'), '1\n');
  return transcript;
}

function rpcProcess(home: string) {
  const child = spawn(node, [server], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw JSON-RPC replies are asserted field by field
  const pending = new Map<number, (value: any) => void>();
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      const message = JSON.parse(line);
      if (pending.has(message.id)) { pending.get(message.id)!(message); pending.delete(message.id); }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  let next = 1;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw JSON-RPC replies are asserted field by field
  const request = (method: string, params = {}) => new Promise<any>((resolve, reject) => {
    const id = next++;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`timeout awaiting ${method}`)); }, 3000);
    pending.set(id, (value) => { clearTimeout(timeout); resolve(value); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    child.once('error', reject);
    child.once('exit', (code) => { if (pending.has(id)) reject(new Error(`server exit ${code}: ${stderr}`)); });
  });
  return { child, request };
}

describe('recall MCP stdio server', () => {
  it('handles initialize, tools/list, indexed/fallback calls, output limits, and unknown sessions', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 's4-recall-mcp-direct-'));
    const session = 'direct-session';
    try {
      const transcript = makeIndex(home, session, event('The Kestrel station uses the distinctive code KST-48213. ' + 'archive detail '.repeat(2600)));
      const options = { home, transcript, recallRoot: path.join(home, '.claude/exovault/recall') };
      expect(handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }).result.serverInfo.name).toBe('recall');
      expect(handleMessage({ id: 2, method: 'tools/list' }).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['search_session']);
      expect(handleMessage({ id: 2, method: 'tools/list' }).result.tools[0]._meta).toEqual({ 'anthropic/alwaysLoad': true });
      const indexed = handleMessage({ id: 3, method: 'tools/call', params: { name: 'search_session', arguments: { query: 'Kestrel KST-48213', session, k: 5 } } }, options).result.structuredContent;
      expect(indexed.source).toBe('session-index');
      expect(indexed.hits[0].text).toContain('KST-48213');
      expect(indexed.hits.reduce((sum: number, hit: { text: string }) => sum + Math.ceil(hit.text.length / 4) + 24, 0)).toBeLessThanOrEqual(750);
      rmSync(path.join(options.recallRoot, hashedSessionDir(session)), { recursive: true, force: true });
      const fallback = handleMessage({ id: 4, method: 'tools/call', params: { name: 'recall', arguments: { query: 'Kestrel KST-48213', session, k: 5 } } }, options).result.structuredContent;
      expect(fallback.source).toBe('bounded-transcript-fallback');
      const unknown = handleMessage({ id: 5, method: 'tools/call', params: { name: 'recall', arguments: { query: 'missing detail', session: 'unknown' } } }, { home, recallRoot: options.recallRoot, projectsRoot: path.join(home, 'no-projects') }).result.structuredContent;
      expect(unknown).toMatchObject({ source: 'no-index', hits: [] });
      expect(transcript).toContain(session);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it.skipIf(Boolean(spawnProbe.error))('handshakes, lists recall, calls a published generation, labels fallback, caps size, and handles unknown session', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 's4-recall-mcp-'));
    const session = 'mcp-session';
    try {
      const body = event(`The Kestrel station uses the distinctive code KST-48213. ${'archive detail '.repeat(2600)}`);
      const transcript = makeIndex(home, session, body);
      const { child, request } = rpcProcess(home);
      try {
        const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
        expect(init.result.serverInfo.name).toBe('recall');
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        const listed = await request('tools/list');
        expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['search_session']);
        const called = await request('tools/call', { name: 'search_session', arguments: { query: 'Kestrel KST-48213', session, k: 5 } });
        const indexed = called.result.structuredContent;
        expect(indexed.source).toBe('session-index');
        expect(indexed.hits[0].text).toContain('KST-48213');
        expect(indexed.hits.reduce((sum: number, hit: { text: string }) => sum + Math.ceil(hit.text.length / 4) + 24, 0)).toBeLessThanOrEqual(750);
        rmSync(path.join(home, '.claude/exovault/recall', hashedSessionDir(session)), { recursive: true, force: true });
        const fallback = await request('tools/call', { name: 'recall', arguments: { query: 'Kestrel KST-48213', session, k: 5 } });
        expect(fallback.result.structuredContent.source).toBe('bounded-transcript-fallback');
        const unknown = await request('tools/call', { name: 'recall', arguments: { query: 'missing detail', session: 'unknown-session' } });
        expect(unknown.result.structuredContent).toMatchObject({ source: 'no-index', hits: [] });
        expect(transcript).toContain(session);
      } finally { child.kill(); }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

function hashedSessionDir(session: string) {
  return createHash('sha256').update(session).digest('hex');
}
