# Development

```bash
cd ~/.exo-compact
npm install             # dev tools only: vitest, TypeScript
npm test                # gate tests plus the replay and eval tool tests
npm run typecheck       # against the committed stub of the claude-code module (also in CI)
npm run typecheck:full  # against Claude Code's own declarations, when you have them
```

- **Claude Code types.** `npm run typecheck` reads `types/claude-code.d.ts`, a small hand-written stub
  of the `claude-code` module, so a fresh clone and CI can typecheck. It declares only what the two
  entry points use, in the shapes Claude Code's own declarations give them: the seven events they
  register, the `$` methods they call and the event fields they read. A misspelt event, method or
  field fails it; values the code only passes along stay `unknown`. When a hook starts using a new
  `$` method or event field, add it to the stub. `npm run typecheck:full` checks the
  hooks against Claude Code's own declarations instead, from
  `plugin/compact/.claude-plugin/types/claude-code/index.d.ts`. That file is not in the repository.
  Claude Code writes it beside the mod whenever it loads the plugin, so start `claude` once with the
  plugin loaded (for example `claude --plugin-dir plugin/compact`) first.
  `claude plugin validate plugin/compact` does not write it.
- **CI.** `.github/workflows/ci.yml` runs `npm ci`, `npm run typecheck` and `npm test` on Node 22.15
  and 24 for every pull request and every push to `main`.
- **Rules.** `plugin/compact/CONTRACT.md` is the behavioural contract. Each version adds a
  numbered section, and the gate tests in `plugin/compact/__gate-s4__/` enforce it. Comments and
  the contract sometimes mention `GATE.md`, `tools/ctxbench` or `docs/ctx-s4`: those belong to the
  private development harness and are not in this repository.
- **Public tree.** `node tools/public-tree.mjs <out-dir> [--ref <ref>] [--author "Name <email>"] [--verify]` builds
  the public repository from the private one: the tracked files of one ref without those paths, as a new repository
  with one commit, no history and no remote. The commit is by `--author`, or else by the identity git would commit
  with in this clone (`GIT_AUTHOR_*`, then local, then global `user.name` and `user.email`, so a clone with its own
  identity wins over your global one); with neither, it stops. The summary line names the author. `--verify` runs `npm ci`, `npm run typecheck` and
  `npm test` in it.
- **Offline replay.** `tools/hook-replay/replay.mjs` runs the real hook offline on recorded
  sessions. It costs nothing, so use it for any change to how seeds are built before a live test.
- **Changes.** [CHANGELOG.md](../CHANGELOG.md) lists what changed in each version.

Issues and pull requests are welcome. Please include `node ~/.exo-compact/plugin/compact/setup.cjs doctor --json`
output and, for compaction problems, the `tools/status.mjs` lines for the session.

## Repository layout

```
plugin/compact/            the Claude Code plugin
  compact.ts               function-hook module (session.compact, prompt, tool and stop hooks)
  core/                    pure seed building: extraction, budgets, card, briefs, work state
  host/                    adapters around the Claude Code host API
  recall/                  search_session MCP server, index and embedding workers, push and check hooks
  __gate-s4__/             gate tests
  CONTRACT.md              behavioural contract, one section per version
  setup.cjs, doctor.mjs    activation flags and preflight
plugin/compact-trigger/    optional experimental soft-trigger companion, listed in the marketplace but not used by the launchers
launch/                    exo-compact.sh / exo-compact.ps1 launchers
tools/                     status, offline hook replay, real-transcript replay, eval and A/B harnesses
docs/                      user documentation
```

