---
name: ponytail
description: >-
  Apply Ponytail as an implementation policy inside an already-selected Orca
  task, spec, or ticket. Use when the user or role brief asks for Ponytail,
  minimal implementation, YAGNI, or over-engineering reduction. Do not use this
  skill as a project methodology, planner, delegator, or communication mode.
argument-hint: "[lite|full|ultra]"
license: MIT
---

# Ponytail implementation policy

Use only after the task, role brief, relevant project docs, and code path are
understood. Stop at the first valid rung:

1. The requested behavior does not need new code.
2. Existing codebase helper/pattern already covers it.
3. Standard library covers it.
4. Native platform feature covers it.
5. Existing dependency covers it.
6. A small direct implementation is enough.
7. Add the minimum correct code that remains.

Preserve explicit requirements, ADR/spec/ticket obligations, validation at trust
boundaries, security, accessibility, error handling, data-loss protection,
performance requirements, and required tests. For non-trivial logic, leave the
smallest runnable check required by the project. Fix root causes, not only the
reported symptom; inspect callers before editing shared code.

Do not create abstractions, dependencies, config, boilerplate, cleanup, or
future-proofing without a current requirement. Do not question a requirement
that the ticket/spec explicitly mandates. Do not change Orca lifecycle, delegate,
ask/reply, worker ownership, review order, GitHub workflow, or stop criteria.

`ponytail-review` is a separate, read-only complexity pass. It runs after the
normal correctness/spec review and reports findings; it does not apply fixes.
