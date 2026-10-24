#!/usr/bin/env node
// Summarises replay arms written by eval-sessions.sh: coverage of later-used items for native and S4,
// overall and by session size at the cut (nativePreTokens), plus per-cut paired deltas against the
// first arm. Native numbers only count real native cuts (an S4 cut keeps 1 native token).
// Usage: node eval-summary.mjs <name>=<replay.json>... (the first arm is the reference)
import fs from 'node:fs';

const arms = process.argv.slice(2).map((arg) => { const i = arg.indexOf('='); return { name: arg.slice(0, i), rows: JSON.parse(fs.readFileSync(arg.slice(i + 1), 'utf8')).files }; });
if (!arms.length) throw new Error('Usage: node eval-summary.mjs <name>=<replay.json>...');
const key = (r) => `${r.file}#${r.boundary}`;
const BUCKETS = [['<150k', 0, 150_000], ['150-250k', 150_000, 250_000], ['250-400k', 250_000, 400_000], ['>400k', 400_000, Infinity]];
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '-');
const k = (n) => `${(n / 1000).toFixed(1)}k`;

function table(rows, label) {
  const native = rows.filter((r) => r.nativeFullTokens > 1 && r.needed > 0);
  const s4cuts = rows.filter((r) => r.nativeFullTokens <= 1 && r.needed > 0);
  const sum = (xs, f) => xs.reduce((n, r) => n + f(r), 0);
  const need = sum(native, (r) => r.needed);
  return `${label}: native cuts ${native.length} | native ${pct(sum(native, (r) => r.coverage.nativeFull), need)} @${native.length ? k(sum(native, (r) => r.nativeFullTokens) / native.length) : '-'} | S4 ${pct(sum(native, (r) => r.coverage.s4Full), need)} @${native.length ? k(sum(native, (r) => r.s4FullTokens) / native.length) : '-'}`
    + (native.some((r) => r.coverage.s4FullRecall > r.coverage.s4Full || r.coverage.c > 0) ? ` | recall alone ${pct(sum(native, (r) => r.coverage.c), need)} | S4+recall ${pct(sum(native, (r) => r.coverage.s4FullRecall), need)} | native+recall ${pct(sum(native, (r) => r.coverage.nativeFullRecall), need)}` : '')
    + (s4cuts.length ? ` | S4-only cuts ${s4cuts.length}: S4 ${pct(sum(s4cuts, (r) => r.coverage.s4Full), sum(s4cuts, (r) => r.needed))}` : '');
}

const lines = [];
for (const arm of arms) {
  lines.push(`## ${arm.name}`, table(arm.rows, 'all'));
  for (const [label, lo, hi] of BUCKETS) {
    const rows = arm.rows.filter((r) => (r.nativePreTokens ?? 0) >= lo && (r.nativePreTokens ?? 0) < hi);
    if (rows.length) lines.push(table(rows, `  ${label}`));
  }
}
const [ref, ...rest] = arms;
const refByKey = new Map(ref.rows.filter((r) => r.needed > 0).map((r) => [key(r), r]));
for (const arm of rest) {
  const deltas = arm.rows.filter((r) => refByKey.has(key(r))).map((r) => ({ d: r.coverage.s4Full - refByKey.get(key(r)).coverage.s4Full, pre: r.nativePreTokens ?? 0 }));
  const better = deltas.filter((x) => x.d > 0).length, worse = deltas.filter((x) => x.d < 0).length;
  lines.push(`paired ${ref.name} -> ${arm.name}: S4 items ${deltas.reduce((n, x) => n + x.d, 0) >= 0 ? '+' : ''}${deltas.reduce((n, x) => n + x.d, 0)}, cuts better ${better}, worse ${worse}, same ${deltas.length - better - worse}`);
  for (const [label, lo, hi] of BUCKETS) {
    const b = deltas.filter((x) => x.pre >= lo && x.pre < hi);
    if (b.length) lines.push(`  ${label}: ${b.reduce((n, x) => n + x.d, 0)} items over ${b.length} cuts (better ${b.filter((x) => x.d > 0).length}, worse ${b.filter((x) => x.d < 0).length})`);
  }
}
console.log(lines.join('\n'));
