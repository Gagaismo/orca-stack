---
name: verify-rebote
description: "Model-check the bounce limits of `orca-stack rebote` (review bounce once, CI bounce at most twice, conflict bounce once per head, interpretation findings never to the author). Use when a change touches `reboteCommand` in src/despacho.mjs, src/checks.mjs, the marker lines `Rebote:` / `Rebote CI:` / `Rebote conflicto:`, or step 8 of assets/stack/CONTRATO.md."
---

# verify-rebote

## What is promised, and what breaks if it fails

Promise: `orca-stack rebote <pr>` never launches the author more often than contract step 8 allows. A review bounce happens once per PR (a head that advanced after it goes to main), CI bounces at most twice on distinct heads, a conflict bounce at most once per head, and an interpretation finding never reaches the author.

Harm: an author loops on the same PR, burns quota and rewrites work while main believes the PR is waiting for a human decision.

## Coverage record

- Sync commit: `7769fd3` (the commit at which the model was last confirmed to describe the code).
- Code covered: `reboteCommand` in `src/despacho.mjs` L868-L1089 (decision part L884-L1027, launch L1080, markers L1083-L1085) and the helpers it calls for the CI view in `src/checks.mjs` (`latestChecks`, `analyzeChecks`, `isPending`) plus `blockingBody`, `blockingSection`, `humanAnswers` in `src/despacho.mjs` L845-L862.
- Contract text: `assets/stack/CONTRATO.md` step 8.
- Model: `formal/rebote/Rebote.tla`; every action carries the `file:line` it models in a comment.
- Scope and assumptions: one PR, one author, one `main` session (no concurrent `rebote` runs); one `rebote` run is one indivisible step; 3 distinct heads (`MaxHead = 3`); checks are summarised as `pending | green | red` per head, so cancelled-check handling (L919-L948) and the exact content of the brief are NOT modeled; same-head retry after the author exited is allowed on purpose (test `Rule 2: permits same-head retry marker...` in test/despacho.test.mjs); markers are trusted as written (nobody forges or quotes a marker).

## Run it

```
bash formal/rebote/check.sh
```

Needs Java and `tla2tools.jar` 1.7.4 (`TLA2TOOLS=<path to the jar>`; the script's default is this machine's scratch copy). It takes about 15 s and prints one line per config. Expected:

- `rebote.cfg`: pass. This is the current code.
- `broken-review-once.cfg`, `broken-ci-limit.cfg`, `broken-conflict.cfg`, `broken-interp.cfg`: each fails with the invariant named in the line. A broken config that passes means the model no longer sees that guard: fix the model.
- `rebote-commentfail.cfg`: fails with `ConflictBounceOncePerHead` (known finding, below).

Read every result with the pstack `/statechart` skill: it shows a violation as its shortest path and, for a pass, draws how the PR moves between states. Do not copy its commands here.

To replay a counterexample on the real code: `node --test formal/rebote/replay.test.mjs`.

## Decide whether your change touches the verified code

Open the diff. If it changes any line in the coverage record, or a test in `test/despacho.test.mjs` under `describe('rebote'`, go on. Otherwise stop.

1. Run the check before editing the model. A pass only says the old description still holds.
2. For each changed line decide: no effect on a modeled decision; a modeled guard moved, was added or removed; or the contract itself changed on purpose (cite the contract diff or the tests).
3. Update `Rebote.tla` from the code, not from the result: keep one `rebote` run as one step, keep a `file:line` comment on each guard in `Refused`, add a guard constant for any new refusal and a `broken-*.cfg` that switches it off.
4. Rerun. A failure of `rebote.cfg` after an update is a bug in the code: report it as a counterexample, in steps in the code's words, and replay it with `replay.test.mjs`. Do not weaken an invariant or a guard to get a pass.
5. Move the sync commit above to the new commit only after the model describes the code at that commit and `check.sh` gives the expected line for every config.

## Known finding at the sync commit (confirmed on the real code)

`rebote-commentfail.cfg`: the author is launched at L1080 before the marker is posted at L1085. If `gh pr comment` fails (HTTP error), `rebote` throws, the author runs, and the PR carries no marker. After the author exits, `rebote` runs again and the limits no longer see the first bounce:

1. PR in conflict at head H, no markers. `rebote` launches the author; `gh pr comment` fails.
2. The author exits without pushing.
3. `rebote` again: no `Rebote conflicto: H` exists, so the second conflict bounce on H launches. The same happens for a review bounce followed by a head change: a second review bounce on the new head launches.

Replay: the first two tests of `formal/rebote/replay.test.mjs`. The control test shows the same head advance refused when the marker exists. Treat it as a decision for the human: the contract wants the marker only after the launch; the cost is this window.
