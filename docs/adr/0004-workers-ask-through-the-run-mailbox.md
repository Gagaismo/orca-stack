---
status: accepted
date: 2026-11-25
---

# Workers ask through the Run mailbox

Workers could ask `main` two ways: the Orca Run mailbox (`orca orchestration ask`), for supervised workers started with `worker-start`, and `Consulta: <agente>` comments on GitHub, for unsupervised sessions (`rebote`, `rebote --rdd`, `rebote --continuar`, `reanudar` without a Run task or with a task still `dispatched`) and as a fallback in the ticket brief. The same channel carried the 700-line warning. Now that Gentle Shell is the orchestrator, the human ruled that `Consulta:` is no longer needed and must go everywhere.

This extends [ADR 0001](0001-supervised-dispatch-instead-of-handoff.md): workers ask `main` only through the Run mailbox, and every relaunch runs supervised.

1. `rebote` (normal, `--rdd`, `--continuar`) starts a new supervised task titled `#<issue> <agente> rebote #<pr>`; the task-title parsing of `vigilar` accepts that suffix.
2. `reanudar` with no task or no Run creates a supervised task the way `despachar` does; with a task still `dispatched` it creates a new supervised task titled `#<n> <agente> reanudado` and relaunches bound to it. This replaces the #457 D1 (a) behavior of relaunching unbound.
3. RDD consent in `"humano"` mode: pi asks with `orca orchestration ask` with the envelope's choices; `main` opens a gate for the human, replies by id, and Orca wakes pi. No more "answer in pi's terminal, then `reanudar`".
4. RDD out of budget: pi still posts the PR comment, because `estado` and `puente-gentle` read it on GitHub as evidence, but its first line is `RDD fuera de presupuesto: <sha> (<motivo>)`, with no `Consulta: pi`; pi ends with `worker_done partial`.
5. `orca-stack consultas` and `vigilar --consultas` get one release with a deprecation warning and are removed in the next, following the precedent of [ADR 0002](0002-deprecate-ponytail-adopt-comment-rule.md).
6. `Consulta: <agente>` leaves the fixed protocol marks (the contract, the AGENTS block and `src/marcas.mjs`).
7. The 700-line warning is dropped from the contract and the brief: a ticket is always a single PR. Chained PRs are not a supported flow; a ticket that looks large is split into smaller tickets before dispatch, never mid-way. The only chain, #419 with PRs #441, #442 and #443, came from the contract's 700-line rule contradicting the brief's single-PR rule, and `rebote`, `reanudar`, `vigilar` and `estado` all assume one PR per issue and per worktree.
8. `revisar` reviews and `planificar` do not change.

## Considered Options

- Keep `Consulta:` for unsupervised sessions only: rejected; the human chose to remove it everywhere.
- Support chained PRs with one worktree per PR, or a checkout in the issue's worktree: rejected; five commands to support a case that happened once, caused by a contract/brief contradiction.
- Have `reanudar` with a `dispatched` task keep relaunching unbound, or refuse until `main` closes the dispatch: rejected; the first leaves the worker without a mailbox, the second adds manual steps.

## Consequences

- Questions no longer leave a trace on GitHub. A human answer that changes a ticket rule is still published as `Respuesta del humano:`.
- Sessions in other repos with old briefs may still post `Consulta:` until they upgrade, and nobody watches for them after the removal release.
- The Run holds more tasks: one per relaunch.
