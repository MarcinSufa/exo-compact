#!/usr/bin/env bash
# exo-compact installer:
#   curl -fsSL https://raw.githubusercontent.com/MarcinSufa/exo-compact/main/install.sh | bash
# It clones the repository (or updates the clone) and registers it with Claude Code as a plugin.
# This is the alternative to the native install (`/plugin marketplace add MarcinSufa/exo-compact`,
# `/plugin install exo-compact@exo-compact`): the plugin is on for every project once it is installed
# and its defaults (session recall on, interactive sessions only) come from the manifest, so this script
# only adds what the native install cannot: the clone, and the plugin directory option.
# Running it again updates the install and keeps the options you changed.
#   EXO_COMPACT_HOME        where the clone lives (default: ~/.exo-compact)
#   EXO_COMPACT_ENABLE_DIR  optional: turn exo-compact on for this directory with a flag file (it is
#                           already on everywhere by default); "none" keeps it off everywhere, use
#                           `setup.cjs enable <dir>` later
#   EXO_COMPACT_REPO, EXO_COMPACT_REF  the repository, and the tag or branch to install from (default:
#                           the tag of this release; main for unreleased changes)
set -euo pipefail

say() { printf 'exo-compact: %s\n' "$*"; }
die() { printf 'exo-compact: %s\n' "$*" >&2; exit 1; }

# Everything runs from main, so a download that stops halfway runs nothing. Child commands read
# /dev/null: with curl | bash, stdin is this script.
main() {
  local repo="${EXO_COMPACT_REPO:-https://github.com/MarcinSufa/exo-compact.git}"
  local ref="${EXO_COMPACT_REF:-v4.9.2}"
  local dir="${EXO_COMPACT_HOME:-$HOME/.exo-compact}"
  local enable_dir="${EXO_COMPACT_ENABLE_DIR:-}"
  local plugin="$dir/plugin/compact"

  command -v git >/dev/null 2>&1 || die "git is not installed."
  command -v node >/dev/null 2>&1 || die "Node.js is not installed. exo-compact needs Node.js 22.15 or newer: https://nodejs.org"
  command -v claude >/dev/null 2>&1 || die "Claude Code is not installed (no 'claude' on PATH): https://claude.com/claude-code"

  if [[ -d "$dir/.git" ]]; then
    say "updating $dir to $ref"
    # Fetch and check out $ref rather than pull: a clone made from another ref (main) still moves to EXO_COMPACT_REF.
    { git -C "$dir" fetch --quiet --depth 1 origin "$ref" && git -C "$dir" checkout --quiet --detach FETCH_HEAD; } \
      || die "could not update $dir to $ref. If you changed files there, undo that or remove the folder, then run the installer again."
  elif [[ -e "$dir" ]]; then
    die "$dir exists and is not an exo-compact clone. Move it away, or set EXO_COMPACT_HOME to another folder."
  else
    say "downloading to $dir"
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$ref" "$repo" "$dir" || die "could not clone $repo."
  fi

  # The preflight check stops here on a Node.js or Claude Code that is too old.
  node "$plugin/setup.cjs" doctor --preflight </dev/null || die "the check above failed, so nothing was registered with Claude Code."

  # The same call installs and re-configures: it sets only the plugin directory and the Node binary, so the
  # other options stay at the manifest defaults, or as the user left them on a later run. The hook runs its
  # scripts with that absolute Node, not the first node on a PATH a project can change (CONTRACT S5w).
  local node_bin
  node_bin="$(node -p process.execPath </dev/null)" || die "could not find the path of node."
  claude plugin marketplace add "$dir" </dev/null >/dev/null || die "claude could not add the marketplace at $dir."
  claude plugin install exo-compact@exo-compact --config "recallPluginRoot=$plugin" --config "nodePath=$node_bin" </dev/null >/dev/null || die "claude could not install the plugin."
  # A Claude Code that copies the plugin instead of reading it from the clone needs these two.
  claude plugin marketplace update exo-compact </dev/null >/dev/null 2>&1 || true
  claude plugin update exo-compact@exo-compact </dev/null >/dev/null 2>&1 || true

  if [[ "$enable_dir" == none ]]; then
    node "$plugin/setup.cjs" disable "$HOME"
  elif [[ -n "$enable_dir" ]]; then
    node "$plugin/setup.cjs" enable "$enable_dir"
  fi

  local version
  version="$(node -p 'require(process.argv[1]).version' "$plugin/.claude-plugin/plugin.json")"
  echo
  echo "exo-compact $version is installed."
  if [[ "$enable_dir" == none ]]; then
    echo "  It is off everywhere. Turn it on for a folder and everything below it:"
    echo "    node $plugin/setup.cjs enable <dir>"
  else
    echo "  It is on for every project."
    echo "  Keep it off for one project:  node $plugin/setup.cjs optout <dir>"
  fi
  echo "  Start claude as usual. A session that is already running needs a restart."
  echo "  See what it did:              node $dir/tools/status.mjs"
  echo "  Update:                       run this installer again"
}

main "$@"
