---
description: how this suite tests workflow scripts that cannot be imported
paths:
  - "tests/*.js"
---

Node, no dependencies, no framework. Workflow scripts are self-contained by runtime requirement, so
there is nothing to `require()`: read the file, swap `export const meta` for `const meta`, wrap the
whole thing in `new Function(...)` (the body is a function body, top-level `return` and all) and call
it with stubs. Rationale: `docs/architecture.md` → "Testing".

- Stub `agent`/`parallel`/`workflow` to **throw** and pass `dryRun: true` to test scheduling; stub
  them to reply *by agent label* to test control flow. An unexpected label then becomes a test
  failure instead of a surprise bill.
- Never rearrange a script to accommodate a test.
- Prefer widening the `dryRun` projection over extracting a block by anchor — `dryRun` runs the real
  entry point, an anchor only runs a copy of it. Where an anchor is unavoidable, fail closed if it
  moves; a silent pass is worse than no test.
- Assert against values **extracted from the source**, never restated in the test: a constant copied
  into a test drifts exactly like prose does.
- Do not grep for canonical sentences. A check that passes because a file still contains the word
  while the sentence around it now says the opposite is a check that teaches people to ignore the
  suite.
- Every case prints a `PASS`/`FAIL` line and the file exits non-zero on failure, so
  `sh tests/run-all.sh` stops at the first failing file.
- Verify a new drift-style check by **mutation**: change the thing it guards and watch it fail. A
  test like this can silently stop testing.
