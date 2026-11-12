import test from 'node:test';
import assert from 'node:assert/strict';
import * as recall from './recall-when-needed.mjs';
const { analyzeTranscript, extractItems } = recall;

const at = (milliseconds) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, milliseconds)).toISOString();
const boundary = (timestamp = at(0)) => ({ type: 'system', subtype: 'compact_boundary', timestamp });
const user = (content, milliseconds, extra = {}) => ({
  type: 'user', timestamp: at(milliseconds), message: { content, ...extra.message }, ...extra,
});
const assistant = (id, content, milliseconds) => ({
  type: 'assistant', timestamp: at(milliseconds), message: { id, content },
});
const pluginSeed = (milliseconds = 1, text = 'Seed text.') => user(`[[exovault:s4-seed:v1]]\n${text}`, milliseconds);
const nativeSummary = (content, milliseconds = 1) => user(content, milliseconds, { isCompactSummary: true });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const toolResult = (id, content) => ({ type: 'tool_result', tool_use_id: id, content });
const init = (tools) => ({ type: 'system', subtype: 'init', tools });
const itemsIn = (text) => new Set(extractItems(text));

test('extracts absolute, relative, and basename file paths with recognized extensions', () => {
  const found = itemsIn('/repo/src/worker.ts ./docs/guide.md ../state/session.json package.json');
  for (const item of ['/repo/src/worker.ts', './docs/guide.md', '../state/session.json', 'package.json']) {
    assert.ok(found.has(item), `expected ${item}`);
  }
  const negative = itemsIn('example.com path-without-extension foo.123 https://host.test/repo/main.ts');
  assert.equal(negative.size, 0);
});

test('extracts 7 to 40 character git SHAs, but not short, malformed, UUID-fragment, or issue tokens', () => {
  const found = itemsIn('a1b2c3d 0123456789abcdef0123456789abcdef01234567');
  assert.ok(found.has('a1b2c3d'));
  assert.ok(found.has('0123456789abcdef0123456789abcdef01234567'));
  const negative = itemsIn('a1b2c3 012345678g 12345678-abcd-1234-abcd-12345678901z #12345678');
  assert.deepEqual(negative, new Set(['#12345678']));
});

test('does not treat all-digit identifiers as SHAs', () => {
  assert.deepEqual(itemsIn('1731400000 20261112 a8274f3 0123456'), new Set(['a8274f3']));
});

test('extracts UUIDs as a whole identifier and rejects malformed UUIDs', () => {
  const id = '123e4567-e89b-12d3-a456-426614174000';
  assert.deepEqual(itemsIn(id), new Set([id]));
  assert.equal(itemsIn('123e4567-e89b-12d3-a456-42661417400z').size, 0);
});

test('extracts issue and PR numbers with a hash prefix only', () => {
  assert.deepEqual(itemsIn('#7 #123'), new Set(['#7', '#123']));
  assert.equal(itemsIn('issue 123 #abc').size, 0);
});

test('extracts jobq IDs and numeric background job IDs, but not ordinary prose', () => {
  assert.deepEqual(itemsIn('jobq:queue-2026-11-12-a9 job-17'), new Set(['jobq:queue-2026-11-12-a9', 'job-17']));
  assert.equal(itemsIn('job queue job-description jobq').size, 0);
});

test('excludes exact items represented in the seed or retained tail', () => {
  const events = [
    user('Before compaction: #701 #702 and /repo/tail.ts', 0),
    boundary(),
    user('[[exovault:s4-seed:v1]]\nSeed text includes #701.', 1),
    user('Retained tail mentions /repo/tail.ts', 500),
    assistant('use-retained', [{ type: 'text', text: 'Use #701, #702, and /repo/tail.ts now.' }], 3000),
  ];
  const [cut] = analyzeTranscript(events);
  assert.equal(cut.arm, 'plugin');
  assert.equal(cut.preCutItems, 3);
  assert.equal(cut.needs.length, 1);
  assert.equal(cut.needs[0].item, '#702');
});

test('strict recall counts an exact query or result; loose recall counts any earlier search_session call', () => {
  const exact = [
    user('Before compaction: #801', 0), boundary(), pluginSeed(),
    assistant('search', [toolUse('s1', 'mcp__recall__search_session', { query: 'find #801' })], 3000),
    assistant('use', [{ type: 'text', text: 'The identifier is #801.' }], 4000),
  ];
  const [exactCut] = analyzeTranscript(exact);
  assert.equal(exactCut.needs[0].strict, 'recall');
  assert.equal(exactCut.needs[0].loose, 'recall');

  const result = [
    user('Before compaction: #802', 0), boundary(), pluginSeed(),
    assistant('search', [toolUse('s2', 'mcp__recall__search_session', { query: 'find old ticket number' })], 3000),
    user([toolResult('s2', 'Result excerpt contains #802.')], 3500),
    assistant('use', [{ type: 'text', text: 'The identifier is #802.' }], 4000),
  ];
  const [resultCut] = analyzeTranscript(result);
  assert.equal(resultCut.needs[0].strict, 'recall');
  assert.equal(resultCut.needs[0].loose, 'recall');
});

test('strict and loose recall can differ when a generic search precedes the user source', () => {
  const events = [
    user('Before compaction: #803', 0), boundary(), pluginSeed(),
    assistant('search', [toolUse('s3', 'mcp__recall__search_session', { query: 'check the prior decision' })], 2500),
    user('The issue is #803; please check.', 3000),
    assistant('use', [{ type: 'text', text: 'For #803, the prior decision was ...' }], 4000),
  ];
  const [cut] = analyzeTranscript(events);
  assert.equal(cut.needs[0].strict, 'user');
  assert.equal(cut.needs[0].loose, 'recall');
});

test('classifies grep/find results and file reads as rederive', () => {
  const grep = [
    user('Before compaction: #804', 0), boundary(), pluginSeed(),
    assistant('grep', [toolUse('g1', 'Grep', { pattern: '#804' })], 3000),
    user([toolResult('g1', 'match: #804')], 3500),
    assistant('use', [{ type: 'text', text: 'Found #804.' }], 4000),
  ];
  const [grepCut] = analyzeTranscript(grep);
  assert.equal(grepCut.needs[0].strict, 'rederive');
  assert.equal(grepCut.needs[0].loose, 'rederive');

  const read = [
    user('Previously worked in /repo/old.ts', 0), boundary(), pluginSeed(),
    assistant('read', [toolUse('r1', 'Read', { file_path: '/repo/old.ts' })], 3000),
    assistant('use', [{ type: 'text', text: 'I will update /repo/old.ts.' }], 4000),
  ];
  const [readCut] = analyzeTranscript(read);
  assert.equal(readCut.needs[0].strict, 'rederive');
  assert.equal(readCut.needs[0].loose, 'rederive');
});

test('classifies an unprompted exact use as none', () => {
  const events = [
    user('Before compaction: 123e4567-e89b-12d3-a456-426614174000', 0), boundary(), pluginSeed(),
    assistant('use', [{ type: 'text', text: 'The run id was 123e4567-e89b-12d3-a456-426614174000.' }], 3000),
  ];
  const [cut] = analyzeTranscript(events);
  assert.equal(cut.needs[0].strict, 'none');
  assert.equal(cut.needs[0].loose, 'none');
});

test('recognizes native summaries and stops after 20 assistant calls or the next cut', () => {
  const afterWindow = [user('Before: #901', 0), boundary(), nativeSummary('NATIVE SUMMARY'), ...Array.from({ length: 20 }, (_, i) => assistant(`a${i}`, [{ type: 'text', text: `Call ${i + 1}.` }], 3000 + i)), assistant('a21', [{ type: 'text', text: 'Use #901.' }], 4000)];
  const [windowCut] = analyzeTranscript(afterWindow);
  assert.equal(windowCut.arm, 'native');
  assert.equal(windowCut.assistantCallsObserved, 20);
  assert.equal(windowCut.needs.length, 0);

  const nextBoundary = [
    user('Before: #902', 0), boundary(), nativeSummary('NATIVE SUMMARY'),
    assistant('a1', [{ type: 'text', text: 'Call one.' }], 3000),
    boundary(at(3500)), nativeSummary('SECOND SUMMARY', 3501),
    assistant('a2', [{ type: 'text', text: 'Use #902.' }], 4000),
  ];
  const [firstCut] = analyzeTranscript(nextBoundary);
  assert.equal(firstCut.arm, 'native');
  assert.equal(firstCut.assistantCallsObserved, 1);
  assert.equal(firstCut.needs.length, 0);
});

test('uses system/init tool lists as authoritative availability evidence', () => {
  const authoritative = [
    init(['Read', 'mcp__recall__search_session']),
    assistant('prior-search', [toolUse('before', 'mcp__recall__search_session', {})], 0),
    boundary(), pluginSeed(),
  ];
  const [available] = analyzeTranscript(authoritative);
  assert.equal(available.searchSessionAvailable, true);
  assert.equal(available.searchSessionAvailabilityEvidence, 'system_init_tool_list');

  const explicitAbsence = [
    init(['Read']),
    assistant('prior-search', [toolUse('before', 'mcp__recall__search_session', {})], 0),
    boundary(), pluginSeed(),
  ];
  const [unavailable] = analyzeTranscript(explicitAbsence);
  assert.equal(unavailable.searchSessionAvailable, false);
  assert.equal(unavailable.searchSessionAvailabilityEvidence, 'system_init_tool_list');
  assert.equal(unavailable.searchSessionOldProxyAvailable, false);
});

test('orders fallback availability evidence and excludes calls at or after the boundary', async (t) => {
  await t.test('an injected plugin seed that names search_session means it was offered', () => {
    const [cut] = analyzeTranscript([boundary(), pluginSeed(1, 'Use search_session for earlier details.')]);
    assert.equal(cut.searchSessionAvailable, true);
    assert.equal(cut.searchSessionAvailabilityEvidence, 'plugin_seed_mentions_search_session');
  });

  await t.test('plugin seed evidence takes priority over earlier tool use', () => {
    const events = [
      assistant('prior-search', [toolUse('before', 'mcp__recall__search_session', {})], 0),
      boundary(), pluginSeed(1, 'Use search_session for earlier details.'),
    ];
    const [cut] = analyzeTranscript(events);
    assert.equal(cut.searchSessionAvailabilityEvidence, 'plugin_seed_mentions_search_session');
  });

  await t.test('only a search_session call strictly before this boundary is fallback evidence', () => {
    const events = [
      assistant('prior-search', [toolUse('before', 'mcp__recall__search_session', {})], 0),
      boundary(), nativeSummary('NATIVE SUMMARY'),
    ];
    const [cut] = analyzeTranscript(events);
    assert.equal(cut.searchSessionAvailable, true);
    assert.equal(cut.searchSessionAvailabilityEvidence, 'pre_boundary_search_session_tool_use');
  });

  await t.test('a search_session call inside this cut window does not make it available', () => {
    const events = [
      boundary(), nativeSummary('NATIVE SUMMARY'),
      assistant('inside-window', [toolUse('inside', 'mcp__recall__search_session', {})], 3000),
    ];
    const [cut] = analyzeTranscript(events);
    assert.equal(cut.searchSessionAvailable, false);
    assert.equal(cut.searchSessionAvailabilityEvidence, 'unavailable');
    assert.equal(cut.searchSessionOldProxyAvailable, true);
  });
});

test('splits need counts and class shares by item rule', () => {
  const values = '/repo/file.ts a1b2c3d 123e4567-e89b-12d3-a456-426614174000 #7 job-17';
  const events = [
    init(['mcp__recall__search_session']),
    user(`Before compaction: ${values}`, 0), boundary(), pluginSeed(),
    assistant('use-all', [{ type: 'text', text: `Use these now: ${values}` }], 3000),
  ];
  const [cut] = analyzeTranscript(events);
  assert.deepEqual(new Set(cut.needs.map((need) => need.itemRule)), new Set(['path', 'sha', 'uuid', 'issueNumber', 'jobId']));
  assert.equal(typeof recall.summarizeArm, 'function');
  const summary = recall.summarizeArm([cut]);
  assert.equal(summary.needsByItemRule.path.needs, 1);
  assert.equal(summary.needsByItemRule.path.shareOfAllNeeds, 0.2);
  assert.equal(summary.needsByItemRule.path.strict.categories.none.needs, 1);
  assert.equal(summary.needsByItemRule.path.strict.categories.none.share, 1);
  assert.equal(summary.needsByItemRule.issueNumber.loose.categories.none.needs, 1);
});
