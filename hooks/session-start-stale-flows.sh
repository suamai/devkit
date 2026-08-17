#!/bin/sh
# SessionStart: say something only when a workspace was left at `implementing`.
#
# That stage means an implement run started and did not finish — and stopping early is a DESIGNED
# outcome of wf-implement (blocking question, unclean checkpoint, failed step, budget floor), not
# only a crash. The workspace holds everything needed to continue, but nothing surfaced it: you found
# out by remembering to run /dev-status, which is exactly the memory this repo keeps trying to
# replace with a check. Meanwhile /dev-implement treats an `implementing` workspace as a concurrency
# lock, so a forgotten one blocks the next run for a reason nobody can see.
#
# Silence is the contract. A hook that prints on every session start is a hook that gets removed, so
# a clean repo produces no output at all. No node, no jq — a SessionStart hook runs in every repo
# that installs the plugin, and it cannot assume either.
#
# Usage: sh hooks/session-start-stale-flows.sh [repo-root]   (default: $CLAUDE_PROJECT_DIR or .)

root=${1:-${CLAUDE_PROJECT_DIR:-.}}
cd "$root" 2>/dev/null || exit 0
[ -d .dev ] || exit 0

# `set -- .dev/*/state.json` with nullglob unavailable: an unmatched pattern stays literal, so test it.
set -- .dev/*/state.json
[ -e "$1" ] || exit 0

# Pull a top-level string field out of JSON without a parser. Newlines become spaces first, so this
# reads a pretty-printed file and a compact one identically. Good enough because these files have one
# writer (the skills) and a flat, known shape — not good enough to be reused for arbitrary JSON.
field() {
  tr '\n' ' ' < "$2" | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

found=''
n=0
for state in "$@"; do
  [ -f "$state" ] || continue
  [ "$(field stage "$state")" = "implementing" ] || continue
  slug=$(basename "$(dirname "$state")")
  updated=$(field updated "$state")
  found="$found  - $slug${updated:+  (last updated $updated)}
"
  n=$((n + 1))
done

[ "$n" -gt 0 ] || exit 0

if [ "$n" -eq 1 ]; then
  printf 'devkit: a workspace is left at `implementing` — an implement run that did not finish:\n'
else
  printf 'devkit: %d workspaces are left at `implementing` — implement runs that did not finish:\n' "$n"
fi
printf '%s' "$found"
printf 'Continue with /dev-implement <slug>, or clear it with /dev-status.\n'
printf '/dev-implement treats these as a concurrency lock, so a stale one blocks the next run.\n'
