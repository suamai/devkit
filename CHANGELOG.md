# Changelog

Under a plugin a repo cannot pin a version — every project runs whatever is installed at
`~/.claude/skills/devkit` on its next session start. So this file *is* the compatibility story:
it is how `/dev-setup` can tell a repo configured against 0.1.0 what changed by 0.2.0.

**The version moves on behavior changes only** — a changed default, a new or removed option, a
different artifact, a new gate — and never on prose that restates behavior already shipped. Both
`.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` state it (the latter twice);
`tests/contract-drift.test.js` fails if they disagree, or if the shipped version has no entry here.

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
