---
name: arena
description: "Spawn N parallel candidates at the same task, pick a base, graft the strongest parts of the losers into it. Use for /arena, 'arena this', 'throw it in the arena', or when one attempt at a non-trivial artifact would lock in the wrong shape."
disable-model-invocation: true
---

# Arena

Open a todolist with one entry per phase (Frame, Fan out, Judge, Pick, Graft, Verify) before launching anything.

## Adaptation Note

Adapted from pstack (`cursor/plugins`, version 0.15.31). Dropped references to pstack's router, model configuration files (`~/.cursor/rules/pstack-models.mdc`), `poteto-mode`, and external principle skills (`separate-before-serializing-shared-state`, `Laziness Protocol`, `redesign-from-first-principles`, `prove-it-works`).

In orca-stack, arena runs in-process only: subagents of the task owner (Agent tool, or Workflow when the human authorized it), each writer in an isolated worktree. Never route candidates through `despachar` or `revisar`.

## Phase A: Frame

Every candidate gets the same prompt, so the prompt is the contract.

1. State the artifact each candidate is producing.
2. Derive the rubric: 3-6 concrete gradeable criteria for what success looks like on *this* task. It is the picker's tool in Phase D. Write the rubric before the fan-out and keep it from the candidates; candidates only see the task.
3. Pick the runners. In-process subagents only. Candidates should differ in approach or model tier (such as Haiku, Sonnet, Opus), with the rubric naming the difference. Spawn more runners when the arena covers multiple design directions. Use the same model N times when the work is generation-bound rather than judgment-sensitive.
4. Give each candidate its own output location: an isolated git worktree for each writer.

## Phase B: Fan out

Spawn all N subagents in-process, each with the task, the path to the shared grounding, its own isolated worktree output path, and instructions to produce the artifact and a short rationale naming the alternatives it considered and what it rejected.

If a candidate produces no output, proceed with N-1 and note the dropout.

## Phase C: Judge

After all Phase B candidates complete, spawn one read-only judge subagent with a clean context.

In orca-stack, the judge is a read-only subagent of the same model family as the candidates, which is weaker than pstack's cross-family judge. The judge is not a review and replaces no review.

Four compensations:
1. A rubric of 3-6 criteria written before the fan-out and kept from the candidates;
2. Candidates that differ in approach or model tier (Haiku, Sonnet, Opus), with the rubric naming the difference;
3. A judge with a clean context that does not know which candidate the owner prefers;
4. Executed checks, such as tests or the suite, where possible.

A Gentle Shell consult may add a second opinion, but adds no new family.

The judge sees the rubric and the candidates by path label, scores each criterion, and recommends a base with rationale. It runs in parallel with the owner's reading in Phase D. Don't spawn it while candidates are still writing.

## Phase D: Pick a base

Read every candidate end to end before picking. Score each against the rubric criterion by criterion, not on holistic feel, and compare with the judge. Agreement on the base confirms the pick. Disagreement means one of you is biased or the rubric was ambiguous. Read both rationales before deciding.

Pick the base a future maintainer can extend most easily without breaking invariants. When two feel tied, prefer the cleaner boundary or smaller API.

## Phase E: Graft

The task owner grafts. Walk each losing candidate once more for what is worth porting into the base, usually one or two things per candidate, not most of it. Fold each graft in by hand so the result stays coherent under one mental model. Don't paste mechanically.

If the candidates converge on one shape, that is strong agreement. Note it and ship the consensus shape. No graft is needed. If they wildly diverge, Phase A was under-specified. Reframe and re-run rather than averaging the divergence.

## Phase F: Verify

The owner grafts, and the configured verification runs on the grafted result, not only on the candidates (nobody judged the combined code). Run the configured verification commands and any tests the task requires against the grafted artifact. If verification finds a problem the arena missed, either Phase A was wrong (re-frame and re-run) or a candidate caught it and you missed the graft (go back to Phase E). Don't paper over it.

## Phase G: Cleanup of losing candidates

Losing candidates are deleted only as the contract's `Permisos` exception allows: one listed id at a time, never by pattern, never with `--force`. Candidate branches and worktrees must have been created by the owner, never pushed, absent from the remote, and removed only after the synthesis note is published on the artifact.

## Outputs

Results go under `## Arena` on the artifact they served (an issue comment or orchestration PR body for main, the PR body for a worker):
- Rubric (3-6 criteria)
- Base candidate and why
- Judge verdict and rationale
- Each graft with its source candidate
- What was rejected and why
- Any convergence or dropouts
- Verification result
