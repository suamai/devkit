#!/bin/sh
# Install this repo's committed state as the plugin Claude Code loads — a frozen COPY, never a
# symlink back to the working tree.
#
# Why a copy. `${CLAUDE_PLUGIN_ROOT}` expands to the install path, and a symlink there resolves
# *through* it into the working tree. That is fine for every other repo and wrong for this one,
# because here the plugin is also the thing being edited:
#
#   - `/dev-implement` passes `reviewLoopPath` as `${CLAUDE_PLUGIN_ROOT}/workflows/wf-review-loop.js`,
#     and `scriptPath` reads from disk at invocation time. Under a symlink, a step that edits that
#     file changes the review loop of the very run that is about to review it.
#   - Stopping early is a DESIGNED outcome of `wf-implement` (blocking question, unclean checkpoint,
#     failed step, budget floor). Under a symlink, a stopped run leaves the tooling itself
#     half-edited, and the next session loads it.
#
# So: run this BETWEEN plans, never during one, and restart Claude Code afterwards — `name:`
# resolution serves a snapshot taken when the plugin loaded, so nothing here reaches a live session.
#
# The install is left read-only on purpose. Two copies that can both be written are two copies that
# diverge silently; an agent with the wrong working directory then edits the install and the bug is
# invisible. Read-only turns that into an error.
#
# Only committed content is promoted (`git archive HEAD`), so untracked scratch — IDEAS.md, .dev/ —
# never ships, and the SHA in FROZEN_AT names exactly what is installed.
#
# Usage: sh scripts/promote-plugin.sh [target]     (default: ~/.claude/skills/devkit)

set -e

repo=$(cd "$(dirname "$0")/.." && pwd)
target=${1:-$HOME/.claude/skills/devkit}

# A bare `rm -rf "$target"` on a bad argument is the one way this script could ruin someone's day.
case "$target" in
  "" | "/" | "$HOME" | "$HOME/" | "$HOME/.claude" | "$HOME/.claude/")
    echo "refusing to install over: $target" >&2
    exit 1
    ;;
esac

cd "$repo"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "not a git repository: $repo" >&2
  exit 1
fi

# Tracked modifications would make the install differ from what you are looking at — `git archive`
# ships HEAD, not the working tree. Untracked files are excluded by design and are not an error.
if ! git diff-index --quiet HEAD --; then
  echo "working tree has uncommitted changes to tracked files — commit them first:" >&2
  git status --short >&2
  exit 1
fi

# Never promote a tree whose own suite fails. This is the same rule the pipeline applies to itself:
# verification means running the check, not reading the diff.
echo "running the suite before promoting..."
sh tests/run-all.sh >/dev/null 2>&1 || { sh tests/run-all.sh; echo "suite failed — not promoting" >&2; exit 1; }

sha=$(git rev-parse HEAD)
short=$(git rev-parse --short HEAD)

# Replace only something that is absent, a symlink, empty, or recognisably a previous install.
if [ -L "$target" ]; then
  rm "$target"
elif [ -d "$target" ]; then
  if [ -f "$target/.claude-plugin/plugin.json" ] || [ -z "$(ls -A "$target")" ]; then
    chmod -R u+w "$target"
    rm -rf "$target"
  else
    echo "$target exists and does not look like a devkit install — move it aside first" >&2
    exit 1
  fi
elif [ -e "$target" ]; then
  echo "$target exists and is not a directory or symlink" >&2
  exit 1
fi

mkdir -p "$target"
git archive HEAD | tar -x -C "$target"
printf '%s\n' "$sha" > "$target/FROZEN_AT"
chmod -R a-w "$target"

echo "installed $short at $target (read-only)"
echo "restart Claude Code — workflows and skills register at session start."
