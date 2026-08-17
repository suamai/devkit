---
name: dev-spec
description: Build a grounded task specification through dialogue — repo-anchored questions, goals/non-goals, verifiable acceptance criteria. Use before /dev-plan for large or ambiguous tasks. Writes .dev/<slug>/spec.md.
argument-hint: <rough task description>
---

Spec-building is dialogue, so it happens here in the main loop — no background workflow. The spec's acceptance criteria flow downstream: they anchor exploration, become each plan step's verification, feed the review "intent" lens, and close the final consistency check.

## Process

1. **Workspace.** Derive a short kebab-case slug from the task; the workspace is `.dev/<slug>/` (absolute path, under the repo root). Create the directory.

2. **Ground yourself BEFORE asking anything.** Do a quick scan of the areas the task touches — an Explore agent or targeted greps, a few minutes' worth, not a full exploration (that is wf-explore-plan's job). The point: generic requirement questions are useless; questions anchored in what actually exists ("there's already a `NotificationService` — does the new feature extend it or replace it?") get real answers.

3. **Interview.** 1-2 AskUserQuestion rounds, max 3-4 questions each. Every question must be traceable to something you found in the repo or to a genuine fork in scope/behavior. Infer everything you can; ask only what you cannot.

4. **Write `<workspace>/spec.md`:**
   - **Goal** — one paragraph, the observable outcome.
   - **Non-goals** — explicitly out of scope (prevents scope creep downstream).
   - **Acceptance criteria** — each one VERIFIABLE: a command to run, a behavior to exercise, an invariant to check. "Works well" is not a criterion; "`POST /orders` returns 422 for an empty cart" is.
   - **Constraints** — tech choices, compatibility, performance, style.
   - **Grounding** — pointers (`file:line`) to the existing code the spec talks about.

5. **Register the flow.** Write `<workspace>/state.json`: `{ task, stage: "spec", updated: "<YYYY-MM-DD HH:MM>" }`. State lives inside the workspace it describes, so the file has exactly one writer by construction — there is no shared registry to reconcile.

6. **Present and iterate.** Show a concise summary; apply the developer's adjustments to the file.

7. **Handoff.** Suggest `/dev-plan` pointed at the same slug — it picks up `spec.md` from the workspace automatically.

## Artifact language

If `CLAUDE.md` carries an `Artifact language: <language>.` line, write `spec.md` in that language.
No line means today's behavior: it follows the conversation. Acceptance criteria are the exception
that matters — the command, endpoint, flag or identifier inside one is an address, and it stays
exactly as it appears in the repo. Translate the sentence around it, never the thing being run.
