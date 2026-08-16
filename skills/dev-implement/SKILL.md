---
name: dev-implement
description: Execute an approved plan from /dev-plan — adaptive context scouting, verified implementation, a cheap contract gate per dependency wave, and consolidated review at cost-driven checkpoints.
argument-hint: <slug, workspace, or plan.md> [--continue] [extra notes]
---

You orchestrate the implementation phase of a planned dev task. The heavy lifting happens in the `wf-implement` workflow (which can recursively split oversized steps, gates each dependency wave with one cheap contract check, and calls `wf-review-loop` at accumulated review checkpoints); your job is preflight, interrupts, phase commits, and the final report.

## Process

1. **Resolve the workspace.** A slug resolves to `.dev/<slug>/`; a `plan.md` path resolves to its
   parent. If absent, use the most recently modified workspace only when unambiguous.
   Read `<workspace>/plan.md` and parse the ```json steps block from the "Machine-readable steps"
   section. If missing or malformed, reconstruct it from the Steps sections and write it back. A
   plan marked `Tier: small` has no steps block by design and is not an input to this skill — it was
   triaged to be implemented inline; say so instead of manufacturing steps to fan a one-file change
   out across agents. With `--continue`, read `<workspace>/last-run.json` too and follow
   "Continuing a run that stopped" below instead of starting over.

2. **Concurrency lock.** Glob `.dev/*/state.json` and read them: any workspace at `implementing` is
   the repo-wide lock. Check whether it is live (running workflow task, recent `updated`). Live →
   stop: one implement per repo at a time because verifications share the working tree. Stale →
   offer to mark it abandoned and proceed.

3. **Git preflight.** This phase requires a git repo (offer `git init` otherwise). If on the default
   branch, create and switch to `dev/<slug>`. Ensure `.dev/` is gitignored. Capture the baseline —
   reviewers judge diffs since it.

4. **Sanity-check the steps.** Each step needs `id`, `goal`, `files`, `depends_on`, `details`, and an
   executable `verify`; `risk: "contract" | "local"` is optional but worth filling in for steps that
   change a consumed surface — it earns an immediate review checkpoint. Steps sharing files must be
   linked by `depends_on`, but the reverse is a smell: a `depends_on` that isn't a hard dependency
   (the other step's code must exist to compile/run/verify) deepens the sequential chain for nothing.
   Run the lint rather than eyeballing it — zero agents, zero tokens:
   `Workflow({ name: "devkit:wf-implement", args: { dryRun: true, steps, rules } })` returns the
   schedule this run would follow (waves, real parallel groups, scouts, matched rules, projected
   checkpoints) plus `warnings` and an `agents_min` floor. A chain of mostly single steps, steps
   with overlapping files and no dependency, or a step with no `verify` all show up there; depth is
   the main driver of wall-clock, so offer to flatten before running. Fix obvious gaps in the plan
   file; ask only for judgment calls. If the plan wasn't approved in this conversation, show a one-paragraph summary
   and get explicit go-ahead — this phase edits many files.

5. **Update state and run.** Set `stage: "implementing"` with `baseline` and `updated` in the
   workspace's `state.json`; it returns to `implemented` in step 8. Then:
   ```
   Workflow({ name: "devkit:wf-implement", args: { workspace, steps, baseline, notes, reviewLoopPath, rules } })
   ```

   `rules`: the repo's path-scoped checklists, so subagents stop rediscovering conventions the repo
   already documented. `.claude/rules/*.md` is a **native** Claude Code convention — those files load
   automatically alongside CLAUDE.md, scoped by a `paths:` frontmatter key — but that loading is a
   main-session mechanism and background subagents inherit none of it. Workflow scripts also have no
   filesystem access, so you extract the manifest and the workflow matches each step's files against
   the globs (it outputs `[]` when there is no `.claude/rules/`, and the workflow then tells agents to
   look for rules themselves):
   ```bash
   sh "${CLAUDE_PLUGIN_ROOT}/scripts/rules-manifest.sh"
   ```
   A rule file with no `paths:` is unscoped — natively always loaded, so the workflow hands it to
   every agent. It comes back with empty `globs`; pass it through rather than filtering it out.
   `notes`: anything the developer said since the plan was written. `reviewLoopPath`:
   `${CLAUDE_PLUGIN_ROOT}/workflows/wf-review-loop.js`. Optional: `review: false`,
   `reviewRounds: N` (default 3 — rounds after the first are one targeted agent, so this is cheaper
   than it looks), `scoutMode: "always" | "adaptive" | "never"` (default adaptive: the plan's
   `context_confidence` decides, heuristic as fallback), `maxParallelSteps` (default 5), `gate: false`,
   `checkpointFileThreshold` (default 20), `checkpointMaxWaves` (default 3); `profile`/`models`/`efforts` (see Cost below — `impl` runs once per step and is the pipeline's largest single cost).

   Waves stay sequential (that's `depends_on`), but review is **not** per wave: waves accumulate into
   a review checkpoint, and each wave in between gets one cheap contract gate. To restore per-wave
   review — the developer asks for it, or the work is unusually contract-heavy — pass
   `checkpointFileThreshold: 1, checkpointMaxWaves: 1`. If the workflow name does not resolve (the plugin has not loaded in this session yet), invoke
   with `scriptPath` pointing at `${CLAUDE_PLUGIN_ROOT}/workflows/wf-implement.js`. Record the returned run id as
   `lastRunId` in the workspace's `state.json` — it enables resume.

6. **On completion, persist and read the result.** First write `<workspace>/last-run.json`
   (`{ runId, stoppedEarly, stopReason, args, continuation }`) — without it a continuation in a later
   session has no steps array and no completion map. Then:
   - `needs_user_input` with `blocking: true` → the run **stopped there on purpose**: an implementer
     guessed at something that changes its step's approach, and dependent waves were not built on the
     guess. Ask these first (AskUserQuestion, include the recorded `assumption` as context). If the
     answer matches the assumption, continue the run (see below); if it does not, the step needs rework
     before anything downstream runs. Non-blocking questions are informational — resolve them inline.
   - `unverifiedSteps` non-empty → those steps have no substantiated executable check. Their
     behavior rests on the checkpoint reviews and the suite. Verify them yourself now — that is step 7
     — and never report them as verified. `reason` distinguishes two different failures, and they are
     worth reporting differently: an honest one (the implementer set `ran: false` and explained why no
     check was possible) versus a claimed-but-unevidenced one ("claimed ran=true without naming the
     command it ran" / "…without reporting whether the check passed"). The second means an implementer
     asserted verification it did not substantiate — mention it, it is a prompt-calibration signal.
   - `concerns` non-empty → the implementers' own doubts. The checkpoint reviewers received them as
     priority targets and the final check was asked to settle them, so treat anything still listed
     here as unresolved and either check it or surface it in your report.
   - `stage: "implement-result-unavailable"` → classify it before taking action. Read that agent's transcript/journal and check `expected_notes_path`:
     - Repeated `StructuredOutput`/schema validation errors **and** a completed notes file/code diff → `result_serialization_failed`. The implementation itself is not failed; do not re-run it. Reconstruct the compact report inline from notes + diff and report the serialization failure separately.
     - No structured-output errors and no completed notes/code evidence → `implementation_failed`; re-run the step or implement inline.
     - Conflicting evidence → `agent_failed_unknown`; surface it instead of guessing.
   - Other failed steps (`failed: true`, e.g. `stage: "verify"`) → check the workflow journal, fix the cause, then continue (see below); only the failed step and what follows it re-runs.
   - Steps `skipped_for_budget` → report them; continue with a fresh budget when the developer asks.
   - Split steps (`split: true`) → normal (size escape valve); mention it so future plans size better.
   - `unreviewedWaves` non-empty → those waves were implemented but never reached a checkpoint (the run
     stopped early), so their code is in the tree unjudged. Continuing handles this by itself: they come
     back as `continuation.completed` entries with `reviewed: false` and are folded into the next
     checkpoint. Only if the developer abandons the flow do you review them separately with
     `wf-review-loop` scoped to their files.
   - `contractGates[].breaks` → gates that fired. High/critical ones already forced a checkpoint;
     low/medium ones were informational and the checkpoint review should have covered them — if one
     survived into `finalCheck.issues`, mention it, it means the gate is more accurate than the review.
   - `finalCheck.issues` high/critical with `fixed: false` → fix inline or run `wf-review-loop` scoped to the affected files (pass the same `baseline`).

7. **Verify end-to-end.** Per-step `verify_run` and `suite_run` already executed checks; re-run
   anything that failed after your fixes, and exercise the changed flow if the project has a runtime
   surface (the built-in `/run` skill launches it). Give `unverifiedSteps` an actual check here — they
   are the only steps whose behavior nothing has executed.

8. **Phase commit.** `impl(<slug>): <plan title>`, with the standard co-author trailer; using this
   skill opts into phase commits unless the developer said otherwise. Then set `stage: "implemented"`
   in the workspace's `state.json`.

9. **Report.** Lead with `cost`: `by_phase` (`steps` = scouting + implementation, which cannot be
   split further because parallel steps interleave; `gate`; `review`; `check`) and `total`. If
   `floors_active` is false, say so once — the budget floors that skip steps and stop review rounds
   were inert, because they only exist when the developer put a "+300k"-style target in their own
   message. Then per step: what changed, verification result, deviations and why. Report
   `implementation_failed`, `result_serialization_failed`, and `agent_failed_unknown` distinctly.
   Then, per checkpoint, which waves it covered and its rounds/fixes (`checkpointReviews[].reason`
   says why it fired); contract gates that found breaks; consistency check, commit hash, and
   concerns. State `unverifiedSteps` explicitly — "N steps have no substantiated check of their
   own", with the honest/unevidenced split from step 6 — and
   if `stoppedEarly`, lead with `stopReason` rather than burying it under the per-step detail.
   If the run stopped early, do **not** phase-commit and report as done — say what stopped it and
   offer the continuation below.

10. **Ratchet the repo's rules — only when the run produced evidence.** Nothing carries between
    cycles by design; the repo itself is the only durable store, so this is the one moment where
    what an agent learned can be written somewhere the next one will read it.

    **Offer this only when there is a signal**, never as a routine end-of-run question: confirmed
    findings in `checkpointReviews[].review.confirmed`, unresolved `finalCheck.issues`, or an
    implementer's `notes/` recording a convention it had to discover. A clean run has nothing to
    ratchet, and asking anyway trains the developer to say no.

    When it fires, one agent reads the workspace's `notes/`, the confirmed findings and the existing
    `.claude/rules/*.md`, and returns **at most three** proposed edits. Hard constraints, because
    each one is a failure mode this would otherwise walk into:

    - **A bug is not a convention.** Review findings are mostly defects, and turning each into a rule
      builds a rulebook of paranoia that later agents skim past. The test: would this have applied to
      a *different* task in the same area? If it only describes what went wrong once, it belongs in
      the commit message, not in a rule.
    - **Cite the evidence.** Every proposal names the note or finding behind it, with a path. A
      proposal that reads like general best practice came from the model's priors, not this repo.
    - **Prefer editing an existing rule to adding one.** Fifteen rule files that each match
      everything are worse than three that match precisely — a rule nobody can scope is a rule nobody
      reads.
    - **A rule must be followable.** "Be careful with migrations" is not a rule; "a migration and the
      code that requires it land in the same commit" is. If an agent could not tell whether it had
      complied, it is not a rule.

    The agent **proposes**; you show the developer a diff per file and write only what they approve.
    Rules are versioned, PR-reviewable repo content with a human curator — that is the whole reason
    this store was chosen over an agent-writable one.

## Continuing a run that stopped

Stopping early is a designed outcome here, not a crash: a blocking question, an unclean checkpoint, a
failed step or the budget floor all end the run with `stoppedEarly: true` and a `stopReason`. The
work that landed is real and in the tree, so continuing resumes from it — it never re-runs it.

Invoked as `/dev-implement <slug> --continue` (or just "continue the implement"): read
`<workspace>/last-run.json` for the previous `args` and `continuation`.

1. **Resolve what stopped it first.** A blocking question gets an answer; an unclean checkpoint gets
   its findings addressed; a failed step gets its cause fixed. Continuing without that stops again in
   the same place, having paid for the run.
2. **Re-invoke with the same `steps` plus `completed`:**
   ```
   Workflow({ name: "devkit:wf-implement", args: {
     workspace, steps, baseline, rules, reviewLoopPath,
     completed: <previous result's continuation.completed, verbatim>,
     notes: <previous notes + the developer's answers>
   } })
   ```
   Pass the plan's **full** steps array. The workflow strips completed ids out of `depends_on`
   itself; passing only the pending steps fails, because the dependency check rejects ids it cannot
   see. `baseline` stays the original one — reviewers must still judge the whole change.
3. **Never hand-edit `completed`.** Its `reviewed` flags decide what gets folded into the next review
   checkpoint. Flipping one to `true` to save a round ships unjudged code, which is the specific
   failure this field exists to prevent.
4. **`resumeFromRunId` is a different tool.** It replays cached agents after a *crash*. A planned
   stop usually changes `notes` (that is where the answer goes), which changes every implementer
   prompt and invalidates the cache anyway — so `completed` is the path here, not resume.

## Cost

Every workflow takes the same three cost args, and every skill passes them through:
`profile: "cheap" | "default" | "max"` shifts every agent one rung on the model ladder;
`models: { <role>: "haiku|sonnet|opus" }` and `efforts: { <role>: "low|…|max" }` override one role
and beat the profile. Roles are pipeline-wide (`decompose, scout, validate, synth, impl, gate,
check, review, verify, fix`), so one object covers a workflow and everything it calls. An unknown
role or value throws before any agent runs — check it with `dryRun: true`, which returns the
resolved policy. Omitting all three reproduces the shipped tiers exactly. Default it from the
repo's `Cost profile:` line in CLAUDE.md when one is present.

This skill forwards them into the nested `wf-review-loop` as well, so one dial covers
implementation *and* its review checkpoints.

## Notes

- Workspace files: `briefs/` (only scouts that actually ran) and `notes/` (implementers — decisions and their whys, deviations, traps for later steps). Point the developer at them rather than pasting.
- Only steps with declared disjoint `files` run in parallel. True parallel *flows* need one git worktree per flow — designed extension, not built; don't improvise it.
