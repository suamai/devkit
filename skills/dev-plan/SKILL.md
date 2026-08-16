---
name: dev-plan
description: Triage and plan a development task, or turn a persisted PR review into an approved remediation plan; uses proportional exploration and batched validation.
argument-hint: <task description> | --review <review.md> [--deep]
---

You orchestrate the planning phase of a dev task. Fan-out work happens in the `explore-plan` workflow; your job is the parts a background workflow cannot do — triage, gathering input, interrupting the developer with questions, and iterating the plan with them.

## Review remediation mode — `/dev-plan --review <review.md>`

Route here before normal task triage when `--review` is present. This converts verified review
evidence into an implementation plan; it does not repeat full feature exploration.

1. **Validate the artifact.** Read the `Machine-readable findings` JSON block. Require `version: 1`,
   branch/base-branch/base-ref/merge-base/reviewed-head, and arrays for confirmed/refuted. Refuse clean reports or
   reports with no confirmed findings. Require the current branch to match and current `HEAD` to
   equal `reviewed_head`; code drift requires a fresh `/dev-pr --review`, not an override by default.
2. **Create a remediation workspace.** If the report is
   `<task-workspace>/reviews/<sha>.md`, use `<task-workspace>/remediations/<sha>/`; otherwise use a
   sibling `remediations/<sha>/`. Never overwrite an existing `plan.md` without asking. The review
   is immutable evidence; the remediation workspace owns `plan.md`, `briefs/` and `notes/`.
3. **Triage cost.** Two or fewer findings with one clear root cause, one subsystem, and concrete
   suggested fixes → inspect current code and write the remediation plan inline. Otherwise run:
   ```
   Workflow({ name: "devkit:plan-remediation", args: {
     reviewPath, workspace: remediationWorkspace,
     validate: true, deep
   } })
   ```
   Use `${CLAUDE_PLUGIN_ROOT}/workflows/plan-remediation.js` as `scriptPath` if the name does not resolve. `--deep` requests deeper integration inspection; it still uses one batched validator and
   one synthesizer, never the 3-5-scout `explore-plan` fan-out. If batched revalidation returns
   `no_action: true`, report that all findings became refuted/stale and do not fabricate a plan.
4. **Plan contract.** Group findings by root cause and tightly coupled ownership — never one step per
   finding mechanically. Every step has `id`, `title`, `goal`, `files`, `depends_on` (hard
   dependencies only — they become sequential implementation waves), `details`, an executable
   `verify`, `risk` (`contract` | `local`), and `source_findings`. The markdown ends with the same machine-readable JSON
   steps block used by normal plans and names the source review + reviewed HEAD.
5. **Interrupt and approval.** Surface open questions, then present: groups/steps, dependencies,
   verification, dropped stale/refuted findings, and risks. Stop for explicit approval.
6. **Handoff.** On approval, suggest `/dev-implement <remediation-workspace>`. Remediation is not
   registered in `.dev/state.json`: the workspace on disk is the record, and `/dev-status` finds it
   by looking for `remediations/<sha>/plan.md`. Leave the parent flow's stage untouched.

Remediation mode is deliberately narrower than `explore-plan`: the review already contains
adversarially verified code evidence. Its work is correction strategy, grouping, dependencies, and
proof commands.

## 0. Triage first — pick the machinery, don't default to the pipeline

| Tier | Signals | Machinery |
|---|---|---|
| Trivial | typo, rename, config tweak, one obvious edit | No workspace, no workflows. Just do it (or say it doesn't need the pipeline). |
| Small | single-file-ish change, approach already clear | One inline scout (Explore agent), short plan in chat, implement inline; optional 1-round `review-loop` at the end. |
| Medium | multi-file, real unknowns, needs exploration | Full flow below. |
| Large / arch-open | new subsystem, cross-cutting, ambiguous requirements | Recommend `/dev-spec` first if no spec exists; then full flow. |

State your tier choice in one line; the developer can override ("treat as large").

## Process (medium/large)

1. **Collect the task brief.** From the invocation arguments and conversation: `task`, `scope`, `requirements`, `constraints`. If `task` is missing or so vague that scouts would wander, ask with AskUserQuestion (one round, max 2-3 questions). Reasonable inference beats interrogation.

2. **Workspace.** Reuse the `.dev/<slug>/` workspace if `/dev-spec` created one (then pass `specPath: <workspace>/spec.md`); otherwise derive the slug and create `.dev/<slug>/`. Always pass `workspace` as an absolute path. If `plan.md` already exists there, ask whether to overwrite or version. Update `.dev/state.json` (you are its only writer): `flows[<slug>] = { task, stage: "planning", updated }`. In a git repo, ensure `.dev/` is gitignored (suggest adding it).

3. **Run the exploration.**
   ```
   Workflow({ name: "devkit:explore-plan", args: { task, scope, requirements, constraints, workspace, specPath? } })
   ```
   Optional: `angles` to override angle decomposition when the developer already told you what to investigate; `validate: false` skips the single batched validation pass for cost-sensitive planning. If the workflow name does not resolve (the plugin has not loaded in this session yet), invoke with `scriptPath` pointing at `${CLAUDE_PLUGIN_ROOT}/workflows/explore-plan.js`. Runs in background; you'll be notified. While waiting, do nothing speculative.

4. **Interrupt point — open questions.** The result contains `open_questions` (decisions only the developer can make). If non-empty, surface them via AskUserQuestion (use the provided `options`). Fold answers into the plan: edit `<workspace>/plan.md` yourself — including the machine-readable JSON steps block — or, if an answer invalidates the approach, re-run the workflow with the answers appended to `constraints`.

5. **Present the plan.** Concise prose: the approach, the step list with dependencies/parallelism, risks, and what was dropped as refuted during validation (`dropped_claims`). Full detail is in `plan.md`; scout reports in `<workspace>/findings/`. Then stop — the developer reviews; apply their adjustments to the plan file (keep the JSON block in sync).

   Two per-step fields shape what implementation costs, so sanity-check them rather than passing them
   through: `risk` (`contract` earns an immediate review checkpoint) and `context_confidence`
   (`low` spawns an exploration agent for that step, `high` skips it). If every step came back `low`,
   the plan is admitting it is vague — worth a look before approval; if a step you know is
   hand-waved came back `high`, fix it.

   State the **wave shape** from the result's `waves` (e.g. "3 waves: s1+s2 → s3 → s4+s5"). Waves are
   the sequential spine of implementation, so a deep chain of single steps is worth challenging at
   approval time, not after: check whether each `depends_on` is a hard dependency (the other step's
   code must exist to compile/run/verify) rather than reading order, and propose flattening or merging
   when it isn't. The workflow logs a warning for a suspiciously deep chain — relay it if present.

6. **Handoff.** On approval, set the flow's stage to `plan-ready` in `.dev/state.json` and suggest `/dev-implement <slug>` (or continue yourself if asked).

## Notes

- The workspace is the shared memory: agents exchange *paths* into it, never raw dumps. Every file has exactly one writer. Don't let the chat summary drift from `plan.md`.
- If the repo is not a git repository, recommend `git init` before implementing — reviews and rollback need diffs.
