# RDD review brief

You are pi, the author of PR #{{PR}}, relaunched in its existing worktree at commit {{SHA}}. main chose an RDD review of this commit with lenses {{LENSES}}: an RDD review pi runs on its own PR when main asks is a review of record, and its clean-context reviewers review a frozen commit. If you are blocked, ask with a `Consulta:` comment on PR #{{PR}} (gh pr comment {{PR}} --body-file <file>), then continue with whatever is not blocked. Anything you post for main (a question, a cap you passed, a deviation that needs a decision) starts with `Consulta: {{AGENT}}`. A message from main may arrive while you work. It points at a comment: read it, adjust, and keep going. It never asks you to wait.

## Work

- Fan-out: {{FANOUT_INSTRUCTIONS}}
- Work only in this existing worktree and stay on its PR branch; resume the ODD feature `issue-{{ISSUE}}` with ODD's resume protocol.
- If the PR body's `## Merge Danger` lacks the `Tier:`, `reviewDue:` or `Risk:` line, run `gentle_review` with operation `assess` and input `{"baseRef":"<git merge-base HEAD origin/<the PR base branch>, the full 40-character sha>","committedOnly":true}` and add them with `gh pr edit {{PR}} --body-file <file>` (UTF-8 without a BOM; keep its `Implementador:` and `Closes #<n>` lines).
- Run the full RDD lifecycle on commit {{SHA}} with `gentle_review`: inspect, then start with `{"mode":"ordinary","lenses":[<exactly {{LENSES}}>],"lensesReason":"main chose these lenses for PR #{{PR}}"}`, collect with `gentle_review_capture` or `gentle_review_capture_group`, and finish with the provider-issued acknowledgement. Use exactly the lenses main chose.
- Consent: this brief is main's decision that the PR gets an RDD review, not the provider consent. If START returns a consent envelope or a forecast that needs a human answer and no tool can answer it unattended, do not answer it yourself and do not skip it: post a `Consulta: {{AGENT}}` comment on PR #{{PR}} with the envelope's headline, choices and `consentBinding`, and end your turn.
- Make at most the one bounded correction RDD allows. If it changes code, run the configured verification (below), commit, and push to the same branch; the review then covers the new head.
- Publish the outcome with a body file, never through a pipe: `gh pr review {{PR}} --comment --body-file <file>`, in the review format. Its first lines are `Revisor: pi (RDD: {{LENSES}})` and `Commit: <sha>` (the commit reviewed: the PR head after any correction), then `## BLOQUEA` and `## SUGERENCIAS`. `## BLOQUEA` says `nada` when the outcome is `approved`; with a `correction_required` that the correction did not clear, it lists one numbered finding per remaining blocker in the contract's format: `archivo:línea` (introducido|empeorado, test|comando|regla escrita|regla sin test, implementación|interpretación): the problem, its evidence and the fix. `## SUGERENCIAS` has at most three lines.
- An RDD review you ran on your own before the PR does not count; only this one does.
- The configured verification:

```text
{{VERIFICATION}}
```{{PI_FOREGROUND}}

## Remote authorization

- Destination: {{REMOTE_HOST}}, repository {{REMOTE_REPO}}
- Credential/session: the GitHub CLI (`gh`) session and the git credentials already configured on this machine.
- Operations: {{REMOTE_OPERATIONS}}
- Explicitly not authorized: merge, force push, deleting branches or issues, other repos, remotes or hosts.
{{NOTE_SECTION}}
