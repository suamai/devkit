---
name: dev-pr
description: Prepare, optionally review, and publish a pull request from the current branch — branch-to-base analysis, .dev plan/spec context, persistent review evidence, PR description, and guarded gh publication.
argument-hint: "[base] [--review] [--draft] [--body-only]"
---

You prepare a pull request from the current branch. Analysis and review are read-only; pushing,
creating, or editing a PR always requires an explicit developer confirmation after the preview.

## 1. Preflight and base

1. Require a git repository and a non-default current branch.
2. Resolve the base in this order: explicit argument; an existing PR's base (`gh pr view`);
   `refs/remotes/origin/HEAD`; remote default branch from `gh repo view`. Never guess `main`.
   Keep two values distinct: the GitHub branch name (for example `dev`) and the local comparison
   ref (normally `origin/dev`).
3. Offer to fetch the base branch before analysis. Record the exact merge-base and `HEAD` SHA; all
   claims and review findings refer to `comparison-ref...HEAD`, not branch tips independently.
4. Inspect status, upstream, ahead/behind counts, commits, name-status, stat, and diff. A dirty tree
   may produce `--body-only` artifacts, but blocks push/PR publication because it is not represented
   by `HEAD`. Say exactly which changes are excluded.
5. Detect an existing PR for the branch. Existing PR → preview an edit, never create a duplicate.

## 2. Find task context

Match a `.dev/<slug>/` workspace by evidence, not recency alone: its state baseline must be an
ancestor of `HEAD`, recorded commits should be contained in the branch, and its plan paths should
overlap the diff. If evidence conflicts or multiple workspaces match, ask.

Read `spec.md` and `plan.md` when present. Read only relevant `notes/` selected by
step ids, recorded commits, or changed-file overlap. Treat `findings/` and `briefs/` as historical
hints. Build an internal coverage map: requirement/plan step → diff or commit evidence → executed
verification → deviation/follow-up. Never claim completion from the plan alone.

Without a matched task workspace, create `.dev/pr/<sanitized-branch>/` for PR artifacts. Create
`reviews/` as needed. Do not add `.dev` files to git.

## 3. Optional report-only review (`--review`)

Run `review-loop` with:

```
Workflow({ name: "devkit:review-loop", args: {
  scope, intent, baseline: mergeBase, contextPaths,
  apply: false, maxRounds: 1,
  lenses: [
    { key: "runtime-contracts", focus: "logic/error-path bugs, broken invariants, callers/callees, registrations, migrations and regressions" },
    { key: "plan-pr-integrity", focus: "spec/plan coverage, tests, deviations, scope creep, generated artifacts, docs and deploy/config omissions" }
  ]
} })
```

If the workflow name does not resolve, use `${CLAUDE_PLUGIN_ROOT}/workflows/review-loop.js` as `scriptPath`.
This review never applies fixes. Save its evidence to `<workspace>/reviews/<head-short-sha>.md` with
the exact format below. Refuted findings stay for audit but are never remediation input.

````markdown
# PR review: <branch> → <base>

- Merge base: `<sha>`
- Reviewed HEAD: `<sha>`
- Outcome: `clean | needs-attention | blocked`

## Confirmed findings
...

## Refuted findings
...

## Machine-readable findings

```json
{
  "version": 1,
  "branch": "...",
  "base_branch": "dev",
  "base_ref": "origin/dev",
  "merge_base": "...",
  "reviewed_head": "...",
  "clean": false,
  "confirmed": [],
  "refuted": []
}
```
````

Preserve each canonical finding's `id`, `severity`, `title`, `merged_titles`, `file`, `line`,
`description`, `reasoning`, and `suggested_fix`. Outcome is `blocked` when any confirmed finding is
high/critical, `needs-attention` for low/medium only, otherwise `clean`.

- High/critical: block PR publication and offer `/dev-plan --review <report-path>`.
- Low/medium: require one explicit risk acknowledgement in addition to publication confirmation.
- Clean: continue to the PR preview.

Only a review whose `reviewed_head` equals current `HEAD` can gate publication. After remediation,
run `/dev-pr --review` again over the whole branch.

## 4. Draft the PR

Write `<workspace>/pr.md` and propose a concise conventional title. The body has only useful
sections:

```markdown
## Summary
## What changed
## Validation
## Deviations and known limitations
## Follow-ups
```

Omit empty sections. Synthesize behavior and motivation; do not dump commits or one bullet per
file. Validation lists commands actually observed in notes/current checks, never checks merely
planned. Keep secrets, local paths, agent internals, `.dev` paths, and workflow failures out of the
public body unless they are product-relevant limitations.

Show title, body, base/head, draft status, review gate, and whether a push is needed. `--body-only`
stops here and is also the fallback when `gh` is unavailable or unauthenticated.

## 5. Publish only after confirmation

Ask one explicit confirmation covering the exact external actions. If needed, push with
`git push -u origin HEAD`, then:

- no existing PR: `gh pr create --base <base-branch> --head <branch> --title <title> --body-file <pr.md>`
  plus `--draft` when requested;
- existing PR: `gh pr edit <number-or-url> --title <title> --body-file <pr.md>`; do not silently
  change draft/ready state.

Report the PR URL. Never commit, stage, push, create, edit, close, or mark ready without the
developer's explicit approval.
