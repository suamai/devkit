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
  "worktree": "<absolute path, set when a flow runs --isolated>",
  "worktree_branch": "<branch>",
  "worktree_integrated": "true — set once step 10 merges or cherry-picks the branch; omitted otherwise",
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

`worktree` and `worktree_branch` appear only on a flow that ran `/dev-implement <slug> --isolated`:
the absolute path of that flow's git worktree, and the branch it was created on. Both are **flat
top-level strings on purpose**, not a nested `isolation` object — `hooks/session-start-stale-flows.sh`
reads a state file with a `sed` one-liner that matches top-level strings and nothing else, and an
abandoned isolated run is exactly the case that has to be able to say where its work is at session
start. The workspace itself never moves into the worktree: it stays in the primary checkout, so this
skill's glob, `/dev-implement`'s concurrency lock and that hook all keep seeing an isolated flow.

`worktree_integrated` is a third, optional top-level boolean: `/dev-implement` step 10 writes it
`true` the moment it merges or cherry-picks the branch into the primary checkout, and never writes
it at all otherwise — same rule as `isolated` in the run ledger. It is what Status below reads to
tell a merged flow's now-removed worktree from one still at risk.

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
   is historical, not a current PR gate. For a flow whose state carries `worktree`, also test that
   the path is still a directory — one `[ -d "<path>" ]`, nothing more.
3. Report a compact table: slug, stage, updated, task, artifacts and latest PR-review outcome/SHA.
   Flag an `implementing` stage with no running task, or an update older than ~24h, as likely stale.
   A workspace whose state carries `archived` is finished and thinned on purpose — report it as
   archived and never flag it stale or missing artifacts; its files were deleted by request.
   A flow carrying `worktree` is isolated: name that path and its `worktree_branch` in the row, so
   the diff is findable without re-deriving where it went. A `worktree` path that is gone is worth
   flagging exactly like a stale `implementing` stage — the state still claims a worktree, so the
   work now survives only on the branch — **unless the state also carries `worktree_integrated:
   true`**, which means step 10 already merged or cherry-picked that branch into the primary
   checkout before the directory disappeared; report that plainly ("worktree removed after merge")
   rather than as at risk, since the work is in the primary checkout's own history now. Without that
   flag, `git branch --list "<worktree_branch>"` is the one command that says whether even the
   branch is still there. Report what it answers; deleting a branch is never this skill's decision.

## Clean (`clean <slug>`)

1. Show exactly what will be deleted, including PR drafts and reviews under `.dev/<slug>/`. When the
   state carries `worktree`, that worktree is on the list too: name its path, and say that the branch
   in `worktree_branch` **survives** and every commit made in that worktree survives with it — what
   is lost is any **uncommitted** work still sitting in the worktree.
2. Confirm with the developer before deleting (this is destructive and not yours to assume).
3. When the state carries `worktree`, remove the worktree **first**, with the one command
   `/dev-implement` also offers at the end of an isolated run:
   ```bash
   sh "${CLAUDE_PLUGIN_ROOT}/scripts/worktree.sh" remove <slug>
   ```
   The order is not cosmetic: `rm -rf` over a directory holding a nested worktree leaves that
   worktree registered as `prunable` in the repo's `.git/worktrees`, and it takes a separate
   `git worktree prune` to clear — reproduced. If the worktree still holds uncommitted changes the
   command exits 3 and removes nothing: that is a decision surfacing, not a fault. Show git's own
   refusal, and append `--force` only after the developer says that uncommitted work is expendable —
   never on your own initiative, and never as a retry. Exit 2 ("no worktree is registered…") means
   it was already removed — most often via this same command, already offered and taken at the end
   of the isolated run itself (`state.json`'s `worktree` key is not cleared by that) — treat it as
   already done and continue to step 4, not as a fault. Skip this step entirely when there is no
   `worktree` key; it is the only thing that makes an isolated flow's cleanup different.
4. Delete the workspace directory and report. Its state file lives inside it, so nothing else needs
   unlinking. If a worktree was removed, name the branch that survived it and give
   `git branch -D <worktree_branch>` as the separate second decision — offered, never run.

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
   whatever else is there. List what the directory actually holds, not this list. When the state
   carries `worktree`, the worktree is on that list too, and its entry says two things plainly:
   the branch in `worktree_branch` survives, and with it every commit made in that worktree — but
   **any uncommitted work in the worktree is lost**. Archiving is how the space gets reclaimed, so
   the worktree cannot be quietly exempted; saying what it costs, before the confirmation, is what
   makes that a decision rather than a surprise.
2. Confirm with the developer before deleting. This is destructive and not yours to assume — the
   plan, the briefs, the review reports and the worktree are gone afterwards.
3. When the state carries `worktree`, remove the worktree first — the same one command `clean` uses,
   for the same reason (a plain `rm -rf` over a nested worktree leaves it `prunable` in
   `.git/worktrees`, needing a separate `git worktree prune`):
   ```bash
   sh "${CLAUDE_PLUGIN_ROOT}/scripts/worktree.sh" remove <slug>
   ```
   Its exit 3 on an uncommitted worktree, and the `--force` that answers it, work exactly as under
   `clean` — step 1 already said what that costs, so this is where the developer confirms it against
   git's own message rather than against a warning. Its exit 2 ("no worktree is registered…") also
   works exactly as under `clean`: the worktree was already removed, treat it as already done and
   continue. Then delete the rest:
   ```bash
   find ".dev/<slug>" -mindepth 1 -maxdepth 1 ! -name state.json -exec rm -rf {} +
   ```
4. Rewrite `state.json` keeping **every key it already has, except `findings`, `worktree` and
   `worktree_branch`**, and adding `archived: "<YYYY-MM-DD HH:MM>"`. This is a drop-list, not an
   allow-list: `updated` and anything else a phase handed on (`plan`, `spec`, `decisions`) survive
   untouched, matching the "a reader tolerates extra keys and never drops one it did not write"
   invariant stated above — an allow-list that named only `task`, `stage`, `baseline`, `lastRunId`
   and `runs` would silently erase all of that. The three that go, go for one reason and it is not
   tidiness: each of them names something step 3 just removed. `findings`' `report_path` entries
   point at the `findings/` files, and that array is what `/dev-plan` reads back as `priorFindings`
   for a later run in this workspace — a dangling path handed to a scout is worse than no prior
   findings at all. `worktree` points at a directory that no longer exists, and leaving it would have
   every later `/dev-status` and every session start announce a worktree that is gone;
   `worktree_branch` goes with it, because a branch name left behind on its own reads as a live
   isolated flow. `worktree_integrated` deliberately **stays**, and it is the exception that shows
   what the rule is: it names no path and points at nothing step 3 removed — it records that this
   flow's branch was merged or cherry-picked, which stays true forever and is exactly the thing worth
   knowing about an archived flow whose worktree is gone. Report what was deleted, that everything else including the run summaries was kept,
   and — the one thing no longer recorded anywhere — **name the surviving branch**, so its commits
   stay findable (`git branch --list "<branch>"`; `git branch -D "<branch>"` remains a separate
   decision nobody takes here).

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
