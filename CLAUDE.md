# devkit

This repository **is** the devkit Claude Code plugin: `skills/*/SKILL.md` (control plane, main loop)
and `workflows/*.js` (data plane, background Workflow scripts). It ships through a symlink at
`~/.claude/skills/devkit`, so there is no publish step — an edit here reaches every project on the
next session start. Treat the prompts as code.

Conventions live in `.claude/rules/*.md`, scoped by path; the full rationale for every one of them is
in `docs/architecture.md`. Tests: `sh tests/run-all.sh` (node, no dependencies).

## Dev pipeline

Medium/large tasks go through the devkit multi-agent pipeline: /dev-spec (large/ambiguous) →
/dev-plan → /dev-implement → /dev-review → /dev-pr; /dev-status monitors flows.
Confirmed PR-review findings are fixed with `/dev-review --from-report`. Bugs go through
/dev-debug (repro first, then hypotheses). Trivial/small changes don't need the pipeline
(the /dev-plan triage decides).
Cost profile: default.
