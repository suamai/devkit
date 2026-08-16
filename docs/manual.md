# Dev pipeline — user manual

How to *use* the devkit multi-agent dev pipeline day to day. Architecture and design rationale live
in the companion doc ([architecture.md](architecture.md)); read that when you want to change the
pipeline, read this when you want to use it.

## Command map

| Command | Use when | Produces |
|---|---|---|
| `/dev-setup` | Configuring a repo for the pipeline, or checking it after a plugin update | gitignore, CLAUDE.md pointer, Workflow permission, rules, smoke test |
| `/dev-spec <rough idea>` | Task is large or requirements are fuzzy | `.dev/<slug>/spec.md` with verifiable acceptance criteria |
| `/dev-plan <task>` | Start of any nontrivial task | Triage; a five-line `plan.md` for small, a validated step plan for medium+ |
| `/dev-review --from-report <review.md>` | Apply the confirmed findings of a PR review | Fixes applied and explicitly re-reviewed; clean/not-clean |
| `/dev-implement <slug>` | Plan approved | Implemented steps, executed verifications, review loops, phase commit |
| `/dev-review [files]` | Validate changes (standalone) | Confirmed findings, applied fixes, clean/not-clean verdict |
| `/dev-pr [base] [--review] [--draft] [--body-only]` | Prepare/review/publish the current branch | `pr.md`, optional SHA-bound review report, PR after approval |
| `/dev-status` | "What's going on?" / cleanup | Table of flows and stages; `clean <slug>` deletes a workspace |

## Arguments and options

### `/dev-pr [base] [--review] [--draft] [--body-only]`

| Argument/option | Meaning | Important behavior |
|---|---|---|
| `[base]` | Explicit GitHub destination branch, for example `dev` or `main` | Overrides automatic detection. Omit it to use an existing PR's base, then `origin/HEAD`, then the remote default. This is a branch name, not a SHA. |
| `--review` | Run a branch-wide, report-only code review before offering publication | Saves `reviews/<HEAD>.md`. It never edits code. High/critical findings block publication; low/medium require a separate risk acknowledgement. |
| `--draft` | Create a new GitHub PR as a draft | Affects only `gh pr create`. When editing an existing PR, it does not silently change draft/ready state. It does not mean “only draft the text”; use `--body-only` for that. |
| `--body-only` | Stop after generating and previewing the title and `pr.md` | Never pushes or calls `gh pr create/edit`. It can be combined with `--review` to save both review evidence and a PR body without publishing. It is also the fallback when `gh` is unavailable or unauthenticated. |

Options compose left-to-right through the same flow: inspect branch → optional review → generate
body → publication gate. Publication always needs an explicit final confirmation, even without
`--review`. A dirty working tree always blocks publication because uncommitted bytes are absent from
the PR; it does not prevent `--body-only` output.

Examples:

```text
/dev-pr
  Auto-detect the base, write pr.md, preview it, then offer to publish a normal PR.

/dev-pr dev --review
  Compare against dev, persist a report-only review, then offer publication if its gate allows it.

/dev-pr --draft --body-only
  Generate the proposed draft-PR title/body, but do not push or contact GitHub.

/dev-pr main --review --draft
  Review against main and, after all gates and confirmation, create a draft PR.
```

If the current branch already has a PR, `/dev-pr` previews an update to that PR instead of creating
a duplicate. The positional base is normally unnecessary in that case.

### Planning options

| Invocation | Meaning |
|---|---|
| `/dev-plan <task>` | Normal task triage. Trivial/small work stays inline (small still writes a five-line `plan.md`); medium/large use repository exploration, and require a named escalation signal. |
A task can be promoted explicitly by saying “treat this as large”.

### Review, implementation, and status options

| Invocation | Meaning |
|---|---|
| `/dev-review [scope]` | Review the supplied paths, or infer changed files. Confirmed findings are fixed by default and explicitly re-reviewed. |
| `/dev-review [scope] --no-apply` | One report-only find/verify pass. No fixes are written. Unlike `/dev-pr --review`, it does not persist a SHA-bound PR-gate artifact. |
| `/dev-implement <slug>` | Execute `.dev/<slug>/plan.md`. |
| `/dev-implement <slug> --continue` | Resume a run that stopped early, after you resolved what stopped it. Implemented steps are not redone; any that were never reviewed are folded into the next checkpoint. |
| `/dev-implement <workspace-or-plan.md>` | Execute an explicitly named workspace or plan file rather than a slug. |
| `/dev-status clean <slug>` | Preview, confirm, then delete a task workspace (its state file goes with it). |
| `/dev-status clean pr/<branch>` | Preview, confirm, then delete one standalone PR workspace. Bare `pr` never deletes all PR workspaces. |

Implementation tuning is supplied in the request as intent rather than relying on rigid flag
parsing: for example “implement `<slug>` with review disabled”, “use one review round”, “never run
scouts”, or “limit parallel steps to two”. The corresponding workflow controls are `review`,
`reviewRounds`, `scoutMode`, and `maxParallelSteps`; the skill reports any non-default choice before
the run.

## The standard cycle

### 1. Plan — `/dev-plan "add rate limiting to the public API"`

Claude triages first, and the cheap tiers are the default: **trivial** tasks are just done, **small**
ones get an inline scout and a five-line `plan.md`. Reaching **medium/large** — the multi-agent
exploration — requires naming which escalation signal fired, from a closed list, in the report. So
you can audit the choice in both directions, and override it either way ("treat this as large",
"just do it"). For medium+:

- Exploration runs in the background (~3-5 scout agents + one batched validator + a synthesizer; a few
  minutes). You'll see progress; you don't need to babysit.
- **Your checkpoint #1**: open questions. Agents collect decisions only you can make; Claude asks
  them in one batch, with options. Answer them — they reshape the plan.
- **Your checkpoint #2**: plan approval. Read the summary (full detail: `.dev/<slug>/plan.md`).
  Push back freely — adjustments are edits to the plan file, cheap. Nothing touches your code yet.

Tip: for large/ambiguous work, run `/dev-spec` first — the interview produces acceptance criteria
that make everything downstream (plan verification, reviews, final check) measurably stricter.

### 2. Implement — `/dev-implement <slug>`

Preflight: requires git; branches to `dev/<slug>` if you're on the default branch; captures the
baseline SHA; refuses to run if another implement is active in this clone. Then the workflow runs
in the background: ambiguous/oversized steps get a scout; implementers write code and **run each
step's verification**; up to five disjoint steps run in parallel by default.

Review is **not** per wave. Waves are sequential (that's what `depends_on` buys), but a full review
loop costs 7-9 agents, so waves accumulate until a review is worth paying for — and a wider scope
also lets the reviewer see the composed change. Each wave in between gets one cheap **contract
gate** instead: a single agent asking only "would a pending step hit a broken contract if work
continued right now?". A checkpoint fires on the last wave, on a `contract`-risk step, on a blocking
question, when a gate finds a real break, or when enough files/waves have piled up. A final checker
then audits the seams across all of it and runs the test suite.

- **Your checkpoint #3**: end-of-run questions (`needs_user_input`) — ambiguities where the
  implementer made the safest reversible choice and flagged it. Review them.
- The run ends with a **phase commit** and a report: per-step changes, verification results,
  deviations from the plan, review outcomes, remaining concerns. Read the deviations — that's
  where surprises live.

### 3. Review anytime — `/dev-review` or `/dev-review src/api/ --no-apply`

Standalone entry to the same review machinery, for changes made with or without the pipeline.
Default applies confirmed fixes and re-reviews until clean; `--no-apply` reports only. Ask for a
focus ("security only") to swap the lenses.

### 4. Prepare and publish — `/dev-pr --review --draft`

`/dev-pr` detects the real default/base branch, compares `base...HEAD`, matches a task workspace by
baseline/commits/file overlap, and writes a concise `pr.md`. It shows the title/body before doing
anything external. A dirty tree may produce the draft but blocks publication.

`--review` adds a report-only review: two complementary reviewers plus batched verification, with no
implicit code edits. The report is saved as `reviews/<reviewed-head>.md`:

- high/critical confirmed finding: PR publication is blocked;
- low/medium only: publication needs one extra explicit confirmation;
- clean: the normal preview/publish checkpoint follows.

Fixes go back through the review loop, seeded with what the report already proved:

```text
/dev-pr --review
  → /dev-review --from-report .dev/<slug>/reviews/<sha>.md
  → /dev-pr --review again
```

There is no separate remediation pipeline, on purpose. The report's findings were already found and
already verified, so re-finding them would risk *missing* one — the loop skips straight to fixing
them, then re-reviews explicitly, so `clean` still means a pass that found nothing. It refuses to run
unless the branch matches, `HEAD` still equals the reviewed one and the tree is clean: the findings
cite `file:line` in the reviewed commit, so on drifted code they point at something that is no longer
there. The old report cannot clear the new `HEAD` after fixes.

When the findings need an approach decision, span several subsystems, or must be applied in a set
order, they are ordinary work: `/dev-plan "fix the findings in <report>"` gets exploration, a plan
you approve, and waves — the same pipeline as everything else.

## Teaching the repo (`.claude/rules/`)

This is the one thing that makes a generic pipeline specific to *your* repo, and the only channel
that survives between cycles — agents share no memory across runs, so anything worth keeping has to
end up in the repo itself.

`.claude/rules/*.md` is a **native Claude Code** convention, not a devkit one: those files load
automatically alongside `CLAUDE.md`, and a `paths:` frontmatter key scopes one so it loads *only*
when Claude works with matching files.

```markdown
---
description: how this repo talks to the database
paths:
  - "src/db/**/*.ts"
  - "packages/*/schema/*.ts"
---
- Every query goes through the repository layer; no raw SQL in handlers.
- A migration and the code that requires it land in the same commit.
```

Two ways they get written:

**Bootstrap — `/dev-setup`.** If you have no rules yet, it proposes 3-6 files built from what you
have *already written down*: the always/never sections of `CLAUDE.md`, `CONTRIBUTING.md`, a style
guide, lint config. It will not invent a convention from reading your code, and it asks about each
file separately with the source lines shown. This pays off even if you never run the pipeline:
`CLAUDE.md` is loaded into every session, while a scoped rule is loaded only when relevant — moving
path-specific guidance out of `CLAUDE.md` makes every unrelated session cheaper.

**Ratchet — after an implement that found real problems.** Claude offers at most three proposed
edits, each citing the implementer note or confirmed review finding behind it, and you approve them
as a diff. It is deliberately narrow: a bug is not a convention, and a rulebook grown from every
individual defect is one later agents skim past. You can also just ask, any time: *"turn what we
just learned into a rule."*

What you get for it: matching rules reach scouts and implementers before they write code, and become
an extra `repo-conventions` reviewer. What you never get: a rule Claude wrote and installed on its
own. You are the curator; the rules are versioned, diffable repo content, and that is the point.

## What you are expected to do (and not do)

- **Do** answer open questions with real opinions — they're asked because agents couldn't decide.
- **Do** read plan and deviations; **don't** re-review every line the loop already cleaned (spot-
  check; the review evidence is in the report).
- **Don't** edit files while an implement runs in your clone — verifications run on your tree.
- **Do** run `/dev-status` when in doubt about what's active or stale.

## Reading the artifacts (`.dev/<slug>/`)

| File | What it tells you |
|---|---|
| `spec.md` / `plan.md` | The contract: criteria, approach, steps. The JSON block in plan.md is what actually executes — a small-tier plan is five lines and has none, because it was implemented inline. |
| `findings/<angle>.md` | Full exploration reports — read when you doubt a plan claim |
| `briefs/<id>.md` | What the implementer was told about the codebase |
| `notes/<id>.md` | The implementer's decisions and *whys* — read before questioning a choice |
| `pr.md` | Proposed public PR body; safe to edit before publication |
| `reviews/<sha>.md` | Confirmed/refuted review evidence for one exact branch HEAD |
| `state.json` | This flow's own state: stage, baseline, last run id (resume) |

When no task workspace matches a branch, `/dev-pr` uses `.dev/pr/<branch>/` instead. `/dev-status`
lists these separately; they are not registered as implementation flows.

## Cost control

Cost scales with the triage tier — that's the point of triage, and the tier is by far the largest
knob: nothing else on this list saves what not escalating saves. Claude defaults low and has to name
a signal to go up, so the cheapest correction available to you is disagreeing with that line. The
rest, roughly in order:

- **Model tier.** `profile: "cheap"` shifts every agent in a run one rung down the
  `haiku → sonnet → opus` ladder; `"max"` shifts it up. It reaches nested workflows too, so a cheap
  implement also gets cheap review checkpoints. For one role instead of all of them:
  `models: { impl: "sonnet" }` (roles: `decompose, scout, validate, synth, impl, gate, check, review,
  verify, fix`), and `efforts: { … }` for reasoning effort. Say it in your message — "run this
  cheap", "use sonnet for the implementers" — and Claude passes it through. To pin a default for the
  whole repo, put a `Cost profile:` line in `CLAUDE.md`; `/dev-setup` offers this.
- **Token budget.** Say "+300k" (or any target) **in your message** to set a hard budget the loops
  respect. Unlike the profile this stops work rather than making it cheaper: steps past the floor
  come back as `skipped_for_budget`, and a review that runs out returns `clean: false`.

  Read that literally: the floors exist *only* when you set a target. Without one there is no
  ceiling and nothing degrades gracefully — the run simply runs. This is not something the plugin
  can default for you; the budget comes from your turn, not from a config file. Every workflow now
  reports which of the two you were in (`cost.floors_active`), so at least you are never guessing.
- **Stage knobs.** `reviewRounds`/`review: false`, `scoutMode`, `maxParallelSteps` for implement;
  fewer `angles` or `validate: false` for exploration.

The completion notification of every workflow shows its total token usage, and every workflow now
also returns a per-phase breakdown (`cost.by_phase`) and logs it as it goes — so "where did the
money go" is answered by the run, not by arithmetic on notifications.

PR drafting without `--review` uses no review agents. `/dev-review --from-report` skips the find and
verify phases entirely — those were already paid for when the report was written — so it costs one
fixer plus one re-review.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/dev-*` not in autocomplete | Restart Claude Code (skills/workflows register at session start) |
| Edited a workflow, but the run behaves as before | `name:` resolution serves a snapshot from plugin load. Invoke by `scriptPath` while iterating, or restart |
| "Workflow not found" | Same restart; meanwhile skills fall back to `scriptPath` automatically |
| Implement crashed midway | `lastRunId` is in `.dev/<slug>/state.json` — ask Claude to resume; completed steps replay from cache |
| Implement *stopped* midway (blocking question, unclean checkpoint, failed step, budget) | Not a crash — that is the design. Resolve what stopped it, then `/dev-implement <slug> --continue` |
| Implementer wrote code/notes but has no result | Inspect rejected `StructuredOutput` calls; classify `result_serialization_failed`, not `implementation_failed` |
| "Where did that review finding go?" | Refuted findings remain in the workflow result and `journal.jsonl` for audit |
| PR review says it is stale | Its `reviewed_head` differs from `HEAD`; run `/dev-pr --review` again |
| PR review found real bugs | Run the offered `/dev-review --from-report <report.md>`, then `/dev-pr --review` again |
| `gh` missing or not authenticated | `/dev-pr --body-only` still writes/returns the title and `pr.md`; publish manually or authenticate later |
| Working tree is dirty | Commit/stash/discard intentionally; `/dev-pr` will draft but not publish bytes absent from `HEAD` |
| Flow stuck at `implementing` | `/dev-status` — if no task is running, mark it abandoned |
| Two teammates, same repo | Fine — `.dev/` is per-clone. Two implements in *one* clone: blocked, on purpose |
| Agents keep missing the same repo quirk | Nothing carries over between cycles. After an implement that found real problems, Claude offers to propose up to three edits to `.claude/rules/*.md` — accept them and every future agent touching those files reads it. You can also ask directly: "turn what we just learned into a rule" |

## Extending safely

Parameters first (lenses, angles, rounds — no code changes), then this repo's own
`.claude/rules/*.md` for anything repo-specific, then a one-off workflow script for a shape the
canned ones don't cover (house rules in the architecture doc), and only then a change to the
plugin — guided by the calibration checklist. Treat prompts as code, and mind the blast radius: a
plugin change ships to *every* project you work on, not just this one.
