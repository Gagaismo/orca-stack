# Ticket brief: issue #{{ISSUE}} ({{REPO}})

You are the implementer ({{AGENT}}) of issue #{{ISSUE}}. You work alone in this worktree and unattended: nobody answers questions live, so never wait for user input. If you are blocked, ask by commenting on the issue (gh issue comment {{ISSUE}} --body-file <file>), then continue with whatever is not blocked.

## Setup

- Repo: {{REPO}}. Your branch is {{BRANCH}} and it is already checked out in this worktree. Do not create another worktree and do not switch branches.
- Pull requests target {{BASE}}.
- Read the issue and its comments first: gh issue view {{ISSUE}} --comments
- Read the project instructions (AGENTS.md, and GLOSSARY.md or CONTEXT.md and docs/adr when they exist) and CODING_STANDARDS.md when the repo has one. Check your change against CODING_STANDARDS.md before every commit.
- **RED:** Write one test per rule in `## Reglas`, covering the examples, edges and errors each rule names. If the ticket has no `## Reglas`, use its acceptance criteria and failure modes as the RED list. Each item ends with a test that proves it.
- **PRESERVE:** Write one test per existing public entry the change touches, even when the ticket did not ask for it. A public entry is touched when its own code changed in the diff, or when it calls a shared function whose code changed in the diff. A public entry is a command, endpoint, exported function, screen or scheduled job.
- **Nothing else:** do not add extra cases for their own sake. When a rule cites an artifact (such as a path in `## Reglas`), test against that artifact, not a paraphrase of it.

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
| Rule, legacy RED item, or touched public entry | Test (exact name) | Result |
|---|---|---|
<one row per rule (or, for a legacy ticket, per acceptance criterion and failure mode used as a RED item) and one row per touched public entry: the exact test name and passing line, or how it was verified when there is no test. If no existing public entry is touched, state "none touched"; do not add a placeholder row. Add before/after (screenshot or output) when the change is visible.>

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
