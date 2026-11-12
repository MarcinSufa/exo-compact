# Recall when needed: real transcript measurement

Scanned 2972 JSONL files under ~/.claude/projects, including subagent transcripts; found 1131 compact boundaries across 127 distinct sessions. Recognized 681 plugin cuts and 450 native-summary cuts; 0 boundaries had neither selected seed form.
The scan ran on 2026-11-12. Transcripts were read only; it made no model calls or network requests. Aggregate JSON is `/tmp/exo-compact-recalluse/run2.json` and stores hashed session keys and counts, not item values or transcript text.
The need window is the first 20 unique assistant calls after the two-second injection grace, ending at the next compact boundary. Items and classes follow the definitions in the JSON method record.
The plugin and native arms differ in more than the seed: search_session availability, session kinds, and dates also differ. The comparison is descriptive, not causal.

## Definitions and implementation

The analyzer reuses transcript parsing, plugin-seed/native-summary recognition, the two-second injection window, retained-tail handling, and assistant-call grouping from `tools/real-replay/seed-sections.mjs`.
A need is one distinct eligible item per cut. It appears before the boundary, is absent from the injected seed or summary and retained tail, and is used exactly in assistant text or a serialized assistant tool input in the 20-call window. Only its first assistant use in that window counts.

| Item rule | Exact extraction rule |
|---|---|
| Path | POSIX absolute or relative path token, including basename-only tokens, with one of 51 extensions. URLs are removed before matching. |
| SHA | 7 to 40 hexadecimal characters with token boundaries and at least one a-f letter. All-digit tokens are not counted as SHAs. |
| UUID | Whole hexadecimal `8-4-4-4-12` UUID-shaped token, kept whole so its groups are not counted as SHAs. |
| `#digits` | A `#` followed by one or more digits, including `#7`; the hash distinguishes the token from an ordinary number. |
| Job ID | `jobq` followed by `-`, `_`, or `:` and an identifier token, plus numeric `job-<digits>` background IDs. |

Strict recall requires the exact item in a `search_session` query or its paired result; an item in the query counts at the call. Loose recall counts any `search_session` call before first use, even if the query and result omit the item. Rederive requires an item-bearing `Grep`/`Glob` or Bash `grep`/`find`/`ls`/`git log` result, or a `Read`, `NotebookRead`, or `read_file` that reads or returns the item. User means a non-summary human message after the cut contains the item. None means no qualifying visible source appears before first use. The earliest source by event order wins; same-event ties go recall, rederive, then user. Strict and loose are independent.
The global class share is class needs divided by all needs in that arm. Per-session shares divide each class count by the session's needs; the reported spreads use R-7 linear interpolation.

## Tool availability and cut context

| Arm | All cuts | search_session available | Unavailable | system/init list | plugin seed names tool | pre-boundary call | no evidence | Session kinds | Boundary date range |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| plugin | 681 | 612 | 69 | 0 | 612 | 0 | 69 | main: 670, subagent: 11 | 2026-09-28 to 2026-11-12 |
| native | 450 | 144 | 306 | 0 | 0 | 144 | 306 | main: 177, subagent: 273 | 2026-09-27 to 2026-11-12 |

Each JSON cut record includes `searchSessionAvailable` and `searchSessionAvailabilityEvidence`. The evidence order is: the first system/init tool list (including explicit absence), the injected plugin seed naming `search_session`, then a `search_session` tool_use strictly before that cut boundary. Cuts with none of these are unavailable. The old session-wide tool-use proxy appears only in the sensitivity table below.
Rule 3 still correlates with session habits: a model that searched before is likelier to search again, so available-only shares remain an upper-leaning estimate.

## All recognized cuts

| Arm | n cuts | n needs | Cuts with at least one need | Sessions with at least 3 needs |
|---|---:|---:|---:|---:|
| plugin | 681 | 7960 | 633 (93.0%) | 83 |
| native | 450 | 4238 | 411 (91.3%) | 29 |

Each cell gives global share of needs, then the per-session share median and p25/p75 across sessions with at least one need. The final field repeats the spread only for sessions with at least three needs.

| Arm | Recall rule | Class | Needs / share | Per-session share | Sessions with 3+ needs: per-session share |
|---|---|---|---:|---|---|
| plugin | strict | recall | 636 / 8.0% | median 0.0%, p25 0.0%, p75 9.2% (n=96) | median 0.0%, p25 0.0%, p75 11.2% (n=83) |
| plugin | strict | rederive | 3824 / 48.0% | median 47.8%, p25 34.8%, p75 64.0% (n=96) | median 45.8%, p25 35.0%, p75 64.1% (n=83) |
| plugin | strict | user | 28 / 0.4% | median 0.0%, p25 0.0%, p75 0.0% (n=96) | median 0.0%, p25 0.0%, p75 0.0% (n=83) |
| plugin | strict | none | 3472 / 43.6% | median 44.4%, p25 33.3%, p75 55.4% (n=96) | median 43.5%, p25 33.3%, p75 54.5% (n=83) |
| plugin | loose | recall | 3399 / 42.7% | median 21.1%, p25 0.0%, p75 52.6% (n=96) | median 31.8%, p25 0.0%, p75 54.1% (n=83) |
| plugin | loose | rederive | 2500 / 31.4% | median 33.3%, p25 18.7%, p75 53.2% (n=96) | median 33.2%, p25 20.0%, p75 53.4% (n=83) |
| plugin | loose | user | 24 / 0.3% | median 0.0%, p25 0.0%, p75 0.0% (n=96) | median 0.0%, p25 0.0%, p75 0.0% (n=83) |
| plugin | loose | none | 2037 / 25.6% | median 26.0%, p25 14.9%, p75 45.8% (n=96) | median 25.9%, p25 17.3%, p75 36.5% (n=83) |
| native | strict | recall | 49 / 1.2% | median 0.0%, p25 0.0%, p75 1.0% (n=32) | median 0.0%, p25 0.0%, p75 1.8% (n=29) |
| native | strict | rederive | 1710 / 40.3% | median 40.0%, p25 20.7%, p75 50.0% (n=32) | median 40.0%, p25 26.8%, p75 50.0% (n=29) |
| native | strict | user | 14 / 0.3% | median 0.0%, p25 0.0%, p75 0.0% (n=32) | median 0.0%, p25 0.0%, p75 0.0% (n=29) |
| native | strict | none | 2465 / 58.2% | median 58.2%, p25 50.0%, p75 69.7% (n=32) | median 58.1%, p25 50.0%, p75 66.1% (n=29) |
| native | loose | recall | 306 / 7.2% | median 0.0%, p25 0.0%, p75 6.0% (n=32) | median 0.0%, p25 0.0%, p75 7.6% (n=29) |
| native | loose | rederive | 1625 / 38.3% | median 37.2%, p25 18.9%, p75 50.0% (n=32) | median 38.0%, p25 26.8%, p75 50.0% (n=29) |
| native | loose | user | 14 / 0.3% | median 0.0%, p25 0.0%, p75 0.0% (n=32) | median 0.0%, p25 0.0%, p75 0.0% (n=29) |
| native | loose | none | 2293 / 54.1% | median 54.3%, p25 45.1%, p75 63.8% (n=32) | median 54.1%, p25 42.1%, p75 58.2% (n=29) |

## Only cuts with search_session available

| Arm | n cuts | n needs | Cuts with at least one need | Sessions with at least 3 needs |
|---|---:|---:|---:|---:|
| plugin | 612 | 7627 | 598 (97.7%) | 82 |
| native | 144 | 1918 | 141 (97.9%) | 17 |

Each cell gives global share of needs, then the per-session share median and p25/p75 across sessions with at least one need. The final field repeats the spread only for sessions with at least three needs.

| Arm | Recall rule | Class | Needs / share | Per-session share | Sessions with 3+ needs: per-session share |
|---|---|---|---:|---|---|
| plugin | strict | recall | 636 / 8.3% | median 0.0%, p25 0.0%, p75 9.7% (n=94) | median 0.0%, p25 0.0%, p75 11.3% (n=82) |
| plugin | strict | rederive | 3672 / 48.1% | median 47.8%, p25 35.0%, p75 63.5% (n=94) | median 46.6%, p25 35.8%, p75 64.2% (n=82) |
| plugin | strict | user | 23 / 0.3% | median 0.0%, p25 0.0%, p75 0.0% (n=94) | median 0.0%, p25 0.0%, p75 0.0% (n=82) |
| plugin | strict | none | 3296 / 43.2% | median 44.4%, p25 33.5%, p75 55.2% (n=94) | median 43.5%, p25 33.3%, p75 53.9% (n=82) |
| plugin | loose | recall | 3399 / 44.6% | median 23.3%, p25 0.0%, p75 53.7% (n=94) | median 32.4%, p25 0.0%, p75 54.3% (n=82) |
| plugin | loose | rederive | 2348 / 30.8% | median 31.8%, p25 18.5%, p75 52.7% (n=94) | median 31.8%, p25 20.0%, p75 53.6% (n=82) |
| plugin | loose | user | 19 / 0.2% | median 0.0%, p25 0.0%, p75 0.0% (n=94) | median 0.0%, p25 0.0%, p75 0.0% (n=82) |
| plugin | loose | none | 1861 / 24.4% | median 26.0%, p25 15.5%, p75 43.9% (n=94) | median 25.5%, p25 17.1%, p75 36.0% (n=82) |
| native | strict | recall | 49 / 2.6% | median 1.6%, p25 0.0%, p75 4.5% (n=17) | median 1.6%, p25 0.0%, p75 4.5% (n=17) |
| native | strict | rederive | 658 / 34.3% | median 36.4%, p25 18.2%, p75 40.0% (n=17) | median 36.4%, p25 18.2%, p75 40.0% (n=17) |
| native | strict | user | 6 / 0.3% | median 0.0%, p25 0.0%, p75 0.1% (n=17) | median 0.0%, p25 0.0%, p75 0.1% (n=17) |
| native | strict | none | 1205 / 62.8% | median 59.8%, p25 57.0%, p75 77.3% (n=17) | median 59.8%, p25 57.0%, p75 77.3% (n=17) |
| native | loose | recall | 295 / 15.4% | median 5.5%, p25 0.0%, p75 41.7% (n=17) | median 5.5%, p25 0.0%, p75 41.7% (n=17) |
| native | loose | rederive | 577 / 30.1% | median 32.1%, p25 13.5%, p75 40.0% (n=17) | median 32.1%, p25 13.5%, p75 40.0% (n=17) |
| native | loose | user | 6 / 0.3% | median 0.0%, p25 0.0%, p75 0.1% (n=17) | median 0.0%, p25 0.0%, p75 0.1% (n=17) |
| native | loose | none | 1040 / 54.2% | median 54.5%, p25 40.4%, p75 58.2% (n=17) | median 54.5%, p25 40.4%, p75 58.2% (n=17) |

## Old session-wide proxy sensitivity

These rows reapply the round 2 filter, which marked a cut available if any `search_session` call appeared anywhere in its transcript. Changes are old-proxy recall share minus the all-cuts share, showing the uplift from the outcome-correlated filter.

| Arm | Cuts selected | Needs | Strict recall under old proxy | Change vs all cuts | Loose recall under old proxy | Change vs all cuts |
|---|---:|---:|---:|---:|---:|---:|
| plugin | 547 | 7256 | 636 / 8.8% | +0.78 pp | 3399 / 46.8% | +4.14 pp |
| native | 188 | 2338 | 49 / 2.1% | +0.94 pp | 306 / 13.1% | +5.87 pp |

## Plugin item rules, available sessions only

Each need is counted once under its extraction rule. `Needs / share of all` uses all available plugin needs as the denominator; class shares use the needs for that item rule as the denominator.

| Recall rule | Item rule | Needs / share of all | Class | Class needs / share within item rule |
|---|---|---:|---|---:|
| strict | path | 6893 / 90.4% | recall | 566 / 8.2% |
| strict | path | 6893 / 90.4% | rederive | 3361 / 48.8% |
| strict | path | 6893 / 90.4% | user | 17 / 0.2% |
| strict | path | 6893 / 90.4% | none | 2949 / 42.8% |
| strict | sha | 330 / 4.3% | recall | 39 / 11.8% |
| strict | sha | 330 / 4.3% | rederive | 189 / 57.3% |
| strict | sha | 330 / 4.3% | user | 2 / 0.6% |
| strict | sha | 330 / 4.3% | none | 100 / 30.3% |
| strict | uuid | 24 / 0.3% | recall | 5 / 20.8% |
| strict | uuid | 24 / 0.3% | rederive | 8 / 33.3% |
| strict | uuid | 24 / 0.3% | user | 0 / 0.0% |
| strict | uuid | 24 / 0.3% | none | 11 / 45.8% |
| strict | #digits | 377 / 4.9% | recall | 26 / 6.9% |
| strict | #digits | 377 / 4.9% | rederive | 111 / 29.4% |
| strict | #digits | 377 / 4.9% | user | 4 / 1.1% |
| strict | #digits | 377 / 4.9% | none | 236 / 62.6% |
| strict | job id | 3 / 0.0% | recall | 0 / 0.0% |
| strict | job id | 3 / 0.0% | rederive | 3 / 100.0% |
| strict | job id | 3 / 0.0% | user | 0 / 0.0% |
| strict | job id | 3 / 0.0% | none | 0 / 0.0% |
| loose | path | 6893 / 90.4% | recall | 3095 / 44.9% |
| loose | path | 6893 / 90.4% | rederive | 2140 / 31.0% |
| loose | path | 6893 / 90.4% | user | 13 / 0.2% |
| loose | path | 6893 / 90.4% | none | 1645 / 23.9% |
| loose | sha | 330 / 4.3% | recall | 125 / 37.9% |
| loose | sha | 330 / 4.3% | rederive | 143 / 43.3% |
| loose | sha | 330 / 4.3% | user | 2 / 0.6% |
| loose | sha | 330 / 4.3% | none | 60 / 18.2% |
| loose | uuid | 24 / 0.3% | recall | 14 / 58.3% |
| loose | uuid | 24 / 0.3% | rederive | 4 / 16.7% |
| loose | uuid | 24 / 0.3% | user | 0 / 0.0% |
| loose | uuid | 24 / 0.3% | none | 6 / 25.0% |
| loose | #digits | 377 / 4.9% | recall | 163 / 43.2% |
| loose | #digits | 377 / 4.9% | rederive | 60 / 15.9% |
| loose | #digits | 377 / 4.9% | user | 4 / 1.1% |
| loose | #digits | 377 / 4.9% | none | 150 / 39.8% |
| loose | job id | 3 / 0.0% | recall | 2 / 66.7% |
| loose | job id | 3 / 0.0% | rederive | 1 / 33.3% |
| loose | job id | 3 / 0.0% | user | 0 / 0.0% |
| loose | job id | 3 / 0.0% | none | 0 / 0.0% |

## Short issue-number sensitivity, available plugin cuts

Dropping needs matching `#\d{1,2}` removes 138 of 7627 needs, leaving 7489. Strict recall moves from 8.34% to 8.41% (+0.07 pp); loose recall moves from 44.57% to 44.64% (+0.07 pp).

| Recall rule | Class | Needs before | Share before | Needs after | Share after | Change in share (pp) |
|---|---|---:|---:|---:|---:|---:|
| strict | recall | 636 | 8.3% | 630 | 8.4% | 0.07 |
| strict | rederive | 3672 | 48.1% | 3630 | 48.5% | 0.33 |
| strict | user | 23 | 0.3% | 22 | 0.3% | -0.01 |
| strict | none | 3296 | 43.2% | 3207 | 42.8% | -0.39 |
| loose | recall | 3399 | 44.6% | 3343 | 44.6% | 0.07 |
| loose | rederive | 2348 | 30.8% | 2317 | 30.9% | 0.15 |
| loose | user | 19 | 0.2% | 18 | 0.2% | -0.01 |
| loose | none | 1861 | 24.4% | 1811 | 24.2% | -0.22 |

## Reading these counts

For plugin cuts selected by the ordered availability evidence, strict recall was 636/7,627 needs (8.3%) and loose recall was 3,399/7,627 (44.6%). For available native cuts, strict recall was 49/1,918 (2.6%) and loose recall was 295/1,918 (15.4%). Across all cuts, plugin strict and loose recall were 8.0% and 42.7%; native strict and loose recall were 1.2% and 7.2%.

The old session-wide proxy produces higher shares than the all-cuts rates: plugin strict and loose rise by 0.78 and 4.14 percentage points, while native rises by 0.94 and 5.87 points. Rule 3 still correlates with session habits, so shares among cuts marked available remain upper-leaning estimates. The plugin and native arms also differ in session kinds and dates and are not matched by task; these are descriptive rates, not a plugin effect.

## Method notes

Item rules: paths use a 51-extension allowlist; Git SHAs are 7-40 hex with at least one a-f letter; UUIDs are whole 8-4-4-4-12 forms; issue/PR IDs are # plus digits; job IDs are jobq-prefixed tokens and numeric job-<digits>.
Strict recall requires the exact item in a search_session query or paired result. Loose recall counts any earlier search_session call. Rederive requires an item-bearing grep/find/ls/git log result or a read of the item. The item appears in neither the seed/summary nor the retained tail.
Per-session percentiles use R-7 linear interpolation. The JSON stores aggregate counts, hashed session keys, per-cut availability/evidence, dates, and session kinds; it does not store item strings or transcript text.

## Limits

- The transcript records the whole conversation log; after an earlier compaction, items in old transcript entries may not have remained in the model context at this later cut.
- Exact lexical matching misses paraphrased needs and may count incidental exact mentions; items correctly recalled from model memory without a visible source are classified none.
- A visible search_session call is not proof that the result was relevant, read, or relied on; strict recall only checks whether the query or returned text contains the exact item.
- The pre-boundary search_session evidence rule still correlates with session habits: a model that searched before is likelier to search again, so available-only shares remain an upper-leaning estimate.
- All-digit abbreviated SHAs are missed by design because SHA tokens must contain at least one a-f letter.
- The file-path allowlist omits uncommon extensions, Windows-style paths, and paths containing spaces; identifiers outside the stated forms are not measured.
- Shell/tool activity is visible only when represented in the JSONL. Bash aliases, unrecognized wrappers, hidden tool state, and sources outside the transcript are not attributed.
- Retained tail uses the seed-sections convention: user/assistant messages after the injected seed/summary within two seconds, excluding synthetic entries and a repeated plugin sentinel. Unusual timestamp ordering can misclassify a tail entry.
- Cuts without a qualifying injected plugin seed or native summary are excluded; a final window ending at transcript end is right-censored.
