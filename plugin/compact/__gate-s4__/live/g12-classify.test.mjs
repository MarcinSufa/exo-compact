import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCompactOutcome, isCompactBoundary } from './lib.mjs';

const headlessRefusal = '$.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on';

test('classifies the headless refusal', () => {
  assert.equal(classifyCompactOutcome({ status: 'rejected', message: headlessRefusal }), 'refused-headless');
});

test('classifies the prompt.submit in-turn refusal', () => {
  assert.equal(classifyCompactOutcome({ status: 'rejected', message: 'exo-compact: session.compact: a turn is running' }), 'in-turn');
});

test('classifies the hooks-worker in-turn refusal', () => {
  assert.equal(classifyCompactOutcome({ status: 'rejected', message: 'exo-compact: session.compact: this hook is holding' }), 'in-turn');
});

test('classifies a resolved compact call', () => {
  assert.equal(classifyCompactOutcome({ status: 'resolved' }), 'ok');
});

test('classifies an unrelated rejection', () => {
  assert.equal(classifyCompactOutcome({ status: 'rejected', message: 'unexpected compact error' }), 'other');
});

test('detects a system compact boundary frame', () => {
  assert.equal(isCompactBoundary({ type: 'system', subtype: 'compact_boundary' }), true);
});

test('rejects a compact_boundary type frame', () => {
  assert.equal(isCompactBoundary({ type: 'compact_boundary' }), false);
});

test('rejects a system init frame', () => {
  assert.equal(isCompactBoundary({ type: 'system', subtype: 'init' }), false);
});

test('rejects a result frame', () => {
  assert.equal(isCompactBoundary({ type: 'result' }), false);
});
