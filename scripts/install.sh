#!/bin/sh
# First-run install on a fresh machine. The counterpart to `promote-plugin.sh`, which is the
# between-plans command for someone who *edits* devkit and assumes everything is already set up.
#
# This is a deliberately thin wrapper: the copy logic lives in `promote-plugin.sh` and is not
# repeated here, because two scripts that both know how to install are two scripts that drift. What
# this adds is the part a first run needs and a promote does not — checking the prerequisites before
# doing anything, saying what is about to happen, and saying what to do afterwards.
#
# It installs a frozen, read-only COPY. The old advice was `ln -s ~/projects/devkit
# ~/.claude/skills/devkit`, and that is now wrong for anyone who edits the plugin: under a symlink,
# `${CLAUDE_PLUGIN_ROOT}` resolves back into the working tree, so a step that edits a workflow
# changes the workflow of the run that is editing it, and a run that stops early (a designed outcome)
# leaves the tooling half-edited for the next session. If you already followed the old advice, this
# replaces the symlink — `promote-plugin.sh` removes one on sight.
#
# Usage:
#   git clone https://github.com/suamai/devkit.git ~/projects/devkit
#   sh ~/projects/devkit/scripts/install.sh [target]     (default: ~/.claude/skills/devkit)

set -e

repo=$(cd "$(dirname "$0")/.." && pwd)
target=${1:-$HOME/.claude/skills/devkit}

missing=''
for cmd in git node; do
  command -v "$cmd" >/dev/null 2>&1 || missing="$missing $cmd"
done
if [ -n "$missing" ]; then
  # node is not optional here even though the plugin never runs it: the install refuses to ship a
  # tree whose suite has not passed, and the suite is node.
  echo "missing required command(s):$missing" >&2
  echo "git is needed to install a pinned copy; node is needed to run the suite first." >&2
  exit 1
fi

if ! git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "$repo is not a git clone." >&2
  echo "clone the repository first, then run this script from inside it:" >&2
  echo "  git clone https://github.com/suamai/devkit.git ~/projects/devkit" >&2
  echo "  sh ~/projects/devkit/scripts/install.sh" >&2
  exit 1
fi

version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$repo/.claude-plugin/plugin.json" | head -1)

echo "installing devkit ${version:-?} from $repo"
echo "  target:  $target   (frozen read-only copy of HEAD, not a symlink)"
if [ -L "$target" ]; then
  echo "  note:    replacing an existing SYMLINK — that was the old install advice; see this script's header"
elif [ -d "$target" ]; then
  echo "  note:    replacing an existing install"
fi
echo

sh "$repo/scripts/promote-plugin.sh" "$target"

cat <<EOF

next:
  1. restart Claude Code — skills and workflows register at session start.
  2. run /dev-setup inside a project to configure it (gitignore, CLAUDE.md, Workflow permission,
     the stale-flow hook, and a zero-cost smoke test of the three workflows).
  3. read docs/manual.md (5 minutes). docs/architecture.md is the design rationale.

to update later: git pull in $repo, then re-run this script (or scripts/promote-plugin.sh).
CHANGELOG.md says what changed between the version a repo was configured against and this one.

if you plan to EDIT devkit itself, also run: sh $repo/scripts/install-hooks.sh
(opt-in pre-commit running the suite — never installed for you).
EOF
