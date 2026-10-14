# PR bounce brief

You are relaunching the author of PR #{{PR}} in its existing worktree at commit {{SHA}}. Read only the findings and failed checks below, fix their causes, and do not broaden the change. If you are blocked, ask with a `Consulta:` comment on PR #{{PR}} (gh pr comment {{PR}} --body-file <file>), then continue with whatever is not blocked.

## Review findings

{{FINDINGS}}

## Failed checks

{{FAILED_CHECKS}}

## Work

- Work only in this existing worktree and stay on its PR branch.
- Resume the ODD feature `issue-{{ISSUE}}` with ODD's resume protocol (the document is still in the worktree).
- Fix every listed review finding and failed check. Do not resolve interpretation findings; those are never sent in a bounce brief.
- Do not delete, skip or weaken a test to make CI pass.
- Do not edit `.github/workflows/` unless the ticket asks for it.
- If a failure depends on the environment, make the test hermetic.
- If you are blocked, ask with a `Consulta:` comment on PR #{{PR}}.
- Run the configured verification:

```text
{{VERIFICATION}}
```

- Push the fix to the same branch.
- Comment on PR #{{PR}} with what changed for each finding and check.
- The PR already bounced and the new failure shares the previous fix's premise: read `~/.claude/skills/principle-attack-the-premise/SKILL.md`.

## Remote authorization

- Destination: {{REMOTE_HOST}}, repository {{REMOTE_REPO}}
- Credential/session: the GitHub CLI (`gh`) session and the git credentials already configured on this machine.
- Operations: {{REMOTE_OPERATIONS}}
- Explicitly not authorized: merge, force push, deleting branches or issues, other repos, remotes or hosts.
{{NOTE_SECTION}}
