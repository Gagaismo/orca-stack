## Orca stack: perk de ponytail

Este fragmento lo instala `orca-stack global` junto a `MAIN.md`, `ORCA-STACK.md` y `ROLE-BRIEFS.md`. Vale solo con el perk `ponytail` encendido (`"perks": { "ponytail": true }` en cualquier capa de la config de orca-stack). Con el perk encendido, el contrato que escribe `orca-stack init` trae la frase de Ponytail y apunta acá, y los workers y la sesión de `main` leen este fragmento entero junto con `ORCA-STACK.md` y `ROLE-BRIEFS.md`: sus reglas se suman a las de esos documentos en la sección que nombra cada una. Con el perk apagado no aplica nada de lo que sigue.

### Components (`ORCA-STACK.md`)

- **Ponytail (modular)**: implementation policy only: avoid unnecessary work and
  choose the smallest correct solution after understanding the task and code.
  Orca Auto applies it to implementation turns; it never overrides requirements.
  Its level is `lite`, `full` or `ultra` (the wrappers set `full`), and a
  shortcut with a known limit gets a `shortcut: <the limit>, <when to upgrade>`
  code comment.

### Authority order (`ORCA-STACK.md`)

Ponytail takes its own level, right after the specialized skill for the current role (level 4) and before Caveman communication policy (when that perk is on) and provider defaults:

5. Ponytail implementation policy.

### Methodology contract (`ORCA-STACK.md`)

Ponytail may reduce the
implementation footprint inside an approved ticket; it may not remove research,
domain modeling, explicit spec obligations, ADR decisions, security, validation,
accessibility, data-loss handling, or required tests. `ponytail-review` is a
second pass after correctness/spec review; it reports only and never applies
changes. It reviews quality as a whole (bugs, risk, scale, tests, speed, lean);
the Ponytail reviewer role keeps only its Lean findings and passes any
non-Lean *Must fix* to main in one line. `ponytail-audit` is
opt-in and repo-wide.

### Deliberate exclusions (`ORCA-STACK.md`)

Do not install the full Ponytail lifecycle-hook stack. The wrappers set the
launch-scoped environment marker `ORCA_STACK_PONYTAIL_LEVEL`.
The installed modular skills remain available explicitly:

- `ponytail` — implementation policy card, no lifecycle hook.
- `ponytail-review` — read-only quality review, second pass.
- `ponytail-audit` / `ponytail-debt` — explicit maintenance tools;
  `ponytail-debt` lists the `shortcut:` comments and older `ponytail:` ones.

### Research worker (`ROLE-BRIEFS.md`)

**Policy:** Ponytail is not active for research output.

### Implementation worker (`ROLE-BRIEFS.md`)

**Rules:** apply Ponytail's smallest complete change, and mark a shortcut
with a known limit `shortcut: <the limit>, <when to upgrade>`.

## Ponytail reviewer

**Mission:** second-pass review for over-engineering only, after correctness/spec
review.

**Rules:** run `ponytail-review` and report only its Lean findings; its other
findings belong to the correctness review. When it finds a non-Lean *Must fix*
(a bug, data loss), pass it to main in one line, never drop it. Output format:
`## BLOQUEA` / `## SUGERENCIAS`, with the Lean findings and that line. A `shortcut:` (or older `ponytail:`) comment that names its
limit is a decision, not a finding. Do not flag required
validation, security, accessibility, error handling, acceptance tests, or ADR
constraints. Do not apply fixes.
