# devkit

This repository **is** the devkit Claude Code plugin: `skills/*/SKILL.md` (control plane, main loop)
and `workflows/*.js` (data plane, background Workflow scripts). Treat the prompts as code.

It ships as a **frozen read-only copy** at `~/.claude/skills/devkit`, installed from committed state
by `sh scripts/promote-plugin.sh` — deliberately **not** a symlink, because here the plugin is also
the thing being edited: under a symlink a step that edits `wf-review-loop.js` would change the review
loop of the very run about to review it, and a run that stops early (a designed outcome) would leave
the tooling half-edited for the next session. So editing this repo changes **nothing** that any
session loads. Promote between plans, never during one, then restart Claude Code — `name:` resolution
serves a snapshot taken when the plugin loaded. `scripts/promote-plugin.sh`'s header is the full
argument; a run that must exercise uncommitted work has to pass `scriptPath` into this working tree
instead.

Conventions live in `.claude/rules/*.md`, scoped by path; the full rationale for every one of them is
in `docs/architecture.md`. Tests: `sh tests/run-all.sh` (node, no dependencies) — install the opt-in
pre-commit hook with `sh scripts/install-hooks.sh` so it runs without anyone remembering. CI runs the
same suite. Bump the version in **both** `.claude-plugin/*.json` and add a `CHANGELOG.md` entry on
behavior changes only, never on prose; `tests/contract-drift.test.js` fails if they disagree.

## Dev pipeline

Medium/large tasks go through the devkit multi-agent pipeline: /dev-spec (large/ambiguous) →
/dev-plan → /dev-implement → /dev-review → /dev-pr; /dev-status monitors flows.
Confirmed PR-review findings are fixed with `/dev-review --from-report`. Bugs go through
/dev-debug (repro first, then hypotheses). Trivial/small changes don't need the pipeline
(the /dev-plan triage decides).
Cost profile: default.
Artifact language: English.
Configured against devkit 0.2.0.
