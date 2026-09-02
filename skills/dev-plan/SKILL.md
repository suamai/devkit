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

This mode writes a ledger line too — it spent a full fan-out, and a phase whose cost is invisible
makes the tokens-per-phase row understate what planning costs. Same `scripts/ledger-append.sh`
heredoc as the two write sites below, with `{"phase":"plan","mode":"explain",…}`, the `slug`,
`run_id` and `cost` verbatim, and **no `tier`** — nothing was triaged here, and inventing one would
put a fabricated row into the escalation rate. That is why the reader counts only lines that carry a
`tier`. This is the mode's own write site; it does not reach the two below, and it never writes twice.

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

`.dev/<slug>/state.json` — `{ task, stage: "plan-ready", updated }` plus one `runs` entry,
`{ phase: "plan", ts, tier: "small" }`, so `/dev-status` sees the flow at all, `/dev-pr` can find the
intent, and the surviving copy of the evidence covers this tier too — `runs` holds one entry per
phase run of a workspace, and a small-tier plan is a phase run. It carries no numbers because no
workflow produced any; that is the entry, not a stub of one. Set `stage: "implemented"` once the
inline work is verified.

Two workspace files, no workflow, no approval round — that is the entire ceremony. Don't let it
grow: a small-tier `plan.md` that wants a steps block was a medium task, and the honest move is to
name the signal and escalate.

## The ledger line — trivial and small

Then record the run. Every `/dev-plan` invocation appends **exactly one** `plan` line to the run
ledger, and the cheap tiers are the ones that matter most here: without their lines the escalation
rate the calibration report prints is 100% by construction, and the row is a lie. So the trivial
tier writes one too — right after you have stated the tier and made (or declined) the edit:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/ledger-append.sh" <<'JSON'
{"phase":"plan","tier":"small","slug":"retry-policy","concurrent":"unknown"}
JSON
```

The **quoted** heredoc is the carrier: nothing expands, so quotes and apostrophes inside a value
reach the file byte-for-byte. `tier` always. `slug` only once a workspace exists — the trivial tier
has none, so it omits the field rather than inventing one. `signal` only when one actually fired,
which at these tiers is never, so it is omitted too. Nothing else: no workflow ran, so there is no
`cost`, no `run_id` and no projection, and a field you do not have is **omitted, never guessed**.
`concurrent` is `"unknown"` unless you genuinely checked (see step 7).

This is one of **exactly three** write sites in this skill, and they are mutually exclusive: an
`--explain` run writes at the top of this file, the low tiers write here, and a medium/large run
writes once at step 7. No invocation reaches two of them. In particular, a small tier whose inline
scout escalates (§0) writes **nothing** here: that invocation became a medium run, and its one line
goes out at step 7 with the tier it ended at and the signal that fired. If the append fails it prints
one line to stderr; mention it in one sentence and carry on. A lost ledger line is never a failed
phase.

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

   Optional: `angles` to override angle decomposition when the developer already told you what to investigate — an array of objects `{name, focus, why, hints?}`, with a plain string accepted as shorthand for that angle's `focus`; a malformed entry throws before any agent is spawned, so a wrong shape costs the call and nothing else; `validate: false` skips the single batched validation pass for cost-sensitive planning; `profile`/`models`/`efforts` set the model tiers (see Cost below). If the workflow name does not resolve (the plugin has not loaded in this session yet), invoke with `scriptPath` pointing at `${CLAUDE_PLUGIN_ROOT}/workflows/wf-explore-plan.js`. Runs in background; you'll be notified. While waiting, do nothing speculative.

4. **Interrupt point — open questions.** The result contains `open_questions` (decisions only the developer can make). If non-empty, push a notification **first**, then surface them via AskUserQuestion (use the provided `options`). Fold answers into the plan: edit `<workspace>/plan.md` yourself — including the machine-readable JSON steps block — or, if an answer invalidates the approach, re-run the workflow with the answers appended to `constraints`.

   The notification is the **`PushNotification`** tool, called once with `{ message, status: "proactive" }` — one line, ≤200 characters, no markdown, e.g. `plan ready for retry-policy: 3 open questions need your call`. If it is not in the current tool set, `ToolSearch` for it first. It is **not** the background-workflow completion ping step 3 mentions: that one fires by itself when the workflow returns and only says the run finished, while this one says the run is *blocked on a person* — the one thing worth pulling the developer back for. A `not sent` result means they are already at the terminal: expected, not an error, and never retried.

5. **Lint the plan before presenting it.** Zero agents, zero tokens, one call:
   ```
   Workflow({ name: "devkit:wf-implement", args: { dryRun: true, steps, rules, criteria } })
   ```
   `args.criteria` is the spec's acceptance-criterion ids, and **you** extract them: a workflow script
   has no filesystem access, the same reason `rules` arrives pre-extracted. Read them out of the spec
   with the command rather than by eye:

   ```bash
   grep -oE '^[[:space:]]*[-*][[:space:]]*(\*\*)?AC-[0-9]+' "<workspace>/spec.md" | grep -oE 'AC-[0-9]+'
   ```

   Pass what it prints, in document order and **not deduplicated** — a spec declaring one id twice is
   a defect the lint exists to report, and quietly de-duplicating on the way in is how that defect
   reaches the acceptance matrix instead. No `spec.md`, or the command prints nothing: pass no
   `criteria` at all and say so in one line. Never complete or repair the list from memory or from the
   plan's own `covers` — a fabricated id makes the lint compare the plan against an invention, and
   deriving the ids from `covers` makes an unknown id undetectable by construction.

   It returns `schedule`: the dependency waves, which steps *actually* run in parallel
   (`parallel_groups` — only disjoint declared files do), which get a scout, which repo rules match,
   where review checkpoints would fire and why, `warnings`, and `agents_min`. Fix what it finds
   before the developer sees the plan — the coverage warnings below are the one exception; a plan
   that lints badly is cheaper to fix now than after an implement run. Two `warnings` are worth
   acting on rather than reporting: steps with overlapping files and no dependency (they cost the
   parallelism the plan appears to have), and a step with no `verify` (it can only ever come back
   `unverified`). It also lints each step's `verify` **command** itself: one that deletes,
   force-pushes, publishes, deploys, migrates data or reaches an external service; one that is a
   synthesized shell pipeline where a project-declared script would do; and one aggregated line
   naming every command it does not recognize, which is surfaced and then **proceeds** — an
   unfamiliar runner is not a claim that the command is unsafe.

   **The three coverage warnings are surfaced, not silently fixed.** They are the only lint output
   that judges the plan against the *spec*, and two of the three are not yours to settle:
   - an **unknown id** — a step's `covers` naming a criterion the spec does not have — and a
     **duplicate id** — one step listing an id twice, or the spec itself declaring one id twice — are
     plan defects. Fix them before presenting, and still say what you fixed: an invented id usually
     means the step is covering something nobody wrote down.
   - a **criterion covered by no step** is the developer's decision, not a defect. A suite-level check
     is a legitimate cover, and so is deciding a criterion is out of this plan's scope. Report it and
     let them answer. Never auto-patch it by adding a `covers` entry to the nearest plausible step:
     that manufactures evidence for a criterion nothing was written to satisfy, and the acceptance
     matrix will later repeat it as fact.

   State all three with the wave shape in step 6, before the approval checkpoint — they are about
   what the plan promises to prove, which is exactly what the developer is approving.

   **Render the projection as a cost quote**, and present it with the plan in step 6. The developer
   is about to approve a number of agents, so it is stated as a bound with its escape hatches named,
   never as an estimate:

   ```
   Cost quote — a static floor, not an estimate
     Agents floor    : 21 (floor: scouts + one implementer per step + gates + ~4 per review
                       checkpoint + the final consistency check)
     Checkpoints     : 2 (contract-risk step; final wave) — they fire earlier, never later
     Largest variable: review checkpoints — 2 × ~4 agents
     Only ever adds  : gate breaks, blocking questions, extra review rounds, oversized-step splits
     Profile         : default (shipped tiers)
   ```

   Every number is read off the lint's `schedule`, none of them invented: the floor and the note
   beside it are `agents_min` and `agents_min_note` (its first sentence — the rest is the
   `Only ever adds` line); the checkpoints and their reasons are `waves[].checkpoint.{number,reason}`;
   scouts are `waves[].scouts`. **Largest variable** is *derived*: compare `checkpoints × 4`, the step
   count, the scout count and the gate count, and name whichever is biggest with its count — that is
   the term worth arguing about if the quote is too high, and the only one the plan can still change.

   Both honesty facts belong inside the quote rather than in a footnote, because they are what makes
   it a bound: checkpoints can fire **earlier** than shown and never later, since a blocking question
   or a contract-gate break also forces one and neither is knowable before the agents run; and
   `agents_min` is a floor — everything on the `Only ever adds` line adds agents and nothing
   subtracts any.

6. **Present the plan.** Lead with the exploration's `cost` (`by_phase`: decompose / explore /
   validate / synthesize, plus `total`) — it is the developer's calibration data and it is what makes
   the next `angles`/`validate: false` decision an informed one. Then concise prose: the approach, the step list with dependencies/parallelism, risks, and what was dropped as refuted during validation (`dropped_claims`). Full detail is in `plan.md`; scout reports in `<workspace>/findings/`. Then stop — the developer reviews; apply their adjustments to the plan file (keep the JSON block in sync).

   **Historically — a separate paragraph, never a blended number.** Part of that same presentation,
   beside the quote and before you stop: run `ledger-report.sh --quote` once,

   ```bash
   sh "${CLAUDE_PLUGIN_ROOT}/scripts/ledger-report.sh" --quote --phase implement --tier <tier> --profile <profile>
   ```

   and paste its single line verbatim under the label `Historically (your ledger, not a promise):`.
   `--phase implement` because that is the run being quoted; `--tier <tier>` is the tier §0 triaged
   this plan at — implement lines *do* carry `tier`, carried over from the plan that triaged them
   specifically so this quote can filter on it (`docs/architecture.md` → "The run ledger"), and
   comparability is phase + tier + profile: leaving `--tier` off would blend runs of an unrelated tier
   into the median. `--profile` is the profile the implement run will use, which is `default` when
   nothing was overridden (a ledger line records `profile` only when it was). Leaving an argument off
   widens the query rather than filtering on absence. If the script answers `n=0 comparable runs` or
   `n=<count> — sample too small to quote (need 3)`, print **that** — an absent history is a result,
   and a range extrapolated from two runs is exactly the confidently weak number this whole quote
   exists to avoid. Keep it in its own paragraph: the block above is arithmetic on *this* plan, this
   line is what runs of the same shape actually cost you, and averaging the two produces a number
   backed by nothing.

   Two per-step fields shape what implementation costs, so sanity-check them rather than passing them
   through: `risk` (`contract` earns an immediate review checkpoint) and `context_confidence`
   (`low` spawns an exploration agent for that step, `high` skips it). If every step came back `low`,
   the plan is admitting it is vague — worth a look before approval; if a step you know is
   hand-waved came back `high`, fix it.

   State the **wave shape** from the lint's `schedule` (e.g. "3 waves: s1+s2 → s3 → s4+s5"), and with
   it the **coverage warnings** step 5 collected — one line each, in the same breath, before you stop
   for approval: which criteria no step covers, and which `covers` ids you corrected and how. The
   developer is approving what this plan will and will not prove, so an uncovered criterion is a
   question for them here rather than a discovery at `/dev-pr`. Waves are the sequential spine of
   implementation, so a deep chain of single steps is worth challenging at approval time, not after:
   check whether each `depends_on` is a hard dependency (the other step's code must exist to
   compile/run/verify) rather than reading order, and propose flattening or merging when it isn't.
   The workflow logs a warning for a suspiciously deep chain — relay it if present.

7. **Handoff.** On approval, set `stage: "plan-ready"` in `<workspace>/state.json`, and store the
   result's `findings` array there too — that is what makes a later run in this workspace skip
   re-exploring. In the same write, **append** one entry to that file's `runs` array —
   `{ phase: "plan", ts, run_id, tier, signal?, agents_projected, cost_total, floors_active }` — `ts`
   is plain `YYYY-MM-DD HH:MM`, matching `updated` (`/dev-status`'s Notes) — append only, never
   rewriting an earlier entry: `/dev-status archive <slug>` keeps this file and
   deletes the bulk, so it is the copy of the evidence that survives when the ledger does not.

   **Record the plan's freshness in that same write.** `/dev-implement`'s preflight has to know which
   tree this plan was written against, and this is the **one** place that contract is stated — the
   other skill reads these four values, re-runs these same commands against the tree it is about to
   implement into, and derives nothing a second way. So `state.json` gains a nested `plan_freshness`
   object beside `stage`: `{ planned_at_sha, steps_sha, spec_sha, plugin_commit }`. Each is one
   command, run here, at handoff:

   ````bash
   git rev-parse HEAD                                             # planned_at_sha
   awk '/^## Machine-readable steps/,0' "<workspace>/plan.md" \
     | sed -n '/^```json$/,/^```$/p' | sed '1d;$d' | git hash-object --stdin    # steps_sha
   git hash-object "<workspace>/spec.md"                          # spec_sha
   head -n 1 "${CLAUDE_PLUGIN_ROOT}/FROZEN_AT"                    # plugin_commit
   ````

   `steps_sha` hashes the machine-readable steps block **as it stands on disk** — run it after step 4's
   edits and after anything the developer changed at the checkpoint, because hashing what the workflow
   returned would certify a plan nobody is going to implement. `git hash-object`, never
   `shasum`/`sha256sum`: git is already required by this phase, and those two are not portable across
   macOS and Linux, so the writing skill and the reading skill would compute different digests on
   different machines.

   Two of the four are conditional, and a value you cannot read is **omitted, never fabricated**:
   `spec_sha` only when the workspace has a `spec.md`, and `plugin_commit` only when `FROZEN_AT`
   exists — it is written by `scripts/promote-plugin.sh` into a frozen install, so a run driven from a
   checkout simply has no plugin commit. At the other end an absent field reads as *unknown* and is
   skipped; an invented one reads as *checked, and fine*.

   Then suggest `/dev-implement <slug>` (or continue yourself if asked).

   **The ledger line — the last of the three write sites.** One `plan` line per invocation, written
   here for medium and large only. The low tiers wrote theirs already; never both. Same
   `scripts/ledger-append.sh` heredoc as above (unindented, so the closing `JSON` starts its own
   line), with a fuller body:

   ```json
   {"phase":"plan","slug":"retry-policy","tier":"medium","signal":"contract-change","open_questions":2,"waves":3,"parallel_groups":2,"scouts_projected":4,"agents_projected":21,"run_id":"wf-2f1c","concurrent":"unknown","cost":{"by_phase":{"decompose":900,"explore":31000,"validate":8100,"synthesize":12000},"total":52000,"budget_total":null,"floors_active":false}}
   ```

   Every value is a number, a boolean or a top-level string — the reader parses by key, so a string
   never goes inside `cost`. `tier` always; `signal` only when one fired, **comma-separated when
   several did** — the reader counts each separately, so joining them is how a signal stops being
   counted; `slug` whenever a workspace
   exists. Four come from the step-5 lint's `schedule`: `waves` = `schedule.waves.length`,
   `parallel_groups` = how many `waves[].parallel_groups` hold more than one step,
   `scouts_projected` = the total length of `waves[].scouts`, `agents_projected` = `agents_min`.
   `run_id` and `cost` — the whole object, **verbatim** — come from the workflow result;
   `open_questions` is how many step 4 surfaced, a count and not the questions themselves;
   `profile`/`models`/`efforts` only when you overrode them. Omit whatever you do not have.

   `concurrent` is `false` **only** if you actually looked (TaskList showed no other workflow when
   you launched this one), `true` if you found one, and `"unknown"` otherwise. Never a guessed
   `false`: that field is the only thing telling the calibration report whether these token numbers
   can be trusted, since `budget.spent()` counts the whole turn and cannot see a second workflow.

   The line records the planning *run*, not the approval — so if the developer declines at the
   checkpoint or the run ends there, write it then, once, and say so in the report. Dropping it would
   bias every rate the report prints toward plans that happened to be approved. And as at the low
   tiers, a failed append is one sentence in the report and never a failed phase.

## Cost

Every workflow takes the same three cost args, and every skill passes them through:
`profile: "cheap" | "default" | "max"` selects a column of a per-role model table rather than
shifting everything one rung: `cheap` leaves the judging roles on sonnet, and `max` spends `fable`
only where an agent authors or synthesises. `models: { <role>: "haiku|sonnet|opus|fable" }` and
`efforts: { <role>: "low|…|max" }` override one role and beat the profile. Roles are pipeline-wide
(`decompose, scout, validate, synth, impl, gate, check, review, verify, fix, run`), so one object
covers a workflow and everything it calls. An unknown role or value throws before any agent runs —
check it with `dryRun: true`, which returns the resolved policy. Omitting all three reproduces the
shipped tiers exactly — that is the table's `default` column, stated rather than derived. Default it
from the repo's `Cost profile:` line in CLAUDE.md when one is present.

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
