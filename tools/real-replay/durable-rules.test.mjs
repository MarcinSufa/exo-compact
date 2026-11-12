import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeCuts, collectTranscriptCuts, normalizeRuleUnit, renderMarkdown } from './durable-rules.mjs';

const UNIT = 'Keep the current request in the hot seed';

function seed({ constraints = [], rules = [], decisions = [] } = {}) {
  return [
    '[[exovault:s4-seed:v1]]',
    '<session-memory source="exo-compact">',
    '## Constraints (history)',
    ...constraints,
    '## Task card',
    '### Rules',
    ...rules,
    '### Decisions',
    ...decisions,
    '</session-memory>',
  ].join('\n');
}

function cut(claudeProjectDirKey, sessionKey, timestamp, seedText, extra = {}) {
  return {
    claudeProjectDirKey,
    gitRepoKey: extra.gitRepoKey ?? claudeProjectDirKey,
    gitRepoEvidence: extra.gitRepoEvidence ?? 'gitCommonDir',
    sessionKey,
    boundaryTimestamp: timestamp,
    seedText,
    ...(extra.preCutHarnessTexts ? { preCutHarnessTexts: extra.preCutHarnessTexts } : {}),
  };
}

function metrics(report, cutIndex, scope) {
  return report.cuts[cutIndex].scopes[scope].sources;
}

test('normalizes bullets, quoted lines, source tags, case, and whitespace', () => {
  assert.equal(normalizeRuleUnit('  -   Keep   the current request in the hot seed [user, Stop hook]  '), UNIT.toLowerCase());
  assert.equal(normalizeRuleUnit('  > KEEP the current request in the hot seed [user, Stop hook]  '), UNIT.toLowerCase());
});

test('separates within-session and cross-session repeats in each scope', () => {
  const report = analyzeCuts([
    cut('claude-a', 'session-a1', 10, seed({ constraints: [`- ${UNIT} [user, Stop hook]`] }), { gitRepoKey: 'repo-a' }),
    cut('claude-a', 'session-a1', 20, seed({ constraints: [`> ${UNIT}`] }), { gitRepoKey: 'repo-a' }),
    cut('claude-a', 'session-a2', 30, seed({ rules: [`- ${UNIT}`] }), { gitRepoKey: 'repo-a' }),
    cut('claude-b', 'session-b1', 40, seed({ constraints: [`- ${UNIT}`] }), { gitRepoKey: 'repo-b' }),
  ]);

  assert.equal(report.scopes.claudeProjectDir.sample.sessions, 3);
  assert.equal(report.scopes.claudeProjectDir.sample.projects, 2);
  assert.equal(metrics(report, 0, 'claudeProjectDir').all.crossSessionRepeatTokens, 0);
  assert.ok(metrics(report, 1, 'claudeProjectDir').all.withinSessionRepeatTokens > 0);
  assert.equal(metrics(report, 1, 'claudeProjectDir').all.crossSessionRepeatTokens, 0);
  assert.ok(metrics(report, 2, 'claudeProjectDir').all.crossSessionRepeatTokens > 0);
  assert.equal(metrics(report, 3, 'claudeProjectDir').all.crossSessionRepeatTokens, 0);
  assert.ok(metrics(report, 2, 'claudeProjectDir').taskCardRules.crossSessionRepeatTokens > 0);
  assert.equal(metrics(report, 2, 'claudeProjectDir').constraintsHistory.crossSessionRepeatTokens, 0);
});

test('gitRepo joins different Claude project dirs while global also joins other repos', () => {
  const report = analyzeCuts([
    cut('claude-worktree-a', 'session-a', 10, seed({ constraints: [`- ${UNIT}`] }), { gitRepoKey: 'common-repo-a' }),
    cut('claude-worktree-b', 'session-b', 20, seed({ constraints: [`- ${UNIT}`] }), { gitRepoKey: 'common-repo-a' }),
    cut('claude-other-repo', 'session-c', 30, seed({ constraints: [`- ${UNIT}`] }), { gitRepoKey: 'common-repo-b' }),
  ]);

  assert.equal(metrics(report, 1, 'claudeProjectDir').all.crossSessionRepeatTokens, 0);
  assert.ok(metrics(report, 1, 'gitRepo').all.crossSessionRepeatTokens > 0);
  assert.ok(metrics(report, 1, 'global').all.crossSessionRepeatTokens > 0);
  assert.equal(metrics(report, 2, 'claudeProjectDir').all.crossSessionRepeatTokens, 0);
  assert.equal(metrics(report, 2, 'gitRepo').all.crossSessionRepeatTokens, 0);
  assert.ok(metrics(report, 2, 'global').all.crossSessionRepeatTokens > 0);
});

test('a rule seen only in a later session does not count as a prior repeat', () => {
  const report = analyzeCuts([
    cut('project-a', 'session-later', 20, seed({ constraints: ['- Later session will repeat this phrase'] })),
    cut('project-a', 'session-current', 10, seed({ constraints: ['- Later session will repeat this phrase'] })),
  ]);

  assert.equal(metrics(report, 0, 'claudeProjectDir').all.crossSessionRepeatTokens, 0);
  assert.ok(metrics(report, 1, 'claudeProjectDir').all.crossSessionRepeatTokens > 0);
});

test('near-match sensitivity includes Jaccard 0.8 and rejects lower similarity', () => {
  const longWords = Array.from({ length: 29 }, (_, index) => `word${index}`);
  const closeWords = [...longWords];
  closeWords[14] = 'changed14';
  const fartherWords = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
  const fartherVariant = ['alpha', 'beta', 'gamma', 'theta', 'epsilon', 'zeta'];
  const report = analyzeCuts([
    cut('project-near', 'session-near-old', 10, seed({ constraints: [`- ${longWords.join(' ')}`] })),
    cut('project-near', 'session-near-new', 20, seed({ constraints: [`- ${closeWords.join(' ')}`, `- ${fartherVariant.join(' ')}`] })),
    cut('project-far', 'session-far-old', 30, seed({ constraints: [`- ${fartherWords.join(' ')}`] })),
    cut('project-far', 'session-far-new', 40, seed({ constraints: [`- ${fartherVariant.join(' ')}`] })),
  ]);

  assert.equal(metrics(report, 1, 'claudeProjectDir').all.crossSessionRepeatTokens, 0);
  assert.ok(metrics(report, 1, 'claudeProjectDir').all.nearMatchAdditionalTokens > 0);
  assert.equal(metrics(report, 3, 'claudeProjectDir').all.nearMatchAdditionalTokens, 0);
});

test('counts cross-session repeat units already delivered by same-session harness text', () => {
  const report = analyzeCuts([
    cut('claude-a', 'session-old', 10, seed({ constraints: [`- ${UNIT}`] }), { gitRepoKey: 'repo-a' }),
    cut('claude-b', 'session-new', 20, seed({ constraints: [`- ${UNIT}`] }), {
      gitRepoKey: 'repo-a',
      preCutHarnessTexts: [`System rule: KEEP   the current request in the hot seed.`],
    }),
  ]);

  assert.equal(metrics(report, 1, 'claudeProjectDir').all.harnessDeliveredRepeatUnits, 0);
  assert.equal(metrics(report, 1, 'gitRepo').all.harnessDeliveredRepeatUnits, 1);
  assert.equal(metrics(report, 1, 'global').all.harnessDeliveredRepeatUnits, 1);
  assert.equal(report.scopes.gitRepo.cohorts.allCuts.cutsWithHarnessDeliveredRepeatUnits.all, 1);
  assert.equal(report.scopes.global.cohorts.allCuts.cutsWithHarnessDeliveredRepeatUnits.all, 1);
  assert.match(renderMarkdown(report), /Harness-delivered exact repeat units/);
  assert.equal(JSON.stringify(report).includes(UNIT), false);
});

test('a missing cwd falls back to its unchanged cwd key and counts fallback evidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-rules-cwd-'));
  try {
    const transcript = path.join(dir, 'session.jsonl');
    const events = [
      { type: 'system', subtype: 'compact_boundary', timestamp: '2026-01-01T00:00:00.000Z', sessionId: 'session-gone', cwd: '/gone/repo-wt' },
      { type: 'user', timestamp: '2026-01-01T00:00:01.000Z', sessionId: 'session-gone', cwd: '/gone/repo-wt', message: { content: seed({ constraints: [`- ${UNIT}`] }) } },
    ];
    fs.writeFileSync(transcript, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    let resolverCalls = 0;
    const collected = await collectTranscriptCuts(dir, {
      resolveGitCommonDir(cwd) {
        resolverCalls++;
        assert.equal(cwd, '/gone/repo-wt');
        return undefined;
      },
    });

    assert.equal(resolverCalls, 1);
    assert.equal(collected.cuts[0].gitRepoKey, '/gone/repo-wt');
    assert.equal(collected.cuts[0].gitRepoEvidence, 'cwdFallback');
    const report = analyzeCuts(collected.cuts, collected.sampleMetadata);
    assert.equal(report.scopes.gitRepo.sample.fallbackSessions, 1);
    assert.equal(report.scopes.gitRepo.sample.evidenceKindSessions.cwdFallback, 1);
    assert.equal(JSON.stringify(report).includes('/gone/repo-wt'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('serialized report contains no rule unit text or unhashed scope keys', () => {
  const secretUnit = 'Never print this synthetic private phrase';
  const report = analyzeCuts([
    cut('/private/project-a', 'session-a1', 10, seed({ constraints: [`- ${secretUnit}`] }), { gitRepoKey: '/private/repository' }),
    cut('/private/project-a', 'session-a2', 20, seed({ constraints: [`- ${secretUnit}`] }), { gitRepoKey: '/private/repository' }),
  ]);

  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(secretUnit), false);
  assert.equal(serialized.includes('/private/project-a'), false);
  assert.equal(serialized.includes('/private/repository'), false);
  assert.equal(report.scopes.claudeProjectDir.topRepeatedUnits.length, 1);
  assert.match(report.scopes.claudeProjectDir.topRepeatedUnits[0].sha256, /^[a-f0-9]{12}$/);
  assert.equal(report.scopes.claudeProjectDir.topRepeatedUnits[0].distinctSessions, 2);
  assert.deepEqual(report.scopes.claudeProjectDir.topRepeatedUnits[0].sourceSections, ['Constraints (history)']);
});
