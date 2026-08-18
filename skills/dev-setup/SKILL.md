---
name: dev-setup
description: Configure a repository to use the devkit dev pipeline — gitignore, CLAUDE.md pointer, Workflow permission, the stale-flow session hook, and a zero-cost smoke test of the three workflow scripts. Records the plugin version it configured against, so a later run can say what changed. Use in a new project, or to check an existing setup after installing or updating the plugin.
argument-hint: [--check]
---

You configure the repository you are in to work with the `devkit` pipeline. The skills, workflows
and docs ship with the plugin — nothing is copied into the repo, so there is no install mode and no
file-drift to reconcile. What a repo still owns is small: where scratch goes, whether teammates can
find the manual, and the repo's own path-scoped rules.

## Checklist

Work through these, reporting each as ok / fixed / skipped-with-reason.

Invoked as `/dev-setup --check`, this becomes a read-only diagnosis instead: the writing steps are
skipped and nothing in the repo is touched. See **Read-only check (--check)** below.

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
   Configured against devkit 0.3.0.
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
   hooks; if it is already firing, say so and skip this rather than registering it twice. Under a
   marketplace install that is the normal case, and preferring it is not merely tidier: the absolute
   path you would write here is correct on this machine and wrong on a teammate's, while
   `.claude/settings.json` is usually committed. So where you do write it, say plainly that it is the
   one line of this checklist that should not be shared. Verify by
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

## Read-only check (--check)

`--check` is a **diagnosis, not a configuration run**, and that is an invariant rather than a
preference: a diagnostic that repairs as it goes cannot be used to find out what is wrong. In this
mode you create no file, edit no file, add no permission, bootstrap no rules, write no `.gitignore`
line and offer no commit. Checklist steps 2, 3, 4, 5's bootstrap and 7 are skipped entirely, and
step 1 keeps only its reading half. Run this in a repo that has never been configured and that repo
must be exactly as you found it when the report prints — the report is the only output.

Report each of the ten items below as `ok`, `problem` or `unknown`, with the evidence you actually
read. `unknown` is a real verdict — the check could not run, because there is no git repository, no
rules directory, or a frozen-install file that is not there — and it is never a polite word for
"probably fine".

1. **Plugin and manifest version.** Read `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` and
   `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/marketplace.json` — the marketplace states the version twice
   more and a consumer reads those, so a disagreement between the three is a packaging problem worth
   naming — plus `${CLAUDE_PLUGIN_ROOT}/FROZEN_AT`, which exists only in a frozen install: its
   absence is `unknown` and means "running from a checkout", not a problem. Compare with the repo's
   `Configured against devkit <version>.` line exactly as step 1 does, and stop at the comparison. On
   a mismatch, summarise the `${CLAUDE_PLUGIN_ROOT}/CHANGELOG.md` entries between the two versions
   and name `/dev-setup` without the flag as what updates the line. The line is read here and never
   rewritten.

2. **The three workflow names resolve.** `devkit:wf-explore-plan`, `devkit:wf-implement` and
   `devkit:wf-review-loop`. If they do not, the plugin was installed or updated after this session
   started: say that, and that Claude Code has to be restarted before the names register. It is not
   a repo problem and nothing in this repo fixes it. Item 5 still runs meanwhile, through step 6's
   `scriptPath` fallback.

3. **`${CLAUDE_PLUGIN_ROOT}` expands in a skill body.** Every path above depends on it, and it fails
   as *text* rather than as an error, so prove it: run one command that uses it —
   `ls "${CLAUDE_PLUGIN_ROOT}/workflows"` — and read the failure literally. An error quoting an
   unexpanded, literal `${CLAUDE_PLUGIN_ROOT}` is the signal, and it means every path in this skill
   that uses the variable is dead for this session. A listing of the workflow files is the pass.

4. **The `Workflow` permission, and the stale-flow hook.** Read `permissions.allow` from
   `.claude/settings.json` and from `.claude/settings.local.json`: either may carry `"Workflow"` and
   either counts, so report which one does, or that neither does — the cost of that is the recurring
   permission prompt, nothing worse. Then the `SessionStart` hook, which is registered either in
   those same settings files or by the plugin's own `hooks/hooks.json`. Report which of the two, and
   report *both* when both are there: a hook registered twice prints twice. A settings file that
   does not exist is reported, never created — step 4 is what writes it.

5. **The three smoke tests, and the policy they resolve.** Run step 6's three `dryRun` calls as they
   are written there, adding this repo's cost profile (the `Cost profile:` line step 3 documents) as
   `profile`, which checks that setting for free. Report `{ok: true}` and the resolved `policy`
   (model and effort per role) for each, together with the profile that produced it. Say in the
   report that these spawn **zero agents and cost nothing** — that is the whole reason a read-only
   diagnostic may run them at all, and a reader who does not know it will assume a `--check` just
   spent money. A parse failure here is a plugin problem, not a repo problem: show the error.

6. **Rule-manifest parse errors.** Run `sh "${CLAUDE_PLUGIN_ROOT}/scripts/rules-manifest.sh"` and
   show what it found — then read the files yourself, because the script has no error path at all. A
   deliberately unscoped rule and a malformed one come back identically, as an empty `globs` array
   (`scripts/rules-manifest.sh:17-18`), so an empty `globs` proves nothing on its own. Open each
   `.claude/rules/*.md` and look for the three failures the script cannot report: no opening `---`,
   frontmatter never closed by a second `---`, and a `paths:` key with no list items under it. Name
   the file and the line. A rule with genuinely no `paths:` key is `ok`: unscoped is a valid choice
   and reaches every agent.

7. **Rule globs matching no tracked file.** One `git ls-files <glob> | head -1` per non-empty glob.
   A zero match is the same failure as a `paths:` typo and just as silent — the rule reaches nobody
   and nothing ever says so. Step 5 states this as a spot-check; here it is every glob, each
   reported by name with the glob that found nothing.

8. **Stale workspaces.** Glob `.dev/*/state.json` and flag any workspace at stage `implementing`
   with no running workflow task, or with an `updated` older than about 24h — the rule `/dev-status`
   applies (`skills/dev-status/SKILL.md:64`) and the one `hooks/session-start-stale-flows.sh` prints
   at session start. A workspace carrying `archived` is finished on purpose and is never stale. Say
   what continues one (`/dev-implement <slug>`) and what clears it (`/dev-status clean <slug>`), and
   that `/dev-implement` treats a stale workspace as a concurrency lock — that is why a forgotten one
   is worth reporting rather than ignoring.

9. **Git, remote and `gh`.** `git rev-parse --show-toplevel` first: no repository means
   `/dev-implement`, `/dev-review` and `/dev-pr` have no diffs to work from, which is a `problem` to
   report and step 2's to fix. Then `git remote -v`, and `gh auth status` **only** when a GitHub
   remote exists. Report which `/dev-pr` lane this repo lands in by pointing at the lane table
   (`skills/dev-pr/SKILL.md:16-23`) instead of restating it; a non-GitHub remote and no remote at all
   are lanes, not problems.

   **The run ledger is out of scope, deliberately.** This mode never reads, greps or aggregates
   `~/.claude/devkit/runs.jsonl`: no agent may read raw ledger lines (`scripts/ledger-report.sh`'s
   header states the invariant), and comparing the installed commit against recent runs was dropped
   rather than smuggled in through a file this mode has no business opening.

10. **The summary, and what to run.** Close with one list: every `problem`, in the order worth
    fixing, and the exact invocation that fixes it — `/dev-setup` without the flag for anything that
    would write (steps 2, 3, 4, 5 and 7), a Claude Code restart for item 2, an editor for a
    malformed rules file. Then stop. **In this mode you do not apply a fix, even when asked**: say
    which invocation does it and let the developer run that. Switching modes mid-run is exactly how
    a diagnostic becomes the thing it was diagnosing, and changing nothing is the only guarantee
    `--check` has to offer.


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
