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
   `Workflow({ name: "devkit:wf-implement", args: { dryRun: true, steps, rules, criteria } })`
   returns the schedule this run would follow (waves, real parallel groups, scouts, matched rules, projected
   checkpoints) plus `warnings` and an `agents_min` floor. A chain of mostly single steps, steps
   with overlapping files and no dependency, a step with no `verify`, or several steps declaring the
   **same** `verify` string all show up there; depth is the main driver of wall-clock, so offer to
   flatten before running. The last of those is about evidence rather than scheduling: one shared
   command was already green before every step that named it but the first, so the rest come back
   `weak_evidence` (step 6) — a step whose goal *adds* behavior needs a check of its own.

   `criteria` is the spec's canonical acceptance-criterion ids, and **you** extract them: a workflow
   script has no filesystem access, the same reason `rules` arrives pre-extracted. This skill is its
   own entry point — never assume `/dev-plan` ran and already passed them. In document order and
   **not** deduplicated, because a spec that declares one id twice is exactly what the duplicate
   warning is for:
   ```bash
   grep -oE '^[[:space:]]*[-*][[:space:]]*(\*\*)?AC-[0-9]+' "<workspace>/spec.md" | grep -oE 'AC-[0-9]+'
   ```
   No `spec.md`, or no ids in it → pass nothing and say so; never fabricate a list. With the ids in
   hand the same zero-agent projection also reports the coverage warnings against each step's optional
   `covers` array: an id no spec declares, an id declared twice, and a criterion no step covers. The
   first two are plan defects — fix them before running. The third is the developer's call, because a
   suite-level check is a legitimate cover: report it, never invent a `covers` entry to silence it.
   Fix obvious gaps in the plan file; ask only for judgment calls. If the plan wasn't approved in this conversation, show a one-paragraph summary
   and get explicit go-ahead — this phase edits many files.

5. **Update state and run.** Set `stage: "implementing"` with `baseline` and `updated` in the
   workspace's `state.json`; it returns to `implemented` in step 8. Then:
   ```
   Workflow({ name: "devkit:wf-implement", args: { workspace, steps, baseline, notes, reviewLoopPath, rules, criteria } })
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
   `criteria`: the same ids step 4 extracted, by the same command (extract them here if step 4 was
   skipped) — the run needs them to compute the acceptance gate and the coverage matrix. Passing none
   is not a failure: it yields `acceptance: "n/a"`, and a plan with no spec behaves exactly as before.
   `notes`: anything the developer said since the plan was written. `reviewLoopPath`:
   `${CLAUDE_PLUGIN_ROOT}/workflows/wf-review-loop.js`. Optional: `review: false`,
   `reviewRounds: N` (default 3 — rounds after the first are one targeted agent, so this is cheaper
   than it looks), `scoutMode: "always" | "adaptive" | "never"` (default adaptive: the plan's
   `context_confidence` decides, heuristic as fallback), `maxParallelSteps` (default 5), `gate: false`,
   `checkpointFileThreshold` (default 20), `checkpointMaxWaves` (default 3); `profile`/`models`/`efforts` (see Cost below — `impl` runs once per step and is the pipeline's largest single cost).

   A review checkpoint applies fixes, so it also hands the review loop the `verify` commands of the
   steps it covers — deduplicated, joined with `&&` — as that loop's `verifyCommand`. The fixes a
   checkpoint applies are therefore **executed**, not merely re-read: the loop cannot report clean over
   a tree whose own steps' checks stopped passing, and a failure blocks the run (step 6). Steps that
   declare no `verify` hand down nothing to run, which is one more reason step 4's lint matters. Nobody
   passes this arg: it comes from the plan, and `dryRun: true` shows the exact command each projected
   checkpoint would use.

   Waves stay sequential (that's `depends_on`), but review is **not** per wave: waves accumulate into
   a review checkpoint, and each wave in between gets one cheap contract gate. To restore per-wave
   review — the developer asks for it, or the work is unusually contract-heavy — pass
   `checkpointFileThreshold: 1, checkpointMaxWaves: 1`. If the workflow name does not resolve (the plugin has not loaded in this session yet), invoke
   with `scriptPath` pointing at `${CLAUDE_PLUGIN_ROOT}/workflows/wf-implement.js`. Record the returned run id as
   `lastRunId` in the workspace's `state.json` — it enables resume.

6. **On completion, persist and read the result.** First write `<workspace>/last-run.json`
   (`{ runId, stoppedEarly, stopReason, delivery_verdict, gates, reasons, coverage, args, continuation }`)
   — without it a continuation in a later session has no steps array and no completion map. `coverage`
   is the **only** copy of the acceptance matrix `/dev-pr` renders later: the workflow computes it and
   returns it, nothing else stores it, and `/dev-status archive <slug>` deletes this file. After an
   archive the verdict still survives — step 8 puts it in `state.json` — and the matrix does not, which
   is why `/dev-pr` then reports its check and outcome columns as unavailable instead of rebuilding
   them from prose. Then:
   - `needs_user_input` with `blocking: true` → the run **stopped there on purpose**: an implementer
     guessed at something that changes its step's approach, and dependent waves were not built on the
     guess. Ask these first (AskUserQuestion, include the recorded `assumption` as context). If the
     answer matches the assumption, continue the run (see below); if it does not, the step needs rework
     before anything downstream runs. Non-blocking questions are informational — resolve them inline.
   - Every step report carries a **typed** verification outcome the script derived — not a boolean:
     `status: passed | failed | not-run | infra-error`, plus `kind: new-test | existing-suite | manual`
     when a check ran, `attempts` (2 when an infrastructure failure bought its one re-run) and
     `verify_command`. `ran`/`command`/`passed` are still what the implementer reports and still the
     arbiter; `infra-error` is the one thing the reply's shape cannot reveal, so it is *claimed* — and
     only honored when the claim names both the command and the failure it observed. The four bullets
     below are the run-level counts of that type.
   - `unverifiedSteps` non-empty → those steps have no substantiated executable check. Their
     behavior rests on the checkpoint reviews and the suite. Verify them yourself now — that is step 7
     — and never report them as verified. `reason` distinguishes three different situations, and they
     are worth reporting differently: an honest one (the implementer set `ran: false` and explained why
     no check was possible); a claimed-but-unevidenced one ("claimed ran=true without naming the
     command it ran" / "…without reporting whether the check passed"); and an infrastructure one ("the
     check could not run (infrastructure): …", the next bullet). The second means an implementer
     asserted verification it did not substantiate — mention it, it is a prompt-calibration signal the
     register expects to be zero. The third is nobody's defect.
   - `infraErrors` non-empty → the check could not run for reasons unrelated to the code: a missing
     toolchain, a registry outage, a service that would not start. Each was retried **once** (`attempts`
     is 2 once that re-run was paid for, even if the agent came back empty and the first claim stands —
     the same counting `wf-review-loop`'s `fix_verify.attempts` uses), and an infrastructure failure is
     **not** a defect — it did not
     fail the step and it did not stop the dependent waves. Those steps are unverified all the same, so
     they are exactly the ones to give a real check in step 7. A step that claimed `infra-error` without
     naming the command *and* the failure it observed is deliberately reported as a **failed** step
     instead: the one claim the script cannot check is the one that has to come with evidence. Report
     what the retry did: it may re-run the environment step the first attempt named (`npm ci`, starting
     a service, restoring a dependency) and it names every such command, so a reader can see that the
     environment moved under later steps — it may never edit tracked files, because a fix that needs a
     source change is a defect, not a blip.
   - `weakEvidenceSteps` non-empty → those steps passed, and are verified, but only by a check that was
     **already green** before them (`kind: existing-suite`). They stay verified on purpose: a
     refactor's whole point is that the suite still passes, and degrading that to unverified would make
     the one honest answer the most expensive one to give. They are a red flag exactly when the step's
     goal was to *add* behavior — then the command proves it broke nothing and nothing more. The
     checkpoint reviewer already received them as priority targets; read the goal before deciding which
     case each one is.
   - `kindMissing` non-empty → steps that passed but declared no `kind` at all. Not a defect, not weak
     evidence, and never a gate: `kind` fails open on purpose. It is the calibration signal for a new
     field, expected to trend to zero the way the unevidenced-claim count is — a number to watch, not
     something to act on.
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
   - `checkpointReviews[].review.fix_verify` → that checkpoint's post-fix check: the command it ran,
     whether it passed, or the honest reason it did not run. A check that **ran and did not clear** is a
     **different** stop cause from an unaddressed finding, and worth reporting as such: every finding may
     have been fixed and the tree still stopped working under those fixes, so the run blocked there.
     Two shapes reach that: `failed: true` (the command came back red) and a claim to have run that
     substantiated no pass (`unverified`) — report which, because the second proved nothing *and* cost
     the round its re-review, so nothing judged that tree. `ran: false` with a reason is the opt-out and
     does not block. Absent means the checkpoint's review never applied a fix, so there was nothing to
     check — not that a check passed.
   - `contractGates[].breaks` → gates that fired. High/critical ones already forced a checkpoint;
     low/medium ones were informational and the checkpoint review should have covered them — if one
     survived into `finalCheck.issues`, mention it, it means the gate is more accurate than the review.
   - `finalCheck.issues` high/critical with `fixed: false` → fix inline or run `wf-review-loop` scoped to the affected files (pass the same `baseline`).
   - `stoppedEarly: true` → **run the repo's own check yourself, here, before you report.** A stopped
     run leaves real code in the tree that nothing has executed as a whole, and "we stopped" is not an
     answer to "does what you left me still build?". One Bash call, zero agents. Take the command from
     what the repo itself documents — `CLAUDE.md`, the README, the runner it ships — and do not invent
     one or assemble a plausible-looking command out of `package.json`; that is the same rule
     `/dev-review` states for its `verifyCommand`. If the repo documents no check, say *that* — an
     honest "this repo documents no suite" is a result; a guess is not. `finalCheck.suite_run` does not
     substitute for this: on a stopped run the script fabricated it with nothing behind it, so restating
     it as a result would be reporting a check that never happened.
   - `delivery_verdict: 'blocked'` → tell the developer, once: call the **`PushNotification`** tool
     (`{ message, status: "proactive" }`, one line, ≤200 chars, no markdown). Key it on the verdict, not
     on `stoppedEarly`: a stopped run always blocks too, through whichever gate the stop actually came
     from (`scope` for a genuinely incomplete wave or step, `review` or `questions` for a checkpoint
     block or a blocking question on an otherwise fully-implemented, fully-reviewed last wave) — but so
     does a run that finished all its waves and still blocked — on `finalCheck.issues`, a checkpoint
     review, or another gate — so `stoppedEarly` alone would miss that second case entirely.
     Compose the message from what actually happened: `implement <slug> stopped: <stopReason>` when
     `stoppedEarly` is true (`stopReason` can itself be long — a blocked wave joins every concurrently
     blocked step's `id:stage`); otherwise `implement <slug> blocked: <reasons[0]>`, the run's own first
     reason. Either way, if the composed message would run past 200 characters, truncate the variable
     part and keep the `<slug>` and its verb ("stopped"/"blocked") intact — that is what tells the
     developer where to look. It is a deferred tool — if it is not in the current tool set, `ToolSearch`
     for it first. There is still only one condition to test and no way to fire one ping per question: a
     blocking question forces the checkpoint flush before the verdict is computed. A `not sent` result
     means the developer is at the terminal — expected, not an error, never retried. This is not the
     automatic ping a finished background workflow already sends: that one says the run ended, this one
     says *why it needs attention* and names it.

7. **Verify end-to-end.** Per-step `verify_run` and `suite_run` already executed checks; re-run
   anything that failed after your fixes, and exercise the changed flow if the project has a runtime
   surface (the built-in `/run` skill launches it). Give `unverifiedSteps` an actual check here — they
   are the only steps whose behavior nothing has executed, and `infraErrors` are among them — their
   check never ran, and a re-run that hit the same outage did not change that. A checkpoint's
   `fix_verify` narrows this but
   does not replace it: it ran the commands of the steps that checkpoint reviewed, on the tree as it
   stood then — never the composition, and never the waves a later checkpoint covered. The whole change
   is still `suite_run`'s job — and when the run stopped before reaching it, step 6's `stoppedEarly`
   bullet is where that check already happened, so what is left here is the per-step gap, not the tree.

8. **Phase commit.** `impl(<slug>): <plan title>`, with the standard co-author trailer; using this
   skill opts into phase commits unless the developer said otherwise. Then set `stage: "implemented"`
   in the workspace's `state.json`, and **append** one compact entry to its `runs` array —
   `{ phase: "implement", ts, run_id, delivery_verdict, agents_projected, steps_leaf, rounds,
   confirmed, applied, unverified, cost_total, floors_active, stopped, stop_reason }` (`ts` is plain
   `YYYY-MM-DD HH:MM`, matching `updated`), the same numbers step 9's ledger line carries (`rounds` is
   its `review_rounds`, `unverified` is `unverifiedSteps.length`,
   `cost_total`/`floors_active` come from `cost`). `delivery_verdict` is the returned verdict string
   verbatim — a plain string, since this file carries no structure of its own — and it is the part of
   the evidence chain that outlives `last-run.json`. Append it; never rewrite an earlier entry, and merge
   into whatever the earlier phases left in that file. This is the copy that survives when the ledger
   does not — `/dev-status archive <slug>` keeps `state.json` and deletes the bulk.

   **A stopped run appends this entry too.** There is no commit and `stage` stays `implementing` —
   the flow is resumable and the SessionStart stale-flow hook depends on that stage — but the entry
   is still written, with `stopped: true` and `stop_reason`. Those two fields exist for exactly this
   case: the run that stopped is the one whose numbers matter most, and a `runs` array holding only
   the runs that finished well would bias the surviving copy the same way `clean` biases the
   workspaces. Write the entry, leave the stage alone, and say in the report that you did.

9. **Report.** Lead with the verdict the run computed for itself —
   `delivery_verdict: ready | ready-with-unverified | blocked` — then `reasons`, one line per gate
   that is not clean, naming the gate and the evidence behind it. Under that, `gates` as one compact
   line: `acceptance`, `tests`, `review`, `questions`, `scope`, each with its own value. Restate a
   gate exactly as it is labelled and never as something stronger: `tests: not-run` is not "the tests
   pass", `acceptance` at `n/a` is not "the criteria are met", and `ready-with-unverified` is not
   "ready". The verdict is computed in plain JS from this run's own structured outputs — verification
   statuses, review findings, blocking questions, coverage, the waves that were reached — and no agent
   asserts it anywhere; that is why it leads, and why it can be read as a fact about the run rather
   than a claim the reader has to check.
   Then `cost`: `by_phase` (`steps` = scouting + implementation, which cannot be
   split further because parallel steps interleave; `gate`; `review`; `check`) and `total`. If
   `floors_active` is false, say so once — the budget floors that skip steps and stop review rounds
   were inert, because they only exist when the developer put a "+300k"-style target in their own
   message. Then per step: what changed, verification result, deviations and why. Report
   `implementation_failed`, `result_serialization_failed`, and `agent_failed_unknown` distinctly.
   Then, per checkpoint, which waves it covered and its rounds/fixes (`checkpointReviews[].reason`
   says why it fired); contract gates that found breaks; consistency check, commit hash, and
   concerns. State `unverifiedSteps` explicitly — "N steps have no substantiated check of their
   own", with the honest/unevidenced/infrastructure split from step 6 — and state `weakEvidenceSteps`,
   `infraErrors` and `kindMissing` as their own counts beside it, because none of the three is the same
   claim: verified-but-only-by-an-already-green-check, could-not-run-and-is-not-a-defect, and a
   calibration number nobody acts on. A run that stopped early is `blocked` by construction, and its
   `stopReason` usually reads straight out of `reasons` too — `scope` names it verbatim when a wave or
   step is genuinely incomplete; a stop from a checkpoint block or a blocking question on an otherwise
   complete last wave instead reads through `review`'s or `questions`' own reason, which names the same
   fact in the gate's own words rather than repeating the raw `stopReason` string. Either way it needs
   no second competing lead: name it in the same breath as the verdict rather than burying it under the
   per-step detail, and put step 6's own suite result right next to it — whether the tree this run
   leaves behind still builds, or the honest reason that could not be established.
   If the run stopped early, do **not** phase-commit and report as done — say what stopped it and
   offer the continuation below.

   Then append this run to the ledger — one line, once per invocation, after the report and (when
   there was one) the phase commit. A run that stopped early writes its line too: no phase commit
   happened, and `stopped`/`stop_reason` below exist precisely to record that. Skipping it would make
   the ledger a record of runs that finished well, which is the bias the store was chosen to avoid.
   A `--continue` run is its own phase run: it writes its **own** line and never amends the
   previous one.

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/ledger-append.sh" <<'JSON'
{"phase":"implement","slug":"<slug>","tier":"medium","run_id":"<lastRunId>","baseline":"<baseline>","waves":3,"parallel_groups":1,"steps_leaf":7,"splits":0,"scouts_ran":2,"gates":2,"gate_breaks":0,"checkpoints":2,"review_rounds":3,"agents_projected":19,"unreviewed_waves":0,"stopped":false,"delivery_verdict":"ready","concurrent":false,"findings":{"raw_titles":14,"clusters":9,"confirmed":5,"refuted":4,"applied":5,"skipped":0},"verification":{"steps":7,"passed":6,"unverified_honest":1,"unverified_unevidenced":0,"unverified_infra":0,"weak_evidence":2,"kind_missing":0},"cost":{"by_phase":{"steps":180000,"gate":9000,"review":120000,"check":11000},"total":320000,"budget_total":null,"floors_active":false}}
JSON
```

   Both the command and the closing `JSON` start at column 0 on purpose: an indented terminator does
   not close a quoted heredoc, and the script then sees a two-line body and refuses it.

   The envelope is the script's half and the shared vocabulary is in `docs/architecture.md` → "The run
   ledger"; every number below comes off *this* run's result, and anything you do not have is omitted
   rather than guessed:
   - `tier` = the tier the plan was triaged at, not a judgement you make here: read it from the
     workspace's own `runs` array (the latest `plan` entry — every tier writes one, small included, so
     this is the only source step 9 ever needs). It is carried over because comparability is phase +
     tier + profile, and `/dev-plan`'s quote (`--phase implement --tier <t>`) matches strictly — a
     line missing the field it is filtered on never matches, so dropping `tier` here would leave that
     quote reading `n=0` forever. If the workspace has no `runs` entry for this plan, omit it, like any
     other field you do not have.
   - `waves` = `result.waves.length`; `parallel_groups` = the groups of more than one step in step 4's
     lint (`schedule.waves[].parallel_groups`); `agents_projected` = that same lint's `agents_min`
   - `steps_leaf` = the leaf reports (a `split: true` report is the parent of its `substeps` — count
     the substeps, not it); `splits` = the reports with `split: true`
   - `scouts_ran` = `ls <workspace>/briefs | wc -l`: only scouts that actually ran leave a brief
   - `gates` = `contractGates.length`; `gate_breaks` = the total of `contractGates[].breaks.length`
   - `checkpoints` = `checkpointReviews.length`; `review_rounds` = the sum of
     `checkpointReviews[].review.rounds`
   - `findings` sums `checkpointReviews[].review` across checkpoints: `confirmed`/`refuted`/`applied`/
     `skipped` are those arrays' lengths, `raw_titles` sums `review.raw` and `clusters` sums
     `review.clustered` — the review loop's own scalars, stored verbatim under each checkpoint. Never
     reconstruct either from `merged_titles`: that count silently omits every raw finding the verifier
     dropped without clustering. A review object carrying neither field (an older run) omits **both**
     rather than substituting a derivation.
   - `verification` restates step 6's own counts: `steps` = `steps_leaf`, `passed` = the leaf reports
     whose verification status is `passed`, and the three unverified reasons split exactly as step 6
     splits them, partitioning `unverifiedSteps` with no overlap — `unverified_infra` =
     `infraErrors.length` (an infra-error step is a member of `unverifiedSteps` too, since it sets
     `unverified: true`); `unverified_unevidenced` = the *remaining* `unverifiedSteps` whose reason
     begins "claimed ran=true…"; `unverified_honest` = whatever is left of `unverifiedSteps` after
     removing both of those — never just "the rest" of the unevidenced split alone, or every
     infra-error step gets counted twice. `weak_evidence` = `weakEvidenceSteps.length`, `kind_missing`
     = `kindMissing.length`
   - `delivery_verdict` = the returned verdict string, verbatim. It is top-level and string-valued,
     which is what the ledger's shape allows; the `gates` object stays out of the line entirely, since
     only `cost`, `findings` and `verification` may nest — and the `gates` number already in the line
     is the count of contract gates, a different thing that happens to share the name. `reasons` stays
     out too: it is prose for the report, not a comparable field.
   - `unreviewed_waves` = `unreviewedWaves.length`; `stopped`/`stop_reason` from `stoppedEarly` and
     `stopReason`; `cost` **verbatim**; `run_id` = the `lastRunId` you already recorded; `baseline` =
     the one step 3 captured
   - `concurrent`: step 2 already looked — `false` when that glob and TaskList found nothing, `true`
     when they found a live run, `"unknown"` when the check did not happen. Never a guessed `false`:
     overlapping runs inflate `cost.by_phase` and this field is the only thing that says so.

   The ledger is telemetry for a later report, never a gate. If the append fails, say so in one
   sentence and finish; never fail the phase over it, and never read the file back.

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
