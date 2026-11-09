<!-- orca-stack:begin -->
## Orca stack: contrato de trabajo

Este bloque lo mantiene orca-stack y describe cómo trabajan los agentes en este repo. Las reglas del proyecto que están fuera del bloque valen por encima de él cuando nombran la regla que cambian. Es igual en todos los proyectos: lo que cambia de un repo a otro vive en `.orca-stack.json` y se lee de ahí, no de este texto. Al final del bloque están las rutas de la política general y de los briefs por rol.

Los encabezados `## Evidencia`, `## Desvíos del ticket`, `## BLOQUEA`, `## SUGERENCIAS`, `## Arena` y `## Swarm`, y las líneas `Implementador: <agente>`, `Revisor: <agente>`, `Commit: <sha>`, `Verificado por main: hallazgos <n,…> corregidos en <sha>`, `Decidido por main: <hallazgo> — <razón>`, `Rebote: <sha>`, `Rebote CI: <sha>`, `Rebote conflicto: <sha>`, `Marcha: <lazy|medium|proactive>`, `Esperando marcha: <items>`, `Consulta: <agente>`, `Respuesta de main:` y `Respuesta del humano:`, son marcas fijas del protocolo: no se traducen aunque el resto del texto vaya en otro idioma, porque la sesión de `main` las busca literalmente.

### Configuración del proyecto

La configuración sale de tres capas que se fusionan en este orden, y las posteriores pisan a las anteriores: `~/.orca-stack/config.json` (personal, por máquina, no se commitea), `.orca-stack.json` en la raíz del repo (reglas del proyecto, se commitea) y `.orca-stack.local.json` (local, ignorado por git). Las claves de objeto se fusionan una por una; una lista de una capa reemplaza a la de la anterior. Leé las tres antes de decidir algo que dependa de ellas. Cuando este contrato dice "lo que fijó el setup", se refiere a estas claves y a la capa donde suele vivir cada una:

| Clave | Qué guarda |
|---|---|
| `setup` | `"completo"` cuando el setup ya se hizo |
| `modo` | `"multiagente"` (Orca despacha workers) o `"un-agente"` |
| `ramaBase` | la rama contra la que se abren los PRs |
| `agentes` | en `.orca-stack.json`: `usa` (qué agentes usa este repo), `preguntarAntes` (los que necesitan el OK del humano antes de despacharse) y las excepciones del proyecto. El inventario de modelos y esfuerzos (`agentes.modelos`) y la cuenta de Claude que usa pi (`agentes.pi.claudeConfigDir`) viven en la config personal, porque dependen de la máquina y de las cuentas de cada persona |
| `verificacion` | `{ "suite": "...", "typecheck": "..." }`: los comandos exactos, con los flags que el repo necesite para terminar |
| `riesgo` | las rutas (globs) cuyo cambio es una puerta de una vía: migraciones, auth, borrado de datos, contratos públicos, deploy, dependencias |
| `review` | solo en modo `un-agente`: quién hace el review de registro, `"subagente"` (por defecto) o `"humano"` |
| `merge` | si `main` mergea sola cuando se cumple la condición de merge |
| `despliegue` | `{ "despues": false }`, o el comando, cómo se verifica y `pruebaFuncional`: al menos un recorrido real de punta a punta por el flujo de producción hasta un destino permitido |
| `idioma` | el idioma del código, los commits y los PRs |

Un agente puede estar sin cuota por un tiempo: el mod `guardia-despacho` y `.orca-stack.json` lo dicen, y en ese caso no se despacha hasta que vuelva.

### Setup pendiente

Si `.orca-stack.json` no existe o no tiene `"setup": "completo"`, la sesión de `main` (y solo ella) le ofrece al humano hacer el setup con la skill `orca-setup`, antes de cualquier otro trabajo. Un worker nunca lo ofrece ni lo hace: si lo encuentra pendiente, sigue con su brief, porque el setup necesita al humano y un worker trabaja sin él.

### Qué rol tenés

El rol lo da el checkout, no el agente. Comparalo con `git rev-parse --git-dir` y `git rev-parse --git-common-dir`:

- Iguales y en la rama `ramaBase`: sos la sesión de **`main`**. Orquestás, despachás, mergeás e integrás `GLOSSARY.md` y los ADRs; corrés ODD para tu propio trabajo de orquestación, nunca implementás tickets ni revisás PRs.
- Iguales pero en otra rama: actuás como `main`, pero no mergeás hasta volver a `ramaBase`.
- Distintos: estás en un **worktree**. Si su nombre empieza con `revision`, sos revisor; si no, implementás el ticket de tu brief vos mismo, de punta a punta. Las reglas de coordinación y delegación del `CLAUDE.md` global (gentle-ai) valen solo para `main`.

Si el repo todavía tiene `CONTEXT.md` en vez de `GLOSSARY.md`, leelo como si fuera `GLOSSARY.md`; el setup lo renombra.

Si sos `main` (o la sesión única en modo `un-agente`), leé `~/orca/stack/MAIN.md` entero antes de actuar: ahí están el Ciclo de `main`, las Marchas, el Despacho, los Permisos de `main` y Arena y swarm.

### Marchas

Esta sección es solo de `main` y está en `~/orca/stack/MAIN.md`.

### Agentes

| Agente | Implementa | Revisa | Cómo trabaja |
|---|---|---|---|
| claude (`main`) | No | No | Orquesta. Planificación con las skills de Matt (`grill-with-docs`, `to-spec`, `to-tickets`, disparadas por el humano), implementación con gentle-ai ODD (main corre ODD para su trabajo de orquestación, nunca implementa tickets). En modo `un-agente` esta misma sesión planifica e implementa con ODD (ver abajo). |
| claude (worker) | Sí, con ODD | Solo si el humano lo pide | Modo desatendido. |
| agy | Sí | Sí, es el revisor por defecto | Las skills se le piden en prosa. |
| codex | Sí | Sí | Codex directo. |
| pi (Gentle Shell) | Sí, con su propia metodología (puede usar ODD) | Sí, como segundo review de los PRs que tocan `riesgo`, salvo los que escribió pi. Corre sobre Claude: al lado de claude aporta otra metodología, no otro modelo | También es el par que `main` consulta con `consultar_gentle_shell`. Esa consulta es de solo lectura y no reemplaza un review. |

Revisa agy, salvo que el PR lo haya escrito agy: entonces revisa codex. Si codex está bloqueado o no tiene cuota, el PR espera a que codex vuelva. Una regla `guardia.bloquear` vigente cuenta como bloqueo: `despachar` y `revisar` se niegan a despachar a ese agente y dicen el motivo. Un revisor nunca corre un modelo de la misma familia que el autor: dos modelos de una familia comparten puntos ciegos. La familia sale del modelo que cada agente tiene en `agentes.modelos`, y `revisar` se niega cuando coinciden. pi es la excepción: corre sobre Claude, y al lado de claude aporta otra metodología. Un PR de codex lo revisa agy. Qué agentes están en uso en este repo lo dice `agentes` en `.orca-stack.json`; los que figuran en `preguntarAntes` se despachan solo con el OK del humano.

Nadie revisa su propio PR y un worktree de ticket nunca revisa. Excepción: con `agentes.pi.review: "rdd"` en la config, el review RDD que pi corre sobre un PR suyo cuando `main` se lo pide (`orca-stack rebote <pr> --rdd <lentes>`) es un review de registro, porque revisores de contexto limpio miran un commit congelado. El autochequeo ODD de pi, o un RDD que pi corrió por su cuenta antes del PR sin que `main` lo pidiera, no cuentan.

### Modo `un-agente`

Esta sección es solo de `main` y está en `~/orca/stack/MAIN.md`.

### Permisos

Sin preguntar: crear ramas, commitear, pushear, abrir PRs, comentar y etiquetar issues, despachar, elegir revisor y, en `main`, mergear cuando se cumple la condición de merge. Se hace y después se cuenta; esta lista cuenta como la autorización explícita de ODD para esas acciones.

Se pregunta: lo irreversible (reescribir historia, force push, borrar ramas o issues, tocar algo ya publicado), gastar plata, credenciales, mensajes a terceros y cambios al stack global. Si Pi discrepa en algo material, se le muestran al humano las dos posturas con sus razones.

Excepción de `Arena y swarm`: el owner puede borrar, sin preguntar, las ramas y los worktrees candidatos que haya creado si se cumplen todas las condiciones de la excepción de abajo; se vuelven a comprobar justo antes de borrar.

- Cada candidato se llama `worktree-agent-<id>` y su id figura en su propio `## Arena`.
- No tiene upstream y no aparece en `git ls-remote`.
- La nota de síntesis está publicada (para un worker, el PR está abierto).
- Se borra un id listado por vez, nunca por patrón: primero `git worktree remove` sin `--force` y después `git branch -D`; nunca `orca worktree rm`.
- Si `git worktree remove` se niega, el candidato queda y el owner lo informa. Borrar es opcional.

Por ejemplo, si `## Arena` lista `worktree-agent-a1b2` y `worktree-agent-c3d4`, se pueden borrar esos dos de a uno tras publicar la nota y comprobar upstream y `git ls-remote`; un `worktree-agent-e5f6` no listado nunca se toca.

Después de una llamada rechazada o interrumpida, revisá sus efectos (`orca worktree ps --json`, `git status`, `gh pr view`) antes de intentar lo mismo por otro camino: el despacho pudo haber salido igual.

### Ciclo de `main`

Esta sección es solo de `main` y está en `~/orca/stack/MAIN.md`.

### Arena y swarm

Lo que es solo de `main` (quién autoriza, las notas de fan-out de un worker, las señales y el modo autónomo) está en `~/orca/stack/MAIN.md`. Lo que sigue vale para cualquier owner de una fan-out.

**Ruta y ownership.** La arena y el swarm corren en proceso, como subagentes de quien tiene la tarea (Agent tool o Workflow). Cada writer de una arena trabaja en un worktree aislado; aplica tanto en `multiagente` como en `un-agente`. `despachar`, `revisar` y las reglas de review no cambian. Quien tiene la tarea ejecuta la arena e injerta el resultado: `main` para su trabajo de orquestación y el worker para su ticket. Se mantiene la regla de que `main` nunca implementa tickets.

**Arena.** El owner propone una sola línea que diga por qué hace falta, cuántas candidaturas propone, en qué se diferencian y cuál es la rúbrica. Por ejemplo: "Propongo una arena de diseño en #158: dos diseños sin ganador; N=3 (Haiku, Sonnet, Opus); rúbrica: …". `main` no ejecuta nada hasta que el humano da el OK. El judge es de solo lectura, no es un review; en modo `un-agente`, elegir una candidatura nunca cuenta como el review de registro. Las compensaciones del judge de #168 y las fases completas de la arena están en `~/.claude/skills/arena/SKILL.md` o `~/.agents/skills/arena/SKILL.md`. La suite configurada y los tests RED corren sobre el resultado injertado, no sobre una candidatura aislada.

**Swarm.** Es trabajo de lectura y no publica nada. Una suite o build en paralelo requiere worktrees aislados. Las APIs externas son operaciones remotas y requieren su autorización. El informe no reemplaza CI ni `Verificado por main`. Leer áreas distintas para darle contexto a `main` es delegación, no un swarm, y no deja `## Swarm`. Los resultados se publican bajo `## Arena` o `## Swarm` en el artefacto correspondiente: comentario del issue o cuerpo del PR de orquestación para `main`, cuerpo del PR para un worker. Las fases y el formato del informe están en `~/.claude/skills/swarm/SKILL.md` o `~/.agents/skills/swarm/SKILL.md`.

**Antes de la fan-out.** El owner comprueba que git ignore `.claude/worktrees/` con `git check-ignore`. Si no lo ignora, la fan-out no se ejecuta y el owner explica por qué; #161 escribe esa entrada. En Claude Code, el worktree se espera en `.claude/worktrees/agent-<id>` y la rama `worktree-agent-<id>` (valores observados en #151). En v1, solo los workers de Claude hacen fan-out; #170 cubre la parte del brief.

### Verificación

Corré la verificación con los comandos de `verificacion` (`suite` y `typecheck`), sin cambiarles los flags. Si un comando puede tardar más de diez minutos, ponele un límite de tiempo; si se pasa, avisale al humano con lo último que mostró, en vez de quedarte esperando en segundo plano.

### PRs

- El cuerpo sigue la skill `pr`: `## Summary` con la vista más chica que deje claro el cambio, `## Evidencia` y `## Merge Danger` (puerta de una o dos vías y blast radius).
- Un PR de ticket lleva `Closes #<n>`, la línea `Implementador: <agente>` y `## Evidencia` con una fila por cada regla (o, en tickets legacy, por cada criterio de aceptación y modo de falla usado como RED) y por cada entrada pública tocada (la definición está en el brief del ticket que arma `orca-stack despachar`). Cada fila incluye el nombre exacto del test y la línea de la corrida en verde, o cómo se verificó si no hay test. Si no se toca ninguna entrada pública existente, se indica `none touched` sin una fila de relleno. Agregá antes y después cuando el cambio se ve (captura o salida), y `## Desvíos del ticket` (`ninguno`, o qué se hizo distinto y por qué).
- Un PR de orquestación (este contrato, scripts, ADRs) no lleva `Closes #`: su cuerpo dice qué se pidió y qué criterios cumple.
- El cuerpo de un PR o de un review se manda con `--body-file`, nunca con `--body` ni por tubería: desde la consola de Windows se rompen los acentos y los saltos de línea.
- Si existe `CODING_STANDARDS.md`, leelo antes de commitear y verificá tu cambio contra él.
- Los implementadores no editan `GLOSSARY.md` ni `docs/adr/`: lo proponen en el cuerpo del PR bajo `## Propuesta para GLOSSARY.md` o `## Propuesta de ADR`, y lo integra `main`.
- Si el diff proyecta más de 700 líneas, pará y avisá en el issue antes de seguir.

### Dónde vive cada regla

Cada regla del repo vive en un solo archivo; los demás apuntan a ella sin copiarla.

- **Mecánica** (la puede verificar una herramienta: formato de commits, secretos, tipos, lint): vive en la CI, con un hook local como aviso temprano. Cuenta la CI, porque un hook se saltea con `--no-verify`. Sale de `AGENTS.md` solo cuando el chequeo existe y se lo vio fallar con un caso malo.
- **De juicio sobre cómo se escribe el código**: vive en `CODING_STANDARDS.md`, si existe.
- **De producto o privacidad** (cambia qué se implementa): vive en `AGENTS.md`.

### Review

El review que cuenta es el cruzado: la skill `code-review` del brief y el review RDD de gentle-ai son autochequeos del autor y no lo reemplazan, salvo el review RDD que pide `main` (ver Agentes).

Los ejes, los tests derivados, la comprobación de que un test del autor falle sin el cambio y la limpieza de tests están en el brief de revisión que arman `orca-stack revisar` y `orca-stack brief-revision`.

Bloquean solo cuatro tipos de evidencia concreta: `test` (un test del reviewer que falla), `comando` (un comando y su salida), `regla escrita` (un `archivo:línea` que rompe una regla citada de `CODING_STANDARDS.md` o `AGENTS.md`) y `regla sin test` (la regla o criterio del ticket, nombrado, que el diff no cumple o no prueba). No bloquean lo inferido, que va a `## SUGERENCIAS` con qué correr para confirmarlo ("puede haber una race si corren dos `despachar`", sin reproducción), los code smells, otros documentos, una regla mecánica que ya tiene chequeo en la CI, ni lo que el diff no toca ni empeora.

Cada bloqueo dice si lo introduce o lo empeora y su tipo de evidencia. Se etiqueta `implementación` si el código rompe una regla clara, o `interpretación` si autor y reviewer leen la regla distinto; esos van al humano y `main` no los salda con `Decidido por main`.

El formato, sin listas de lo que está bien:

```
Revisor: <agente>
Commit: <sha>

## BLOQUEA
1. `archivo:línea` (introducido|empeorado, test|comando|regla escrita|regla sin test, implementación|interpretación): el problema en una frase. Su evidencia; para un test, su código. El arreglo, en una línea.

## SUGERENCIAS
(como mucho tres, una línea cada una; lo inferido primero)
```

Sin bloqueos, `## BLOQUEA` dice `nada`. Sin CI, el revisor corre la suite completa y agrega debajo de `Revisor:` la línea `Suite: <comando> en verde`. Si el diff es una puerta de una vía y el `## Merge Danger` dice otra cosa, va a `## SUGERENCIAS`.

### Skills de Matt

| Situación | Skill |
|---|---|
| Implementar un ticket | gentle-ai ODD |
| Escribir el cuerpo de un PR | `pr` |
| Revisar un PR ajeno | `code-review`, con los ejes de arriba |
| Un bug difícil o una regresión de performance | `diagnosing-bugs` |
| Dudar de un modelo de estado o de una UI | `prototype` |
| Vocabulario del dominio o un ADR | `domain-modeling` |
| La interfaz de un módulo o dónde va un seam | `codebase-design` |
| Un paso que solo puede hacer un humano | `wizard` |

En Claude se invocan con `/mattpocock-skills:<skill>`, con el slash al principio del mensaje. En agy y codex se piden en prosa. `grill-with-docs`, `to-spec`, `to-tickets`, `wayfinder`, `triage`, `retro` y `ask-matt` solo las puede disparar el humano. Si una invocación no toma, abrí el `SKILL.md` por ruta y seguilo.

### Avances

Antes de una tarea larga, decí en una línea qué vas a hacer. Al terminar, cerrá con un resumen que se entienda solo: qué hiciste, qué encontraste y qué necesitás del humano.

### Política del stack

Política canónica: `~/orca/stack/ORCA-STACK.md` (se puede cambiar con `$ORCA_STACK_POLICY_PATH`). Briefs por rol: `~/orca/stack/ROLE-BRIEFS.md`.
Si faltan, corré `npx github:Gagaismo/orca-stack global`.

- El runtime de Orca y el Dispatch activo manejan el ciclo de vida, la delegación, los workers, el cierre y la limpieza. Un worker ejecuta su brief: no arranca otro flujo de trabajo ni espera al humano.
- Planificación con las skills de Matt Pocock (grill-with-docs, to-spec, to-tickets, disparadas por el humano), e implementación con gentle-ai ODD en todo el stack. Gentle Shell (Pi) trabaja con la suya y puede usar ODD. Ponytail se aplica en el trabajo de implementación con el nivel configurado, pero nunca contra un requisito explícito.
- Respetá los requisitos explícitos de la spec, el ticket y los ADRs, y también la validación, la seguridad, la accesibilidad, el manejo de errores, la protección contra pérdida de datos y los tests que se piden: son lo que el humano espera recibir.
- Caveman sigue el ajuste Auto/Off del stack y comprime solo prosa pesada en tokens. Conservá el código, los comandos, las rutas, los errores exactos, las decisiones, los riesgos, las dudas, los tests y la evidencia de aceptación.
- Engram es solo memoria: no es autoridad ni planificador. Para las reglas de cada rol, leé la política canónica.
- Las reglas de los mods de Claude Code para este proyecto están en `.orca-stack.json` (se commitea) y `.orca-stack.local.json` (local, ignorado por git); las personales, en `~/.orca-stack/config.json`.
<!-- orca-stack:end -->

## Project rules

- **No reviews in this repo for now (speed first), for PRs not written by pi.** This overrides step 7 (a), (b) and (d) of "Ciclo de `main`" and step 6 (no review dispatch): `main` merges a PR as soon as CI is green and the PR body has its `## Evidencia`. Do not run `orca-stack revisar` unless the human asks. `riesgo` is empty on purpose. A PR over 400 lines still gets a Gentle Shell consult before merging (`puente-gentle` enforces it); if Gentle Shell has no quota, the human merges the PR or it waits. When the Gentle Shell consult of a PR finds a blocker and main has confirmed it in the code, main publishes it with `--body-file` as a comment in the review format, with first lines `Revisor: pi (consulta <tema>, publicada por main)` and `Commit: <headRefOid>`, then `## BLOQUEA` and `## SUGERENCIAS`, and bounces the PR with `orca-stack rebote <pr>`. A consult finding that main could not confirm is not published as `## BLOQUEA`: main shows Lautaro both positions with their reasons, as today. After the author's fix, main merges only with CI green on the new head and a comment of its own with `Verificado por main: hallazgos <n,…> corregidos en <sha>` and `Commit: <sha>`, written after reading `gh pr diff` against each finding; when the fix changes more than the findings, main consults Gentle Shell again in the same tema before merging. PRs whose `Implementador:` is pi follow the RDD mode instead (`agentes.pi.review: "rdd"` in `.orca-stack.json`, `MAIN.md` steps 6-8): main merges them with a `Sin review: <razón>` comment carrying `Commit: <headRefOid>`, or after an RDD review requested with `orca-stack rebote <pr> --rdd <lentes>`.
- **`main` is protected** (turned on once #65 merges): branches must be up to date, the `ci-ok` check is required, and admins are included, so every change reaches `main` through a PR.
- **Emergency only:** if CI itself is broken (a runner or `gitleaks-action` down) and a merge cannot wait, ask the human before lifting admin enforcement with `gh api -X DELETE repos/Gagaismo/orca-stack/branches/main/protection/enforce_admins`, and restore it with `-X POST` on the same path right after the merge.
- **Mods load at session start.** After a release that changes `mods/`, this session keeps running the old hooks: propose a handoff to a new session before any work that depends on the new ones.
