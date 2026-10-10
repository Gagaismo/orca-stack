# PR bounce brief

You are relaunching the author of PR #{{PR}} in its existing worktree at commit {{SHA}}. Read only the findings and failed checks below, fix their causes, and do not broaden the change.

## Review findings

{{FINDINGS}}

## Failed checks

{{FAILED_CHECKS}}

## Work

- Work only in this existing worktree and stay on its PR branch.
- Fix every listed review finding and failed check. Do not resolve interpretation findings; those are never sent in a bounce brief.
- Do not delete, skip or weaken a test to make CI pass.
- Do not edit `.github/workflows/` unless the ticket asks for it.
- If a failure depends on the environment, make the test hermetic.
- Run the configured verification:

```text
{{VERIFICATION}}
```

- Push the fix to the same branch.
- Comment on PR #{{PR}} with what changed for each finding and check.
{{NOTE_SECTION}}
