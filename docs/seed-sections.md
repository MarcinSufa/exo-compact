# Seed section measurement for issue #6

This measurement estimates how much of an exo-compact seed could move behind disk pointers, and how often the following turns show exact textual matches to that material. It uses transcript data available on this host as of 2026-11-12. The analyzer reads `~/.claude/projects/**/*.jsonl`, including `subagents` directories. It does not write to `~/.claude`, `~/.exovault`, or project `.exovault` directories.

## Seed and section recognition

A plugin cut is a `system` event with subtype `compact_boundary`, followed by injected user summary text containing `[[exovault:s4-seed:v1]]`, matching the existing `postcut.mjs` recognition. The seed builder defines this first-line sentinel in [sentinel.ts](../plugin/compact/core/sentinel.ts:8), and the surrounding session-memory markers in [seed.ts](../plugin/compact/core/seed.ts:101). `compact.ts` builds the seed sections and calls `renderSeed` at [compact.ts](../plugin/compact/compact.ts:1280). The returned message list puts the rendered seed first and the retained tail after it at [compact.ts](../plugin/compact/compact.ts:1400). Native summaries without the plugin sentinel are excluded; the replay parser recognizes native compact summaries by their `isCompactSummary` flag in [transcript-parser.mjs](../tools/real-replay/transcript-parser.mjs:43).

The builder's section headings are in [seed.ts](../plugin/compact/core/seed.ts:133) and [seed.ts](../plugin/compact/core/seed.ts:167). The analyzer defines two mappings in [seed-sections.mjs](../tools/real-replay/seed-sections.mjs). The primary mapping treats the existing reference sections as disk candidates. The conservative mapping treats `Since the card`, `Work state`, and `Gates and errors` as skeleton because each can contain current state. All other labels match between the mappings. An unlisted heading defaults to `disk_candidate` in both mappings.

Two headings found in 13 older plugin seeds, `History (verbatim user records)` and `Reasoning`, are not emitted by the checked-in builder. They are explicitly mapped as disk candidates because they are older user records and assistant notes. `Recent tail` is a measurement-only row, not a seed heading: it represents the retained messages placed after the seed and is skeleton under both mappings.

## Method

- JSONL parsing is shared with `real-replay.mjs` and `postcut.mjs` through [transcript-parser.mjs](../tools/real-replay/transcript-parser.mjs). Each boundary is paired with the first injected user message using the same short injection window as `postcut.mjs`.
- Section tokens use `estimateTokens` from [budgets.ts](../plugin/compact/core/budgets.ts:99), the density-aware estimator used by the plugin. A section count includes its heading. Retained-tail tokens use `serializedTokens` with the same estimator.
- Percentiles use R-7 linear interpolation over sorted per-cut values. Section `n` counts cuts where that section was present. Skeleton share is the estimator count of the framed seed after disk-candidate sections are removed, divided by the original seed count. The seed frame and pointers stay in the numerator. The recent tail is outside the seed-share denominator.
- The primary mapping keeps rules and current task context hot: compaction pressure, constraints, contract, todo, task brief, task card, current values, next step, and the small transcript, file, and ID pointers. It classifies `Since the card`, `Work state`, and `Gates and errors` as disk candidates. The conservative mapping moves those three headings to skeleton. Both mappings classify older notes, work state or history references, recipes, session maps, excerpts, values, and reasoning as disk candidates, except for the three conservative overrides.
- The projected reduction removes each disk-candidate section and inserts one fixed 35-token stub per cut that has at least one candidate: `## Archived context\nAdditional notes, maps, and excerpts are stored on disk. Use search_session or read a section pointer to retrieve them.` Net saved tokens is the full seed estimate minus the projected seed estimate with that stub. Cuts with no disk-candidate sections save zero apart from any framing estimate difference.
- For each cut, the post-cut context denominator is the first unique non-synthetic assistant message after the same 2-second injection cutoff used by `postcut.mjs`: `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. Context-share percentiles include cuts whose first assistant usage provides a positive denominator. Seven of 675 cuts did not have usage available.
- The post-cut window contains the next 20 unique assistant message IDs after the seed injection cutoff, stopping earlier at the next compact boundary or transcript end. Search calls are tool names ending in `search_session`. File reads count `Read`, `NotebookRead`, `read` or `read_file` tools and recognized Bash `cat`, `head`, `tail`, `sed -n`, `less`, or `wc -l` commands.
- For disk-candidate use, the analyzer looks for case-sensitive exact sequences of five whitespace-delimited tokens. Whitespace is normalized; token spelling and punctuation remain exact. A sequence must occur once across the seed and not occur in the retained tail. It is matched in assistant text blocks and serialized tool inputs. The n-gram rate is the share of cuts with at least one matching assistant call.

## Results

The scan found **675 plugin cuts across 119 sessions** in **2,964 transcript files**, including subagent transcripts. There were 1,124 compact boundaries; 449 native summaries marked with `isCompactSummary` and no other no-seed boundaries were excluded. Seven plugin-cut windows ended before any assistant call or first post-cut usage was available.

Token counts are estimated, not tokenizer API counts. The per-section `n` column is the number of cuts containing that section. The primary and conservative labels are shown together.

| Section | Primary | Conservative | n | Median | p25 | p75 | p90 | Max |
|---|---|---|---:|---:|---:|---:|---:|---:|
| Constraints (history) | skeleton | skeleton | 484 | 559 | 201 | 1,342 | 1,998 | 2,176 |
| Task card | skeleton | skeleton | 559 | 2,217 | 1,237 | 2,422 | 2,469 | 2,505 |
| Since the card | disk_candidate | skeleton | 373 | 453 | 390 | 481 | 500 | 509 |
| Work state | disk_candidate | skeleton | 607 | 497 | 428 | 563 | 626 | 818 |
| Recipes | disk_candidate | disk_candidate | 257 | 382 | 352 | 411 | 424 | 437 |
| Working notes | disk_candidate | disk_candidate | 232 | 997 | 449 | 2,734 | 7,397 | 18,106 |
| Transcript | skeleton | skeleton | 664 | 231 | 229 | 242 | 257 | 280 |
| IDs | skeleton | skeleton | 274 | 37 | 36 | 63 | 107 | 323 |
| Session map | disk_candidate | disk_candidate | 467 | 902 | 550 | 926 | 940 | 944 |
| Earlier user messages | disk_candidate | disk_candidate | 460 | 142 | 60 | 300 | 516 | 1,613 |
| Gates and errors | disk_candidate | skeleton | 178 | 128 | 17 | 216 | 318 | 472 |
| File pointers | skeleton | skeleton | 150 | 126 | 56 | 263 | 566 | 771 |
| Current values | skeleton | skeleton | 88 | 32 | 30 | 37 | 37 | 67 |
| Task brief | skeleton | skeleton | 323 | 593 | 491 | 593 | 713 | 5,191 |
| Key facts, older heading | disk_candidate | disk_candidate | 13 | 2,900 | 2,891 | 2,902 | 2,902 | 2,902 |
| Contract, older heading | skeleton | skeleton | 13 | 9 | 9 | 9 | 9 | 9 |
| Todo, older heading | skeleton | skeleton | 13 | 7 | 7 | 7 | 7 | 7 |
| History (verbatim user records), older heading | disk_candidate | disk_candidate | 13 | 7,853 | 7,668 | 8,029 | 8,040 | 8,047 |
| Values, older heading | disk_candidate | disk_candidate | 13 | 8 | 8 | 8 | 8 | 8 |
| Reasoning, older heading | disk_candidate | disk_candidate | 13 | 10 | 10 | 10 | 10 | 10 |
| Compaction pressure | skeleton | skeleton | 21 | 90 | 56 | 90 | 90 | 90 |
| Recent tail, outside seed | skeleton | skeleton | 675 | 1,343 | 555 | 2,128 | 4,811 | 35,304 |

The mapping sensitivity and first post-cut context results are:

| Measure | Primary mapping | Conservative mapping |
|---|---:|---:|
| Skeleton share of seed | 63.0% median, p25 52.8%, p75 70.1%, p90 75.5%, max 94.1% | 78.4% median, p25 69.9%, p75 83.8%, p90 88.3%, max 98.4% |
| Net saved tokens per cut | median 2,015, p25 1,575, p75 2,722, p90 6,257, max 21,722 | median 1,141, p25 842, p75 1,768, p90 5,536, max 20,892 |
| Net saved as share of first post-cut context, n=668 | median 4.5%, p25 3.3%, p75 6.3%, p90 12.9% | median 2.5%, p25 1.8%, p75 4.1%, p90 11.8% |
| N-gram match rate | 168/675 cuts, 24.9% | 91/675 cuts, 13.5% |

| Post-cut measure | Cuts with one or more | Rate | Count per cut: median, p25, p75, p90, max |
|---|---:|---:|---|
| `search_session` calls | 381/675 | 56.4% | 1, 0, 2, 4, 10 |
| File reads | 647/675 | 95.9% | 8, 5, 12, 16, 45 |

The n-gram rate is an upper-bound proxy for exact textual matches that could have prompted retrieval. It may count quoted or coincidental text. The data do not show that any matched section was necessary.

## What this means for #6

The original mapping leaves a median 2,015 estimated tokens per cut after the stub. The conservative mapping, which keeps `Since the card`, `Work state`, and `Gates and errors` hot, leaves a median 1,141. This reduces the median seed share available to move from 37.0% to 21.6%. The median net saving is 4.5% of the first post-cut context under the primary mapping and 2.5% under the conservative mapping.

Both mappings still show a material reduction opportunity, mainly in working notes, session maps, older excerpts, and earlier user messages. The primary mapping's n-gram rate is 24.9%; it falls to 13.5% with the conservative mapping. These rates are lexical proxies only. Keep current task state hot and measure actual section fetches in a disk-backed prototype before broad removal.

## What the data cannot answer

- These transcripts predate disk-backed seed sections. Search and read calls are observed behavior, not retrievals of the proposed archived sections.
- The n-gram method cannot determine whether a match affected the answer. It may overcount irrelevant quotation and coincidental repetition, and it misses paraphrases.
- The file-read detector does not recognize every possible shell command or tool that can read a file.
- Windows that reached transcript end or another cut before 20 assistant calls are shorter. Seven cuts had no assistant call or first post-cut usage available.
- The recent-tail size uses transcript entries within the same two-second injection window as `postcut.mjs`. An unusual timestamp order can place an entry in the wrong group.
- Historical `History (verbatim user records)` and `Reasoning` headings are present in older plugin seed messages but absent from the current checked-in builder, so the current source cannot identify their original rendering options.
- This report does not inspect stored capture payloads under `~/.exovault` or project `.exovault` directories. It measures seed size and transcript-visible post-cut behavior, not whether a specific archived section exists as a retrievable capture.
