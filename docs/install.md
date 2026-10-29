# Install and run

The [README](../README.md#install) has the short version. This page has every detail: the
installer, the launcher, the manual install, how to check that it works, and how to remove it.

## Requirements

- **Claude Code ≥ 2.1.278.** The plugin loads with no extra flag (checked on 2.1.278, 2.1.284 and 2.1.292).
  The launchers still set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, which is harmless.
- **Node.js ≥ 22.15** on `PATH` (the recall MCP server and its workers run on it).
- **git**, for the installer.
- Linux or macOS. Windows has a PowerShell installer and launcher, but they have not been tested on a real Windows machine.
- About 280 MB of disk, only if local vectors are used. The first search installs them in the background.

Running the plugin needs no `npm install`; it has no runtime dependencies.

## Install from inside Claude Code

The plugin needs nothing else. In a Claude Code session run:

```
/plugin marketplace add MarcinSufa/exo-compact
/plugin install exo-compact@exo-compact
```

The marketplace also lists `exovault-s4-trigger`, an optional, experimental soft-trigger companion; the
install above installs only `exo-compact`.

Installed means enabled: the plugin is on for every project, session recall is on, and `claude -p` and SDK
runs stay on native compaction. A session checks the Node.js and Claude Code versions once and prints one
warning line if either is too old; the plugin then stays inert for that session. To keep it off for one
project run `node <plugin>/setup.cjs optout <dir>`; to keep it off everywhere run `setup.cjs disable ~`.
A session that is already running needs a restart.

To update, run these in Claude Code and restart it; a running session keeps the old version:

```
/plugin marketplace update exo-compact
/plugin update exo-compact@exo-compact
```

The marketplace is this repository's `main` branch, so both the install above and these updates take the newest
commit on `main`, released or not. To stay on released versions, use the installer below, which installs the tag of the
latest release.

**Upgrading from 4.7.x.** Before 4.8.0 an installed plugin did nothing until a flag file turned it on, and
`setup.cjs disable` only deleted that flag. From 4.8.0 an installed plugin is on everywhere, so if you installed it and
never enabled it, or turned it off with `disable` before 4.8.0, it is on after the update. To keep it off, run
`node <plugin>/setup.cjs disable ~`.

## Install with one command

The installer below is the alternative: it installs the tag of the latest release rather than `main`, and it
keeps a clone in `~/.exo-compact`, which the launcher, `tools/status.mjs` and `setup.cjs` use.

```bash
curl -fsSL https://raw.githubusercontent.com/MarcinSufa/exo-compact/main/install.sh | bash
```

On Windows, in PowerShell (untested on a real Windows machine):

```powershell
irm https://raw.githubusercontent.com/MarcinSufa/exo-compact/main/install.ps1 | iex
```

The installer does four things:

1. Asks two questions about Claude Code's auto-compact, on a terminal and only on the first install:
   whether to set the auto-compact window to 200000 tokens (or another number; `n` leaves your setting
   alone), and whether to turn auto-compact on. exo-compact runs only when Claude Code auto-compacts, and
   on a 1M model that is when 1,000,000 tokens fill. Without a terminal the answers are 200000 and on.
2. Clones the repository to `~/.exo-compact`, or updates the clone that is already there.
3. Runs the preflight check (`doctor`). On a Node.js or Claude Code that is too old it stops
   here, before anything is registered.
4. Registers the clone with Claude Code as a plugin and sets the plugin directory, the Node binary and the
   two answers (`autoCompactWindow`, `autoCompact`), then writes the answers to `~/.claude/settings.json`
   and prints what it changed. Session recall and `interactiveOnly=true` are the manifest defaults, so they
   are not set again. This is the [manual install](#install-by-hand) below. The plugin is on for every
   project; the installer writes no flag file.

Then start `claude` as usual. A session that is already running needs a restart.

Running the installer again updates the clone and the plugin. It sets only the plugin directory
and the Node binary again and asks nothing, so the other options stay as you left them; an
`EXO_COMPACT_WINDOW` or `EXO_COMPACT_AUTO` you pass is applied again.

| Variable | What it changes |
|---|---|
| `EXO_COMPACT_ENABLE_DIR` | Optional. A directory to also write a flag file in (`setup.cjs enable <dir>`); not needed, the plugin is on everywhere. `none` keeps it off everywhere (`setup.cjs disable ~`); use `setup.cjs enable <dir>` later. |
| `EXO_COMPACT_HOME` | Where the clone lives. Default: `~/.exo-compact`. |
| `EXO_COMPACT_REPO`, `EXO_COMPACT_REF` | The repository, and the tag or branch to install from. The default is the tag of the latest release (the installer on `main` names it), so a change merged to `main` is installed only once it is released; `EXO_COMPACT_REF=main` installs it before that. |
| `EXO_COMPACT_WINDOW` | Answers the first question without a prompt: the auto-compact window in tokens, 100000 to 1000000, or `0` to leave your setting alone. Anything else stops the installer before it clones. |
| `EXO_COMPACT_AUTO` | Answers the second question without a prompt: `1` turns auto-compact on, `0` leaves your setting alone. |

```bash
cd ~/work/my-project
curl -fsSL https://raw.githubusercontent.com/MarcinSufa/exo-compact/main/install.sh | EXO_COMPACT_ENABLE_DIR="$PWD" bash   # also flags this project
```

If you prefer to read a script before running it, download `install.sh` first and run it with `bash install.sh`.

## Run it with the launcher

The launcher needs no install. It loads the plugin for one `claude` process:

```bash
git clone https://github.com/MarcinSufa/exo-compact.git ~/.exo-compact
cd ~/work/my-project
~/.exo-compact/launch/exo-compact.sh
```

The launcher does four things:

1. Runs a preflight check (`doctor`).
2. Writes `.exovault/s4-compact-active` in the current directory.
3. Sets `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` for this process only (not needed since 2.1.278, harmless).
4. Starts `claude --plugin-dir …` with session recall on.

Any extra arguments go straight to `claude`.

**Scripted runs (`-p`).** The launcher prints its own messages (the doctor report and the enable
note) to stderr, so `~/.exo-compact/launch/exo-compact.sh -p "..." --output-format json` writes
only claude's JSON to stdout. Headless runs keep every notice line; see `notices` below.

> [!NOTE]
> With the plugin installed (by the installer or by hand) the launcher passes `interactiveOnly=true`, so `-p` and SDK
> runs stay on native compaction. Without an install, `-p` runs through the launcher use
> the plugin.

```bash
S4_WINDOW=500000 ~/.exo-compact/launch/exo-compact.sh   # larger auto-compact window
S4_SKIP_DOCTOR=1 ~/.exo-compact/launch/exo-compact.sh   # skip the preflight check
```

On Windows (untested):

```powershell
C:\path\to\exo-compact\launch\exo-compact.ps1 [-Window 500000] [-SkipDoctor]
```

The PowerShell launcher recognises only the exact (case-insensitive) `-PluginDir <dir>`,
`-Window <n>`, `-Jev` and `-SkipDoctor`; every other argument, including `-p`, goes to `claude`
unchanged and in order. The home directory is `HOME`, then `USERPROFILE`, then
`HOMEDRIVE`+`HOMEPATH`. Claude Code's own files are read from `CLAUDE_CONFIG_DIR` when it is set.

> [!NOTE]
> The capture store keeps excerpts of the session in the project's `.exovault/` (see
> [Privacy and cost](privacy-and-cost.md)). exo-compact writes `.exovault/.gitignore` with `*` there, so git ignores
> the directory without a change to the project's own `.gitignore`. A `.exovault/.gitignore` you wrote is kept.

## Install by hand

These are the commands the installer runs. Use them to install from a clone you made yourself:

```bash
claude plugin marketplace add ~/.exo-compact
claude plugin install exo-compact@exo-compact \
  --config recallPluginRoot="$HOME/.exo-compact/plugin/compact"
```

The commands assume a clone in `~/.exo-compact`. The plugin options store
absolute paths, so if you move the clone, run this install step again with the new location.

`recallEnabled` and `interactiveOnly` default to `true` in the manifest. With `interactiveOnly=true`, `claude -p` and SDK runs stay on native compaction. Check the install
in an interactive session (start `claude` in a flagged directory), not with a `-p` run.

Notes on the installed plugin:

- **Where it acts.** The plugin acts in every project. A flag file or an opt-out file is looked up
  from the session's project root upward (and from the shell's working directory, see below); with
  neither, the capture store goes to your home directory.
- **Scripted runs.** `interactiveOnly=true` keeps `claude -p`, SDK runs and any run started from inside another
  session on native compaction. A session started from the VS Code or Cursor extension counts as interactive.
- **Launcher.** You can still use the launcher with the plugin installed. It detects the install and
  passes only options, so the plugin is not loaded twice.
- **Updates.** Run the installer again: it moves the clone to the tag of the latest release. By hand: in the clone,
  `git fetch origin tag vX.Y.Z` and `git checkout --detach vX.Y.Z` (the installer's clone is a detached tag, where
  `git pull` fails), then `claude plugin marketplace update exo-compact` and `claude plugin update exo-compact@exo-compact`.
  Only new sessions pick the update up.

## Check that it works

- **Preflight.** `node ~/.exo-compact/plugin/compact/setup.cjs doctor` checks Node, Claude Code and the recall
  files. With `--jev`, or when `ruleCheck` or `jevEnabled` is on in your Claude Code settings, it also checks
  the TypeSafe key and warns when the key is missing, rejected, or the account has no credit. With Jev off it
  prints `WARN Jev: off (optional)` with the two steps to turn the rule check on; S4 and recall work without it.
  It also names the copy Claude Code loads (version, commit, folder) and compares its version with the latest release
  tag on the remote (`git ls-remote`, nothing is fetched). Only when the remote has no release tags is the commit
  compared with `main` (the last fetched `origin/main` when the remote cannot be reached). Behind is a warning with
  the update command; restart sessions after it. `--preflight` skips it.
  Exit codes: 0 when nothing failed (warnings included), 1 when a check failed (Node or Claude Code too old,
  recall files missing), 3 when Jev was asked to run (`--jev`) and does not work.
- **In a session.** After the first compaction, the first message of the new context starts with
  `[[exovault:s4-seed:v1]]`.
- **Afterwards.** `node ~/.exo-compact/tools/status.mjs` (or `npm run status` in the clone) lists recent sessions. For each
  compaction it shows the kind (`s4` or `native`), the trigger, tokens before and after, and the
  duration. It reads metadata only, never message content.

```bash
node ~/.exo-compact/tools/status.mjs                # interactive sessions with exo-compact in the last 2 days
node ~/.exo-compact/tools/status.mjs --headless     # also -p / SDK runs, which are left out by default
node ~/.exo-compact/tools/status.mjs --days 7       # further back; --all also lists sessions without it
```

Runs started with `-p` are not listed unless you add `--headless`.

`S4 fell back to native` means the plugin gave that cut to native compaction. That is safe, and
it happens by design when a seed cannot fit. `reason=` on that line says why.

`reason=insufficient_reduction` means S4's seed and kept tail would not have been at least 25% smaller
than the messages, so native compaction ran. That is expected in a short session. The line shows the
message tokens S4 counted (for example `S4: 7.5k message tokens -> 6.1k`), which leave out the system
prompt and tools that Claude Code's own `76k -> 12k` includes. To see an S4 cut in a test, run
`/compact` in a session with at least about 20k tokens of messages: on this machine the seed alone was
about 3.4k tokens at the median and 7.5k at the 90th percentile (222 seeds, 2026-10-19, estimated
from characters at about 3.5 per token).

**In the VS Code or Cursor extension** the plugin's notice lines are not drawn in the chat: the extension has no
place for them (read from the extension's files for Claude Code 2.1.296, not seen in its window). There, the reason
for a fallback is the `reason=` in `status.mjs` and the line in `<project>/.exovault/s4-capture/<session id>/notices.log`,
and a rule check that cannot work shows in `setup.cjs doctor`.

## Opt out and uninstall

```bash
node ~/.exo-compact/plugin/compact/setup.cjs disable [dir]   # remove the flag and keep it off below dir
node ~/.exo-compact/plugin/compact/setup.cjs optout  [dir]   # keep exo-compact off below dir (writes .exovault/s4-compact-off, removes a flag there)
node ~/.exo-compact/plugin/compact/setup.cjs optin   [dir]   # undo optout
```

Walking up from the session's project root (where `claude` started, or where `/cd` took it), the
nearest directory that holds either flag file decides; a shell `cd` out of the project does not turn
the plugin off. The shell's working directory is walked too: an opt-out found there wins, and when
the root walk finds no flag file at all, a flag found above the working directory enables the plugin.
With no flag and no opt-out on either walk, the plugin is on and keeps its capture store in the home
directory, unless the home directory holds an opt-out. Starting plain `claude` without the launcher,
and without an install, never loads the plugin.

To uninstall, run:

```bash
claude plugin uninstall exo-compact@exo-compact
claude plugin marketplace remove exo-compact
rm -rf ~/.exo-compact
```

Then clean up what the commands leave behind:

- **Env flag.** Remove `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` from `~/.claude/settings.json` if an older install told you to add it.
- **Project data.** Delete `<project>/.exovault/` (capture store, `notices.log`, flag and opt-out files).
  `disable` and `optout` write a file there, so this folder stays until you delete it.
- **Recall data.** Delete `~/.claude/exovault/`. The recall store always lives under
  `<home>/.claude/exovault/recall`, even when `CLAUDE_CONFIG_DIR` points elsewhere.

## Optional: Jev rule check

[Jev](https://typesafe.ai) is a judgement model run by TypeSafe. It is fully optional. Without
it, the plugin works as described and every Jev step falls back to a deterministic rule.

- **What it adds.** The rule check (`ruleCheck=true`) asks Jev, at the end of a turn, which rules
  on the task card the reply or the diff breaks. When Jev finds a broken rule, the stop is blocked
  once and the model is shown that rule. The A/B test in [benchmarks.md](benchmarks.md) ran with the rule check off.
- **What it needs.** A TypeSafe API key in `TYPESAFE_API_KEY`, set in the shell that starts Claude Code.
- **What it sends.** The final message, the uncommitted diff and the card rules go to
  `api.typesafe.ai`. Secrets are redacted first.
- **Where to keep it off.** Use `jevDenyList` with fragments of project paths where nothing may
  leave the machine.
- **How you know it works.** A rule check that cannot reach Jev never stops your work: the turn
  passes as if the option were off. So check it once after turning it on:
  `node ~/.exo-compact/plugin/compact/setup.cjs doctor` prints a `WARN Jev:` line when the key is
  not set, when TypeSafe rejects it, or when the account has no credit (HTTP 402). In a session,
  the plugin says so once, at the first turn that ends with a task card, in a notice line that
  starts with `exo-compact: rule_check.off=`. Every skipped check is also in the plugin's log:
  `rule_check.fired=0 reason=no_key`, `reason=http_402` or `reason=timeout`.

```bash
claude plugin install exo-compact@exo-compact --config ruleCheck=true ...   # installed plugin
S4_JEV=1 ~/.exo-compact/launch/exo-compact.sh   # launcher: Jev ranking (jevEnabled); the doctor checks the key first
```

### A Jev server of your own (`EXO_JEV_URL`, experimental)

Every Jev request goes to TypeSafe unless `EXO_JEV_URL` is set in the shell that starts Claude Code. Set it to the
address of a server that answers TypeSafe's `/v1/systemone` requests, and the rule check, span selection, note and search
ranking and the doctor all ask that server instead:

```bash
export EXO_JEV_URL=http://127.0.0.1:8080        # /v1/systemone is added when the address has no path
node ~/.exo-compact/plugin/compact/setup.cjs doctor --jev
# exo-compact doctor ok   Jev: your own server http://127.0.0.1:8080 (EXO_JEV_URL) answered in 688 ms (model jev-0.1)
```

- **Key.** An address on this machine (`127.0.0.1`, `localhost`, `[::1]`) needs no key. Any other address needs
  `TYPESAFE_API_KEY`. When that variable is set, its value is sent to the address in `EXO_JEV_URL` as the bearer key,
  so do not point it at a server you do not trust while a TypeSafe key is set.
- **A wrong address is not a fallback.** If `EXO_JEV_URL` is not an http or https address, Jev is not asked at all,
  TypeSafe included. The doctor and the session say so (`rule_check.off=bad_url`).
- **Model name.** Span selection (`jevEnabled`) accepts an answer only when the server's `model` is the name that
  `jevModel` asks for; the default `jev-latest` accepts `jev-<digits>`. `llama-server` reports the model file's path
  unless it is started with `--alias jev-0.1`. The doctor points this out.
- **Time limits do not change.** The rule check allows 6 s per request and 10 s in all, the search ranking 4 s, and
  span selection 10 s for a whole cut. A server slower than that changes nothing in your session: every Jev step falls
  back as if Jev were off (`rule_check.fired=0 reason=timeout`).

What was tried, on 2026-10-13: `llama-server` from llama.cpp (build b11583, CPU only, 8 threads on a shared machine)
with two open models served natively at `/v1/systemone`. Only the doctor's one-question probe fit the limits (0.5 s
with a 0.4B model, 3.5 s with a 4B model). A rule check on a small report took 95 to 173 s and a search ranking 20 to
198 s. So on a CPU alone this option does not give a working rule check; a GPU was not tested.

To time a server yourself, the rule check script and the search ranking read a longer limit per request, in
milliseconds, from `EXO_RULE_CHECK_TIMEOUT_MS` and `EXO_JEV_RECALL_TIMEOUT_MS`. In a session the rule check still gets
10 s in all, so these are for measuring, not a way to make a slow server work.

**A model you run yourself is not TypeSafe's Jev.** The rule check's thresholds, and the earlier A/B that ran with the
rule check on, were measured with TypeSafe's Jev. Another model scores the same questions differently,
and nothing here was measured with one, so expect different results: more missed rules, more false alarms, or both.
