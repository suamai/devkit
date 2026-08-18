---
name: dev-implement
description: Execute an approved plan from /dev-plan — adaptive context scouting, verified implementation, a cheap contract gate per dependency wave, and consolidated review at cost-driven checkpoints.
argument-hint: <slug, workspace, or plan.md> [--continue] [--isolated] [extra notes]
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

   **`--isolated`** runs this one flow inside a dedicated git worktree: step 3 creates it, every
   agent the run spawns works in it, and step 10 presents the finished diff before anything reaches
   the developer's primary checkout. It changes nothing else here — a run without the flag behaves
   exactly as it does today, down to the args passed and the ledger line written. Two rules about the
   flag itself:
   - **Never retype it on a continuation.** With `--continue`, isolation is re-derived from the
     workspace's `state.json`: a `worktree` field means this flow is isolated whether or not the flag
     was typed, and no `worktree` field means it is not, whether or not it was. A continuation that
     silently fell back to the primary checkout would split one flow across two trees, half its
     commits somewhere the other half cannot see.
   - **Refuse it on a flow that already has non-isolated work.** If `state.json` carries a
     `baseline` — set the moment any earlier implement began, in step 5 below — and carries no
     `worktree`, say so and stop instead of creating a worktree at today's baseline. Check `baseline`
     itself, not a `runs` entry or `stage: implemented`: a crash before step 8's bookkeeping runs can
     leave `stage` stuck at `implementing`, or at `abandoned` after the concurrency lock's own offer
     to mark it so, with no `runs` entry for the attempt ever appended — `baseline` with no `worktree`
     is what survives either way. There is nothing to retro-isolate: that work is already in the
     primary checkout, and the honest offer is to finish or discard it first.

2. **Concurrency lock.** Glob `.dev/*/state.json` and read them: any workspace at `implementing` is
   the repo-wide lock. Check whether it is live (running workflow task, recent `updated`). Live →
   stop: one implement per repo at a time because verifications share the working tree. Stale →
   offer to mark it abandoned and proceed.

   `--isolated` changes nothing in this step, deliberately: an isolated flow's workspace still lives
   at `.dev/<slug>/` in the primary checkout, so this glob still finds it and it still holds the
   repo-wide lock. Isolation moves where the code is edited, not where the flow is recorded. And
   nothing here relaxes the lock — one worktree per flow is what would eventually make relaxing it
   thinkable, but two implements at once is still not a supported state and this step still refuses
   it.

3. **Git preflight.** This phase requires a git repo (offer `git init` otherwise). If on the default
   branch, create and switch to `dev/<slug>`. Ensure `.dev/` is gitignored. Capture the baseline —
   reviewers judge diffs since it.

   **`dev/<slug>` is not always creatable, and this is where that bites first.** Git stores a branch
   as a file under `refs/heads/`, so a repository that already has a branch named `dev` can hold
   nothing under `refs/heads/dev/` — `git checkout -b dev/<slug>` then fails with
   `fatal: cannot lock ref 'refs/heads/dev/<slug>': 'refs/heads/dev' exists` (exit 128). A `main` +
   `dev` pair is an ordinary layout, not an exotic one, so check before you create: if
   `git show-ref --verify --quiet refs/heads/dev` succeeds, the prefixed name is impossible. Use the
   flat `<slug>-iso` instead — the same name `scripts/worktree.sh` defaults to, so one slug reads the
   same whichever path created it — and say in one line which name you used and why. Never retry the
   failing command, and never silently implement onto the default branch because the branch step
   failed: that is how the change ends up committed somewhere nobody chose.

   **Under `--isolated`, and only then, this preflight branches.** Everything above still happens
   except one line, and the order matters: capture the baseline **first**, from the primary checkout,
   exactly as above — it is the base ref the worktree is created at, which is what makes
   `git diff <baseline>` mean the same thing to every agent in the run. Then, in order:

   - **Skip the primary-side branch.** Do not create or switch to `dev/<slug>` here: the worktree is
     about to own that branch, and `git checkout -b dev/<slug>` afterwards fails with `fatal: a
     branch named 'dev/<slug>' already exists` (exit 128). An isolated run leaves the primary
     checkout on whatever branch the developer left it on, clean or dirty. That is the point.
   - **Snapshot the primary checkout**, for the assertion step 10 makes before anything is
     integrated: `git status --porcelain | git hash-object --stdin` and `git rev-parse HEAD`. Keep
     both strings, and the primary's own path (`git rev-parse --show-toplevel`, referred to below as
     `<primary>`). Nothing else records them, and they are the only evidence that this run did not
     edit the developer's tree behind its own back.
   - **Create the worktree**, with the cwd in the primary checkout:
     ```bash
     sh "${CLAUDE_PLUGIN_ROOT}/scripts/worktree.sh" setup <slug> <baseline>
     ```
     It creates the worktree at `.dev/<slug>/worktree`, inside the flow's own gitignored workspace so
     the primary checkout's `git status` never sees it, and prints one JSON line — `path`, `branch`,
     `baseline` (the resolved full sha), `setup_ms`, `disk_kb`. It refuses rather than improvising:
     exit 2 with one stderr line when a precondition fails and nothing was created, exit 3 when git
     itself refused. Its default branch name is `dev/<slug>`, and **that name is not always
     available**.
     Two different conflicts both come back as exit 2 and they need different answers: an earlier run
     already holds `dev/<slug>` → re-run with `dev/<slug>-iso` as the explicit `[branch]` argument;
     git cannot create any `dev/…` branch at all because `refs/heads/dev` exists as a file, which is
     every repo whose own default branch is named `dev` → `dev/<slug>-iso` fails identically, so pass
     the flat name the script itself suggests, `<slug>-iso`, with no `dev/` prefix at all. Read which
     conflict the script named, take the branch name out of its message, and pass it explicitly:
     ```bash
     sh "${CLAUDE_PLUGIN_ROOT}/scripts/worktree.sh" setup <slug> <baseline> <branch>
     ```
     Never guess a third name after a second refusal — ask. The absolute `path` it prints is the
     worktree's root, written `<root>` everywhere below.
   - **Record it in `state.json`.** Write `worktree` (that absolute `path`) and
     `worktree_branch` (its `branch`) into the workspace's `state.json`, as top-level strings — flat,
     because `/dev-status` and the SessionStart stale-flow hook read them with a `sed`-based
     top-level-string reader and nothing else. `worktree_branch` is recorded rather than derived
     precisely because the name may not be the default one. Keep `setup_ms` and `disk_kb` in hand for
     step 9's ledger line; nothing else stores those.
   - **The freshness gate below is unchanged**, and on an isolated run it runs against the worktree
     (`git -C "<root>" …`) — the tree this run is about to implement into. Its `HEAD` is the baseline
     the primary just reported and its working tree is clean by construction, so the gate's four
     branches read exactly as they do in the primary. The one difference is uncommitted work in the
     primary: it is not in the tree this run implements into, so it is not a freshness signal here —
     but if any of it touches a path a step declares in its `files`, say so in one line, because that
     is what step 10's merge would collide with.

   **Then the freshness gate, here, before any agent exists.** The workspace's `state.json` carries a
   `plan_freshness` object that `/dev-plan` wrote at handoff — `skills/dev-plan/SKILL.md` step 7
   states the four fields and the exact command behind each, and it is the only statement of that
   contract. Re-run those same commands against the tree you are about to implement into, compare,
   and take exactly one of four branches. The first two are the common case and they **spawn
   nothing** — a gate that costs an agent on every clean run is a tax, not a check:

   - **Nothing relevant moved.** `planned_at_sha` is `HEAD`, `steps_sha` still matches `plan.md` on
     disk, `spec_sha` still matches `spec.md`, and `git status --porcelain` shows nothing under any
     path a step declares in its `files`. Continue: one line in the report, zero agents.
   - **Only unrelated files moved.** `git diff --name-only <planned_at_sha> HEAD` plus that porcelain
     list names no path any step's `files` names. Report the count — "N files changed since planning,
     none of them the plan's" — and continue. Still zero agents.
   - **A file the plan cites moved.** Some changed path does appear in a step's `files`. Spawn
     **one** cheap targeted validator — a single read-only `Explore` agent from here, not a workflow —
     and give it only the affected steps and the diff for those files. It answers one question: is
     the plan still **executable**, do the anchors, signatures and assumptions those steps state still
     hold? It may not re-explore the repo and it may not judge whether the plan was *thorough* — that
     is an explicit non-goal, and a validator that drifts into it has turned a preflight into a second
     planning round at implement prices.
   - **Block.** `steps_sha` no longer matches `plan.md` (the plan was edited after handoff),
     `spec_sha` no longer matches `spec.md` (a criterion changed under it), or the validator reports a
     contract or plan assumption that no longer holds. Stop before step 5, say **which of the three**
     it was and name the evidence, and offer either re-planning (`/dev-plan`, with what changed as
     `constraints`) or an explicit developer override. Never proceed on your own judgement that it is
     probably still fine.

   Two situations look like the fourth branch and are not. **No `plan_freshness` object at all** — a
   plan written before this shipped, or an inline small-tier plan that never had one — say so once and
   continue; never reconstruct it from today's tree, which would certify a freshness nobody measured.
   And a `plugin_commit` that differs from the installed `FROZEN_AT`: **report** it and point at
   `/dev-setup --check`, never block on it alone. A plugin upgrade changes how the pipeline runs, not
   whether the plan is executable.

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

   The same projection also lints each step's `verify` **command** itself, and those warnings are
   worth reading before anything runs: one that deletes, force-pushes, publishes, deploys, migrates
   data or reaches an external service; one that is a synthesized shell pipeline where a
   project-declared script (`npm run …`, a Makefile target, a committed script) would do; and one
   aggregated line naming every command nobody recognizes, which is surfaced and then **proceeds** —
   an unrecognized runner is a command you should look at, never a claim that it is unsafe.

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

   Under `--isolated`, and only then, one more optional arg goes in: `root`, the worktree path step 3
   recorded. It must be absolute — the workflow throws on a relative one before any agent runs.
   It reaches every agent the run spawns (scouts, implementers, the per-wave contract gate, the final
   consistency check) and is threaded into the nested `wf-review-loop` with it, so all of them run
   their git, build and verify commands in the worktree instead of the primary checkout. Workspace
   paths are absolute and stay in the primary checkout, so `briefs/` and `notes/` are still written
   where `/dev-status` and a continuation can find them. Omit `root` on every other run: with no
   `root` every prompt is byte-identical to what it is today.

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
   - A step report can already carry `result_recovered: true` even when its `stage` is not
     `implement-result-unavailable`: the workflow's own non-editing `result:` retry sets it when *that*
     attempt alone rescued an otherwise-missing result, and the step then continues through the normal
     report path below — you will not see it flagged separately, only the field itself set. This is a
     different producer from the recovery agent the next bullet describes; step 9 defines the field
     covering both.
   - `stage: "implement-result-unavailable"` → the implementer returned no structured result.
     **The workflow already retried the serialization once** — `result_retry_attempted: true` on the
     report says that non-editing re-serialization attempt happened and came back empty — so do not
     retry it again. Classify first: read that agent's transcript directory (`journal.jsonl`) and
     check `expected_notes_path`.
     - Repeated `StructuredOutput`/schema validation errors **and** a completed notes file/code diff →
       `result_serialization_failed`. The implementation itself is not failed, and **recovery never
       re-runs implementation** — that would duplicate work on a tree the first attempt has already
       half-edited. Recovery is automatic here: spawn **one** compact read-only agent (`Explore` — the
       same structurally read-only mechanism `/dev-debug`'s hypothesis fan-out uses, which is what
       makes "may not modify files" a tool-level guarantee rather than a request) and give it exactly
       four things. (a) `expected_notes_path` **and** the workspace's `notes/` directory —
       `notes_path` is normally self-reported, so the expected path is a convention and not a promise.
       (b) The result schema field by field: `summary`, `changed_files`, `notes_path`, `verify_run`
       (`ran`, `command`, `passed`, `kind`, `not_ran_reason`), `deviations`, `concerns`. (c) The
       step's declared `files`. (d) `git diff <baseline> -- <files>`. It reconstructs the structured
       result and nothing else: no edits, no implementation, and **no verification the notes or
       `journal.jsonl` do not evidence** — with no command *and* no result recorded anywhere, it
       returns `ran: false` and a `not_ran_reason` naming that absence rather than a plausible pass.
       Mark what comes back `result_recovered: true`, then treat it exactly like an implementer
       report, so it lands in `unverifiedSteps` unless the evidence really was there. Report the
       serialization failure separately from the step it recovered.
       This recovery runs after the workflow call has already returned, so nothing you build here
       reaches `continuation.completed` on its own: `continuationEntry()` excludes any leaf with
       `failed: true`, and this report is still one. If the run needs to continue — the failed step
       is why `stoppedEarly` fired, or a later step `depends_on` it — construct that step's
       `completed` entry yourself and append it (never replace any entry already in the array) before
       re-invoking: `{ id: <step id>, changed_files: <recovered changed_files>, notes_paths:
       [<recovered notes_path>] or [] when none, unverified: <false only when the recovered
       verify_run substantiates a pass>, unverified_reason: <its not_ran_reason or failure reason,
       when unverified>, weak_evidence: <true when the recovered verify_run's kind is
       existing-suite>, reviewed: false }`. This is the one named exception to "never hand-edit
       `completed`" in "Continuing a run that stopped" below — every other entry there still passes
       through verbatim.
     - No structured-output errors and no completed notes/code evidence → `implementation_failed`; re-run the step or implement inline.
     - Conflicting evidence → `agent_failed_unknown`; surface it instead of guessing.
   - Other failed steps (`failed: true`, e.g. `stage: "verify"`) → check the workflow journal, fix the cause, then continue (see below); only the failed step and what follows it re-runs.
   - Steps `skipped_for_budget` → report them; continue with a fresh budget when the developer asks.
   - Split steps (`split: true`) → normal (size escape valve); mention it so future plans size better.
   - `unreviewedWaves` non-empty → those waves were implemented but never reached a checkpoint (the run
     stopped early), so their code is in the tree unjudged. Continuing handles this by itself: they come
     back as `continuation.completed` entries with `reviewed: false` and are folded into the next
     checkpoint. Only if the developer abandons the flow do you review them separately with
     `wf-review-loop` scoped to their files — passing the same `baseline`, and on an isolated flow
     the same `root` (the `worktree` path from `state.json`), so that loop judges the same diff in
     the same tree the run used.
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
     it as a result would be reporting a check that never happened. On an isolated run make that one
     call in the worktree (`cd "<root>"` first): the code this run left behind is there, the primary
     checkout has none of it, and a suite run in the primary would report on a tree this run never
     touched.
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
   On an isolated run every check in this step runs in the worktree — `cd "<root>"`, or
   `git -C "<root>"` — for the same reason: that is where this run's code is.

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

   **On an isolated run the commit is made in the worktree** — `git -C "<root>" commit` — onto the
   isolated branch, and it is no longer integration: nothing lands in the primary checkout here, and
   this commit exists to make that branch cherry-pickable and to give step 10 something to present.
   The state writes above do not move with it: `stage`, the `runs` entry and everything else in this
   step go to the workspace's `state.json` in the primary checkout, which is where they already live
   and where `/dev-status` and a continuation look for them.

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

   On an isolated run, say **where** the change is and that it is not yet in the developer's tree:
   name the worktree path and its branch, and state plainly that the diff has **not been integrated**
   — nothing has reached the primary checkout, and step 10 is where that decision gets made. A report
   that leads with `ready` and omits that reads as "it landed", which is the one thing an isolated run
   has deliberately not done.

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

   Run the append **from the primary checkout**, which on an isolated run means not from `<root>`.
   The script derives `repo` and `repo_sha` from `git rev-parse` with no explicit directory, and its
   envelope always wins over the body — so an append issued with the cwd inside an isolated run's
   worktree records the worktree's own basename as the repo, and no field you put in the JSON can
   override it.

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
   - `result_recovered` = `true` when at least one step's structured result was reconstructed instead
     of returned by its implementer — whether that happened via the workflow's own non-editing
     `result:` retry (that step's own report already carries `result_recovered: true`, set before you
     ever see it) or via step 6's read-only recovery agent. Top-level and boolean, and **omitted** when
     no step needed either kind of recovery — it is the one field saying a report's numbers were
     rebuilt from notes and a diff rather than reported by the agent that did the work.
   - `isolated`, `worktree_setup_ms`, `worktree_disk_kb` = written on an `--isolated` run only:
     `true`, plus the `setup_ms` and `disk_kb` the setup script measured in step 3. All three are
     top-level — they are wall-clock milliseconds and kilobytes, never inside `cost`, which is token
     cost throughout — and all three are **omitted** entirely on every other run, the same rule
     `result_recovered` follows, so a non-isolated line stays byte-identical to what it writes today.
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

10. **Present before integrating — isolated runs only.** An isolated run has produced a branch, not
    a change to the developer's checkout, and nothing reaches that checkout without an explicit
    answer here. Skip this step entirely on a run that was not `--isolated`: there is nothing to
    present, because step 8 already committed onto the branch the developer is standing on.

    In this order, and all of it before the question:

    1. **The isolated run's diff.** `git -C "<root>" diff --stat "<baseline>"` first, then the full
       `git -C "<root>" diff "<baseline>"`, then `git -C "<root>" log --oneline "<baseline>..HEAD"`.
       The stat is the map, the diff is the change, the log is what a cherry-pick would take.
    2. **The verdict and the gates**, restated exactly as step 9 labelled them — the same
       `delivery_verdict`, the same `reasons`, the same one-line `gates`. This is the developer's
       last read before deciding, and a verdict rounded up here ("basically ready") is the one place
       a rounding error becomes a merge.
    3. **The primary-checkout assertion.** Re-run the two commands step 3 snapshotted, in the primary
       checkout: `git status --porcelain | git hash-object --stdin` and `git rev-parse HEAD`. Both
       match → report "primary checkout unchanged since preflight". Either differs → say which, and
       what it shows now, before the question. Never state that line without having run them: the
       whole promise of an isolated run rests on it, prompt text is the only thing keeping agents in
       the worktree, and this is the one detector for an agent that ignored it.
    4. **Then ask** — one `AskUserQuestion`, four options, with "leave as is" the default:
       - **merge** — `git -C "<primary>" merge --no-ff <worktree_branch>` (`<primary>` is the
         checkout this session is in, which it never left). A merge into a dirty primary succeeds
         unless it touches a locally-modified file; when git refuses, report its refusal **verbatim**
         and never force it or stash around it. The developer stashes and says merge again — that is
         one command and it is theirs to run.
       - **cherry-pick** — `git -C "<primary>" cherry-pick <sha>` for step 8's phase commit, when the
         change is wanted without the isolated branch's history.
       - **discard** — nothing is deleted. The isolated branch and its worktree stay exactly where
         they are; "discard" means "not into my tree", not "gone".
       - **leave as is** — the default, and the same physical state as discard said differently: the
         developer has not decided yet.

       Nothing integrates without that answer. Do not merge because the verdict was `ready`, and do
       not skip the question because the diff looked small.

       **On a successful merge or cherry-pick**, write `worktree_integrated: true` into the
       workspace's `state.json` — a flat top-level boolean, written `true` only and omitted on
       discard, leave-as-is, or a non-isolated run, the same rule `isolated` already follows. This is
       what lets `/dev-status` tell a merged flow's now-removed worktree from one still at risk once
       the developer runs the cleanup below; see that skill's Status step.

    Finally, **offer** the cleanup and never run it:

    ```bash
    sh "${CLAUDE_PLUGIN_ROOT}/scripts/worktree.sh" remove <slug>
    ```

    Say what it does: it removes the isolated flow's worktree directory and **keeps the branch**, so
    every commit survives it. Deleting the branch is a separate second decision the developer makes
    explicitly — `git branch -D <worktree_branch>` — and it is the one that can destroy work.
    `/dev-status clean` offers the same command, by name, for the same reason.

11. **Ratchet the repo's rules — only when the run produced evidence.** Nothing carries between
    cycles by design; the repo itself is the only durable store, so this is the one moment where
    what an agent learned can be written somewhere the next one will read it.

    On an isolated run this step edits `.claude/rules/*.md` in the **primary checkout**, and it runs
    **after** step 10's integration decision — never in the worktree. Step 10 allows the whole diff
    to be discarded, and a rule edit written into a discarded worktree would take the pipeline's only
    durable-knowledge write path down with it. These writes land after the primary-checkout assertion
    was already made, and they are the developer's own approved edits, so they do not weaken it.

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

On an isolated flow, "in the tree" means **in the worktree**: `state.json`'s `worktree` path holds
the working tree, its `worktree_branch` holds whatever step 8 committed there, and the primary
checkout has none of it and stands exactly as the developer left it. Say both when you report a
stopped isolated run, so nobody goes looking in the primary checkout for work that is one directory
away.

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

   On an isolated flow — `worktree` present in `state.json`, per step 1 — pass
   `root: "<that path>"` too, alongside that same original `baseline`. Both come from the recorded
   state, never from the command line: the flag is not retyped and the path is not re-derived. Then
   re-snapshot the primary checkout the way step 3 does, because this continuation makes its own
   step 10 assertion against its own snapshot, not the stopped run's.
3. **Never hand-edit `completed`** — with one named exception: a step recovered under step 6's
   `result_serialization_failed` bullet has no other path into this array (the run that recovered it
   already returned, and `continuationEntry()` excludes a `failed: true` leaf), so that bullet has you
   build and append its one entry yourself. Every other entry passes through verbatim. Its `reviewed`
   flags decide what gets folded into the next review checkpoint; flipping one to `true` to save a
   round ships unjudged code, which is the specific failure this field exists to prevent.
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
- Only steps with declared disjoint `files` run in parallel. Flow-level isolation is built and opt-in: `--isolated` gives one flow its own git worktree, and step 2's lock is unchanged by it. True parallel *flows* — several implements running at once — are still not built: that needs one worktree per flow *and* a lock that admits more than one, and neither the lock nor `/dev-status` has been taught the second half. Don't improvise it.
