#!/bin/sh
# Emit the repo's path-scoped rule files as [{path, globs}] JSON, for passing to the pipeline
# workflows (which have no filesystem access and cannot read them themselves).
#
# `.claude/rules/*.md` is a NATIVE Claude Code convention, not a devkit one: those files load
# automatically alongside CLAUDE.md, and a `paths:` frontmatter key scopes a file so it loads only
# when Claude works with matching files. The contract below is therefore Claude Code's, not ours —
# this script conforms to it, it does not define it.
#
#   ---
#   description: what this checklist covers   # optional, ignored here
#   paths:                                    # optional; block list or inline [a, b]
#     - "src/db/**/*.ts"
#     - "packages/*/schema/*.ts"
#   ---
#
# No `paths:` key means the rule is unscoped: Claude Code loads it for everything, so the workflows
# hand it to every agent. That is emitted as an empty `globs` array, NOT as an absent rule.
#
# Usage: rules-manifest.sh [rules-dir]   (default .claude/rules)
dir=${1:-.claude/rules}
[ -d "$dir" ] || { printf '[]\n'; exit 0; }
set -- "$dir"/*.md
[ -e "$1" ] || { printf '[]\n'; exit 0; }

awk '
function esc(s) { gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); return s }
function add(f, g) {
  sub(/^[ \t]+/, "", g); sub(/[ \t]+$/, "", g)
  sub(/^"/, "", g); sub(/"$/, "", g)
  sub(/^'"'"'/, "", g); sub(/'"'"'$/, "", g)
  if (g == "") return
  globs[f] = globs[f] (nglob[f]++ ? "," : "") "\"" esc(g) "\""
}
FNR == 1 { fm = 0; inpaths = 0; order[++nf] = FILENAME }
/^---[ \t]*$/ { fm++; inpaths = 0; next }
fm != 1 { next }
# inline form:  paths: ["a", "b"]
/^paths:[ \t]*\[/ {
  line = $0; sub(/^paths:[ \t]*\[/, "", line); sub(/\].*$/, "", line)
  m = split(line, parts, ",")
  for (i = 1; i <= m; i++) add(FILENAME, parts[i])
  inpaths = 0; next
}
# block form:  paths:  followed by "  - glob" items
/^paths:[ \t]*$/ { inpaths = 1; next }
# any other top-level key ends the block — this is what the old "scrape every list item" awk missed
/^[^ \t#-]/ { inpaths = 0; next }
inpaths && /^[ \t]*-[ \t]*/ {
  g = $0; sub(/^[ \t]*-[ \t]*/, "", g); sub(/[ \t]+#.*$/, "", g)
  add(FILENAME, g); next
}
END {
  printf "["
  for (i = 1; i <= nf; i++) printf "%s{\"path\":\"%s\",\"globs\":[%s]}", (i > 1 ? "," : ""), esc(order[i]), globs[order[i]]
  printf "]\n"
}
' "$@"
