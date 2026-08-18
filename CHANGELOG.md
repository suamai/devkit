# Changelog

Under a plugin a repo cannot pin a version — every project runs whatever is installed at
`~/.claude/skills/devkit` on its next session start. So this file *is* the compatibility story:
it is how `/dev-setup` can tell a repo configured against 0.1.0 what changed by 0.2.0.

**The version moves on behavior changes only** — a changed default, a new or removed option, a
different artifact, a new gate — and never on prose that restates behavior already shipped. Both
`.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` state it (the latter twice);
`tests/contract-drift.test.js` fails if they disagree, or if the shipped version has no entry here.

## 0.8.0 — 2026-08-18

### Added
- **A plan freshness gate, at the `/dev-implement` preflight.** `/dev-plan` now writes a
  `plan_freshness` block into the workspace's `state.json` at handoff — `planned_at_sha`, a hash of
  the machine-readable steps block *as it stands on disk* after whatever you edited at the approval
  checkpoint, a hash of `spec.md` when there is one, and the plugin commit the plan was written
  under (each omitted rather than fabricated when it cannot be read). `/dev-implement`'s git
  preflight reads it back and branches four ways, and the two common branches cost **zero agents**:
  nothing relevant moved → continue; only files no step declares changed → report the count and
  continue. A change inside a step's own `files` buys exactly one cheap read-only validator, given
  only the affected steps and the diff for those files and asked a single question — is this plan
  still *executable* — never whether the exploration was thorough. A plan edited after handoff, a
  spec whose criteria moved, or a validator reporting a contract that no longer holds stops the run
  and offers re-planning or an explicit override. Two cases are stated rather than guessed: a plan
  written before this shipped has no block, which is said once and continues; and a `plugin_commit`
  that differs from the installed one is reported and points at `/dev-setup --check`, never a block
  on its own — a plugin upgrade changes how the pipeline runs, not whether your plan is executable.

  **Not wired into `delivery_verdict`, on purpose.** `gates.scope` still implements five of the six
  blocked triggers 0.7.0 named, and the sixth — a stale plan — stays unimplemented. The preflight
  blocks *before* any agent is spawned, which is strictly cheaper than a verdict computed just
  before the run returns; and `wf-implement` still has no filesystem access, no git and no clock, so
  the branch would need an argument no caller sends. What is left is a narrower window than the one
  0.7.0 recorded — a plan current at the preflight and stale by the time the run ends — and it is
  now a stated scope line rather than a missing field.

- **`/dev-setup --check`: the whole checklist, read-only.** A mode that creates no file, edits no
  file, adds no permission, bootstraps no rules, writes no gitignore line and offers no commit — run
  it against a repo that has never been configured and the repo is byte-for-byte as it was. It
  reports each item as ok, problem or unknown *with the evidence it read*: the plugin and manifest
  version against the `Configured against devkit <version>.` line in your `CLAUDE.md` (read, never
  rewritten); whether the three workflow names resolve, and that a restart is the fix when they do
  not; whether `${CLAUDE_PLUGIN_ROOT}` expands inside a skill body; the `Workflow` permission and the
  stale-flow `SessionStart` hook; the three `dryRun` smoke tests and the policy they resolve to,
  which spawn zero agents — the reason a diagnostic may run them at all; rule-manifest parse errors
  *and* a frontmatter pass beside them, because a malformed rule file and a deliberately unscoped one
  both come back with empty globs; rule globs matching no tracked file; stale workspaces; and git,
  remote and `gh` state. It closes by naming the invocation that fixes each problem — and in this
  mode it will not apply one even if asked.

  **Rejected: a separate `/dev-doctor`.** It would cost a name in the flat namespace shared with the
  workflows and duplicate a checklist that then has to be kept in sync; a flag is the same capability
  with nothing to drift. Also dropped, deliberately: comparing the installed plugin commit against
  recent ledger lines. Both routes to it were worse than the gap — a new aggregate mode in
  `scripts/ledger-report.sh`, or a skill reading raw `runs.jsonl`, which breaks the invariant that no
  agent ever reads the ledger.

- **The free projection now lints the `verify` commands a plan proposes.** The planner writes those
  strings and implementers execute them; the honesty gate has always checked whether a command ran
  and passed, never whether it should have been run at all. Three categories now reach you before
  approval, at zero agents, in the `dryRun` projection that already prices the plan: a command that
  deletes, force-pushes, publishes, deploys, migrates data or contacts an external service is flagged
  with the step that carries it and the category it matched; a command that is a synthesized shell
  program rather than a call — three or more chained segments, or an operator other than `&&` — is
  flagged with a nudge toward a project-declared script; and every command in which no segment's head
  is a recognized project runner is collected into **one** aggregated line naming each step and its
  command, which says the run proceeds, the command having been shown. Matching runs over each step's
  own `verify` and over its `&&`/`;`/`|`-separated segments — so `npm run db:migrate` is caught even
  though its head is a declared script — and never over the joined command a checkpoint builds from
  several steps.

  **Rejected: a sandbox, and an allow-list.** This is a lint and an approval prompt. An allow-list —
  warn on anything not proven safe — is the fragile shape `IDEAS.md` #16 rejects by name: it would
  fire on most of the honest commands in this repo's own suite, and a warning that is always on is a
  warning nobody reads.

- **An implementer that finishes the work but not the report no longer needs you.** Recovery is
  automatic, and read-only in both halves. `wf-implement` retries the **serialization** once: one
  cheap non-editing agent, forbidden from implementing anything or editing any tracked file, that
  reads the diff for the step's declared files and the notes and returns the structured result only.
  If that also comes back empty the step is still reported `implement-result-unavailable`, now
  carrying `result_retry_attempted: true`, and `/dev-implement` reconstructs the report itself from
  `journal.jsonl`, the notes directory and the diff — the half a workflow script cannot do, having no
  filesystem. Whichever half succeeds marks the object `result_recovered: true`, top-level on the
  report and on the ledger line, so a reconstructed result is never mistaken for one an implementer
  returned; it is then treated exactly like an implementer report, which means it counts as
  unverified unless the notes or the journal actually show a command *and* its result. Recovery never
  re-runs implementation.

  **Rejected: a blind re-run of the implementer.** Re-invoking the implementer prompt would spend the
  pipeline's most expensive role on a tree the first attempt may already have half-edited — duplicated
  work, and a diff nobody asked for. What failed is the serialization, so the serialization is what
  gets retried.

### Fixed
- **Two scouts of one exploration run can no longer share a report path.** `wf-explore-plan` accepted
  an `angles` argument and read `a.name` off every entry without checking the shape, so a caller
  passing an array of plain strings — the obvious reading of "override the decomposition" — sent every
  scout to `findings/undefined.md`, where they overwrote one another. Found by this campaign's own
  planning run, which did exactly that and lost four of its five reports. Angles are now normalized on
  the *converged* value, so the caller's array and the decomposer's output both pass through it: a
  string becomes that angle's focus with a slug for its filename, an object missing `name` or `focus`
  throws naming the index rather than guessing what a scout was meant to look at, a non-array throws,
  and repeated names are disambiguated deterministically (`a.md`, then `a-2.md`). Throwing costs
  nothing on the caller-supplied path, since the decomposer is skipped whenever `angles` is non-empty.
  The returned `findings` array now carries the path the **script** assigned rather than the one the
  scout reported, and a divergence between the two is logged as the scout deviation it is.

## 0.7.0 — 2026-08-17

### Added
- **Acceptance criteria carry stable ids, and covering them is linted for free.** `/dev-spec` now
  numbers every criterion `AC-01: …` in document order and never renumbers one — an id is an address
  the rest of the pipeline points at. A plan step declares which ones it covers (`covers: ["AC-01"]`,
  optional, on both step schemas), `/dev-plan` extracts the canonical id list from `spec.md` with a
  stated `grep` — a workflow script has no filesystem access, the same reason `rules` arrives
  pre-extracted — and passes it into the `dryRun` projection it already runs. So the three coverage
  warnings (an id no spec declares, an id declared twice, a criterion no step covers) reach you before
  the approval checkpoint at **zero agent cost**. They are surfaced, never auto-patched: an unknown or
  duplicate id is a plan defect to fix, while a criterion covered by no step is your call, since a
  suite-level check is a legitimate cover and inventing a `covers` entry to quiet the warning is
  precisely the lie the chain exists to prevent. `/dev-pr` then renders an acceptance matrix —
  criterion → step(s) → the check that actually ran → outcome — from that structure instead of
  reconstructing it in prose, and marks the rows resting on a check that was already green.

  **Rejected: a criterion-level self-report.** The fuller design had implementers return
  `{criterion, status, evidence}` beside their `verify_run` — a second self-reported evidence channel,
  with a second honesty gate to write and defend, for something a genuinely verifiable criterion
  already states as a command. A criterion's status is instead **derived** from the `verify_run` of
  the steps that declare `covers`, so nothing new is self-reported and the matrix shows the command
  rather than an adjective. Ids on their own are ceremony; the derived matrix is what makes them pay.

- **One computed delivery verdict ends an implement run.** `wf-implement` returns `delivery_verdict`
  (`ready`, `ready-with-unverified` or `blocked`), a `gates` object over acceptance/tests/review/
  questions/scope, and `reasons` naming the evidence for every gate that is not clean.
  `/dev-implement` leads its report with it, persists it into `last-run.json`, `state.json` and the
  run ledger; `/dev-pr` stops before publication on `blocked` — stating the gates, offering
  `/dev-implement --continue` or `/dev-review --from-report`, publishing only on an explicit override
  — and asks for one risk acknowledgement on `ready-with-unverified`. Readiness used to be spread
  across `review.clean`, `finalCheck.consistent`, `suite_run`, unverified steps, blocking questions,
  budget exits and `stoppedEarly`: every signal honest on its own, the combination left to whoever
  read the report, where "review clean" quietly read as "ready" even when nothing ran end to end.

  **Rejected: letting an agent decide it.** The verdict is a pure function, in plain JS, of structured
  outputs the run already produced — no agent call was added anywhere, and four existing test files
  throw on an unexpected agent, so the constraint enforces itself. A label an agent asserts is the one
  thing that would make people stop looking at the gates underneath it. `gates.scope` implements five
  of the six blocked triggers the design named; the sixth, a stale plan, has no computable source in
  this script's reach — no filesystem, no git, no clock — and is filed against the plan-freshness gate
  (`IDEAS.md` #13, which would record `planned_at_sha`) rather than stubbed with an argument no caller
  ever passes. Until it lands, a verdict is only as current as the plan it was computed against.

## 0.6.0 — 2026-08-17

### Fixed
- **The calibration report counts each escalation signal separately.** A triage can fire more than
  one signal, and `/dev-plan` records them comma-separated on the ledger line — but the reader keyed
  its histogram on the whole string, so `contract-change, independent-parts` became its own bucket
  and neither signal was counted where anyone looks for it. With enough multi-signal runs the
  escalation row degenerates into a list of unique combinations, which is precisely when it stops
  answering the question it exists for: *which signal is doing the discriminating work?* The reader
  now splits on commas and counts each name. `n` still counts **runs**, not signals, so a run naming
  two signals does not inflate the escalation rate — the two totals differ on purpose.

  Nothing needs rewriting to benefit: a single-signal line splits into one element and reads exactly
  as before, and no signal in the closed list contains a comma. Existing lines that already joined
  two signals start counting correctly on the next report.

## 0.5.0 — 2026-08-17

### Added
- **A run ledger: one JSONL line per phase run, at `~/.claude/devkit/runs.jsonl`.** Every phase
  already computed the numbers that answer *is this pipeline calibrated?* — tier, waves, splits,
  rounds, the clustering ratio, the verification split, `cost.by_phase` — and all of it died with the
  turn. `scripts/ledger-append.sh` now takes a one-line JSON body on stdin from the skill that owns
  the phase, prepends an envelope it computes itself (`ts`, `plugin_version`, `plugin_commit`, `repo`,
  `repo_sha` — omitted, never guessed, when it cannot read one) and appends the merged line with a
  single `printf … >>`. Never a read-modify-write: that is how two concurrent sessions lose a line.
  The store is per developer and spans repos, has no schema version and no migration path, and losing
  it costs nothing. **No agent ever reads it**; only `scripts/ledger-report.sh`'s aggregates reach a
  conversation, and a failed append is one sentence in the phase report, never a failed phase.
- **`/dev-status --calibration`.** Prints the architecture doc's calibration checklist with real
  numbers from the ledger — clustering ratio, split rate, round convergence, escalation rate,
  unverified steps, tokens per phase, projected vs. actual agents — each row carrying its sample size,
  medians rather than means, and `n=0 — no data` instead of a row with nothing behind it. Unreadable
  lines are skipped *and* counted; with no ledger at all it says so and exits 0.
- **`/dev-status archive <slug>`.** Deletes everything under `.dev/<slug>/` except `state.json`, then
  rewrites that file keeping every key it already has except `findings`, and stamping `archived`. Not
  a gentler `clean` — `clean` still removes the whole workspace, `state.json` included. `findings`
  goes because its `report_path` entries are what `/dev-plan` hands a scout as `priorFindings`, and
  after archiving those files are gone: a dangling path is worse than no prior findings.
- **A cost quote at the `/dev-plan` approval checkpoint.** The projection is rendered as a quote block
  built from the lint's `schedule` — the agents floor and its note, the checkpoints and why they fire,
  the largest term in the floor *for this plan*, and what can only ever add to it — keeping both
  honesty facts it always carried (checkpoints fire earlier, never later; `agents_min` is a floor, not
  an estimate). Separately, and never blended into it, `scripts/ledger-report.sh --quote` contributes
  one historical line from your own ledger. Comparable means the same phase, tier and profile across
  every repo; fewer than three samples refuses to quote a median rather than printing a weak number
  confidently.
- **Three notifications, at the three moments a run stops on a person.** `/dev-plan` with non-empty
  `open_questions`, `/dev-implement` when `stoppedEarly` is true, and `/dev-pr --review` when
  high/critical findings block publication each call the `PushNotification` tool once
  (`{ message, status: "proactive" }`, one line, ≤200 characters). Distinct from the completion ping a
  background workflow already sends: that one says a run finished, these say it is blocked on you. A
  `not sent` result means the developer is at the terminal — expected, and never retried.
- **A `runs` array in `state.json`.** One compact entry appended per phase run — the same numbers the
  ledger line carries, never rewritten — so `archive` can throw away the bulk of a workspace and keep
  the evidence, and so a lost ledger does not take a flow's own history with it.

### Changed
- **`wf-review-loop` returns `raw` and `clustered`.** Two new scalars beside `rounds`/`clean`: raw
  findings summed across rounds, and semantic clusters counted after verification. The clustering
  ratio is now *read* from them instead of reconstructed from `merged_titles`, which silently omitted
  every raw finding the verifier dropped without clustering and reported exactly 1.0 on seeded
  `--from-report` runs. Both are always present (0 is the truth, not a missing field); round 1 of a
  seeded run maps them 1:1, but a non-clean round 2 re-review still adds to both, so the ledger's
  overall ratio is 1.0 only when round 2 also finds nothing new.

## 0.4.0 — 2026-08-17

### Added
- **A typed `verify_run` on `wf-implement`.** A step's verification outcome stops being a boolean and
  becomes `status: passed | failed | not-run | infra-error`, derived by the script from the
  `ran`/`command`/`passed` the implementer still reports — those remain the arbiter, and the eight
  lines that classify them stay byte-identical with `wf-review-loop.js`. A step report now also
  carries `kind`, `attempts`, `verify_command`, `weak_evidence`, `infra_error` and `kind_missing`, and
  the run returns `weakEvidenceSteps`, `infraErrors` and `kindMissing` next to `unverifiedSteps`.
- **`infra-error` is not a defect, and it buys one cheap re-run.** It is the one status no reply shape
  can reveal, so an implementer *claims* it — and the claim is honored only when it names both the
  command it tried and the failure it observed. An evidenced one spawns a single `verify:<id>` agent
  (new `verify` role, sonnet) that re-runs the command; the step does not fail and the dependent waves
  still run, though it is reported as unverified with a distinct third reason string. That agent may
  also re-run the environment step the first attempt named (`npm ci`, starting a service, restoring a
  dependency) and must name every command it ran, so the mutation is visible to the reviewer and to
  later steps that inherit the environment; it may **not** edit tracked files, because a fix that needs
  a source change is a defect and gets reported as one. An unevidenced claim that says the check *ran*
  degrades to `failed` and buys no agent; one that honestly says `ran: false` keeps its
  `not_ran_reason` and stays `not-run`.
- **`kind: new-test | existing-suite | manual`, and the weak-evidence mark it produces.** A pass whose
  only check was already green before the step (`existing-suite`) stays **verified** — a refactor's
  evidence *is* the still-green suite — but is reported as weak evidence and reaches the checkpoint
  reviewer as a priority target, next to the implementer's `deviations`, which now travel there too.
  `kind` fails open: a pass declaring none is not weak evidence, it is counted in `kindMissing` as a
  calibration signal and never gates anything.
- **A duplicate-`verify` lint in the `dryRun` schedule.** Two or more steps declaring the same `verify`
  string produce one warning naming them, because a single shared command cannot be per-step evidence
  for each of them — every step after the first comes back `weak_evidence`.
- **`tests/verify-contract.test.js`**, which drives the whole contract through the real entry point
  with stubbed agents, and a second table in `tests/verify-gate.test.js` for the typed layer extracted
  from `wf-implement.js`'s fenced block. `tests/contract-drift.test.js` now also compares the `status`
  and `kind` enums against every document that restates them, with a fail-closed guard and an
  in-memory mutation proof.

### Changed
- **`/dev-implement` runs the repo's own check in the main loop before reporting a run that stopped
  early.** One Bash call, zero agents, and the command comes from what the repo documents rather than
  from a guess — the same rule `/dev-review` states for `verifyCommand`. A stopped run's
  `finalCheck.suite_run` no longer asserts a suite outcome: it says outright that it is a placeholder
  the workflow fabricated with nothing behind it, so the two cannot contradict each other.

## 0.3.0 — 2026-08-17

### Added
- **`verifyCommand` on `wf-review-loop`, and a `Check` phase that uses it.** After a round *applies*
  fixes, one agent runs the repo's own executable check and reports what happened; the script has no
  shell, so that claim is classified by the same truth table `wf-implement` applies to an
  implementer's `verify_run` — byte-identical code, asserted as such by `tests/verify-gate.test.js`.
  The result travels back as `fix_verify` (`ran`, `command`, `passed`, `output_summary`,
  `not_ran_reason`, `failed`, `unverified`, `attempts`, `repaired?`) and the phase shows up in
  `cost.by_phase` as `check`. Passing nothing, or `verifyCommand: false`, spawns no agent at all:
  a caller with no command must not pay for one that can only report having nothing to run.
- **One bounded repair attempt per round when the check fails.** `check → repair → re-check`, once,
  never a second round of finding. The repair may not revert a confirmed fix or weaken a test to reach
  green, and its files are appended to what the next re-review reads, so a repair is reviewed like any
  other change rather than trusted — a repair that names no files is therefore not accepted at all,
  since the script has no filesystem access and an unnamed edit is one the next round cannot see.
  Accepted attempts are returned in `repairs`
  (`{round, summary, changed_files}`); `fix_verify.attempts` counts the checks and
  `fix_verify.repaired` marks a round that broke its own check and then patched it.
- **`ruleLens`.** `false` suppresses the `repo-conventions` reviewer even when a rule matches, for a
  caller that wants exactly the lenses it named.
- **Two drift gates.** A code block that hands `wf-review-loop` custom `lenses` must also pass `rules`
  and `files` (with a fail-closed companion, so it cannot pass by finding no such block), and
  `skills/dev-review/SKILL.md` must document the knobs it tells Claude to pass.

### Changed
- **The `repo-conventions` rule lens is appended to whatever `lenses` resolves to** instead of being
  one entry in the default array. A caller passing custom lenses is asking for a different pair of
  general lenses, not for the repo's own checklists to be dropped — and `/dev-pr --review`, which
  passes two custom lenses at the last gate before publication, had been silently losing that
  reviewer. It now also passes `rules` and `files`, without which there is nothing to match.
- **A review checkpoint inside `/dev-implement` hands the covered steps' own `verify` commands down**
  as the loop's `verifyCommand` — deduplicated, joined with `&&` — so a checkpoint's fixes are
  executed and not merely re-read. A check that **did not clear** now blocks the run: "every finding was
  applied" and "the tree still builds" are different claims, and only the second one was missing. The
  gate mirrors the loop's own (`ran === true` without a substantiated pass), so a claim to have run that
  substantiates nothing blocks too — it proved nothing *and* cost the round its re-review. Not running
  at all (`verifyCommand: false`, no command, budget floor) stays an honest opt-out and does not block.
- **`clean: true` requires more than a quiet re-review.** When a round applied fixes it also needs a
  post-fix check that passed, or an honest statement that none ran. A claim to have run one that names
  no command or no result blocks `clean`, exactly as a bare `verify_run` degrades a step to
  `unverified`.
- **`models`/`efforts` reach one more agent.** The review loop's check runs as the existing `check`
  role, so `models: { check: … }` and `profile` now retier it too — consistent with the documented
  semantics, and worth knowing before a `cheap` run puts haiku on the gate.

## 0.2.0 — 2026-08-17

### Added
- **`Artifact language:` in `CLAUDE.md`.** Artifacts (`plan.md`, `understanding.md`, `spec.md`,
  `pr.md`) followed the language of the conversation, which is wrong for anyone working in one
  language and publishing in another. Same mechanism as `Cost profile:` — a committed line the
  skills read and pass to the agent that writes the file. `/dev-setup` step 3 offers it; omitting
  the line keeps the old behavior exactly.
- **`language` argument on `wf-explore-plan`.** Optional; constrains the synthesizer's prose in both
  `plan` and `explain` modes. Identifiers, paths and code quotations are never translated.
- **A shipped `SessionStart` hook** flagging workspaces left at `implementing` — the stage that means
  an interrupted implement run, which nothing surfaced until you next ran `/dev-status`.
  `hooks/hooks.json` registers it for a marketplace install; `/dev-setup` step 6 wires it into a
  project's `.claude/settings.json`, which is the path that works for a `~/.claude/skills/` install.
- **`scripts/install.sh`** — first-run counterpart to `scripts/promote-plugin.sh`: clone (or reuse a
  clone), run the suite, install a frozen read-only copy. Replaces "clone plus a manual symlink",
  which is now the wrong advice for anyone who edits the plugin.
- **`scripts/install-hooks.sh`** — opt-in `pre-commit` running `sh tests/run-all.sh`. Never installed
  silently, refuses to clobber an existing hook, and `--uninstall` removes it.
- **CI.** `.github/workflows/tests.yml` runs the suite on push and pull request.
- **`LICENSE`** — MIT.

### Changed
- **`/dev-setup` records the version it configured against** (`Configured against devkit <version>.`
  in `CLAUDE.md`) and, on a later run, compares it to the installed plugin and points at the entries
  in between. Repos configured before 0.2.0 have no such line; `/dev-setup` adds it and says so
  rather than guessing what they were configured against.

### Fixed
- **`/dev-setup` step 6's promise is now enforced.** It told every new repo that all three workflows
  return `{ok: true}` for `args: {"dryRun": true}`; only `wf-implement`'s branch had a test.
  `tests/dryrun-smoke.test.js` drives all three through their real entry points, with every
  agent-spawning hook stubbed to throw, and covers any workflow added later automatically.
- `README.md` pointed at `ROADMAP.md`, deleted in `41e54ef`. It points here instead.

## 0.1.0

The pipeline as first assembled, unversioned in practice — `0.1.0` through every commit up to
`409a6ef`. `/dev-spec`, `/dev-plan` (with `--explain`), `/dev-implement`, `/dev-review` (with
`--from-report`), `/dev-debug`, `/dev-pr`, `/dev-status`, `/dev-setup`; the three workflow scripts;
context discipline, the honesty gates, cost as an argument, and `.claude/rules/*.md` as the one
channel that specializes the pipeline to a repo.
