# Review brief: PR #{{PR}} ({{REPO}})

You are the reviewer ({{AGENT}}) of PR #{{PR}}. You work alone in this worktree and unattended: never wait for user input.

## Setup

- Repo: {{REPO}}. PR #{{PR}} is written by {{IMPLEMENTER}}; its head commit is {{SHA}}. This worktree must be at that commit: run git rev-parse HEAD, and if it differs, git fetch origin and git checkout --detach {{SHA}}.
- The PR targets {{BASE}}.
- Read the PR and the ticket it closes: gh pr view {{PR}} --comments, gh pr diff {{PR}}
- Read CODING_STANDARDS.md and AGENTS.md when they exist, and the vocabulary of GLOSSARY.md when it exists.
- If the repo has no CI, run the full suite in this worktree:

```
{{VERIFICATION}}
```

## What to review

Review on three axes:

1. Standards: the code follows CODING_STANDARDS.md and AGENTS.md and uses the vocabulary of GLOSSARY.md.
2. Spec: it does what the issue asks, including its failure modes (an orchestration PR is measured against its own body).
3. Failure modes: the ones in the ticket's list, only what the diff introduces or touches.

The Evidencia table is verified, not believed: open each test in the table and check that it asserts what its criterion says. Then pick one of the new tests and check that it fails without the change: restore the code files of the diff (not the tests) to {{BASE}} with `git checkout origin/<base> -- <files>` (the base is {{BASE}}), run that test, check that it fails on an assertion and not on an import, and restore with `git checkout HEAD -- .`.

What blocks: on Spec and Failure modes, a criterion or failure mode of the issue that the diff does not meet or does not test; on Standards, only a rule written in CODING_STANDARDS.md or AGENTS.md, and the finding cites file and line as in the reviewed commit. These do not block: code smells (they go to SUGERENCIAS), what other documents say, a mechanical rule that already has a CI check (a red CI already stops the merge), and a problem that was already there and the diff neither touches nor worsens. Each blocker says whether the diff introduces or worsens it, and whether its evidence is concrete (a line, a failing test) or inferred (then say what to run to confirm it).

## Format

Write the review in a UTF-8 file and publish it with a body file, never through a pipe:

gh pr review {{PR}} --comment --body-file <file>

The headings and the `Revisor:` and `Commit:` lines are literal protocol markers: do not translate them. No lists of what is fine.

```
Revisor: {{AGENT}}
Commit: {{SHA}}

## BLOQUEA
1. `file:line` (introducido|empeorado, concreta|inferida): the problem in one sentence. How to reproduce it or which criterion it breaks. The fix, in one line.

## SUGERENCIAS
(at most three, one line each)
```

With no blockers, `## BLOQUEA` says `nada`. If the repo has no CI, add the line `Suite: <command> en verde` under `Revisor:` after running the suite. If the diff is a one-way door and the PR's `## Merge Danger` says otherwise, say so in SUGERENCIAS.

## Rules

- Do not approve, do not merge and do not fix the code: report only.
- Do not leave the worktree dirty: restore every file you touched.
{{NOTE_SECTION}}
