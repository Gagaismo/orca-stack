# PR bounce brief

You are relaunching the author of PR #{{PR}} in its existing worktree at commit {{SHA}}. Read only the findings, failed checks and merge conflict below, fix their causes, and do not broaden the change. If you are blocked, ask main with `orca orchestration ask` (the command is in Orca's preamble above), then continue with whatever is not blocked, and end your turn once only blocked work is left: Orca wakes you with the answer, as Orca mail, not as a comment. A question, including a deviation that needs a decision, always goes through `orca orchestration ask`. A message from main may arrive while you work. It points at a comment: read it, adjust, and keep going. It never asks you to wait.

## Review findings

{{FINDINGS}}

## Failed checks

{{FAILED_CHECKS}}
{{CONFLICT_SECTION}}
## Work

- Fan-out: {{FANOUT_INSTRUCTIONS}}
- Work only in this existing worktree and stay on its PR branch.
- Resume the ODD feature `issue-{{ISSUE}}` with ODD's resume protocol (the document is still in the worktree).
- Fix every listed review finding and failed check. Do not resolve interpretation findings; those are never sent in a bounce brief.{{DEFECT_CLASS_STEP}}
- When a finding or failed check is about the PR body, fix the body file, edit the PR with `--body-file` (`gh pr edit {{PR}} --body-file <file>`), make no commit for it, and say in the PR comment that the head did not change. The edited body keeps its `Implementador:` and `Closes #<n>` lines and is UTF-8 without a BOM.{{BODY_PRECHECK_STEP}}
- Do not delete, skip or weaken a test to make CI pass.
- Do not edit `.github/workflows/` unless the ticket asks for it.
- If a failure depends on the environment, make the test hermetic.
- If you are blocked, ask main with `orca orchestration ask`.
- If RDD asks for consent on your own candidate (an RDD you would start before you push), the orca-stack policy answer is `declined`: pi's Gentle Shell answers it by itself (orca-stack launched it with `GENTLE_PI_ORCA_RDD_POLICY=1` and wrote the policy file in this worktree's git dir), and any other agent answers `declined` itself; never ask the human. This holds while `agentes.{{AGENT}}.rddConsentimiento` in .orca-stack.json is absent or `"politica"` (the default); with `"humano"`, ask with a `Consulta: {{AGENT}}` comment on PR #{{PR}} instead.
- Run the configured verification:

```text
{{VERIFICATION}}
```{{PI_FOREGROUND}}

- Push the fix to the same branch.
- Comment on PR #{{PR}} with what changed for each finding and check.
- The PR already bounced and the new failure shares the previous fix's premise: read `~/.claude/skills/principle-attack-the-premise/SKILL.md`.

## Remote authorization

- Destination: {{REMOTE_HOST}}, repository {{REMOTE_REPO}}
- Credential/session: the GitHub CLI (`gh`) session and the git credentials already configured on this machine.
- Operations: {{REMOTE_OPERATIONS}}
- Explicitly not authorized: merge, force push, deleting branches or issues, other repos, remotes or hosts.
{{NOTE_SECTION}}
