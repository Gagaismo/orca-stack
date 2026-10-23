---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

## Adaptation Note

Adapted from pstack (`cursor/plugins`, version 0.15.31). Dropped references to pstack's router, cloud workers (`environment: "cloud"`, `subagent_type: generalPurpose`), model configuration files (`~/.cursor/rules/pstack-models.mdc`), and `poteto-mode`.

In orca-stack, swarm runs in-process only: subagents of the task owner (Agent tool, or Workflow when the human authorized it). Never route workers through `despachar` or `revisar`.

A swarm does read work only: audit, exploration, measurement, verification on named SHAs, slices or a race, returning one aggregated report. Swarm members publish nothing on GitHub; only the owner aggregates and publishes. The report is not a review and replaces neither CI nor `Verificado por main`. (A writing race is an arena; writing slices are sub-issues and a tanda).

No swarm worker or owner deletes branches by pattern or with `--force`; any branch cleanup follows the contract's `Permisos` exception: one listed id at a time, never by pattern, never with `--force`.

## Start

Open a todolist with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the report the swarm must return.
2. Choose the shape. Partition into read slices, race N workers on identical read briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
4. Pick the worker models for the job. In-process subagents run on the parent model or chosen models. For a model race, name each arm's model up front.
5. Swarm work is read work only. When workers run a suite or build in parallel (which writes artifacts and caches), give each worker an isolated worktree. Measuring against external APIs is a remote operation and requires its own remote authorization. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief also names the method (sample count, what one sample is, order). The worker records both in its result.

## Phase B: Fan out

Spawn all N workers in-process with the task owner's subagent tool. Swarm members publish nothing on GitHub.

When workers need an isolated checkout for test artifacts, pass an isolated worktree path.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. Drop a result that does not record the SHAs and method its brief names, and respawn that worker once. After a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use `first pass`, `rank all`, or `best-of`. Do not paste raw worker dumps.

The swarm report is not a review and replaces neither CI nor `Verificado por main`.

## Phase D: Report

Only the task owner aggregates and publishes. Results go under `## Swarm` on the artifact they served (an issue comment or orchestration PR body for main, the PR body for a worker):
- Result table
- Issue one-liners with evidence
- Gaps or dropouts
- Selection rule when a race was used
