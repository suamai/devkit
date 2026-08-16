---
name: dev-implement
description: Execute an approved feature or PR-remediation plan from /dev-plan — adaptive context scouting, verified implementation, a cheap contract gate per dependency wave, and consolidated review at cost-driven checkpoints.
argument-hint: <slug, workspace, or plan.md> [extra notes]
---

You orchestrate the implementation phase of a planned dev task. The heavy lifting happens in the `wf-implement` workflow (which can recursively split oversized steps, gates each dependency wave with one cheap contract check, and calls `wf-review-loop` at accumulated review checkpoints); your job is preflight, interrupts, phase commits, and the final report.

## Process

1. **Resolve the workspace.** A slug resolves to `.dev/<slug>/`; a directory may be a normal task
   workspace or nested `<task>/remediations/<reviewed-sha>/`; a `plan.md` path resolves to its
   parent. If absent, use the most recently modified top-level workspace only when unambiguous.
   Read `<workspace>/plan.md` and parse the ```json steps block from the "Machine-readable steps"
   section. If missing or malformed, reconstruct it from the Steps sections and write it back.
   Detect remediation plans by their source-review/reviewed-HEAD metadata and retain the parent
   task slug for state and commit naming.

2. **Concurrency lock.** Read `.dev/state.json`. Any flow at `implementing` is the repo-wide lock —
   a remediation run uses its parent task's flow entry, so there is one lock, not two. Check whether
   it is live (running workflow task, recent `updated`). Live → stop: one implement per repo at a
   time because verifications share the working tree. Stale → offer to mark it abandoned and proceed.

3. **Git preflight.** This phase requires a git repo (offer `git init` otherwise). For a normal plan,
   if on the default branch, create and switch to `dev/<slug>`. For a remediation plan, require the
   current branch to match its source review and require `HEAD` to equal its `reviewed_head`; drift
   means rerun `/dev-pr --review` and `/dev-plan --review`. Never create a new branch for remediation.
   Remediation also requires a clean working tree: uncommitted bytes were not reviewed. Ensure
   `.dev/` is gitignored. Capture the baseline; for remediation it is exactly
   `reviewed_head`, so the implementation's internal reviews judge only the fixes.

4. **Sanity-check the steps.** Each step needs `id`, `goal`, `files`, `depends_on`, `details`, and an
   executable `verify`; `risk: "contract" | "local"` is optional but worth filling in for steps that
   change a consumed surface — it earns an immediate review checkpoint. Steps sharing files must be
   linked by `depends_on`, but the reverse is a smell: a `depends_on` that isn't a hard dependency
   (the other step's code must exist to compile/run/verify) deepens the sequential chain for nothing.
   If the steps form a chain of mostly single steps, say so and offer to flatten it before running —
   depth is the main driver of implementation wall-clock. Fix obvious gaps in the plan file; ask only
   for judgment calls. If the plan wasn't approved in this conversation, show a one-paragraph summary
   and get explicit go-ahead — this phase edits many files.

5. **Update state and run.** Set the flow to `implementing` with `baseline` and `updated`. A
   remediation writes to its parent task's entry — the stage describes what is running now, and it
   returns to `implemented` in step 8. You are the only state writer. Then:
   ```
   Workflow({ name: "devkit:wf-implement", args: { workspace, steps, baseline, notes, reviewLoopPath, rules } })
   ```

   `rules`: the repo's path-scoped checklists, so subagents stop rediscovering conventions the repo
   already documented. Workflow scripts have no filesystem access, so you read them and the workflow
   matches each step's files against the globs. Build it with one command (skip if `.claude/rules/`
   doesn't exist — the workflow then tells agents to look for rules themselves):
   ```bash
   awk 'FNR==1{f=FILENAME;infm=0;n=0} /^---$/{infm++;next} infm==1 && /^[[:space:]]*-[[:space:]]/{g=$0;sub(/^[[:space:]]*-[[:space:]]*/,"",g);gsub(/^['"'"'"]|['"'"'"]$/,"",g);globs[f]=globs[f] (n++?",":"") "\"" g "\""} END{printf "[";c=0;for(k in globs){printf "%s{\"path\":\"%s\",\"globs\":[%s]}",(c++?",":""),k,globs[k]};print "]"}' .claude/rules/*.md
   ```
   `notes`: anything the developer said since the plan was written. `reviewLoopPath`:
   `${CLAUDE_PLUGIN_ROOT}/workflows/wf-review-loop.js`. Optional: `review: false`,
   `reviewRounds: N` (default 3 — rounds after the first are one targeted agent, so this is cheaper
   than it looks), `scoutMode: "always" | "adaptive" | "never"` (default adaptive: the plan's
   `context_confidence` decides, heuristic as fallback), `maxParallelSteps` (default 5), `gate: false`,
   `checkpointFileThreshold` (default 20), `checkpointMaxWaves` (default 3).

   Waves stay sequential (that's `depends_on`), but review is **not** per wave: waves accumulate into
   a review checkpoint, and each wave in between gets one cheap contract gate. To restore per-wave
   review — the developer asks for it, or the work is unusually contract-heavy — pass
   `checkpointFileThreshold: 1, checkpointMaxWaves: 1`. If the workflow name does not resolve (the plugin has not loaded in this session yet), invoke
   with `scriptPath` pointing at `${CLAUDE_PLUGIN_ROOT}/workflows/wf-implement.js`. Record the returned run id as
   `lastRunId` in state.json — it enables resume.

6. **On completion, read the result:**
   - `needs_user_input` with `blocking: true` → the run **stopped there on purpose**: an implementer
     guessed at something that changes its step's approach, and dependent waves were not built on the
     guess. Ask these first (AskUserQuestion, include the recorded `assumption` as context). If the
     answer matches the assumption, resume the remaining waves; if it does not, the step needs rework
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
   - Other failed steps (`failed: true`, e.g. `stage: "verify"`) → check the workflow journal and re-run only what failed. A crashed run can resume with `Workflow({scriptPath, resumeFromRunId: <lastRunId>, args: <same>})`; completed agents replay from cache.
   - Steps `skipped_for_budget` → report them; re-run with a fresh budget when the developer asks.
   - Split steps (`split: true`) → normal (size escape valve); mention it so future plans size better.
   - `unreviewedWaves` non-empty → those waves were implemented but never reached a checkpoint (the run
     stopped early). Their code is unreviewed: after resolving what stopped the run, review them with
     `wf-review-loop` scoped to their files, or let the resumed run reach the next checkpoint.
   - `contractGates[].breaks` → gates that fired. High/critical ones already forced a checkpoint;
     low/medium ones were informational and the checkpoint review should have covered them — if one
     survived into `finalCheck.issues`, mention it, it means the gate is more accurate than the review.
   - `finalCheck.issues` high/critical with `fixed: false` → fix inline or run `wf-review-loop` scoped to the affected files (pass the same `baseline`).

7. **Verify end-to-end.** Per-step `verify_run` and `suite_run` already executed checks; re-run
   anything that failed after your fixes, and exercise the changed flow if the project has a runtime
   surface (the built-in `/run` skill launches it). Give `unverifiedSteps` an actual check here — they
   are the only steps whose behavior nothing has executed.

8. **Phase commit.** Normal plan: `impl(<slug>): <plan title>`. Remediation:
   `fix(<slug>): address PR review findings`. Include the standard co-author trailer; using this
   skill opts into phase commits unless the developer said otherwise. Then set the flow's stage to
   `implemented`. A completed remediation leaves no extra state: the workspace on disk
   (`remediations/<sha>/` with its plan and notes) is the record.

9. **Report.** Per step: what changed, verification result, deviations and why. Report
   `implementation_failed`, `result_serialization_failed`, and `agent_failed_unknown` distinctly.
   Then, per checkpoint, which waves it covered and its rounds/fixes (`checkpointReviews[].reason`
   says why it fired); contract gates that found breaks; consistency check, commit hash, and
   concerns. State `unverifiedSteps` explicitly — "N steps have no substantiated check of their
   own", with the honest/unevidenced split from step 6 — and
   if `stoppedEarly`, lead with `stopReason` rather than burying it under the per-step detail.
   After remediation, always require a fresh `/dev-pr --review`: the old report remains evidence but
   cannot clear a different `HEAD`.

## Notes

- Workspace files: `briefs/` (only scouts that actually ran) and `notes/` (implementers — decisions and their whys, deviations, traps for later steps). Point the developer at them rather than pasting.
- Only steps with declared disjoint `files` run in parallel. True parallel *flows* need one git worktree per flow — designed extension, not built; don't improvise it.
