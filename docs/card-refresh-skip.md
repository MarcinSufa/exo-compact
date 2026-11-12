# Task-card refresh skip analysis

Run date: 2026-11-12 UTC. The default window starts 2026-10-01 and runs through the analysis time. The analyzer reads local notices and transcripts only; it makes no API calls. Re-run with **node tools/real-replay/card-unchanged.mjs --json** or pass **--root**, **--capture**, **--since**, and **--until**. The JSON output was written to **/tmp/exo-compact-cardsame-run3.json**.

## Recovered versions and seed shrink

The transcript search found 12 refresh prompts and one fork reply. The reply mapped to a refresh, but no session had two adjacent fork replies. Seed task-card sections after compact boundaries therefore supplied the 124 selected recovered cards. There were 616 written refreshes in 134 sessions, with 124 recovered versions (20.1%) across 21 sessions. The recovered versions formed 55 adjacent pairs. Six notice files were at the 1,500-line cap, so recovered history is incomplete.

The seed budget fallback calls `renderCardSection(...)` with the reduced card budget at `plugin/compact/compact.ts:1340` and emits `seed.task_card_shrunk` at `plugin/compact/compact.ts:1342`. The `capCard` implementation keeps section headings and inserts line-count markers when it trims or removes section text at `plugin/compact/core/task-card.ts:164`. The analyzer treats parenthesized `more lines` and `left out: N lines` lines, plus a matched shrink or drop notice, as a shrink marker. A size notice alone does not mark a card as shrunk.

| Recovered seed-card status | Count |
|---|---:|
| Cards marked shrunk | 91/124 (73.4%) |
| Cards with an in-card section marker | 91/124 |
| Cards with a matched `seed.task_card_shrunk` notice | 50/124 |
| Cards with a matched drop notice | 0/124 |
| Pairs with either card shrunk | 49/55 (89.1%) |
| Pairs with both cards shrunk | 31/55 (56.4%) |
| Pairs with neither card shrunk | 6/55 (10.9%) |

The in-card marker and notice counts overlap. Every notice-marked card also had a section marker in this sample.

## Corrected change shares

The full-card comparison across all recovered pairs has n=55, median change share 76.7%, and IQR 70.0%-80.6%. All 55 pairs were above the 20% threshold. Excluding any pair where either version was marked shrunk leaves six unshrunk pairs: median 79.1%, IQR 75.9%-80.3%. Both estimates compare cards across cuts; the unshrunk subset is too small to generalize.

| Comparison basis | n | Median change share | IQR (Q1-Q3) | Exact identity | At most 10% changed | At most 20% changed |
|---|---:|---:|---:|---:|---:|---:|
| All recovered pairs | 55 | 76.7% | 70.0%-80.6% | 0 pairs, 0 eq | 0 pairs, 0 eq | 0 pairs, 0 eq |
| Unshrunk pairs only | 6 | 79.1% | 75.9%-80.3% | 0 pairs, 0 eq | 0 pairs, 0 eq | 0 pairs, 0 eq |

For the section comparison, the analyzer removes omission-marker lines and compares the common kept prefix: the first `min(kept lines in version A, kept lines in version B)` nonblank lines. A section with no kept body lines in either version is omitted from that section's n. Single-line share is the fraction of compared pairs with exactly one common kept line. First-line character similarity is normalized Levenshtein similarity on whitespace-normalized first kept lines, using Unicode code points and `1 - edit distance / longer line length`. Section-level matches do not establish that an entire card can be skipped.

Distribution cells show median (IQR; Q1-Q3); character-similarity IQR is in percentage points.

| Section | n | Change share median (IQR) | Common kept lines per pair median (IQR) | Single-line comparisons (pairs, share) | First-line similarity (n, median, IQR) | Count at least 0.9 |
|---|---:|---:|---:|---:|---:|---:|
| Goal | 55 | 100.0% (0.0 pp; 100.0%-100.0%) | 1 (0; 1-1) | 49/55 (89.1%) | 55; 30.8% (39.8 pp; 22.6%-62.5%) | 5 |
| Rules | 55 | 100.0% (20.2 pp; 79.8%-100.0%) | 6 (6.5; 4-10.5) | 9/55 (16.4%) | 55; 75.1% (71.9 pp; 27.4%-99.3%) | 18 |
| Decisions | 55 | 100.0% (0.0 pp; 100.0%-100.0%) | 4 (3; 2-5) | 10/55 (18.2%) | 55; 21.5% (28.7 pp; 18.0%-46.7%) | 7 |
| Done | 54 | 100.0% (0.0 pp; 100.0%-100.0%) | 4 (2; 2-4) | 11/54 (20.4%) | 54; 18.6% (6.4 pp; 16.0%-22.4%) | 0 |
| Acceptance checks | 53 | 100.0% (0.0 pp; 100.0%-100.0%) | 3 (2; 2-4) | 13/53 (24.5%) | 53; 22.1% (21.1 pp; 18.9%-40.0%) | 6 |
| Next step | 55 | 100.0% (0.0 pp; 100.0%-100.0%) | 1 (2; 1-3) | 36/55 (65.5%) | 55; 17.7% (6.6 pp; 14.3%-20.8%) | 0 |

For sections with a median of one common kept line, the per-section change shares are a binary first-line comparison and cannot measure near-identical cards.

| Section | Exact retained text | At most 10% changed | At most 20% changed |
|---|---:|---:|---:|
| Goal | 1 pair, 31,723.5 eq | 1 pair, 31,723.5 eq | 1 pair, 31,723.5 eq |
| Rules | 5 pairs, 143,323.5 eq | 5 pairs, 143,323.5 eq | 5 pairs, 143,323.5 eq |
| Decisions | 4 pairs, 116,402.8 eq | 4 pairs, 116,402.8 eq | 4 pairs, 116,402.8 eq |
| Done | 0 pairs, 0 eq | 0 pairs, 0 eq | 0 pairs, 0 eq |
| Acceptance checks | 5 pairs, 141,078.4 eq | 5 pairs, 141,078.4 eq | 5 pairs, 141,078.4 eq |
| Next step | 0 pairs, 0 eq | 0 pairs, 0 eq | 0 pairs, 0 eq |

The equivalents in section rows are the estimated cost of the next refresh attached to those pairs, using the same `0.1 x context + 5 x written-card size` formula. They are not measured savings and cannot justify skipping a whole-card refresh based on one section.

## Refreshes per cut stretch and sample coverage

A recovered seed card represents the latest refresh written before its cut. Thus a pair of adjacent recovered seed versions compares cards on opposite sides of a cut. It does not compare successive refreshes within a stretch that has multiple refreshes before its next cut. The 55 pairs cannot speak for those multi-refresh stretches.

Using the successful refresh rows from **tools/real-replay/card-refresh-rate.mjs**, the capture contains n=480 observed cut stretches, including nonempty open tails after the last recorded cut. Refreshes per stretch have median 1 and IQR 1-1. Of those stretches, 87/480 (18.1%) contain at least two refreshes. Those are the stretches where an within-stretch skip might save a refresh.

The multi-refresh stretches contain 227/616 refreshes (36.9%) and 6,618,049.8 estimated equivalents (38.0% of the 17,414,239.7 equivalents in all scoped rows). The observation window is 42.17 days, with 14.61 refreshes per day and 140 within-stretch adjacent refresh pairs, or 3.32 such pairs per day. At that observed rate, 100 within-stretch pairs would take about 30.1 days of normal use.

Notice cuts matched main-transcript boundaries for 507 of 616 refreshes. The call count from a refresh write to the next matched cut had median 47 and IQR 34-61. One of 507 refreshes was within one assistant call, 6/507 (1.2%) within three, and 10/507 (2.0%) within five. The remaining 109 had no following matched cut in the selected window.

## Other predictor results

These results are exploratory labels on all 55 recovered pairs, which compare cards across cuts. They are not evidence about the intermediate refreshes in multi-refresh stretches.

| Predictor | TP / FP / FN / TN | Precision | Recall | n | Predicted skip equivalents | Changed cards skipped |
|---|---:|---:|---:|---:|---:|---:|
| No new real user message | 0 / 5 / 0 / 50 | 0% | n/a | 55 | 144,863.1 | 5 |
| No Edit/Write/MultiEdit/NotebookEdit | 0 / 7 / 0 / 48 | 0% | n/a | 55 | 195,999.3 | 7 |
| No git commit in Bash | 0 / 17 / 0 / 38 | 0% | n/a | 55 | 484,324.3 | 17 |
| Fewer than 10 tool results | 0 / 0 / 0 / 55 | n/a | n/a | 55 | 0 | 0 |

## Options and recommendation

- **A. Skip using a predictor.** The predictors are only labeled on the cross-cut sample. Do not use those results to skip intermediate refreshes.
- **B. Run the fork, then skip an identical write.** No exact identity appeared across all 55 recovered pairs or among the six unshrunk pairs. This does not test within-stretch identity.
- **C. Coalesce near a cut.** Only 6/507 matched refreshes were within three assistant calls of the next cut and 10/507 within five.
- **D. Make no skip change yet.** The unshrunk pair set has n=6 with zero exact or threshold-qualified pairs. That small sample neither shows nor rules out savings within multi-refresh stretches.
- **E. Record card history in capture.** Keep the previous card text, or a per-section hash and size, next to `task-card.md` on each refresh. This needs a plugin change and release, a retention period, and a decision about keeping plaintext snapshots. The current `task-card.md` already stores card text as plaintext on disk. At the observed within-stretch pair rate, about 30.1 days of normal use would produce 100 such pairs.

Recommendation: **E as a measurement step, then reassess skipping with within-stretch evidence.** The seed-derived history is too shrunk to answer #9: 49/55 pairs (89.1%) include at least one shrunk card, leaving only six unshrunk pairs. Goal and Next step each have a median of one common kept line, so their 100% median change shares are binary first-line comparisons; the character-similarity results above distinguish rewording from substantially different first-line content but cannot restore the missing history. The data neither show nor rule out savings within multi-refresh stretches. Keep the near-cut coalescing numbers separate from that unanswered question.

## Named mutant checks

The four named tests were each run against a mutant that broke the behavior, then rerun against the restored implementation.

| Test | Mutant | Mutant result | Restored result |
|---|---|---|---|
| M1 shrink-marker detection | Ignore in-card shrink markers | Red, failed | Green, passed |
| M2 common-kept section diff | Compare all section lines instead of the common kept prefix | Red, failed | Green, passed |
| M3 refreshes per cut stretch | Do not reset the stretch at a cut | Red, failed | Green, passed |
| M4 first-line character similarity | Collapse nonidentical first lines to 0 similarity and identical lines to 1 | Red, failed | Green, passed |
