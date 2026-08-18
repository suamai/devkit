#!/bin/sh
# Create and remove the dedicated git worktree that ONE `/dev-implement <slug> --isolated` flow runs
# inside — the whole lifecycle in one committed file, so that every caller says the same thing.
#
# Why a script and not inline prose in a SKILL.md. Three reasons, each load-bearing:
#   1. The ledger's `worktree_setup_ms` and `worktree_disk_kb` must be MEASURED. A number a prompt
#      asks a model to estimate is a number no later calibration report can trust.
#   2. `/dev-implement` and `/dev-status` (clean, archive) must offer ONE cleanup command, byte for
#      byte, so the developer reads the same string wherever it is printed.
#   3. It gives the suite something to EXECUTE. `tests/worktree.test.js` drives this file against
#      real git in a throwaway repo, which is the only automated evidence that the lifecycle leaves
#      the developer's primary checkout byte-for-byte untouched. A prompt cannot be tested that way.
#
# What it never does: delete a branch. `remove` takes the worktree away and leaves the branch behind,
# because the branch is where the work is — a cleanup command that can destroy unmerged commits is a
# cleanup command nobody can safely offer. Deleting the branch afterwards is a separate decision, and
# the caller (which knows what is on it) is the one that offers the command for it. That is also why
# this file names no branch-deleting command anywhere: `remove` reports `branch_kept` and stops.
#
# Usage — run from the PRIMARY checkout:
#
#   sh "${CLAUDE_PLUGIN_ROOT}/scripts/worktree.sh" setup  <slug> <baseline-sha> [branch]
#   sh "${CLAUDE_PLUGIN_ROOT}/scripts/worktree.sh" remove <slug> [--force]
#
# Both print exactly ONE line of JSON on stdout and nothing else, so a caller can splice it straight
# into `state.json` or a ledger body. Every informational byte git writes goes to stderr instead —
# `git worktree add` prints "HEAD is now at …" on stdout, which would otherwise corrupt the line.
#
#   setup  -> {"path":"…","branch":"…","baseline":"…","setup_ms":123,"disk_kb":4096}
#   remove -> {"path":"…","branch":"…","removed":true,"branch_kept":"…"}
#
# `baseline` in the setup line is the RESOLVED full commit sha, so `git -C <path> rev-parse HEAD`
# equals it verbatim and `git diff <baseline>` means the same thing to every reviewer downstream.
#
# Exit codes, distinct on purpose so a caller can branch on them:
#   0  done
#   1  environment — this is not a git repository with a working tree; the request was never examined
#   2  refused — a precondition failed and NOTHING was created or deleted
#   3  git itself refused the create/remove; git's own message is on stderr immediately above ours

die() { printf 'worktree: %s\n' "$1" >&2; exit "$2"; }

# Escape what JSON reserves, the same way scripts/ledger-append.sh does. Paths and branch names are
# the two values a developer's filesystem can put a quote or a backslash into.
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# A millisecond clock that degrades honestly. BSD/macOS `date` has no %N and prints the literal
# "…N", so the fallback measures whole seconds — `worktree_setup_ms` stays a wall-clock millisecond
# count either way, just coarser, and never a guess.
now_ms() {
  n=$(date +%s%N 2>/dev/null)
  case "$n" in
    ''|*N*) echo $(( $(date +%s) * 1000 )) ;;
    *) echo $(( n / 1000000 )) ;;
  esac
}

cmd=$1
case "$cmd" in
  setup|remove) ;;
  '') die 'usage: worktree.sh setup <slug> <baseline-sha> [branch] | worktree.sh remove <slug> [--force]' 2 ;;
  *) die "unknown subcommand \"$cmd\" — expected setup or remove" 2 ;;
esac

slug=$2
case "$slug" in
  '') die "$cmd: missing <slug>" 2 ;;
  # The slug becomes a path segment under .dev/. Anything with a slash, or a leading dot or dash,
  # either escapes the workspace or turns into an option — refuse rather than normalize.
  *[!A-Za-z0-9._-]*) die "slug \"$slug\" must match [A-Za-z0-9._-]+ — nothing done" 2 ;;
  .*|-*) die "slug \"$slug\" must not start with a dot or a dash — nothing done" 2 ;;
esac

# ---- Environment guards. Both subcommands, before anything is written.

# One call answers both questions. In the primary checkout the two absolute paths are equal; inside a
# linked worktree --git-dir is <primary>/.git/worktrees/<name> while --git-common-dir stays
# <primary>/.git. Outside a repository the command fails outright.
dirs=$(git rev-parse --path-format=absolute --git-dir --git-common-dir 2>/dev/null) ||
  die 'not inside a git repository — nothing done' 1
gitdir=$(printf '%s\n' "$dirs" | sed -n 1p)
commondir=$(printf '%s\n' "$dirs" | sed -n 2p)
[ -n "$gitdir" ] && [ -n "$commondir" ] || die 'cannot locate the git directory — nothing done' 1
if [ "$gitdir" != "$commondir" ]; then
  die "cwd is inside a linked worktree ($gitdir) — run this from the primary checkout that owns $commondir; nothing done" 2
fi

root=$(git rev-parse --show-toplevel 2>/dev/null)
[ -n "$root" ] || die 'no working tree here (a bare repository?) — nothing done' 1

# The one path both subcommands agree on. Nested under the flow's own workspace, which is gitignored
# (`.dev/*`), so the primary checkout's `git status` never sees it.
path="$root/.dev/$slug/worktree"

case "$cmd" in

setup)
  baseline=$3
  # FLAT by default, with no `dev/` prefix. `dev/<slug>` was the original design and it is a trap:
  # git stores a branch as a file under refs/heads/, so a repository holding a branch named `dev`
  # can never create anything under refs/heads/dev/ — and a `main` + `dev` pair is an ordinary
  # convention, not an exotic one. A default that fails on a common layout is a default that makes
  # every run in those repositories pass an explicit [branch]. The `-iso` suffix keeps it obvious
  # which branches an isolated flow created, and keeps it clear of the `dev/<slug>` names the
  # non-isolated path still uses in the primary checkout, so the two can coexist for one slug.
  branch=${4:-$slug-iso}
  [ -n "$baseline" ] || die 'setup: missing <baseline-sha> — usage: setup <slug> <baseline-sha> [branch]' 2
  [ "$#" -le 4 ] || die 'setup: too many arguments — usage: setup <slug> <baseline-sha> [branch]' 2

  # The baseline is what every downstream `git diff <baseline>` is anchored on, so resolve it here
  # and hand the caller the full sha rather than whatever shorthand was typed.
  resolved=$(git rev-parse --verify --quiet "$baseline^{commit}") ||
    die "baseline \"$baseline\" does not resolve to a commit in this repository — nothing created" 2
  [ -n "$resolved" ] ||
    die "baseline \"$baseline\" does not resolve to a commit in this repository — nothing created" 2

  git check-ref-format "refs/heads/$branch" 2>/dev/null ||
    die "\"$branch\" is not a valid git branch name — nothing created" 2

  if git show-ref --verify --quiet "refs/heads/$branch"; then
    die "branch \"$branch\" already exists — pass an explicit [branch] argument (for example \"$branch-iso\"); nothing created" 2
  fi

  # Refs are stored as files, so a branch name with a `/` cannot coexist with a branch at any of its
  # prefixes. Reproduced in this very repository, whose default branch is literally named `dev`:
  #   fatal: cannot lock ref 'refs/heads/dev/x': 'refs/heads/dev' exists; cannot create ...
  # `git check-ref-format` does NOT catch this — the name is well-formed, it is the repository that
  # cannot hold it — and it is a DIFFERENT failure from "branch already exists" above. Probe the real
  # refs and name the conflict. The default is flat now, so this fires for a CALLER-SUPPLIED branch
  # (`/dev-implement` offers a prefixed one when the flat default is taken) rather than for the
  # default itself. NOTE the suggested escape: appending `-iso` to a prefixed name would collide on
  # the very same prefix, so what is offered is a FLAT name with no prefix at all.
  prefix=''
  rest=$branch
  while :; do
    case "$rest" in
      */*) seg=${rest%%/*}; rest=${rest#*/} ;;
      *) break ;;
    esac
    prefix="${prefix:+$prefix/}$seg"
    if git show-ref --verify --quiet "refs/heads/$prefix"; then
      die "cannot create branch \"$branch\": branch \"$prefix\" already exists, and git cannot hold both a ref and a ref directory at refs/heads/$prefix — pass an explicit [branch] argument with no \"$prefix/\" prefix (for example \"$slug-iso\"); nothing created" 2
    fi
  done

  # The mirror image: any ref under refs/heads/<branch>/ makes that path a directory, so the branch
  # itself cannot be created either.
  under=$(git for-each-ref --count=1 --format='%(refname:short)' "refs/heads/$branch/" 2>/dev/null)
  [ -z "$under" ] ||
    die "cannot create branch \"$branch\": branch \"$under\" already exists, so refs/heads/$branch is a ref directory — pass a different explicit [branch] argument (for example \"$slug-iso\"); nothing created" 2

  [ ! -e "$path" ] ||
    die "\"$path\" already exists — remove it first (worktree.sh remove $slug), or use a different slug; nothing created" 2

  mkdir -p "$root/.dev/$slug" || die "cannot create $root/.dev/$slug — nothing created" 1

  # The measurement brackets exactly the git call and nothing else, so `worktree_setup_ms` is the
  # cost of the isolation and not the cost of this script's guards.
  start=$(now_ms)
  git worktree add "$path" -b "$branch" "$resolved" >&2 ||
    die "git worktree add refused — see git's message above; nothing was created that \`git worktree prune\` will not clear" 3
  end=$(now_ms)
  setup_ms=$((end - start))
  [ "$setup_ms" -ge 0 ] || setup_ms=0

  disk_kb=$(du -sk "$path" 2>/dev/null | cut -f1 | tr -d '[:space:]')
  case "$disk_kb" in
    ''|*[!0-9]*) disk_kb=0 ;;
  esac

  printf '{"path":"%s","branch":"%s","baseline":"%s","setup_ms":%s,"disk_kb":%s}\n' \
    "$(esc "$path")" "$(esc "$branch")" "$(esc "$resolved")" "$setup_ms" "$disk_kb"
  ;;

remove)
  shift 2
  force=''
  for a in "$@"; do
    case "$a" in
      --force) force='--force' ;;
      *) die "remove: unknown option \"$a\" — usage: remove <slug> [--force]" 2 ;;
    esac
  done

  # "Already gone" is not silently "removed": a caller that deletes a directory it never had is a
  # caller working from a wrong slug, and it should hear about it.
  registered=$(git worktree list --porcelain |
    awk -v p="$path" '$1=="worktree" && substr($0,10)==p { print "yes"; exit }')
  [ -n "$registered" ] || die "no worktree is registered at \"$path\" — nothing removed" 2

  # Report the branch git actually has checked out there, never the `<slug>-iso` default: a run whose
  # default collided was created with an explicit [branch], and naming the wrong one would point the
  # developer's follow-up deletion at somebody else's branch.
  branch=$(git worktree list --porcelain | awk -v p="$path" '
    $1=="worktree" { cur = (substr($0,10)==p) }
    cur && $1=="branch" { print substr($0,8); exit }')
  branch=${branch#refs/heads/}

  # A registered worktree whose directory a developer already deleted by hand is `prunable`, not
  # removable — `git worktree remove` refuses it. Prune is what clears that state, and it is the
  # second half of the normal path anyway.
  if [ -d "$path" ]; then
    # $force is deliberately unquoted: it is one whole flag or nothing at all.
    # shellcheck disable=SC2086
    git worktree remove $force "$path" >&2 ||
      die "git worktree remove refused \"$path\" — see git's message above; nothing removed (pass --force to discard uncommitted work in the worktree)" 3
  fi
  git worktree prune >&2 || die "git worktree prune failed — see git's message above" 3

  printf '{"path":"%s","branch":"%s","removed":true,"branch_kept":"%s"}\n' \
    "$(esc "$path")" "$(esc "$branch")" "$(esc "$branch")"
  ;;

esac
