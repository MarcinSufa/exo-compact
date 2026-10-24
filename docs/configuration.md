# Configuration

Every option is a plugin `userConfig` value from `plugin/compact/.claude-plugin/plugin.json`; this page is generated from it (descriptions verbatim).

Set options with `claude plugin install exo-compact@exo-compact --config key=value`, or in settings:

```json
{ "pluginConfigs": { "exo-compact@exo-compact": { "options": { "briefDigestModel": "" } } } }
```

With `--plugin-dir` (the launcher) the plugin is keyed `exo-compact` / `exo-compact@inline`; the launcher passes `recallEnabled`, `recallPluginRoot` and `jevEnabled` itself.

## Core

| Option | Type | Default | Description |
|---|---|---|---|
| `recallEnabled` | boolean | `true` | Build and query a local, session-scoped history index. |
| `retentionDays` | number | `30` | Delete the recall index and the capture directory of a session untouched for this many days (checked at most once a day by the recall build worker; captures under a project's own .exovault are left alone). 30 matches Claude Code's default for keeping transcripts; 0 keeps everything. `node setup.cjs cleanup` runs the same retention by hand, with a dry run and a backup. |
| `recallPluginRoot` | string | `""` | Absolute directory of this plugin, used to start the recall index worker. Empty falls back to CLAUDE_PLUGIN_ROOT. |
| `interactiveOnly` | boolean | `true` | Leave -p runs, the SDK and any run started from inside another session on native compaction; terminal sessions and sessions started from the VS Code or Cursor extension count as interactive. On by default, so a plugin enabled globally does not change scripted runs; set false to use exo-compact in -p and SDK runs too. A return to native compaction under this option logs `compact.fallback=interactive_only origin=compact entrypoint=<value>`. A benchmark or A/B made of `-p` runs must set `interactiveOnly=false`, or both sides use native compaction. |
| `timeoutMs` | number | `30000` | Maximum duration in milliseconds for the S4 compaction attempt. |
| `contract` | string | `""` | Project instructions to carry into the compacted context. |
| `realTokenCount` | boolean | `true` | Size the seed and the kept messages by an estimate of real tokens instead of characters / 4. |
| `totalBudgetTokens` | number | `20000` | Tokens for the seed plus the kept tail after a cut; seed, dense notes and tail budgets scale from it. Counted as real tokens (20000 by default); with Real token count off it is characters / 4 and 13000 is the old default. |
| `cardTotalBudgetTokens` | number | `8000` | Tokens for the seed plus the kept tail after a cut once a task card exists (tail 3/8, notes 1/8, seed the rest); about what native compaction keeps. |

## Seed contents

| Option | Type | Default | Description |
|---|---|---|---|
| `denseNotes` | boolean | `true` | Keep specific details from earlier user, assistant, and tool activity in the seed. |
| `toolOutputNotes` | boolean | `true` | Keep safe lines from Bash results in dense working notes. |
| `workState` | boolean | `true` | Keep the session directory, Git state, tasks, and background work in the seed. |
| `workStateProbe` | boolean | `true` | Check Git status and worktrees at compaction time. |
| `currentValues` | boolean | `true` | Keep in the seed the newest value of each thing the user changed in a message ("set X to 6", "X is now 11"), without the earlier values. |
| `sessionMap` | boolean | `true` | Put one line per earlier compaction segment (date, the user's asks, edited files, commits) in the seed, from the recall index; needs recallEnabled. |
| `adoptedFiles` | boolean | `true` | Copy a rules file the user tells the model to read and follow when the request is sent, and quote it in every seed. |
| `taskCard` | boolean | `true` | Keep a short task card written by the session's own model (a background fork as the context fills) and put it in the seed instead of the whole brief; once a card exists a cut keeps about 8000 tokens (seed + kept messages). |
| `sinceCard` | boolean | `true` | With a task card in the seed, add a "Since the card" section: one line per tool call made after the card was written and before the kept messages (files written, commands run and their outcome), at most 500 tokens, no model call. Needs taskCard. |
| `taskBriefs` | boolean | `true` | Save a long request (2,500+ characters) verbatim when it is sent and put its path and checklist in the seed; needs recallEnabled. |
| `fullBrief` | boolean | `true` | Put the newest saved task brief in the seed whole and verbatim when it is at most 24,000 characters; the tokens it needs come out of the kept tail. Needs taskBriefs. |
| `briefDigestModel` | string | `"sonnet"` | Model alias for the background `claude -p` call that writes a saved brief's checklist (one call per brief). Used only with `taskCard` off; with the card on (the default) no checklist is written. Empty turns it off and the seed shows the brief's start. |

## Session recall

| Option | Type | Default | Description |
|---|---|---|---|
| `recallVectors` | boolean | `true` | Also embed the session index with a small local model (multilingual-e5-small on the CPU, nothing leaves the machine) so searches match by meaning. The first use installs about 280 MB into ~/.claude/exovault/recall-runtime in the background. |

## After a cut

| Option | Type | Default | Description |
|---|---|---|---|
| `briefCheck` | boolean | `false` | After a cut whose seed points at a saved task brief, block the main loop's first stop once with the brief lines about files, tests, checks, exact strings and frozen parts; needs taskBriefs. |
| `briefPush` | boolean | `false` | After a cut whose seed points at a saved task brief, a call that writes a file (Write, Edit, or a Bash command that writes one) and a short message get the newest brief's lines for it as context, each line once per cut; a new brief turns it off until the next cut. |
| `sessionPush` | boolean | `true` | After a cut, each user message is searched in the session index line by line; transcript lines a compaction removed that share a rare name, id or code with the message go with it as context (at most 1,500 characters, each line once per cut). Needs recallEnabled. |
| `briefLimits` | boolean | `true` | After a write, the lines it added (git diff against HEAD, a new file whole) are checked against the line-length limit the newest saved task brief states (a tracked file that already had longer lines is skipped); only a broken limit adds a short note. Needs recallEnabled. |

## Jev (TypeSafe, opt-in)

| Option | Type | Default | Description |
|---|---|---|---|
| `ruleCheck` | boolean | `false` | Sends the final message and the uncommitted diff to Jev (TYPESAFE_API_KEY) at every main-loop stop with a task card, and blocks once with the card rules Jev finds broken; a clean turn passes with nothing pasted. Its own opt-in, independent of jevEnabled; jevDenyList applies. Needs taskCard. |
| `jevEnabled` | boolean | `false` | Privacy rule (spec v3.4 §3.3, §privacy): J is off by default. Per-project opt-in; set true only for a project where sending span text to TypeSafe's Jev is acceptable. Also lets Jev rank session-search results (search_session sends the query and up to 20 redacted excerpts). |
| `jevDenyList` | string | `""` | Comma-separated substrings of a project's cwd that keep J off even when jevEnabled is true (for example client repo path fragments). Matched against the session cwd. |
| `jevModel` | string | `"jev-latest"` | The Jev model id requested for choice questions and checked in the response (K4: a mismatch maps to selector D). |
| `jevPerCallTimeoutMs` | number | `4000` | Timeout in milliseconds for one Jev batch request; a batch that misses it falls back to selector D. |
| `jevTotalBudgetMs` | number | `10000` | Total time in milliseconds selector J may spend across every Jev call in one compaction; once spent, every remaining span falls back to selector D. |
| `jevDenseRerank` | boolean | `true` | When Jev is enabled, Jev re-ranks working-note candidates against the current work at each cut. |
| `jevDensePerCallTimeoutMs` | number | `3000` | Maximum duration in milliseconds for one dense-note reranking request. |
| `jevDenseTotalBudgetMs` | number | `5000` | Maximum milliseconds spent on dense-note reranking at one compaction cut. |

## Environment

| Variable | Used by | Meaning |
|---|---|---|
| `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` | Claude Code | Not needed: the plugin loads without it on every supported version (checked on 2.1.278, 2.1.284 and 2.1.292). The launchers still set it. |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Claude Code | Auto-compact window in tokens (`S4_WINDOW` in the launcher). |
| `TYPESAFE_API_KEY` | Jev features | TypeSafe API key; needed only for `ruleCheck` / `jevEnabled`. `setup.cjs doctor` warns when one of them is on and the key is missing, rejected or out of credit. |
| `S4_WINDOW`, `S4_JEV=1`, `S4_SKIP_DOCTOR=1` | `launch/exo-compact.sh` | Window, Jev ranking on, skip preflight (`-Window`, `-Jev`, `-SkipDoctor` in PowerShell). |
