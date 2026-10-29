#!/usr/bin/env bash
# exo-compact installer:
#   curl -fsSL https://raw.githubusercontent.com/MarcinSufa/exo-compact/main/install.sh | bash
# It clones the repository (or updates the clone) and registers it with Claude Code as a plugin.
# This is the alternative to the native install (`/plugin marketplace add MarcinSufa/exo-compact`,
# `/plugin install exo-compact@exo-compact`): the plugin is on for every project once it is installed
# and its defaults (session recall on, interactive sessions only) come from the manifest, so this script
# only adds what the native install cannot: the clone, the plugin directory and Node options, and two
# questions about Claude Code's auto-compact (the window, 200000 tokens by default, and whether auto-compact
# is on), which it applies to your Claude Code settings right away (CONTRACT S5x).
# Running it again updates the install and keeps the options you changed; it asks the questions only once.
#   EXO_COMPACT_HOME        where the clone lives (default: ~/.exo-compact)
#   EXO_COMPACT_ENABLE_DIR  optional: turn exo-compact on for this directory with a flag file (it is
#                           already on everywhere by default); "none" keeps it off everywhere, use
#                           `setup.cjs enable <dir>` later
#   EXO_COMPACT_REPO, EXO_COMPACT_REF  the repository, and the tag or branch to install from (default:
#                           the tag of this release; main for unreleased changes)
#   EXO_COMPACT_WINDOW      answers the first question: the auto-compact window in tokens, 100000 to
#                           1000000, or 0 to leave your setting alone (default without a terminal: 200000)
#   EXO_COMPACT_AUTO        answers the second question: 1 turns auto-compact on, 0 leaves your setting
#                           alone (default without a terminal: 1)
set -euo pipefail

say() { printf 'exo-compact: %s\n' "$*"; }
die() { printf 'exo-compact: %s\n' "$*" >&2; exit 1; }

# 0, or a whole number of tokens Claude Code accepts as an auto-compact window; nothing for anything else.
window_value() {
  [[ "$1" =~ ^[0-9]{1,9}$ ]] || return 1
  local tokens=$((10#$1))
  (( tokens == 0 || (tokens >= 100000 && tokens <= 1000000) )) || return 1
  echo "$tokens"
}

# One question on the terminal; with curl | bash stdin is this script, so it reads /dev/tty. End of input
# answers with the default (an empty line).
ask() {
  local answer=''
  printf 'exo-compact: %s ' "$1" >/dev/tty
  IFS= read -r answer </dev/tty || answer=''
  printf '%s' "$answer"
}

# Everything runs from main, so a download that stops halfway runs nothing. Child commands read
# /dev/null: with curl | bash, stdin is this script.
main() {
  local repo="${EXO_COMPACT_REPO:-https://github.com/MarcinSufa/exo-compact.git}"
  local ref="${EXO_COMPACT_REF:-v4.10.0}"
  local dir="${EXO_COMPACT_HOME:-$HOME/.exo-compact}"
  local enable_dir="${EXO_COMPACT_ENABLE_DIR:-}"
  local plugin="$dir/plugin/compact"

  command -v git >/dev/null 2>&1 || die "git is not installed."
  command -v node >/dev/null 2>&1 || die "Node.js is not installed. exo-compact needs Node.js 22.15 or newer: https://nodejs.org"
  command -v claude >/dev/null 2>&1 || die "Claude Code is not installed (no 'claude' on PATH): https://claude.com/claude-code"

  # 4.10.0 (CONTRACT S5x): the auto-compact answers. The environment answers first; a terminal is asked only
  # until the marker exists (auto-compact.mjs writes it once it applied the answers); without either, the
  # defaults. "keep" on a later run passes no option, so a value changed with /plugin configure stays.
  local window=keep auto=keep
  local marker="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/exovault/auto-compact.json"
  local asked=''
  [[ -e "$marker" ]] || asked=defaults
  if [[ -n "$asked" && -t 1 ]] && (: </dev/tty) 2>/dev/null; then asked=terminal; fi
  if [[ -n "${EXO_COMPACT_WINDOW:-}" ]]; then
    window="$(window_value "$EXO_COMPACT_WINDOW")" || die "EXO_COMPACT_WINDOW must be 0 (leave the setting alone) or a number of tokens from 100000 to 1000000, not '$EXO_COMPACT_WINDOW'."
  elif [[ "$asked" == terminal ]]; then
    local reply
    while :; do
      reply="$(ask "Claude Code compacts only when the context window fills: on a 1M model that is 1,000,000 tokens. Set the auto-compact window to 200000 tokens (recommended)? [Y/n or a number]")"
      case "$reply" in
        ''|[Yy]|[Yy][Ee][Ss]) window=200000 ;;
        [Nn]|[Nn][Oo]) window=0 ;;
        *) window="$(window_value "$reply")" || { say "answer y, n, or a number of tokens from 100000 to 1000000."; continue; } ;;
      esac
      break
    done
  elif [[ "$asked" == defaults ]]; then
    window=200000
  fi
  case "${EXO_COMPACT_AUTO:-}" in
    1|true) auto=true ;;
    0|false) auto=false ;;
    '')
      if [[ "$asked" == terminal ]]; then
        while :; do
          case "$(ask "Turn auto-compact on, so exo-compact runs when the window fills? [Y/n]")" in
            ''|[Yy]|[Yy][Ee][Ss]) auto=true ;;
            [Nn]|[Nn][Oo]) auto=false ;;
            *) say "answer y or n."; continue ;;
          esac
          break
        done
      elif [[ "$asked" == defaults ]]; then
        auto=true
      fi ;;
    *) die "EXO_COMPACT_AUTO must be 1 (turn auto-compact on) or 0 (leave the setting alone), not '$EXO_COMPACT_AUTO'." ;;
  esac

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

  # The same call installs and re-configures: it sets the plugin directory, the Node binary and the
  # auto-compact answers given on this run, so the other options stay at the manifest defaults, or as the
  # user left them on a later run. The hook runs its scripts with that absolute Node, not the first node on
  # a PATH a project can change (CONTRACT S5w).
  local node_bin
  node_bin="$(node -p process.execPath </dev/null)" || die "could not find the path of node."
  local configs=(--config "recallPluginRoot=$plugin" --config "nodePath=$node_bin")
  [[ "$window" == keep ]] || configs+=(--config "autoCompactWindow=$window")
  [[ "$auto" == keep ]] || configs+=(--config "autoCompact=$auto")
  claude plugin marketplace add "$dir" </dev/null >/dev/null || die "claude could not add the marketplace at $dir."
  claude plugin install exo-compact@exo-compact "${configs[@]}" </dev/null >/dev/null || die "claude could not install the plugin."
  # A Claude Code that copies the plugin instead of reading it from the clone needs these two.
  claude plugin marketplace update exo-compact </dev/null >/dev/null 2>&1 || true
  claude plugin update exo-compact@exo-compact </dev/null >/dev/null 2>&1 || true

  # The settings change now, not at the first session start, and the line saying so goes in the summary.
  local applied=''
  if [[ "$window" != keep || "$auto" != keep ]]; then
    applied="$(node "$plugin/auto-compact.mjs" apply "$window" "$auto" </dev/null)" || true
  fi

  if [[ "$enable_dir" == none ]]; then
    node "$plugin/setup.cjs" disable "$HOME"
  elif [[ -n "$enable_dir" ]]; then
    node "$plugin/setup.cjs" enable "$enable_dir"
  fi

  local version
  version="$(node -p 'require(process.argv[1]).version' "$plugin/.claude-plugin/plugin.json")"
  echo
  echo "exo-compact $version is installed."
  [[ -z "$applied" ]] || echo "$applied"
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
