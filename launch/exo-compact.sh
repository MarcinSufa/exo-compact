#!/usr/bin/env bash
# Start Claude Code with the exo-compact (S4) plugin + session recall in the current directory.
# S4_WINDOW=<tokens> sets the auto-compact window; S4_JEV=1 enables selector J (sends span text
# to TypeSafe, needs TYPESAFE_API_KEY); S4_SKIP_DOCTOR=1 skips the preflight check.
# Opt-out: start plain `claude`, or run `node $S4/setup.cjs disable` in the project dir.
set -euo pipefail
S4="$(cd "$(dirname "${BASH_SOURCE[0]}")/../plugin/compact" && pwd)"
node "$S4/setup.cjs" enable "$PWD" >&2
JEV=false
[[ "${S4_JEV:-}" == 1 ]] && JEV=true
if [[ "${S4_SKIP_DOCTOR:-}" != 1 ]]; then
  DOCTOR_ARGS=()
  [[ "$JEV" == true ]] && DOCTOR_ARGS+=(--jev)
  set +e
  node "$S4/doctor.mjs" ${DOCTOR_ARGS[@]+"${DOCTOR_ARGS[@]}"} >&2
  code=$?
  set -e
  if [[ "$code" == 3 ]]; then
    if [[ -t 0 ]]; then
      read -r -p "Jev is not working. Start without Jev? [y/N] " answer
      [[ "$answer" == [yY]* ]] || exit 3
    else
      echo "exo-compact: Jev is not working, starting without it" >&2
    fi
    JEV=false
  elif [[ "$code" != 0 ]]; then
    exit "$code"
  fi
fi
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
if [[ -n "${S4_WINDOW:-}" ]]; then
  export CLAUDE_CODE_AUTO_COMPACT_WINDOW="$S4_WINDOW"
fi
# 4.9.2 (CONTRACT S5w): the hook starts its Node scripts with this binary, not with whatever `node` a project's env
# block puts first on PATH. Empty when node is missing; the hook then falls back to `node`.
NODE_BIN="$(node -p process.execPath </dev/null 2>/dev/null || true)"
OPTS="{\"recallEnabled\":true,\"recallPluginRoot\":\"$S4\",\"nodePath\":\"$NODE_BIN\",\"jevEnabled\":$JEV}"
# A global install (claude plugin install ...@exo-compact) already loads the plugin; adding
# --plugin-dir would load a second copy, so only its options are passed.
INSTALLED="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/installed_plugins.json"
# 4.0.0 renamed the plugin; the old id would load a second copy next to --plugin-dir.
if [[ -f "$INSTALLED" ]] && grep -q '"exovault-s4-compact@exo-compact"' "$INSTALLED"; then
  echo "exo-compact: the plugin was renamed in 4.0.0; replace the old install first:" >&2
  echo "  claude plugin uninstall exovault-s4-compact@exo-compact && claude plugin install exo-compact@exo-compact ..." >&2
  exit 1
fi
if [[ -f "$INSTALLED" ]] && grep -q '"exo-compact@exo-compact"' "$INSTALLED"; then
  GLOBAL_OPTS="{\"recallEnabled\":true,\"recallPluginRoot\":\"$S4\",\"nodePath\":\"$NODE_BIN\",\"interactiveOnly\":true,\"jevEnabled\":$JEV}"
  exec claude --settings "{\"pluginConfigs\":{\"exo-compact@exo-compact\":{\"options\":$GLOBAL_OPTS}}}" "$@"
fi
SETTINGS="{\"pluginConfigs\":{\"exo-compact\":{\"options\":$OPTS},\"exo-compact@inline\":{\"options\":$OPTS}}}"
exec claude --plugin-dir "$S4" --settings "$SETTINGS" "$@"
