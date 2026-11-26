---
status: accepted
date: 2026-11-26
---

# Gentle Shell runs the orca-stack cycle natively

orca-stack and Gentle Shell were treated as dependencies of each other: `main` was a Claude Code session driven by Claude Code mods, and Gentle Shell (Pi) was one more worker. The human asked to unify them: "Orca stack y gentle shell (con todo lo que conlleva su ciclo y etc) se unifican y se dejan de tratar como dependencias. O sea que nativamente gentle shell deberia entender en su ciclo todas las funciones de orca y orca stack." They also asked that the stack never block on the agents they can pay for: "Depende del presupuesto y los agentes que yo tenga quiero poder tener Pi, agy, codex. Pi , agy. Pi solo. O sea que no quiero que el stack me bloquee por no disponer de poder pagar tantas suscripciones (Pi usa claude de fondo)". We decided that Gentle Shell, in the fork `Gagaismo/gentle-shell`, runs `main` and the orca-stack cycle natively, that Orca stays the runtime, and that every Claude Code mod is retired.

Issue: [#485](https://github.com/Gagaismo/orca-stack/issues/485).

1. `main` lives only in Gentle Shell: "Q1, opcion A, si vamos a retirar todos los mods de claude code." The mods are retired in the major directly, with no deprecation release.
2. Orca stays the runtime and Gentle Shell uses it natively.
3. The mods stop being Claude Code mods: "Q7 basicamente lo que dijiste pero ya no quiero que sean mods de claude code sino cosas de orca stack + gentle shell." Ported to the fork: `main-md`, `guardia-despacho`, `modo-autonomo`, `marchas` (a perk, off by default), `bandeja-mensajes` and `grilling-ok` (on `ask_user_question`). Dropped: `tablero-despacho`, `reloj-cache` and `guardia.modeloClaude`.
4. The fork keeps pulling upstream releases, and the orca code is written so that merge stays cheap. The native integration lives in the fork in its own files (`extensions/orca-*.ts`, `lib/orca-*`), touching core only in small seams (the G1 preflight, the G2 consent). The `orca-stack` CLI keeps what does not depend on the harness: worktrees, Runs, `estado`, `init`, the codex and agy wrappers and the skills. The fork asks the CLI with `--json` commands instead of copying its logic.
5. orca-stack is for the human's own use: "Orca stack es para uso propio. Se parece mas a la opcion c." `global` points to the local fork checkout, and nothing is published.
6. `claude` leaves the worker roster; the A20 combinations (Pi+agy+codex, Pi+agy, Pi alone) no longer name it.
7. The record review is the cross-review by an agent of another model family when there is one available; otherwise, the RDD review that `main` requests. The stack never blocks for a missing agent.
8. Arena and swarm are rebuilt on Gentle Shell subagents: "Q9 ok, pero hay que ver si no se pisan entre si." Parallel-writer admission treats writers with different `workspace_root`s as disjoint (fork `lib/bounded-writer-admission.ts:229-242`).
9. The `o` toggle stays: `off` turns the whole orca cycle off, and a repo without `.orca-stack.json` never turns it on.
10. The fork is wired with `orca-stack init`: "Q12 a". Its tickets are issues of `Gagaismo/gentle-shell`, linked as sub-issues of #485, dispatched by a `main` running in the fork.
11. Adopted from the grill closing (assumptions A2-A18, never answered "ok"; adopted by `main` after the human asked to implement directly with ODD, and open to their veto):
    - A2: the record-review rule of point 7 removes the paths in `estado.mjs` that require two families other than claude.
    - A3: pi stays the second review on `riesgo`.
    - A4: removing claude also removes the claude wrapper, the skills in `~/.claude`, the gentle-ai block in `~/.claude/CLAUDE.md`, `claude` from the agent and family lists, and the `CLAUDE.md` that `init` writes; an existing one is deleted only if it is exactly orca-stack's import.
    - A5: Matt's skills are installed for Pi.
    - A6: `main` runs Gentle Shell inside an Orca terminal; the dispatch mechanics do not change.
    - A8: `vigilar` becomes native in the fork.
    - A9: autonomous mode runs on `agent_end` and `autonomousMode`.
    - A10: marchas loses Ultracode; its knobs become Pi thinking levels.
    - A11: arena fan-out is done by `main` and pi workers.
    - A12: Judge, Judgment Day, RDD and swarm stay distinct terms.
    - A13: with the toggle on, the contract beats Gentle Shell defaults.
    - A14: the contract, `MAIN.md` and the briefs drop Claude Code and `puente-gentle`.
    - A15: the order is #413 first (the fork moves to v5), then the fork port, then `main` moves to Gentle Shell, then the mods are retired.
    - A16: `doctor` checks that the fork checkout is compatible.
    - A17: `un-agente` mode stays.
    - A18: this ADR, number 0006.

## Considered Options

- Both harnesses, with the shared logic in the CLI (Q1 b): rejected; keeping two harnesses is the "two layers for one flow" the unification removes.
- Gentle Shell by default and Claude Code as legacy for one release, with a deprecation release before the mods are deleted (Q1 c): rejected; the human chose to retire every Claude Code mod.
- Propose the integration upstream (first Q5 c): rejected; with the fork nobody else has to accept anything: "¿Como que dependo que un tercero lo acepte? Si nosotros justamente forkeamos para personalizarlo a nuestra manera a gentle shell".
- Freeze the fork at one version and touch core freely (second Q5 b): rejected; the human wants the upstream improvements (RDD, review, profiles, v5), and #413 is already waiting for v5.
- A separate Pi package in the orca-stack repo (Q6 b): rejected; it keeps the integration as "another thing installed alongside", which is treating them as dependencies again.
- Install the fork from a GitHub tag (Q8 a) or publish it on npm under its own name (Q8 b): rejected; orca-stack is for the human's own use, so the local checkout is enough.
- Retire arena and swarm in the major and add them back later (Q9 b): rejected; Gentle Shell already has subagents, so it is a port, not an invention.

## Consequences

- A Claude Code `main` is no longer supported; until the mods are retired, at the end of the A15 order, today's `main` keeps depending on them.
- A repo can run with Pi alone, and no PR waits for a model family the roster does not have.
- The fork diverges from upstream only in its own files and a few core seams, so each upstream release is a cheaper merge.
- Fork work follows the same cycle as orca-stack, and #485 is the single place to track both repos.
