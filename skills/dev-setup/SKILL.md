---
name: dev-setup
description: Configure a repository to use the devkit dev pipeline — gitignore, CLAUDE.md pointer, Workflow permission, and a zero-cost smoke test of the four workflow scripts. Use in a new project, or to check an existing setup after installing or updating the plugin.
---

You configure the repository you are in to work with the `devkit` pipeline. The skills, workflows
and docs ship with the plugin — nothing is copied into the repo, so there is no install mode and no
file-drift to reconcile. What a repo still owns is small: where scratch goes, whether teammates can
find the manual, and the repo's own path-scoped rules.

## Checklist

Work through these, reporting each as ok / fixed / skipped-with-reason.

1. **Plugin loaded.** Confirm the workflows resolve by name (`devkit:wf-explore-plan`,
   `devkit:wf-implement`, `devkit:wf-review-loop`, `devkit:wf-plan-remediation`). If they do not, the plugin
   was installed or updated after this session started — say so and tell the developer to restart
   Claude Code. Everything below still works meanwhile via `scriptPath`.

2. **Git.** The repo must be a git repository (offer `git init` — `/dev-implement`, `/dev-review`
   and `/dev-pr` all need diffs). Add to `.gitignore` if absent:
   ```
   .dev/*
   ```
   Workspaces are personal scratch; nothing under `.dev/` is committed.

3. **CLAUDE.md.** Append this section if no equivalent exists (create the file if needed):
   ```markdown
   ## Dev pipeline
   Medium/large tasks go through the devkit multi-agent pipeline: /dev-spec (large/ambiguous) →
   /dev-plan → /dev-implement → /dev-review → /dev-pr; /dev-status monitors flows.
   PR reviews can feed `/dev-plan --review` remediation plans. Trivial/small changes don't need
   it (the /dev-plan triage decides).
   Cost profile: default.
   ```
   Ask which cost profile this repo wants (`cheap` | `default` | `max` — the manual's Cost control
   explains the ladder); a side project and a production repo do not deserve the same budget.
   CLAUDE.md is already in context in every session, so that line *is* the mechanism — the skills
   read it and pass it as `profile`. No config file, no precedence rules, and unlike anything under
   `.dev/` it is committed, so it applies to whoever clones the repo.

4. **Permissions.** In the project's `.claude/settings.json`, ensure `permissions.allow` includes
   `"Workflow"` (create the file and keys as needed, merging with what exists — never dropping
   entries). This spares the recurring permission prompt on every pipeline run.

5. **Repo rules (optional but high-value).** The pipeline reads `.claude/rules/*.md` — path-scoped
   checklists with a `paths:` frontmatter listing the globs each one covers. They are the one
   channel that specializes a generic pipeline to this repo: matching rules reach scouts and
   implementers, and become an extra `repo-conventions` review lens. If `.claude/rules/` does not
   exist, say what the repo would gain and offer to draft rules from what is already written down
   (CLAUDE.md conventions, invariants, a style guide) — but let the developer approve the content.
   Never invent conventions the repo has not stated.

6. **Smoke test.** Run each of the four workflows with `args: {"dryRun": true}` — zero agents
   spawned, zero cost. All four must return `{ok: true}`:
   ```
   Workflow({ name: "devkit:wf-explore-plan", args: {"dryRun": true} })
   Workflow({ name: "devkit:wf-implement", args: {"dryRun": true} })
   Workflow({ name: "devkit:wf-review-loop", args: {"dryRun": true} })
   Workflow({ name: "devkit:wf-plan-remediation", args: {"dryRun": true} })
   ```
   Fall back to `scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/<name>.js"` if the names have not
   registered yet. A parse failure here is a plugin problem, not a repo problem — show the error.
   Each also returns its resolved `policy` (model/effort per role), so adding the repo's chosen
   `profile` to these calls checks the setting for free, before it can cost anything.

7. **Commit.** Offer to commit whatever step 2-5 changed (`chore: configure devkit pipeline`,
   standard co-author trailer). Skip if the developer declines.

## Report

Checklist results, then:

- Suggested first read: `${CLAUDE_PLUGIN_ROOT}/docs/manual.md` (5 minutes — commands, checkpoints,
  troubleshooting). Architecture and design rationale: `${CLAUDE_PLUGIN_ROOT}/docs/architecture.md`.
- Suggested first run: `/dev-plan` on a real medium-sized task, then check the calibration numbers
  in the architecture doc ("First-run calibration checklist").

## Notes

- To change pipeline behavior, edit the plugin, not the repo — a repo cannot fork a prompt. What a
  repo *can* tune is its `.claude/rules/`, which is why step 5 is worth doing properly.
- New or renamed workflow files register at session start; `scriptPath` works immediately.
