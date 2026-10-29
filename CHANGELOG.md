# Changelog

Notable changes per version. `plugin/compact/CONTRACT.md` has the full behavioural rules, one section per version.

## 4.10.1 - 2026-10-29

- Claude Code 2.1.312's built-in `cc-plugin-sec-default` runs before user plugins and sends their hook events on past
  them, so exo-compact's hooks never run and every compaction is native (S5y). `setup.cjs doctor` now reads the skip
  lines Claude Code leaves in the newest transcripts of the project and warns, naming the plugin and the events, with
  two fixes: `"appendPlugins": ["exo-compact@exo-compact"]` in the user settings, or an administrator's managed
  settings entry.
- `setup.cjs doctor digest [folder]` prints the `pluginDigests` value managed settings need for that entry, computed
  as Claude Code does, and refuses a folder Claude Code would refuse (a symlink, too many files) or one whose files
  have CRLF line endings.
- While the hooks are skipped, the session start leaves the auto-compact settings alone and says why in one line:
  a smaller window would only bring the native compaction sooner. The settings are applied after the fix.
- README: "Hooks skipped by another plugin", how to recognize it and both fixes, with the managed settings JSON.

## 4.10.0 - 2026-10-29

- The plugin sets Claude Code's auto-compact window and turns auto-compact on (S5x). Two new options come first in
  the manifest: `autoCompactWindow` (default 200000, what the A/B tests ran with; 0 leaves the setting alone) and
  `autoCompact` (default true). At the first attended session start, `auto-compact.mjs` writes them to the user
  `settings.json` (other keys kept, atomic write, a broken file left alone, a concurrent change planned again, a
  byte order mark kept; the hook passes the config dir it resolved, so a project `env` block cannot redirect it) and the change shows as one notice line,
  also in `notices: "quiet"`. A marker in `<config dir>/exovault/auto-compact.json` records the applied values, so a
  later change by hand stays. `install.sh` and `install.ps1` ask both questions on a terminal (or read
  `EXO_COMPACT_WINDOW` / `EXO_COMPACT_AUTO`), pass the answers as `--config` and apply them right away.
  `setup.cjs doctor` reports the effective window and whether auto-compact is on, and warns when it is off, unset or
  above 200000.
- Dev dependencies: vitest 4.1.12 -> 5.0.5; TypeScript stays on 5.9.3 because TypeScript 7 does not ship the
  JavaScript compiler API used by the static source gates; `@types/node` stays on the Node 22 major; Dependabot now
  ignores TypeScript 7 and `@types/node` major updates.
- Dev dependencies: vitest 4.0.18 -> 4.1.12 (vite 7 -> 8), which clears the vitest and vite advisories `npm audit`
  reported (GHSA-5xrq-8626-4rwp and others). They affect only the test run, not the installed plugin, which ships no
  npm runtime dependencies.
- `.github/dependabot.yml`: weekly update PRs for the dev dependencies and the GitHub Actions.

## 4.9.2 - 2026-10-26

Security release from a pre-launch audit. See `SECURITY.md` for the policy and how to report a vulnerability.

- The hook runs its own scripts only from the directory Claude Code loaded it from (`$.plugin.root`, S5t). It no longer
  reads `CLAUDE_PLUGIN_ROOT`, which a cloned project's `.claude/settings.json` could set through its `env` block to point
  the hook at a script of its own. `recallPluginRoot` is only a fallback and must be an absolute path without `..`.
- The capture store is owner-only (S5u): `.exovault`, `s4-capture` and each session directory are 0700 and every
  capture file 0600, set before a session's first capture write and after every turn and every cut (`harden.mjs`).
  Before, they followed the umask (often 664/775). The held brief is deleted once it is back in the prompt box.
- Secrets are redacted where capture records, the task card and the working-directory snapshot are written, not only
  when the seed reads them back.
- Seed bodies cannot forge seed structure (S5v): a `#`/`##` heading that names a seed section (`## Constraints`,
  `## Task card`, ...) is demoted, also inside code fences, quotes, tables and list items and after Unicode folding;
  `session-memory` and `system-reminder` tags are neutralized. Adopted-file constraints come only from text the user
  typed, not from a system reminder or hook output appended to a user message.
- The optional vectors runtime installs with `npm ci --ignore-scripts` from a shipped lock
  (`recall/runtime-lock.json`, exact versions with integrity hashes), and the model loads from a pinned hub commit. An
  install from an earlier version installs again once.
- The Windows named pipe of the recall push server carries 128 random bits in its name.
- New `SECURITY.md`: private vulnerability reporting, data the plugin keeps, hardening and known limits (Windows ACLs).
- Fixes from a cross-vendor security review of this release:
  - Node scripts the hook starts can no longer be redirected by a project's `env` block (S5w). `NODE_OPTIONS`,
    `NODE_PATH`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES` and similar variables are cleared for every child, and the Node
    binary comes from the new `nodePath` option, which `install.sh` and `install.ps1` set to the Node that ran them
    (without it, `node` from `PATH`). The brief digest starts `claude` only from `~/.local/bin` or next to its own
    Node, never from `PATH`.
  - The capture store fails closed (S5u). `harden.mjs` exits 2 when `.exovault`, `s4-capture` or the session directory
    is a symbolic link, not a directory owned by the user, or not 0700 afterwards, and the hook then writes nothing
    there: a repository that commits `.exovault/s4-capture` as a link into its checkout no longer gets the held brief
    or capture segments written through it. The check is awaited before the first write under every newly chosen root,
    also after the working directory changes during a session, and only a success is cached.
  - Seed integrity (S5v): `## [Constraints](#)`, `## <b>Constraints</b>` and similar link or inline-HTML wrappings of a
    seed section name are demoted too, and a wrapper tag hidden with zero-width or combining characters
    (`</session-\u200Bmemory>`) is neutralized.
  - The vectors runtime's `READY` stamp records the platform and CPU architecture, so a runtime directory moved to
    another one installs again instead of loading binaries `prune` removed.
  - `SECURITY.md` states that everything stays local in the default configuration and names the two opt-in features
    that send data to Jev, `jevEnabled` and `ruleCheck`.
- First installs no longer print Git's detached-HEAD advice (#75).
- README: a new lead (0.4 s instead of 62 s, no model call), a three-step "How it works" (capture, deterministic
  rebuild, recall with `search_session`) and a new how-it-works graphic. `docs/assets/social-preview.png` is the
  1280x640 repository preview image.

## 4.9.1 - 2026-10-25

- The compact and dense timing gates measure CPU time instead of wall time, so server load no longer fails them (#68).
  The compact gate adds a 10 s wall ceiling and an event-loop-lag ceiling and retries up to three times on a fresh host
  and store; the dense gate also bounds CPU growth for 4x input and retries only its wall-time sample.
- Recall redaction no longer overflows the stack on multi-megabyte input (#65). Lines longer than 64 KiB get a bounded
  prescan that hides oversized provider keys, bearer values, URL passwords and named values (fail closed); text whose
  lines all fit the bound gives exactly the earlier output. A regex overflow in `replace` is retried on a fallback.
- The oversized-credential prescan combines its long-run and quote checks, skips impossible JWT candidates and stops
  after a provider match covers the rest of a line, reducing work on repeated markers without changing bounded-line output.
- Retention recovers orphaned capture tombstones (#66) in dry runs, cleanup and build-worker runs: a quiet one (no write
  for an hour, recorded pid dead) is restored when its canonical path is free, one past the retention window is deleted,
  and one beside an occupied canonical capture is left until it ages out. A capture append re-lists once when a listed
  segment disappears during a retention rename.
- Dry-run retention counts a quiet tombstone as restorable when its canonical capture is planned for pruning in the same run (#71).
- Cleanup checks capture and brief file contents immediately before replacing them, so a brief save made during redaction
  stays on disk for the next run. Retention atomically moves an old capture directory to a hidden sibling, checks it
  again and deletes only that moved tree; writers keep using the canonical path, which can be recreated without waiting.
  A failed directory rename leaves the capture in place.
- Recall redaction timing gates calibrate repetitions per input shape until the fastest of three base samples uses 20 ms of CPU, reducing timer noise while preserving the 48 KB and 192 KB input sizes and growth threshold.
- Detached recall build tests wait for the `BUILD_LOCK` owner to exit after records publish before removing temporary indexes.
- Cleanup and the next build remove every stored vector keyed to a row's pre-redaction text, while keeping vectors for
  unchanged rows. The dry run reports stale vector records and `--apply` backs up the vector file before dropping
  them. Vector locks wait at most two seconds and locks older than 30 seconds are taken over, even when the recorded
  pid is live. Cleanup starts queued builds in vectors mode when the index has a vector file, and reports cutoffs
  dropped with pruned indexes.
- Session push now starts its server deadline from the same clock reading as the hook timer, with a 200 ms server
  margin. The server returns shown keys without saving them; the hook saves them after using its answer, so a timed-out
  or lost answer does not hide lines from the next prompt. The CLI fallback keeps its existing state-file behavior.
- Recall timing gates now compare redaction CPU growth and parent event-loop CPU gaps, avoiding wall-time failures under
  machine load while confirming the detached index build publishes its records.
- Recall redaction CPU growth is checked per adversarial input shape, so one quadratic pattern cannot be diluted by
  the other shapes.

## 4.9.0 - 2026-10-24

- Each gating hook (prompt.submit, session.compact, classic.PreToolUse, classic.PostToolUse, classic.Stop) has a
  `.catch`: a throw or an overrun budget logs `hook.caught=<event> kind=<throw|timeout>` and passes the event on, so
  `claude plugin validate --strict` reports no gating hook without `.catch`. The marketplace also lists
  `exovault-s4-trigger`, the optional, experimental soft-trigger companion, which now names its author.
- `setup.cjs doctor` now shows the `interactiveOnly=false` install command when scripted runs keep
  native compaction. The README, configuration and benchmark docs explain the default and add the
  200k-window A/B results.
- Session push is answered by the session's recall MCP server over a local socket (an owner-only Unix socket, a named
  pipe on Windows) instead of a new `session-push.mjs` process on every prompt, which read and prepared the whole
  session index each time (1.4 s and 580 MB on a large session). The server already holds the prepared index. With
  no server for the session, or when it refuses or is gone, the hook spawns the script as before; a server that does
  not answer within 1.5 s is given up for that prompt. The `session_push.fired` notice ends in `via=server` or
  `via=spawn`.
- `setup.cjs cleanup` also redacts the capture directories it keeps (home and `--capture-root`): segments, the work
  log, the task card, notices and adopted files, with the same backup first. Content hashes stay as written, so
  reconcile does not capture a turn again. A capture written in the last hour is skipped (a session may still be
  writing it; capture writes take no lock). A capture that changes or gains a file between the plan and the rewrite
  is left whole, and each file is read once more right before it is replaced. Segments are read as JSON lines, the
  paths in `adopted.json` stay as they are (its copies are found by them; an entry whose path holds a key or is no string is dropped),
  a symlinked capture root is not followed,
  and run from a session (`CLAUDE_CODE_SESSION_ID` set) the command leaves that session's capture and index alone.
  The report and `--json` count what was skipped (`recentCaptures`, `redact.skipped`); `redact.files` and
  `redact.captures` count what was rewritten.
- `tools/public-tree.mjs` commits as `--author "Name <email>"`, or else as the git identity of whoever runs it
  (author and committer alike), instead of always as Claude. With neither it stops before writing anything, and it
  never makes up an identity from the login and host name. The summary line names the author.
- `npm test`, and so CI, runs the installer tests (`tools/install/install.test.mjs`, both `install.sh` and, where pwsh
  is found, `install.ps1`) and the `quiz-cutid` and `tree-eval` tests, which it left out before. The two `tree-eval`
  files written for vitest run under vitest, since `node --test` would pass them without running their assertions. A
  gate checks that every `tools/**/*.test.mjs` is in the script under the runner it imports, also in a tree without
  `.git`. The installer tests now start pwsh by its full path, so a pwsh outside `/usr/bin` (`~/.local/bin`) no
  longer fails them inside the sandbox's short `PATH`, and they remove their temporary directories when done.

## 4.8.1 - 2026-10-23

- Releases are tagged (`v4.8.1` is the first), and `install.sh` and `install.ps1` install the tag of the latest
  release instead of `main`, so a change merged to `main` reaches users once it is released. `EXO_COMPACT_REF=main`
  installs `main`. A gate checks that `package.json`, `package-lock.json`, `plugin.json`, the README badge, the first
  CHANGELOG section and both installers name the same version.
- `doctor` compares the install with the latest release tag on the remote, by version, and with `main` only when the
  remote has no release tags. An install at the tag of the latest release is up to date even when `main` moved on.
  Behind it, the update command fetches and checks out the tag (`git pull --ff-only` fails on the detached clone the
  installer leaves; a clone on a branch is still pulled) before `claude plugin marketplace update` and
  `claude plugin update`. When the remote cannot be reached and the clone has release tags, the release is not
  checked rather than compared with a stale `origin/main`.
- Session search ranking (Jev) follows the same rule as the hook (#29): it runs only when the session's working
  directory (the last `cwd` its transcript records) passes `jevDenyList` and is not turned off by
  `.exovault/s4-compact-off`, and every place the session may be rooted (the recall server's directory,
  `CLAUDE_PROJECT_DIR`, the first `cwd` in the transcript) passes the deny list and has no opt-out as its nearest
  marker. With no transcript, no recorded `cwd`
  or no home directory, the search keeps its own order and asks Jev nothing. Before, only the server's own directory
  was checked, so a search could send excerpts to Jev from an opted-out or denied directory the session had moved into.
- The live gate's test-only override moved from the plugin options `gateForceTrigger` and `gateForceAgentId` to the
  environment variables `EXO_COMPACT_GATE_FORCE_TRIGGER` and `EXO_COMPACT_GATE_FORCE_AGENT_ID`, so the plugin's
  settings no longer show them. A value left in the old options is ignored.
- `tools/public-tree.mjs` builds the public repository: the tracked files of one ref without `docs/ctx-s4/`,
  `tools/ctxbench/` and `__gate-s4__/GATE.md`, as a new repository with one commit and no remote. The hygiene gate
  reads its list of private paths from it.
- `doctor` names the copy Claude Code loads (from `installed_plugins.json`: version, commit, folder) and compares its
  commit with `main` of the marketplace clone (with the latest release tag since the entry above). Claude Code keeps running that copy until `claude plugin update`, so a
  pulled clone or a merged fix did not reach sessions and nothing said so. Behind `main` is a warning (exit code
  unchanged) with the update command for the marketplace kind (`git pull` first for a directory marketplace), then a
  session restart. The check asks the remote with `git ls-remote` and falls back to the last fetched `origin/main`;
  nothing is fetched or pulled. A doctor run from another copy than the one Claude Code loads says so. `--preflight`
  and `--versions` skip it.
- CI: `.github/workflows/ci.yml` runs `npm ci`, `npm run typecheck` and `npm test` on Node 22.15 and 24, without keeping the checkout token. A fresh
  clone typechecks too: `npm run typecheck` (now both plugins) reads a committed stub of the `claude-code` module,
  `types/claude-code.d.ts`, which types the events, `$` methods and event fields the hooks use, instead of the declarations Claude Code generates beside the mod (gitignored, so a
  clone failed with TS6053). `npm run typecheck:full` checks against the generated file. The redaction timing
  guards check growth instead of an absolute bound: 4x the input must cost under 8x the CPU (the base input doubles
  until it takes 20 ms; the reading is the median of five interleaved 1x/4x pairs, so a burst of load on a shared
  machine does not skew it), so a slow CI runner passes and a quadratic regression (16x) still fails.
- The recall MCP server keeps one prepared index per session instead of the last 8 generations. Every compaction
  publishes a new generation, so a long session used to hold 8 stale copies: 2.2 GB and 3.9 GB were measured on two
  live sessions (about 210 MB per copy at 18k chunks). The heap now stays at one copy. A search also stops parsing
  `records.json` again while the generation is unchanged (about 140 ms down to about 75 ms per search at 18k chunks).
- Recall redaction (`recall/shared.mjs`) catches current key shapes before session text is indexed: Anthropic
  `sk-ant-`, OpenAI `sk-proj-`/`sk-svcacct-`, Supabase `sb_secret_`/`sb_publishable_`, GitHub `gho_`/`ghs_`/`ghu_`/`ghr_`,
  Slack `xapp-` and every `xox?-` (`xoxc-`, `xoxd-`, `xoxe-` included), AWS `ASIA`, Google `AIza`, Stripe `sk_live_`/`whsec_`, Hugging Face, npm,
  GitLab, JWTs, bearer and basic authorization headers, `*_KEY`/`*_TOKEN`/`*_PASS` env assignments, `token` and
  `api_token` names holding a key-like value, quoted JSON keys, quoted values that span lines, and URL credentials
  with an empty user (`redis://:pass@host`). Code
  that only refers to a secret (`${apiKey}`, `$TOKEN`, `process.env.X`, a call, a type) stays findable, as long as the
  whole value is the reference. `PWD`, `OLDPWD` and a bare `*_KEY` whose value holds no key (`PRIMARY_KEY=users.id`)
  stay too. Before, only `sk-` keys
  without a dash, `ghp_`, `github_pat_`, `xoxa-`/`xoxb-`/`xoxp-`, `AKIA`, PEM keys, URL credentials and
  `name=value` secrets were caught.
- The next build of an existing index redacts the rows it carries over, so keys stored by an older version are
  removed after one more compaction instead of staying in the index.
- `setup.cjs cleanup` (`recall/cleanup.mjs`) redacts again, with today's patterns, every stored index generation,
  saved brief, checklist, `briefs.json`, session map and search log, and applies the retention below. It is a dry run
  with numbers unless `--apply`, which first writes everything it changes or deletes to
  `~/.exovault/backup-<date>.tar.gz` (owner-only) and checks the archive lists each entry. Sessions whose build holds
  `BUILD_LOCK` are skipped; the lock is held for every index the run changes. A session a turn touches after the plan
  keeps both its index and its capture, and so does a session whose build holds the lock (no capture is removed while a build
  from an older version, which leaves `ACTIVE` empty, holds the lock before its first manifest). The redaction never shortens a file
  (long briefs keep every line) and covers record paths too; tar reads the backup list NUL-separated with `./` names.
- Retention: new option `retentionDays` (default 30, Claude Code's default for keeping transcripts; 0 keeps
  everything). At most once a day the recall build worker deletes the index and the home capture directory of every
  session untouched that long (newest file in either store, linked through the raw session id when the capture name had to be sanitized; each
  turn marks its index and records that id in it), never the session it builds.
  Before, nothing was deleted (850 MB of indexes after
  three weeks on one machine).
- New briefs are stored redacted at full length (the id still comes from the text as sent), and the search log
  redacts the query. New index rows redact the tool path as well as the text.
- `.exovault/.gitignore` (`*`) is written with the first capture of a session and by `setup.cjs enable`/`optout`, so a
  project's captures, flags and briefs never show in `git status`. A `.gitignore` already there is kept.

## 4.8.0 - 2026-10-16

**A native plugin install is enough: installed means enabled.**

**Upgrading from 4.7.x.** If you installed the plugin but never enabled it, or turned it off with `setup.cjs disable`
before 4.8.0 (which only deleted the flag), it is on after the update. To keep it off everywhere run
`node <plugin>/setup.cjs disable ~`; for one project, `setup.cjs optout <dir>`.

- `/plugin marketplace add MarcinSufa/exo-compact` and `/plugin install exo-compact@exo-compact` now work with no
  installer step. With no `.exovault/s4-compact-active` anywhere up the tree the plugin is active and captures under
  `~/.exovault/s4-capture/<session>/` (the home directory is the root). `.exovault/s4-compact-off` in a directory or a
  parent, or in the home directory, still turns it off; an active flag still pins the root to its directory.
  `setup.cjs disable [dir]` now writes the opt-out file (and removes the flag), because deleting a flag no longer turns
  anything off; `enable` removes an opt-out in the same directory. `doctor` reports an installed plugin as enabled.
- One-project setup (`disable ~` plus `enable <project>`): a shell `cd` elsewhere under the home directory no longer turns
  the session off. An opt-out found from the working directory stays final unless the session root's flag sits below that
  opt-out's directory, so a nearer opt-out (a private directory, a vendored folder) still wins. Jev egress still tests
  the working directory alone (CONTRACT S5r).
- Manifest defaults: `recallEnabled` true, `interactiveOnly` true, `briefPush` false, `briefCheck` false (in the A/B run with both
  nudges off the plugin cost about the same as native compaction, with better quality). `recallPluginRoot` still falls back to `CLAUDE_PLUGIN_ROOT`.
- SessionStart preflight: Node or Claude Code below the minimum (`doctor.mjs` holds the numbers) draws one plain-English
  line per session and the plugin stays inert (native compaction). `node plugin/compact/doctor.mjs --versions [--claude <version>]` runs the same check.

- Code fallbacks now equal the manifest defaults. Claude Code fills unset `userConfig` keys from the manifest, but the code
  still fell back to the old values when an option was missing (`recallEnabled` and `interactiveOnly` false, `briefPush`
  and `briefCheck` true); a gate test (`option-defaults.gate.test.ts`) fails when any `optionBoolean`, `optionString` or
  `optionNumber` fallback in `compact.ts` disagrees with `plugin.json`.
- `install.sh` and `install.ps1` stay as the alternative path and stay idempotent, but no longer set `recallEnabled` or
  `interactiveOnly` (manifest defaults) and no longer write a flag file for the home directory. They set `recallPluginRoot`
  on every run. `EXO_COMPACT_ENABLE_DIR=<dir>` still runs `setup.cjs enable <dir>`; `none` now runs `setup.cjs disable ~`.
- README and docs: install leads with the two `/plugin` commands, then updating, then the installer as the alternative,
  and opting out per project. New A/B with the 4.8.0 defaults (Sonnet 5.5, 9 chains per side, 8-task chain, equal
  window): hidden tests missed 6.1 against 8.2 of 229 per chain, session rules kept 34.5 against 32.3 of 35, wall
  time 25.3 against 33.3 min (24% less), cost $4.21 against $4.49 on the mean (median $4.31 against $4.36, ranges
  overlap, so on par). It replaces the 3.56.0 result (about 40% more cost), which came from brief push and brief
  check, now off by default. docs/benchmarks.md has every chain.

**Fixes from the Windows 11 test (PowerShell 5.1, Claude Code 2.1.284, Node 24).**

- `setup.cjs optout <dir>` after `enable <dir>` did nothing: the flag stayed beside the opt-out file and wins over it.
  `optout` now removes the flag in that directory too, the same as `disable`.
- `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is not needed on any supported version: the Windows retest ran the compaction
  hook on 2.1.284 without it, and 2.1.278 loads the plugin the same with and without it. The installers no longer
  tell 2.1.278 to 2.1.286 users to add it, and the docs no longer ask for it. The launchers still set it (harmless).
- `doctor` with Jev off is a warning now (`WARN Jev: off (optional), so the rule check does not run.`) with the two
  steps to turn it on: set `TYPESAFE_API_KEY`, then `--config ruleCheck=true`. The exit code stays 0.
- `setup.cjs enable|disable|optout|optin` print one line saying what they did (they were silent on success).
- `tools/status.mjs`: a `reason=insufficient_reduction` fallback shows the message tokens S4 counted and, from
  4.8.0 logs, what its seed and tail would have left, for example `(S4: 7.5k message tokens -> 6.1k, under the 25%
  cut; too short a session, expected)`. Claude Code's own before and after include the system prompt and tools.
  The fallback line in `notices.log` gains `sizeAfter=<tokens>` after `origin=compact`.
  The summary counts every native cut S4 declined, not only those after an S4 cut:
  `native fallbacks: 2 (0 after an S4 cut)`.
- `install.sh` and `install.ps1` move an existing clone to `EXO_COMPACT_REF` (fetch and check out the ref) instead of
  only pulling the branch it was cloned from. `install.ps1` says what to close when adding the marketplace fails with
  EBUSY (a terminal or editor open in the clone or in the old marketplace copy).
- `tools/status.mjs` on Windows: a capture dir reached through `c:\...` and `C:\...` counts once (no false
  "split across dirs"), and both forms shorten to `~`.
- `doctor` on Windows runs `claude --version` as one command string, so Node 24 no longer prints DEP0190.

**A subagent's final report is no longer saved as a task brief.**

- A hand-back reaches the parent session as a prompt (origin `peer`, `handback: true`; text `<agent-message ...>` then
  `[Subagent hand-back]`). Over 2,500 characters it was saved as the newest brief: brief push then pushed the report's
  lines into every later write, and the report, as a "new brief", turned the push of the real brief off. `briefText`
  and `cleanUserText` now drop it whole, and `prompt.submit` skips an origin with `handback: true`.

## 4.7.6 - 2026-10-13

**The plugin stays on when the shell leaves the project (issue #27).**

- Enablement followed `$.session.cwd()`, the live shell directory, so a Bash `cd` out of the flagged project (a worktree,
  `/tmp`) turned the plugin off for the rest of the session: no capture, native compaction, `compact.fallback=not_enabled`.
  `findCaptureRoot` (both copies) now walks up from the working directory first (an `s4-compact-off` found there is final),
  then from `$.session.root()`, the project root a shell `cd` does not move: a marker on the root walk decides, no marker on
  the root walk leaves the working-directory result. A host without `session.root`, or one whose `root()` throws, rejects
  or answers with an empty or non-string value, behaves exactly as before.
- Every flag host and the brief-push and task-card hosts carry `root: () => $.session.root()`; `cwd` members still point
  at the working directory (`brief-push.mjs limits`, the `cwd_snapshot` record, adopted file paths).
- Jev (prompt labels, dense rerank, selector J) and `rule-check.mjs` send text off the machine, including session and
  capture-store content, and `rule-check.mjs` also sends the working directory's diff, so they run only when the
  option is on, a walk from the working directory alone is enabled, and the working directory passes `jevDenyList`;
  a usable session root is tested against `jevDenyList` too, a host without one keeps the working-directory test only.
  While the shell is outside every flagged directory, labels are not requested, selector J falls back to D and the
  dense rerank and rule check are off (in another flagged project they still run when neither that directory nor a
  usable session root is on the deny list).
- `session.root` was verified present in host binaries 2.1.278, 2.1.280, 2.1.284 and 2.1.296, so the minimum supported
  Claude Code version rises from 2.1.274 to 2.1.278 (`MIN_CLAUDE` in `doctor.mjs`; `doctor` fails on an older host and
  says to run `claude update`). `doctor.mjs` still walks from the cwd only.

## 4.7.5 — 2026-10-13

**A Jev option without a working key is no longer silent.** No change for anyone who leaves Jev off.

- `setup.cjs doctor` (the installer runs it) now reads your Claude Code settings. When `ruleCheck` or `jevEnabled` is on, it
  checks the TypeSafe key and prints a `WARN Jev:` line if the key is not set, is rejected, or the account has no credit
  (HTTP 402). It is a warning only: the exit code stays 0. With Jev off, the line now says where the optional rule check
  is described.
- README: says where a TypeSafe (Jev) API key is needed: never for a default install, only for the optional rule check;
  and that the plugin side of the A/B test ran with the rule check on. New FAQ entry "Do I need a Jev API key?".
- `setup.cjs doctor`: the "S4 is not enabled" warning added in 4.7.4 now gives the full enable command for this install,
  and the installers no longer show it before they turn the folder on (`doctor --preflight`).
- In a session, a rule check that is on but cannot work (no key, rejected key, no credit) says so once, in a visible
  notice line: `exo-compact: rule_check.off=no_key ruleCheck is on but TYPESAFE_API_KEY is not set, so no rule is checked. ...`
- In a session, the rule check logs why it had no result: `rule_check.fired=0 reason=no_key`, `reason=http_402`,
  `reason=timeout` (it used to be `reason=no_result` for all of them).
- An unattended run (`-p --resume`, the SDK) of a session that already has a `notices.log` adds its
  `compact.fallback=` lines to it, so `tools/status.mjs` shows `reason=interactive_only` for that cut. It never creates
  the file. docs/install.md and the README now say that the VS Code and Cursor extension does not draw the plugin's
  notice lines, and where to read them instead (#25).
- `jevPerCallTimeoutMs` now defaults to 4000 ms in the plugin manifest and in docs/configuration.md, as it already did
  in the code. The manifest still said 1500, a limit found too short for a full Jev batch. Only span selection
  (`jevEnabled`) uses it.
- New, experimental: `EXO_JEV_URL` names a Jev-compatible server of your own (`/v1/systemone`) to ask instead of
  TypeSafe. An address on this machine needs no key; `TYPESAFE_API_KEY`, when set, is sent to that address. A value that
  is not an http or https address turns Jev off rather than falling back to TypeSafe. `doctor --jev` probes the address,
  prints how long it took, and points out a model name that span selection would reject. No time limit changed: on a
  CPU alone a local model was too slow for the rule check (95 to 173 s against 6 s), and a model you run yourself does
  not score like TypeSafe's Jev. See docs/install.md.

## 4.7.4 — 2026-10-13

**A session started from the VS Code or Cursor extension is interactive; an `interactiveOnly` fallback from `session.compact` says why.**

- With `interactiveOnly: true` an extension session (`CLAUDE_CODE_ENTRYPOINT=claude-vscode`, no `$.session.surfaces()` entry)
  fell back to native compaction silently, captured no turns and was hidden by `tools/status.mjs`. "Interactive" now means: a
  surface is attached, or the process was started by the extension and is not a child of another session
  (`CLAUDE_CODE_CHILD_SESSION`, `EXOVAULT_BRIEF_CHILD`). `-p`, the SDK and any run started from inside another session stay
  on native compaction. The quiet notice policy records `notices.log` for an extension session too.
- `session.compact` logs `compact.fallback=interactive_only origin=compact entrypoint=<value or unset>` when it falls back
  under `interactiveOnly`, and `compact.fallback=not_enabled origin=compact` to the debug log only when the project has no
  S4 flag.
- `doctor.mjs` adds two warnings (exit code unchanged): the cwd is not enabled for S4; `interactiveOnly` is on and this kind
  of session (`CLAUDE_CODE_ENTRYPOINT`) keeps native compaction.
- `tools/status.mjs` lists extension sessions without `--headless` and shows `reason=<reason>` on a native compaction row
  when `notices.log` recorded a fallback line for it.

**Public release preparation.** English only, internal names removed, Claude Code types no longer tracked, README install fixes, status --headless hint. The README and docs/benchmarks.md gain field data counted from two weeks of real sessions. No behaviour change.

- One-command installer: `install.sh` (`curl ... | bash`) and `install.ps1` (`irm ... | iex`). It clones to `~/.exo-compact`, runs
  `doctor`, registers the plugin with recall on and turns it on for the home directory; a second run updates and keeps changed
  options. Tests in `tools/install/`. The docs now use `~/.exo-compact` as the clone path.
- README: an animated recording of a real session going through a compaction (`docs/assets/demo.svg`, built from captured
  terminal screens of a session with a small auto-compact window, `CLAUDE_CODE_AUTO_COMPACT_WINDOW=50000`).
- README: the A/B section now says what the +40% does not show: the context carried per call (135k tokens on average, measured
  over 33,200 calls in 83 sessions) against the estimate for a 1M window left to fill. Method in `docs/benchmarks.md`.
- README: rebuilt around five pictures drawn from the measured data (`docs/assets/*.png`, each in a dark and a light
  version): the context size of one real session over 39 active hours, native compaction against exo-compact, how it
  works, the A/B test and two weeks of daily use. Three headline numbers sit under the first picture; the full tables
  and the FAQ fold open. The pictures replace `session-*.svg` and `speed-*.svg`. The public-hygiene test now checks
  binary files for the banned patterns only, since their bytes decode to random letters.

## 4.7.3 — 2026-10-10

**The card cap never cuts without saying so; no log key contains "token".**

- Live A/B run w72a (plugin 4.7.2), cuts 6 and 10 (card budgets about 1301 and 1250): the card cap fell back to a plain line cut and
  dropped Done, Acceptance checks and Next step whole, with no marker. Cause: the first lines of the sections alone were about
  880 tokens and the five markers repeat a 120-character path (about 270 tokens), so one line per section did not fit. Now every
  heading keeps a shortened first line plus a `(k more lines in <path>)` marker; if that does not fit either, whole sections are
  replaced by one marker line each, Next step kept longest, then Acceptance checks, then Goal. Cards that fit with at least one line per
  section are byte-identical to 4.7.2.
- Renamed log keys (Claude Code redacts the value of any key containing "token"; values are unchanged):
  `seed.work_state_tokens` to `seed.work_state_size`, `seed.session_map_tokens` to `seed.session_map_size`,
  `seed.task_brief_tokens` to `seed.task_brief_size`. A test scans the source and fails on any new key containing "token".
  `tools/hook-replay` ignores the new keys when it compares against a live log of 4.7.2 or older.

## 4.7.2 — 2026-10-10

**The `recipes` option is on by default.** `lateCardRefresh` stays off; nothing else changes. Set `recipes: false` for the 4.6.0 seed.

- Two live A/B pairs (w71, w72; Sonnet 5.5, 100k window, 8 tasks, plugin 4.7.1) with recipes on vs off: gate check failures 5 vs 10,
  fully green tasks 11/16 vs 10/16, cost 11.30 $ vs 11.85 $ (within noise), moves to the first edit after a cut about 2.8 vs 4.4.
  Recipes reached the seed on 13 of 20 cuts, including 6 over-budget ones. Not statistically significant; no measure got worse.
- `toolOutputNotes: false` also keeps output text out of the recipe lines (outcome `ok`, no result-only ports); this includes recipes carried from an earlier seed, which keep only the background marker, ports from the command and the cwd.
- The `recipes` description in `plugin.json` now states the 4.7.1 shrink order.

## 4.7.1 — 2026-10-09

**Recipes survive the working notes, the new `$.model.fork` result, mods docs.**

- Recipes now give way after the working notes, not before. Over budget, the working notes shrink first (down to none);
  only then do the recipes shrink, and after them the brief path lines, the card and the adopted rules. In a live A/B the
  4.7.0 order dropped the recipes in the first cut, so they never reached the model.
- `$.model.fork` handling: since Claude Code 2.1.287 it returns `{ isAnswered, text, usage }` or `{ isAnswered: false, reason }`.
  A failed card refresh now gives the step back and logs `task_card.refresh=no_reply reason=<reason>` (`null` for the old
  `null` result) instead of the generic `task_card.refresh=error`.
- Typings refreshed to Claude Code 2.1.292.
- README: mods are public since 2.1.287 and the plugin needs no `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` flag there; the flag is
  needed only on 2.1.274 to 2.1.286. CONTRACT S5l notes the fork result and the `claude plugin validate` warning.

## 4.7.0 — 2026-10-09

**Quiet notices, Windows home directory, CLAUDE_CONFIG_DIR, launcher fixes.**

- New option `notices` (`quiet` default, `all`). An interactive session now draws one summary line per cut
  (`compacted 92k -> 11k tokens in 0.3 s`) plus warnings (fallbacks, errors, new-brief hold, refusal guard,
  `brief.saved=0`, capture timeout). Everything else goes, with an ISO timestamp, to `<capture dir>/notices.log`.
  Headless `-p` and SDK runs keep every line, so tools that parse them still work.
- One home-directory rule (`HOME`, `USERPROFILE`, `HOMEDRIVE`+`HOMEPATH`, `.`) for the hooks, the recall MCP server and
  the recall workers.
- `CLAUDE_CONFIG_DIR` is honored for Claude Code's own files (`projects/`, `installed_plugins.json`) in `status.mjs`,
  recall transcript lookup and the launchers. The plugin's recall store stays under `<home>/.claude/exovault/recall`.
- `launch/exo-compact.ps1` no longer has a `param` block: `-p` was read as `-PluginDir`. It recognises only the exact
  `-PluginDir`, `-Window`, `-Jev`, `-SkipDoctor`. Both launchers send doctor output and the enable message to stderr, so
  `launcher -p --output-format json` prints clean JSON.
- `brief_limits`, `brief_push` and `session_push` log the error tail when they fail. The 8 `session_push ... reason=error`
  lines of 2026-10-07 were the 3 s push timeout, not a bug in the push.
- README: clone path, scripted runs, global install and `-p`, where data lives.

**Optional: a late task card refresh and a Recipes section.** Two optional features, both off by default so they can be A/B tested. They come from an audit of 97 real cuts in 36
sessions: the task card's "Next step" was 1-5 rounds behind in about 12 of 21 judged cuts (median card age at the cut 53
minutes and 40 tool calls; the refresh fires at about 60% of the window, the cut at about 87%), and 7 of 21 cuts lost how
the session had run things (launch commands, env vars, ports, verify commands, background task ids): 179 recall calls
after cuts were mostly "how did I run X".

- **`lateCardRefresh`** (default off): a second background card refresh at 85% of the compaction window, when the card is
  more than 15 tool calls old, once per cut cycle, so the card at the cut is usually fresh. Cost: one extra fork per cut
  cycle (logged as `task_card.refresh=start ... late=1 calls=N`). The card section also gets one age line,
  `(card written N tool calls before the kept messages; the messages below are newer)`, unless the "Since the card"
  section already lists those calls (CONTRACT S5j).
- **`recipes`** (default off): a `## Recipes` section after Work state with the last working run, test, build, verify and
  deploy commands from the Bash calls before the cut: those that succeeded, deduplicated (newest kept), with their short
  outcome, env-var names, ports and background task ids, secrets redacted, reads and git inspection left out, what the kept
  tail shows left out. At most 8 lines and about 400 tokens, no model call, and it shrinks first when the seed is over
  budget. Recipes of earlier cuts carry forward in the seed (CONTRACT S5k).
- With both options off the seed is byte-identical to 4.6.0.
- Hook module change: running sessions pick it up after a restart.

## 4.6.0 — 2026-10-07

**The seed now lists what happened after the task card was written.** A new "Since the card" section follows the card
and lists, one line per step, the tool calls between the card's horizon (the newest call its fork could see) and the
kept messages: files written or edited, commands run with their last output line or first error, agents started, and a
count of read-only calls. No model call; the cut stays as fast as before. Measured on 112 recorded cuts whose seed used
the card: the card is a median 66 s old at the cut (p90 163 s, max 258 s), and between its horizon and the kept tail
there is a median of 4 tool calls, 2 file writes and 2 test or build runs; in 56% of cuts that gap holds at least 2
writes or 3 checks, and the tail covers a median 2 s. One seed said "Nothing written yet for task 8" after the model had
written or edited 8 files and run the tests in the 130 s before the cut. The section is capped at 500 tokens (newest steps
kept), shrinks before the card does and is dropped last, so it adds no budget fallback. Option `sinceCard` (default on).
Hook module change: running sessions pick it up after a restart.

- A Bash step that writes a file and also runs other commands (the usual heredoc, then `sed`, `grep` or tests) now names
  the file: `wrote <files> (bash, with other commands) -> <outcome>`. A file list over the line limit shows each path as
  `…/<dir>/<file>`. On the recorded w60–w62 runs, 816 of 1167 file-writing Bash calls lost a file name before and 32
  (three or more files in one call) do now. A failed one reads ``ran `...` (writes <files>) -> failed: ...``, leading
  `cd <dir>` commands are dropped from the shown command, and camelCase MCP tools (`readMessages`) count as read-only
  like `read_messages`.
- Several long paths in one Bash step: each shrinks to `…/<dir>/<file>` and the names that fit whole are listed, then
  `, +K more`; a name is never cut in the middle. A heredoc write followed by a read (`sed -n`, `head`, `tail`, `cat`,
  `ls`) is now the mixed form with its outcome, not `wrote <file> (bash)`: `sed` is file work only with `-i`, and
  `cat`/`head`/`tail` only with a `>` redirect. On the horizon message the steps start at the horizon call itself, so
  tool calls before it in the same message are no longer listed.
- Over budget, the "Since the card" section now keeps its newest 3 step lines until the card's older tail lines have
  shrunk; only then does it shrink to its floor (and is dropped last). In a live A/B run it was emptied on 4 of 9 cuts
  before the card was touched.
- Optional `cutOnNewBrief` (default off) compacts the completed task before each later long brief enters the model
  context. It uses the existing 2,500-character brief detector, leaves short follow-ups and the first session prompt
  alone, and passes the new prompt through whole.
  The engine refuses a cut while the turn this prompt is about to run exists (live w67: "a turn is running"), so on
  that error the brief is held: saved to `held-brief.md` in the capture dir, dropped with a short reason, the cut
  retried every ~100 ms for up to ~10 s, then the brief is put back in the prompt box (`$.prompt.fill`, else
  `$.prompt.submit`) for Enter. Logs: `compact.trigger=new_brief`, `compact.trigger_skipped=compact_error|compaction_veto|headless|brief_returned`,
  `compact.error=`, `compact.brief_returned=fill|submit|lost`. Only a later submit that is itself a cut candidate (a
  long brief) consumes the returned-brief flag; a short message sent while the held brief is being cut leaves it, so the
  returned brief is still not cut a second time. Headless sessions and prompts with attachments pass through.
  In an interactive session the plugin runs in the hooks worker and the refusal reads "... it would compact under the
  turn this hook is holding"; both texts now hold the brief. A refused cut that still passes the brief through logs
  `compact.error=<message>` and, if the brief was not held, `compact.hold_skipped=attachments:<types>|no_capture_root|hold_error:<message>`.
  A pasted brief comes back without the engine's `<pasted_content id="X">` tags (typed text kept). Live interactive
  check on Haiku 5.5, 2026-10-08: brief held, cut 4 s later, the 3554-character brief back in the box, answered after Enter.
- A seed still over its budget after every section has shrunk now takes the missing tokens from the kept tail (down to
  30% of the tail budget) instead of handing the cut to Claude Code's own summary. Live A/B run w65b: the seed was 289
  tokens over (5289/5000) with the tail at its budget (7082/7082) and the cut fell back on `budget`.

## 4.5.0 — 2026-10-07

**A rule part about something the message lacks no longer blocks it.** The rule check now tells Jev that a part of a
report rule about how something is written when it appears (questions, errors, links, code) is followed when the
message has none. "Reply in Polish. Questions use ❓ Qn plus a ➡️ recommendation" had blocked 34 of 40 stops in one
coordinator session on Polish status updates without a single question, and the agent sent the same message again each
time. Offline on the 104 blocks recorded since 4.4.0 was installed: that rule fires 1 time instead of 32; on the w17
cases with labels, 23 of 26 real misses are still caught and false alarms drop from 5 to 2 of 217. Hook module change:
running sessions pick it up after a restart.

## 4.4.0 — 2026-10-06

**The block on a progress update no longer asks for the final report.** When the rule check blocks a progress update,
it now asks the agent to fix what is really broken, say so in a line or two and carry on; the hand-back block still asks
for the full report again. In the 154 recorded blocks, 44 of 59 short progress updates (median 184 characters) were
followed by a full report (median 1638 characters) for a task that was not done yet. Hook module change: running
sessions pick it up after a restart.

## 4.3.0 — 2026-10-06

**A rule blocks a progress update once per task.** When a rule has already blocked a stop in the current task, a later
progress update that breaks only such rules passes; the hook logs `repeat=N` instead. The hand-back is still blocked
for every broken rule, and a new task (a new brief) starts a new list. In the 303 recorded stops, 31 of the 75 still
blocked after 4.2.0 were such repeats (one orchestrator was blocked 15 times for the same rule). The hook module
changed, so running sessions pick this up only after a restart.

## 4.2.0 — 2026-10-06

**No hand-back rules on a progress update.** The stop-time rule check no longer blocks a progress update ("Reviewer round 2
is running; I'll re-run the gate when it finishes") for a DONE line, PR body or status entry the agent has not written
yet. Jev now also says whether the message is the hand-back and, per rule, whether the rule can only be judged on the
finished task; on a progress update those rules are skipped, and rules that always hold (language, style,
prohibitions) are still checked. Offline on 303 recorded stops: 91 of 129 blocked progress updates now pass, and 17 of
18 blocked hand-backs stay blocked. Same two Jev requests, one more question per rule.

## 4.1.0 — 2026-10-06

**Cheaper by about $0.76 per 8-task chain.** With the task card on (the default), a saved brief no longer gets its
`claude -p` checklist. The card carries the task's rules, and a card cut never showed the checklist: 0 of 29 plugin cuts
in the w61 A/B and 0 of 210 recorded seeds had it, and no session opened the checklist file. The checklist calls were
$0.68–0.80 of the plugin's +$1.85 per chain over native. `briefDigestModel` now applies only with `taskCard=false`.

## 4.0.0 — 2026-10-05

**Renamed.** The plugin is now `exo-compact` (was `exovault-s4-compact`) and its MCP server is `recall` (was
`exovault-recall`). No change to how sessions are compacted.

Migrating a global install:

```bash
claude plugin uninstall exovault-s4-compact@exo-compact
claude plugin marketplace update exo-compact
claude plugin install exo-compact@exo-compact --config recallEnabled=true \
  --config recallPluginRoot=/path/to/exo-compact/plugin/compact --config interactiveOnly=true
```

Options set under `pluginConfigs["exovault-s4-compact@exo-compact"]` move to `pluginConfigs["exo-compact@exo-compact"]`.
The launchers refuse to start while the old id is installed. Data directories (`.exovault/`, `~/.claude/exovault/`)
are unchanged.

## 3.57.0 — 2026-10-05

- The user's rules file is the last thing a card cut shrinks

## 3.56.0 — 2026-10-04

- Rule check judges every clause, keeps report verdicts, sends no secrets; digest spend recorded

## 3.55.0 — 2026-10-04

- The current task's brief survives the cut; card refresh and stale-card fixes

## 3.54.0 — 2026-10-04

- A cut on the new task prompt keeps the card total and the brief once

## 3.53.0 — 2026-10-04

- A card written for an earlier brief is left out of the seed

## 3.52.0 — 2026-10-04

- A card refresh whose fork never ran is given back and retried

## 3.51.0 — 2026-10-04

- Report line limits are counted, not judged by Jev

## 3.50.0 — 2026-10-04

- The task card keeps every section

## 3.49.0 — 2026-10-04

- Task card once per stretch and once per new task

## 3.48.1 — 2026-10-03

- Rule check skips stale cards, keeps code brackets, report-only resend

## 3.48.0 — 2026-10-03

- Jev rule check at the stop instead of pasting checks
- RuleCheck is its own Jev opt-in, off by default

## 3.47.1 — 2026-10-03

- The card total has its own option

## 3.47.0 — 2026-10-03

- Task card kept by the session's model, 8000-token cut

## 3.46.0 — 2026-10-03

- Budgets count real tokens, 20000 by default

## 3.45.0 — 2026-10-03

- Full brief returns its tail shift to an oversized tail

## 3.44.0 — 2026-10-03

- Brief check asks for the full report again

## 3.43.2 — 2026-10-02

- Tail back on chars/4

## 3.43.1 — 2026-10-02

- Session push needs the asked-for id

## 3.43.0 — 2026-10-02

- Tail token estimate, session push on by default, current values in the seed

## 3.42.0 — 2026-10-02

- Session push - after a cut, a message gets the compacted-away transcript lines that share a rare id or code with it (option sessionPush, default off)

## 3.41.1 — 2026-10-02

- Limit check skips a tracked file that already had lines over the limit

## 3.41.0 — 2026-10-02

- Line-length check after each write: added lines over the brief's stated limit get a note

## 3.40.0 — 2026-10-02

- Brief push: after a cut, every write gets the brief lines for its files as context

## 3.39.0 — 2026-10-02

- The newest task brief goes into the seed whole and verbatim, paid for by the tail

## 3.38.1 — 2026-10-02

- Brief check asks for the brief's exact form, not equivalent code

## 3.38.0 — 2026-10-02

- Brief check sends the whole brief when it fits 30k chars

## 3.37.1 — 2026-10-02

- Version bump for the brief check wording

## 3.37.0 — 2026-10-02

- Brief check before the first stop after a cut (detached search at the cut, one Stop block)
- Brief check asks to grep each listed string in its file

## 3.36.0 — 2026-10-02

- Search_session scope "brief" (brief lines, vectors), seed points to it, compound-term parts

## 3.35.0 — 2026-10-02

- Keep standing-rule sentences from over-cap paragraphs (rules glued to a pasted brief)
- Review fixes (edge-only scan, stricter starting-point marker, prefixes, fallback split, skip log)

## 3.34.0 — 2026-10-02

- Copy rules files the user adopts and quote them in every seed; standing-instruction markers
- Review fixes for adopted rules files (origin, redaction, revocation, budget, tags, ordering)
- Revocation governs only its own path; chain and refresh failures keep the copy

## 3.33.0 — 2026-10-02

- Load search_session with every prompt instead of deferring it behind tool search

## 3.32.1 — 2026-10-01

- Shrink the brief section instead of falling back to native when the seed overflows

## 3.32.0 — 2026-10-01

- One total budget for seed, dense notes and tail; brief read in parts

## 3.31.0 — 2026-10-01

- Task brief saved on disk, Sonnet checklist in the background, brief section in the seed

## 3.30.0 — 2026-10-01

- Session map in the seed, segment filter in search

## 3.29.0 — 2026-10-01

- Segment numbers in the session index

## 3.28.1 — 2026-10-01

- Tail keeps the work before the newest prompt

## 3.28.0 — 2026-10-01

- Machine-wide cap on embedding workers

## 3.27.0 — 2026-10-01

- Jev ranks session-search results

## 3.26.0 — 2026-10-01

- Leaner search_session replies; quiz embeds every cut's index

## 3.25.0 — 2026-10-01

- Refresh the recall index and vectors after every answer

## 3.24.0 — 2026-10-01

- Local vectors in session recall (multilingual-e5-small, background embed worker)

## 3.23.0 — 2026-10-01

- Ask session search in plain words; optional dense list in the ranker; dense/quiz retrieval evals

## 3.22.0 — 2026-10-01

- Exact values in session search (hash prefixes, numbers in any notation, quoted phrases, notFound)

## 3.21.0 — 2026-10-01

- Recall exact-token + proximity channels, links between excerpts (search_session around=<ref>)

## 3.20.0 — 2026-10-01

- Session search (hybrid recall ranking, tool calls indexed, search_session tool)

## 3.19.0 — 2026-09-30

- Jev re-ranks working-note candidates at the cut

## 3.18.1 — 2026-09-30

- Work state review fixes

## 3.18.0 — 2026-09-30

- Work state section built from tool calls and a git check at the cut

## 3.17.5 — 2026-09-30

- Keep thirty Bash output lines instead of ten

## 3.17.4 — 2026-09-30

- Fourth review fixes (key scanner, prose mode, look-alike turns)

## 3.17.3 — 2026-09-30

- Third review fixes (URL credentials, key strength, linear PEM)

## 3.17.2 — 2026-09-30

- Second review fixes (output secrets, bounded redaction, command walk)

## 3.17.1 — 2026-09-30

- Review fixes for 3.16.1/3.17.0 (linear command scan, output-only redaction)

## 3.17.0 — 2026-09-30

- Unused tail budget goes to the working notes

## 3.16.1 — 2026-09-30

- Review fixes

## 3.16.0 — 2026-09-30

- Bash output lines in working notes

## 3.15.2 — 2026-09-30

- Tool activity keeps no secrets; honest dense user lines

## 3.15.1 — 2026-09-30

- No secrets in edit notes, readable identifiers

## 3.15.0 — 2026-09-30

- Dense working notes

## 3.14.1 — 2026-09-30

- Review fixes

## 3.14.0 — 2026-09-30

- Jev labels user messages in the background

## 3.13.0 — 2026-09-29

- Readable seed without a model

## 3.12.0 — 2026-09-29

- Frame the seed as plugin memory, not the user's words

## 3.11.1 — 2026-09-29

- Per-project opt-out from S4

## 3.11.0 — 2026-09-29

- Refusal guard sends the session to native compaction

## 3.10.6 — 2026-09-29

- Clean old capture records on read, strip injected blocks instead of dropping messages
- Wrapper blocks only at line start; closing fence is the marker alone
- Strip back-to-back wrapper blocks on one line
- Strip a run of wrapper blocks in one match, no pass cap
- Linear indexOf scan for wrapper blocks

## 3.10.5 — 2026-09-29

- Live-seed audit fixes

## 3.10.4 — 2026-09-28

- Bare "do" opens a question only before a personal pronoun

## 3.10.3 — 2026-09-28

- Review fixes

## 3.10.2 — 2026-09-28

- Review fixes

## 3.10.1 — 2026-09-28

- Review fixes

## 3.10.0 — 2026-09-28

- Fixes from the first live cut

## 3.9.0 — 2026-09-28

- Fill the seed's File pointers from pre-cut tool calls

## 3.8.0 — 2026-09-28

- Expand short ids in the seed to their full form

## 3.7.1 — 2026-09-28

- Anchor the capture store at the flag directory

## 3.7.0 — 2026-09-28

- Doctor preflight, Jev opt-in in launchers, no double load with a global install

## 3.6.1 — 2026-09-28

- InteractiveOnly option and local marketplace for a global install

## 3.6.0 — 2026-09-28

- Model-free Claude Code compaction plugin with session recall

---

Versions before 3.6.0 were developed inside a larger project and are not listed here.
