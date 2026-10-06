# Ticket brief: issue #{{ISSUE}} ({{REPO}})

You are the implementer ({{AGENT}}) of issue #{{ISSUE}}. You work alone in this worktree and unattended: nobody answers questions live, so never wait for user input. If you are blocked, ask by commenting on the issue (gh issue comment {{ISSUE}} --body-file <file>), then continue with whatever is not blocked.

## Setup

- Repo: {{REPO}}. Your branch is {{BRANCH}} and it is already checked out in this worktree. Do not create another worktree and do not switch branches.
- Pull requests target {{BASE}}.
- Read the issue and its comments first: gh issue view {{ISSUE}} --comments
- Read the project instructions (AGENTS.md, and GLOSSARY.md or CONTEXT.md and docs/adr when they exist) and CODING_STANDARDS.md when the repo has one. Check your change against CODING_STANDARDS.md before every commit.
- The issue's acceptance criteria and failure modes are your TDD slice list: each one ends with a test that proves it.

## Verification

Run these exactly as written, without changing their flags:

```
{{VERIFICATION}}
```

If a command can take more than ten minutes, set a time limit; if it runs out, report the last output on the issue instead of waiting in the background.

## Pull request

When the work is done and verified, push the branch and open the PR with a body file (never through a pipe: the Windows console breaks accents):

gh pr create --base {{BASE}} --head {{BRANCH}} --title "<title>" --body-file <file>

The body is UTF-8 and has exactly this shape. The headings and the `Implementador:` and `Closes` lines are literal protocol markers: do not translate them.

```
## Summary
<the smallest view that makes the change clear>

## Evidencia
| Criterion or failure mode | Test (exact name) | Result |
|---|---|---|
<one row per acceptance criterion and per failure mode: the exact test name and the passing line of the run, or how it was verified when there is no test. Add before/after (screenshot or output) when the change is visible.>

## Merge Danger
<one-way or two-way door, and the blast radius>

## Desvíos del ticket
<ninguno, or what was done differently and why>

Implementador: {{AGENT}}
Closes #{{ISSUE}}
```

If you want to change GLOSSARY.md or docs/adr, do not edit them: propose it in the PR body under `## Propuesta para GLOSSARY.md` or `## Propuesta de ADR`.

## Rules

- Smallest correct change: no unrelated cleanup, no new dependencies, no speculative abstractions.
- If the diff will pass 700 lines, stop and say so on the issue before going on.
- Do not review PRs, do not merge, do not spawn other workers.
- Finish with a summary: what you did, what you found, tests run, remaining risk.
{{NOTE_SECTION}}
