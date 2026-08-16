#!/bin/sh
# Every test in one command. Each file prints a PASS/FAIL line per case and exits non-zero on
# failure; this stops at the first failing file rather than burying it in a wall of green.
cd "$(dirname "$0")/.." || exit 1
status=0
for t in tests/*.test.js; do
  printf '\n=== %s\n' "$t"
  node "$t" || status=1
done
[ "$status" -eq 0 ] && printf '\nALL SUITES PASS\n' || printf '\nSOME SUITES FAILED\n'
exit "$status"
