---
name: dev-spec
description: Build a grounded task specification through dialogue — repo-anchored questions, goals/non-goals, verifiable acceptance criteria. Use before /dev-plan for large or ambiguous tasks. Writes .dev/<slug>/spec.md.
argument-hint: <rough task description>
---

Spec-building is dialogue, so it happens here in the main loop — no background workflow. The spec's acceptance criteria flow downstream: they anchor exploration, become each plan step's `covers` claim and its verification, feed the review "intent" lens, are checked by the free coverage lint at plan approval, are rendered as `/dev-pr`'s acceptance matrix, and close the final consistency check. Every one of those consumers addresses a criterion **by id**, which is why the criteria below are numbered and why the numbers are permanent.

## Process

1. **Workspace.** Derive a short kebab-case slug from the task; the workspace is `.dev/<slug>/` (absolute path, under the repo root). Create the directory.

2. **Ground yourself BEFORE asking anything.** Do a quick scan of the areas the task touches — an Explore agent or targeted greps, a few minutes' worth, not a full exploration (that is wf-explore-plan's job). The point: generic requirement questions are useless; questions anchored in what actually exists ("there's already a `NotificationService` — does the new feature extend it or replace it?") get real answers.

3. **Interview.** 1-2 AskUserQuestion rounds, max 3-4 questions each. Every question must be traceable to something you found in the repo or to a genuine fork in scope/behavior. Infer everything you can; ask only what you cannot.

4. **Write `<workspace>/spec.md`:**
   - **Goal** — one paragraph, the observable outcome.
   - **Non-goals** — explicitly out of scope (prevents scope creep downstream).
   - **Acceptance criteria** — each one VERIFIABLE: a command to run, a behavior to exercise, an invariant to check. "Works well" is not a criterion; "`POST /orders` returns 422 for an empty cart" is. **One criterion per bullet, each beginning with a stable id**, numbered from `AC-01` in document order:

     ```markdown
     - AC-01: `POST /orders` returns 422 for an empty cart.
     - AC-02: `sh tests/run-all.sh` passes, the contract-drift suite included.
     ```

     The id is the address every downstream consumer uses: a plan step declares `covers: ["AC-01"]`, the
     coverage lint checks those declarations against this list, and `/dev-pr` renders one matrix row per
     id. So an id is **never reused and never renumbered** once written. Dropping a criterion retires its
     id and the next one keeps counting; a criterion added later takes the next free number rather than
     being inserted in the middle. Renumbering is the failure that costs the most and shows the least — it
     silently re-points every `covers` and every matrix row that already cites the old number. And one id
     means one checkable thing: two criteria joined by an "and" cannot be told apart in the matrix, so
     split them into two ids.
   - **Constraints** — tech choices, compatibility, performance, style.
   - **Grounding** — pointers (`file:line`) to the existing code the spec talks about.

5. **Register the flow.** Write `<workspace>/state.json`: `{ task, stage: "spec", updated: "<YYYY-MM-DD HH:MM>", runs: [{ "phase": "spec", "ts": "<the same timestamp>" }] }`. State lives inside the workspace it describes, so the file has exactly one writer by construction — there is no shared registry to reconcile. `runs` is the compact per-phase record every later phase appends to: add this run's entry, never rewrite an entry that is already there.

6. **Present and iterate.** Show a concise summary; apply the developer's adjustments to the file.

7. **Handoff.** Suggest `/dev-plan` pointed at the same slug — it picks up `spec.md` from the workspace automatically. Then append one `spec` line to the run ledger, once per invocation:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/ledger-append.sh" <<'JSON'
{"phase":"spec","slug":"<slug>"}
JSON
```

The line carries the slug and nothing else, because a spec has no counts to report: it exists so the
ledger can say how often a spec preceded a plan. The envelope — timestamp, plugin version, repo, SHA
— is the script's job and never yours, and a failed append is one sentence in the handoff, never a
failed phase.

## Artifact language

If `CLAUDE.md` carries an `Artifact language: <language>.` line, write `spec.md` in that language.
No line means today's behavior: it follows the conversation. Acceptance criteria are the exception
that matters — the command, endpoint, flag or identifier inside one is an address, and it stays
exactly as it appears in the repo. Translate the sentence around it, never the thing being run. The
`AC-01` id is an address in the same way: it is never translated, localized or renumbered, because a
plan's `covers` and a matrix row cite it verbatim.
