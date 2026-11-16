# Planning brief: umbrella #{{UMBRELLA}} ({{REPO}})

This is the planning session of umbrella issue #{{UMBRELLA}} ("{{TITLE}}"). The human drives this session from this terminal: it is interactive and takes many turns. Answer the human, ask them when something is unclear, and wait for their next message between steps. Do not plan, write tickets or trigger a skill on your own.

## Setup

- Repo: {{REPO}} ({{REMOTE_REPO}}). This worktree is checked out on branch {{BRANCH}}, created from `origin/{{BASE}}`. Do not create another worktree and do not switch branches.
- Read the umbrella and its comments: gh issue view {{UMBRELLA}} --json title,body,comments
- Before anything else, read GLOSSARY.md (or CONTEXT.md) and every ADR under docs/adr/, when they exist. AGENTS.md is already in your context.
- Then tell the human, in a few lines, what you read and that you are ready, and wait.

## The skills

The human runs the planning skills, in this order: grill-with-docs, then to-spec, then to-tickets. Only the human triggers them; follow each one when the human starts it. If a step needs a product decision, ask the human.

## Docs on this branch

- This session writes the planning docs by design: GLOSSARY.md, the ADRs under docs/adr/ and the spec. Commit them on {{BRANCH}} only, never on {{BASE}} and never in another checkout, and commit docs only: no code.
- Push only this branch, with git push -u origin {{BRANCH}}. Do not open a PR: main opens the orchestration PR from {{BRANCH}}.

## Tickets

- to-tickets publishes every ticket as a sub-issue of #{{UMBRELLA}}: main watches that list, and a ticket that is not a sub-issue of #{{UMBRELLA}} is invisible to it. After creating each issue, link it with gh api repos/{{REMOTE_REPO}}/issues/{{UMBRELLA}}/sub_issues -X POST -F sub_issue_id=<id>, where <id> is the issue's numeric id (gh api repos/{{REMOTE_REPO}}/issues/<n> --jq .id), not its number.
- A ticket that cites an ADR written in this session names it under `## ADRs que aplican`: main dispatches it after the docs PR of {{BRANCH}} merges.
- Push {{BRANCH}} before publishing the tickets, so every doc they cite is on the branch.
- When the last ticket is published, comment on the umbrella with gh issue comment {{UMBRELLA}} --body-file <file>, whose body is the single line `Planificación publicada: #a, #b` listing the sub-issues you published, in order.
