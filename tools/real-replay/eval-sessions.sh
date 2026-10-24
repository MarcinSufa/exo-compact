#!/usr/bin/env bash
# Offline evaluation of S4 (with and without Jev re-ranking) against native compaction on a set of
# transcripts. No Claude calls. Jev calls only when TYPESAFE_API_KEY is set (or JEV_ENV names a file
# to source for it); without a key the Jev arms are skipped.
#
#   tools/real-replay/eval-sessions.sh <out-dir> <transcript.jsonl>...
#
# MAX_CANDIDATES="4000 16000" sweeps how many of the newest note lines dense notes consider
# (the plugin uses 4000). Every step is resumable: delete an arm's directory to rerun it.
set -euo pipefail
OUT=$1; shift
[ $# -gt 0 ] || { echo "usage: $0 <out-dir> <transcript.jsonl>..." >&2; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
if [ -n "${JEV_ENV:-}" ]; then set -a; . "$JEV_ENV"; set +a; fi
ARMS=()

replay() { # name, extra env...
  local name=$1; shift
  if [ ! -s "$OUT/$name/replay.json" ]; then
    mkdir -p "$OUT/$name"
    env REPLAY_STRICT_NEEDED=used REPLAY_NO_RECALL=1 "$@" node --experimental-strip-types "$HERE/real-replay.mjs" "${TRANSCRIPTS[@]}" --out "$OUT/$name/replay.json" > "$OUT/$name/replay.md" 2> "$OUT/$name/replay.err"
  fi
  ARMS+=("$name=$OUT/$name/replay.json")
}

TRANSCRIPTS=("$@")
for M in ${MAX_CANDIDATES:-4000}; do
  rm -f "$OUT/cands-$M.jsonl.tmp"
  if [ ! -s "$OUT/base-$M/replay.json" ]; then
    replay "base-$M" REPLAY_DENSE_MAX_CANDIDATES=$M REPLAY_DENSE_JEV_DUMP="$OUT/cands-$M.jsonl"
  else
    ARMS+=("base-$M=$OUT/base-$M/replay.json")
  fi
  if [ -n "${TYPESAFE_API_KEY:-}" ]; then
    node "$HERE/jev-dense.mjs" "$OUT/cands-$M.jsonl" --out "$OUT/scores.jsonl" --metrics "$OUT/jev-calls.jsonl" --concurrency 6 2> "$OUT/jev-$M.err" || { tail -3 "$OUT/jev-$M.err" >&2; exit 1; }
    replay "jev-$M" REPLAY_DENSE_MAX_CANDIDATES=$M REPLAY_DENSE_JEV_SCORES="$OUT/scores.jsonl"
  fi
done

node "$HERE/eval-summary.mjs" "${ARMS[@]}" | tee "$OUT/summary.txt"
if [ -s "$OUT/jev-calls.jsonl" ]; then
  node -e '
    const rows = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse);
    const ms = rows.map((r) => r.ms).sort((a, b) => a - b), tok = rows.reduce((n, r) => n + (r.inputTokens || 0), 0);
    console.log(`jev: ${rows.length} requests, ${rows.filter((r) => r.error).length} errors, ${tok} input tokens (~$${(tok * 0.042e-6).toFixed(2)}), p50 ${ms[ms.length >> 1]} ms`);
  ' "$OUT/jev-calls.jsonl" | tee -a "$OUT/summary.txt"
fi
