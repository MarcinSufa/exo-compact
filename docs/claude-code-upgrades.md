# Claude Code upgrade checklist

Run this after updating Claude Code. New sessions load the installed plugin, so use a fresh session
for the check.

1. Check the installed version with `claude --version` and start a new interactive session in a
   project where exo-compact is enabled.
2. Run `node ~/.exo-compact/plugin/compact/setup.cjs doctor`. Check the Claude Code and plugin version
   lines, then the `hooks` line. The hooks check summarizes the last seven days, reading at most 50
   notice files. `no sessions yet` means it has no recent notices to inspect. In an attended session
   using the default quiet notice policy, SessionStart records `claude_code.version=<x.y.z>` in the
   session notice log. Doctor compares the installed version
   with the newest recorded version that has a seed cut in the window, and warns when the installed
   version has not cut a seed yet. If the window has no version-tagged seed cut, the comparison is
   unavailable until a successful `/compact` establishes a baseline. Because a notice log retains only its last
   1,500 lines, a long session can lose the version line or cuts needed for comparison; doctor reports the comparison
   as unavailable for that session.
3. In that session, run `/compact` once. After a successful exo-compact cut, the new context starts
   with `[[exovault:s4-seed:v1]]`. A short conversation can fall back because the seed is not at least
   25% smaller than the messages.
4. Check `node ~/.exo-compact/tools/status.mjs` and the project's
   `.exovault/s4-capture/<session>/notices.log` (or the home capture directory). Look for:
   - `compacted ...` for a cut handled by the seed.
   - `compact.fallback=<reason> origin=compact` for a cut handed to native compaction.
   - Error notices such as `task_card.refresh=no_reply reason=error` or
     `seed.work_state_probe=error`. The doctor reports their share and counts by kind.
   - `claude_code.version=<x.y.z>` for the Claude Code release used by that session.

   `insufficient_reduction`, `refusal_guard`, and `interactive_only` can be expected. Repeated
   `budget`, `timeout`, or `error` fallbacks after an upgrade merit investigation. Start with the
   doctor output and the fallback reason in status.
5. If the regression is in Claude Code, return to the last known good version using the same installer
   that installed it. For an npm installation, install the prior version with
   `npm install -g @anthropic-ai/claude-code@<last-known-good-version>`. The `claude update` command
   moves to the latest version. See [Claude Code installation and update instructions](https://docs.anthropic.com/en/docs/claude-code/getting-started).
   To disable exo-compact instead, run `claude plugin uninstall exo-compact@exo-compact`, or use
   `node ~/.exo-compact/plugin/compact/setup.cjs optout <project-dir>` to turn it off for one project.

After restoring or disabling it, restart Claude Code and run the doctor again.
