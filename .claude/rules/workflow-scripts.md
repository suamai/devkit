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
- A self-contained script cannot import a helper, so several blocks are **byte-identical copies**,
  each pinned by a test that fails on drift. Editing one copy means editing all of them in the same
  commit. They are not all fenced and they do not all span the same files, so check before you edit:

  | Copied | In | Pinned by | Sliced how |
  |---|---|---|---|
  | `policy()` | all 3 | `tests/policy.test.js` | by signature |
  | `MODELS`, `EFFORTS`, `ROLE_NAMES` | all 3 | `tests/policy.test.js` | by line prefix |
  | `PROFILES` | all 3 | `tests/policy.test.js` | by signature |
  | per-phase cost (`metered`/`costReport`) | all 3 | `tests/policy.test.js` | fenced |
  | repo-rule matching, and its `GLOB_TOKENS`/`pathScope` primitives | implement + review-loop | `tests/rules.test.js` | fenced / by anchor |
  | `rulesNote` | implement + review-loop | `tests/rules.test.js` | by signature |
  | verify classification | implement + review-loop | `tests/verify-gate.test.js` | by anchor, per-file end |
  | `root`, `GIT`, `RUN_FROM`, `ROOT_NOTE` | implement + review-loop | `tests/isolation.test.js` | by line prefix |

  Two traps the table is meant to spare you. `policy()` and `PROFILES` are extracted by *signature*,
  so moving either is free while editing its body is not — and the constants are rows of their own
  because `wf-implement` forwards `profile`/`models`/`efforts` into the nested `wf-review-loop`,
  which re-validates against its own copy. For `ROLE_NAMES` that drift is loud: a role added to one
  copy alone is accepted there and then throws `unknown role` a wave later, inside the workflow it
  forwarded to. For `PROFILES` the same drift is silent: two copies whose `ROLE_NAMES` agree can still
  price the *same* role differently in their tables, and nothing ever throws — the copy that drifted
  a tier is simply the one a caller's override never reaches, and it silently spends more or less than
  the other copy would. And the last four rows are absent from `wf-explore-plan.js` entirely, so
  "every script" is the wrong mental model. `rulesNote` sits OUTSIDE the repo-rule fence in both files — it renders the
  matched rules, it does not match them — so the fenced comparison says nothing about it and it is
  pinned by its own case.
- Parts of this file are read as **text** by the suite: a guard slices the region between two anchors
  (`const reviewBlocked =` → the next `\n  if (`, in `tests/schedule.test.js`; `  review: ` →
  `? 'blocked'`, in `tests/delivery-verdict.test.js`) and asserts what the slice mentions. A line
  added inside such a region satisfies the guard on a mutant's behalf, so the case that goes red is
  its mutation proof — a test about code you did not touch. That is the diagnosis, not a flake: move
  your line out of the slice, never widen the anchor to make it pass. `grep -n "indexOf('" tests/*.js`
  lists the anchors before you place code near one.
- These scripts are the source of truth for defaults, option sets and severity levels. Changing one
  means changing the prose that restates it — see the rule covering `skills/*/SKILL.md`.
- `name:` resolution serves a snapshot taken when the plugin loaded, so an edited script must be
  invoked by `scriptPath` or the run silently executes the old file.
