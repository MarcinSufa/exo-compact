# Observation masking replay

Scan time: 2026-11-11T23:50:30.106Z UTC. Boundaries dated 2026-10-01 through 2026-11-12, inclusive. The scan read 1,021 main-session transcript files and found 815 cuts: 649 exo seed and 166 native. It skipped no malformed lines and made no API calls. Transcripts under a `subagents` path remain excluded.

## Method and image accounting

The scanner reuses `postcut.mjs` parsing, cut classification, usage parsing, cost weighting, and aggregation. Each cut uses the active transcript segment before `compact_boundary`. Results are paired with their preceding `tool_use`; the last K tool-result blocks are kept and older result contents are replaced by `[Earlier tool output masked.]`.

For array/object content, the scanner removes image and document base64 payloads before estimating text as `ceil(JSON.stringify(text-only content).length / 4)`; top-level string messages keep the existing character-count estimate. It then adds 1,000 tokens per image or document block. The 1,000-token figure is an explicit fixed assumption, not a sourced model-token formula. It applies to the whole-context calibration and tool-result estimates. The placeholder estimate is 8 tokens. Freed tokens subtract placeholder tokens from the old result estimate, including the image estimate.

| K | Cuts with masked image/document blocks | Masked blocks total | Estimated image/document tokens | Per-cut blocks, median (IQR) |
| ---: | ---: | ---: | ---: | ---: |
| 5 | 288 | 1,182 | 1,182,000 | 0 (0..2) |
| 10 | 276 | 1,082 | 1,082,000 | 0 (0..2) |
| 20 | 258 | 934 | 934,000 | 0 (0..2) |

Statistics use the same linear interpolation as `postcut.mjs`. Freed share is freed tokens divided by boundary `preTokens`. Window groups are also reused: 100k to under 350k is the 200k proxy, at least 500k is the 1M proxy, and the remaining values are `other`.

## Image accounting comparison

With a fixed image/document estimate (current scan), the estimate for the whole pre-cut context divided by the last assistant-call context usage is n=813, median 0.517 (IQR 0.487..0.545). With base64 counted as text (earlier scan, two fewer cuts), it is n=811, median 0.552 (IQR 0.502..0.934). No scale is applied: transcript estimates omit system context and request framing, so applying the whole-context ratio to tool results would attribute those missing tokens to tool outputs.

The differences below reflect the change from base64 counted as text to a fixed image/document estimate, as well as two additional cuts in the later scan. Values are rounded to the nearest token.

| K | Cohort | Base64 counted as text, n; median (IQR) | Fixed image/document estimate, n; median (IQR) | Median change |
| ---: | --- | --- | --- | ---: |
| 5 | All | 813; 43,206 (31,802..119,950) | 815; 36,756 (29,676..43,207) | -6,450 |
| 5 | Exo seed | 648; 43,222 (32,227..104,855) | 649; 37,665 (30,018..44,207) | -5,557 |
| 5 | Native | 165; 41,696 (31,397..165,442) | 166; 34,512 (28,119..38,839) | -7,184 |
| 10 | All | 813; 41,105 (30,714..114,327) | 815; 35,193 (28,619..41,378) | -5,912 |
| 10 | Exo seed | 648; 41,187 (31,058..94,996) | 649; 36,189 (29,306..42,266) | -4,998 |
| 10 | Native | 165; 39,680 (29,141..162,362) | 166; 32,961 (26,581..37,320) | -6,719 |
| 20 | All | 813; 36,471 (27,136..99,172) | 815; 31,847 (25,936..37,724) | -4,624 |
| 20 | Exo seed | 648; 36,719 (27,668..85,238) | 649; 32,725 (26,640..38,656) | -3,994 |
| 20 | Native | 165; 34,701 (25,867..135,873) | 166; 29,822 (23,609..33,602) | -4,879 |

The Read contribution compares base64 counted as text with a fixed image/document estimate and shows the removed base64 tail directly:

| K | Base64 counted as text, n; median (IQR) | Fixed image/document estimate, n; median (IQR) |
| ---: | --- | --- |
| 5 | 479; 55,037 (3,624..178,020) | 480; 3,547 (1,886..7,070) |
| 10 | 459; 55,309 (3,783..173,312) | 460; 3,435 (1,817..6,786) |
| 20 | 432; 55,546 (3,450..153,783) | 433; 3,030 (2,013..6,060) |

## Corrected headroom and deferral

All 815 cuts are included in the overall rows, including cuts with no tool results. The 48 `other` cuts all have `preTokens` below 100k (22,392..85,782); their median is five tool results and zero results older than K=5, so the median freed amount is zero.

| K | Freed tokens, n; median (IQR) | Freed share, n; median (IQR) | Masked results per cut, median (IQR) |
| ---: | --- | --- | --- |
| 5 | 815; 36,756 (29,676..43,207) | 815; 17.0% (13.8..19.9%) | 93 (73..113) |
| 10 | 815; 35,193 (28,619..41,378) | 815; 16.2% (13.3..19.0%) | 88 (68..108) |
| 20 | 815; 31,847 (25,936..37,724) | 815; 14.7% (12.0..17.3%) | 78 (58..98) |

For 200k-proxy cuts, the freed-token medians are 37,455 (31,290..43,611), 35,998 (29,987..41,769), and 32,475 (27,018..38,071) for K=5, 10, and 20. There are no 1M-proxy cuts. The `other` medians are zero at every K.

Deferral divides freed tokens by median context growth across adjacent assistant calls among the last 20 calls before the boundary. Median growth is n=810, 1,109 tokens per call (IQR 849..1,480). Estimated extra calls are:

| K | Eligible cuts | Estimated extra calls, median (IQR) |
| ---: | ---: | ---: |
| 5 | 808 | 33.34 (24.13..44.35) |
| 10 | 808 | 31.96 (22.75..42.98) |
| 20 | 808 | 29.39 (20.13..39.66) |

## Matched-horizon cost

Costs are input-token equivalents, using `postcut.mjs` weights: input 1, cache write 1.25, cache read 0.1, and output 5. The masked path pays one batch cache write for the masked context and output on its first call. Each later call pays a cache read of the prior context, a 1.25 cache write for the new tokens at measured median per-call growth, and the same observed output. The real exo or native path uses measured post-cut `weightedUsage` calls. The deferral horizon is rounded up to a whole call and capped at 200. When a transcript has fewer measured calls than N, both paths use median observed output tokens for the missing calls; the real path extends cache reads from its last measured context, increasing by the same growth on each missing call. This real-path extension past measured calls charges reads and output but no cache write for new tokens, which favours the real path by about 1.25 times median growth per extended call; it cannot change the sign of the median difference. Extension counts have median zero; maximum added calls were 19 exo and 15 native at 20 calls, and 128/35 at K=5, 127/34 at K=10, and 125/33 at K=20 for the deferral horizon.

Each table cell reports the median of per-cut paired differences, masked minus real, and its IQR. Positive values mean masking costs more. The final column is the share of paired cuts where masking is cheaper.

| K | Horizon | Real path | n | Median N | Masked minus real, median (IQR) | Masking cheaper |
| ---: | --- | --- | ---: | ---: | --- | ---: |
| 5 | 20 calls | Exo seed | 639 | 20 | +341,361 (300,424..377,913) | 0.3% (2/639) |
| 5 | 20 calls | Native | 161 | 20 | +289,273 (217,705..336,675) | 2.5% (4/161) |
| 10 | 20 calls | Exo seed | 639 | 20 | +347,190 (307,427..383,562) | 0.2% (1/639) |
| 10 | 20 calls | Native | 161 | 20 | +292,244 (224,122..339,611) | 2.5% (4/161) |
| 20 | 20 calls | Exo seed | 639 | 20 | +356,956 (317,607..394,630) | 0.2% (1/639) |
| 20 | 20 calls | Native | 161 | 20 | +303,562 (238,559..347,873) | 1.9% (3/161) |
| 5 | Deferral | Exo seed | 642 | 35 | +448,001 (349,553..548,668) | 1.1% (7/642) |
| 5 | Deferral | Native | 163 | 32 | +327,505 (225,879..448,226) | 5.5% (9/163) |
| 10 | Deferral | Exo seed | 644 | 33 | +442,531 (347,601..547,315) | 0.8% (5/644) |
| 10 | Deferral | Native | 163 | 30 | +328,317 (231,052..446,148) | 5.5% (9/163) |
| 20 | Deferral | Exo seed | 645 | 31 | +435,406 (339,600..536,870) | 0.2% (1/645) |
| 20 | Deferral | Native | 163 | 27 | +323,188 (224,882..429,184) | 4.3% (7/163) |

Masking still reaches a cut again after its estimated deferral and then requires a seed. The modeled next-seed counts are 645 exo and 163 native cuts for each K; the median calls to that next cut are 34/32 at K=5, 33/30 at K=10, and 31/27 at K=20. That next seed is outside the paired N-call cost above.

## Read replay proxy

The proxy checks whether a path from a masked result or a retained result appears again in one of the first 20 assistant calls after the real cut. It uses `Read`, `NotebookRead`, and the `READ_BASH` patterns from `postcut.mjs`, with exact normalized path matching. `n` counts path observations and `cuts` counts cuts with at least one such path. This is a proxy, not a quality measure.

| K | Result set | Path observations n | Re-read | Share | Cuts |
| ---: | --- | ---: | ---: | ---: | ---: |
| 5 | Masked Reads | 31,330 | 1,139 | 3.6% | 788 |
| 5 | Retained Reads | 1,693 | 105 | 6.2% | 636 |
| 10 | Masked Reads | 29,685 | 1,034 | 3.5% | 781 |
| 10 | Retained Reads | 3,338 | 210 | 6.3% | 756 |
| 20 | Masked Reads | 26,519 | 913 | 3.4% | 770 |
| 20 | Retained Reads | 6,504 | 331 | 5.1% | 802 |

## Hook surface and recommendation

The checked-in type facade exposes no generic pre-request hook that receives and rewrites full conversation history. `prompt.submit` receives only prompt text and optional context. `classic.PostToolUse` can update the just-finished output, but cannot reach old results. `session.compact` receives and may return the full messages list, so it can mask at a compaction boundary.

The matched cost results do not support A as a cheaper first route. The paired median difference is positive for every K and path, ranging from +289,273 to +448,001, and masking is cheaper on 0.2% to 5.5% of cuts. The Read replay rates are low, but this path proxy does not establish fidelity or answer quality. A can only be justified by a demonstrated fidelity benefit; this replay supplies no such quality measure. Recommend C: do not add observation masking based on the current evidence.

Each test in tools/real-replay/mask-replay.test.mjs was shown red against its own named mutant of mask-replay.mjs; the list is in the pull request.

See also the [post-cut size and cost benchmark](benchmarks.md#post-cut-size-and-cost-per-turn).
