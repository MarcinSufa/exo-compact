import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byUnit, compareArms, gateTable, pareto } from './gate.mjs';

const rows = (arm, rewards, cost = 1) => rewards.map((reward, i) => ({ arm, split: i % 2 ? 'heldout' : 'dev', unit: `u${i}`, reward, cost }));

test('byUnit averages repeats of one unit', () => {
  const u = byUnit([{ unit: 'a', reward: 1, cost: 2 }, { unit: 'a', reward: 0, cost: 4 }, { unit: 'b', reward: 1, cost: 1 }]);
  assert.deepEqual(u.get('a'), { reward: 0.5, cost: 3, repeats: 2 });
  assert.throws(() => byUnit([{ unit: 'a', reward: NaN }]), /not a number/);
});

test('paired gate: a consistent gain beats one SE, noise ties, a loss is worse', () => {
  const base = rows('native', [0.5, 0.6, 0.4, 0.5, 0.7, 0.3]);
  const better = compareArms(base, rows('s4', [0.8, 0.9, 0.6, 0.8, 0.9, 0.6]));
  assert.equal(better.kind, 'paired'); assert.equal(better.n, 6); assert.equal(better.verdict, 'better');
  assert.ok(Math.abs(better.d - 0.2667) < 1e-3);
  const noisy = compareArms(base, rows('s4', [0.9, 0.2, 0.8, 0.1, 0.9, 0.3], 0.5));
  assert.equal(noisy.verdict, 'tie-cheaper');
  assert.equal(compareArms(base, rows('s4', [0.2, 0.3, 0.1, 0.2, 0.4, 0.0])).verdict, 'worse');
});

test('one shared unit has no SE; disjoint units fall back to combined SE', () => {
  assert.equal(compareArms(rows('a', [0.5]), rows('b', [1])).verdict, 'too-few-units');
  const base = [{ unit: 'x1', reward: 0 }, { unit: 'x2', reward: 0.2 }], cand = [{ unit: 'y1', reward: 1 }, { unit: 'y2', reward: 0.8 }];
  const g = compareArms(base, cand);
  assert.equal(g.kind, 'unpaired'); assert.equal(g.verdict, 'better');
  assert.equal(compareArms([], cand).verdict, 'no-data');
});

test('pareto keeps variants no other beats on both reward and cost', () => {
  const front = pareto([{ name: 'native', reward: 0.7, cost: 5 }, { name: 's4', reward: 0.9, cost: 4 }, { name: 'cheap', reward: 0.5, cost: 1 }, { name: 'bad', reward: 0.6, cost: 6 }]);
  assert.deepEqual(front.map((p) => p.name), ['s4', 'cheap']);
});

test('gateTable lists each candidate per split and over all units', () => {
  const t = gateTable([...rows('native', [0.5, 0.6, 0.4, 0.5]), ...rows('s4', [0.8, 0.9, 0.7, 0.8])], 'native');
  assert.match(t, /\| s4 \| native \| dev \| 2 \| \+30\.0 pp \|/);
  assert.match(t, /\| s4 \| native \| all \| 4 \| \+30\.0 pp \| 0\.0 \| better \|/);
});
