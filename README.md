# devkit

A multi-agent development pipeline for Claude Code, packaged as a plugin.

```
/dev-spec      →  grounded spec with verifiable acceptance criteria   (large/ambiguous tasks only)
/dev-plan      →  triage, then fan-out exploration → validated step plan
                  (--explain writes understanding instead, reusable by a later plan)
/dev-implement →  steps in dependency waves, contract gates, review checkpoints, phase commit
/dev-review    →  two complementary reviewers → verify → fix → re-review until clean
                  (--from-report applies a PR review's confirmed findings)
/dev-debug     →  repro → read-only hypothesis fan-out → refute → narrow serially → prove it dead
/dev-pr        →  branch analysis, optional SHA-bound review, PR body, guarded publication
/dev-status    →  what's running, what's stale, cleanup
/dev-setup     →  configure a repo to use all of the above
```

Read `docs/manual.md` to use it, `docs/architecture.md` to change it — including what was
deliberately dropped and why — and `CHANGELOG.md` for what moved between versions.

## What it is actually built around

Fan-out is the cheap part. The parts that carry their weight:

- **Context discipline** — every workspace file has exactly one writer, and agents exchange *paths*,
  never dumps. Scouts write full reports and return compact summaries; readers open the file only
  when a decision hinges on the detail.
- **Honesty gates** — a step is verified only when it names the command it ran *and* reports that the
  command passed; a bare claim degrades to `unverified`, never to success.
  A review is `clean` only after an explicit post-fix pass finds nothing. Confirmed
  findings are reconciled against the fixer by identity, not by count, and the match fails closed.
- **Proportional cost** — triage defaults to the cheap tiers and makes the multi-agent flow argue for
  itself: escalation needs a named signal from a closed list, stated in the report;
  review checkpoints accumulate waves instead of paying a full loop per wave, with one cheap
  contract gate in between. Model tier and reasoning effort are arguments, not constants
  (`profile: "cheap"` shifts every agent down a rung), and every run reports what it actually spent
  per phase.
- **Nothing carries between cycles, so the repo is the memory** — `.claude/rules/*.md` (a native
  Claude Code convention) is the one channel that specializes a generic pipeline to your code.
  `/dev-setup` bootstraps it from what you already wrote down; after a run that found real problems,
  `/dev-implement` proposes at most three edits, citing evidence, for you to approve as a diff.
- **Tested where it can be** — the scheduler, the honesty gates, the continuation surgery, the rule
  matcher and the cost policy all run under `sh tests/run-all.sh`, driven through the real workflow
  entry points rather than copies. `tests/contract-drift.test.js` additionally checks that the prose
  still states the values the scripts actually use.

## Install

Personal use, no marketplace needed — the plugin auto-loads from `~/.claude/skills/`:

```bash
git clone https://github.com/suamai/devkit.git ~/projects/devkit
sh ~/projects/devkit/scripts/install.sh
```

Restart Claude Code; it loads as `devkit@skills-dir`. Then run `/dev-setup` inside any project.

That installs a **frozen, read-only copy** of `HEAD`, not a symlink, and runs the suite before it
will. A symlink is the obvious shortcut and it is wrong here, because this repo is also the thing
being edited: `${CLAUDE_PLUGIN_ROOT}` resolves back through the link into your working tree, so a
step that edits a workflow changes the workflow of the run editing it, and a run that stops early —
a designed outcome, not a crash — leaves the tooling half-edited for the next session. If you
already have the symlink, `install.sh` replaces it.

To update: `git pull`, then re-run `install.sh` (or `scripts/promote-plugin.sh`, which is the same
install without the first-run checks — run it *between* plans, never during one). `CHANGELOG.md` says
what changed since the version `/dev-setup` recorded in your project's `CLAUDE.md`.

Editing devkit itself? Also run `sh scripts/install-hooks.sh` — an opt-in `pre-commit` running the
suite. It is never installed for you, and CI runs the same suite on every push.

For a team, publish from a repo carrying `.claude-plugin/marketplace.json` and have each project
declare `extraKnownMarketplaces` + `enabledPlugins` in its `.claude/settings.json`.

## Layout

```
.claude-plugin/              plugin + marketplace manifests (both state the version)
skills/dev-*/SKILL.md        control plane — runs in the main loop, talks to you
workflows/wf-*.js            data plane — background orchestration, invoked as devkit:wf-<name>
scripts/                     install, promote, and the rules manifest the skills call
hooks/                       shipped SessionStart hook + the opt-in git pre-commit
docs/                        manual (usage) + architecture (design rationale)
tests/                       node, no dependencies — `sh tests/run-all.sh`
evals/                       `claude plugin eval` cases for judgment calls no unit test reaches
```

Projects contribute `.dev/` (scratch, gitignored) and optionally `.claude/rules/*.md` — path-scoped
checklists that reach scouts, implementers and an extra review lens. Under a plugin, rules are the
only way a repo specializes the pipeline, so they are worth writing properly.

## Requirements

Git for `/dev-implement`, `/dev-review`, `/dev-debug` and `/dev-pr` — they judge diffs. Node to run
the tests. Nothing else.

`gh` is needed only for the last hop of `/dev-pr`: publication. Branch analysis, the coverage map
against your plan, the SHA-bound review and the body draft are plain git, so a GitLab remote, a bare
remote or no remote at all still gets everything except the `gh pr create`. `/dev-pr` detects which
of those you are in and says so before starting.

## License

MIT — see `LICENSE`.
