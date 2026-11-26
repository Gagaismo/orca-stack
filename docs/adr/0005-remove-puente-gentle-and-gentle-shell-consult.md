---
status: accepted
date: 2026-11-25
---

# Remove puente-gentle and the Gentle Shell consult

The `puente-gentle` Claude Code mod gave `main` the `consultar_gentle_shell` tool and refused a `gh pr merge` that did not meet the merge condition, including a Gentle Shell consult before merging any PR over 400 lines. When `main` proposed running that consult only to get past the 400-line guard, the human ruled: "elimina ese mod, no necesitamos esa dependencia". We decided to remove both the Gentle Shell consult before merging PRs over 400 lines and the `puente-gentle` mod (#391). `orca-stack estado` is the sole checker of the merge condition: its `falta` list, which already covered the `riesgo` reviews and the RDD request on the head. pi stays a worker and a reviewer: the second review on `riesgo` and the RDD mode through `orca-stack rebote <pr> --rdd <lentes>`.

Issue: [#391](https://github.com/Gagaismo/orca-stack/issues/391). PR: [#483](https://github.com/Gagaismo/orca-stack/pull/483).

## Considered Options

- Keep the mod and drop only the 400-line rule: rejected; the human asked to remove the mod and its dependency.
- Keep `estado` and `puente-gentle` as two copies of the same check: rejected; they had to decide the same and already differed (#465's out-of-budget marker lived only in `estado`).

## Consequences

- A Claude Code `main` has no mechanical hook that refuses a `gh pr merge`: `main` runs `orca-stack estado <n> --json` and merges with `gh pr merge <n> --merge --match-head-commit <head>`. A Gentle Shell `main` keeps its RDD delivery guard, which runs `estado` itself.
- `estado` no longer reads published consult comments (`Revisor: pi (consulta <tema>, publicada por main)`, #446).
- On machines that had the mod, `orca-stack global` removes the installed copy and its `CLAUDE_CODE_PLUGIN_DIRS` entry, keeping user-modified or untracked files, and `orca-stack doctor` warns about a leftover copy, naming `orca-stack global`.
- [ADR 0004](0004-workers-ask-through-the-run-mailbox.md) still names `puente-gentle` as a reader of the out-of-budget comment; `estado` alone reads it now.
