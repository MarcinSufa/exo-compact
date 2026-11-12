# Cross-session durable rules measurement

## Question

How many rule tokens in a plugin seed already appeared in a seed from an earlier, different session, under three candidate reuse scopes?

## Sample

Scanned 2972 JSONL transcripts, including 1937 subagent transcripts. Found 1131 compact boundaries and 681 plugin seed cuts in 119 sessions.
Git scope evidence covers 22 sessions resolved to a git common directory, 96 sessions using the unchanged cwd fallback, 0 sessions without a cwd value, and 1 session with mixed evidence. Total sessions with any fallback evidence: 97.
Rule token counts use plugin/compact/core/budgets.ts::estimateTokens over each original source line; seed token counts use the full seed.

## Reading the scopes

- `claudeProjectDir` keeps the original transcript-directory key for comparison. Worktrees and clones commonly split into separate keys under this scope.
- `gitRepo` joins sessions whose cwd resolves to the same git common directory, including linked worktrees. If cwd is gone or not a repository, its exact cwd string remains the fallback key. Missing cwd values are isolated by session.
- `global` treats any earlier different session as a possible repeat and is the vault-wide upper bound.
- ExoVault is vault-wide, so `global` best matches the lookup scope issue #8 would actually use. `gitRepo` is a repository-aware sensitivity check; `claudeProjectDir` is only a comparison.

## Claude project directory scope

681 cuts in 119 sessions across 113 scope keys. The cohort with at least three sessions contains 1 key, 4 sessions, and 180 cuts.

Exact-repeat hit cuts, meaning cuts with one or more exact repeat tokens:

| Source | Exact repeat cuts, all | Exact repeat cuts, cohort | Cuts with harness-delivered repeat units, all | Cuts with harness-delivered repeat units, cohort |
|---|---:|---:|---:|---:|
| Constraints (history) | 68/681 | 68/180 | 68/681 | 68/180 |
| Task card / Rules | 0/681 | 0/180 | 0/681 | 0/180 |
| Task card / Decisions | 0/681 | 0/180 | 0/681 | 0/180 |
| Together | 68/681 | 68/180 | 68/681 | 68/180 |

### Per-cut distributions

Values are median, p25, p75, and p90. Each cell includes its n. Token counts are estimated tokens, shares are percentages, and harness-delivered counts are distinct repeat units per cut.

| Source | Measure | All cuts | Keys with at least 3 sessions |
|---|---|---:|---:|
| Constraints (history) | Rule tokens | n=681; median 214.0 / p25 0.0 / p75 931.0 / p90 1808.0 | n=180; median 989.5 / p25 485.0 / p75 1696.5 / p90 1907.1 |
| Constraints (history) | Exact cross-session repeat tokens | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=180; median 0.0 / p25 0.0 / p75 68.0 / p90 111.0 |
| Constraints (history) | Harness-delivered exact repeat units | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=180; median 0.0 / p25 0.0 / p75 1.0 / p90 3.0 |
| Constraints (history) | Exact repeats as share of rule tokens | n=681; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% | n=180; median 0.0% / p25 0.0% / p75 4.6% / p90 7.0% |
| Constraints (history) | Exact repeats as share of whole seed | n=681; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% | n=180; median 0.00% / p25 0.00% / p75 1.22% / p90 1.73% |
| Constraints (history) | Within-session repeat tokens | n=681; median 176.0 / p25 0.0 / p75 931.0 / p90 1726.0 | n=180; median 931.0 / p25 485.0 / p75 1564.5 / p90 1740.2 |
| Constraints (history) | Near-match repeat tokens, inclusive | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=180; median 0.0 / p25 0.0 / p75 89.0 / p90 157.0 |
| Constraints (history) | Near-match tokens beyond exact repeats | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=180; median 0.0 / p25 0.0 / p75 0.0 / p90 27.0 |
| Constraints (history) | Near matches as share of rule tokens | n=681; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% | n=180; median 0.0% / p25 0.0% / p75 5.3% / p90 10.2% |
| Constraints (history) | Near matches as share of whole seed | n=681; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% | n=180; median 0.00% / p25 0.00% / p75 1.45% / p90 2.61% |
| Task card / Rules | Rule tokens | n=681; median 353.0 / p25 114.0 / p75 685.0 / p90 892.0 | n=180; median 176.5 / p25 115.0 / p75 335.0 / p90 576.3 |
| Task card / Rules | Exact cross-session repeat tokens | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=180; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Task card / Rules | Harness-delivered exact repeat units | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=180; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Task card / Rules | Exact repeats as share of rule tokens | n=681; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% | n=180; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% |
| Task card / Rules | Exact repeats as share of whole seed | n=681; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% | n=180; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% |
| Task card / Rules | Within-session repeat tokens | n=681; median 0.0 / p25 0.0 / p75 73.0 / p90 163.0 | n=180; median 52.0 / p25 27.0 / p75 115.0 / p90 201.3 |
| Task card / Rules | Near-match repeat tokens, inclusive | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=180; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Task card / Rules | Near-match tokens beyond exact repeats | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=180; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Task card / Rules | Near matches as share of rule tokens | n=681; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% | n=180; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% |
| Task card / Rules | Near matches as share of whole seed | n=681; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% | n=180; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% |
| Task card / Decisions | Rule tokens | n=681; median 237.0 / p25 110.0 / p75 383.0 / p90 531.0 | n=180; median 174.5 / p25 127.0 / p75 277.5 / p90 463.2 |
| Task card / Decisions | Exact cross-session repeat tokens | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=180; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Task card / Decisions | Harness-delivered exact repeat units | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=180; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Task card / Decisions | Exact repeats as share of rule tokens | n=681; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% | n=180; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% |
| Task card / Decisions | Exact repeats as share of whole seed | n=681; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% | n=180; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% |
| Task card / Decisions | Within-session repeat tokens | n=681; median 0.0 / p25 0.0 / p75 51.0 / p90 52.0 | n=180; median 51.0 / p25 0.0 / p75 52.0 / p90 127.0 |
| Task card / Decisions | Near-match repeat tokens, inclusive | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=180; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Task card / Decisions | Near-match tokens beyond exact repeats | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=180; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Task card / Decisions | Near matches as share of rule tokens | n=681; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% | n=180; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% |
| Task card / Decisions | Near matches as share of whole seed | n=681; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% | n=180; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% |
| Together | Rule tokens | n=681; median 1271.0 / p25 979.0 / p75 1619.0 / p90 2132.0 | n=180; median 1588.0 / p25 1197.3 / p75 2021.8 / p90 2176.9 |
| Together | Exact cross-session repeat tokens | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=180; median 0.0 / p25 0.0 / p75 68.0 / p90 111.0 |
| Together | Harness-delivered exact repeat units | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=180; median 0.0 / p25 0.0 / p75 1.0 / p90 3.0 |
| Together | Exact repeats as share of rule tokens | n=681; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% | n=180; median 0.0% / p25 0.0% / p75 3.8% / p90 5.6% |
| Together | Exact repeats as share of whole seed | n=681; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% | n=180; median 0.00% / p25 0.00% / p75 1.22% / p90 1.73% |
| Together | Within-session repeat tokens | n=681; median 298.0 / p25 0.0 / p75 1041.0 / p90 1879.0 | n=180; median 1060.0 / p25 633.0 / p75 1724.5 / p90 1957.6 |
| Together | Near-match repeat tokens, inclusive | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=180; median 0.0 / p25 0.0 / p75 89.0 / p90 157.0 |
| Together | Near-match tokens beyond exact repeats | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=180; median 0.0 / p25 0.0 / p75 0.0 / p90 27.0 |
| Together | Near matches as share of rule tokens | n=681; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% | n=180; median 0.0% / p25 0.0% / p75 4.7% / p90 7.9% |
| Together | Near matches as share of whole seed | n=681; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% | n=180; median 0.00% / p25 0.00% / p75 1.45% / p90 2.61% |

### Most repeated units

The table ranks normalized units by distinct sessions within a key in this scope. Unit text and scope keys are omitted.

| Distinct sessions | Length in tokens | Source section | SHA-256 prefix |
|---:|---:|---|---|
| 4 | 43 | Constraints (history) | d9c94ec42213 |
| 3 | 21 | Constraints (history) | ef90d1f64277 |
| 2 | 87 | Constraints (history) | 26c4000ebfc4 |
| 2 | 66 | Constraints (history) | fb7ecf594bea |
| 2 | 17 | Constraints (history) | 49887a51a339 |
| 2 | 15 | Constraints (history) | 9b12eb11508b |
| 2 | 11 | Constraints (history) | ab29e85f3954 |
| 2 | 3 | Constraints (history) | 6a3d4bcd004b |

## Git common directory scope

681 cuts in 119 sessions across 107 scope keys. The cohort with at least three sessions contains 2 keys, 11 sessions, and 245 cuts.

Exact-repeat hit cuts, meaning cuts with one or more exact repeat tokens:

| Source | Exact repeat cuts, all | Exact repeat cuts, cohort | Cuts with harness-delivered repeat units, all | Cuts with harness-delivered repeat units, cohort |
|---|---:|---:|---:|---:|
| Constraints (history) | 132/681 | 132/245 | 132/681 | 132/245 |
| Task card / Rules | 0/681 | 0/245 | 0/681 | 0/245 |
| Task card / Decisions | 0/681 | 0/245 | 0/681 | 0/245 |
| Together | 132/681 | 132/245 | 132/681 | 132/245 |

### Per-cut distributions

Values are median, p25, p75, and p90. Each cell includes its n. Token counts are estimated tokens, shares are percentages, and harness-delivered counts are distinct repeat units per cut.

| Source | Measure | All cuts | Keys with at least 3 sessions |
|---|---|---:|---:|
| Constraints (history) | Rule tokens | n=681; median 214.0 / p25 0.0 / p75 931.0 / p90 1808.0 | n=245; median 782.0 / p25 267.0 / p75 1406.0 / p90 1808.0 |
| Constraints (history) | Exact cross-session repeat tokens | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 74.0 | n=245; median 6.0 / p25 0.0 / p75 89.0 / p90 118.0 |
| Constraints (history) | Harness-delivered exact repeat units | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 2.0 | n=245; median 1.0 / p25 0.0 / p75 3.0 / p90 4.0 |
| Constraints (history) | Exact repeats as share of rule tokens | n=681; median 0.0% / p25 0.0% / p75 0.0% / p90 6.4% | n=245; median 0.5% / p25 0.0% / p75 7.5% / p90 15.8% |
| Constraints (history) | Exact repeats as share of whole seed | n=681; median 0.00% / p25 0.00% / p75 0.00% / p90 1.35% | n=245; median 0.10% / p25 0.00% / p75 1.44% / p90 2.04% |
| Constraints (history) | Within-session repeat tokens | n=681; median 176.0 / p25 0.0 / p75 931.0 / p90 1726.0 | n=245; median 710.0 / p25 256.0 / p75 1362.0 / p90 1727.0 |
| Constraints (history) | Near-match repeat tokens, inclusive | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 74.0 | n=245; median 6.0 / p25 0.0 / p75 89.0 / p90 154.6 |
| Constraints (history) | Near-match tokens beyond exact repeats | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=245; median 0.0 / p25 0.0 / p75 0.0 / p90 27.0 |
| Constraints (history) | Near matches as share of rule tokens | n=681; median 0.0% / p25 0.0% / p75 0.0% / p90 8.7% | n=245; median 0.5% / p25 0.0% / p75 9.2% / p90 15.8% |
| Constraints (history) | Near matches as share of whole seed | n=681; median 0.00% / p25 0.00% / p75 0.00% / p90 1.42% | n=245; median 0.10% / p25 0.00% / p75 1.54% / p90 2.61% |
| Task card / Rules | Rule tokens | n=681; median 353.0 / p25 114.0 / p75 685.0 / p90 892.0 | n=245; median 215.0 / p25 126.0 / p75 551.0 / p90 768.0 |
| Task card / Rules | Exact cross-session repeat tokens | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=245; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Task card / Rules | Harness-delivered exact repeat units | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=245; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Task card / Rules | Exact repeats as share of rule tokens | n=681; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% | n=245; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% |
| Task card / Rules | Exact repeats as share of whole seed | n=681; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% | n=245; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% |
| Task card / Rules | Within-session repeat tokens | n=681; median 0.0 / p25 0.0 / p75 73.0 / p90 163.0 | n=245; median 52.0 / p25 0.0 / p75 107.0 / p90 172.4 |
| Task card / Rules | Near-match repeat tokens, inclusive | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=245; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Task card / Rules | Near-match tokens beyond exact repeats | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=245; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Task card / Rules | Near matches as share of rule tokens | n=681; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% | n=245; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% |
| Task card / Rules | Near matches as share of whole seed | n=681; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% | n=245; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% |
| Task card / Decisions | Rule tokens | n=681; median 237.0 / p25 110.0 / p75 383.0 / p90 531.0 | n=245; median 204.0 / p25 127.0 / p75 354.0 / p90 529.0 |
| Task card / Decisions | Exact cross-session repeat tokens | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=245; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Task card / Decisions | Harness-delivered exact repeat units | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=245; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Task card / Decisions | Exact repeats as share of rule tokens | n=681; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% | n=245; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% |
| Task card / Decisions | Exact repeats as share of whole seed | n=681; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% | n=245; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% |
| Task card / Decisions | Within-session repeat tokens | n=681; median 0.0 / p25 0.0 / p75 51.0 / p90 52.0 | n=245; median 51.0 / p25 0.0 / p75 51.0 / p90 102.0 |
| Task card / Decisions | Near-match repeat tokens, inclusive | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=245; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Task card / Decisions | Near-match tokens beyond exact repeats | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=245; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Task card / Decisions | Near matches as share of rule tokens | n=681; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% | n=245; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% |
| Task card / Decisions | Near matches as share of whole seed | n=681; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% | n=245; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% |
| Together | Rule tokens | n=681; median 1271.0 / p25 979.0 / p75 1619.0 / p90 2132.0 | n=245; median 1437.0 / p25 1142.0 / p75 1913.0 / p90 2131.6 |
| Together | Exact cross-session repeat tokens | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 74.0 | n=245; median 6.0 / p25 0.0 / p75 89.0 / p90 118.0 |
| Together | Harness-delivered exact repeat units | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 2.0 | n=245; median 1.0 / p25 0.0 / p75 3.0 / p90 4.0 |
| Together | Exact repeats as share of rule tokens | n=681; median 0.0% / p25 0.0% / p75 0.0% / p90 4.9% | n=245; median 0.4% / p25 0.0% / p75 5.1% / p90 6.7% |
| Together | Exact repeats as share of whole seed | n=681; median 0.00% / p25 0.00% / p75 0.00% / p90 1.35% | n=245; median 0.10% / p25 0.00% / p75 1.44% / p90 2.04% |
| Together | Within-session repeat tokens | n=681; median 298.0 / p25 0.0 / p75 1041.0 / p90 1879.0 | n=245; median 795.0 / p25 318.0 / p75 1486.0 / p90 1899.6 |
| Together | Near-match repeat tokens, inclusive | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 80.0 | n=245; median 6.0 / p25 0.0 / p75 89.0 / p90 154.6 |
| Together | Near-match tokens beyond exact repeats | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=245; median 0.0 / p25 0.0 / p75 0.0 / p90 27.0 |
| Together | Near matches as share of rule tokens | n=681; median 0.0% / p25 0.0% / p75 0.0% / p90 5.1% | n=245; median 0.4% / p25 0.0% / p75 5.4% / p90 8.7% |
| Together | Near matches as share of whole seed | n=681; median 0.00% / p25 0.00% / p75 0.00% / p90 1.43% | n=245; median 0.10% / p25 0.00% / p75 1.55% / p90 2.61% |

### Most repeated units

The table ranks normalized units by distinct sessions within a key in this scope. Unit text and scope keys are omitted.

| Distinct sessions | Length in tokens | Source section | SHA-256 prefix |
|---:|---:|---|---|
| 9 | 21 | Constraints (history) | ef90d1f64277 |
| 8 | 43 | Constraints (history) | d9c94ec42213 |
| 7 | 35 | Constraints (history) | 3a0bfff40e81 |
| 7 | 11 | Constraints (history) | beefd03a13e9 |
| 5 | 31 | Constraints (history) | fb57989ed46e |
| 4 | 17 | Constraints (history) | 49887a51a339 |
| 3 | 11 | Constraints (history) | ab29e85f3954 |
| 3 | 3 | Constraints (history) | 6a3d4bcd004b |
| 2 | 87 | Constraints (history) | 26c4000ebfc4 |
| 2 | 66 | Constraints (history) | fb7ecf594bea |
| 2 | 24 | Constraints (history) | ca7c62aa9c38 |
| 2 | 22 | Constraints (history) | 5295203c6a0f |
| 2 | 15 | Constraints (history) | 9b12eb11508b |

## Vault-wide global scope

681 cuts in 119 sessions across 1 scope key. The cohort with at least three sessions contains 1 key, 119 sessions, and 681 cuts.

Exact-repeat hit cuts, meaning cuts with one or more exact repeat tokens:

| Source | Exact repeat cuts, all | Exact repeat cuts, cohort | Cuts with harness-delivered repeat units, all | Cuts with harness-delivered repeat units, cohort |
|---|---:|---:|---:|---:|
| Constraints (history) | 348/681 | 348/681 | 348/681 | 348/681 |
| Task card / Rules | 10/681 | 10/681 | 9/681 | 9/681 |
| Task card / Decisions | 1/681 | 1/681 | 1/681 | 1/681 |
| Together | 358/681 | 358/681 | 357/681 | 357/681 |

### Per-cut distributions

Values are median, p25, p75, and p90. Each cell includes its n. Token counts are estimated tokens, shares are percentages, and harness-delivered counts are distinct repeat units per cut.

| Source | Measure | All cuts | Keys with at least 3 sessions |
|---|---|---:|---:|
| Constraints (history) | Rule tokens | n=681; median 214.0 / p25 0.0 / p75 931.0 / p90 1808.0 | n=681; median 214.0 / p25 0.0 / p75 931.0 / p90 1808.0 |
| Constraints (history) | Exact cross-session repeat tokens | n=681; median 6.0 / p25 0.0 / p75 72.0 / p90 133.0 | n=681; median 6.0 / p25 0.0 / p75 72.0 / p90 133.0 |
| Constraints (history) | Harness-delivered exact repeat units | n=681; median 1.0 / p25 0.0 / p75 3.0 / p90 4.0 | n=681; median 1.0 / p25 0.0 / p75 3.0 / p90 4.0 |
| Constraints (history) | Exact repeats as share of rule tokens | n=681; median 0.5% / p25 0.0% / p75 11.1% / p90 30.1% | n=681; median 0.5% / p25 0.0% / p75 11.1% / p90 30.1% |
| Constraints (history) | Exact repeats as share of whole seed | n=681; median 0.09% / p25 0.00% / p75 1.27% / p90 2.16% | n=681; median 0.09% / p25 0.00% / p75 1.27% / p90 2.16% |
| Constraints (history) | Within-session repeat tokens | n=681; median 176.0 / p25 0.0 / p75 931.0 / p90 1726.0 | n=681; median 176.0 / p25 0.0 / p75 931.0 / p90 1726.0 |
| Constraints (history) | Near-match repeat tokens, inclusive | n=681; median 6.0 / p25 0.0 / p75 72.0 / p90 142.0 | n=681; median 6.0 / p25 0.0 / p75 72.0 / p90 142.0 |
| Constraints (history) | Near-match tokens beyond exact repeats | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Constraints (history) | Near matches as share of rule tokens | n=681; median 0.5% / p25 0.0% / p75 12.0% / p90 30.1% | n=681; median 0.5% / p25 0.0% / p75 12.0% / p90 30.1% |
| Constraints (history) | Near matches as share of whole seed | n=681; median 0.09% / p25 0.00% / p75 1.29% / p90 2.48% | n=681; median 0.09% / p25 0.00% / p75 1.29% / p90 2.48% |
| Task card / Rules | Rule tokens | n=681; median 353.0 / p25 114.0 / p75 685.0 / p90 892.0 | n=681; median 353.0 / p25 114.0 / p75 685.0 / p90 892.0 |
| Task card / Rules | Exact cross-session repeat tokens | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Task card / Rules | Harness-delivered exact repeat units | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Task card / Rules | Exact repeats as share of rule tokens | n=681; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% | n=681; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% |
| Task card / Rules | Exact repeats as share of whole seed | n=681; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% | n=681; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% |
| Task card / Rules | Within-session repeat tokens | n=681; median 0.0 / p25 0.0 / p75 73.0 / p90 163.0 | n=681; median 0.0 / p25 0.0 / p75 73.0 / p90 163.0 |
| Task card / Rules | Near-match repeat tokens, inclusive | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Task card / Rules | Near-match tokens beyond exact repeats | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Task card / Rules | Near matches as share of rule tokens | n=681; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% | n=681; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% |
| Task card / Rules | Near matches as share of whole seed | n=681; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% | n=681; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% |
| Task card / Decisions | Rule tokens | n=681; median 237.0 / p25 110.0 / p75 383.0 / p90 531.0 | n=681; median 237.0 / p25 110.0 / p75 383.0 / p90 531.0 |
| Task card / Decisions | Exact cross-session repeat tokens | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Task card / Decisions | Harness-delivered exact repeat units | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Task card / Decisions | Exact repeats as share of rule tokens | n=681; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% | n=681; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% |
| Task card / Decisions | Exact repeats as share of whole seed | n=681; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% | n=681; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% |
| Task card / Decisions | Within-session repeat tokens | n=681; median 0.0 / p25 0.0 / p75 51.0 / p90 52.0 | n=681; median 0.0 / p25 0.0 / p75 51.0 / p90 52.0 |
| Task card / Decisions | Near-match repeat tokens, inclusive | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Task card / Decisions | Near-match tokens beyond exact repeats | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Task card / Decisions | Near matches as share of rule tokens | n=681; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% | n=681; median 0.0% / p25 0.0% / p75 0.0% / p90 0.0% |
| Task card / Decisions | Near matches as share of whole seed | n=681; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% | n=681; median 0.00% / p25 0.00% / p75 0.00% / p90 0.00% |
| Together | Rule tokens | n=681; median 1271.0 / p25 979.0 / p75 1619.0 / p90 2132.0 | n=681; median 1271.0 / p25 979.0 / p75 1619.0 / p90 2132.0 |
| Together | Exact cross-session repeat tokens | n=681; median 6.0 / p25 0.0 / p75 72.0 / p90 133.0 | n=681; median 6.0 / p25 0.0 / p75 72.0 / p90 133.0 |
| Together | Harness-delivered exact repeat units | n=681; median 1.0 / p25 0.0 / p75 3.0 / p90 4.0 | n=681; median 1.0 / p25 0.0 / p75 3.0 / p90 4.0 |
| Together | Exact repeats as share of rule tokens | n=681; median 0.4% / p25 0.0% / p75 5.5% / p90 9.3% | n=681; median 0.4% / p25 0.0% / p75 5.5% / p90 9.3% |
| Together | Exact repeats as share of whole seed | n=681; median 0.10% / p25 0.00% / p75 1.30% / p90 2.16% | n=681; median 0.10% / p25 0.00% / p75 1.30% / p90 2.16% |
| Together | Within-session repeat tokens | n=681; median 298.0 / p25 0.0 / p75 1041.0 / p90 1879.0 | n=681; median 298.0 / p25 0.0 / p75 1041.0 / p90 1879.0 |
| Together | Near-match repeat tokens, inclusive | n=681; median 6.0 / p25 0.0 / p75 72.0 / p90 146.0 | n=681; median 6.0 / p25 0.0 / p75 72.0 / p90 146.0 |
| Together | Near-match tokens beyond exact repeats | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 | n=681; median 0.0 / p25 0.0 / p75 0.0 / p90 0.0 |
| Together | Near matches as share of rule tokens | n=681; median 0.6% / p25 0.0% / p75 5.7% / p90 10.2% | n=681; median 0.6% / p25 0.0% / p75 5.7% / p90 10.2% |
| Together | Near matches as share of whole seed | n=681; median 0.11% / p25 0.00% / p75 1.36% / p90 2.58% | n=681; median 0.11% / p25 0.00% / p75 1.36% / p90 2.58% |

### Most repeated units

The table ranks normalized units by distinct sessions within a key in this scope. Unit text and scope keys are omitted.

| Distinct sessions | Length in tokens | Source section | SHA-256 prefix |
|---:|---:|---|---|
| 16 | 21 | Constraints (history) | ef90d1f64277 |
| 15 | 43 | Constraints (history) | d9c94ec42213 |
| 13 | 31 | Constraints (history) | fb57989ed46e |
| 10 | 35 | Constraints (history) | 3a0bfff40e81 |
| 10 | 11 | Constraints (history) | beefd03a13e9 |
| 7 | 17 | Constraints (history) | 49887a51a339 |
| 6 | 66 | Constraints (history) | fb7ecf594bea |
| 6 | 22 | Constraints (history) | 5295203c6a0f |
| 6 | 4 | Constraints (history) | b256a79fc2c4 |
| 5 | 24 | Constraints (history) | ca7c62aa9c38 |
| 5 | 11 | Constraints (history) | ab29e85f3954 |
| 4 | 15 | Constraints (history) | 9b12eb11508b |
| 3 | 87 | Constraints (history) | 26c4000ebfc4 |
| 3 | 59 | Constraints (history) | be470554891e |
| 3 | 33 | Constraints (history) | f22d925e79f9 |

## Options for issue #8

Savings are gross measured seed tokens in the `global` scope, which matches ExoVault’s vault-wide lookup. A pointer has overhead. Exact repeats already present in earlier non-seed user or system text save seed tokens if moved behind a bridge, but add no new recall.

| Option | Expected seed token saving from this measurement | Risk | Effort |
|---|---|---|---|
| A. No bridge | 0 tokens from a new bridge. | Repeated constraints continue to use seed space. | None |
| B. Pointer for exact cross-session repeats only | 358/681 global cuts had an exact repeat. Per-cut repeat-token distribution: n=681; median 6.0 / p25 0.0 / p75 72.0 / p90 133.0. In the three-session cohort: 358/681 cuts; n=681; median 6.0 / p25 0.0 / p75 72.0 / p90 133.0. Harness-delivered repeat-unit distribution: n=681; median 1.0 / p25 0.0 / p75 3.0 / p90 4.0 overall and n=681; median 1.0 / p25 0.0 / p75 3.0 / p90 4.0 in the cohort. 357 of 358 exact-repeat hit cuts had at least one such unit. Subtract pointer overhead. | A stale or wrong pointer can hide a needed rule. Harness-delivered repeats save seed tokens but add no recall for those units. | Medium |
| C. Full bridge with pointers and hot rules kept verbatim | Gross ceiling is total extracted rule tokens: n=681; median 1271.0 / p25 979.0 / p75 1619.0 / p90 2132.0 overall and n=681; median 1271.0 / p25 979.0 / p75 1619.0 / p90 2132.0 in the three-session cohort. Actual savings are lower after keeping hot rules and adding pointers. | Temporary, superseded, or context-specific rules could be promoted as durable. A missed or stale pointer could remove needed instructions. | High |

## Recommendation for issue #8

119 sessions are represented in the vault-wide scope. Exact repeats should be judged from the global cohort because that is the runtime lookup boundary. The updated scope changes the reading: 358 of 681 cuts have an exact cross-session repeat, while 357 of those repeat-hit cuts already contain at least one repeated unit in same-session user or system text. Those harness-delivered units can save seed tokens if moved behind a bridge, but the bridge adds no recall for them. Keep A as the default. Test B only as a narrow token-saving experiment with a freshness check; its gross median is 6.0 tokens per cut and its p75 is 72.0 before pointer overhead. Do not pursue C yet: its total-rule-token ceiling includes session-specific material and rules that may no longer apply.

## Method

- Seed detection uses `[[exovault:s4-seed:v1]]` inside the boundary window recognized by `tools/real-replay/transcript-parser.mjs::parseJsonl, eventContentText, and splitBoundaries`.
- Rule units are non-empty bullet or quoted lines from Constraints (history), Task card / Rules, and Task card / Decisions. Strip a bullet or quote prefix and a trailing bracket tag with comma-separated source values, collapse whitespace, then lowercase.
- A cross-session exact repeat requires the same normalized unit in a seed from a different session in the selected scope at a strictly earlier boundary timestamp. Same-session repeats from an earlier cut are reported separately.
- Transcript parent directory directly under the Claude projects root, retained for comparison. Git common directory resolved from the session cwd using git rev-parse --path-format=absolute --git-common-dir. If cwd is missing, gone, or not a repository, the unchanged cwd is used as the key. All sessions share one vault-wide scope.
- Git common directory resolution is cached per cwd. Evidence counts include sessions with plugin seed cuts only. Fallback cwd strings are kept intact, including worktree-like suffixes.
- The harness-delivered metric counts distinct exact repeat units also found verbatim after whitespace and case normalization in non-seed user or system text from that transcript before the boundary.
- Near-match sensitivity compares word 3-gram sets against earlier sessions in the selected scope using Jaccard >= 0.8. The inclusive near-match count includes exact matches; the additional count excludes them.
- Each scope cohort includes keys with at least three distinct sessions represented by plugin seed cuts. Subagent transcripts use their parent session ID when available.
- Per-cut token shares divide repeat tokens by that cut source's rule tokens or full seed tokens. Empty rule sections contribute zero shares.
- Percentiles use linear interpolation over sorted per-cut values.
- The JSON and this report omit rule text, project names, session IDs, cwd values, git paths, and transcript paths. Scope keys are SHA-256 hashed before comparison.

## Limits

- Exact matching misses paraphrases and treats any normalized line match as equivalent even if its meaning changed.
- The near-match sensitivity can overcount boilerplate and remains a lexical measure, not evidence that the rule was needed in the later session.
- A three-session cohort can still be small within the Claude project directory or git repository scopes. The global cohort can be much broader and should not be read as proof that every rule applies everywhere.
- Token estimates are an approximation of model tokenizer costs. Pointer overhead and hot rules retained verbatim are not deducted from the gross repeated-token measurement.
- A rule that appeared in an earlier seed may have been temporary, project-specific, or superseded. This measurement does not establish that it is safe to move.
