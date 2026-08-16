# devkit — dev-process workflows

Reusable multi-agent development pipeline for Claude Code, inspired by the
[Recursive Language Models](https://arxiv.org/abs/2512.24601) paper (Zhang, Kraska, Khattab):
context lives in the *environment* (files, structured summaries, pointers), and orchestration is
*programmatic* (deterministic JS with loops/branches spawning sub-agents), never a verbalized
linear chain.

> **Just want to use it?** Read the [user manual](manual.md) — commands, the standard cycle, your
> checkpoints, troubleshooting. This document is the architecture: read it to *change* the
> pipeline. Both ship inside the plugin at `${CLAUDE_PLUGIN_ROOT}/docs/`, so every repo that has
> the plugin has them — they are never copied into a project.

## Architecture

Two layers, deliberately split:

| Layer | Mechanism | Runs | Can talk to the dev? |
|---|---|---|---|
| Control plane | `skills/*/SKILL.md` (`/dev-spec`, `/dev-plan`, `/dev-implement`, `/dev-review`, `/dev-pr`, `/dev-debug`, plus `/dev-status`, `/dev-setup`) | main conversation loop | yes — `AskUserQuestion`, approval |
| Data plane | `workflows/*.js`, invoked as `devkit:<name>` (Workflow tool scripts) | background, deterministic JS | no — returns structured data + `open_questions` / `needs_user_input` |

Both live in the plugin. A project contributes only `.dev/` (scratch, gitignored) and, optionally,
`.claude/rules/*.md` — the one channel through which a repo specializes a generic pipeline.

**Interrupts** live *between* workflow phases: agents flag questions in structured output; the
skill surfaces them to the dev and feeds answers into the next phase.

**Three memory tiers** (the RLM mapping):

| Tier | In the paper | Here | Read cost |
|---|---|---|---|
| Symbolic state | REPL variables | the workflow script's JS variables | zero — it's code, no context window |
| Dense context | slices sub-LMs read | repo + task workspace, read by pointer | paid only by whoever needs it |
| Agent window | sub-LM context | prompt assembled by the script from minimal slices | disposable |

## Task workspace — the shared scratchpad

Each task gets `.dev/<slug>/`. Every file has **exactly one writer**; everyone else reads by
pointer (never "read the whole workspace"):

```
.dev/
  pr/<branch>/         ← standalone PR artifacts when no task workspace matches; never flow state
  <slug>/
    state.json         ← this flow's stage/baseline/lastRunId; written by the skill owning the phase
    last-run.json      ← the implement run's args + completion map, so a stop can be continued
    spec.md            ← /dev-spec (dialogue in the main loop)
    plan.md            ← wf-explore-plan's synthesizer; then curated by the /dev-plan skill
    understanding.md   ← same workflow in mode:'explain'; findings/ stay reusable for a later plan
    findings/<angle>.md← exploration scouts (full reports; compact summaries returned to the script)
    briefs/<id>.md     ← adaptive scouts only; inherited by sub-steps on recursive split
    notes/<id>.md      ← per-step implementers (decisions + whys); read by reviewers & sub-steps
    pr.md              ← proposed public PR body; publication always waits for approval
    reviews/<sha>.md   ← immutable report-only PR review, tied to an exact HEAD
```

Notes from other agents are hints, not truth — every prompt says "verify load-bearing claims in code".

## No shared memory across cycles

Context is *push only*: the script hands each agent the paths it needs. There is no cross-cycle
memory store — nothing an agent learns in one run is discoverable by an agent in the next. Durable
knowledge belongs in the repo itself (`CLAUDE.md`, `docs/`, `.claude/rules/*.md`), where it is
PR-reviewable and travels with git. Adding a pull-side memory channel is a possible extension
(see "Extending"), not something the pipeline currently depends on.

There *is* a write path, and it deliberately ends at a human. `/dev-implement` step 10 offers — only
when a run produced confirmed findings or a note recording a rediscovered convention — at most three
proposed edits to `.claude/rules/*.md`, each citing its evidence, which the developer approves as a
diff. That is the same producer an earlier design had feeding an agent-writable knowledge base,
reattached to the store this architecture actually endorses. The difference is not storage: it is
that a rule now has to survive review by someone who can say no.

## The pipeline

```
/dev-spec  (optional, for large/ambiguous tasks — dialogue, repo-anchored questions)
   → spec.md with VERIFIABLE acceptance criteria that flow through everything downstream

/dev-plan "task"
   0. TRIAGE: default trivial/small; medium+ needs a named signal (unknown-code, contract-change,
      independent-parts, needs-approval, no-spec). small → inline scout + 5-line plan.md, inline impl
   └─ wf-explore-plan.js ─── background
        Decompose (sonnet)  → 3-5 angles, merging concerns with shared evidence
        Explore  (sonnet ×N)→ scouts write findings/<angle>.md, return compact summaries
        Validate (sonnet ×1)→ one batched check of load-bearing headline claims
        Synthesize (opus)   → cross-check, coherent one-agent steps (~10 files as a soft guide,
                              executable verify), writes plan.md (+ JSON steps block)
   └─ interrupt: open_questions → dev; checkpoint: dev approves plan

/dev-implement <slug>
   └─ wf-implement.js ─── background
        steps → topological waves → within a wave, disjoint-file steps in parallel
        per dependency wave:
          Scout (sonnet)   → adaptive only for ambiguous/oversized steps; may split recursively
          Implement (opus) → RUNS each step's verify command, writes notes/<id>.md
          BARRIER          → all implementations finish before review/fixes mutate files
          wf-review-loop      → one consolidated review over the wave's changed files
        Check (opus)  → the SEAMS between steps; runs the suite
   └─ interrupt: needs_user_input → dev; skill verifies end-to-end and reports
   └─ a run that stopped early continues via `completed` (same steps; done ids stop being deps)

/dev-plan --explain "question"
   └─ wf-explore-plan.js with mode:'explain' — same Decompose/Explore/Validate, different
      synthesizer: writes understanding.md and returns `findings` a later plan run passes back
      as `priorFindings` (re-validated, never re-scouted)

/dev-debug "<symptom>"   — no workflow: repro → read-only hypothesis fan-out → adversarial
   refutation → serial narrowing in the main loop → fix via the normal path → prove the repro dead

/dev-review [files]      — standalone entry to the same wf-review-loop
   └─ wf-review-loop.js
        while not clean and rounds < max:
          Review (sonnet ×2: runtime/contracts + intent/verification)
          → one verifier semantically clusters and checks all findings in a batch
          → critical clusters alone get one second opinion
          → Fix confirmed (fix tier; critical escalates one rung) → explicit post-fix re-review

/dev-pr [base] [--review] [--draft] [--body-only]
   ├─ deterministic git map: merge-base, commits, diff, upstream, dirty-tree gate
   ├─ selectively reads matching .dev spec/plan/notes as hints
   ├─ optional report-only wf-review-loop (apply:false) → reviews/<reviewed-head>.md
   ├─ writes pr.md and previews title/body
   └─ explicit approval → push if needed → gh pr create/edit   ← the ONLY GitHub-specific step;
      every lane above it is plain git and runs with a non-GitHub remote or none at all

Confirmed PR findings go back through the same review loop, seeded:

  reviews/<sha>.md
    → /dev-review --from-report <report>
      ├─ gate: branch matches, HEAD == reviewed_head, clean tree
      └─ wf-review-loop with seedFindings → straight to Fix, then explicit re-review
    → /dev-pr --review again (only current HEAD can clear the PR gate)
```

The model tiers above are **defaults**, not constants — see "Cost policy" below for how a run,
or a repo, shifts them.

## Design rules

- Agents return **structured data** (JSON Schema enforced); prose artifacts go to workspace files.
- Findings need evidence (`file:line` + failure scenario); verification means **running** a check,
  not reading code.
- Recursive splitting is an escape valve (scout-triggered, depth-capped), not the default. File
  count is a soft guide; cohesive vertical slices avoid multiplying fixed per-step agent cost.
- Steps own disjoint `files` sets to parallelize; prefix overlap, globs and undeclared files run serial.
- Reviews and fixes happen only after a dependency-wave barrier.
- `clean: true` requires an explicit pass with no confirmed findings; skipped fixes and budget exits leave it false.
- PR review artifacts are SHA-bound evidence. High/critical findings block publication; low/medium
  require an extra confirmation. Review mode never fixes code implicitly.
- All workflows accept `{ dryRun: true }` (zero-cost smoke test) and normalize `args` from JSON
  string. Named resolution requires a session restart after creating a workflow file; `scriptPath`
  works immediately.

## Two shapes the feature cycle does not fit

**Understanding** is `mode: 'explain'` on `wf-explore-plan`, not a new script and not a new command.
The synthesizer's prompt and schema swap; everything before it is identical. The justification is
deliberately *not* "explain this to me" — the built-in `Explore` agent does that far more cheaply,
and `/dev-plan`'s prose says to route bare questions there. What this buys is that `findings/<angle>.md`
are durable and adversarially validated, and the run returns a `findings` array a later `/dev-plan`
in the same workspace passes back as `priorFindings`. Angles already covered are not re-scouted; the
findings still go through validation, so a claim that went stale is refuted rather than trusted —
that is the entire staleness guard, and it is the check that already existed doing its job on older
input. Understanding becomes a *stage*, not a feature beside the pipeline.

**Debugging** is one skill and no workflow, because its two halves want opposite things. The
hypothesis half is embarrassingly parallel and must be **read-only**: parallel agents running a repro
contend for one working tree, which is the same constraint that limits the repo to one
`/dev-implement` at a time, and an agent that edits a file to test a theory corrupts every other
agent's evidence. The narrowing half is inherently serial, executes, and talks to the developer —
main-loop work by definition. A workflow script could host the first and not the second.

The pattern that transfers is `wf-review-loop`'s: generate candidates cheaply, then spend a second
pass trying to **refute** each one, defaulting to refuted under uncertainty. A plausible cause is easy
to generate and feels like progress; the cost lands later, when someone instruments and rebuilds
around a theory nobody checked. And the honesty gate is the same shape as `verify_run`'s: a repro that
was never re-run cannot close a bug, and an unreproduced bug yields an explicitly *unverified* fix
rather than a quiet success.

## Repo rules — a native convention the subagents could not see

`.claude/rules/*.md` is **Claude Code's** convention, not devkit's. Those files load automatically
alongside CLAUDE.md, and a `paths:` frontmatter key scopes one so it loads only when Claude works
with matching files. (Verified against the shipped CLI: its `/init` text describes exactly this, and
`claudeMdExcludes` lists `.claude/rules/**` among the memory it can exclude.) So the frontmatter
contract is not ours to define — the pipeline conforms to it.

That places rules next to the other two memory shapes rather than replacing them:

| | Loads | Good for |
|---|---|---|
| root `CLAUDE.md` | always | facts every session needs |
| nested `CLAUDE.md` | when working **under that directory** | module-local instructions, in a monorepo |
| `.claude/rules/*.md` + `paths:` | when working with **matching files** | cross-cutting concerns whose files don't share a directory — the data layer, error surfaces, migrations |

`/dev-setup` bootstraps them as a **refactor of existing memory, not authorship**: the raw material
is usually already in `CLAUDE.md`'s always/never section, `CONTRIBUTING.md` or lint config, and a
rule that cannot be traced to something a human wrote does not get proposed. Splitting that material
out is a win independent of this pipeline — `CLAUDE.md` costs every session, a `paths:`-scoped rule
costs only the sessions it applies to.

What devkit adds is **reach**, not format. Native loading is a main-session mechanism: a background
workflow subagent inherits none of it, which is why every agent used to rediscover conventions the
repo had already written down. So `scripts/rules-manifest.sh` extracts `[{path, globs}]` (workflow
scripts have no filesystem access) and the workflows match it per agent, handing each one only the
rules covering the files it touches — plus every unscoped rule, since natively those load for
everything.

Two consequences worth stating:

- **The matcher is ours and can disagree with the CLI's at the edges.** A workflow script cannot
  import Claude Code's matcher, so `globToRegExp` reimplements `*`, `**/`, `?` and `{a,b}`. It errs
  toward offering an extra rule, which costs one read. It lives in a fenced block copied verbatim
  into `wf-implement.js` and `wf-review-loop.js`; `tests/rules.test.js` asserts the copies stay
  byte-identical, so the duplication is one algorithm rather than two.
- **Matching happens in one place, for both entry points.** `wf-implement` passes the raw manifest
  and the changed-file list down to `wf-review-loop` rather than a pre-filtered list, so `/dev-review`
  standalone gets the same deterministic matching instead of a skill eyeballing globs in the main loop.

## Cost policy — roles, not phases

Model tier and reasoning effort are arguments, not constants. Every workflow resolves them once at
startup through the same `policy()` block and spreads the result into each `agent()` call:

```
profile: "cheap" | "default" | "max"   shift every role one rung on [haiku, sonnet, opus]
models:  { impl: "sonnet", … }         override one role; beats the profile
efforts: { decompose: "low", … }       same, over [low, medium, high, xhigh, max]
```

Four decisions are worth knowing about, because each one is a place this could have gone wrong:

- **Roles, not phase names.** `impl`, `review`, `gate`, `synth`… are a vocabulary shared across the
  whole pipeline, so one object survives `workflow()` nesting: `wf-implement` forwards its cost args
  to `wf-review-loop` unchanged. A cheap implement whose review checkpoints run at full price is not
  a cheap run. The cost of a shared vocabulary is that a role a given workflow doesn't own has to be
  *ignored* rather than rejected — so unknown names are checked against the pipeline-wide list, and
  a typo (`implement` for `impl`) throws before any agent spawns instead of silently paying full price.
- **Defaults are exactly what shipped.** Omitting all three reproduces the previous hardcoded split.
  The one deliberate exception is `decompose`, which now defaults to `effort: 'low'`: it turns a task
  description into 3-5 angle names without reading code, and inheriting a session running at high
  effort meant paying high effort for near-templating. Everything else inherits the session's effort,
  as before.
- **The contract gate stayed on sonnet.** It is the obvious haiku candidate — it is even labelled
  "one cheap agent per wave" — but it reads a diff and judges whether a consumed surface is coherent,
  and its failure mode is asymmetric: a gate that wrongly reports *breaks* costs one review, while a
  gate that wrongly reports *clean* is worse than no gate, because the pipeline then trusts it. Cheap
  is available via `profile`/`models`; it is not the default.
- **Escalation is relative.** A critical review finding buys the fixer one rung above the run's fix
  tier, not a hardcoded opus — otherwise "critical gets a better model" quietly means nothing under
  a cheap profile, which is exactly when it matters most.

`policy()` is copied verbatim into all four scripts: they are self-contained by construction and
cannot import a shared helper. `tests/policy.test.js` asserts the four copies are byte-identical, so
the duplication cannot drift into four different cost models. `dryRun` returns the resolved policy,
which makes a cost setting checkable for free before it can spend anything.

A repo pins its default through the `Cost profile:` line `/dev-setup` writes into `CLAUDE.md` —
already in every session's context, committed with the repo, and needing no config format,
precedence rules or parser.

## Testing

Workflow scripts are self-contained by runtime requirement — no imports — so there is nothing to
`require()`. The harness that works instead: read the file, swap `export const meta` for `const
meta`, wrap the whole thing in `new Function(...)` (the script body is a function body, top-level
`return` and all) and call it with stubs for `agent`/`parallel`/`workflow`. Stub them to **throw**
and pass `dryRun: true` to test the scheduling; stub them to reply *by agent label* and let the loop
run to test control flow — which is how `tests/seeded-review.test.js` proves no finder ever runs on
the seeded path, since an unexpected label throws. Nothing is rearranged in the script to accommodate the test, and the stubs turn "a
regression reached an agent" into a test failure instead of a surprise bill.

That is what `dryRun` with `steps` is for: it runs the entire scheduler and returns the result, so
`tests/schedule.test.js` covers `toWaves`, `disjoint`/`pathScope`, `globToRegExp`/`ruleMatchesFile`,
the scout heuristic and the checkpoint policy through the real entry point rather than through
copies of them.

| File | Covers |
|---|---|
| `tests/schedule.test.js` | the whole scheduler, via the `dryRun` projection (real entry point) |
| `tests/verify-gate.test.js` | the verified/unverified/failed truth table |
| `tests/continuation.test.js` | dependency surgery when a stopped run continues |
| `tests/policy.test.js` | model/effort resolution, plus `policy()` drift across the four scripts |
| `tests/rules.test.js` | `paths:` frontmatter parsing, glob matching, matcher drift |
| `tests/seeded-review.test.js` | `--from-report`: that no finder runs, and that `clean` still needs a post-fix pass |
| `tests/explore-modes.test.js` | plan vs explain mode, and that reused findings skip scouting but not validation |
| `tests/contract-drift.test.js` | that the prose still states the values the scripts actually use |

Run one with `node tests/<name>.test.js` or all of them with `sh tests/run-all.sh`; each prints a
PASS/FAIL line per case and exits non-zero on failure. Where a test cannot reach through `dryRun` it extracts the shipped block by an anchor
and fails closed if the anchor moves — a stopgap, and the reason to prefer widening `dryRun`.

`tests/contract-drift.test.js` is a different kind of check: the scripts are the source of truth for
defaults, option sets and severity levels, and the skills restate them for a human, so a script that
changes without its prose leaves a confident lie behind — the failure no reviewer catches, because
nobody diffs a `SKILL.md` against a schema. It compares **concrete values only**, extracted from the
source, never restated in the test. It deliberately does not grep for canonical sentences: a check
that passes because a file still contains the word "disjoint" while the sentence around it now says
the opposite is a check that teaches people to ignore the suite. Its own failure modes were verified
by mutation — changing a default, adding an enum member, renaming a workflow file.

`evals/` is the other half: `claude plugin eval` cases for judgment calls no unit test can reach
(does triage escalate, and does it say why). See `evals/README.md` — including that the command is
early-access gated, so those cases are written but unrun.

## Distribution

The pipeline is a **Claude Code plugin**. Skills, workflows and these docs live in one place and
every project sees the same version — there are no per-repo copies to drift.

**Personal use (one developer, many repos).** `claude plugin init` scaffolds at
`~/.claude/skills/<name>/`, which auto-loads next session as `<name>@skills-dir`. No marketplace, no
install step: edit the plugin directory and every project picks the change up on restart. Keeping
that directory in git (or symlinking it to a normal project checkout) gives version history without
changing how it loads.

**Team use.** Publish the plugin from a git repo carrying `.claude-plugin/marketplace.json`, then
have each project declare it in `.claude/settings.json` (`extraKnownMarketplaces` +
`enabledPlugins`) so a teammate who clones the repo is prompted to install it. This is the one
mechanic that genuinely changed with the plugin move: previously `.claude/` travelled inside the
repo and a `git pull` was enough.

**Per-repo setup** is what remains, and `/dev-setup` walks it: `.dev/*` in `.gitignore`, a pipeline
pointer in `CLAUDE.md`, `"Workflow"` in the project's `permissions.allow`, and — the valuable one —
`.claude/rules/*.md`. Under a plugin a repo cannot fork a prompt, so rules are the only place
repo-specific knowledge can steer the agents. Treat them accordingly.

Onboarding notes worth stating once:

- New or renamed workflow files register on **session start** — restart after installing or
  updating the plugin. More precisely: `name:` resolution serves a **snapshot** taken when the
  plugin loaded, so *editing* an already-registered workflow does not change what `name:` runs
  either. While working on a workflow, invoke it by `scriptPath` — that always reads the file on
  disk. (Observed directly: a `dryRun` by name returned the pre-edit result while the same args by
  `scriptPath` returned the new one.)
- The pipeline spawns many sonnet/opus agents; token cost scales with the triage tier (see that
  table). A "+300k"-style budget directive caps a run hard, and `profile: "cheap"` shifts every
  agent down a model tier.
- Treat the plugin's prompts as code: change them via PR against the plugin repo, informed by the
  calibration checklist below. A change ships to every project at once — that is the point, and
  also the risk.
- One `/dev-implement` per clone at a time (`.dev/` is per-clone, so two people on
  separate clones are fine).

## Git conventions

A git repo is a **prerequisite** for `/dev-implement`, `/dev-review`, and `/dev-pr`:

- `.dev/` is gitignored — workspaces are scratch, not history.
- Before implementing, the skill captures a **baseline** (`git rev-parse HEAD`) and passes it down:
  reviewers judge `git diff <baseline> -- <files>`, so introduced defects are distinguishable from
  pre-existing ones. Review without a baseline reviews whole files — much weaker.
- On the default branch, the skill branches to `dev/<slug>` first. After a completed implement it
  makes a **phase commit** (`impl(<slug>): <title>`) — the rollback/review boundary.
- `/dev-pr` compares `base...HEAD` from the exact merge-base. A dirty tree can produce a body draft
  but blocks publication because those bytes are not in the proposed PR.
- `/dev-review --from-report` requires `HEAD == reviewed_head`, a matching branch **and a clean
  working tree**: the findings cite `file:line` in the reviewed commit, so on drifted code they
  describe something that no longer exists. After the fix commit the prior report is historical and
  a fresh whole-branch PR review is required.

## Flow state & concurrency

Each workspace owns its state: `.dev/<slug>/state.json` holds
`{ task, stage, updated, baseline, lastRunId }` with stages
`spec → planning → plan-ready → implementing → implemented` (or `abandoned`), written by the skill
that owns that phase. State sits **inside the thing it describes**, which is what makes the
single-writer rule structural rather than an invariant every skill has to be told to respect: there
is no shared file two skills could race on, and a directory that exists with no state file is a
recoverable case (infer the stage from its artifacts) rather than a corrupt registry.

`/dev-status` globs those files: table of flows, PR-review SHA/outcome, staleness flags, and
`clean <slug>` to delete the workspace — which takes its state with it.

Fixing a PR review adds no state and no stage: `/dev-review --from-report` is a review loop, and a
review loop has never been a flow. See "Fixing a review, without a second pipeline" for why the
dedicated remediation axis that used to live here was removed.

**One implement per repo at a time** — the advisory lock is a glob (`.dev/*/state.json`, any at
`implementing`), deliberately not a lock file: a shared file would reintroduce the writer the
per-workspace split just removed. The reason is not file
collisions — it's that step verifications and the consistency check *run the test suite on the
shared working tree*; a second concurrent flow makes every verification result unreliable. True
parallel flows are a designed extension: one git worktree + branch per flow, merge at the end.
Don't improvise same-tree concurrency.

## Debugging & recovery

- **Live progress**: `/workflows` in the CLI; each workflow launch prints its transcript dir.
- **What did an agent actually return?** Read `journal.jsonl` in the transcript dir — one result
  line per completed agent. Do this before diagnosing an empty/odd workflow result.
- **Implementer has code/notes but no result**: inspect its transcript for rejected
  `StructuredOutput` calls. Classify that as `result_serialization_failed`, distinct from
  `implementation_failed`; do not re-run completed implementation work just to recover a report.
- **Stopped run vs crashed run.** `implement` stopping early (blocking question, unclean
  checkpoint, failed step, budget floor) is the design, not a fault: it returns
  `stoppedEarly` + `stopReason` + a `continuation` block. Resolve the cause and re-invoke with
  the same `steps` plus `continuation.completed` — done ids stop counting as dependencies and
  any never-reviewed work is folded into the next checkpoint. Do not reach for `resumeFromRunId`
  here: a planned stop usually changes `notes`, which changes every implementer prompt and
  invalidates the agent cache anyway.
- **Crashed/killed run**: `Workflow({scriptPath, resumeFromRunId: <lastRunId>, args: <same>})` —
  completed agents replay from cache; only edited/new calls run live. `lastRunId` is in the
  workspace's `state.json`.
- **Refuted review findings** never trigger fixes; they remain in the result and journal for audit.
- **The budget floors only exist when a budget does.** wf-review-loop stops below ~30k remaining
  tokens (`clean: false`) and implement skips steps below ~40k (`skipped_for_budget`) — but every one
  of those guards reads `if (budget.total && …)`, and `budget.total` is `null` unless the developer
  put a "+300k"-style target in their own *message*. Verified, not assumed: a zero-agent probe
  returned `total: null` with `spent()` working normally. So in a run with no directive there is no
  floor, and nothing degrades gracefully — it just runs. A script cannot fix this by setting its own
  ceiling: `budget` comes from the turn, not from args. What it can do is stop pretending, which is
  why every workflow now returns `cost.floors_active`.

## Fixing a review, without a second pipeline

A `/dev-pr --review` report is adversarially verified evidence bound to one exact `HEAD`. Turning it
into applied fixes used to be a whole second axis — `wf-plan-remediation.js`, `/dev-plan --review`, a
nested `remediations/<sha>/` workspace, and remediation branches in five of `/dev-implement`'s nine
steps. That is gone. `/dev-review --from-report <path>` feeds the report's `confirmed` array to
`wf-review-loop` as `seedFindings` and the loop goes straight to the fixer.

The reasoning, since the deletion is the kind that looks like lost capability:

- **The two bundled things separate cleanly.** SHA-bound evidence that gates publication is valuable
  on its own, solo included; a *plan-and-approve cycle for the corrections* exists so that "the
  review found things, someone else fixes them later" survives a handoff. Only the second was in
  question, and only the second was removed.
- **Seeding, not re-reviewing, is the correctness argument — not just the cheap one.** The findings
  were already found and already confirmed. Running finders over them again risks *missing* one,
  which silently drops a confirmed defect. So round 1 skips find and verify entirely. The explicit
  post-fix re-review is untouched, so `clean: true` still means a pass that found nothing.
- **The HEAD invariants were kept, not dropped with the rest.** They protect against applying
  `file:line` findings to code that moved, which is true whether or not a plan sits in between.
- **Escalation stays available and costs nothing to keep.** Findings that need an approach decision,
  span subsystems, or must be ordered are ordinary work: `/dev-plan "fix the findings in <report>"`
  gets exploration, an approved plan and waves — through the one pipeline that already exists.

What this gives up: a batched revalidation pass over stale findings (the HEAD gate makes staleness
impossible instead), root-cause grouping into steps (the fixer sees all findings at once), and
`source_findings` traceability. The residual question — did anyone ever want an *approved plan* for
a correction rather than the correction itself — was answered from real use, not from the armchair.

## Relation to built-in skills

- One-off change without a workspace → built-in `/code-review` (cheaper). Pipeline cycle →
  `/dev-review` (workspace context, severity-scaled verification, applies fixes in a loop).
- `/dev-pr --review` deliberately uses that same verifier in report-only mode, persists evidence,
  and routes fixes through plan approval instead of silently mutating code while preparing a PR.
- The built-in `/run` complements step 7 of `/dev-implement`: launch the app and exercise the
  changed flow end-to-end, not just tests.

## First-run calibration checklist

Use workflow transcripts from real cycles to tune these before adding more agents:

- **Clustering ratio**: many raw titles collapsing into few semantic defects means reviewer overlap
  is high; merge lenses before adding validators.
- **Split rate**: every step triggering `too_big` means the synthesizer sizes badly; never
  triggering is fine.
- **Round convergence**: wf-review-loop should go clean in 1–2 rounds; consistently hitting 3 means a
  weak fixer or redundant lenses.
- **Tokens per phase**: no longer read off notifications by hand — every workflow returns
  `cost: { by_phase, total, budget_total, floors_active }` and logs a `cost: steps=42k review=18k …`
  line. Know where the money goes before cutting. First knobs: `profile: "cheap"`, then skip planning
  validation, reduce angles, or disable scouts.

  Two things the numbers are not. `steps` in wf-implement covers scouting *and* implementation
  together: the steps in a wave run concurrently, so their agents interleave and no delta can
  attribute tokens to one or the other. And `budget.spent()` is the whole turn's output tokens,
  shared with the main loop and any other workflow — so a second workflow running at the same time
  inflates these, and nothing in the script can detect that. Measure with one run at a time.

## Authoring a bespoke workflow

The canned scripts aren't sacred. When a scenario's *control flow* genuinely differs — an audit, a
migration, a tournament/judge-panel shape, a loop over a different unit — write a one-off script
instead of bending args. (Parameters first: custom `lenses`, `angles`, `review: false` and budgets
already cover a lot, and sequencing canned workflows across turns covers more.) Put it in the task
workspace as `orchestration-<name>.js` and invoke it with `Workflow({scriptPath})`.

House rules — each of these exists because it bit us or the runtime requires it:

- `export const meta = { name, description, phases }` — a pure literal; phase titles must match the
  `phase()` calls.
- Open the body by normalizing args
  (`if (typeof args === 'string') { try { args = JSON.parse(args) } catch (e) { throw new Error('args arrived as a non-JSON string') } }`)
  and a `dryRun` guard returning `{ok: true}`.
- A JSON `schema` on every `agent()` call; end prompts by saying the output is raw data for an
  orchestrator. Prose goes to workspace files — agents return compact summaries plus paths, never a
  dump piped into the next prompt.
- `pipeline()` by default; `parallel()` only for a true barrier. Agents that mutate files need
  disjoint file ownership, or run serial.
- A budget guard in every loop: `if (budget.total && budget.remaining() < 30000) break` — and know
  that it is inert unless the developer set a target in their message; guard, don't promise.
- Bracket phases with `metered(phase, fn)` so the run reports its own cost. Deltas of
  `budget.spent()` are only meaningful around non-overlapping intervals, so meter phases, never
  individual agents inside a `parallel()`.
- No `Date.now()` / `Math.random()` / argless `new Date()` — the runtime throws, because they would
  break resume. Timestamps arrive via args or from an agent running `date`.
- **`workflow()` nests one level only.** Safe children: `wf-explore-plan`, `wf-review-loop`.
  `wf-implement` calls `wf-review-loop` internally, so as a child it needs `review: false`.
- Escape backticks inside template literals — an unescaped fence is the classic parse error.

Smoke-test with `args: {"dryRun": true}` (zero agents, zero cost) before the real run; on a crash or
a mid-flight edit, `Workflow({scriptPath, resumeFromRunId})` replays completed agents from cache.
Agent-level truth lives in the run's `journal.jsonl`. If a shape proves recurrent, harden it and
promote it into the plugin's `workflows/` — it registers as `devkit:<name>` on the next session
start.

## Extending

- Custom review lenses: pass `lenses` to `wf-review-loop`.
- Shared memory (removed, re-addable): a pull-side channel where scouts/implementers/reviewers
  discover lessons, gotchas and subsystem maps from earlier cycles. It was backed by an external
  MCP knowledge base and was stripped out with it. Re-adding it means picking a store (committed
  markdown entries + a grep-able catalog is the simplest), a query snippet in the exploration and
  review prompts, and a curated set of writers — a post-implementation retro agent distilling ≤3
  lessons per cycle is the natural producer, and was removed along with the store it wrote to.
- Design judge-panel for arch-open tasks: N independent approach proposals + judges before
  synthesis — add as a workflow called by /dev-plan between explore and synthesize.
- Parallel flows (designed, not built): `git worktree add` per flow, implement runs against the
  worktree path (prompts take a `root` arg), merge + review at the end; the workspace state gains a
  `worktree` field. Build only after single-flow cycles run well.
- Status dashboard (designed, not built): an Artifact-rendered HTML view of the workspace states;
  `/dev-status` covers the need until then.
