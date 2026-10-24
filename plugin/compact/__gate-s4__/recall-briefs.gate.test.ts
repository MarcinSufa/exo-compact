import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { briefUnits, embedBriefs, searchBriefs } from '../recall/brief-search.mjs';
import { saveBrief } from '../recall/brief.mjs';
import { handleMessage, recallTool } from '../recall/mcp-server.mjs';
import { hash } from '../recall/shared.mjs';
import { DIM } from '../recall/vectors.mjs';

const OLD_BRIEF = [
  'Task 1 of 2. Build the list view.',
  '## Tests',
  '- test/r1-list.test.tsx (at least 4): renders the rows in order.',
].join('\n');
const NEW_BRIEF = [
  'Task 2 of 2. Build the inbox badge.',
  '## Files',
  '1. src/ui/inbox-badge.tsx (new, at most 40 lines): exports `InboxBadge`.',
  '   It renders nothing when the count is 0.',
  '## Tests',
  '- test/r2-host-inbox.test.tsx (at least 5): loadHost asks memoryLearned with the routed project.',
  '- test/r2-css.test.ts (at least 3): pins the badge rule.',
].join('\n');

function rootWithBriefs(session: string, briefs: string[]): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'recall-briefs-'));
  briefs.forEach((text, i) => saveBrief(root, session, text, new Date(Date.UTC(2026, 9, 2, 8, i))));
  return root;
}

describe('3.36.0 (S4zi) brief lines', () => {
  it('makes one excerpt per line with the brief label, the section heading and the 1-based line number', () => {
    const units = briefUnits(NEW_BRIEF, 'Task 2 of 2');
    expect(units[0]).toEqual({ line: 1, text: '[Task 2 of 2] Task 2 of 2. Build the inbox badge.' });
    expect(units.find((unit) => unit.line === 6)?.text).toBe('[Task 2 of 2 | Tests] - test/r2-host-inbox.test.tsx (at least 5): loadHost asks memoryLearned with the routed project.');
  });

  it('joins an indented continuation line to the item above it', () => {
    const item = briefUnits(NEW_BRIEF, 'Task 2 of 2').find((unit) => unit.line === 3);
    expect(item?.text).toBe('[Task 2 of 2 | Files] 1. src/ui/inbox-badge.tsx (new, at most 40 lines): exports `InboxBadge`.\nIt renders nothing when the count is 0.');
  });

  it('splits an over-long line and keeps its start on every later part', () => {
    const long = `- test/r9-long.test.ts (at least 9): ${'the rule holds. '.repeat(120)}`;
    const parts = briefUnits(long, 'Task 9');
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts.slice(1)) expect(part.text).toContain('- test/r9-long.test.ts (at least 9)');
    expect(new Set(parts.map((part) => part.line))).toEqual(new Set([1]));
  });
});

describe('3.36.0 (S4zi) brief search', () => {
  it('finds the line by a plain question and names <file>:<line> of the saved brief', () => {
    const root = rootWithBriefs('s1', [OLD_BRIEF, NEW_BRIEF]);
    const found = searchBriefs(root, 's1', 'minimum number of tests in the host-inbox test file', 3);
    expect(found.briefs).toBe(2);
    expect(found.hits[0].text).toContain('test/r2-host-inbox.test.tsx (at least 5)');
    expect(found.hits[0].filePath).toMatch(/briefs[\\/][0-9a-f]{12}\.md:6$/);
    expect(found.hits[0].newest).toBe(true);
  });

  it('ranks the newest brief first on an equal match, but an older line that matches more still wins', () => {
    const root = rootWithBriefs('s2', [OLD_BRIEF, NEW_BRIEF]);
    const equal = searchBriefs(root, 's2', 'which test file, at least how many', 3);
    expect(equal.hits[0].newest).toBe(true);
    const specific = searchBriefs(root, 's2', 'test file that renders the rows', 2);
    expect(specific.hits[0].text).toContain('r1-list.test.tsx');
  });

  it('returns one hit per line', () => {
    const root = rootWithBriefs('s3', [`- test/r9-long.test.ts (at least 9): ${'the badge rule holds. '.repeat(120)}`]);
    const found = searchBriefs(root, 's3', 'badge rule holds', 5);
    expect(found.hits).toHaveLength(1);
  });

  it('reports no briefs for a session without any', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'recall-briefs-'));
    expect(searchBriefs(root, 'none', 'anything', 5)).toEqual({ hits: [], missing: [], briefs: 0 });
  });
});

describe('3.36.0 (S4zi) brief line vectors', () => {
  /** A fake embedder: one axis per known word, so "stylesheet" and ".css" lines can share a direction. */
  const fakeEmbed = (axis: (text: string) => number) => async (texts: string[]) => texts.map((text) => {
    const vector = new Float32Array(DIM); vector[axis(text)] = 1; return vector;
  });
  const cssAxis = (text: string) => (/stylesheet|\.css/.test(text) ? 1 : 2);

  it('embeds every brief line once, with the passage prefix', async () => {
    const root = rootWithBriefs('v1', [OLD_BRIEF, NEW_BRIEF]);
    const seen: string[] = [];
    const embed = async (texts: string[]) => { seen.push(...texts); return fakeEmbed(cssAxis)(texts); };
    const lines = OLD_BRIEF.split('\n').length + NEW_BRIEF.split('\n').length - 1;
    expect(await embedBriefs(root, 'v1', embed)).toBe(lines);
    expect(seen.every((text) => text.startsWith('passage: '))).toBe(true);
    expect(await embedBriefs(root, 'v1', embed)).toBe(0);
  });

  it('ranks a line the query words miss when its vector is nearest', async () => {
    const root = rootWithBriefs('v2', [NEW_BRIEF.replace('pins the badge rule', 'pins the rule in badge.css')]);
    await embedBriefs(root, 'v2', fakeEmbed(cssAxis));
    const queryVector = (await fakeEmbed(cssAxis)(['query: stylesheet']))[0];
    const found = searchBriefs(root, 'v2', 'how long may the stylesheet be', 1, { queryVector });
    const [covered, rows] = String(found.vectors).split('/').map(Number);
    expect(covered).toBe(rows);
    expect(found.hits[0].matched ?? []).not.toContain('css');
    expect(found.hits[0].text).toContain('badge.css');
  });

  it('returns nothing to embed for a session without briefs', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'recall-briefs-'));
    expect(await embedBriefs(root, 'none', async () => { throw new Error('not called'); })).toBe(0);
  });
});

describe('3.36.0 (S4zi) search_session scope "brief"', () => {
  it('answers from the briefs only, with source "brief" and the file line, and logs the call', () => {
    const root = rootWithBriefs('s4', [OLD_BRIEF, NEW_BRIEF]);
    const result = recallTool({ query: 'which file is the css test', session: 's4', scope: 'brief', k: 2 }, { recallRoot: root, projectsRoot: root });
    expect(result.source).toBe('briefs');
    expect(result.hits[0]).toMatchObject({ source: 'brief', newest: true });
    expect(result.hits[0].text).toContain('test/r2-css.test.ts');
    expect(result.hits[0].filePath).toMatch(/\.md:7$/);
    const calls = readFileSync(path.join(root, hash('s4'), 'search-calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ query: 'which file is the css test', scope: 'brief' });
    expect(calls[0].hits[0]).toMatch(/^brief:[0-9a-f]{12}\.md:7$/);
  });

  it('says so when the session saved no brief', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'recall-briefs-'));
    const result = recallTool({ query: 'test file', session: 'empty', scope: 'brief' }, { recallRoot: root, projectsRoot: root });
    expect(result.hits).toEqual([]);
    expect(result.message).toContain('No long request (task brief) was saved');
  });

  it('rejects an unknown scope and keeps the session search as the default', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'recall-briefs-'));
    expect(() => recallTool({ query: 'x', session: 's', scope: 'everything' }, { recallRoot: root, projectsRoot: root })).toThrow('scope must be "session" or "brief"');
    mkdirSync(path.join(root, hash('s')), { recursive: true });
    const plain = recallTool({ query: 'x', session: 's' }, { recallRoot: root, projectsRoot: root });
    expect(plain.source).toBe('no-index');
    const calls = readFileSync(path.join(root, hash('s'), 'search-calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(calls[0]).toMatchObject({ query: 'x', scope: 'session', hits: [] });
  });

  it('lists scope in the tool schema and mentions it in the description', () => {
    const tool = handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).result.tools[0];
    expect(tool.inputSchema.properties.scope).toMatchObject({ type: 'string', enum: ['session', 'brief'], default: 'session' });
    expect(tool.description).toContain('With scope "brief" it searches instead the user\'s long requests');
  });

  it('never writes a log for a session directory that does not exist', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'recall-briefs-'));
    recallTool({ query: 'x', session: 'ghost' }, { recallRoot: root, projectsRoot: root });
    expect(() => readFileSync(path.join(root, hash('ghost'), 'search-calls.jsonl'))).toThrow();
    writeFileSync(path.join(root, 'marker'), '');
  });
});
