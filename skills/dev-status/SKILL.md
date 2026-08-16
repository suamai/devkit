---
name: dev-status
description: Show dev-pipeline flow status — stages, staleness, artifacts, PR reviews and remediation workspaces — and clean up finished or abandoned workspaces.
argument-hint: [clean <slug>]
---

Each task workspace owns its state file at `.dev/<slug>/state.json` — one writer by construction,
no shared registry to reconcile:

```json
{
  "task": "one-line description",
  "stage": "spec | planning | plan-ready | implementing | implemented | abandoned",
  "updated": "2026-07-09 14:32",
  "baseline": "<git sha, set when implementing starts>",
  "lastRunId": "wf_..."
}
```

## Status (default)

1. Glob `.dev/*/state.json` and read each. Then list `.dev/*/` directories to catch a workspace with
   no state file — infer its stage from what is on disk (`spec.md` alone → `spec`; `plan.md` →
   `plan-ready`; `notes/` present → `implementing` or `implemented`) and offer to write the file.
   `.dev/pr/<branch>/` workspaces are listed separately and never carry state.
2. For each flow, check normal artifacts plus `pr.md`, `reviews/*.md`, and
   `remediations/*/{plan.md,briefs/,notes/}`; also check whether a workflow task is running
   (TaskList). A review whose `reviewed_head` differs from current `HEAD` is historical, not a
   current PR gate. Remediations carry no state file of their own — read them off disk: a
   `remediations/<sha>/plan.md` with no `notes/` beside it is planned but not implemented.
3. Report a compact table: slug, stage, updated, task, artifacts, latest PR-review outcome/SHA, and
   any remediation workspace found on disk with its apparent state. Flag an `implementing` stage
   with no running task, or an update older than ~24h, as likely stale.

## Clean (`clean <slug>`)

1. Show exactly what will be deleted, including PR drafts, reviews, and remediation workspaces under
   `.dev/<slug>/`.
2. Confirm with the developer before deleting (this is destructive and not yours to assume).
3. Delete the workspace directory and report. Its state file lives inside it, so nothing else needs
   unlinking.

`clean pr/<branch>` follows the same show-and-confirm rule but deletes only that standalone PR
workspace. Never interpret bare `pr` as permission to delete every branch.

## Notes

- Keep `updated` as a plain `YYYY-MM-DD HH:MM` string (from the `date` command).
- Planned extension (not built): an HTML dashboard rendered via Artifact from the per-workspace
  state files. If the developer asks to "see" the flows visually, offer to generate one.
