# hook-replay parity: an A/B arm (3.43.2 live, 15 cuts)

```
node tools/hook-replay/replay.mjs ~/work/sandbox/arm-1            # all 15 cuts, table at the end
node tools/hook-replay/replay.mjs ~/work/sandbox/arm-1 --cut 4    # one cut in detail (runs everything before it)
node tools/hook-replay/replay.mjs ~/work/sandbox/arm-1 --rev c2553f2   # plugin exported from a commit
```

Extra flags:
- `--json <file>` writes the full report.
- `--keep` keeps the temp overlay that holds every write.
- `REPLAY_PROJECT_DIR` (default `proj`) names the sandbox subdirectory that holds the working copy; `REPLAY_JAIL_HOME` (default `/home/user`) is the HOME the recorded session ran with.
- `--no-regroup` and `--no-parallel-group` are ablations (see below).
- `--options '<json>'` replaces the live userConfig. The default is (with `<repo>` the clone root) `{"recallEnabled":true,"recallPluginRoot":"<repo>/plugin/compact","jevEnabled":false,"totalBudgetTokens":13000}`.

The replay loads the production `plugin/compact/compact.ts` from source and calls its own `register()`. It does not use a mirror. The `.js` to `.ts` specifiers are resolved by the same `registerHooks` used in `tools/real-replay`. A full run takes about 1.5 s, makes no network calls and runs no `claude`/`codex`. Both the working tree (3.44.0) and `--rev c2553f2` (3.43.2, the live build) give the results below. `compact.ts` is the same in both. Between the two, only `core/brief-check.ts` and the plugin metadata changed.

## Result

- **Outcome: 15/15** cuts match, including the fallback reason.
- **Log values: 15/15.** Every deterministic `key=value` the live hook logged for the cut is equal. This covers:
  - `sizeBefore`, `brief_tail_shift`, `compaction_pressure`, every `task_brief_shrunk` / `adopted_shrunk` step;
  - `task_brief_digest` pending/ready, labels, `constraints_skipped_paragraph`, `facts_omitted`, `adopted_files`, jev lines, `recall.build_started`, and the `brief_check` / `brief_push` arming lines;
  - nothing extra and nothing missing.
- **Plugin seeds: 10/10 byte-identical** to the seed record CC wrote to the transcript. Every `## ` section is therefore within 5% (all at 0%). The tail matches in message count, chars and content identity, in order.
- **Capture writes: all 15 cuts and all 16 turn.complete calls match.** This compares the size of every `segment`, `watermark`, `compaction-pressure` and `s4-cut-fresh` write, in order, against the CC debug log's `$.fs.write` lines.
- **Final state equals the sandbox**:
  - `segment-000001.json` (321 records), `watermark.json` and `compaction-pressure.json` are byte-identical.
  - `timeline.json` has the same segments.
  - Recall generations: 29 in the replay and 29 live. The generation numbers at each cut also equal the ones in `embed.log`: cuts 1..15 → 2, 4, 5, 8, 9, 10, 13, 16, 17, 20, 22, 24, 25, 26, 28.
  - Manifests 27 and 28 match on cutoff byte. For 29, see gap 4.
- **Audit**:
  - no path outside the jail was touched;
  - no file newer than its event was read;
  - 7 files that hold live end state are hidden from the hook, because the replay rebuilds them itself: capture segment, watermark, pressure, and the `s4-*` flags.

## Per cut

In the "Live seed / replay" column, the slash separates live chars from replay chars. In the "Tail live / replay" column, `6·15738` means 6 messages and 15738 chars. In the "Shrink steps" column, `a750` is `adopted_shrunk=750`.

| Cut | Line | Run | Live outcome | Replay | sizeBefore | Brief tail shift | Pressure | Shrink steps | Log values (n compared) | Writes | Live seed / replay (chars) | Sections ±5% | Tail live / replay |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 140 | r13-a | plugin | same | 26795 | 2971 | state_missing | – | yes (22) | yes | 36233 / 36233 exact | 19/19 | 6·15738 / 6·15738 |
| 2 | 241 | r12-a | plugin | same | 26153 | 2987 | 1 | – | yes (22) | yes | 48466 / 48466 exact | 18/18 | 5·2581 / 5·2581 |
| 3 | 332 | r12-a | plugin | same | 19834 | 2987 | 2 | – | yes (22) | yes | 43096 / 43096 exact | 18/18 | 10·8607 / 10·8607 |
| 4 | 421 | r17-a | plugin | same | 24686 | 4358 | 3 | – | yes (22) | yes | 51660 / 51660 exact | 23/23 | 3·328 / 3·328 |
| 5 | 476 | r17-a | plugin | same | 21434 | 4358 | 4 | – | yes (22) | yes | 45683 / 45683 exact | 23/23 | 3·6190 / 3·6190 |
| 6 | 550 | r17-a | fallback: budget | same | 25335 | 4358 | 5 | 4263, 3622, 3522, 0, a750, a0 | yes (28) | yes | – | – | – |
| 7 | 653 | r5-a | fallback: budget | same | 20859 | 3550 | 5 | 3801, 3701, 3601, 0, a750, a0 | yes (29) | yes | – | – | – |
| 8 | 782 | r4-a | plugin | same | 28895 | 3269 | 5 | – | yes (23) | yes | 40860 / 40860 exact | 16/16 | 4·11087 / 4·11087 |
| 9 | 865 | r4-a | plugin | same | 21259 | 3269 | 6 | – | yes (23) | yes | 40713 / 40713 exact | 16/16 | 8·11219 / 8·11219 |
| 10 | 941 | r3-a | fallback: budget | same | 21457 | 4088 | 7 | 3144, 3044, 2944, 0, a750, a0 | yes (29) | yes | – | – | – |
| 11 | 1060 | r3-b | plugin | same | 26860 | 4088 | 7 | 5911 | yes (24) | yes | 42069 / 42069 exact | 10/10 | 11·9881 / 11·9881 |
| 12 | 1130 | r2-a | plugin | same | 23528 | 3785 | 8 | 5618, 5451 | yes (25) | yes | 36503 / 36503 exact | 11/11 | 3·358 / 3·358 |
| 13 | 1210 | r2-a | plugin | same | 20004 | 3785 | 9 | 5479 | yes (24) | yes | 39516 / 39516 exact | 9/9 | 17·12463 / 17·12463 |
| 14 | 1315 | r2-a | fallback: budget | same | 22245 | 3785 | 10 | 5039, 4581, 4108, 0, a750, a0 | yes (29) | yes | – | – | – |
| 15 | 1470 | r2-b | fallback: insufficient_reduction | same | 16360 | 3785 | 10 | 5488 | yes (24) | yes | – | – | – |

The section count differs per cut because the embedded task brief brings its own `## ` headings. The per-section listing is in the `--cut N` output.

## How each input is rebuilt

### Runs

`out/chain.txt` gives 8 tasks × (a, b) = 16 `claude -p` runs. Each run starts at a `queue-operation` enqueue group in the transcript, and the two counts are asserted equal. For each run, the replay:
- calls `register()` once, so the module's per-process caches (`transcriptPathCache`, `adoptedChain`) start empty as they did live;
- dispatches `session.compact` at each `compact_boundary` in the run (with `trigger: 'auto'`);
- dispatches one `turn.complete` (`reason: 'answer'`) after the run's last record. Each live debug log has exactly one `turn.complete settled`.

`prompt.submit` and `classic.*` are not called. Their disk output is taken from the sandbox, time-cut (see "Time-cut host").

### `event.messages`

These are the user/assistant records after the latest boundary, in file order. `isMeta` records and attachments are left out. Each record becomes the SessionMessage shape `{role, text, toolUses, toolResults?}`, with no extra fields, because the hook hashes the JSON.

- **After a native boundary**: core's summary record, then the records in `compactMetadata.preservedMessages.uuids`, then the later records.
- **After a plugin cut**: the seed and tail records.

Two CLI behaviours had to be inferred from evidence:

1. **Parallel tool calls are grouped in `session.compact`'s list.** The order is all fragments of one assistant message, then their results (a a u u). The transcript writes them interleaved (a u a u). Evidence:
   - the live segment holds those records in a a u u order where a cut captured them first (cuts 5 and 8);
   - in a u a u order where a `turn.complete` captured them first (r16-a, r17-a, r17-b, r5-a);
   - cut 8's tail came back from the hook as a a u u.

   So the replay groups for `session.compact` only. `turn.complete` gets the file order. With `--no-parallel-group`, two segment records swap places and the final segment no longer matches. Outcomes, log values and seeds still match.

2. **Resume regroup.** Some resumed runs log `ensureToolResultPairing: ... assistant(id=msg_X, tool_uses=[A,A])`. In those runs CC had also loaded the pre-boundary fragments of message X and their tool result, next to the copies the plugin's tail kept. The replay inserts them:
   - pre fragments before the first post fragment;
   - the pre result before the post result.

   This happens only when the run's debug log shows that line before its first cut:
   - r13-b and r12-a: cut-1 stretch, lines 128, 129, 130, 134;
   - r12-b and r17-a: cut-3 stretch, lines 323, 324, 326.

   With `--no-regroup`, cuts 2 and 4 lose their exact `sizeBefore` (off by 3728 and 76) and their seeds. Log values drop to 13/15 and exact seeds to 8/10. The insertion order inside the group cannot be checked separately; it is only confirmed by the exact seeds and tails.

### Time-cut host

The `$` host is built per event, with T = the live timestamp of that dispatch's `compact.sizeBefore` line (or of `turn.complete settled`).

**Path mapping**
- Jail `$HOME/.claude/exovault` → `sandbox/exovault`.
- Jail `$HOME/.claude/projects` → `sandbox/projects`.
- Sandbox paths map to themselves.
- Anything else is refused and listed. No such access happened.

**Writes**

Writes go to a temp overlay under `os.tmpdir()`, and reads look there first. Nothing is written into the sandbox, and the overlay is deleted at exit.

**Capture dir (`proj/.exovault/s4-capture/<sid>`)**

This belongs to the replay. Segments, watermark, pressure and flags all start empty and are rebuilt by the replayed handlers. Only `adopted.json` and `adopted/*` (written by `prompt.submit`) come from disk, and only if their mtime ≤ T.

**Recall dir (`exovault/recall/<sha256(sid)>`)**
- `briefs/briefs.json` is served with only the entries whose `at` ≤ T.
- `briefs/*.md` and `*.digest.md` are visible if their mtime ≤ T. The digests are written by the detached `brief.mjs`, and this rule is what makes `task_brief_digest` pending/ready match at every cut. For example, cut 4 at 09:43:55.7 sees no digest, and cut 5 at 09:44:30.9 sees the one written at 09:44:30.67.
- `timeline.json` comes from the emulated build (below).
- Everything else (generations, vectors, logs) is hidden.

**Other sandbox files**

These are shown as they are now. A read of a file whose mtime is after T is recorded; there were none. Existence checks of directories (the work-state probe dir) are not time-cut.

**Session values**
- `session.id`: `out/sid`.
- `session.cwd`: the `cwd` of the last transcript record before the event. It agrees with the directory the live git probe ran in at all 15 cuts.
- `env.get`: `HOME=/home/user` and nothing else, so no credentials are read.
- `http.fetch`: throws.

**Clock**
- `clock.now` is T.
- `sleep(0)` yields one macrotask.
- A positive sleep, i.e. the 30 s fallback race or the 2 s adopted wait, only ends by abort.
- `after()` never fires.

**Detached processes**
- `recall/launch.mjs` records a build and exits 0, so `recall.build_started=1` is logged as live.
- `brief-check.mjs` and any other `node` process never settle.
- `git` is emulated (see gap 2).

**Recall build emulation**

This follows `recall/build-worker.mjs` rules, using the real `recall/timeline.mjs`:
- The cutoff is the transcript bytes before the event. CC's trailing bookkeeping lines (last-prompt, mode, atis-latch, cost-state) are excluded.
- A turn build is skipped below 32 KiB of growth.
- Any build not newer than the published one is skipped.
- A build is published before the next event. Live builds took about 1 s and events are minutes apart.

**Native `next()`**

It returns core's summary plus the preserved records as `messages`. The hook derives its fallback watermark from them, and the following segment writes match.

## What does not match, or cannot be reproduced

1. **Three logged values are redacted in logs from plugin 4.7.2 and older**: `seed.task_brief_tokens`, `seed.work_state_tokens` and `seed.session_map_tokens`. CC's debug log redacts any key containing "token". Since 4.7.3 (S5m) the keys are `seed.task_brief_size`, `seed.work_state_size` and `seed.session_map_size` and are compared like any other. `replay.mjs` drops `[REDACTED]` keys, and for a live log of 4.7.2 or older it also drops the matching `_size` keys of the replay, which have no live twin there.
   - For the 10 plugin cuts, the byte-identical seeds contain those exact sections, so the values follow.
   - For the 5 fallback cuts no seed survives, so these three values are unverified there. The shrink steps computed from them do match.
2. **The git state at a cut is not on disk.** The `git status` / `git worktree list` output is emulated:
   - the branch comes from the transcript's `gitBranch`;
   - the one worktree is the sandbox repo;
   - the changed-file count is **borrowed from the live seed's "Git at the cut" line** for the 10 plugin cuts;
   - it is **assumed 0** for the 5 fallback cuts. For example, at cut 6 the live status output was 429 chars, so files had changed.

   For plugin cuts this makes the Git line match by construction, not by reproduction. For fallback cuts the count changes at most a few chars of the work-state section. All shrink steps still match, but the work-state section itself is not reproduced exactly there.
3. **The detached brief check is not run.** It produces `brief_check.ready=N` and the later `s4-brief-check.json` contents, which feed only `classic.Stop`, not compaction. These are excluded from the comparison. Only the arming (`brief_check.armed=1`, 5-byte write) is compared.
4. **Recall manifest 29 is at cutoff 5197323 in the replay and 5197832 live.** At r2-b's end, the `last-prompt`/`mode`/`atis-latch` lines (509 bytes) were already on disk when the launcher ran. At r2-a's end (generation 27, matching) they were not. Which bookkeeping lines CC flushes before `turn.complete` is not visible in the logs. The timeline segments are unaffected, because those lines carry no messages, and so is every generation decision.
5. **The resume regroup and the parallel-call grouping are evidence-driven, not taken from CC source.** The replay applies the regroup only where the run's debug log shows the duplicated tool_use ids. Why r2-a resumed without one, although its stretch also starts with a plugin tail, is not explained. On another session these rules may need new evidence.
6. **`briefs.json` is time-cut by each entry's `at`.** This assumes the index is append-only and that `at` is the save time. That holds here, because each brief's `.md` mtime equals its `at` to within 1 ms. A rewritten or pruned index would not be reconstructable.
7. **Not replayed**: `prompt.submit` and `classic.PreToolUse`/`PostToolUse`/`Stop`. Their effects on compaction are disk files, taken time-cut from the sandbox (adopted copy, briefs). The original adopted file (`nd/house-rules.md`) no longer exists, so the saved copy is used. Live never logged `adopted.refreshed`, so the copy was what live quoted too.
8. **Wall-clock values are excluded from the comparison**: `dense.jev_ms` and hook durations. Jev is disabled in this arm, so no Jev path is exercised.

## Limits found in an external review (2026-10-03)

- Fixed-trace replay: every cut is rebuilt from the live transcript, so after a cut whose outcome changes, the later
  cuts still see the live (old) context. Only the changed cut itself is a clean comparison; enable a change only at
  one cut (as the review's `only-cut-N` runs did) to test it in isolation.
- Fixed: a native fallback result now uses only this cut's summary, never one from a later boundary.
- Fixed: `--dump` writes the native summary plus its preserved messages, so content checks compare the whole
  model-visible context on both sides.
- Git state on fallback cuts is assumed clean (0 changed files); on plugin cuts it is copied from the live seed.
