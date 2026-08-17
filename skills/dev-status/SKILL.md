---
name: dev-status
description: Show dev-pipeline flow status — stages, staleness, artifacts and PR reviews — clean up or archive finished workspaces, and print the pipeline calibration checklist from the run ledger.
argument-hint: [clean <slug>] [archive <slug>] [--calibration]
---

Each task workspace owns its state file at `.dev/<slug>/state.json` — one writer by construction,
no shared registry to reconcile:

```json
{
  "task": "one-line description",
  "stage": "spec | planning | plan-ready | implementing | implemented | abandoned",
  "updated": "2026-07-09 14:32",
  "baseline": "<git sha, set when implementing starts>",
  "lastRunId": "wf_...",
  "findings": [{ "angle": "...", "report_path": "...", "summary": "..." }],
  "runs": [
    { "phase": "plan", "ts": "2026-07-09 11:04", "tier": "medium", "agents_projected": 19 },
    { "phase": "implement", "ts": "2026-07-09 14:32", "run_id": "wf_...", "steps_leaf": 7,
      "rounds": 2, "confirmed": 4, "applied": 4, "unverified": 1, "cost_total": 138000,
      "stopped": false }
  ]
}
```

`runs` is the compact per-phase run summary — one entry appended by the skill that owned the phase,
earlier entries never rewritten. It carries the same numbers as the run ledger
(`docs/architecture.md` → "The run ledger"), and the duplication is deliberate: `archive <slug>`
keeps this file and deletes everything else, so the evidence survives here even where the ledger is
lost. A reader tolerates extra keys and never drops one it did not write; real workspaces also carry
what a phase handed on (`plan`, `spec`, `decisions`).

## Status (default)

1. Glob `.dev/*/state.json` and read each. Then list `.dev/*/` directories to catch a workspace with
   no state file — infer its stage from what is on disk (`spec.md` alone → `spec`; `understanding.md`
   with no `plan.md` → explored but not planned; `plan.md` → `plan-ready`; `notes/` present →
   `implementing` or `implemented`) and offer to write the file. `findings` is the reusable
   exploration index `/dev-plan` stores so a later run in that workspace skips re-scouting; report
   its presence, never its contents.
   `.dev/pr/<branch>/` workspaces are listed separately and never carry state.
2. For each flow, check normal artifacts plus `pr.md` and `reviews/*.md`; also check whether a
   workflow task is running (TaskList). A review whose `reviewed_head` differs from current `HEAD`
   is historical, not a current PR gate.
3. Report a compact table: slug, stage, updated, task, artifacts and latest PR-review outcome/SHA.
   Flag an `implementing` stage with no running task, or an update older than ~24h, as likely stale.
   A workspace whose state carries `archived` is finished and thinned on purpose — report it as
   archived and never flag it stale or missing artifacts; its files were deleted by request.

## Clean (`clean <slug>`)

1. Show exactly what will be deleted, including PR drafts and reviews under `.dev/<slug>/`.
2. Confirm with the developer before deleting (this is destructive and not yours to assume).
3. Delete the workspace directory and report. Its state file lives inside it, so nothing else needs
   unlinking.

`clean pr/<branch>` follows the same show-and-confirm rule but deletes only that standalone PR
workspace. Never interpret bare `pr` as permission to delete every branch.

`clean` is unchanged by `archive`: whole directory, `state.json` included, destructive, confirmed
first. When the workspace is done but its numbers are worth keeping, `archive <slug>` is the
alternative that deletes the bulk and keeps the evidence.

## Archive (`archive <slug>`)

Not a gentler `clean` — a different operation. `clean` removes the workspace; `archive` reclaims the
space and keeps `state.json`, so the compact `runs` summaries of what that task cost survive.

1. Show exactly what will be deleted: everything under `.dev/<slug>/` **except** `state.json` —
   `plan.md`, `spec.md`, `findings/`, `briefs/`, `notes/`, `reviews/`, `pr.md`, `last-run.json` and
   whatever else is there. List what the directory actually holds, not this list.
2. Confirm with the developer before deleting. This is destructive and not yours to assume — the
   plan, the briefs and the review reports are gone afterwards.
3. Delete:
   ```bash
   find ".dev/<slug>" -mindepth 1 -maxdepth 1 ! -name state.json -exec rm -rf {} +
   ```
4. Rewrite `state.json` keeping **every key it already has, except `findings`**, and adding
   `archived: "<YYYY-MM-DD HH:MM>"`. This is a drop-list, not an allow-list: `updated` and anything
   else a phase handed on (`plan`, `spec`, `decisions`) survive untouched, matching the "a reader
   tolerates extra keys and never drops one it did not write" invariant stated above — an allow-list
   that named only `task`, `stage`, `baseline`, `lastRunId` and `runs` would silently erase all of
   that. Only `findings` goes, and not for tidiness: its `report_path` entries point at the
   `findings/` files step 3 just deleted, and that array is what `/dev-plan` reads back as
   `priorFindings` for a later run in this workspace — a dangling path handed to a scout is worse
   than no prior findings at all. Report what was deleted and that everything else, including the
   run summaries, was kept.

Re-planning in an archived workspace is fine; it simply re-scouts. `archive pr/<branch>` is not
offered: those workspaces carry no state file by design, so there is nothing to keep and archiving
one would be `clean` with extra words — use `clean pr/<branch>`.

## Calibration (`--calibration`)

Is this pipeline calibrated — does it size steps well, converge in the rounds it should, escalate as
often as it claims? The run ledger (`~/.claude/devkit/runs.jsonl`, one line per phase run, appended
by the phase skills) holds the numbers; one script turns them into the checklist.

1. Run it and show its output:
   ```bash
   sh "${CLAUDE_PLUGIN_ROOT}/scripts/ledger-report.sh"
   ```
   It prints `docs/architecture.md`'s "First-run calibration checklist" with real numbers, each row
   with its sample size. Needs no workspace and no slug: the ledger is per developer and spans repos,
   so this answers the same in a repo with no `.dev/` at all.
2. Three rules, and they are rules:
   - **Print what the script printed.** Never add a row, a total, a trend or a comparison it did not
     produce, and never round or "clean up" a number. Every figure here has to be arithmetic the
     developer can re-run. A row that says `n=0 — no data` is a result — show it as it came.
   - **No ledger is an answer.** If it prints `no ledger yet at ~/.claude/devkit/runs.jsonl …` it
     exits 0 and so do you: relay that line and stop. Do not offer to reconstruct the numbers from
     `.dev/` workspaces — those are a biased sample by construction (`clean` deletes exactly the
     tasks that went well) and a reconstructed figure is indistinguishable from a measured one once
     it is on screen.
   - **Never read, quote, grep or summarise raw ledger lines** — not one line, not "just to check the
     shape", not to answer a follow-up question. Aggregates may reach the conversation; the lines
     behind them never do. Run history inside a prompt is exactly the uncurated cross-cycle memory
     this project rejected (`docs/architecture.md` → "No shared memory across cycles"), and it is
     unreliable arithmetic on top. If a number looks wrong, that is a bug in the script.
3. Say once how to read them: these are calibration input, not a target. A clustering ratio of 2.4 is
   a fact about reviewer overlap, not a score to raise; each row in the architecture doc's checklist
   names the knob it points at, and one sample size of 2 means the row is not yet worth acting on.

`/dev-status` writes no ledger line of its own — it is not a phase — and the script only reads.

## Notes

- Keep `updated`, `archived`, and every `runs[].ts` as plain `YYYY-MM-DD HH:MM` strings (from the
  `date` command) — this file is read by humans; the ledger keeps the ISO timestamps. Every phase
  skill's compact `runs` entry uses this same format for its `ts` field, matching `updated`.
- Planned extension (not built): an HTML dashboard rendered via Artifact from the per-workspace
  state files. If the developer asks to "see" the flows visually, offer to generate one.
