# Benchmarks

## A/B with the 4.8.0 defaults

**Workload.** One long Claude Code session works through a chain of 8 real, consecutive coding
tasks from a private project ("slices"). Each slice has:

- a written brief with exact requirements;
- a house-rules file for the final report;
- hidden test gates (229 per chain) that the agent never sees.

Besides the gates, 5 standing session rules are checked in 7 reports, 35 checks per chain.

**Setup.**

| | |
|---|---|
| Model | Sonnet 5.5 |
| Arms | native compaction (Claude Code's own), and exo-compact with the 4.8.0 manifest defaults: `briefPush` and `briefCheck` off, `ruleCheck` off, so no TypeSafe key |
| Runs | 9 chains per arm, in pairs: one chain per arm at the same time. Only the first two plugin chains were compared with native chains run the day before. |
| Window | 100k tokens on both sides of every pair (80k effective, as Claude Code's debug log reports it). Pairs 8 and 9 asked for 60k, but the harness clamped it, so they ran at the same window as the rest |

**Results.**

| Pair | Window | Arm | Gates | Session rules (first reply · after a follow-up) | Cost | Wall time | Cuts |
|---|---:|---|---:|---:|---:|---:|---:|
| 1 | 100k | plugin | 225/229 | 34/35 · 34/35 | $3.81 | 23.7 min | 7 |
| 1 | 100k | native | 220/229 | 34/35 · 35/35 | $4.01 | 29.6 min | 7 |
| 2 | 100k | plugin | 223/229 | 34/35 · 34/35 | $3.78 | 24.1 min | 7 |
| 2 | 100k | native | 219/229 | 30/35 · 30/35 | $3.91 | 33.0 min | 7 |
| 3 | 100k | plugin | 225/229 | 33/35 · 34/35 | $4.18 | 23.0 min | 7 |
| 3 | 100k | native | 224/229 | 33/35 · 35/35 | $4.08 | 42.3 min | 7 |
| 4 | 100k | plugin | 222/229 | 35/35 · 35/35 | $3.85 | 24.8 min | 7 |
| 4 | 100k | native | 223/229 | 25/35 · 27/35 | $4.36 | 30.9 min | 8 |
| 5 | 100k | plugin | 222/229 | 35/35 · 35/35 | $4.33 | 24.4 min | 8 |
| 5 | 100k | native | 219/229 | 30/35 · 30/35 | $5.35 | 35.4 min | 10 |
| 6 | 100k | plugin | 226/229 | 35/35 · 35/35 | $4.70 | 27.6 min | 9 |
| 6 | 100k | native | 222/229 | 35/35 · 35/35 | $4.91 | 33.1 min | 8 |
| 7 | 100k | plugin | 224/229 | 34/35 · 34/35 | $4.37 | 24.0 min | 8 |
| 7 | 100k | native | 222/229 | 35/35 · 35/35 | $4.77 | 32.5 min | 8 |
| 8 | 100k | plugin | 221/229 | 35/35 · 35/35 | $4.58 | 29.8 min | 8 |
| 8 | 100k | native | 212/229 | 35/35 · 35/35 | $4.28 | 31.4 min | 7 |
| 9 | 100k | plugin | 218/229 | 35/35 · 35/35 | $4.31 | 26.4 min | 8 |
| 9 | 100k | native | 226/229 | 31/35 · 31/35 | $4.75 | 31.9 min | 8 |

| Per chain | exo-compact | Native compaction |
|---|---:|---:|
| Hidden tests passed | **222.9 / 229** (2,006 / 2,061 in all) | 220.8 / 229 (1,987 / 2,061) |
| Hidden tests missed | **6.1** | 8.2 |
| Session rules kept | **34.5 / 35** | 32.3 / 35 |
| Cost, mean | **$4.21** | $4.49 |
| Cost, median | **$4.31** | $4.36 |
| Cost, range | $3.78 to $4.70 | $3.91 to $5.35 |
| Wall time, mean | **25.3 min** | 33.3 min |
| Compactions, mean | 7.7 | 7.8 |

Costs are the API-equivalent amounts Claude Code reported. Session rules are the mean of the two
columns.

**Reading the results.**

- **Gates.** The plugin missed 6.1 hidden tests per chain against 8.2. It was not ahead in every
  pair: in pairs 4 and 9 the native chain passed more.
- **Session rules.** The clearest gap. The plugin kept 34.5 of 35 on average and never fewer than
  33 in a report column; three of the nine native chains kept 30 or fewer.
- **Time.** About 24% less wall time per chain, with about the same number of compactions.
- **Cost.** 6% less on the mean, but the ranges overlap and the medians are close ($4.31 against
  $4.36). Read it as on par or a little cheaper, not as a saving.
- **No wrong task.** No chain on either side worked on the wrong task after a compaction.

**Caveats.**

- The test covers one project and one model.
- The workload is the one the plugin was developed against. A test on a held-out project has not
  been done yet.
- An earlier A/B (plugin 3.56.0, three pairs, with brief push, brief check and the Jev rule check
  on) cost about 40% more than native compaction. Brief push and brief check are off by default
  since 4.8.0.

## A/B at a 200k window (2026-10-23)

**Setup.** exo-compact main `20cc1d7` with its manifest defaults (no API key, no rule check) and
`interactiveOnly=false`, against native compaction. This used the same 8-task chain as the A/B
above: Sonnet 5.5, 229 hidden tests and 35 rule checks per chain. The auto-compact window was
200k tokens (the existing A/B used 100k), so there were only 1 to 2 compactions per chain. There
were 3 pairs, each pair run at the same time.

**Per pair (exo-compact / native).**

| Pair | Hidden tests passed | Rules kept (of 35) | Cost | Time | Compactions |
|---|---:|---:|---:|---:|---:|
| 1 | 227 / 226 | 35 / 31 | $4.41 / $4.03 | 1720 s / 1855 s | 1 / 1 |
| 2 | 227 / 224 | 35 / 35 | $4.71 / $4.61 | 1866 s / 2083 s | 2 / 2 |
| 3 | 226 / 221 | 35 / 34 | $4.15 / $4.74 | 1624 s / 1984 s | 1 / 2 |

**Means per chain.**

| | exo-compact | Native compaction |
|---|---:|---:|
| Hidden tests passed (of 229) | 226.7 | 223.7 |
| Rules kept (of 35) | 35.0 | 33.3 |
| Time | 29.0 min (12% sooner) | 32.9 min |
| Cost | $4.42 (on par) | $4.46 |
| Compactions | 1.3 | 1.7 |

Only 3 pairs were run, so no difference here is statistically sure. Four of native's five missed
rule checks came before the first compaction in pair 1, so the rule gap is mostly noise;
exo-compact cost more in pair 1 ($4.41 against $4.03).

**A benchmark of -p runs must set interactiveOnly=false.** The manifest default
`interactiveOnly=true` means `claude -p` and SDK runs keep native compaction and log
`compact.fallback=interactive_only origin=compact entrypoint=sdk-cli`. A benchmark made of `-p`
runs therefore measures native compaction on both sides unless it sets `interactiveOnly=false`.
In the first run (4 pairs), the plugin side never made one cut of its own; it only measured the
plugin's hooks on top of native compaction: $4.51 against $4.12 per chain (mean of 4 pairs).

## Field data (2026-09-27 to 2026-10-12)

The README's field-data table is counted from Claude Code's own transcripts of the maintainer's
interactive sessions. Scripted (`-p` and SDK) sessions and subagent transcripts are left out.

**What was counted.**

- **Compaction.** A `compact_boundary` record followed by the plugin's seed message
  (`[[exovault:s4-seed:v1]]`) counts as a plugin cut. One followed by Claude Code's own summary
  message counts as a native compaction.
- **Sessions.** The exo-compact column holds every session with at least one plugin cut. The
  native column holds sessions that compacted natively and never had a plugin cut.
- **Context size.** Input tokens plus cache-read and cache-creation tokens of an assistant
  message. "Before" is the `preTokens` value of the boundary record. "After" is the first
  assistant message that follows the cut.
- **Time per compaction.** From the timestamp of the last transcript entry before the boundary to
  the timestamp of the seed or summary message.
- **Searches.** `search_session` tool calls and the length of their results.
- **Re-reads.** A `Read` call, after a cut, of a file path the session had already read before
  that cut, counted once per file and cut.

**Results.** 80 sessions with 255 plugin cuts, and 19 sessions with 38 native compactions.

| | exo-compact | native compaction |
|---|---:|---:|
| Context before (median) | 217,644 | 218,103 |
| Context after (25th / median / 75th percentile) | 40,620 / 44,739 / 56,104 | 45,142 / 49,961 / 56,804 |
| Seconds per compaction (25th / median / 90th percentile) | 0.30 / 0.43 / 3.79 | 49.1 / 61.9 / 90.0 |
| Cuts followed by at least one search | 126 of 255 | 0 of 38 |
| Sessions that searched | 46 of 80 | 0 of 19 |
| Search result length (25th / median / 75th percentile, characters) | 2,248 / 3,135 / 3,575 | n/a |
| Re-reads | 141, after 40 of 255 cuts | 1 |

**Longest runs.** A run is a series of plugin cuts in one session with no native compaction in
between. It starts at the previous compaction (or the session start) and ends at the next native
compaction (or the session end). Active time is the sum of the gaps shorter than 10 minutes
between transcript entries, so idle time does not count.

| Plugin cuts in a row | Active hours | Calendar days | Tool calls | User messages |
|---:|---:|---:|---:|---:|
| 50 | 39.0 | 7.1 | 4,891 | 313 |
| 23 | 38.6 | 6.1 | 3,242 | 137 |
| 10 | 17.6 | 1.6 | 943 | 46 |
| 15 | 15.9 | 5.2 | 1,379 | 71 |
| 8 | 9.9 | 1.1 | 916 | 7 |

The first three runs sit in sessions that also had native compactions before or after the run.
The last two sessions had none. The second and fourth were still open when this was counted.

The 50 compactions of the first run took 154 seconds in total by the measure above (median 2.7 s,
longest 14.9 s). Fifty native compactions at the native median of 61.9 s would take about 52
minutes. The picture at the top of the README shows this run: each mark is one compaction, placed
at its active-time offset from the start of the run.

**How to read it.**

- This is not a controlled comparison. The two columns are different sessions doing different
  work, and the native column is small.
- The model mix differs: 88% of assistant messages in the plugin sessions came from Opus 5.5 and
  12% from Sonnet 5.5, against 52% and 47% in the native sessions.
- All 255 plugin cuts were automatic. Of the 38 native compactions, 22 were automatic and 16 were
  started by hand with `/compact`.
- Two long sessions spent developing the plugin account for 262 of the 507 searches. Without
  them, 78 sessions made 245 searches, after 90 of 219 cuts.
- Four of the 80 plugin sessions also contain native compactions, 26 in total. Nineteen came
  before the plugin's first cut in that session. Seven came after it, in two sessions; their cause
  was not examined.
- The counts cannot show what a search replaced: whether the model would otherwise have guessed,
  asked the user or redone the work. So no cost saving is claimed from them.
- The plugin version changed many times during the period, up to 4.7.3.

## Context carried per call

The README's "Context carried per call" table has one measured row and one estimated row.

**Measured row.** Counted from the same transcripts as the field data, over 2026-09-27 to
2026-10-13: the 83 interactive sessions with at least one plugin cut (281 plugin cuts, 33,200
model calls, 353 active hours). The context of a call is its input tokens plus cache-read and
cache-creation tokens. Each assistant message is counted once.

| | exo-compact sessions | native-only sessions |
|---|---:|---:|
| Sessions / model calls | 83 / 33,200 | 19 / 2,582 |
| Context per call, mean | 134,825 | 135,121 |
| Context per call, median | 135,504 | 134,719 |
| Context per call, 90th percentile | 200,604 | 202,963 |
| Context per call, maximum | 219,381 | 217,379 |
| Share read from the prompt cache | 98.2% | 97.7% |

These sessions compacted at about 218k tokens (median 217,687 before a plugin cut, 218,103 before
a native compaction) and restarted at about 45k.

**Estimated row.** No session in this data ever carried more than 250k tokens, so there is no
measurement of a 1M window. The 500k figure is half the window: a context that grows steadily
from a small summary to the window limit averages about half the limit. The same rule applied to
the measured sessions gives (45k + 218k) / 2 = 131k, against 135k measured.

**How to read it.**

- At an equal window the two columns carry the same context. exo-compact does not shrink the
  context by itself. What it changes is the price of a compaction (0.4 s against 62 s at the
  median, and the earlier session stays searchable), which is what makes a small window
  comfortable.
- The estimate holds only for a session long enough to fill a 1M window more than once. A session
  that ends at 300k never reaches that average.
- Context size is not the whole bill. Output tokens cost the same either way, and the task card
  adds its own calls (in the A/B above, which ran both arms at the same window, the plugin still
  cost about the same as native compaction). No total cost comparison between a small and a large
  window has been run.
- Whether tokens beyond a certain context size are billed at a different rate depends on the
  model and the plan. That is not counted here.

## Earlier measurements

- **Compaction loss audit.** 43 real compactions from day-to-day sessions were checked for facts
  the next turn needed but lost. Native compaction lost 2 of 27, the plugin 0 of 16. Native's
  losses were facts that were present in the summary but ignored, not facts missing from it.
- **Refusals.** In early versions (before 3.12), some sessions saw refusals after a seeded cut.
  Since the seed is framed as plugin memory (3.12.0), there have been none in more than 28
  compactions. A refusal guard (3.11.0) still sends the session to native compaction if one occurs.

## Offline replay

`tools/hook-replay/replay.mjs` runs the real hook module against the capture stores of recorded
sessions, at every recorded cut, and writes out each seed and its logs. It makes no model calls
and costs nothing. Every change to how seeds are built is checked this way before a live run:

```bash
HOOK_REPLAY_PLUGIN=plugin/compact node tools/hook-replay/replay.mjs <sandbox> [--cut N] [--options '<json>'] [--dump dir]
```
