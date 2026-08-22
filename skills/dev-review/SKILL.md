---
name: dev-review
description: Iterative multi-agent review of code changes — two complementary reviewers, semantic clustering and batched verification, confirmed fixes applied, explicitly re-reviewed until clean.
argument-hint: [files/scope] [--no-apply] | --from-report <review.md>
---

You drive a standalone review loop over code changes using the `wf-review-loop` workflow.

## Fixing a persisted PR review — `/dev-review --from-report <review.md>`

Route here before the normal process when `--from-report` is present. A `/dev-pr --review` report is
already adversarially verified evidence bound to one exact `HEAD`; this turns its confirmed findings
into applied fixes. It is not a second review — re-finding what is already confirmed risks *missing*
one, which silently drops a defect.

1. **Validate the artifact.** Read the report's `Machine-readable findings` JSON block. Require
   `version: 1` and branch/base-branch/base-ref/merge-base/reviewed-head. Refuse a clean report, or
   one with no confirmed findings — there is nothing to fix.

2. **Prove the code has not moved.** The current branch must match the report's, `HEAD` must equal
   its `reviewed_head`, and the working tree must be clean. This is not ceremony: the findings cite
   `file:line` in the reviewed commit, so on drifted code they describe something that no longer
   exists, and the fixer would either patch the wrong thing or skip everything. Drift means a fresh
   `/dev-pr --review`, not an override. Uncommitted bytes were never reviewed either.

3. **Run the loop, seeded.**
   ```
   Workflow({ name: "devkit:wf-review-loop", args: {
     scope, intent, files, rules,
     baseline: <the report's merge-base>,
     seedFindings: <the report's confirmed array, verbatim>,
     priorRefuted: <the report's refuted array>,
     apply: true, maxRounds: 3, verifyCommand: <the repo's own check, or false>
   } })
   ```
   `seedFindings` makes round 1 skip finding and verifying and go straight to the fixer; the explicit
   post-fix re-review is unchanged, so `clean: true` still means a pass that found nothing.
   `priorRefuted` stops that re-review re-litigating what the report already dismissed. `intent`:
   what the branch was supposed to do, from the PR body or the plan. `verifyCommand` (step 3 below
   says what to pass, and when to pass `false`) matters most on this path: this is the run that edits
   code minutes before a fresh `/dev-pr --review` looks at it, so it is the worst place to learn later
   that the fixes stopped the suite.

   `maxRounds: 3` — one lower than a standalone review's limit, because a seeded run starts a round
   further along: round 1 is the seeded fix, round 2 fixes whatever that fix broke, and round 3 is the
   report-only last round that judges the result. Two rounds would delete the middle one, leaving this
   path unable to repair its own regression — which is precisely the failure a seeded fix is most
   likely to produce, since it edits code nobody has reviewed since the report was written.

4. **Report and re-gate.** Say which findings were fixed, which were skipped and why, and the
   clean/not-clean verdict. Then require a fresh `/dev-pr --review`: the old report stays as
   evidence, but only a review of the *current* `HEAD` can clear the publication gate.
   Write the ledger line here too — the same `review` line step 4 of the Process describes, plus
   `"seeded":true`. Round 1 skips finding and clustering entirely and maps every seeded finding 1:1,
   so `raw` and `clustered` are equal by construction **for that round alone**. But `maxRounds: 3`
   means real, non-seeded rounds 2 and 3 still run whenever round 1 leaves anything to check, and
   their own find+cluster can add unequal raw/clustered increments to the same cumulative totals —
   so the ledger line's overall ratio reports 1.0 only when the later rounds also find nothing new.
   When one of them does find something, a ratio above 1.0 is the honest number, not a bug to chase.

**When this is the wrong tool.** If the findings need an approach decision, span several subsystems,
or must be applied in a specific order, they are ordinary work — say so and offer
`/dev-plan "fix the findings in <report>"`, which gets exploration, a plan you approve, and waves.
There is no dedicated remediation machinery to reach for; that is deliberate.

## Process

1. **Determine scope and intent.**
   - Scope: from the arguments if given. Otherwise, in a git repo, `git diff --stat` (plus `--staged`) to enumerate changed files; outside git, ask the developer. Scope is a *description string* for reviewer agents — list the concrete files.
   - Baseline: in a git repo, pass `baseline` so reviewers judge the diff, not whole files — `git rev-parse HEAD` for uncommitted changes, or the merge-base with the default branch when reviewing a branch. Without a baseline, reviewers cannot distinguish introduced defects from pre-existing ones; say so in the report.
   - Intent: what the change was supposed to accomplish, from the conversation, the relevant plan step, or the spec's acceptance criteria. If you genuinely don't know, say so in the intent field rather than guessing.
   - If a `.dev/<slug>/` workspace exists for this change, pass `contextPaths` with the relevant `briefs/`/`notes/` files — reviewers use them as background hints.

2. **Decide apply mode.** Default `apply: true`. `--no-apply` or "just review, don't touch" → `apply: false` (single find+verify pass, report only).

3. **Run it.**
   ```
   Workflow({ name: "devkit:wf-review-loop", args: { scope, intent, files, baseline?, contextPaths?, rules?, verifyCommand?, root?, apply, maxRounds, profile?, models?, efforts? } })
   ```

   `root`: only when reviewing a flow that ran `/dev-implement <slug> --isolated`. That flow's code
   lives in a git worktree, not in the primary checkout, so a review launched without `root` reads a
   tree the run never touched and reports on it — cleanly, and about the wrong files. Take the
   absolute path from the workspace's `state.json` `worktree` field (`/dev-status` prints it beside
   the flow), and pass the same `baseline` the flow used. No `worktree` field means the flow was not
   isolated: omit `root` entirely rather than passing the primary checkout's own path, since an empty
   `root` is what makes every prompt byte-identical to a normal review.

   `rules`: the repo's rule manifest, from `sh "${CLAUDE_PLUGIN_ROOT}/scripts/rules-manifest.sh"`
   (outputs `[]` when the repo has none). Pass it **unmatched**, together with `files` — the concrete
   paths under review — and the workflow matches globs against files with the same code
   `wf-implement` uses. Do not pre-filter it yourself: eyeballing globs in the main loop is the same
   job done a second time, less reliably. Matching rules **append** a third `repo-conventions` lens
   grounded in this repo's own checklists instead of generic judgement, at one extra agent per round —
   worth it for domain code (data layer, auth, error surfaces). It is appended to whatever `lenses`
   resolves to, so a custom focus does not silently drop it; `ruleLens: false` drops it deliberately,
   and `rules: []` opts out by giving it nothing to match — the right call for a purely mechanical
   change.

   `verifyCommand`: the repo's own executable check — in this repository, `sh tests/run-all.sh`. After
   a round applies fixes, one agent runs it and reports what happened, and the loop classifies that
   claim exactly as `/dev-implement` classifies an implementer's, so `clean: true` then requires either
   a substantiated pass or an honest statement that the check never ran. Pass what the repo itself
   documents (`CLAUDE.md`, the README, the runner it ships) — do not invent one, and do not assemble a
   plausible-looking command out of `package.json`. `verifyCommand: false` opts out: the right answer
   for a suite too expensive to run once per round, and for a repo whose suite is already red, where
   every round would otherwise report a failure the fixes did not cause — the same call when the
   developer says something like "skip the suite" or "don't run it each round." Omitting it is the same
   opt-out said less explicitly — honest rather than silent, because the result then says no check ran
   and why.
   `maxRounds` default 4. Custom `lenses` when the developer asks for a specific focus (e.g. security-only) — they replace the two general lenses, never the appended `repo-conventions` one. If the workflow name does not resolve (the plugin has not loaded in this session yet), invoke with `scriptPath` pointing at `${CLAUDE_PLUGIN_ROOT}/workflows/wf-review-loop.js`.

   Round 1 is the wide two-lens sweep; rounds 2+ are one targeted agent that only asks whether the
   fixes held and whether they broke anything. So a higher `maxRounds` is much cheaper than it looks —
   the wide net is paid once.

4. **Report.** Lead with the outcome: clean or not, in how many rounds. Then canonical confirmed findings (including merged reviewer titles), fixes applied, fixes skipped and why, and whether the loop ended `clean: true` (an explicit post-fix pass found nothing) or stopped for one of the other reasons `rounds_end` gives.

   A run invoked with `apply: false` that ends with confirmed findings always reports
   `rounds_end: 'blocked'` — that is the expected outcome of a report-only pass, not a stuck fix. Say
   so plainly rather than leaving the reader to infer it: `blocked` carries the same word whether the
   caller asked for a report only or a fix genuinely could not land, and only the report can tell
   those apart.

   Reaching the round limit no longer means an unreviewed fix. The last permitted round is
   report-only — it finds, verifies and reports, and hands nothing to a fixer — so a `max-rounds` exit
   is a tree that *was* reviewed after its last edit, with findings deliberately left unfixed. Name
   them; they are the deliverable of that round. A rerun with a higher `maxRounds` is how they get
   fixed, and saying so is more honest than "one more round would have finished it", which the loop
   has no evidence for.

   Report `fix_verify` in one line as well: whether a check ran, which command it ran, and whether it
   passed — or, when it did not run, the reason the result gives. No `fix_verify` at all means no round
   ever applied a fix, so there was nothing to check; that is not a check that passed, and saying which
   one it was costs one clause. If `fix_verify.repaired` is set **or `repairs` is non-empty** — the field
   reflects only the last round, so a run that broke its check in round 1 and applied further fixes in
   round 2 carries the evidence in `repairs` alone — the round's own fixes broke the check
   and the loop spent one bounded repair attempt on it, whose changes joined what the next re-review
   reads — read `passed` for whether the attempt reached green, and `repairs` for what it touched. Say so
   at report time: a `clean: true` reached that way is still a run that broke the tree once, and the
   developer should not have to find that in the diff.

   Five more fields change what the report has to say, and none of them is a detail:

   - `scope_source` says where the last fix round's re-review scope came from: `diff` when the check
     agent actually read the tree with `git status`, `self-report` when no check ran there and the
     scope degraded to the fixer's own `changed_files` plus the confirmed findings' files. Call out
     `self-report` explicitly — that is the degraded case the field exists to flag, closely related to
     `undeclared_files` below (which is only ever populated when the source is `diff`).
   - `oscillating: true` means the loop stopped **itself**: one defect was reported fixed in two
     separate rounds and came back anyway, or one file was rewritten by three separate fix rounds.
     That is not a budget running out, and another round is not the answer to it — say what kept
     coming back, and offer `/dev-plan "fix the findings in <scope>"`, a decision about the design
     rather than one more attempt at the same edit. Re-running the loop unchanged is the one response
     this verdict exists to rule out.
   - `unreviewed_fixes: true` means the loop exited with fixes at `HEAD` that no later round looked
     at. The round budget can no longer cause this; a post-fix check that stayed red and a fix the
     fixer skipped still can. Say it in one line — the developer should not have to find unjudged
     edits in the diff.
   - `undeclared_files` are paths the post-fix `git status` reported changed that nothing in the run
     had declared — the fixer edited them and did not say so. Any round that followed read them
     first, under a heading saying exactly that, so they are not by themselves unreviewed; list them
     anyway, because they are the honest measure of how far a fix actually reached.
   - `fix_self_check` is the fixer's **own** run of the check, classified exactly as `fix_verify` is
     and gating nothing (`clean` rests on the independent check alone). Report it when it disagrees
     with `fix_verify`: a fixer claiming green over a check that came back red is worth naming out
     loud, and averaging the two would hide precisely that.

   `regressions_introduced` and `unresolved_after_fix` count confirmed findings by their
   `origin: introduced-by-fix | unresolved | pre-existing` — an attribution only a round 2-or-later
   re-review can make, since there have to be fixes to attribute anything to. A run that never
   re-reviewed therefore reports 0 because it had no basis for the label, not because nothing broke;
   when the numbers matter, say which of the two it was.

   Then append one `review` line to the ledger — once per invocation, after the report:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/ledger-append.sh" <<'JSON'
{"phase":"review","rounds":2,"fix_rounds":1,"clean":true,"rounds_end":"clean","concurrent":"unknown","findings":{"raw_titles":11,"clusters":7,"confirmed":4,"refuted":3,"applied":4,"skipped":0,"regressions_introduced":0},"cost":{"by_phase":{"review":90000,"verify":30000,"fix":40000,"check":12000},"total":172000,"budget_total":null,"floors_active":false}}
JSON
```

   Both the command and the closing `JSON` start at column 0 on purpose: an indented terminator does
   not close a quoted heredoc, and the script then sees a two-line body and refuses it.

   All of it comes off the loop's own return — the envelope is the script's half, and the shared
   vocabulary lives in `docs/architecture.md` → "The run ledger". `rounds` and `clean` go in verbatim,
   and so does `rounds_end`: the loop computes why it stopped and returns it, one of
   `rounds_end: clean | oscillating | max-rounds | blocked | budget`, so write it as given rather than
   re-deriving it — the script applies the precedence (budget outranks the round limit, because a
   budget exit landing on the last round would otherwise be filed as convergence that never happened),
   and one answer computed in one place is what makes the vocabulary checkable at all.
   `fix_rounds` goes in verbatim too: the rounds that actually spawned a fixer, which is the
   denominator a regression rate needs and something `rounds` — report-only and clean rounds
   included — cannot be. In `findings`, `raw_titles` is the return's `raw` and `clusters` its
   `clustered` — the loop's own scalars — `regressions_introduced` is the return's scalar of that
   name, and `confirmed`/`refuted`/`applied`/`skipped` are those arrays' lengths. Never reconstruct
   `raw_titles` or `clusters` from `merged_titles`, which omits every raw finding the verifier
   dropped without clustering. `cost` goes in **verbatim**; add `profile` only when the
   developer overrode it. `concurrent` is `"unknown"` unless you actually checked (TaskList showed no
   other workflow running) — never a guessed `false`.

   Add `slug`, and a compact entry in `.dev/<slug>/state.json`'s `runs` array
   (`{ phase: "review", ts, rounds, confirmed, applied, cost_total, floors_active }` — `ts` is plain
   `YYYY-MM-DD HH:MM`, matching `updated` — appended, never
   rewriting an earlier one), **only** when a `.dev/<slug>/` workspace already exists for this change —
   a standalone review usually has none, and inventing one is not this skill's job.

   The ledger is telemetry for a later report, never a gate: a failed append is one sentence in the
   report, never a failed review, and the file is never read back.

## Notes

- One verifier clusters and checks all findings against evidence, reachability and prior handling. Critical findings alone receive a second independent opinion.
- Skipped fixes and budget exits always leave `clean: false`; findings are never suppressed between
  rounds. A post-fix check that failed does the same, and so does one that claimed to have run without
  naming its command or its result — an unsubstantiated claim is worth what no check is worth, minus
  the honesty.
- The result carries `cost`: `by_phase` (review / verify / fix / check) and `total`. Report it — a review
  loop is the pipeline's most repeatable spend, so its per-phase split is the most useful number the
  developer gets. `floors_active: false` means the budget guards were inert (no target in the
  developer's message); mention it rather than implying the run was bounded.
- Findings that fail verification do not trigger fixes; they remain available in the result's `refuted` list and workflow journal for audit.
- For a branch-wide, persistent, report-only review that gates PR publication, use `/dev-pr --review`;
  its report is fixed by `--from-report` above. Standalone `/dev-review` remains the direct
  review-and-optionally-fix entry point.
