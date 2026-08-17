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
- Names are addresses, and the drift test checks them: a `/dev-*` mentioned anywhere must exist as a
  skill on disk, every skill must be mentioned somewhere, a `devkit:wf-*` must resolve to a workflow
  file, and a skill's frontmatter `name` must match its directory.
- Workflow prompt ↔ skill prose is **not** duplication to remove. The prompt instructs an agent, the
  skill instructs the orchestrator; they must *agree*, not be deduplicated.
- Prefer a stated concrete value over a vague restatement. The drift test compares values extracted
  from source, so a sentence that names the number is checkable and a sentence that gestures at it is
  not.
- Run `sh tests/run-all.sh` before committing a prose change, exactly as for a code change.
