# devkit

A multi-agent development pipeline for Claude Code, packaged as a plugin.

```
/dev-spec      →  grounded spec with verifiable acceptance criteria   (large/ambiguous tasks only)
/dev-plan      →  triage, then fan-out exploration → validated step plan
/dev-implement →  steps in dependency waves, contract gates, review checkpoints, phase commit
/dev-review    →  two complementary reviewers → verify → fix → re-review until clean
/dev-pr        →  branch analysis, optional SHA-bound review, PR body, guarded publication
/dev-status    →  what's running, what's stale, cleanup
/dev-setup     →  configure a repo to use all of the above
```

Read `docs/manual.md` to use it, `docs/architecture.md` to change it, `ROADMAP.md` for what is
knowingly unfinished.

## What it is actually built around

Fan-out is the cheap part. The parts that carry their weight:

- **Context discipline** — every workspace file has exactly one writer, and agents exchange *paths*,
  never dumps. Scouts write full reports and return compact summaries; readers open the file only
  when a decision hinges on the detail.
- **Honesty gates** — a step is verified only when it names the command it ran *and* reports that the
  command passed; a bare claim degrades to `unverified`, never to success.
  A review is `clean` only after an explicit post-fix pass finds nothing. Confirmed
  findings are reconciled against the fixer by identity, not by count, and the match fails closed.
- **Proportional cost** — triage decides the machinery (trivial work never touches the pipeline);
  review checkpoints accumulate waves instead of paying a full loop per wave, with one cheap
  contract gate in between.

## Install

Personal use, no marketplace needed — the plugin auto-loads from `~/.claude/skills/`:

```bash
git clone <this repo> ~/projects/devkit
ln -s ~/projects/devkit ~/.claude/skills/devkit
```

Restart Claude Code; it loads as `devkit@skills-dir`. Then run `/dev-setup` inside any project.

For a team, publish from a repo carrying `.claude-plugin/marketplace.json` and have each project
declare `extraKnownMarketplaces` + `enabledPlugins` in its `.claude/settings.json`.

## Layout

```
.claude-plugin/plugin.json   manifest
skills/dev-*/SKILL.md        control plane — runs in the main loop, talks to you
workflows/*.js               data plane — background orchestration, invoked as devkit:<name>
docs/                        manual (usage) + architecture (design rationale)
```

Projects contribute `.dev/` (scratch, gitignored) and optionally `.claude/rules/*.md` — path-scoped
checklists that reach scouts, implementers and an extra review lens. Under a plugin, rules are the
only way a repo specializes the pipeline, so they are worth writing properly.

## Requirements

Git for `/dev-implement`, `/dev-review` and `/dev-pr` (they judge diffs). `gh` for publishing a PR —
`/dev-pr --body-only` still works without it.
