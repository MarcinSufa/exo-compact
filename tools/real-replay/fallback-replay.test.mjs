import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureSnapshotAt, cardFromSeedText, messagesAtBoundary, messagesThroughBoundary, createMemoryOverlay, realTokenCountForCut, restoreTaskCardForCut, restoreTaskCardHorizonForCut } from './fallback-replay.mjs';

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

test('a capture segment written after the cut is invisible', () => {
  const snapshot = captureSnapshotAt([
    { name: 'segment-000001.json', mtimeMs: 300, snapshotMs: 100, text: 'pre-cut segment appended later' },
    { name: 'segment-000002.json', mtimeMs: 201, snapshotMs: 201, text: 'written after' },
  ], 200);
  assert.deepEqual([...snapshot.keys()], ['segment-000001.json']);
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
