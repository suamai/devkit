#!/bin/sh
# Append ONE line to the run ledger — `~/.claude/devkit/runs.jsonl`, per developer, spanning repos —
# the file that accumulates what every phase already computes and used to throw away with the turn.
#
# Why a script instead of the model writing the file. The Workflow scripts have no filesystem access,
# so the ledger is written by the SKILLS from the main loop. The envelope (timestamp, plugin version,
# frozen commit, repo, repo SHA) is computed HERE precisely so that no model ever types it: a field
# this script cannot read is OMITTED, never guessed. That is the whole reason the numbers a later
# report prints can be trusted at all.
#
# Why append-only. One `printf … >>` per call — O_APPEND, no temp file, no read-modify-write. A
# read-modify-write is exactly how two concurrent sessions lose a line, and this file has many
# writers (every phase of every session) and no lock.
#
# Why a malformed body is refused rather than repaired. A corrupt line is worse than a missing one:
# the ledger has no schema version and no migration path, unknown fields are ignored, and losing the
# whole file costs nothing — so dropping one bad line is the cheap outcome, while a half-written
# object silently poisons a median. The reader counts what it cannot parse.
#
# Failure here is never fatal to a phase: on a refusal, an unset or unwritable $HOME, this prints one
# line to stderr and exits non-zero (2 = the body was refused, 1 = the environment). The skills are
# told to mention it in a sentence and carry on.
#
# Usage: ledger-append.sh        (the body — ONE line, `{…}`, valid JSON — arrives on stdin)
#
#   sh "${CLAUDE_PLUGIN_ROOT}/scripts/ledger-append.sh" <<'JSON'
#   {"phase":"plan","slug":"run-ledger","tier":"medium","open_questions":2}
#   JSON
#
# A QUOTED heredoc is the carrier: no expansion, so apostrophes, double quotes and backslashes in the
# body reach the file byte-for-byte.

# The install path, not $CLAUDE_PLUGIN_ROOT: that variable belongs to the main loop and is not
# guaranteed to be exported into this process. Same idiom as scripts/promote-plugin.sh.
root=$(cd "$(dirname "$0")/.." && pwd)

die() { printf 'ledger-append: %s\n' "$1" >&2; exit "$2"; }

body=$(cat)

# One non-empty line, opening `{` and closing `}`. Checked before anything is written, so a refused
# body leaves the ledger exactly as it was.
lines=$(printf '%s\n' "$body" | grep -c '[^[:space:]]')
if [ "$lines" -eq 0 ]; then
  die 'empty body — nothing written' 2
fi
if [ "$lines" -ne 1 ]; then
  die "body spans $lines non-empty lines, expected 1 — nothing written" 2
fi

line=$(printf '%s\n' "$body" | grep '[^[:space:]]' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
case "$line" in
  '{'*'}') ;;
  *) die 'body must be one JSON object, starting with { and ending with } — nothing written' 2 ;;
esac

# Escape what JSON reserves. Only the envelope goes through this — the body is the caller's own JSON
# and is passed through untouched.
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
add() { [ -n "$2" ] || return 0; envelope="$envelope,\"$1\":\"$(esc "$2")\""; }

envelope="\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""

# Pull a top-level string out of JSON without a parser — the same bargain, and the same sed idiom,
# hooks/session-start-stale-flows.sh documents: one writer, a flat known shape. Every read below is
# silenced so an unreadable source drops its field rather than failing the append.
add plugin_version "$(tr '\n' ' ' < "$root/.claude-plugin/plugin.json" 2>/dev/null |
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
# FROZEN_AT is written by scripts/promote-plugin.sh and exists only in a frozen install; a working
# tree has none, so this field is simply absent for runs driven from a checkout. That is the truth.
add plugin_commit "$(head -n 1 "$root/FROZEN_AT" 2>/dev/null | tr -d '[:space:]')"
top=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$top" ]; then add repo "$(basename "$top")"; fi
add repo_sha "$(git rev-parse HEAD 2>/dev/null)"

# Merge by concatenation: strip the body's outer braces and splice. `{}` is a legitimate body (the
# envelope alone is still a usable line), and it is the one case that must not produce a stray comma.
# The envelope goes LAST, not first: JSON permits duplicate keys and every reader (JSON.parse, and
# the awk parser's F[key]=... assignment) takes the last occurrence, so a body that happens to carry
# one of the five envelope names (accidentally, or copied from the docs table) cannot shadow the
# script-computed value — the envelope always wins.
inner=${line#\{}
inner=${inner%\}}
if [ -n "$(printf '%s' "$inner" | tr -d '[:space:]')" ]; then
  out="{$inner,$envelope}"
else
  out="{$envelope}"
fi

[ -n "$HOME" ] || die '$HOME is not set — nothing written' 1
dir="$HOME/.claude/devkit"
mkdir -p "$dir" 2>/dev/null || die "cannot create $dir — nothing written" 1
printf '%s\n' "$out" >> "$dir/runs.jsonl" || die "cannot append to $dir/runs.jsonl — nothing written" 1
