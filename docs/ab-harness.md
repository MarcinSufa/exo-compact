# A/B harness

This guide covers `tools/task-ab/task-ab.mjs`. It runs the work after a saved
compaction point. It does not replay the whole original session.

## What is compared

The arms are `native` and `s4` (the exo-compact memory arm). For one task, both
arms receive the same request, the same conversation since the selected cut,
the same model, and separate copies of the repository at the task's parent
commit. `native` receives the captured native summary. `s4` receives the
captured exo-compact seed and its `search_session` recall tool. Each arm works
in its own checkout. A paired item is one task and one repetition run once per
arm; it is not a multi-task session in which later tasks inherit earlier work.

The request comes from the task JSON. The runner finds the user transcript
event whose timestamp matches `askTs`, selects the latest dump cut before that
event, and puts the saved memory, conversation since the cut, and request into
one prompt. By default the model is inferred from the transcript. The task
checkout starts at `base`; test files from `commit` are copied over the result
for scoring.

The default jail uses bubblewrap. It overlays the caller's home, `/work`,
`/tmp`, `/var/tmp`, and `/root` with temporary filesystems, then exposes the
recall code read-only, the cut sandbox, and the task checkout. It also makes
the task checkout available at its original path. The Claude process keeps the
caller's `HOME` value, but that home path is masked; `.claude.json` and
`.claude/.credentials.json` are bound back in, as are existing `.nvm` and
`.local` directories. The recall MCP server gets its own sandbox `HOME`.
Network access remains available. The jail is partial: `/` is initially
bound to the host filesystem, and the runner does not set or isolate a custom
`CLAUDE_CONFIG_DIR` outside the masked home. With `TASKAB_JAIL=0`, no jail is
used.

The Claude command reads project settings only, uses a strict MCP config,
disables hooks, and does not pass `--plugin-dir`. The `s4` arm supplies the
recall MCP server directly. This is a comparison of saved post-compaction
memories, not a live test of the plugin's compaction hook.

Each invocation uses `-p`, `--model`, stream JSON, verbose output, no session
persistence, project-only setting sources, strict MCP config, tool and
permission lists, `--max-turns`, and `--max-budget-usd`. The `native` arm has
no MCP server; `s4` adds `mcp__exovault-recall__search_session` with the
sandbox `HOME`. Common tools are Bash, Read, Edit, Write, Grep, and Glob.
Bash commands for Claude, tmux, curl, wget, ssh, psql, herdr, and codex are
denied. `--effort` is passed only when `TASKAB_EFFORT` is set.

For a separate live A/B made of `claude -p` chains, set the plugin option
`interactiveOnly` to `false`. Its default is `true`, and scripted `-p` runs
then fall back to native compaction. This runner does not set that option: it
sets `disableAllHooks: true` and has no `interactiveOnly` flag or environment
variable. Changing the setting alone will not turn this replay into a live
plugin-hook test.

## Inputs and command line

The positional `<tasks.json>` is an array of task records. At minimum, a usable
record needs `id`, `usable`, local `repo`, git `base` and `commit`, `tests`,
`target`, `keep`, `transcript`, `ask`, and `askTs`. `cwd` is optional and
defaults to `repo`. `target` contains exact test case names that fail at
`base` and pass at `commit`; `keep` contains cases that pass at both commits.
The runner reads these lists; it does not generate or validate them for a run.

`--dump` points to JSON files named `cut-*.json`. A usable cut needs `source`,
`sessionId`, `boundaryLine`, `boundaryUuid`, `native`, `nativeFull`, and
`s4Full`. `source` and each task's `transcript` must point to readable JSONL
transcripts. The runner copies the transcript through the cut into its
sandbox and builds the recall index there.

| Argument | Meaning |
|---|---|
| `<tasks.json>` | Required task array. |
| `--dump <dir>` | Required saved replay cuts. |
| `--out <dir>` | Required output directory. |
| `--plan` | Print prepared tasks and missing run count. This is also the default when neither `--run` nor `--report` is used. |
| `--run` | Run missing task, arm, and repetition records. |
| `--report` | Build `report.md` from records already in `--out`. |
| `--arms native,s4` | Arms to run; default is both. |
| `--reps 3` | Repetitions numbered from 1 through this value; default is 3. |
| `--only id,id` | Restrict work to these task IDs. |

The runner requires the positional task file and both `--dump` and `--out`,
including in report mode. `--report` takes precedence if combined with
`--run`.

## Run, resume, and rerun

Use Node 22.15 or newer, Git, Claude Code CLI with model access, and bubblewrap
(`bwrap`) on the default jailed path. The command below is the minimal paired
run once you have supplied a task file and replay dump:

```bash
node --experimental-strip-types --no-warnings tools/task-ab/task-ab.mjs \
  ./tasks.json --dump ./replay-dump --out ./ab-output \
  --arms native,s4 --reps 1 --run
```

Records and raw Claude stream output land in `--out` as
`<task>.<arm>.<rep>.json` and `<task>.<arm>.<rep>.raw.jsonl`.
`--report` writes `report.md` in the same directory. Prepared cut transcripts
and recall indexes go under `TASKAB_SANDBOX` (default `/tmp/taskab`). Run
checkouts are removed after scoring unless `TASKAB_KEEP=1`.

To resume, repeat the same command. Existing result JSON files are skipped;
increasing `--reps` adds only the new repetition numbers. To rerun one failed
arm and repetition, remove that result JSON, then select its task and arm:

```bash
rm ./ab-output/<task-id>.s4.1.json
node --experimental-strip-types --no-warnings tools/task-ab/task-ab.mjs \
  ./tasks.json --dump ./replay-dump --out ./ab-output \
  --only <task-id> --arms s4 --reps 1 --run
```

A run that writes a result with `ok: false` is still considered present and
will not be retried automatically. Errors before a result file is written are
picked up on the next run. The spend cap resets for each invocation.

### Environment variables

Unset values use these defaults:

| Variable | Default | Effect |
|---|---|---|
| `TASKAB_MODEL` | Most common assistant model before the request; `opus` if none is found | Model used by both arms. |
| `TASKAB_EFFORT` | Unset, so Claude CLI default | If set, passed as `--effort`. |
| `TASKAB_MAX_TURNS` | `80` | Per-run Claude turn limit. |
| `TASKAB_RUN_USD` | `10` | Per-run `--max-budget-usd` limit. |
| `TASKAB_MAX_SPEND` | `20` | Per-invocation reported-cost cap checked before starting a job; concurrent jobs can exceed it. |
| `TASKAB_JOBS` | `2` | Concurrent arm runs. |
| `TASKAB_SANDBOX` | `/tmp/taskab` | Root for cut data and temporary checkouts. |
| `TASKAB_CLAUDE` | `claude` | Claude CLI executable. |
| `TASKAB_SINCE_TOKENS` | `20000` | Approximate budget for the conversation since the cut; newest events are kept first, estimating tokens as characters divided by four. |
| `TASKAB_JAIL` | `1` | Set to `0` to disable bubblewrap. |
| `TASKAB_TIMEOUT_MS` | `3600000` | Per-run timeout in milliseconds; timeout sends `SIGTERM`. |
| `TASKAB_KEEP` | `0` | Set to `1` to keep scored run checkouts. |

Claude inherits the caller's environment. Build and test subprocesses inherit
it except `NODE_TEST_CONTEXT`, and set `CI=1` and `FORCE_COLOR=0`.

Verification uses `npm ci --offline` for a task repo with `package-lock.json`,
and `pnpm` for a pnpm lockfile or workspace. Files importing `node:test` run
with Node; other tests use `npx vitest`. For an npm-only run, use repos without
a pnpm lock/workspace and with `node:test` tests. Offline npm dependencies must
already be in the npm cache.

## Reading the output

Each result JSON contains per-run metrics. `report.md` averages runs by arm.

| Metric | Meaning |
|---|---|
| `cost` | Last parsed Claude result's `total_cost_usd`; report shows the mean per run. |
| `inputTokens` | `input_tokens` plus cache creation and cache read input tokens from the result. |
| `outputTokens` | Result `output_tokens`. |
| `turns` | Result `num_turns`. |
| `seconds` | Wall time around the Claude CLI invocation, rounded to a second. It excludes hidden tests and build time. |
| `reward` | Share of `target` cases passing. `passed` and `target` give its numerator and denominator. |
| `regressions` | Count of `keep` cases that fail or are missing after the run. |
| `solved` | All target cases pass and there are no regressions. |
| `toolCalls` / `recallCalls` | Count of assistant tool-use events, and the subset calling `search_session`. |
| `cut` / `split` | Selected input cut ID; `split` is `dev` or `heldout`, assigned from the transcript session ID. `cutsBefore` is task metadata only; run-time cuts are not counted. |
| `ok` / `exit` | `ok` means a final Claude result exists and is not marked as an error; `exit` is the CLI process exit code. |
| `changed` | Git status entries plus commits after the task base. |
| `built` | Build status (`n/a`, `ok`, or `failed`); it is not included in the summary table. |

The two gate tables compare `native` with each candidate. The first uses mean
`reward`; the second uses `solved` as a 0 or 1 reward. Repetitions are averaged
per task, and shared tasks are paired. With the default one standard error,
`better` and `worse` exceed the threshold; otherwise the verdict is a tie, with
lower cost preferred. Gate cost is **input tokens**, not USD. With fewer than
two paired units, the verdict is `too-few-units`; with no comparable data, it is
`no-data`.

This tool does not report session-rule checks, a count of run-time compactions,
or compact fallback events.

`total_cost_usd` is cumulative for a resumed Claude session. When aggregating,
group by `session_id` and take the last value per session; do not sum running
totals. This harness disables session persistence and parses the last result
event in each invocation.

Every model call is billed. One arm run can make multiple calls; `cost` comes
from Claude's `total_cost_usd`, with no separate price estimate.

## Data and reproducibility limits

The public repository includes the runner and scoring code, but not the
private `slices` project, task list, captured transcripts, or replay dump, so
it cannot reproduce the published `slices` results today. The public
`selfCheck` helper can derive target and keep cases for an already selected
task, but there is no public task discovery or manifest builder. An outside
user must supply a local Git repository, parent and task commits, tests,
matching transcripts, and cut dump files in the formats above, and either
precompute target and keep names or run `selfCheck` themselves.

Task records and cut dumps carry local repository and transcript paths. Use
paths available on the machine running the harness. There is no public task
discovery tool or sample data set that can be passed to the command unchanged.
