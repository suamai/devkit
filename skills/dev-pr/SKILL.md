---
name: dev-pr
description: Prepare, optionally review, and publish a change from the current branch — branch-to-base analysis, .dev plan/spec context, persistent review evidence, and a change description; publication via gh when the remote is GitHub, otherwise the artifacts without it.
argument-hint: "[base] [--review] [--draft] [--body-only]"
---

You prepare a pull request from the current branch. Analysis and review are read-only; pushing,
creating, or editing a PR always requires an explicit developer confirmation after the preview.

**This skill is two things, and only the second needs GitHub.** Sections 1-4 — base resolution,
branch-to-base analysis, the coverage map, the optional SHA-bound review, the body draft — are plain
git and work in any repository, including one with no remote at all. Section 5 is publication via
`gh`, and it is the only GitHub-specific part.

So detect, then say what you detected; never assume. Read the remote once at the start
(`git remote -v`, and `gh auth status` only if a GitHub remote exists) and pick a lane:

| What you found | What to do |
|---|---|
| GitHub remote + `gh` authenticated | Everything, including section 5. |
| GitHub remote, `gh` missing or unauthenticated | Sections 1-4, then stop with the `pr.md` path and the exact `gh` command they could run. Say which of the two it was — installing and authenticating are different fixes. |
| Non-GitHub remote (GitLab, Gitea, Bitbucket, a bare URL) | Sections 1-4, resolving the base from `refs/remotes/origin/HEAD` and the local ref only. Hand over `pr.md` to paste into their forge. Do not invent a CLI for it. |
| No remote at all | Sections 1-4 against the local base branch. The "PR" is a merge they will do themselves, so the deliverable is the review evidence and the change description — still worth producing, and say so rather than treating it as a degraded run. |

Announce the lane in one line before doing the work, so nobody waits for a publication step that was
never going to happen. `--body-only` forces the sections-1-4 lane regardless of what you detected.

## 1. Preflight and base

1. Require a git repository and a non-default current branch.
2. Resolve the base in this order, skipping the `gh` steps outside the GitHub lane: explicit
   argument; an existing PR's base (`gh pr view`); `refs/remotes/origin/HEAD`; remote default branch
   from `gh repo view`; with no remote, the local default branch. Never guess `main` — if none of
   these resolves, ask.
   Keep two values distinct: the GitHub branch name (for example `dev`) and the local comparison
   ref (normally `origin/dev`).
3. Offer to fetch the base branch before analysis. Record the exact merge-base and `HEAD` SHA; all
   claims and review findings refer to `comparison-ref...HEAD`, not branch tips independently.
4. Inspect status, upstream, ahead/behind counts, commits, name-status, stat, and diff. Keep the
   name-status paths — that list **is** the `files` argument the review in section 3 passes, and the
   repo-conventions lens cannot match a rule without concrete paths. A dirty tree
   may produce `--body-only` artifacts, but blocks push/PR publication because it is not represented
   by `HEAD`. Say exactly which changes are excluded.
5. In the GitHub lane, detect an existing PR for the branch: existing PR → preview an edit, never
   create a duplicate.

## 2. Find task context

Match a `.dev/<slug>/` workspace by evidence, not recency alone: the baseline in its
`state.json` must be an
ancestor of `HEAD`, recorded commits should be contained in the branch, and its plan paths should
overlap the diff. If evidence conflicts or multiple workspaces match, ask.

Read `spec.md` and `plan.md` when present. Read only relevant `notes/` selected by
step ids, recorded commits, or changed-file overlap. Treat `findings/` and `briefs/` as historical
hints. Build an internal coverage map: requirement/plan step → diff or commit evidence → executed
verification → deviation/follow-up. Never claim completion from the plan alone.

Without a matched task workspace, create `.dev/pr/<sanitized-branch>/` for PR artifacts. Create
`reviews/` as needed. Do not add `.dev` files to git.

## 3. Optional report-only review (`--review`)

Run `wf-review-loop` with:

```
Workflow({ name: "devkit:wf-review-loop", args: {
  scope, intent, baseline: mergeBase, contextPaths, rules, files,
  apply: false, maxRounds: 1,
  lenses: [
    { key: "runtime-contracts", focus: "logic/error-path bugs, broken invariants, callers/callees, registrations, migrations and regressions" },
    { key: "plan-pr-integrity", focus: "spec/plan coverage, tests, deviations, scope creep, generated artifacts, docs and deploy/config omissions" }
  ]
} })
```

`rules` is the repo's rule manifest, from `sh "${CLAUDE_PLUGIN_ROOT}/scripts/rules-manifest.sh"`
(it outputs `[]` when the repo has none), passed **unmatched** — the workflow matches the globs
itself, with the same code `/dev-implement` uses. `files` is the changed-file list from the section-1
git map: `scope` is prose for the reviewers, and rule matching needs the concrete paths. Matching
rules **append** a third `repo-conventions` reviewer to the two lenses above rather than replacing
them, so the last gate before publication also reads the change against the repo's own checklists —
one extra agent, and only when a rule actually matches the diff. `ruleLens: false` (or `rules: []`)
opts out.

**No `verifyCommand` belongs here.** `apply: false` means nothing was fixed, so there is nothing to
check, and a read-only gate that runs a suite is no longer read-only. This review stays side-effect
free by construction.

If the workflow name does not resolve, use `${CLAUDE_PLUGIN_ROOT}/workflows/wf-review-loop.js` as `scriptPath`.
This review never applies fixes. Save its evidence to `<workspace>/reviews/<head-short-sha>.md` with
the exact format below. Refuted findings stay for audit but never become fix input.

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

- High/critical: block PR publication and offer `/dev-review --from-report <report-path>`, which
  feeds the confirmed findings straight to the fixer without re-finding them. If the findings need
  an approach decision or span several subsystems, offer `/dev-plan "fix the findings in <report>"`
  as ordinary work instead.
- Low/medium: require one explicit risk acknowledgement in addition to publication confirmation.
- Clean: continue to the PR preview.

Only a review whose `reviewed_head` equals current `HEAD` can gate publication. After the fixes land,
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

**Language.** `pr.md` is the one artifact here that becomes public, so it is the one where following
the conversation's language is most likely wrong. If `CLAUDE.md` carries an
`Artifact language: <language>.` line, write the title and body in that language regardless of the
language this conversation used; with no line, follow the conversation as before. The conventional
commit prefix (`feat:`, `fix:`) is a token, not prose — it does not translate, and neither do
commands under **Validation**, file paths, or identifiers.

Show title, body, base/head, draft status, review gate, and whether a push is needed. Everything to
here is plain git. `--body-only` stops at this point, and so does every lane except the GitHub one —
in which case say what the artifact is for (`pr.md` to paste, or the `gh` command to run once
authenticated) rather than reporting a failure. The work is the same; only the last hop is missing.

## 5. Publish only after confirmation — GitHub lane only

Ask one explicit confirmation covering the exact external actions. If needed, push with
`git push -u origin HEAD`, then:

- no existing PR: `gh pr create --base <base-branch> --head <branch> --title <title> --body-file <pr.md>`
  plus `--draft` when requested;
- existing PR: `gh pr edit <number-or-url> --title <title> --body-file <pr.md>`; do not silently
  change draft/ready state.

Report the PR URL. Never commit, stage, push, create, edit, close, or mark ready without the
developer's explicit approval.
