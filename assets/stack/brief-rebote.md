# PR bounce brief

You are relaunching the author of PR #{{PR}} in its existing worktree at commit {{SHA}}. Read only the blocking findings below, fix them, and do not broaden the change.

## Blocking findings

{{FINDINGS}}

## Work

- Work only in this existing worktree and stay on its PR branch.
- Fix every listed finding. Do not resolve interpretation findings; those are never sent in a bounce brief.
- Run the configured verification:

```text
{{VERIFICATION}}
```

- Push the fix to the same branch.
- Comment on PR #{{PR}} with what changed for each finding.
{{NOTE_SECTION}}
