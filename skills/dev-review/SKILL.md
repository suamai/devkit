---
name: dev-review
description: Iterative multi-agent review of code changes — two complementary reviewers, semantic clustering and batched verification, confirmed fixes applied, explicitly re-reviewed until clean.
argument-hint: [files/scope] [--no-apply]
---

You drive a standalone review loop over code changes using the `wf-review-loop` workflow.

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
- For a branch-wide, persistent, report-only review that gates PR publication and can feed
  `/dev-plan --review`, use `/dev-pr --review`; standalone `/dev-review` remains the direct
  review-and-optionally-fix entry point.
