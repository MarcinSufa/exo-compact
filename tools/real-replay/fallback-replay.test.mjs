import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureSnapshotAt, cardFromSeedText, discoverData, messagesAtBoundary, messagesThroughBoundary, createMemoryOverlay, historicalCaptureFiles, makeHost, matchBoundaries, matchSessionBoundaries, realTokenCountForCut, replayCut, replaySeedMetrics, restoreTaskCardForCut, restoreTaskCardHorizonForCut, runReplay } from './fallback-replay.mjs';

test('the cut budget-count notice selects the replay token counter', () => {
  assert.equal(realTokenCountForCut({ noticeLines: [{ body: 'seed.budget_total=20000 seed.budget_count=real' }] }), true);
  assert.equal(realTokenCountForCut({ noticeLines: [{ body: 'seed.budget_total=13000 seed.budget_count=chars4' }] }), false);
  assert.equal(realTokenCountForCut({ noticeLines: [] }), true);
});

test('original card notices restore a card into the snapshot, while non-card cuts stay card-free', () => {
  const cardCut = {
    noticeLines: [
      { body: 'seed.budget_total=8000 seed.budget_count=real' },
      { body: 'seed.budget_split seed=5000 tail=3000 dense=1000' },
      { body: 'seed.task_card=1 seed.task_card_size=2400' },
    ],
  };
  const card = restoreTaskCardForCut({
    cut: cardCut,
    snapshot: new Map(),
    currentText: '# Task card\n- current contents',
  });
  assert.equal(card.cardSource, 'current');
  assert.equal(card.snapshot.get('task-card.md'), '# Task card\n- current contents');

  const budgetSignaledCard = restoreTaskCardForCut({
    cut: {
      noticeLines: [
        { body: 'seed.budget_total=8000 seed.budget_count=real' },
        { body: 'seed.budget_split seed=5000 tail=3000 dense=1000' },
        { body: 'seed.task_card=0 seed.task_card_size=0' },
      ],
    },
    snapshot: new Map(),
    currentText: '# Task card\n- brief-last-prompt cut',
  });
  assert.equal(budgetSignaledCard.cardSource, 'current');
  assert.equal(budgetSignaledCard.snapshot.has('task-card.md'), true);

  const nonCard = restoreTaskCardForCut({
    cut: { noticeLines: [{ body: 'seed.budget_total=20000 seed.budget_count=real' }, { body: 'seed.task_card=0 seed.task_card_size=0' }] },
    snapshot: new Map([['task-card.md', '# Task card\n- stale file']]),
    currentText: '# Task card\n- do not inject',
  });
  assert.equal(nonCard.cardSource, 'none');
  assert.equal(nonCard.snapshot.has('task-card.md'), false);
});

test('a truncated seed card is not treated as the full card file', () => {
  const complete = cardFromSeedText('[[exovault:s4-seed:v1]]\n## Task card\n(Kept current by this session\'s model before the cut; file: /capture/task-card.md.)\n### Goal\nFinish the task.');
  assert.deepEqual(complete, { text: '# Task card\n## Goal\nFinish the task.', complete: true });
  const truncated = cardFromSeedText('[[exovault:s4-seed:v1]]\n## Task card\n(Kept current by this session\'s model before the cut; file: /capture/task-card.md.)\n### Goal\nFinish the task.\n- (4 more lines in /capture/task-card.md)');
  assert.equal(truncated.complete, false);
});

test('a found card horizon is reconstructed from the refresh notice and matching transcript tool result', () => {
  const cardCut = {
    startedAt: '2026-11-05T12:16:43.318Z',
    noticeLines: [{ body: 'seed.task_card=1 seed.task_card_size=2400' }, { body: 'seed.since_card=5 seed.since_card_size=366 seed.since_card_horizon=found' }],
  };
  const horizon = restoreTaskCardHorizonForCut({
    cut: cardCut,
    snapshot: new Map(),
    noticeText: [
      '2026-11-05T11:21:36.037Z task_card.refresh=start ctx=151577 window=250000 n=3',
      '2026-11-05T11:21:59.705Z task_card.refresh=written size=2597',
    ].join('\n'),
    events: [
      { type: 'assistant', timestamp: '2026-11-05T11:21:34.104Z', message: { content: [{ type: 'tool_use', id: 'toolu_01Y4C1AQu6gbvweQYuPWPVVy', name: 'Bash', input: { command: 'true' } }] } },
      { type: 'user', timestamp: '2026-11-05T11:21:36.057Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_01Y4C1AQu6gbvweQYuPWPVVy', content: 'ok' }] } },
    ],
    activeToolUseIds: new Set(['toolu_01Y4C1AQu6gbvweQYuPWPVVy']),
  });
  assert.equal(horizon.horizonSource, 'transcript');
  assert.deepEqual(JSON.parse(horizon.snapshot.get('task-card.horizon.json')), { toolUseId: 'toolu_01Y4C1AQu6gbvweQYuPWPVVy', at: '2026-11-05T11:21:59.705Z', tokens: 151577 });

  const nonCard = restoreTaskCardHorizonForCut({ cut: { noticeLines: [{ body: 'seed.since_card=0 seed.since_card_size=0 seed.since_card_horizon=missing' }] }, snapshot: new Map(), noticeText: '', events: [], activeToolUseIds: new Set() });
  assert.equal(nonCard.horizonSource, 'none');
  assert.equal(nonCard.snapshot.has('task-card.horizon.json'), false);
});

test('a card horizon refresh after the cut is not reconstructed into the earlier snapshot', () => {
  const horizon = restoreTaskCardHorizonForCut({
    cut: {
      startedAt: '2026-11-05T12:16:43.318Z',
      noticeLines: [{ body: 'seed.task_card=1 seed.task_card_size=2400' }, { body: 'seed.since_card=5 seed.since_card_size=366 seed.since_card_horizon=found' }],
    },
    snapshot: new Map(),
    noticeText: [
      '2026-11-05T12:16:44.000Z task_card.refresh=start ctx=151577 window=250000 n=3',
      '2026-11-05T12:16:45.000Z task_card.refresh=written size=2597',
    ].join('\n'),
    events: [
      { type: 'assistant', timestamp: '2026-11-05T12:16:43.500Z', message: { content: [{ type: 'tool_use', id: 'fixture-tool', name: 'Bash', input: { command: 'true' } }] } },
      { type: 'user', timestamp: '2026-11-05T12:16:44.001Z', message: { content: [{ type: 'tool_result', tool_use_id: 'fixture-tool', content: 'ok' }] } },
    ],
    activeToolUseIds: new Set(['fixture-tool']),
  });
  assert.equal(horizon.horizonSource, 'unavailable');
  assert.equal(horizon.snapshot.has('task-card.horizon.json'), false);
});

test('a capture segment written after the cut is invisible', () => {
  const snapshot = captureSnapshotAt([
    { name: 'segment-000001.json', mtimeMs: 300, snapshotMs: 100, text: 'pre-cut segment appended later' },
    { name: 'segment-000002.json', mtimeMs: 201, snapshotMs: 201, text: 'written after' },
  ], 200);
  assert.deepEqual([...snapshot.keys()], ['segment-000001.json']);
});

test('a numbered capture segment keeps its birthtime visibility after a later append changes mtime', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-replay-segment-'));
  const file = path.join(dir, 'segment-000001.json');
  const hash = 'a'.repeat(64);
  const otherHash = 'b'.repeat(64);
  const text = [
    JSON.stringify({ sourceHash: `${hash}#1:fixture`, body: { text: 'active record' } }),
    JSON.stringify({ sourceHash: `${otherHash}#1:fixture`, body: { text: 'inactive record' } }),
  ].join('\n') + '\n';
  try {
    fs.writeFileSync(file, text);
    const created = fs.statSync(file);
    const cutAt = Date.now() + 5_000;
    fs.utimesSync(file, new Date(cutAt + 2_000), new Date(cutAt + 2_000));
    const stat = fs.statSync(file);
    assert.ok(created.birthtimeMs <= cutAt);
    assert.ok(stat.mtimeMs > cutAt);

    const historical = historicalCaptureFiles([{
      name: path.basename(file),
      path: file,
      text: fs.readFileSync(file, 'utf8'),
      mtimeMs: stat.mtimeMs,
      birthtimeMs: created.birthtimeMs,
    }], cutAt, new Set([hash]));
    assert.equal(historical.byName.has('segment-000001.json'), true);
    assert.deepEqual(historical.byName.get('segment-000001.json').split('\n').filter(Boolean).map((line) => JSON.parse(line).body.text), ['active record']);
    assert.deepEqual(historical.identityFilter, { tagged: 2, matched: 1, dropped: 1, opaque: 0, opaqueIncluded: 0 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('boundary matching enforces cut direction, duration alignment, and the five-minute window', () => {
  const cut = { startedAt: '2026-11-05T12:00:00.000Z', completedAt: '2026-11-05T12:00:01.000Z' };
  const skewEdge = { index: 1, at: Date.parse(cut.startedAt) - 400, event: { compactMetadata: {} } };
  const beyondSkew = { index: 2, at: Date.parse(cut.startedAt) - 401, event: { compactMetadata: {} } };
  const tooFar = { index: 2, at: Date.parse(cut.completedAt) + 5 * 60_000 + 1, event: { compactMetadata: {} } };
  const wrongDuration = { index: 3, at: Date.parse(cut.startedAt) + 12_000, event: { compactMetadata: { durationMs: 1_000 } } };
  assert.equal(matchBoundaries([cut], [skewEdge]).has(cut), true);
  assert.equal(matchBoundaries([cut], [beyondSkew]).has(cut), false);
  assert.equal(matchBoundaries([cut], [tooFar]).has(cut), false);
  assert.equal(matchBoundaries([cut], [wrongDuration]).has(cut), false);
});

test('boundary matching does not let a later cut steal an earlier cut boundary', () => {
  const first = { startedAt: '2026-11-05T12:00:00.000Z', completedAt: '2026-11-05T12:00:01.000Z' };
  const next = { startedAt: '2026-11-05T12:00:10.000Z', completedAt: '2026-11-05T12:00:11.000Z' };
  const beforeNext = { index: 1, at: Date.parse(next.startedAt) - 1, event: { compactMetadata: {} } };
  const atNext = { index: 2, at: Date.parse(next.startedAt), event: { compactMetadata: {} } };
  assert.equal(matchBoundaries([first], [beforeNext], [first, next]).has(first), true);
  assert.equal(matchBoundaries([first], [atNext], [first, next]).has(first), false);
});

test('a notices-before selection still caps its last cut at the next cut in the full log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-replay-notices-before-'));
  const captureRoot = path.join(dir, 'capture');
  const projectsRoot = path.join(dir, 'projects');
  const sessionId = 'fixture-session';
  const sessionDir = path.join(captureRoot, sessionId);
  const projectDir = path.join(projectsRoot, 'fixture-project');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  const firstStart = '2026-11-05T12:00:00.000Z';
  const nextStart = '2026-11-05T12:00:10.000Z';
  fs.writeFileSync(path.join(sessionDir, 'notices.log'), [
    `${firstStart} compact.sizeBefore=10000`,
    '2026-11-05T12:00:00.500Z seed.budget_over seed=5277/5260 tail=5000/4500 total=10277',
    '2026-11-05T12:00:01.000Z compact.fallback=budget reason=budget',
    `${nextStart} compact.sizeBefore=10000`,
    '2026-11-05T12:00:11.000Z compacted ok',
  ].join('\n'));
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), '');
  try {
    const [session] = discoverData(captureRoot, projectsRoot, Date.parse('2026-11-05T12:00:02.000Z'));
    assert.equal(session.cuts.length, 1);
    assert.equal(session.allCuts.length, 2);
    const boundary = { index: 1, at: Date.parse(nextStart), event: { compactMetadata: {} } };
    assert.equal(matchSessionBoundaries(session, session.fallbacks, [boundary]).has(session.fallbacks[0]), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('disk section comparison includes captured sessions without budget fallbacks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-replay-disk-sessions-'));
  const captureRoot = path.join(dir, 'capture');
  const projectsRoot = path.join(dir, 'projects');
  const sessionId = 'control-only-session';
  const sessionDir = path.join(captureRoot, sessionId);
  const projectDir = path.join(projectsRoot, 'fixture-project');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'notices.log'), [
    '2026-11-05T12:00:00.000Z compact.sizeBefore=10000',
    '2026-11-05T12:00:01.000Z compacted ok',
  ].join('\n'));
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), '');
  try {
    assert.equal(discoverData(captureRoot, projectsRoot).length, 0);
    const [session] = discoverData(captureRoot, projectsRoot, undefined, { includeNoFallbackSessions: true });
    assert.equal(session.cuts.length, 1);
    assert.equal(session.fallbacks.length, 0);
    assert.equal(session.transcriptPath, path.join(projectDir, `${sessionId}.jsonl`));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('transcript messages after the target compact boundary are excluded', () => {
  const events = [
    { type: 'user', message: { content: 'old summary' } },
    { type: 'assistant', message: { content: 'work before cut' } },
    { type: 'system', subtype: 'compact_boundary' },
    { type: 'user', message: { content: 'work after cut' } },
  ];
  assert.deepEqual(messagesAtBoundary(events, 2).map((message) => message.text), ['old summary', 'work before cut']);
});

test('messages follow the active parent chain when the transcript has one', () => {
  const events = [
    { type: 'system', subtype: 'compact_boundary', uuid: 'previous' },
    { type: 'user', uuid: 'active-user', parentUuid: 'previous', message: { content: 'active user' } },
    { type: 'assistant', uuid: 'orphan', parentUuid: 'previous', message: { content: 'abandoned branch' } },
    { type: 'assistant', uuid: 'active-assistant', parentUuid: 'active-user', message: { content: 'active assistant' } },
    { type: 'system', subtype: 'compact_boundary', logicalParentUuid: 'active-assistant' },
  ];
  assert.deepEqual(messagesAtBoundary(events, 4).map((message) => message.text), ['active user', 'active assistant']);
});

test('capture reconstruction follows the active branch through earlier compact boundaries', () => {
  const events = [
    { type: 'user', uuid: 'old-user', message: { content: 'older captured fact' } },
    { type: 'assistant', uuid: 'old-assistant', parentUuid: 'old-user', message: { content: 'older response' } },
    { type: 'system', subtype: 'compact_boundary', uuid: 'previous', parentUuid: 'old-assistant' },
    { type: 'user', uuid: 'active-user', parentUuid: 'previous', message: { content: 'active branch' } },
    { type: 'assistant', uuid: 'orphan', parentUuid: 'previous', message: { content: 'abandoned branch' } },
    { type: 'system', subtype: 'compact_boundary', uuid: 'current-boundary', logicalParentUuid: 'active-user' },
  ];
  assert.deepEqual(messagesThroughBoundary(events, 5).map((message) => message.text), ['older captured fact', 'older response', 'active branch']);
});

test('replay host writes land in memory and leave the backing file untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-replay-'));
  const file = path.join(dir, 'capture.txt');
  fs.writeFileSync(file, 'disk');
  const overlay = createMemoryOverlay(async (name) => fs.readFileSync(name, 'utf8'));
  try {
    await overlay.write(file, 'memory');
    assert.equal(await overlay.read(file), 'memory');
    assert.equal(fs.readFileSync(file, 'utf8'), 'disk');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the replay host keeps fs writes in memory and process runs inert', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-replay-host-'));
  const sessionDir = path.join(dir, 'capture');
  const file = path.join(sessionDir, 'capture.txt');
  const processMarker = path.join(dir, 'process-marker');
  fs.mkdirSync(sessionDir);
  fs.writeFileSync(file, 'disk');
  try {
    const { host, writes } = makeHost({
      sessionId: 'fixture-session',
      sessionDir,
      cwd: dir,
      cut: { startedAt: '2026-11-05T12:00:00.000Z' },
      snapshot: new Map([['capture.txt', 'disk']]),
      pluginDir: dir,
      gitProbe: { status: undefined, worktrees: undefined },
    });
    await host.fs.write(file, 'memory');
    assert.equal(await host.fs.read(file), 'memory');
    assert.equal(writes.get(file), 'memory');
    assert.equal(fs.readFileSync(file, 'utf8'), 'disk');

    const code = `require('node:fs').writeFileSync(${JSON.stringify(processMarker)}, 'launched')`;
    await host.process.run([process.execPath, '-e', code]);
    assert.equal(fs.existsSync(processMarker), false);
    await assert.rejects(host.http.fetch('http://127.0.0.1:9/'), { code: 'REPLAY_HTTP_DISABLED' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fallback seed metrics do not count the passthrough transcript message as a seed', () => {
  const metrics = replaySeedMetrics({
    result: {
      messages: [{ role: 'user', text: 'the original transcript message', toolUses: [], toolResults: [] }],
      tokensAfter: 5,
    },
    fellBack: true,
    logs: ['seed.budget_over seed=5277/5260 tail=5000/4500 total=10277'],
    realTokenCount: false,
    budgetCore: {
      estimateTokens: () => 999,
      serializedTokens: (messages, countTokens) => messages.reduce((sum, message) => sum + countTokens(message.text), 0),
    },
  });
  assert.equal(metrics.seedTokens, null);
  assert.equal(metrics.seedMargin, null);
});

test('fallback row building passes next() into seed metrics', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-replay-row-'));
  const startedAt = '2026-11-05T12:00:00.000Z';
  const events = [
    { type: 'user', timestamp: startedAt, message: { content: 'the original transcript message' } },
    { type: 'system', subtype: 'compact_boundary', timestamp: startedAt, compactMetadata: { trigger: 'auto' } },
  ];
  try {
    const row = await replayCut({
      plugin: dir,
      register(on) {
        on('session.compact', async (host, _input, next) => {
          host.ui.log('seed.budget_over seed=5277/5260 tail=5000/4500 total=10277');
          host.ui.log('compact.fallback=budget reason=budget');
          return next();
        });
      },
      extractor: { contentIdentity: (message) => message.text },
      budgetCore: { estimateTokens: () => 1, serializedTokens: () => 17 },
      session: {
        sessionId: 'fixture-session',
        sessionDir: dir,
        transcriptPath: 'fixture-transcript',
        events,
        captureFiles: [],
      },
      cut: {
        ordinal: 1,
        type: 'fallback',
        startedAt,
        completedAt: '2026-11-05T12:00:01.000Z',
        originalSizeBefore: 10000,
        originalFallback: 'budget',
        originalBudgetOver: 'seed.budget_over seed=5277/5260 tail=5000/4500 total=10277',
        noticeLines: [{ body: 'seed.budget_over seed=5277/5260 tail=5000/4500 total=10277' }],
      },
      boundary: { index: 1, at: Date.parse(startedAt), event: events[1] },
      options: {},
    });

    assert.equal(row.eligible, true);
    assert.equal(row.replay.fellBack, true);
    assert.equal(row.replay.seedTokens, null);
    assert.equal(row.replay.seedMargin, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('seed-size diagnostics label the fixed-plugin comparison as trim', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-replay-seed-size-'));
  const pluginDir = path.join(dir, 'fixture-plugin');
  const captureRoot = path.join(dir, 'capture');
  const projectsRoot = path.join(dir, 'projects');
  const sessionId = 'fixture-session';
  const sessionDir = path.join(captureRoot, sessionId);
  const projectDir = path.join(projectsRoot, 'fixture-project');
  const startedAt = '2026-11-05T12:00:00.000Z';
  fs.mkdirSync(path.join(pluginDir, 'core'), { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, '.claude-plugin/plugin.json'), JSON.stringify({ version: 'fixture', userConfig: {} }));
  fs.writeFileSync(path.join(pluginDir, 'compact.ts'), "export function register(on) { on('session.compact', async () => ({ messages: [{ role: 'assistant', text: 'fixed seed', toolUses: [], toolResults: [] }], tokensAfter: 1 })); }\n");
  fs.writeFileSync(path.join(pluginDir, 'core/extractor.ts'), 'export function contentIdentity(message) { return message.text ?? ""; }\n');
  fs.writeFileSync(path.join(pluginDir, 'core/budgets.ts'), [
    'export function estimateTokens(text) { return Math.ceil(String(text ?? "").length / 4); }',
    'export function serializedTokens(messages, countTokens) { return messages.reduce((sum, message) => sum + countTokens(message.text), 0); }',
  ].join('\n'));
  fs.writeFileSync(path.join(sessionDir, 'notices.log'), [
    `${startedAt} compact.sizeBefore=10000`,
    '2026-11-05T12:00:00.500Z seed.budget_total=10000 seed.budget_count=chars4',
    '2026-11-05T12:00:00.600Z seed.budget_split seed=5000 tail=5000 dense=1000',
    '2026-11-05T12:00:00.700Z seed.budget_over seed=5277/5260 tail=5000/4500 total=10277',
    '2026-11-05T12:00:01.000Z compact.fallback=budget reason=budget',
  ].join('\n'));
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: 'user', timestamp: startedAt, uuid: 'fixture-user', message: { content: [{ type: 'text', text: 'fixture message' }] } }),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: startedAt, logicalParentUuid: 'fixture-user', compactMetadata: { trigger: 'auto' } }),
  ].join('\n'));
  try {
    const report = await runReplay({
      pluginDir,
      captureRoot,
      projectsRoot,
      settingsFile: path.join(dir, 'settings.json'),
    });

    assert.equal(report.diagnostics.seedSize.compared, 1);
    assert.equal(report.diagnostics.seedSize.medianReplayToLoggedRatio, 3 / 5277);
    assert.match(report.diagnostics.seedSize.note, /fidelity only for the plugin that logged the cut/);
    assert.match(report.method.seedSize, /with a fixed plugin, it measures trim against the logged seed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('replay seed size and margin use the cut token counter and handler result', () => {
  const metrics = replaySeedMetrics({
    result: {
      messages: [{ role: 'assistant', text: 'seed text', toolUses: [], toolResults: [] }],
      tokensAfter: 10,
    },
    logs: [
      'seed.budget_total=20 seed.budget_count=chars4',
      'seed.budget_split seed=12 tail=8 dense=3',
      'seed.task_card=0 seed.task_card_size=0',
    ],
    realTokenCount: false,
    budgetCore: {
      estimateTokens: () => 999,
      serializedTokens: (messages, countTokens) => messages.reduce((sum, message) => sum + countTokens(message.text), 0),
    },
  });
  assert.deepEqual(metrics, { seedTokens: 3, tokensAfter: 10, seedBudget: 13, seedMargin: 10, sectionTokens: {}, tailTokens: null });
});

test('card seed allowance reserves its effective tail budget when the returned tail exceeds it', () => {
  const metrics = replaySeedMetrics({
    result: {
      messages: [{ role: 'assistant', text: 'abc', toolUses: [], toolResults: [] }],
      tokensAfter: 18,
    },
    logs: [
      'seed.budget_total=20 seed.budget_count=chars4',
      'seed.budget_split seed=12 tail=8 dense=3',
      'seed.task_card=1 seed.task_card_size=12',
    ],
    realTokenCount: false,
    budgetCore: {
      estimateTokens: () => 999,
      serializedTokens: (messages, countTokens) => messages.reduce((sum, message) => sum + countTokens(message.text), 0),
    },
  });
  assert.equal(metrics.seedTokens, 1);
  assert.equal(metrics.seedBudget, 12);
  assert.equal(metrics.seedMargin, 11);
});
