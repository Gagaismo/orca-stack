## Orca stack: contrato de trabajo

Este bloque lo mantiene orca-stack y describe cómo trabajan los agentes en este repo. Las reglas del proyecto que están fuera del bloque valen por encima de él cuando nombran la regla que cambian. Es igual en todos los proyectos: lo que cambia de un repo a otro vive en `.orca-stack.json` y se lee de ahí, no de este texto. Al final del bloque están las rutas de la política general y de los briefs por rol.

Los encabezados `## Evidencia`, `## Desvíos del ticket`, `## BLOQUEA` y `## SUGERENCIAS`, y las líneas `Implementador: <agente>`, `Revisor: <agente>`, `Commit: <sha>`, `Verificado por main: hallazgos <n,…> corregidos en <sha>` y `Decidido por main: <hallazgo> — <razón>`, son marcas fijas del protocolo: no se traducen aunque el resto del texto vaya en otro idioma, porque la sesión de `main` las busca literalmente.

### Configuración del proyecto

La configuración sale de tres capas que se fusionan en este orden, y las posteriores pisan a las anteriores: `~/.orca-stack/config.json` (personal, por máquina, no se commitea), `.orca-stack.json` en la raíz del repo (reglas del proyecto, se commitea) y `.orca-stack.local.json` (local, ignorado por git). Las claves de objeto se fusionan una por una; una lista de una capa reemplaza a la de la anterior. Leé las tres antes de decidir algo que dependa de ellas. Cuando este contrato dice "lo que fijó el setup", se refiere a estas claves y a la capa donde suele vivir cada una:

| Clave | Qué guarda |
|---|---|
| `setup` | `"completo"` cuando el setup ya se hizo |
| `modo` | `"multiagente"` (Orca despacha workers) o `"un-agente"` |
| `ramaBase` | la rama contra la que se abren los PRs |
| `agentes` | en `.orca-stack.json`: `usa` (qué agentes usa este repo), `preguntarAntes` (los que necesitan el OK del humano antes de despacharse) y las excepciones del proyecto. El inventario de modelos y esfuerzos (`agentes.modelos`) vive en la config personal, porque depende de la máquina y de las cuentas de cada persona |
| `verificacion` | `{ "suite": "...", "typecheck": "..." }`: los comandos exactos, con los flags que el repo necesite para terminar |
| `review` | solo en modo `un-agente`: quién hace el review de registro, `"subagente"` (por defecto) o `"humano"` |
| `merge` | si `main` mergea sola cuando se cumple la condición de merge |
| `despliegue` | `{ "despues": false }`, o el comando y cómo se verifica |
| `idioma` | el idioma del código, los commits y los PRs |

Un agente puede estar sin cuota por un tiempo: el mod `guardia-despacho` y `.orca-stack.json` lo dicen, y en ese caso no se despacha hasta que vuelva.

### Setup pendiente

Si `.orca-stack.json` no existe o no tiene `"setup": "completo"`, la sesión de `main` (y solo ella) le ofrece al humano hacer el setup con la skill `orca-setup`, antes de cualquier otro trabajo. Un worker nunca lo ofrece ni lo hace: si lo encuentra pendiente, sigue con su brief, porque el setup necesita al humano y un worker trabaja sin él.

### Qué rol tenés

El rol lo da el checkout, no el agente. Comparalo con `git rev-parse --git-dir` y `git rev-parse --git-common-dir`:

- Iguales y en la rama `ramaBase`: sos la sesión de **`main`**. Orquestás, despachás, mergeás e integrás `CONTEXT.md` y los ADRs. No implementás tickets ni revisás PRs.
- Iguales pero en otra rama: actuás como `main`, pero no mergeás hasta volver a `ramaBase`.
- Distintos: estás en un **worktree**. Si su nombre empieza con `revision`, sos revisor; si no, implementás el ticket de tu brief vos mismo, de punta a punta. Las reglas de coordinación y delegación del `CLAUDE.md` global (gentle-ai) valen solo para `main`.

### Agentes

| Agente | Implementa | Revisa | Cómo trabaja |
|---|---|---|---|
| claude (`main`) | No | No | Orquesta. Método de Matt por defecto; el SDD de gentle-ai solo si el humano lo pide. En modo `un-agente` esta misma sesión planifica e implementa (ver abajo). |
| claude (worker) | Sí, con `implement` | Solo si el humano lo pide | Modo desatendido. |
| agy | Sí | Sí, es el revisor por defecto | Las skills se le piden en prosa ("seguí el skill `implement`"). |
| codex | Sí | Sí | Codex directo. |
| codex-cc | Sí; si figura en `preguntarAntes` (lo normal, porque usa créditos de Command Code), preguntale al humano antes de despacharlo | Sí | Codex por Command Code. No revisa PRs escritos por codex ni por codex-cc: comparten modelo y puntos ciegos. |
| pi (Gentle Shell) | Sí, con su propia metodología (puede usar SDD) | Judgment Day, como segundo review de PRs de riesgo alto | También es el par que `main` consulta con `consultar_gentle_shell`. |

Revisa agy, salvo que el PR lo haya escrito agy: entonces revisa codex, o codex-cc si codex no está disponible. Un PR de codex o de codex-cc lo revisa agy. pi todavía no tiene lanzador en orca-stack: despachalo solo si el humano te dice cómo. Qué agentes están en uso en este repo lo dice `agentes` en `.orca-stack.json`; los que figuran en `preguntarAntes` se despachan solo con el OK del humano.

Nadie revisa su propio PR y un worktree de ticket nunca revisa. Preferí que revise un agente distinto del que implementó, porque comparte menos puntos ciegos.

### Modo `un-agente`

Cuando `modo` es `"un-agente"` no hay workers: la misma sesión planifica e implementa, y los pasos de despacho de este contrato no aplican. El review que cuenta lo hace igual un contexto distinto del que escribió el código: un subagente de contexto limpio, de otra familia de modelos si hay una disponible, con el mismo formato `## BLOQUEA` / `## SUGERENCIAS` y antes de mergear. La sesión de `main` publica ese review con `--body-file`, con las primeras líneas `Revisor: subagente (<modelo>)` y `Commit: <sha>`; la línea `Implementador:` del PR nombra al agente de esa sesión. Si `review` es `"humano"`, el review lo hace el humano y `main` solo registra su veredicto con las mismas líneas. Sin un review hecho por otro contexto no se mergea, porque quien escribió el código comparte con él todos sus puntos ciegos.

### Permisos

Sin preguntar: crear ramas, commitear, pushear, abrir PRs, comentar y etiquetar issues, despachar, elegir revisor y, en `main`, mergear cuando se cumple la condición de merge. Se hace y después se cuenta.

Se pregunta: lo irreversible (reescribir historia, force push, borrar ramas o issues, tocar algo ya publicado), gastar plata, credenciales, mensajes a terceros y cambios al stack global. Si Pi discrepa en algo material, se le muestran al humano las dos posturas con sus razones.

### Ciclo de `main`

1. Una idea nueva o ambigua se trabaja con `grilling`, `to-spec` y `to-tickets`. Esas skills las dispara el humano: proponé cuál corresponde y esperá.
2. Cada ticket lleva criterios de aceptación, una sección `## Modos de falla` con un test por modo (qué pasa si una llamada externa falla o no contesta, si algo falla entre dos escrituras, si llega null o vacío, si se llama dos veces o en paralelo), `## ADRs que aplican`, `UNKNOWN / MUST VERIFY` para lo que no se sabe de una API externa, y sus bloqueantes como dependencias nativas de GitHub. Los riesgos que conocés van al ticket, no al review: así el implementador los prueba en vez de enterarse por un rebote. Si a un ticket le faltan secciones, completalas vos editando el issue antes de despacharlo; si para completarlo hace falta una decisión de producto, preguntásela al humano.
3. Un ticket es despachable si está abierto, no tiene bloqueantes abiertos, no tiene assignee, no tiene `needs-info` y no es paraguas (no tiene sub-issues). Leé cada issue con `gh issue view <n> --comments`: los comentarios dicen si sigue vivo, y el cuerpo de un ticket parqueado parece vigente.
4. Despachá (ver "Despacho manual"). Asigná el issue antes de crear el worktree: el assignee es el cerrojo que evita despachar dos veces. Un issue que ya tiene assignee está tomado aunque el assignee sea tu propia cuenta, porque todas las sesiones y los workers usan la misma cuenta de `gh`. Por la misma razón, en cada repo trabaja una sola sesión de `main`.
5. Vigilá los PRs y los workers con un Monitor de fondo (`gh pr list`, `orca worktree ps --json`). Antes de rearmar un Monitor, matá el anterior: si sigue vivo, le roba los eventos al nuevo.
6. Con un PR nuevo, despachá el review a un agente que no sea el autor.
7. Mergeá solo si se cumplen estas cosas, verificadas con `gh pr view <n> --comments` y `gh pr checks <n>`: (a) hay un comentario de review con `## BLOQUEA` en `nada` y su línea `Revisor:` nombra un agente distinto del de la línea `Implementador:` del PR, o, como alternativa a ese review limpio cuando el PR rebotó, un comentario publicado por `main` con `--body-file` y la línea `Verificado por main: hallazgos <n,…> corregidos en <sha>` (rebote mecánico, ver el paso 8) o, para cada hallazgo que siga en pie después de la segunda ronda, una línea `Decidido por main: <hallazgo> — <razón>`; (b) esos comentarios llevan una línea `Commit: <sha>` igual al `headRefOid` que muestra `gh pr view <n> --json headRefOid`: un review limpio de un commit anterior no cuenta, porque aprobó otro código; (c) la CI está en verde o, si el repo no tiene CI, el review dice que el revisor corrió la suite completa en verde. Además, `merge` tiene que decir que `main` mergea sola; si no, le pedís el merge al humano. Si falta algo, no mergeás: despachás lo que falte.
8. Un PR rebota una sola vez. La segunda ronda lee solo el delta. Si el rebote fue mecánico (idioma, un nombre, un test que faltaba), el autor lo corrige y vos verificás el arreglo leyendo `gh pr diff` contra los hallazgos, sin pedir otro review; nunca lo arreglás vos. Dejás constancia con un comentario tuyo que lleve `Verificado por main: hallazgos <n,…> corregidos en <sha>` y `Commit: <sha>`. Un bloqueo `inferido` podés mandarlo a refutar antes de rebotar. Lo que siga en pie después de la segunda ronda lo decidís vos, y lo dejás escrito con una línea `Decidido por main: <hallazgo> — <razón>` por hallazgo, más `Commit: <sha>`.
9. Después del merge: si la rama base no es la rama por defecto del repo, `Closes #` no cierra el issue y lo cerrás a mano. Integrá lo que el PR propuso bajo `## Propuesta para CONTEXT.md` o `## Propuesta de ADR`, marcá el worktree como terminado y desplegá solo si `despliegue` dice cómo; después verificá el despliegue como ahí se indica. Con `{ "despues": false }` no se despliega.

### Verificación

Corré la verificación con los comandos de `verificacion` (`suite` y `typecheck`), sin cambiarles los flags. Si un comando puede tardar más de diez minutos, ponele un límite de tiempo; si se pasa, avisale al humano con lo último que mostró, en vez de quedarte esperando en segundo plano.

### Despacho manual

Hasta que exista `orca-stack despachar`, se despacha a mano y se trata como un handoff: el worker trabaja solo y no se lo supervisa con `orca orchestration`, salvo que el humano pida supervisar un Run.

1. Escribí el brief en un archivo fuera del repo (por ejemplo `~/orca/briefs/<repo>-<n>.md`): el número de issue, que lo lea con `--comments`, el agente que lo implementa, los comandos de `verificacion`, que pregunte comentando en el issue y que termine abriendo el PR contra `ramaBase` (`gh pr create --base <ramaBase> --body-file ...`) con el formato de abajo.
2. `orca worktree create --name <repo>-<n> --issue <n> --base-branch origin/<ramaBase> --no-parent --json` desde este checkout; la ruta del worktree nuevo sale del JSON. `--no-parent` evita que la rama nueva salga de un feature a medio hacer.
3. `orca terminal create --worktree path:<ruta> --title <agente> --command "<lanzador>" --json`. Lanzá el agente con su lanzador de la política del stack (`~/orca/stack/ORCA-STACK.md`, sección "Launching agents for a manual dispatch"): ahí están los comandos de cada agente para la terminal de Orca, que es PowerShell en Windows. Sumá `--model <modelo>` a claude o agy si la config fija uno. agy arranca preguntando si confiás en la carpeta: contestá con Enter. Antes de mandar el brief, confirmá con `orca terminal read --terminal <handle>` que el TUI del agente está arriba; si el brief cae en la shell, se ejecuta como comando.
4. Mandá una sola línea con `orca terminal send --terminal <handle> --text "Leé y seguí el brief de <ruta del archivo>" --enter`. El brief va en un archivo porque cada salto de línea que mandás por la terminal se convierte en un Enter.

El revisor se despacha igual, en un worktree propio cuyo nombre empiece con `revision` y creado desde `origin/<ramaBase>`, con un brief que nombra el PR, el agente que lo implementó y el formato de review de abajo.

### PRs

- Un PR de ticket lleva `Closes #<n>`, la línea `Implementador: <agente>`, una sección `## Evidencia` con una fila por cada criterio de aceptación y cada modo de falla (el nombre exacto del test que lo prueba y la línea de la corrida en verde, o cómo se verificó si no hay test) y una sección `## Desvíos del ticket` (`ninguno`, o qué se hizo distinto y por qué).
- Un PR de orquestación (este contrato, scripts, ADRs) no lleva `Closes #`: su cuerpo dice qué se pidió y qué criterios cumple.
- El cuerpo de un PR o de un review se manda con `--body-file`, nunca por tubería: la consola de Windows rompe los acentos.
- Los implementadores no editan `CONTEXT.md` ni `docs/adr/`: lo proponen en el cuerpo del PR y lo integra `main`.
- Si el diff proyecta más de 700 líneas, pará y avisá en el issue antes de seguir.

### Review

El review que cuenta es el cruzado. `/code-review` dentro de `implement`, y el review RDD de gentle-ai si alguien lo prende, son autochequeos del autor y no lo reemplazan.

Se revisa en tres ejes: **Standards** (el código cumple `AGENTS.md` y usa el vocabulario de `CONTEXT.md`), **Spec** (hace lo que pide el issue, incluidos sus modos de falla; un PR de orquestación se mide contra su cuerpo) y **Modos de falla** (los de la lista del ticket, solo lo que el diff introduce o toca). La Evidencia se verifica, no se cree: abrí al menos un test de la tabla y comprobá que afirme lo que dice su criterio.

No bloquea: una regla que no está en `AGENTS.md` (si un hallazgo cita `AGENTS.md`, tiene que poder señalar la línea), ni un problema que ya estaba y el diff no toca ni empeora. Cada bloqueo dice si lo **introduce** o lo **empeora** el diff, y si su evidencia es **concreta** (una línea, un test que falla) o **inferida** (en ese caso, qué habría que correr para confirmarlo).

Escribí el review en un archivo UTF-8 y publicalo con `gh pr review <n> --comment --body-file <archivo>`. No apruebes, no mergees y no arregles el código. El formato es este, sin listas de lo que está bien:

```
Revisor: <agente>
Commit: <sha>

## BLOQUEA
1. `archivo:línea` (introducido|empeorado, concreta|inferida): el problema en una frase. Cómo se reproduce o qué criterio incumple. El arreglo, en una línea.

## SUGERENCIAS
(como mucho tres, una línea cada una)
```

Sin bloqueos, `## BLOQUEA` dice `nada`: así se distingue un review limpio de uno que no se corrió. Si el repo no tiene CI, corré la suite completa en tu worktree y agregá debajo de `Revisor:` la línea `Suite: <comando> en verde`.

### Skills de Matt

| Situación | Skill |
|---|---|
| Implementar un ticket | `implement` (corre `tdd` por dentro) |
| Revisar un PR ajeno | `code-review`, con los ejes de arriba |
| Un bug difícil o una regresión de performance | `diagnosing-bugs` |
| Dudar de un modelo de estado o de una UI | `prototype` |
| Vocabulario del dominio o un ADR | `domain-modeling` |
| La interfaz de un módulo o dónde va un seam | `codebase-design` |
| Un conflicto de merge en curso | `resolving-merge-conflicts` |
| Un paso que solo puede hacer un humano | `wizard` |

En Claude se invocan con `/mattpocock-skills:<skill>`, con el slash al principio del mensaje. En agy y codex se piden en prosa. `to-spec`, `to-tickets`, `wayfinder`, `triage` y `ask-matt` solo las puede disparar el humano. Si una invocación no toma, abrí el `SKILL.md` por ruta y seguilo.

### Avances

Antes de una tarea larga, decí en una línea qué vas a hacer. Al terminar, cerrá con un resumen que se entienda solo: qué hiciste, qué encontraste y qué necesitás del humano.
