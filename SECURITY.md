# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability** (GitHub private vulnerability reporting). Do not open a public issue, pull request or
discussion for a security problem.

A useful report names the exo-compact version (`.claude-plugin/plugin.json`), the Claude Code version, the operating
system, and the steps or input that show the problem. Reports are read by the maintainer; you will get an answer in the
advisory thread, and a fix is released as a new version with a CHANGELOG entry. Credit is given in the advisory unless
you ask otherwise.

## Supported versions

Only the latest release gets security fixes. The installers pin a release tag, so updating means running the installer
again.

## What exo-compact does with your data

exo-compact runs inside Claude Code on your machine. In the default configuration everything stays local: there is no
telemetry and no server of its own, and nothing the session contains is sent anywhere by exo-compact. Two optional
features send data to TypeSafe's Jev API (or to the Jev-compatible server `EXO_JEV_URL` names); both are off by default,
are switched on in the plugin options, and stay off in any working directory that matches `jevDenyList`:

- **`jevEnabled`** (selector J): sends span text from the session to Jev to choose what the seed keeps, lets Jev re-rank
  working notes at a cut, and lets Jev rank session-search results (`search_session` sends the query and up to 20
  redacted excerpts).
- **`ruleCheck`** (rule check before stopping): sends the final message of a turn and the uncommitted diff of the working
  directory to Jev at every main-loop stop that has a task card. It is its own opt-in, independent of `jevEnabled`.

The optional vectors runtime downloads packages from npm and a model from Hugging Face on first use; it sends no session
text. What exo-compact writes:

- **Capture store** (`~/.exovault/s4-capture/<session>/`, or under the nearest directory above the working directory that
  holds an exo-compact flag): records of the session used to build the
  post-compaction seed, the task card and the held brief. Directories are set to 0700 and files to 0600 before the
  first capture write and after every turn and every compaction. If `.exovault`, the capture store or the session
  directory is a symlink, is not a directory owned by the user, or cannot be set to 0700, nothing is captured there:
  the check runs (and is awaited) before the first write under every newly chosen store, also when the working
  directory changes during a session. Secrets that look like provider keys, bearer tokens,
  URL passwords and named credentials are redacted when a record is written, not only later. The held brief (the one
  verbatim copy of a prompt) is deleted once it is back in the prompt box.
- **Recall index** (`~/.claude/exovault/recall/`): a redacted, searchable copy of past session transcripts, owner-only.
- **Optional vectors runtime** (`~/.claude/exovault/recall-runtime/`): see below.

## Hardening in place

- **Plugin root.** The hook runs its own scripts only from the directory Claude Code loaded it from (`$.plugin.root`).
  It never reads `CLAUDE_PLUGIN_ROOT`, which a cloned project's `.claude/settings.json` can set through its `env` block.
  The `recallPluginRoot` option is a fallback for hosts without `$.plugin.root`, comes from the user's own settings, and
  must be an absolute path without `..`.
- **Node child processes.** Every Node script the hook starts runs with `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`,
  `DYLD_INSERT_LIBRARIES` and similar variables cleared, because a cloned project's `.claude/settings.json` can set them
  (and `PATH`) through its `env` block. The installers record the absolute path of the Node that ran them as the
  `nodePath` option, which comes from the user's own settings; without it the hook falls back to `node` from `PATH`.
  The brief digest starts `claude` only from `~/.local/bin` or from next to its own Node binary, never from `PATH`.
- **Seed integrity.** The seed that replaces the compacted context quotes text exo-compact did not write (tool output,
  notes, file contents). Before the seed's own section headings are added, every section body is checked: a `#` or `##`
  heading that names a seed section (for example `## Constraints` or `## Task card`) is demoted, including inside code
  fences, quotes, tables and list items, after Unicode folding, and when the name is wrapped in a Markdown link or inline
  HTML tags; `session-memory` and `system-reminder` tags lose their opening bracket, also when zero-width or combining
  characters are hidden inside the tag; Unicode line breaks are normalized first. The Constraints section is built only from text the user
  typed, and from files the user explicitly told the session to follow.
- **Vectors runtime supply chain.** The optional local embedding runtime (`@huggingface/transformers` 4.3.0 and its
  dependencies) is installed with `npm ci --ignore-scripts` from a lock shipped with the plugin
  (`plugin/compact/recall/runtime-lock.json`): every package is an exact version with its npm registry integrity hash,
  and no package runs an install script. The embedding model (`Xenova/multilingual-e5-small`) is downloaded from a
  pinned Hugging Face commit, not from `main`. The model runs on the CPU; no text leaves the machine.
- **Local socket.** The recall push server listens on a Unix socket in an owner-only (0700) directory, or on a Windows
  named pipe whose name carries 128 random bits. Every request must carry a per-server random token, which is stored in
  an owner-only pointer file.

## Known limits

- **Windows file permissions.** On Windows, Node's `chmod` only toggles the read-only flag, so the 0700/0600 modes
  above do not apply there. Capture files, the recall index and the push server's token file keep the ACL they inherit
  from their parent directory; under the default user profile ACL that is the user, SYSTEM and Administrators. Keep
  projects and the profile in directories other local users cannot read.
- **Windows named pipe.** The pipe keeps Windows' default named-pipe security descriptor (full control for the owner,
  SYSTEM and Administrators, read access for Everyone). A request needs write access to the pipe and the token, so another
  local user cannot query it; the random name prevents another user from guessing it and serving a pipe of their own
  under it.
- **Redaction is pattern based.** It catches common credential shapes, not every secret. Do not paste secrets into a
  session you would not want stored locally.
- **Model registry trust.** The vectors runtime trusts the npm registry and Hugging Face to serve the pinned content;
  npm verifies every package against the shipped integrity hashes, and the model is fetched by commit.
- **Node from `PATH`.** Without the `nodePath` option (an install that did not go through the installers), the hook
  starts `node` from `PATH`, which a project's `env` block can change. Its environment is still cleared as above. Run
  the installer again, or set `nodePath` to an absolute path, to close this.
- **A verified store is trusted for the session.** The capture store is checked once per session before its first write;
  a local process that replaces it with a symlink later in the session is not detected until the next session.
- **The seed is read by a model.** Seed integrity stops forged section headings and wrapper tags. It cannot stop a model
  from following an instruction that appears inside quoted reference material; the seed labels such material as
  reference only, not requests.
