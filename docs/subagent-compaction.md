# Subagent compaction

## Measurements

Measured on 2026-11-11 from the current local transcript archive, with boundaries dated from
2026-10-01 through 2026-11-11 05:14:06 UTC. The parent-session benchmark rows are preserved from
an earlier archive snapshot with that same event-time cutoff. The current archive has 771 parent
boundaries in that window, while the benchmark groups contain 623 exo-compact and 160 native
cuts, or 783 total. That 12-cut difference is snapshot drift; it is not an unclassified group.
The current bounded inventory has 1,049 cuts in total, including 278 subagent cuts, or 26.5%.

The current archive contains 905 direct subagent transcripts and 1,029 workflow transcripts.
The 278 boundaries in the bounded window come from 22 parent sessions. They are concentrated:
the top parent session has 190 cuts (68.4%), and the top five have 243 (87.4%). In the window,
192 of 1,934 transcripts have at least one cut. This frequency is dominated by one parent
session rather than spread evenly across agents.

| Subagent transcript source | Transcript files | Transcripts with a cut in window | Cuts in window |
| --- | ---: | ---: | ---: |
| Direct `subagents/*.jsonl` | 905 | 169 | 255 |
| Workflow `subagents/workflows/wf_*/` | 1,029 | 23 | 23 |
| Total | 1,934 | 192 | 278 |

Of these transcripts, 1,926 contain a `sessionId`, with 88 distinct values. The transcript
`sessionId` identifies a parent session shared by multiple agent transcripts, not an individual
agent. The 22 parent sessions above count only sessions with a cut in the bounded window.

All cost figures use `readUsage` and `weightedUsage` from
[`tools/real-replay/postcut.mjs`](../tools/real-replay/postcut.mjs). The parent-session rows are
from [benchmarks.md](benchmarks.md#post-cut-size-and-cost-per-turn). For post-cut calls, this
tool's local selection rule finds the first user event in the next five events, skips calls
through two seconds after that event, excludes synthetic calls, and requires distinct message
IDs. This differs from `postcut.mjs`, which starts at injection time and can fall back to a UUID.
The review also found that `postcut.mjs` can label native subagent cuts as exo-compact when their
summary quotes the seed marker; this subagent report does not use that classifier.
The cohorts are observational, unpaired, and not a controlled A/B.

For context, each cell gives `n`, median, Q1 to Q3, and IQR in tokens. Main-session counts use
parent sessions; the subagent count uses parent sessions and also gives transcript files.

| Measure | Subagent | exo-compact | Native |
| --- | ---: | ---: | ---: |
| Cuts / parent sessions | 278 / 22 (1,934 transcripts) | 623 / 122 | 160 / 25 |
| Tokens before compaction | n=278; 218,618 (217,493.5 to 220,564; IQR 3,070.5) | n=623; 217,509 (217,006 to 218,180; IQR 1,174) | n=160; 217,387 (216,893 to 218,573; IQR 1,680) |
| Tokens after compaction | n=278; 10,713.5 (8,708.5 to 13,886.75; IQR 5,178.25) | n=623; 5,016 (4,232 to 5,321; IQR 1,089) | n=160; 18,018 (13,702 to 22,550; IQR 8,848) |
| First-call context | n=278; 39,095.5 (35,225.5 to 46,244.5; IQR 11,019) | n=617; 44,985 (41,608 to 52,047; IQR 10,439) | n=156; 65,484 (56,651 to 77,523; IQR 20,872) |

The first-call context includes system prompts and tool schemas. The difference between the
first-call and post-cut medians is about 28.4k tokens for subagents, 40.0k for exo-compact, and
47.5k for native. Smaller agent prompts and schemas likely account for much of the gap, so the
lower subagent first-call context is not evidence of a compaction effect.

For cumulative cost, all three groups use the benchmark's `100k-350k preTokens` proxy band. A
cost sample includes only cuts with the full number of distinct assistant calls shown. Each cell
gives `n`, median, Q1 to Q3, and IQR in input-token equivalents.

| Calls after cut | Subagent | exo-compact | Native |
| --- | ---: | ---: | ---: |
| 1 | n=278; 28,226.83 (23,335.58 to 36,736.42; IQR 13,400.85) | n=580; 44,574 (34,419 to 57,854; IQR 23,435) | n=152; 93,470 (74,240 to 108,544; IQR 34,304) |
| 5 | n=235; 66,703.95 (56,210.43 to 79,378.35; IQR 23,167.93) | n=578; 109,298 (91,153 to 126,100; IQR 34,947) | n=152; 153,370 (122,853 to 180,083; IQR 57,230) |
| 20 | n=171; 237,975.65 (210,242.15 to 273,954.78; IQR 63,712.63) | n=568; 319,744 (280,194 to 373,137; IQR 92,943) | n=150; 391,920 (333,101 to 454,890; IQR 121,789) |

These are model-agnostic weighted input-token equivalents, not dollar costs. Sibling
`agent-*.meta.json` files report 179 sonnet, 32 opus, 25 inherit, and 42 unset model values among
the 278 subagent cuts; all 23 workflow cuts have an unset model value. Main-session assistant
events are about 95% Opus. Equal token equivalents therefore do not imply equal dollar costs.

Sibling metadata also reports 226 `general-purpose`, 25 `fork`, 2 `Plan`, 2 `Explore`, and 23
`workflow-subagent` cuts. Fork agents carry parent context by design. For option A, the per-agent
capture boundary must preserve that inherited context while preventing unrelated parent state
from entering the child seed.

The measurements describe compaction frequency, post-cut context, and post-cut call cost. They
do not measure fidelity loss. The aggregate can be reproduced with:

```sh
node tools/real-replay/subagent-cuts.mjs --root ~/.claude/projects --since 2026-10-01 --until 2026-11-11T05:14:06Z --json /tmp/exo-compact-subagent-run3.json
```

## Identity and capture boundary

- The `session.compact` input has optional `agentId` and required `messages`. A successful
  `SessionCompactResult` has `messages`; the skip variant does not
  (`types/claude-code.d.ts:16-18, 73-78`).
- `routeTrigger` sends events with `agentId` to `next` (`plugin/compact/core/handler.ts:14-17`).
  The `next` route calls native compaction first, then can append agent-pressure guidance and
  stores pressure state at `capturePath($.session.id())/agent-pressure/<agentId>.json`
  (`plugin/compact/compact.ts:498-513`). This is a working precedent for an agent-aware key and
  means native subagent cuts may include exo guidance messages.
- Turn capture returns early for events with `agentId`
  (`plugin/compact/compact.ts:1498-1508`). The transcript scan shows that subagent `sessionId`
  values match their parent session. Since `$.session.id()` is used in the pressure-state path,
  I infer that it resolves to the parent ID inside a subagent hook; this was not measured by
  invoking the hook. A per-agent capture store needs an agent-aware key, such as parent
  `sessionId` plus `agentId`; `sessionId` alone is not enough.
- A child seed must read only that child's captured messages and tool activity. Fork agents
  intentionally carry inherited parent context, so isolation must preserve the fork's allowed
  context while keeping captured state scoped to that agent.

## Options

### A. Seed subagents with the same builder

This keeps the regular seed layout and state extraction. It requires an isolated per-agent
capture namespace, child messages and tool activity in that namespace, and tests proving the
capture boundary preserves allowed fork context without adding unrelated parent state. Task
cards, briefs, rules, recall paths, and transcript pointers also need clear per-agent ownership.

### B. Build a thinner seed

This could use only messages passed to `session.compact` to build a small task summary and recent
work. It needs its own contract, a strict size budget, and tests for children with no usable task
state. It would not have the accumulated capture history used by the current builder.

### C. Keep subagents on native compaction

This keeps the current support boundary and native fallback. It avoids mixing captured agent
state across children, while retaining the measured native compaction behavior.

## Recommendation

These measurements show that subagent cuts are concentrated in a small number of parent
sessions, and describe context and call costs after those cuts. They do not show whether option A
preserves useful information better or worse than native compaction. The counts alone do not
justify switching subagents to option A.

Option A would be justified by two results: a proven agent-aware capture boundary that preserves
intentional fork context without adding unrelated parent state, and a held-out replay quiz over
representative cuts from multiple parent sessions and agent types showing that the builder
preserves at least as much answerable information as native compaction without an unacceptable
cost increase. A quiz path adapted from `tools/real-replay/quiz.mjs` could measure that. Quiz run
cost depends on model prices, memory size, and the number of open-mode turns; it cannot be inferred
from these model-agnostic token-equivalent measurements.

Until identity isolation and quiz results are available, keep option C open. The current data do
not decide between A and C, and they do not establish a case for B.
