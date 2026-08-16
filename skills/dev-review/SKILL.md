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
     apply: true, maxRounds: 2
   } })
   ```
   `seedFindings` makes round 1 skip finding and verifying and go straight to the fixer; the explicit
   post-fix re-review is unchanged, so `clean: true` still means a pass that found nothing.
   `priorRefuted` stops that re-review re-litigating what the report already dismissed. `intent`:
   what the branch was supposed to do, from the PR body or the plan.

4. **Report and re-gate.** Say which findings were fixed, which were skipped and why, and the
   clean/not-clean verdict. Then require a fresh `/dev-pr --review`: the old report stays as
   evidence, but only a review of the *current* `HEAD` can clear the publication gate.

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
   Workflow({ name: "devkit:wf-review-loop", args: { scope, intent, files, baseline?, contextPaths?, rules?, apply, maxRounds, profile?, models?, efforts? } })
   ```

   `rules`: the repo's rule manifest, from `sh "${CLAUDE_PLUGIN_ROOT}/scripts/rules-manifest.sh"`
   (outputs `[]` when the repo has none). Pass it **unmatched**, together with `files` — the concrete
   paths under review — and the workflow matches globs against files with the same code
   `wf-implement` uses. Do not pre-filter it yourself: eyeballing globs in the main loop is the same
   job done a second time, less reliably. Matching rules add a third `repo-conventions` lens grounded
   in this repo's own checklists instead of generic judgement, at one extra agent per round — worth
   it for domain code (data layer, auth, error surfaces), skip it (`rules: []`) for a purely
   mechanical change.
   `maxRounds` default 3. Custom `lenses` when the developer asks for a specific focus (e.g. security-only). If the workflow name does not resolve (the plugin has not loaded in this session yet), invoke with `scriptPath` pointing at `${CLAUDE_PLUGIN_ROOT}/workflows/wf-review-loop.js`.

   Round 1 is the wide two-lens sweep; rounds 2+ are one targeted agent that only asks whether the
   fixes held and whether they broke anything. So a higher `maxRounds` is much cheaper than it looks —
   the wide net is paid once.

4. **Report.** Lead with the outcome: clean or not, in how many rounds. Then canonical confirmed findings (including merged reviewer titles), fixes applied, fixes skipped and why, and whether the loop ended `clean: true` (an explicit post-fix pass found nothing) or hit `maxRounds` (fixes applied but final state not re-verified; offer one more round).

## Notes

- One verifier clusters and checks all findings against evidence, reachability and prior handling. Critical findings alone receive a second independent opinion.
- Skipped fixes and budget exits always leave `clean: false`; findings are never suppressed between rounds.
- The result carries `cost`: `by_phase` (review / verify / fix) and `total`. Report it — a review
  loop is the pipeline's most repeatable spend, so its per-phase split is the most useful number the
  developer gets. `floors_active: false` means the budget guards were inert (no target in the
  developer's message); mention it rather than implying the run was bounded.
- Findings that fail verification do not trigger fixes; they remain available in the result's `refuted` list and workflow journal for audit.
- For a branch-wide, persistent, report-only review that gates PR publication, use `/dev-pr --review`;
  its report is fixed by `--from-report` above. Standalone `/dev-review` remains the direct
  review-and-optionally-fix entry point.
