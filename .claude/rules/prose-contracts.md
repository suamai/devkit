---
description: the skills and docs restate what the scripts do — keep them in sync
paths:
  - "skills/*/SKILL.md"
  - "docs/*.md"
  - "README.md"
---

The workflow scripts are the source of truth for defaults, option sets and severity levels; these
documents restate them for a human. A script that changes without its prose leaves a confident lie
behind — the failure no reviewer catches, because nobody diffs a `SKILL.md` against a schema.
`tests/contract-drift.test.js` is what enforces this. Rationale: `docs/architecture.md` → "Testing".

- Changing a default, an option set (`scoutMode`, `profile`, the role names) or a severity enum in a
  script means updating every document that states the value, in the same commit.
- A backticked `` `name: a | b | c` `` span **is** the pinned restatement, wherever it sits:
  `contract-drift` reads every such span in these files and compares the members, in the schema's
  order, against the enum extracted from the script. State the whole set or none of it — a partial or
  reordered list is drift, not shorthand. To name one member, give it its own span (`` `kind` `` …
  `` `existing-suite` ``); to write a vocabulary that is deliberately *not* tracked, separate it with
  `·`, as the gate table in `docs/architecture.md` does — a `|` there is a pinned statement waiting
  for the day someone adds that name to `OPTION_SETS`.
- Names are addresses, and the drift test checks them: a `/dev-*` mentioned anywhere must exist as a
  skill on disk, every skill must be mentioned somewhere, a `devkit:wf-*` must resolve to a workflow
  file, and a skill's frontmatter `name` must match its directory.
- Workflow prompt ↔ skill prose is **not** duplication to remove. The prompt instructs an agent, the
  skill instructs the orchestrator; they must *agree*, not be deduplicated.
- An extraction more than one skill has to perform *identically* belongs in `scripts/`, invoked by
  name. That is what `scripts/rules-manifest.sh` is: four skills pass `rules` off one implementation,
  tested once in `tests/rules.test.js`, with nothing to drift. A command copied into each `SKILL.md`
  instead gives two entry points that can compute different answers from the same repo, silently.
  Where a copy is genuinely unavoidable, it is a contract, not a convenience: identical bytes, and a
  check comparing the pair — `tests/contract-drift.test.js` byte-compares the criteria-extraction
  `grep` that `/dev-plan` and `/dev-implement` each state, for exactly that reason.
- Prefer a stated concrete value over a vague restatement. The drift test compares values extracted
  from source, so a sentence that names the number is checkable and a sentence that gestures at it is
  not.
- Run `sh tests/run-all.sh` before committing a prose change, exactly as for a code change.
