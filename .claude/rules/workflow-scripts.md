---
description: house rules for the self-contained Workflow scripts in workflows/
paths:
  - "workflows/*.js"
---

These scripts run as Workflow tool scripts: deterministic JS spawning subagents, with no filesystem
access and no imports. Each rule below exists because the runtime requires it or because it bit us.
Full rationale: `docs/architecture.md` → "Authoring a bespoke workflow" and "Cost policy".

- `export const meta = { name, description, phases }` must be a **pure literal** — no variables, no
  interpolation — and its phase titles must match the `phase()` calls exactly.
- Open the body by normalizing args
  (`if (typeof args === 'string') { try { args = JSON.parse(args) } catch (e) { throw … } }`)
  and a `dryRun` guard that returns before anything can spend a token.
- No `Date.now()`, `Math.random()` or argless `new Date()` — the runtime throws, because they break
  resume. Timestamps arrive via args or from an agent running `date`.
- Escape backticks inside template literals. An unescaped fence is the classic parse error.
- Every `agent()` call carries a JSON `schema`, and prompts end by saying the output is raw data for
  an orchestrator. Prose goes to workspace files: agents return compact summaries plus paths, never a
  dump piped into the next prompt.
- `pipeline()` by default; `parallel()` only for a true barrier. Agents that mutate files need
  disjoint file ownership, or they run serially.
- A budget guard in every loop (`if (budget.total && budget.remaining() < 30000) break`) — and know
  that it is inert unless the developer put a target in their own message. Guard, don't promise;
  report `floors_active` rather than implying the run was bounded.
- Bracket phases with `metered(phase, fn)` so the run reports its own cost. Deltas of
  `budget.spent()` only mean anything around non-overlapping intervals, so meter phases, never
  individual agents inside a `parallel()`.
- `workflow()` nests **one level only**. `wf-implement` already calls `wf-review-loop`, so as a child
  it needs `review: false`.
- The three fenced shared blocks — `policy()`, the per-phase cost block, and the repo-rule matching
  block — are **byte-identical across every script**, because a self-contained script cannot import a
  helper. `tests/policy.test.js` and `tests/rules.test.js` fail when they drift, by design: editing
  one copy means editing all of them in the same commit.
- These scripts are the source of truth for defaults, option sets and severity levels. Changing one
  means changing the prose that restates it — see the rule covering `skills/*/SKILL.md`.
- `name:` resolution serves a snapshot taken when the plugin loaded, so an edited script must be
  invoked by `scriptPath` or the run silently executes the old file.
