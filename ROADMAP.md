# Roadmap — open improvements

What is left after two cleanup passes (doc/code drift, dead machinery) and the move to a plugin.

Ordered by what I'd do first, on one criterion: **0-3 stop the pipeline from losing work** (the thing
that actually hurts in use), **7-8 make changing a prompt stop being a bet**, and the rest is
capability.

Calibration knobs — clustering ratio, split rate, round convergence, tokens per phase — live in
`docs/architecture.md` ("First-run calibration checklist"). Those are tuning; this is change.

## Standing rules

Constraints that apply to every item below. Each one is here because we caught ourselves breaking it.

- **No migration paths for scratch state.** `.dev/` is gitignored, per-clone and disposable, so a
  format change costs `rm -rf .dev/<slug>` — never a migration step, a legacy reader or a version
  field. Such a path is speculative machinery for a state the world cannot be in, and it outlives
  the format that justified it: nobody deletes a compatibility shim, because nobody can prove it is
  unused. Before writing one, name the artifact that would actually be in the old format and say
  where it is stored. If the answer is scratch, delete instead. *(Caught in #2: a legacy
  `.dev/state.json` splitter was added, then removed.)*

---

## 0. Run it once

**Now:** `git log` says the repo has no commits. `~/.claude/skills/` is empty, no marketplace points
here, `.claude-plugin/marketplace.json` does not exist. **The plugin has never run in this form.**

That is not a hygiene detail: four items below (#8 evals, #9 remediation's fate, the calibration
checklist, half of the risk estimates) depend on transcripts from real cycles that do not exist yet.
Everything else assumes this is done.

**Change:** commit the repo, install it, run `/dev-setup` in a real project, run one full
`/dev-plan → /dev-implement` cycle. Then the cheap verifications that are currently scattered as
assumptions:

**Status:** committed, `marketplace.json` added, installed via `~/.claude/skills/devkit` symlink,
all four workflows pass `dryRun` (0 agents, 0 tokens), plugin loads. What each verification found:

- **What the command is actually called.** ✅ Answered: everything is namespaced, and **skills and
  workflows share one flat namespace** — the listing mixes `devkit:dev-implement` (skill) with the
  workflow names. That produced a confusable pair: `devkit:dev-implement` vs `devkit:implement`, one
  character apart, where the near miss silently hands you the raw workflow instead of the skill.
  **Fixed:** all four workflows now carry a `wf-` prefix (`devkit:wf-implement`,
  `wf-explore-plan`, `wf-review-loop`, `wf-plan-remediation`), which makes the control-plane /
  data-plane split legible in the autocomplete and frees the bare names.
- **Should the skills drop `dev-`?** Now unblocked by the `wf-` prefix, but still conditional, and
  the argument inverts on one fact: if the CLI *requires* the namespaced form, `/devkit:plan` beats
  `/devkit:dev-plan` and the rename is worth it; if the CLI accepts a **short form**, `/dev-plan`
  already works and is distinctive, while `/plan`, `/review`, `/pr`, `/status` are generic enough to
  collide the day another plugin ships one — and you would be pushed back to `/devkit:plan` having
  paid for the rename anyway. Check the autocomplete before deciding.
- **Workflows re-registered mid-session.** Renaming the four files made them appear as
  `devkit:wf-*` without a restart, which contradicts "new or renamed workflow files register on
  session start" (`docs/architecture.md` "Distribution", and the manual's troubleshooting table).
  Observed once, for a *rename*; confirm whether a brand-new file behaves the same before rewriting
  that guidance.
- **Docs still say `/dev-plan`.** 119 occurrences across nine files, written before namespacing was
  known. Fix them to whatever form the CLI actually accepts (check whether the bare short form
  resolves when unambiguous, or only `/devkit:dev-*` does).
- **`${CLAUDE_PLUGIN_ROOT}` inside a SKILL.md body.** Still open — the `scriptPath` fallback in five
  skills rests on it. `/devkit:dev-setup` step 6 answers it for free.
- **`.claude-plugin/marketplace.json`.** ✅ Added, self-hosted (`"source": "./"`). Still untested:
  whether declaring it in a *project's* `.claude/settings.json` (`extraKnownMarketplaces` +
  `enabledPlugins`, `docs/architecture.md` "Distribution") actually prompts a teammate on clone.
- **What the smoke test did NOT cover.** `dryRun` returns before any logic runs, so it proved the
  four scripts parse and their `meta` blocks load — nothing about `toWaves`, `disjoint`,
  `globToRegExp` or the finding-identity pool. That is item 7(b), and this is the evidence for it.

## 1. Close the hole in the honesty gate — ✅ done

**Now:** `IMPL_SCHEMA.verify_run` requires only `ran` (`wf-implement.js:85-95`), and the classification
is:

```js
const verifyFailed = impl.verify_run && impl.verify_run.ran && impl.verify_run.passed === false
const unverified   = !verifyFailed && (!impl.verify_run || impl.verify_run.ran !== true)
```

An implementer returning `{ran: true}` with no `command` and no `passed` is recorded as verified and
not failed. The product's strongest claim — "a step that ran no executable check is reported
`unverified`, never as success" — is defeated by one boolean.

**Change:** `ran === true` without a `command`, or with `passed !== true`, falls through to
unverified (or failed, when `passed === false`). Five lines in `runStep`, plus one sentence in the
prompt saying the fields travel together.

**Why first:** it is the cheapest change on the list and it defends the claim the whole pipeline is
sold on.

**Done:** verified now means all three fields — `ran === true`, a non-blank `command`, and
`passed === true`. Anything less degrades to `unverified` carrying a `reason` that distinguishes the
honest case (`ran: false` plus `not_ran_reason`) from the unevidenced claim ("claimed ran=true
without naming the command it ran"). That reason travels to the checkpoint reviewer's priority
list, the final consistency check and the skill's report, so an implementer asserting verification
it did not substantiate is now visible rather than silently counted as success.

`tests/verify-gate.test.js` locks the truth table — 9 cases including the hole itself. It runs the
*shipped* lines: it reads `wf-implement.js` off disk and extracts the classification block by its
anchors rather than copying it, and throws if the anchors move (fail-closed, never a silent pass).
That anchor trick is a stopgap; 7(b) replaces it with a `dryRun` that returns real computed output.

## 2. Kill the global `.dev/state.json` — ✅ done

**Now:** one shared registry, written by four different skills
(`dev-spec/SKILL.md:24`, `dev-plan/SKILL.md:63,87`, `dev-implement/SKILL.md:20,68`,
`dev-status/SKILL.md:7,25`), each carrying prose to sustain the invariant "skills in the main loop
are its ONLY writers", plus staleness reconciliation, untracked-flow recovery and a repo-wide
advisory lock.

**Change:** move state into each workspace — `.dev/<slug>/state.json`. One writer _by
construction_; no shared file to corrupt. `/dev-status` becomes a glob plus a read, and the whole
"untracked flow" concept disappears because the directory *is* the record.

**Cost:** touches five skills. The advisory lock does want a global view ("is any implement running
in this clone?") — but that is `glob .dev/*/state.json | grep implementing`, not a new file. Do not
introduce a `.dev/lock.json`: it reintroduces the shared writer under another name. The precedent is
already in the design and already works — remediation deliberately carries no state and
`/dev-status` reads it off disk (`docs/architecture.md`, "Flow state & concurrency").

**Why here:** it deletes a class of defensive instruction, and it is the precondition for #3, which
is the real prize.

**Done:** state moved to `.dev/<slug>/state.json`, same shape minus the `flows` wrapper (the
directory names the flow). The lock is a glob for any workspace at `implementing` — no `lock.json`,
as argued above. Three pieces of defensive prose went away rather than being restated: the
"skills are its ONLY writers" invariant (now structural — state sits inside the thing it
describes, so there is no shared file to race on), the untracked-flow recovery path (a directory
without a state file is just a missing file, and its stage is inferable from its artifacts, which is
what `/dev-status` already did for remediations), and the separate "delete the entry" step in
`clean` (the file lives inside the directory being deleted).

`/dev-status` briefly gained a legacy check that split an old top-level `.dev/state.json` into
per-workspace files. It was removed the same day: `.dev/` is scratch, so the migration is
`rm -rf .dev/<slug>`. That mistake is what produced the first standing rule above — the net change
here is subtraction only.

## 3. Make resuming an implement a first-class path — ✅ done

**Now:** `wf-implement.js` stops early *by design* in four situations — a blocking question
(`:524-531`), a checkpoint that did not go clean (`:614-631`), a failed step, the budget floor
(`:360`). That design is right. But the continuation is not a path: the developer has to get Claude
to reconstruct `Workflow({scriptPath, resumeFromRunId, args: <the same>})`, and "the same args"
includes the whole `steps` array. Worse, after answering a blocking question the args legitimately
change (the answer belongs in `notes`), which invalidates the resume cache exactly where reuse was
wanted.

**Change:** a `continue` mode. Persist the exact args of a run (`.dev/<slug>/last-run.json`) and
which steps completed; re-invoke with only the pending steps plus the answer folded into `notes`.
`resumeFromRunId` stays as the crash-recovery path — this is the *planned* stop, which is a
different thing and deserves its own affordance.

**Why:** the workflow is built to stop and hand back. Right now handing back costs the developer
more than the work it saved. Depends on #2 for the "which steps completed" half.

**Done:** `wf-implement` takes a `completed` arg and returns a `continuation` block ready to be
passed straight back; `/dev-implement <slug> --continue` reads `<workspace>/last-run.json` for the
previous args, so a continuation survives a new session or a compaction.

Two things fell out of building it that the plan above had wrong:

- **The caller must pass the FULL steps array, not the pending ones.** `toWaves()` rejects a
  `depends_on` naming an id it cannot see, so handing it only the remaining steps throws
  immediately. The graph surgery — dropping completed ids from `depends_on` — belongs in the script,
  where it is five lines and testable, not in prose telling a skill to edit a dependency graph.
  `tests/continuation.test.js` covers it, including the negative case that proves why.
- **"Implemented" and "reviewed" are different states.** A run that stops early usually leaves
  `unreviewedWaves`: code in the tree that no checkpoint judged. Treating those as simply "done"
  would silently ship unreviewed work — the one thing a continuation must not do. So each
  `completed` entry carries `reviewed`, and entries with `reviewed !== true` are re-seeded into the
  next checkpoint's scope as reports with no agent behind them. This is also why the skill is told
  never to hand-edit that field.

## 4. Invert the triage bias, and make `small` leave an artifact — ✅ done

**Now:** `dev-plan/SKILL.md` opens with a good triage table (trivial / small / medium / large) that
is the main thing standing between a typo and thirty agents. But it's prose, and a model under
pressure to be thorough will reach for "medium". Separately, the `small` tier produces "a short plan
in chat" — which evaporates.

**Change:** (a) make trivial/small the default and require a stated positive reason to escalate —
one line, in the report, naming which signal fired, chosen from a closed list. Cheap to write, and
it makes the escalation auditable in both directions. (b) `small` still writes a five-line
`.dev/<slug>/plan.md`: `/dev-pr` (step 2) and `/dev-review` both depend on *intent*, and a tier that
leaves nothing behind makes the rest of the pipeline weaker for the change most likely to reach it.

**Done:** `dev-plan/SKILL.md` §0 rewritten, plus a `Small tier` section; propagated to README,
`docs/manual.md` (four places, including Cost control) and the architecture diagram. Two things the
plan didn't anticipate:

- **"Require a positive reason" is gameable by not looking.** Any signal phrased as an absence —
  "I can't name the files" — is satisfiable for free by never running the grep. So the closed list
  is preceded by a **look-before-you-triage** rule, and `unknown-code` is worded as *you looked and
  still cannot*. Without that, the escalation gate is decorative: the model writes the required
  sentence and escalates anyway.
- **The signals had to be facts about the work, not sizes.** The old table graded by magnitude
  ("multi-file", "real unknowns"), which is exactly the axis a model inflates under pressure to be
  thorough. The five signals (`unknown-code`, `contract-change`, `independent-parts`,
  `needs-approval`, `no-spec`) each name something the full flow actually buys — parallel
  exploration, contract gates, wave parallelism, an approval checkpoint, a spec. If none is being
  bought, the fan-out is being paid for nothing, which is the argument the tier line now has to make.

Also stated the escalation asymmetry explicitly, since it is what makes the bias rational rather
than merely frugal: going up mid-flight costs one already-useful scout, going up wrongly at the
start costs 3-5 scouts, a validator, a synthesizer and an approval round. And `dev-implement` step 1
now rejects a `Tier: small` plan instead of reconstructing a steps array to fan a one-file change
out across agents. No test: this item is entirely prose, and the behavior it changes is a judgment
call made by a model at runtime — item 7's evals are where it becomes checkable.

## 5. Model tier and effort as parameters, not constants — ✅ done

**Now:** every tier is hardcoded — `model: 'opus'` on the implementer (`workflows/wf-implement.js:387`)
and the consistency check (`:660`), on the plan synthesizer (`workflows/wf-explore-plan.js:250`);
`'sonnet'` everywhere else. `haiku` is never used, and `effort` — available per `agent()` call — is
never passed at all. The implementer is the single biggest cost driver in the pipeline, since it
runs once per step.

**Change:** accept a `models` arg (`{scout, impl, review, synth}`) or a coarse
`profile: 'cheap' | 'default' | 'max'`, defaulting to today's split, and pass `effort` alongside it —
`low` on the mechanical stages (decompose, gate, fix), higher only on verify and synthesis. The
contract gate and the angle decomposition are haiku-shaped work being done by sonnet. The skills
pass it through; `/dev-setup` could let a repo pin a default.

**Watch:** `meta.phases` carries a `model:` label per phase and must be a pure literal, so once the
model is a parameter those labels are cosmetic. Either drop them or accept they can lie.

**Why:** a side project and a production repo do not deserve the same budget, and right now the only
way to spend less is to disable stages wholesale.

**Done:** all four workflows resolve `profile` / `models` / `efforts` through one `policy()` block at
startup; no `model:` literal survives outside a role default. `tests/policy.test.js` covers it (18
cases). Five things the plan had wrong or hadn't reached:

- **Keyed by role, not by phase.** Phase names are per-workflow, and `wf-implement` calls
  `wf-review-loop` — with per-phase keys, a policy could not survive the nesting, and a cheap
  implement whose review checkpoints run at full price is not a cheap run. So roles are one
  pipeline-wide vocabulary and the args pass through the `workflow()` call unchanged.
- **Which forced a rule about unknown keys.** Passing `{ review: 'haiku' }` to `wf-implement` means
  a role it doesn't own, so unknown-to-*this*-workflow must be ignored. But silently ignoring
  everything means `{ implement: 'haiku' }` — a plausible typo for `impl` — quietly runs at full
  price. Validating against the *pipeline-wide* list gets both: foreign roles pass through, invented
  ones throw before an agent spawns.
- **Declined to make the contract gate haiku.** The plan named it as haiku-shaped, and it is even
  labelled "one cheap agent per wave", but its failure modes are not symmetric: a gate that wrongly
  reports breaks costs one review, while a gate that wrongly reports *clean* is worse than no gate,
  because the pipeline then trusts it. Cheap is one arg away; it is not the default. The only default
  that did change is `decompose` at `effort: 'low'` — task text in, angle names out, no code read —
  because inheriting a session running at high effort meant paying high effort for near-templating.
- **Escalation had to become relative.** "opus only for critical defects" is a hardcoded tier, so
  under a cheap profile the critical path would have been the *only* thing still at full price, and
  under a max profile it would have meant nothing at all. A critical finding now buys one rung above
  the run's own fix tier.
- **The `meta.phases` `model:` labels are gone, not accepted as lies.** The Watch was right that a
  pure-literal label cannot track a parameter. Deleting them loses nothing, because the replacement
  is better than a static label ever was: `policy()` logs the resolved tiers when a run is tuned
  (silent otherwise), and `dryRun` now returns the whole resolved policy — so a cost setting is
  checkable for free, before it can spend anything.

Self-contained scripts cannot import a shared helper, so `policy()` is copied into all four files.
The test asserts the four copies are byte-identical, which is the only thing that makes the
duplication safe. Repo-level defaults landed without the config file the plan implied: `/dev-setup`
adds a `Cost profile:` line to `CLAUDE.md`, which is already in every session's context and is
committed with the repo — no format, no precedence rules, no parser, and unlike anything under
`.dev/` it reaches whoever clones the repo.

## 6. Make the `.claude/rules/` contract explicit

**Now:** the pipeline reads path-scoped rules, matches them per step, and turns matching ones into a
third review lens. Under a plugin it is the *only* way a repo specializes the pipeline, since a
project can no longer fork a prompt. But the extraction is one long awk one-liner
(`dev-implement/SKILL.md:54`) that scrapes any `-` item out of the first frontmatter block regardless
of key, and matching happens in two places with two mechanisms: real glob code in `wf-implement.js`
(`globToRegExp`/`ruleMatchesFile`) versus prose telling the main loop to figure it out for
`/dev-review`.

**Change:** define the frontmatter contract, parse `paths:` properly rather than "any list item",
and let one mechanism do the matching for both callers (pass `rules: [{path, globs}]` to
`wf-review-loop` too, as `wf-implement.js` already does internally).

**Also verify:** the comment at `wf-implement.js:194-196` claims rules "load lazily for the main
session". `.claude/rules/` appears in no other plugin and is not a native Claude Code convention —
it is a devkit invention, so probably nothing loads them lazily. Either prove the claim or delete
it. If nothing native reads these files, the `paths:` contract is yours alone to define — and it is
worth one paragraph comparing it against nested `CLAUDE.md`, which *is* picked up natively.

## 7. Eval cases, and a `dryRun` that actually runs something

**Now:** prompts are tuned by reading transcripts and arguing about them. And the pure logic in the
workflow scripts — `toWaves`, `disjoint`/`pathScope`, `globToRegExp`/`ruleMatchesFile`, and the
finding-identity pool at `wf-implement.js:577-613` — has real edge cases and zero tests. A bug there
means wrong parallelization or a checkpoint silently unblocked. They can't be imported (the scripts
are self-contained by runtime requirement), so there is no obvious harness. Meanwhile `dryRun`
returns `{ok: true}` before any logic runs (`wf-implement.js:28`): it tests that the file parses.

**Change:** two halves that pay for each other.

- (a) `claude plugin eval` over `evals/**/case.yaml`, including a no-plugin baseline arm. Scope them
  to **decision points**, not whole pipelines: does triage pick the right tier for a typo vs. a
  cross-cutting change; does the verifier refuse to confirm an unreachable defect; does the
  implementer report `unverified` instead of claiming success when no check is possible.
- (b) `dryRun` with `steps` returns the computed schedule — waves, disjoint batches, matched rules —
  instead of a constant. That is a zero-cost plan lint `/dev-plan` can show before approval, *and*
  it is the only harness through which that pure logic becomes testable without contorting the
  scripts.

**Why:** it turns "this prompt feels better" into evidence, and it is the only thing that makes
tuning safe once a change ships to every project at once.

## 8. Report cost per phase; stop over-promising on budget

**Now:** the calibration checklist asks the developer to read `subagent_tokens` off completion
notifications by hand. And every budget guard is `if (budget.total && ...)` — `budget.total` exists
only when the user typed "+300k" in the message, so the 20k/30k/40k floors the docs present as
protection (`wf-review-loop.js:228`, `wf-implement.js:360,459`) never fire in normal use.

**Change:** (a) bracket each phase with `budget.spent()` and `log()` the delta, so the run reports
its own calibration data — which feeds #5 (where to cut) and #7 directly. Confirm `spent()` works
with no budget directive set. (b) Either document the floors honestly ("only active with an explicit
budget directive") or have `/dev-setup` offer a per-repo default. Half an hour of work; today the
docs promise more than the code delivers.

## 9. Decide the fate of the PR-remediation axis

**Now:** demoted out of the state machine, but still roughly 40% of the collection's conceptual
surface. Half of that can be decided without any more evidence, because two separable things are
bundled:

- **SHA-bound review evidence that gates publication** (`reviews/<sha>.md`, the high/critical block).
  Valuable on its own, solo included. **Keep.**
- **A separate plan-and-implement cycle for the fixes** (`wf-plan-remediation.js`, `/dev-plan --review`,
  the nested `remediations/<sha>/` workspace, the HEAD-equality gates in `dev-implement` step 3, the
  remediation branch of `dev-status`). It exists so "the review found things, someone else fixes
  them later" survives a handoff between people. Solo, "the review found three things, fix them" is
  already `wf-review-loop` with `apply: true`.

**Change:** collapse the second into `/dev-review --from-report <path>`, feeding the report's
`confirmed` findings straight into the fixer + re-review. That deletes `wf-plan-remediation.js`
entirely, half of `dev-plan/SKILL.md`, the nested workspace, and three invariants (HEAD equality +
clean tree + branch match). Escalation stays free: `/dev-plan "fix findings X, Y, Z"` is an ordinary
task.

**What still needs real cycles:** only the residual question — did you ever want an *approved plan*
for a correction rather than the correction itself? Answer that after #0, not from the armchair.

## 10. Give `.claude/rules/` a bootstrap and a ratchet

**Now:** `/dev-setup` step 5 merely offers to draft rules. Nothing improves them afterwards, and the
troubleshooting table's answer to "agents keep missing the same repo quirk" is "write it into
CLAUDE.md yourself".

**Change:** (a) a real bootstrap — read CLAUDE.md, the directory shape and any style guide, propose
3-6 candidate rule files, let the developer approve each. Never invent a convention the repo hasn't
stated. Most repos already have the raw material: a "never violate" / "invariants" section in
CLAUDE.md is a rules file that hasn't been split by path yet. (b) the ratchet: after a cycle, one
agent reads `notes/` plus the confirmed review findings and proposes ≤3 edits to `.claude/rules/*.md`
or `CLAUDE.md`, which the developer approves as a diff.

**Note on (b):** this is the producer that was deleted along with the MCP knowledge base (see
"Deliberately not doing"), reattached to the store the architecture actually endorses — the repo
itself, versioned and reviewable, with the developer as the curator. It is what turns #6 from "rules
exist" into "rules get good".

## 11. An "understand" mode, and a debug shape

**Gap:** there is no way to ask "how does X work here?" without producing a plan, and the pipeline is
feature-shaped (spec → plan → implement) while debugging has a different shape: reproduce →
hypothesize → narrow → fix → prove the repro is dead.

**Change (understand):** not a new command and not a new script — `mode: 'explain'` on
`wf-explore-plan.js`, swapping the synthesizer's prompt and schema. The justification is *not* "explain
this to me" (the built-in `Explore` agent does that for a fraction of the cost); it is that
`findings/<angle>.md` are durable validated artifacts, and a later `/dev-plan` in the same workspace
can consume them instead of re-exploring. That makes exploration a pipeline stage rather than a
parallel feature — and a `mode` keeps #12's duplication from growing.

**Change (debug):** one skill, no workflow, first version. Fan out hypotheses **read-only** — each
agent argues from code, none executes — then one serial step that reproduces, then hand off to the
normal implement/review path. The reason the fan-out cannot execute is the pipeline's own: parallel
agents running the repro contend for the shared working tree, which is exactly why one implement per
clone is enforced (`docs/architecture.md`, "Flow state & concurrency"). The adversarial-verification
pattern in `wf-review-loop.js` transfers to the argue-or-refute half directly.

## 12. Loosen the GitHub assumption; make prose drift detectable

**GitHub:** `/dev-pr` is really two things — branch analysis + coverage map + body draft (useful
anywhere) and publication via `gh` (GitHub-specific). Naming that split in the skill makes graceful
degradation trivial: no remote, GitLab, or a solo repo where the "PR" is a merge you do yourself.
`--body-only` already degrades; the rest should say what it detected instead of assuming.

**Drift:** workflow scripts are self-contained (no imports), so the step contract — "hard
dependencies only", "one-agent-sized, roughly 10 files", "verification means running a check" — is
restated in `wf-explore-plan.js`, `wf-plan-remediation.js`, `wf-implement.js` and several skills. Five copies
drift. "Cite one canonical section" is a convention, and convention is precisely what drifts: make
it a **test** instead — ten lines (a script or an eval case) that greps the canonical sentences
across all copies and fails when one no longer matches.

---

## Dropped

**Scope `allowed-tools` per skill.** Was deferred during the plugin migration; now cut. The stated
benefit is moving the `permissions.allow` entry out of every repo's `.claude/settings.json` — but
`/dev-setup` step 4 already does that automatically. The risk is unchanged: these skills use a wide
tool surface, and an incomplete list degrades a skill in a way that is tedious to diagnose. Real
cost, no remaining benefit.

## Deliberately not doing

**Shared cross-cycle memory.** Removed with the external MCP knowledge base it was built on. Agents
learn nothing from previous cycles now, by design: durable knowledge belongs in the repo
(`CLAUDE.md`, `docs/`, `.claude/rules/`) where it is reviewable and versioned. An uncurated memory
rots and degrades every future agent's discovery. What *was* worth keeping is the producer — a retro
agent distilling ≤3 lessons per cycle — which is now item 10(b), writing into the repo instead of
into a store. `docs/architecture.md` ("Extending") keeps the full note.

**Parallel implementation flows.** Designed, not built: one git worktree per flow, `wf-implement`
running against the worktree path, merge and review at the end. Only worth attempting once
single-flow cycles run reliably — but the design note is out of date and the re-read is cheap: the
runtime now offers `isolation: 'worktree'` per workflow agent and `EnterWorktree`/`ExitWorktree` in
the main loop. A whole `/dev-implement` inside a worktree is far less machinery than the note
assumes, and it attacks the actual root of the advisory lock (verifications sharing one tree).
