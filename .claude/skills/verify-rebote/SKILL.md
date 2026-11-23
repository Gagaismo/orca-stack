---
name: verify-rebote
description: "Model-check the bounce limits of `orca-stack rebote` (review bounce only on a head with its own blocking review, at most four CI bounces, the third and fourth only with a fresh `Diagnóstico: main`, conflict bounce once per head, interpretation findings never to the author). Use when a change touches `reboteCommand` in src/despacho.mjs, src/checks.mjs, the marker lines `Rebote:` / `Rebote CI:` / `Rebote conflicto:`, or step 8 of assets/stack/CONTRATO.md."
---

# verify-rebote

## What is promised, and what breaks if it fails

Promise: `orca-stack rebote <pr>` never launches the author more often than contract step 8 allows. A review bounce happens only on a head with a blocking review of its own, counted by the review's `Commit:` sha (#296: a head that advanced after a bounce bounces again on its own review; a review of an older head bounces nothing), CI bounces at most four times on distinct heads, the third and fourth only with a `Diagnóstico: main` on the head, with a `Siguiente hipótesis:` neither empty nor `ninguna`, published after the latest `Rebote CI:` (#396), a conflict bounce at most once per head, and an interpretation finding never reaches the author.

Harm: an author loops on the same PR, burns quota and rewrites work while main believes the PR is waiting for a human decision.

## Coverage record

- Sync commit: `d90b10c` (the commit at which the model was last confirmed to describe the code).
- Code covered: `reboteCommand` in `src/despacho.mjs` L1288-L1591 (decision part L1311-L1478, CI limit and diagnosis L1414-L1423, launch L1553, markers L1555-L1580: retry loop L1562-L1568 with `MARKER_ATTEMPTS = 3`, fail-loud exit L1569-L1580) and the helpers it calls for the CI view in `src/checks.mjs` (`latestChecks`, `analyzeChecks`, `isPending`) plus `blockingBody`, `blockingSection`, `humanAnswers` in `src/despacho.mjs` L1059-L1086 and `CI_BOUNCE_CAP`, `mainDiagnosis` L1088-L1108.
- Contract text: `assets/stack/CONTRATO.md` step 8.
- Model: `formal/rebote/Rebote.tla`; every action carries the `file:line` it models in a comment.
- Scope and assumptions: one PR, one author, one `main` session (no concurrent `rebote` runs); one `rebote` run is one indivisible step, including its 3 comment attempts; 5 distinct heads (`MaxHead = 5`, so a fifth CI bounce is reachable; when a head is left behind, the model keeps of it only what is read again: its CI markers and launches, its blocking implementation review, and an owed marker as owed); checks are summarised as `pending | green | red` per head, so cancelled-check handling (L1374-L1405) and the exact content of the brief are NOT modeled; the interpretation reviews of a head are summarised as `settled` (some has a `Respuesta del humano:` after it) and `open` (some has none), since an answer settles every review posted before it and none posted after it (`AnswerOrderGuard`); same-head retry after the author exited is allowed on purpose (test `Rule 2: permits same-head retry marker but refuses when head advanced without a review of its own` in test/despacho.test.mjs); markers are trusted as written (nobody forges or quotes a marker); a `Diagnóstico: main` with an empty or `ninguna` hypothesis is not a step (the code reads only the newest diagnosis on the head, so the model may bounce more than the code, never less); `--rdd` bounces (pi's RDD review of its own PR, which skip the CI, conflict and blocker analysis and post `RDD:` instead of a `Rebote` marker) and the review-round count are NOT modeled; when `rebote` fails loud, `main` posts the printed marker before any other `rebote` (`OwedGuard`, the protocol, not the code).

## Run it

```
TLA2TOOLS=<path to tla2tools.jar 1.7.4> bash formal/rebote/check.sh
```

Needs Java 11 or later (`JAVA=<java binary>` when `java` is not on PATH) and `tla2tools.jar` 1.7.4 (SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`). It takes about 90 s and prints one line per config: the result and the expected one. It exits non-zero when any result differs. The CI job `formal` runs it on every PR. Expected:

- `rebote.cfg`: pass. This is the current code.
- `rebote-commentfail.cfg`: pass. All 3 comment attempts may fail; `rebote` fails loud and `main` posts the printed marker first.
- `broken-review-sha.cfg`, `broken-ci-limit.cfg`, `broken-diagnosis.cfg`, `broken-conflict.cfg`, `broken-interp.cfg`, `broken-answer-order.cfg`, `broken-owed.cfg`: each fails with the invariant `check.sh` names for it. A broken config that passes means the model no longer sees that guard: fix the model.

`check.sh <cfg> <pass|Invariant>...` checks only the pairs given.

Read every result with the pstack `/statechart` skill: it shows a violation as its shortest path and, for a pass, draws how the PR moves between states. It does not run on native Windows (use WSL or a Linux/macOS machine). Do not copy its commands here.

To replay the counterexamples on the real code: `node --test test/formal-rebote-replay.test.mjs` (part of `npm test`, no Java).

## Decide whether your change touches the verified code

Open the diff. If it changes any line in the coverage record, or a test in `test/despacho.test.mjs` under `describe('rebote'`, go on. Otherwise stop.

1. Run the check before editing the model. A pass only says the old description still holds.
2. For each changed line decide: no effect on a modeled decision; a modeled guard moved, was added or removed; or the contract itself changed on purpose (cite the contract diff or the tests).
3. Update `Rebote.tla` from the code, not from the result: keep one `rebote` run as one step, keep a `file:line` comment on each guard in `Refused`, add a guard constant for any new refusal and a `broken-*.cfg` that switches it off (and its expected invariant in `check.sh`).
4. Rerun. A failure of `rebote.cfg` after an update is a bug in the code: report it as a counterexample, in steps in the code's words, and replay it in `test/formal-rebote-replay.test.mjs`. Do not weaken an invariant or a guard to get a pass.
5. Move the sync commit above to the new commit only after the model describes the code at that commit and `check.sh` gives the expected line for every config.

## Finding fixed by #310

At `7769fd3` the author was launched before the marker was posted, and a failed `gh pr comment` left no marker: the next `rebote` bounced again on the same head (conflict) or on a later head (review). Since #310 `rebote` retries the comment 3 times and, when all fail, exits non-zero printing the marker and `gh pr comment <pr> --body-file <file>` for `main`. `rebote-commentfail.cfg` now passes; `broken-owed.cfg` is the same model without `main` posting first and still fails with `ConflictBounceOncePerHead`. The replay tests in `test/formal-rebote-replay.test.mjs` run that trace on the real code: the second bounce is refused once `main` posts the printed marker.
