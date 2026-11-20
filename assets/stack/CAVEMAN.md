## Orca stack: perk de caveman

Este fragmento lo instala `orca-stack global` junto a `MAIN.md`, `ORCA-STACK.md` y `ROLE-BRIEFS.md`. Vale solo con el perk `caveman` encendido (`"perks": { "caveman": true }` en cualquier capa de la config de orca-stack; los wrappers siguen la capa personal, `~/.orca-stack/config.json`). Con el perk encendido, el contrato que escribe `orca-stack init` trae la viñeta de Caveman y apunta acá, los wrappers escriben `ORCA_STACK_MODE=auto` y `ORCA_STACK_CAVEMAN_LEVEL=caveman`, y los workers y la sesión de `main` leen este fragmento entero junto con `ORCA-STACK.md` y `ROLE-BRIEFS.md`: sus reglas se suman a las de esos documentos en la sección que nombra cada una. Con el perk apagado no aplica nada de lo que sigue.

### Components (`ORCA-STACK.md`)

- **Caveman (modular)**: communication compression. Orca Auto applies it when
  the work is token-heavy, but never compresses code, commands, paths, exact
  errors, decisions, risks, uncertainty, tests, or acceptance evidence.
  Its level is a caveman 3.2.0 mode: `caveman`, `ultracave` or `megacave` (the
  wrappers set `caveman`).

### Authority order (`ORCA-STACK.md`)

Caveman takes its own level, after the specialized skill for the current role (and after Ponytail's level when that perk is on) and before provider defaults:

6. Caveman communication policy.

If a communication rule would hide evidence, use normal prose for that passage.

### Communication contract (`ORCA-STACK.md`)

Caveman is communication-only. In `auto`, compress filler and repetitive prose
only when it saves tokens; use normal prose for research, security warnings,
irreversible-action confirmations, exact evidence, or when compression could
change order or meaning.

### Deliberate exclusions (`ORCA-STACK.md`)

Do not install the full Caveman lifecycle-hook stack. The wrappers set the
launch-scoped environment markers
(`ORCA_STACK_MODE`, `ORCA_STACK_CAVEMAN_LEVEL`).
The installed modular skills remain available explicitly:

- `caveman` — communication-only mode; Auto is selected in Orca, not by a
  provider hook.

### Research worker (`ROLE-BRIEFS.md`)

**Policy:** Caveman follows the
Orca Agent Stack setting for the summary only; preserve citations and
uncertainty even when compressed.

### orca-stack-policy skill

Apply the Caveman communication boundaries: Caveman only compresses optional prose.
