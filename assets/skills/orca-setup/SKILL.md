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
5. **Verificación**: los comandos exactos de suite y typecheck. Detectalos y pedí solo la confirmación, incluidos los flags que el repo necesite para terminar (por ejemplo `--forceExit` en jest).
6. **Despliegue**: si se despliega después del merge, con qué comando y cómo se verifica; o "ninguno", dicho explícitamente.
7. **Idioma** del código, los commits y los PRs.
8. **Reglas en conflicto**, solo si las hay: un setup anterior de Matt Pocock u otras reglas del proyecto que chocan con el contrato (una que prohíbe SDD, un "no mergear a main" que no dice quién mergea, varios mecanismos de review). Mostrá las dos versiones, citando archivo y línea, y que decida el humano. Nunca sobrescribas una regla sin mostrarla antes, porque es trabajo del humano que no está en este contrato.

## 3. Escribí lo decidido

- Fusioná en `.orca-stack.json` solo las decisiones del repo: `modo`, `review` (si el modo es `un-agente`), `ramaBase`, `agentes.usa` y `agentes.preguntarAntes`, `verificacion` (`{ "suite", "typecheck" }`), `merge`, `despliegue` (`{ "despues": false }` o el comando y su verificación) e `idioma`. Conservá las claves que ya había y `version`.
- Los modelos y esfuerzos (`agentes.modelos`) son de la máquina, no del repo: salen de `~/.orca-stack/config.json`. Si el humano cambia alguno, escribilo ahí y nunca en el archivo que se commitea, porque otra persona o máquina tiene otras cuentas y otros modelos. Una excepción local va en `.orca-stack.local.json`.
- Ponele `"setup": "completo"` al final, recién cuando todo lo demás quedó escrito: así un setup cortado a la mitad se vuelve a ofrecer.
- Editá las reglas en conflicto fuera del bloque orca-stack solo como decidió el humano. No toques el contenido entre `<!-- orca-stack:begin -->` y `<!-- orca-stack:end -->`: lo regenera `orca-stack init`.
- Cerrá con un resumen corto de lo que quedó configurado y de lo que cambiaste en las reglas del proyecto.
