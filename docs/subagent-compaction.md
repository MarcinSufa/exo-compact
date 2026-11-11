# Subagent compaction

## Measurements

Measured on 2026-11-11 from local transcripts with `--since 2026-10-01`. The scan found 904
subagent transcripts. Of these, 172 (19.0%) had at least one compaction, with 258 compact
boundaries in total. Every transcript had a `sessionId`, but there were only 88 distinct values.
The field therefore identifies a parent session shared by multiple agent transcripts, not an
individual agent.

All cost figures use `weightedUsage` from `tools/real-replay/postcut.mjs`, the same parser and
weights used for the parent-session results in [benchmarks.md](benchmarks.md#post-cut-size-and-cost-per-turn).
The tables use the same date cutoff. The parent-session values below are copied from that
benchmark. These are observational transcript cohorts, not a paired or controlled A/B.

In the date window, the all-boundary inventory found 258 subagent and 805 parent-session
boundaries, or 24.27% of 1,063 total. The parent-session benchmark classifies 623 exo-compact
and 160 native cuts; 22 parent-session boundaries in the inventory are outside those two
classified groups.

For context, each cell gives `n`, median, Q1 to Q3, and IQR in tokens. Session counts refer to
parent-session benchmark groups; the subagent count is transcript files.

| Measure | Subagent | exo-compact | Native |
| --- | ---: | ---: | ---: |
| Cuts / sessions or transcripts | 258 / 904 transcripts | 623 / 122 sessions | 160 / 25 sessions |
| Tokens before compaction | n=258; 218,544.5 (217,467 to 220,633.5; IQR 3,166.5) | n=623; 217,509 (217,006 to 218,180; IQR 1,174) | n=160; 217,387 (216,893 to 218,573; IQR 1,680) |
| Tokens after compaction | n=258; 10,925.5 (9,162.5 to 14,338.5; IQR 5,176) | n=623; 5,016 (4,232 to 5,321; IQR 1,089) | n=160; 18,018 (13,702 to 22,550; IQR 8,848) |
| First-call context | n=258; 39,692.5 (35,820 to 48,184.25; IQR 12,364.25) | n=617; 44,985 (41,608 to 52,047; IQR 10,439) | n=156; 65,484 (56,651 to 77,523; IQR 20,872) |

For cumulative cost, all three groups use the benchmark's `100k-350k preTokens` proxy band. A
cost sample includes only cuts with the full number of distinct assistant calls shown. Each cell
gives `n`, median, Q1 to Q3, and IQR in input-token equivalents.

| Calls after cut | Subagent | exo-compact | Native |
| --- | ---: | ---: | ---: |
| 1 | n=258; 29,400.63 (24,243.70 to 38,894.53; IQR 14,650.83) | n=580; 44,574 (34,419 to 57,854; IQR 23,435) | n=152; 93,470 (74,240 to 108,544; IQR 34,304) |
| 5 | n=228; 67,357.25 (57,089.45 to 82,074.38; IQR 24,984.92) | n=578; 109,298 (91,153 to 126,100; IQR 34,947) | n=152; 153,370 (122,853 to 180,083; IQR 57,230) |
| 20 | n=173; 239,081.15 (210,312.45 to 279,456.15; IQR 69,143.70) | n=568; 319,744 (280,194 to 373,137; IQR 92,943) | n=150; 391,920 (333,101 to 454,890; IQR 121,789) |

These figures describe compaction frequency, post-cut context, and post-cut call cost. They do
not measure fidelity loss. Cuts are clustered within sessions, and the three cohorts are not
matched by task or session. The subagent transcript type was absent from the scanned records, so
agent-type breakdowns are unavailable. The full aggregate from this run is
`/tmp/exo-compact-subagent-run2.json`.

## Identity and capture boundary

- The `session.compact` input has optional `agentId` and `messages`, and its result accepts
  `{ messages: ... }`: `types/claude-code.d.ts`.
- `$.session.id()` is exposed by the engine type, but the scan shows `sessionId` is shared across
  agent transcripts. A per-agent capture store needs an agent-aware key, such as parent
  `sessionId` plus `agentId`; `sessionId` alone is not enough.
- The `agentId` route currently returns the native result before the regular seed path starts.
  Turn capture skips events with `agentId`, while the ordinary capture store is keyed by
  `$.session.id()` and reconciles `$.session.messages()`. A child seed must read only that
  child's captured messages and tool activity so parent state cannot enter it.

## Options

### A. Seed subagents with the same builder

This keeps the regular seed layout and state extraction. It requires an isolated per-agent
capture namespace, child messages and tool activity in that namespace, and tests proving the
parent conversation never enters the child seed. Task cards, briefs, rules, recall paths, and
transcript pointers also need clear per-agent ownership.

### B. Build a thinner seed

This could use only messages passed to `session.compact` to build a small task summary and recent
work. It needs its own contract, a strict size budget, and tests for children with no usable task
state. It would not have the accumulated capture history used by the current builder.

### C. Keep subagents on native compaction

This keeps the current support boundary and native fallback. It avoids mixing parent state into a
child seed, while retaining the measured native compaction behavior.

## Recommendation

These measurements do not show whether option A preserves useful information better or worse
than native compaction. They show how often subagents compact and the context and call costs after
those cuts. That is separate from the fidelity-loss question in #11, so the numbers alone do not
justify switching subagents to option A.

Option A would be justified by two results: a proven agent-aware capture boundary that prevents
parent-state leakage, and a held-out replay quiz over representative subagent cuts showing that
the builder preserves at least as much answerable information as native compaction without an
unacceptable cost increase. A quiz path adapted from `tools/real-replay/quiz.mjs` could measure
that. At the script's baked-in model prices, its defaults of 10 questions per cut, two arms, and
closed plus open modes give a rough estimate of $9 to $12 for 20 cuts or $110 to $160 for all
258 cuts, assuming 20k to 50k memory tokens per arm. Actual API cost depends on memory size and
quiz output; the script's default spend cap is $5 per invocation.

Until identity isolation and quiz results are available, keep option C open. The current data do
not decide between A and C, and they do not establish a case for B.
