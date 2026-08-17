---
name: dev-setup
description: Configure a repository to use the devkit dev pipeline — gitignore, CLAUDE.md pointer, Workflow permission, the stale-flow session hook, and a zero-cost smoke test of the three workflow scripts. Records the plugin version it configured against, so a later run can say what changed. Use in a new project, or to check an existing setup after installing or updating the plugin.
---

You configure the repository you are in to work with the `devkit` pipeline. The skills, workflows
and docs ship with the plugin — nothing is copied into the repo, so there is no install mode and no
file-drift to reconcile. What a repo still owns is small: where scratch goes, whether teammates can
find the manual, and the repo's own path-scoped rules.

## Checklist

Work through these, reporting each as ok / fixed / skipped-with-reason.

1. **Plugin loaded, and which version.** Confirm the workflows resolve by name
   (`devkit:wf-explore-plan`, `devkit:wf-implement`, `devkit:wf-review-loop`). If they do not, the
   plugin was installed or updated after this session started — say so and tell the developer to
   restart Claude Code. Everything below still works meanwhile via `scriptPath`.

   Read the installed version from `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` (and the commit
   from `${CLAUDE_PLUGIN_ROOT}/FROZEN_AT` if present — `promote-plugin.sh` writes it). Then look for
   a `Configured against devkit <version>.` line in the repo's `CLAUDE.md`:

   - **No line** — a repo configured before this was recorded, or never configured. Step 3 adds it.
     Say that you are recording the current version, not discovering what it used to be; there is no
     way to know retroactively and guessing would be worse than the gap.
   - **Same version** — nothing to report beyond "up to date".
   - **Different version** — this is the reason the line exists. Read
     `${CLAUDE_PLUGIN_ROOT}/CHANGELOG.md` and summarise the entries *between* the two, then update
     the line in step 3. A repo cannot pin a plugin version, so the changelog is the only
     compatibility story there is; going backwards (installed older than recorded) is worth calling
     out explicitly, because it usually means a stale install rather than a downgrade.

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
   Confirmed PR-review findings are fixed with `/dev-review --from-report`. Bugs go through
   /dev-debug (repro first, then hypotheses). Trivial/small changes don't need the pipeline
   (the /dev-plan triage decides).
   Cost profile: default.
   Configured against devkit 0.2.0.
   ```
   Ask which cost profile this repo wants (`cheap` | `default` | `max` — the manual's Cost control
   explains the ladder); a side project and a production repo do not deserve the same budget.
   CLAUDE.md is already in context in every session, so that line *is* the mechanism — the skills
   read it and pass it as `profile`. No config file, no precedence rules, and unlike anything under
   `.dev/` it is committed, so it applies to whoever clones the repo.

   `Configured against devkit <version>.` takes the version step 1 read from the installed plugin —
   never a version you remember. Update it whenever step 1 found a mismatch, *after* reporting what
   changed in between; silently rewriting it throws away the only signal.

   **Also offer `Artifact language: <language>.`** — same mechanism, one more per-repo fact. Without
   it, `plan.md`, `understanding.md`, `spec.md` and especially `pr.md` come out in whatever language
   the conversation happened in, which is wrong for anyone who works in one language and publishes in
   another. Ask only if there is a reason to think it applies (the repo's committed prose is in a
   different language from the conversation, or the developer raises it); otherwise leave the line
   out, which keeps today's behavior exactly. It binds prose only — identifiers, paths, commands and
   quoted code are never translated, because those are addresses the pipeline follows literally.

4. **Permissions.** In the project's `.claude/settings.json`, ensure `permissions.allow` includes
   `"Workflow"` (create the file and keys as needed, merging with what exists — never dropping
   entries). This spares the recurring permission prompt on every pipeline run.

   **Offer the stale-flow hook** in the same file. A workspace at `implementing` means an implement
   run that did not finish — a designed outcome (blocking question, unclean checkpoint, failed step,
   budget floor), not only a crash — and nothing surfaced it until you remembered to run
   `/dev-status`. Worse, `/dev-implement` treats such a workspace as a concurrency lock, so a
   forgotten one blocks the next run for a reason nobody can see. The hook prints nothing at all when
   the repo is clean, which is the only reason it is worth having at session start:
   ```json
   {
     "hooks": {
       "SessionStart": [
         {
           "matcher": "startup|resume",
           "hooks": [{ "type": "command", "command": "sh \"<plugin-root>/hooks/session-start-stale-flows.sh\"" }]
         }
       ]
     }
   }
   ```
   Write the **resolved absolute path** in place of `<plugin-root>` (expand `${CLAUDE_PLUGIN_ROOT}`
   yourself and paste the result) — that variable is plugin context, and a project settings file is
   not. The plugin also ships the same hook in `hooks/hooks.json` for installs that load plugin
   hooks; if it is already firing, say so and skip this rather than registering it twice. Verify by
   running the script directly — it exits silently on a clean repo, so a silent run is a pass, and an
   error means the path is wrong.

5. **Repo rules (optional but high-value).** `.claude/rules/*.md` is a **native** Claude Code
   convention, not a devkit one: those files load automatically alongside CLAUDE.md, and a `paths:`
   frontmatter key scopes a file so it loads only when Claude works with matching files. The
   contract is therefore not ours to define:
   ```markdown
   ---
   description: what this checklist covers      # optional, ignored by the pipeline
   paths:                                       # optional; omit it and the rule is always loaded
     - "src/db/**/*.ts"
     - "packages/*/schema/*.ts"
   ---
   ```
   What devkit adds is reach: that loading is a *main-session* mechanism, so background workflow
   subagents inherit none of it. The skills extract the manifest with
   `sh "${CLAUDE_PLUGIN_ROOT}/scripts/rules-manifest.sh"` and the workflows match it per agent, which
   makes rules the one channel that specializes a generic pipeline to this repo: matching rules reach
   scouts and implementers, and become an extra `repo-conventions` review lens.

   Verify the manifest here — run the script and show what it found. A rule whose globs come back
   empty is unscoped (fine, and reaches every agent); a rule whose globs look wrong is a `paths:`
   typo, and it will silently reach nobody. Spot-check each non-empty entry against real paths
   (`git ls-files <glob> | head`): a glob matching zero files is the same failure as a typo, and it
   fails silently either way.

   **If `.claude/rules/` does not exist, bootstrap it — as a refactor, not as authorship.** Most
   repos already hold the raw material; a "never do X" or "invariants" section in `CLAUDE.md` is a
   rules file that has not been split by path yet. Read what is already written down and propose
   3-6 candidate files:

   - **Sources, in order of authority:** `CLAUDE.md` and `.claude/CLAUDE.md` (especially any
     always/never/invariant section), `CONTRIBUTING.md`, a style guide under `docs/`, and
     machine-readable config that states a convention outright (`.editorconfig`, lint/formatter
     config, `tsconfig` strictness). Then the directory shape, to know which globs are real.
   - **Never invent a convention the repo has not stated.** If a rule cannot be traced to a
     sentence someone wrote or a config someone committed, it does not go in. Guessing house style
     from the code is how a pipeline starts enforcing an accident.
   - **One approval per file, showing the source.** Present each candidate as its full content plus
     the lines it came from, and let the developer accept, edit or drop it individually. A batch
     "looks good" over six files is not approval, it is a rubber stamp.
   - **Every rule needs a `paths:` that matches something.** Check each glob against `git ls-files`
     before proposing it. A rule scoped to a path that does not exist is invisible, and nothing will
     ever tell you.

   Say what this buys even for someone who never runs the pipeline: `CLAUDE.md` is loaded into
   **every** session, while a `paths:`-scoped rule loads only when Claude works with matching files.
   Moving path-specific guidance out of `CLAUDE.md` makes every unrelated session cheaper. Offer to
   delete the migrated lines from `CLAUDE.md` — leaving both is how the two drift into contradicting
   each other — but only with the developer's explicit go-ahead, one hunk at a time.

6. **Smoke test.** Run each of the three workflows with `args: {"dryRun": true}` — zero agents
   spawned, zero cost. All three must return `{ok: true}`:
   ```
   Workflow({ name: "devkit:wf-explore-plan", args: {"dryRun": true} })
   Workflow({ name: "devkit:wf-implement", args: {"dryRun": true} })
   Workflow({ name: "devkit:wf-review-loop", args: {"dryRun": true} })
   ```
   Fall back to `scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/<name>.js"` if the names have not
   registered yet. A parse failure here is a plugin problem, not a repo problem — show the error.
   Each also returns its resolved `policy` (model/effort per role), so adding the repo's chosen
   `profile` to these calls checks the setting for free, before it can cost anything.

7. **Commit.** Offer to commit whatever step 2-5 changed (`chore: configure devkit pipeline`,
   standard co-author trailer). Skip if the developer declines.

## Report

Checklist results, then:

- The version this repo is now configured against, and — when step 1 found a mismatch — what changed
  between the recorded version and the installed one. That comparison is the whole point of an
  update run; leading with "all steps ok" while burying it is the one way to waste it.
- Suggested first read: `${CLAUDE_PLUGIN_ROOT}/docs/manual.md` (5 minutes — commands, checkpoints,
  troubleshooting). Architecture and design rationale: `${CLAUDE_PLUGIN_ROOT}/docs/architecture.md`.
- Suggested first run: `/dev-plan` on a real medium-sized task, then check the calibration numbers
  in the architecture doc ("First-run calibration checklist").

## Notes

- To change pipeline behavior, edit the plugin, not the repo — a repo cannot fork a prompt. What a
  repo *can* tune is its `.claude/rules/`, which is why step 5 is worth doing properly.
- New or renamed workflow files register at session start; `scriptPath` works immediately.
