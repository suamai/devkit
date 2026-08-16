---
name: dev-plan
description: Triage and plan a development task, or turn a persisted PR review into an approved remediation plan; uses proportional exploration and batched validation.
argument-hint: <task description> | --review <review.md> [--deep]
---

You orchestrate the planning phase of a dev task. Fan-out work happens in the `wf-explore-plan` workflow; your job is the parts a background workflow cannot do — triage, gathering input, interrupting the developer with questions, and iterating the plan with them.

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
   Workflow({ name: "devkit:wf-plan-remediation", args: {
     reviewPath, workspace: remediationWorkspace,
     validate: true, deep
   } })
   ```
   Use `${CLAUDE_PLUGIN_ROOT}/workflows/wf-plan-remediation.js` as `scriptPath` if the name does not resolve. Cost args (`profile`/`models`/`efforts`) apply here too — see Cost below. `--deep` requests deeper integration inspection; it still uses one batched validator and
   one synthesizer, never the 3-5-scout `wf-explore-plan` fan-out. If batched revalidation returns
   `no_action: true`, report that all findings became refuted/stale and do not fabricate a plan.
4. **Plan contract.** Group findings by root cause and tightly coupled ownership — never one step per
   finding mechanically. Every step has `id`, `title`, `goal`, `files`, `depends_on` (hard
   dependencies only — they become sequential implementation waves), `details`, an executable
   `verify`, `risk` (`contract` | `local`), and `source_findings`. The markdown ends with the same machine-readable JSON
   steps block used by normal plans and names the source review + reviewed HEAD.
5. **Interrupt and approval.** Surface open questions, then present: groups/steps, dependencies,
   verification, dropped stale/refuted findings, and risks. Stop for explicit approval.
6. **Handoff.** On approval, suggest `/dev-implement <remediation-workspace>`. A remediation gets no
   state file of its own: it runs under the parent task's `state.json` (one lock, not two), the
   workspace on disk is the record, and `/dev-status` finds it by looking for
   `remediations/<sha>/plan.md`. Leave the parent's stage untouched.

Remediation mode is deliberately narrower than `wf-explore-plan`: the review already contains
adversarially verified code evidence. Its work is correction strategy, grouping, dependencies, and
proof commands.

## 0. Triage first — the burden of proof is on escalation

The full flow is not the safe choice. It spends 3-5 scouts, a validator, a synthesizer and an
approval round *before* anyone knows whether the change was one edit. Escalating later is cheap by
comparison: the small tier's inline scout becomes the plan's first input, not waste. So the low
tiers are the default, and the machinery has to be earned.

| Tier | When | Machinery |
|---|---|---|
| **Trivial** (default) | typo, rename, config tweak, one obvious edit | No workspace, no workflows. Just do it (or say it doesn't need the pipeline). |
| **Small** (default) | you can name the files and the approach | One inline scout (Explore agent), a five-line `plan.md` (next section), implement inline; optional 1-round `wf-review-loop` at the end. |
| Medium | a signal below fired | Full flow below. |
| Large / arch-open | `no-spec` fired | `/dev-spec` first, then the full flow. |

**Look before you triage.** One glob or grep costs less than any path out of this table, and it is
the whole difference between "I looked and cannot name the files" and "I have not looked yet". Only
the first is a signal.

**Escalate only on a named signal**, stated by name with the fact behind it. The list is closed —
"it seems complex", "to be thorough" and "just in case" are not on it:

| Signal | Means |
|---|---|
| `unknown-code` | You looked and still cannot name the files that must change, or the approach turns on how existing code behaves and you would be guessing. |
| `contract-change` | It alters a surface something else consumes: exported signature, DB schema, wire format, config key, CLI flag. |
| `independent-parts` | Three or more pieces with no hard ordering between them — sequential inline execution is the only reason it would be slow. |
| `needs-approval` | The developer has to sign off on the approach before code exists: expensive, risky, or hard to reverse. |
| `no-spec` (large) | New subsystem or cross-cutting change whose requirements are still open. |

State the tier in one line, and make it auditable in **both** directions — the absence of a signal is
also a claim you are making:

```
Tier: small — no escalation signal fired.
Tier: medium — unknown-code: retry policy lives somewhere under src/queue/ and the request doesn't
      say which layer owns it.
```

The developer can override either way ("treat as large", "just do it"). If the small tier's scout
comes back and a signal has fired after all, escalate then and name it — that is the bias working,
not a triage error.

## Small tier — implement inline, leave the intent behind

`/dev-pr` and `/dev-review` judge a diff against *intent*, and a small change is the one most likely
to reach a PR with nothing written down. So the small tier still writes two files before it starts:

`.dev/<slug>/plan.md` — five lines, no machine-readable steps block:

```markdown
# <task title>

**Tier:** small — no escalation signal fired
**Files:** src/queue/retry.ts
**Approach:** <what changes, and why this way rather than the obvious alternative>
**Verify:** <the command that proves it>
```

`.dev/<slug>/state.json` — `{ task, stage: "plan-ready", updated }`, so `/dev-status` sees the flow
at all and `/dev-pr` can find the intent. Set `stage: "implemented"` once the inline work is verified.

Two writes, no workflow, no approval round — that is the entire ceremony. Don't let it grow: a
small-tier `plan.md` that wants a steps block was a medium task, and the honest move is to name the
signal and escalate.

## Process (medium/large)

1. **Collect the task brief.** From the invocation arguments and conversation: `task`, `scope`, `requirements`, `constraints`. If `task` is missing or so vague that scouts would wander, ask with AskUserQuestion (one round, max 2-3 questions). Reasonable inference beats interrogation.

2. **Workspace.** Reuse the `.dev/<slug>/` workspace if `/dev-spec` created one (then pass `specPath: <workspace>/spec.md`); otherwise derive the slug and create `.dev/<slug>/`. Always pass `workspace` as an absolute path. If `plan.md` already exists there, ask whether to overwrite or version. Write `<workspace>/state.json`: `{ task, stage: "planning", updated }`, merging with whatever `/dev-spec` left there. In a git repo, ensure `.dev/` is gitignored (suggest adding it).

3. **Run the exploration.**
   ```
   Workflow({ name: "devkit:wf-explore-plan", args: { task, scope, requirements, constraints, workspace, specPath? } })
   ```
   Optional: `angles` to override angle decomposition when the developer already told you what to investigate; `validate: false` skips the single batched validation pass for cost-sensitive planning; `profile`/`models`/`efforts` set the model tiers (see Cost below). If the workflow name does not resolve (the plugin has not loaded in this session yet), invoke with `scriptPath` pointing at `${CLAUDE_PLUGIN_ROOT}/workflows/wf-explore-plan.js`. Runs in background; you'll be notified. While waiting, do nothing speculative.

4. **Interrupt point — open questions.** The result contains `open_questions` (decisions only the developer can make). If non-empty, surface them via AskUserQuestion (use the provided `options`). Fold answers into the plan: edit `<workspace>/plan.md` yourself — including the machine-readable JSON steps block — or, if an answer invalidates the approach, re-run the workflow with the answers appended to `constraints`.

5. **Lint the plan before presenting it.** Zero agents, zero tokens, one call:
   ```
   Workflow({ name: "devkit:wf-implement", args: { dryRun: true, steps, rules } })
   ```
   It returns `schedule`: the dependency waves, which steps *actually* run in parallel
   (`parallel_groups` — only disjoint declared files do), which get a scout, which repo rules match,
   where review checkpoints would fire and why, `warnings`, and `agents_min`. Fix what it finds
   before the developer sees the plan; a plan that lints badly is cheaper to fix now than after an
   implement run. Two `warnings` are worth acting on rather than reporting: steps with overlapping
   files and no dependency (they cost the parallelism the plan appears to have), and a step with no
   `verify` (it can only ever come back `unverified`).

   The projection errs in one direction: checkpoints can fire **earlier** than shown, never later,
   because a blocking question or a contract-gate break also forces one and neither is knowable
   before the agents run. Same for `agents_min` — a floor, not an estimate.

6. **Present the plan.** Concise prose: the approach, the step list with dependencies/parallelism, risks, and what was dropped as refuted during validation (`dropped_claims`). Full detail is in `plan.md`; scout reports in `<workspace>/findings/`. Then stop — the developer reviews; apply their adjustments to the plan file (keep the JSON block in sync).

   Two per-step fields shape what implementation costs, so sanity-check them rather than passing them
   through: `risk` (`contract` earns an immediate review checkpoint) and `context_confidence`
   (`low` spawns an exploration agent for that step, `high` skips it). If every step came back `low`,
   the plan is admitting it is vague — worth a look before approval; if a step you know is
   hand-waved came back `high`, fix it.

   State the **wave shape** from the lint's `schedule` (e.g. "3 waves: s1+s2 → s3 → s4+s5"). Waves are
   the sequential spine of implementation, so a deep chain of single steps is worth challenging at
   approval time, not after: check whether each `depends_on` is a hard dependency (the other step's
   code must exist to compile/run/verify) rather than reading order, and propose flattening or merging
   when it isn't. The workflow logs a warning for a suspiciously deep chain — relay it if present.

7. **Handoff.** On approval, set `stage: "plan-ready"` in `<workspace>/state.json` and suggest `/dev-implement <slug>` (or continue yourself if asked).

## Cost

Every workflow takes the same three cost args, and every skill passes them through:
`profile: "cheap" | "default" | "max"` shifts every agent one rung on the model ladder;
`models: { <role>: "haiku|sonnet|opus" }` and `efforts: { <role>: "low|…|max" }` override one role
and beat the profile. Roles are pipeline-wide (`decompose, scout, validate, synth, impl, gate,
check, review, verify, fix`), so one object covers a workflow and everything it calls. An unknown
role or value throws before any agent runs — check it with `dryRun: true`, which returns the
resolved policy. Omitting all three reproduces the shipped tiers exactly. Default it from the
repo's `Cost profile:` line in CLAUDE.md when one is present.

## Notes

- The workspace is the shared memory: agents exchange *paths* into it, never raw dumps. Every file has exactly one writer. Don't let the chat summary drift from `plan.md`.
- If the repo is not a git repository, recommend `git init` before implementing — reviews and rollback need diffs.
