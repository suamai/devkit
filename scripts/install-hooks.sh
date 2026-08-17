#!/bin/sh
# Install this repo's OPT-IN git hooks. Never run by anything else — no postinstall, no bootstrap,
# nothing in `install.sh` calls it. A pre-commit hook that appears without being asked for is how
# people learn to type `--no-verify`, which costs more than the hook buys.
#
# What the hook protects: this repo's thesis is *treat prompts as code*, and `tests/run-all.sh` is
# what makes changing a prompt stop being a bet — the drift test especially, which catches prose that
# no longer matches the scripts, the failure no reviewer catches because nobody diffs a SKILL.md
# against a schema. Until this hook exists, the only thing enforcing any of it is memory.
#
# The suite is node-with-no-dependencies and finishes well under a second, and it now includes the
# three workflow `dryRun` calls (tests/dryrun-smoke.test.js), so the hook is one line and there is no
# argument for skipping it.
#
# Usage:
#   sh scripts/install-hooks.sh              install (refuses to overwrite an unrelated hook)
#   sh scripts/install-hooks.sh --force      replace whatever pre-commit is there
#   sh scripts/install-hooks.sh --uninstall  remove it, if it is ours

set -e

repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "not a git repository: $repo" >&2; exit 1; }

# `core.hooksPath` and worktrees both move this; asking git is the only reliable answer.
hooks=$(git rev-parse --git-path hooks)
mkdir -p "$hooks"
target="$hooks/pre-commit"
source="$repo/hooks/pre-commit"
marker='devkit-pre-commit'

case "${1:-}" in
  --uninstall)
    if [ ! -e "$target" ]; then
      echo "no pre-commit hook installed"
    elif grep -q "$marker" "$target" 2>/dev/null; then
      rm "$target"
      echo "removed $target"
    else
      echo "$target is not the devkit hook — leaving it alone" >&2
      exit 1
    fi
    exit 0
    ;;
  --force) force=1 ;;
  '') force=0 ;;
  *) echo "unknown option: $1 (--force | --uninstall)" >&2; exit 1 ;;
esac

[ -f "$source" ] || { echo "missing $source" >&2; exit 1; }

if [ -e "$target" ] && [ "$force" -ne 1 ]; then
  if grep -q "$marker" "$target" 2>/dev/null; then
    echo "already installed (reinstalling to pick up changes)"
  else
    echo "$target already exists and is not the devkit hook." >&2
    echo "inspect it, then re-run with --force to replace it." >&2
    exit 1
  fi
fi

cp "$source" "$target"
chmod +x "$target"

echo "installed $target"
echo "it runs: sh tests/run-all.sh   (bypass once with git commit --no-verify)"
