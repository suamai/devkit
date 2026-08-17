# Changelog

Under a plugin a repo cannot pin a version — every project runs whatever is installed at
`~/.claude/skills/devkit` on its next session start. So this file *is* the compatibility story:
it is how `/dev-setup` can tell a repo configured against 0.1.0 what changed by 0.2.0.

**The version moves on behavior changes only** — a changed default, a new or removed option, a
different artifact, a new gate — and never on prose that restates behavior already shipped. Both
`.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` state it (the latter twice);
`tests/contract-drift.test.js` fails if they disagree, or if the shipped version has no entry here.

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
