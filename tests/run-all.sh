#!/bin/sh
# Every test in one command. Each file prints a PASS/FAIL line per case and exits non-zero on
# failure; this runs all of them and exits non-zero if any failed, so one run shows every broken
# file rather than making you fix them one restart at a time. The `=== <file>` headers and the final
# verdict are what keep a failure from being buried in a wall of green.
cd "$(dirname "$0")/.." || exit 1
status=0
for t in tests/*.test.js; do
  printf '\n=== %s\n' "$t"
  node "$t" || status=1
done
[ "$status" -eq 0 ] && printf '\nALL SUITES PASS\n' || printf '\nSOME SUITES FAILED\n'
exit "$status"
