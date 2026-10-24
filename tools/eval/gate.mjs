// Decision rule for comparing two variants (arms) of the plugin, after the protocol in "Context Language Models"
// (Shao et al. 2026, arXiv:2609.37725, clm_icl): the unit is a task (or a cut), its reward is the mean over repeats,
// and the error is the paired standard error of the per-unit differences. A candidate wins when it beats the
// baseline by more than `z` standard errors, ties when within them (then the cheaper one is preferred), and loses
// otherwise. Tune on `dev`, then decide once on `heldout`: a decision taken on the units you tuned on is reported
// as such. Own implementation; no code from that repository (CC BY-NC).

const mean = (xs) => xs.reduce((t, x) => t + x, 0) / xs.length;
const sem = (xs) => {
  if (xs.length < 2) return Infinity;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((t, x) => t + (x - m) ** 2, 0) / (xs.length - 1) / xs.length);
};

/** Groups rows `{ unit, reward, cost }` by unit: mean reward and cost over repeats. */
export function byUnit(rows) {
  const units = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.reward)) throw new Error(`reward of ${r.unit} is not a number`);
    if (!units.has(r.unit)) units.set(r.unit, []);
    units.get(r.unit).push(r);
  }
  return new Map([...units].map(([u, rs]) => [u, { reward: mean(rs.map((r) => r.reward)), cost: mean(rs.map((r) => r.cost ?? 0)), repeats: rs.length }]));
}

/**
 * Compares candidate rows with baseline rows. Units present in both are paired; with no shared unit the two
 * standard errors are combined instead. Returns d (candidate minus baseline mean reward), se, the verdict and costs.
 */
export function compareArms(baseRows, candRows, { z = 1 } = {}) {
  const base = byUnit(baseRows), cand = byUnit(candRows);
  const shared = [...cand.keys()].filter((u) => base.has(u));
  let d, se, kind, n, costBase, costCand;
  if (shared.length) {
    const diffs = shared.map((u) => cand.get(u).reward - base.get(u).reward);
    d = mean(diffs); se = sem(diffs); kind = 'paired'; n = shared.length;
    costBase = mean(shared.map((u) => base.get(u).cost)); costCand = mean(shared.map((u) => cand.get(u).cost));
  } else {
    const b = [...base.values()].map((x) => x.reward), c = [...cand.values()].map((x) => x.reward);
    if (!b.length || !c.length) return { n: 0, d: NaN, se: NaN, kind: 'none', verdict: 'no-data', costBase: NaN, costCand: NaN };
    d = mean(c) - mean(b); se = Math.sqrt(sem(b) ** 2 + sem(c) ** 2); kind = 'unpaired'; n = Math.min(b.length, c.length);
    costBase = mean([...base.values()].map((x) => x.cost)); costCand = mean([...cand.values()].map((x) => x.cost));
  }
  let verdict;
  if (!Number.isFinite(se)) verdict = 'too-few-units';
  else if (d > z * se) verdict = 'better';
  else if (d < -z * se) verdict = 'worse';
  else verdict = costCand < costBase ? 'tie-cheaper' : 'tie';
  return { n, d, se, kind, verdict, costBase, costCand };
}

/** Variants `{ name, reward, cost }` that no other variant beats on both reward (higher) and cost (lower). */
export function pareto(points) {
  return points.filter((p) => !points.some((q) => q !== p && q.reward >= p.reward && q.cost <= p.cost && (q.reward > p.reward || q.cost < p.cost)));
}

/** Markdown table: every candidate arm against `baseline`, per split. `rows` are `{ arm, split, unit, reward, cost }`. */
export function gateTable(rows, baseline, { z = 1, costLabel = 'cost', costFormat = (x) => x.toFixed(3) } = {}) {
  const pct = (x) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)} pp`;
  const lines = [`| candidate | vs | split | units | d | SE | verdict (z=${z}) | ${costLabel} base → candidate |`, '|---|---|---|---|---|---|---|---|'];
  const splits = [...new Set(rows.map((r) => r.split))].sort();
  for (const arm of [...new Set(rows.map((r) => r.arm))].filter((a) => a !== baseline).sort()) {
    for (const split of [...splits, 'all']) {
      const pick = (a) => rows.filter((r) => r.arm === a && (split === 'all' || r.split === split));
      const g = compareArms(pick(baseline), pick(arm), { z });
      if (!g.n) continue;
      lines.push(`| ${arm} | ${baseline} | ${split} | ${g.n} | ${pct(g.d)} | ${Number.isFinite(g.se) ? (100 * g.se).toFixed(1) : '-'} | ${g.verdict} | ${costFormat(g.costBase)} → ${costFormat(g.costCand)} |`);
    }
  }
  return lines.join('\n');
}
