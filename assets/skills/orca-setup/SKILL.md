---
name: orca-setup
description: >-
  Configura la metodología orca-stack en un proyecto. Usala cuando la sesión de
  main encuentra `.orca-stack.json` sin `"setup": "completo"`, o cuando el
  humano pide hacer o rehacer el setup de orca-stack en un repo. Solo la corre
  la sesión de main; un worker nunca.
---

# Setup de orca-stack en un proyecto

El contrato de trabajo del bloque orca-stack de `AGENTS.md` lee sus valores de `.orca-stack.json`. Este setup los deja escritos, con una sola ronda de preguntas al humano. Lo hace solo la sesión de `main`: un worker trabaja sin el humano y no puede contestar nada de esto, así que si lo encuentra pendiente sigue con su brief.

## 1. Mirá el repo antes de preguntar

Todo lo que se pueda averiguar no se pregunta. Leé:

- `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` y `docs/agents/`, para ver qué reglas ya existen y cuáles chocan con el contrato.
- `package.json` (scripts de test y typecheck), la config de CI y `.github/`.
- `gh label list` y la rama por defecto del repo.
- `~/.orca-stack/config.json`, por los agentes que el humano usa de forma habitual.
- El `.orca-stack.json` actual, para no pisar claves que ya tiene.

## 2. Una ronda de preguntas

Hacé todas las preguntas juntas, numeradas, cada una con tu recomendación ya resuelta con lo que leíste. Formato:

```
❓ **Q1** - **título**: la pregunta, con lo que encontraste
➡️ recomendación
```

Las preguntas:

1. **Modo**: `multiagente` (Orca despacha workers) o `un-agente` (una sesión planifica e implementa). Si es `un-agente`, preguntá también quién hace el review de registro, que se guarda en `review`: `"subagente"` (de contexto limpio, de otra familia de modelos si hay; es lo recomendado) o `"humano"`.
2. **Agentes y modelos**: qué agentes usa este repo (`agentes.usa`) y cuáles necesitan el OK del humano antes de despacharse (`agentes.preguntarAntes`). Proponé los agentes de la tabla del contrato (claude, agy, codex, codex-cc y pi) y los modelos y esfuerzos de la config personal; si la config personal no tiene modelos, cada agente usa el que trae su lanzador por defecto. codex-cc gasta créditos: si implementa, va en `preguntarAntes`.
3. **Rama base**: contra cuál se abren los PRs.
4. **Merge**: si `main` mergea sola cuando se cumple la condición de merge del contrato, o si pide el merge al humano.
5. **Verificación**: los comandos exactos de suite y typecheck. Detectalos y pedí solo la confirmación. El script `test` tiene que terminar por sí solo, porque los agentes corren `npm test` sin importar lo que diga el brief: si el repo usa jest, proponé `jest --runInBand --forceExit`. Proponé también un script `test:handles` con `--detectOpenHandles` y, si la suite deja un handle abierto, abrí un issue para arreglarlo en vez de taparlo con el flag. `verificacion` en `.orca-stack.json` lleva los mismos comandos que `package.json`.
6. **Despliegue**: si se despliega después del merge, con qué comando y cómo se verifica; o "ninguno", dicho explícitamente.
7. **Idioma** del código, los commits y los PRs.
8. **Reglas en conflicto**, solo si las hay: las reglas de `AGENTS.md` fuera del bloque orca-stack que contradicen el contrato sin nombrar la regla que cambian. Ejemplos: "no mergear a main", "no arrancar SDD de Gentle AI", la sintaxis `$implement` de codex, una cadena de métodos duplicada que nombra `CONTEXT.md`, un setup anterior de Matt Pocock o varios mecanismos de review. Proponé borrar o reformular cada una, de a una: mostrá las dos versiones, citando archivo y línea, y que decida el humano. Nunca sobrescribas una regla sin mostrarla antes, porque es trabajo del humano que no está en este contrato.
9. **Rutas de riesgo** (`riesgo`): las que, si cambian, no se pueden deshacer con un revert: migraciones, auth, borrado de datos, contratos públicos, config de deploy, lockfiles y dependencias. Buscalas en el repo y proponé los globs concretos (por ejemplo `**/migrations/**`, `src/auth/**`, `package-lock.json`). Un PR que toca alguna necesita el review de pi antes de mergear.
10. **Chequeos automáticos**: si el repo no tiene CI, proponé una mínima con typecheck, la suite, el lint del formato de los mensajes de commit de todos los commits del PR y un escaneo de secretos; y un hook de commit local como aviso temprano. Lo que cuenta es la CI: un hook se saltea con `--no-verify`. Si ya hay CI, proponé solo lo que le falte.
11. **Reglas por archivo**, como dice "Dónde vive cada regla" del contrato: las reglas de juicio sobre cómo se escribe el código pasan de `AGENTS.md` a `CODING_STANDARDS.md`; las de producto y privacidad se quedan en `AGENTS.md`; una regla mecánica sale de `AGENTS.md` solo cuando su chequeo de CI ya existe y se lo vio fallar con un caso malo. Cada regla vive en un solo archivo. Listá qué regla se mueve y adónde, una por una.
12. **`CONTEXT.md` → `GLOSSARY.md`**, si el repo tiene el primero: las skills de Matt 1.3 solo buscan `GLOSSARY.md`. Se renombra con `git mv` y se actualizan las referencias en `docs/agents/*.md` y en `AGENTS.md`.
13. **Cuenta de Pi**: pi usa las credenciales de Claude de `CLAUDE_CONFIG_DIR` (por defecto `~/.claude`), o sea la misma cuenta que `main`, y las dos se quedan sin cuota juntas. Ofrecé una carpeta de config separada (por ejemplo `~/.claude-pi`) en `agentes.pi.claudeConfigDir` de `~/.orca-stack/config.json`. El login lo tiene que hacer el humano, una sola vez: en PowerShell, `$env:CLAUDE_CONFIG_DIR="<carpeta>"; claude` y después `/login`. Decíselo con el comando completo y no lo corras vos.

## 3. Escribí lo decidido

- Fusioná en `.orca-stack.json` solo las decisiones del repo: `modo`, `review` (si el modo es `un-agente`), `ramaBase`, `agentes.usa` y `agentes.preguntarAntes`, `verificacion` (`{ "suite", "typecheck" }`), `riesgo` (la lista de globs), `merge`, `despliegue` (`{ "despues": false }` o el comando y su verificación) e `idioma`. Conservá las claves que ya había y `version`.
- Los cambios de archivos que el humano aprobó se hacen en una rama, no en la de `main`: los scripts `test` y `test:handles`, la CI y el hook, el movimiento de reglas a `CODING_STANDARDS.md`, el `git mv CONTEXT.md GLOSSARY.md` con sus referencias y las ediciones de reglas en conflicto. Para cada regla mecánica que sale de `AGENTS.md`, comprobá antes que su chequeo de CI falla con un caso malo.
- Los modelos y esfuerzos (`agentes.modelos`) y la cuenta de Pi (`agentes.pi.claudeConfigDir`) son de la máquina, no del repo: salen de `~/.orca-stack/config.json`. Si el humano cambia alguno, escribilo ahí y nunca en el archivo que se commitea, porque otra persona o máquina tiene otras cuentas y otros modelos. Una excepción local va en `.orca-stack.local.json`.
- Ponele `"setup": "completo"` al final, recién cuando todo lo demás quedó escrito: así un setup cortado a la mitad se vuelve a ofrecer.
- Editá las reglas en conflicto fuera del bloque orca-stack solo como decidió el humano. No toques el contenido entre `<!-- orca-stack:begin -->` y `<!-- orca-stack:end -->`: lo regenera `orca-stack init`.
- Cerrá con un resumen corto de lo que quedó configurado y de lo que cambiaste en las reglas del proyecto.
