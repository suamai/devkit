# Changelog

Under a plugin a repo cannot pin a version — every project runs whatever is installed at
`~/.claude/skills/devkit` on its next session start. So this file *is* the compatibility story:
it is how `/dev-setup` can tell a repo configured against 0.1.0 what changed by 0.2.0.

**The version moves on behavior changes only** — a changed default, a new or removed option, a
different artifact, a new gate — and never on prose that restates behavior already shipped. Both
`.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` state it (the latter twice);
`tests/contract-drift.test.js` fails if they disagree, or if the shipped version has no entry here.

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
