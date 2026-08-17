---
name: dev-plan
description: Triage and plan a development task — proportional exploration, batched validation of load-bearing claims, and a plan you approve before any code is written.
argument-hint: <task description> | --explain <question>
---

You orchestrate the planning phase of a dev task. Fan-out work happens in the `wf-explore-plan` workflow; your job is the parts a background workflow cannot do — triage, gathering input, interrupting the developer with questions, and iterating the plan with them.

## Understanding mode — `/dev-plan --explain <question>`

Same exploration, same validation, different synthesizer: it writes `<workspace>/understanding.md`
(answer, how it works, where to start reading, what would surprise you, **what is provably not
true**) instead of `plan.md`, and returns no steps.

**Route a bare question away from here.** "How does X work?" is what the built-in `Explore` agent is
for, at a fraction of the cost, and answering it with a five-scout fan-out is the same mistake as
triaging a typo as medium. This mode is not for answering a question — it is for **exploring a
subsystem you are about to plan work in**, where the point is the durable artifacts:
`findings/<angle>.md` are adversarially validated, and the `findings` array it returns lets the
`/dev-plan` that follows skip re-exploring the same ground.

So the test before using it: *will something consume these findings afterwards?* If no, use
`Explore`. If yes, say so in one line, run it, and store the returned `findings` in
`<workspace>/state.json` for the plan run that follows.

The one thing it produces that nothing cheaper can is the `Not true` section: a lone agent can tell
you how something works, but only a run that put its claims through adversarial validation can tell
you which plausible belief about this code is provably false. Lead the report with that and with
`surprises` — the confirmatory parts are the parts the developer could have gotten anywhere.

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
   Workflow({ name: "devkit:wf-explore-plan", args: { task, scope, requirements, constraints, workspace, specPath?, priorFindings? } })
   ```
   `priorFindings`: if `<workspace>/state.json` carries a `findings` array from an earlier run here
   (an `--explain` pass, or a plan you are redoing), pass it. Angles it already covers are not
   re-explored — often the difference between five scouts and one. It does **not** skip validation:
   the old findings go through the same adversarial pass, so anything that went stale gets refuted
   rather than trusted, which is why no staleness check is needed on top.

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

6. **Present the plan.** Lead with the exploration's `cost` (`by_phase`: decompose / explore /
   validate / synthesize, plus `total`) — it is the developer's calibration data and it is what makes
   the next `angles`/`validate: false` decision an informed one. Then concise prose: the approach, the step list with dependencies/parallelism, risks, and what was dropped as refuted during validation (`dropped_claims`). Full detail is in `plan.md`; scout reports in `<workspace>/findings/`. Then stop — the developer reviews; apply their adjustments to the plan file (keep the JSON block in sync).

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

7. **Handoff.** On approval, set `stage: "plan-ready"` in `<workspace>/state.json`, and store the
   result's `findings` array there too — that is what makes a later run in this workspace skip
   re-exploring. Then suggest `/dev-implement <slug>` (or continue yourself if asked).

## Cost

Every workflow takes the same three cost args, and every skill passes them through:
`profile: "cheap" | "default" | "max"` shifts every agent one rung on the model ladder;
`models: { <role>: "haiku|sonnet|opus" }` and `efforts: { <role>: "low|…|max" }` override one role
and beat the profile. Roles are pipeline-wide (`decompose, scout, validate, synth, impl, gate,
check, review, verify, fix`), so one object covers a workflow and everything it calls. An unknown
role or value throws before any agent runs — check it with `dryRun: true`, which returns the
resolved policy. Omitting all three reproduces the shipped tiers exactly. Default it from the
repo's `Cost profile:` line in CLAUDE.md when one is present.

## Artifact language

If `CLAUDE.md` carries an `Artifact language: <language>.` line, pass `language: "<language>"` to
`wf-explore-plan` and write `plan.md` in that language when you edit it yourself — including the
small tier's five-line file. No line means today's behavior: the artifact follows the conversation.

It binds prose only. Step ids, file paths, `verify` commands, config keys and quoted code stay
exactly as they appear in the repo, because `/dev-implement` follows them literally — a translated
`verify` is a command that does not run. The machine-readable JSON steps block keeps its English
field names for the same reason; only the values are prose.

## Notes

- The workspace is the shared memory: agents exchange *paths* into it, never raw dumps. Every file has exactly one writer. Don't let the chat summary drift from `plan.md`.
- If the repo is not a git repository, recommend `git init` before implementing — reviews and rollback need diffs.
