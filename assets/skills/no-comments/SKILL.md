---
name: no-comments
description: "Author self-check for code comments: run the comment reviewer on the diff, sort every comment into the four types of the comment rule, and apply each type's action."
disable-model-invocation: true
---

# No comments

Run the comment reviewer. Act on accepted findings.

Defer to the reviewer's fresh perspective.

This is an author self-check: it runs before the PR opens and does not count as a review.

## Scope

Use the caller's files or diff. Otherwise use the current diff against the base branch, default `main`, including the working tree.

## The comment rule

Every code comment falls under one of four types, and each type says what to do with it:

| Type | Action |
|---|---|
| Tautology | Delete it. |
| Excuse | Delete it and open an issue to fix the implementation. |
| Stale | Delete it. |
| Decision Record | Move it to an ADR. |

The only comment that stays is a Decision Record that cites an ADR or an issue `#n`. When the repo has a `CODING_STANDARDS.md`, its comment rule and its judgment rules take precedence over this summary.

## Steps

1. Run `orca-stack lint` on the scope when the repo has it, and fix every finding. The lint checks the mechanical part of the rule; the steps below cover what it cannot judge.
2. Start a subagent with a clean context, and give it the scope and `references/reviewer.md`, next to this file. Pick its reasoning level for the job. Do not restate its rules. If you cannot start a subagent, apply `references/reviewer.md` yourself on the scope.
3. Inspect its report and diff. Reject application-code edits, scope escapes, a type or action that does not match the table, and any finding on a Decision Record that cites an ADR or an issue `#n`. Before accepting a finding on a comment that claims a constraint (`IMPORTANT`, `do not remove`), trace the symbol it names. Rerun one rejected report with the failure named. Reject a second, report it open, and fail the self-check.
4. Apply each accepted finding. Delete a Tautology or a Stale comment. For an Excuse, delete the comment and fix the implementation when the fix is small and inside the scope; otherwise open an issue for it, or, when you may not open issues (a dispatched worker), list it under `## Desvíos del ticket` for main. Never bolt on a symptom guard to make the comment unnecessary.
5. A Decision Record without a citation moves to an ADR, and the code cites it. An implementer who does not edit `docs/adr/` proposes the ADR under `## Propuesta de ADR` in the PR body and cites the ticket's issue `#n` meanwhile. A constraint comment (`do not remove`, `do not change the wording`) is a Decision Record: when a type, a runtime check, a test or a lint rule inside the scope can enforce it cheaply, encode it and delete the comment.
6. Report the deletion count per type, the issues opened or listed, the ADRs proposed, the encodings, the rejected findings and reruns, and other open work.

## Adaptation Note

Adapted from pstack (`cursor/plugins`, version 0.15.43, commit `2f87c85`). Changes from upstream:

- Upstream spawns its reviewer, comment-sicko, with `Task` and `subagent_type: "comment-sicko"`. Here any subagent with a clean context receives `references/reviewer.md`, and an agent that cannot start one applies it itself.
- The reviewer persona (`pstack/agents/comment-sicko.md`, version 0.15.42, commit `bf0c7cd`) is rewritten in a sober tone as `references/reviewer.md`: no insults, jokes or exaggerated tone; it states the type, the location and the action of each finding.
- Upstream's own taxonomy (a list of exceptions that may stay, everything else deleted, and `MUST KILL` flags on the code to reshape) is replaced by the four types of the comment rule in `CODING_STANDARDS.md` (Tautology, Excuse, Stale, Decision Record) and their actions. What is never flagged follows `orca-stack lint`: shebangs, license headers, `eslint-disable` and `@ts-…` directives and JSDoc type annotations a tool requires.
- Added step 1: `orca-stack lint` covers the mechanical part of the rule before the reviewer runs.
- Removed the references to skills orca-stack does not ship: poteto-mode (reasoning level), `/why` (now: trace the symbol), `/architect` (no design sketch step), principle-fix-root-causes and principle-redesign-from-first-principles.
- Upstream waits for interactive approval before encoding a constraint comment. orca-stack workers run unattended, so a constraint comment is a Decision Record, encoded only when that is cheap and inside the scope.
- Added where an Excuse's issue and a Decision Record's ADR go when the author may not open issues or edit `docs/adr/`.
- Added that this is an author self-check and does not count as a review.
- Added this note.
