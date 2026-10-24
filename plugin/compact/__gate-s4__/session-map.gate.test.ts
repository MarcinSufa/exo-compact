import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { humanAsk, timelineBuilder } from '../recall/timeline.mjs';
import { recallSession } from '../recall/recall.mjs';
import { recallTool } from '../recall/mcp-server.mjs';
import { renderSessionMap } from '../core/session-map.js';
import type { SessionSegment } from '../core/session-map.js';

const worker = fileURLToPath(new URL('../recall/build-worker.mjs', import.meta.url));
const tokens = (text: string) => Math.ceil(text.length / 4);
const user = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'user', timestamp: '2026-09-29T18:38:00Z', message: { role: 'user', content: text }, ...extra });
const edit = (file: string, command?: string) => ({ type: 'assistant', timestamp: '2026-09-29T18:40:00Z', message: { role: 'assistant', content: [
  { type: 'tool_use', id: `t-${file}`, name: command ? 'Bash' : 'Edit', input: command ? { command } : { file_path: `/repo/src/${file}`, old_string: 'a', new_string: 'b' } },
] } });
const boundary = { type: 'system', subtype: 'compact_boundary' };

describe('session timeline (recall/timeline.mjs)', () => {
  it('keeps only words a person typed: no notifications, peers, seeds, summaries, tool results or shell escapes', () => {
    expect(humanAsk(user('please find why the refusals start after a cut', { origin: { kind: 'human' } }))).toContain('refusals');
    expect(humanAsk(user('<task-notification><task-id>b1</task-id></task-notification>', { origin: { kind: 'task-notification' } }))).toBe('');
    expect(humanAsk(user('Another Claude session sent a message: hello there friend', { isMeta: true, origin: { kind: 'peer' } }))).toBe('');
    expect(humanAsk(user('[[exovault:s4-seed:v1]]\n\n## Constraints'))).toBe('');
    expect(humanAsk(user('This session is being continued from a previous conversation.', { isCompactSummary: true }))).toBe('');
    expect(humanAsk(user('! cd /repo && git status --short'))).toBe('');
    expect(humanAsk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'a long output line here' }] } })).toBe('');
    expect(humanAsk(user('ok'))).toBe('');
    expect(humanAsk(user('the key is sk-abcdefghijklmnopqrstu please keep it'))).toContain('[redacted]');
  });

  it('splits the session at compact boundaries and collects asks, edited files and commit subjects per segment', () => {
    const t = timelineBuilder();
    for (const e of [user('set up the recall index for long sessions'), edit('rank.mjs'), edit('rank.mjs'), edit('recall.mjs'), boundary,
      user('fix the tail picker when the cut follows a prompt'), edit('tail.ts'), edit('', 'git add -A && git commit -qm "3.28.1: tail keeps the work"'), boundary, boundary,
      user('add the session map to the seed')]) t.add(e);
    const segments = t.result();
    expect(segments.map((s: SessionSegment) => s.segment)).toEqual([0, 1, 3]);
    expect(segments[0]).toMatchObject({ asks: ['set up the recall index for long sessions'], files: ['rank.mjs', 'recall.mjs'], commits: [] });
    expect(segments[1].commits).toEqual(['3.28.1: tail keeps the work']);
    expect(segments[1].from).toBe('2026-09-29T18:38:00Z');
  });
});

describe('session map in the seed (core/session-map.ts)', () => {
  const segment = (n: number): SessionSegment => ({ segment: n, from: `2026-09-${String(10 + (n % 18)).padStart(2, '0')}T08:00:00Z`, to: '', asks: [`ask number ${n} about the recall index and the session map work`, `second ask ${n} about something else entirely`], files: [`file-${n}.ts`, 'rank.mjs', 'tail.ts'], commits: [`3.${n}.0: change ${n}`] });

  it('renders one line per segment with date, asks, edited files and commits', () => {
    const text = renderSessionMap([segment(1), segment(2)], tokens, 900);
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toMatch(/^S1: 09-11 08:00 \| asks: ask number 1 .* \| edited: file-1\.ts, rank\.mjs, tail\.ts \| commits: 3\.1\.0: change 1$/m);
  });

  it('stays within budget on an 80-segment session: oldest lines lose detail first, then fold into one pointer line, newest stay whole', () => {
    const all = Array.from({ length: 80 }, (_, i) => segment(i));
    const text = renderSessionMap(all, tokens, 900);
    expect(tokens(text)).toBeLessThanOrEqual(900);
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^S0-S\d+: \d+ older segments, not listed; search them with the segment filter\.$/);
    expect(lines.at(-1)).toContain('ask number 79');
    expect(lines[1]).not.toContain('edited:');
  });

  it('is empty for a session with fewer than two segments that say anything', () => {
    expect(renderSessionMap([segment(0)], tokens)).toBe('');
    expect(renderSessionMap([segment(0), { segment: 1, from: '', to: '', asks: [], files: [], commits: [] }], tokens)).toBe('');
  });
});

describe('segment filter and timeline.json (build worker + search)', () => {
  const event = (role: 'user' | 'assistant', text: string) => JSON.stringify({ type: role, timestamp: '2026-09-30T10:00:00Z', message: { role, content: [{ type: 'text', text }] } }) + '\n';
  const line = (o: unknown) => JSON.stringify(o) + '\n';

  it('writes timeline.json beside the index and searches only the asked segment, keeping whole-index refs', () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 's4-session-map-'));
    try {
      const transcript = path.join(temp, 'session.jsonl');
      let text = event('user', 'Decide the Kestrel retry limit for the uploader please.') + event('assistant', 'The Kestrel retry limit is 3.');
      text += line(boundary) + event('user', 'Revisit the uploader settings now.') + event('assistant', 'The Kestrel retry limit is now 5.');
      text += line(boundary) + event('user', 'Write the release notes for the uploader.') + event('assistant', 'Release notes drafted.');
      writeFileSync(transcript, text);
      const root = path.join(temp, 'index');
      expect(spawnSync(process.execPath, [worker, transcript, root, 'seg-s', String(Buffer.byteLength(text))], { encoding: 'utf8' }).status).toBe(0);
      const dir = path.join(root, crypto.createHash('sha256').update('seg-s').digest('hex'));
      const timeline = JSON.parse(readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
      expect(timeline.segments.map((s: SessionSegment) => s.asks[0])).toEqual(['Decide the Kestrel retry limit for the uploader please.', 'Revisit the uploader settings now.', 'Write the release notes for the uploader.']);
      const first = recallSession(root, 'seg-s', 'Kestrel retry limit', 5, Infinity, { segment: 0 });
      expect(first.hits.length).toBeGreaterThan(0);
      expect(first.hits.every((hit: { segment: number }) => hit.segment === 0)).toBe(true);
      expect(first.hits.map((hit: { text: string }) => hit.text).join(' ')).toContain('limit is 3');
      const whole = recallSession(root, 'seg-s', 'Kestrel retry limit is now 5', 5);
      const ref = whole.hits.find((hit: { text: string }) => hit.text.includes('now 5')).ref;
      const scoped = recallSession(root, 'seg-s', 'Kestrel retry limit is now 5', 5, Infinity, { segment: 1 });
      expect(scoped.hits[0].ref).toBe(ref);
      const empty = recallTool({ query: 'Kestrel', session: 'seg-s', segment: 9 }, { recallRoot: root, transcript });
      expect(empty.hits).toEqual([]);
      expect(empty.note).toBe('Segment 9 has no excerpts; this session has segments 0 to 2.');
      expect(() => recallTool({ query: 'Kestrel', session: 'seg-s', segment: -1 }, { recallRoot: root, transcript })).toThrow('segment must be an integer from 0');
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
