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

- Iguales y en la rama `ramaBase`: sos la sesión de **`main`**. Orquestás, despachás, mergeás e integrás `GLOSSARY.md` y los ADRs. No implementás tickets ni revisás PRs.
- Iguales pero en otra rama: actuás como `main`, pero no mergeás hasta volver a `ramaBase`.
- Distintos: estás en un **worktree**. Si su nombre empieza con `revision`, sos revisor; si no, implementás el ticket de tu brief vos mismo, de punta a punta. Las reglas de coordinación y delegación del `CLAUDE.md` global (gentle-ai) valen solo para `main`.

Si el repo todavía tiene `CONTEXT.md` en vez de `GLOSSARY.md`, leelo como si fuera `GLOSSARY.md`; el setup lo renombra.

### Agentes

| Agente | Implementa | Revisa | Cómo trabaja |
|---|---|---|---|
| claude (`main`) | No | No | Orquesta. Método de Matt por defecto; el SDD de gentle-ai solo si el humano lo pide. En modo `un-agente` esta misma sesión planifica e implementa (ver abajo). |
| claude (worker) | Sí, con `implement` | Solo si el humano lo pide | Modo desatendido. |
| agy | Sí | Sí, es el revisor por defecto | Las skills se le piden en prosa ("seguí el skill `implement`"). |
| codex | Sí | Sí | Codex directo. |
| codex-cc | Sí; si figura en `preguntarAntes` (lo normal, porque usa créditos de Command Code), preguntale al humano antes de despacharlo | Sí | Codex por Command Code, con el modelo que diga `agentes.modelos` (GPT, GLM u otro). |
| pi (Gentle Shell) | Sí, con su propia metodología (puede usar SDD) | Sí, como segundo review de los PRs que tocan `riesgo`, salvo los que escribió pi. Corre sobre Claude: al lado de claude aporta otra metodología, no otro modelo | También es el par que `main` consulta con `consultar_gentle_shell`. Esa consulta es de solo lectura y no reemplaza un review. |

Revisa agy, salvo que el PR lo haya escrito agy: entonces revisa codex, o codex-cc si codex no está disponible (una regla `guardia.bloquear` vigente cuenta como no disponible: `despachar` y `revisar` se niegan a despacharlo y dicen el motivo). Un revisor nunca corre un modelo de la misma familia que el autor: dos modelos de una familia comparten puntos ciegos. La familia sale del modelo que cada agente tiene en `agentes.modelos` (si codex-cc corre GLM, es otra familia que codex; si corre un GPT, la misma), y `revisar` se niega cuando coinciden. pi es la excepción: corre sobre Claude, y al lado de claude aporta otra metodología. Un PR de codex o de codex-cc lo revisa agy. Qué agentes están en uso en este repo lo dice `agentes` en `.orca-stack.json`; los que figuran en `preguntarAntes` se despachan solo con el OK del humano.

Nadie revisa su propio PR y un worktree de ticket nunca revisa. Preferí que revise un agente distinto del que implementó, porque comparte menos puntos ciegos.

### Modo `un-agente`

Cuando `modo` es `"un-agente"` no hay workers: la misma sesión planifica e implementa, y los pasos de despacho de este contrato no aplican. Con una spec que ya tiene tickets, proponé `implement-spec` (la dispara el humano): implementa la frontera de tickets con subagentes y deja todo en una rama de integración. El review que cuenta lo hace igual un contexto distinto del que escribió el código: un subagente de contexto limpio, de otra familia de modelos si hay una disponible, con el mismo formato `## BLOQUEA` / `## SUGERENCIAS` y antes de mergear. La sesión de `main` publica ese review con `--body-file`, con las primeras líneas `Revisor: subagente (<modelo>)` y `Commit: <sha>`; la línea `Implementador:` del PR nombra al agente de esa sesión. Si `review` es `"humano"`, el review lo hace el humano y `main` solo registra su veredicto con las líneas `Revisor: humano` y `Commit: <sha>`. Sin un review hecho por otro contexto no se mergea, porque quien escribió el código comparte con él todos sus puntos ciegos.

### Permisos

Sin preguntar: crear ramas, commitear, pushear, abrir PRs, comentar y etiquetar issues, despachar, elegir revisor y, en `main`, mergear cuando se cumple la condición de merge. Se hace y después se cuenta.

Se pregunta: lo irreversible (reescribir historia, force push, borrar ramas o issues, tocar algo ya publicado), gastar plata, credenciales, mensajes a terceros y cambios al stack global. Si Pi discrepa en algo material, se le muestran al humano las dos posturas con sus razones.

Un worktree terminado se marca terminado; no se remueve. `orca worktree rm` borra también la rama local, aunque tenga commits que no están en ningún otro lado: remové un worktree solo si el humano lo pide y `git branch --no-merged origin/<ramaBase>` no lista su rama.

Después de una llamada rechazada o interrumpida, revisá sus efectos (`orca worktree ps --json`, `git status`, `gh pr view`) antes de intentar lo mismo por otro camino: el despacho pudo haber salido igual.

### Ciclo de `main`

1. Una idea nueva o ambigua se trabaja con `grilling`, `to-spec` y `to-tickets`. Esas skills las dispara el humano: proponé cuál corresponde y esperá.
2. Cada ticket lleva criterios de aceptación, una sección `## Modos de falla` con un test por modo (qué pasa si una llamada externa falla o no contesta, si algo falla entre dos escrituras, si llega null o vacío, si se llama dos veces o en paralelo), `## ADRs que aplican`, `UNKNOWN / MUST VERIFY` para lo que no se sabe de una API externa, y sus bloqueantes como dependencias nativas de GitHub. Los riesgos que conocés van al ticket, no al review: así el implementador los prueba en vez de enterarse por un rebote. Si a un ticket le faltan secciones, completalas vos editando el issue antes de despacharlo; si para completarlo hace falta una decisión de producto, preguntásela al humano.
3. Trabajás la **frontera**: los tickets abiertos, sin bloqueantes abiertos, sin assignee, sin `needs-info` y que no son paraguas (sin sub-issues). Leé cada issue con `gh issue view <n> --comments`: los comentarios dicen si sigue vivo, y el cuerpo de un ticket parqueado parece vigente.
4. Despachá la frontera como una **tanda** con `orca-stack despachar <n> <agente>`, un ticket por comando (ver "Despacho"). `despachar` asigna el issue antes de crear nada; no lo asignes a mano: el assignee es el cerrojo que evita despachar dos veces. Un issue que ya tiene assignee está tomado aunque el assignee sea tu propia cuenta, porque todas las sesiones y los workers usan la misma cuenta de `gh`. Por la misma razón, en cada repo trabaja una sola sesión de `main`.
5. Vigilá la tanda con un solo Monitor de fondo sobre el estado de sus PRs (`gh pr list --json number,headRefName,reviewDecision,statusCheckRollup`), no uno por worker. Antes de rearmarlo, matá el anterior: si sigue vivo, le roba los eventos al nuevo.
6. Con un PR nuevo, despachá el review con `orca-stack revisar <pr> <agente>` a un agente que no sea el autor. Si el diff toca una ruta de `riesgo` o el revisor marcó puerta de una vía en `## Merge Danger`, despachá también un segundo review a pi. Si el PR lo escribió pi, los dos reviews van a agentes de dos familias de modelo distintas que no sean la de pi (Claude): claude no cuenta, y un agente cuyo modelo no tiene una familia reconocida tampoco. Cuando falta uno, el deny de `puente-gentle` dice qué agente despachar según `agentes.usa`, los bloqueos y `preguntarAntes`. `puente-gentle` no deja mergear un PR de `riesgo` sin esos reviews.
7. Mergeá solo si se cumplen estas cosas, verificadas con `gh pr view <n> --comments` y `gh pr checks <n>`: (a) hay un comentario de review con `## BLOQUEA` en `nada` y su línea `Revisor:` nombra un agente distinto del de la línea `Implementador:` del PR, o, como alternativa a ese review limpio cuando el PR rebotó, un comentario publicado por `main` con `--body-file` y la línea `Verificado por main: hallazgos <n,…> corregidos en <sha>` (rebote mecánico, ver el paso 8) o, para cada hallazgo que siga en pie después de la segunda ronda, una línea `Decidido por main: <hallazgo> — <razón>`; (b) esos comentarios llevan una línea `Commit: <sha>` igual al `headRefOid` que muestra `gh pr view <n> --json headRefOid`: un review limpio de un commit anterior no cuenta, porque aprobó otro código; (c) la CI está en verde o, si el repo no tiene CI, el review dice que el revisor corrió la suite completa en verde; después de un rebote, el comentario de `main` lleva también su propia línea `Suite: <comando> en verde`, corrida sobre ese mismo commit; (d) si hubo segundo review de pi (paso 6), o los dos reviews de un PR de pi, también está limpio. En un PR que toca `riesgo`, los reviews del paso 6 son siempre sobre el `headRefOid` (`Verificado por main` no los reemplaza), y un bloqueo sobre ese commit no se salda con `Decidido por main`: lo corrige el autor y se pide otro review, o lo decide el humano. Además, `merge` tiene que decir que `main` mergea sola; si no, le pedís el merge al humano. Si falta algo, no mergeás: despachás lo que falte.
8. Un PR rebota una sola vez. La segunda ronda lee solo el delta. Si el rebote fue mecánico (idioma, un nombre, un test que faltaba), el autor lo corrige y vos verificás el arreglo leyendo `gh pr diff` contra los hallazgos, sin pedir otro review; nunca lo arreglás vos. Dejás constancia con un comentario tuyo que lleve `Verificado por main: hallazgos <n,…> corregidos en <sha>` y `Commit: <sha>`. Un bloqueo `inferido` podés mandarlo a refutar antes de rebotar. Lo que siga en pie después de la segunda ronda lo decidís vos, y lo dejás escrito con una línea `Decidido por main: <hallazgo> — <razón>` por hallazgo, más `Commit: <sha>`.
9. Después del merge: si la rama base no es la rama por defecto del repo, `Closes #` no cierra el issue y lo cerrás a mano. Integrá lo que el PR propuso bajo `## Propuesta para GLOSSARY.md` (o `## Propuesta para CONTEXT.md`, en un PR anterior al renombre) o `## Propuesta de ADR`, marcá el worktree como terminado y desplegá solo si `despliegue` dice cómo; después de cada deploy, también los que cambian solo configuración, ejecutá `despliegue.pruebaFuncional`: un recorrido real de punta a punta que atraviese los mismos controles que una llamada normal y llegue a un destino permitido. Si la verificación falla, avisale al humano de inmediato y no sigas como si hubiera salido bien. Con `{ "despues": false }` no se despliega ni se verifica.
10. La tanda se cierra cuando cada uno de sus PRs está mergeado o decidido. Al cerrarla, proponele al humano `retro` y, si esta sesión ya cerró una tanda antes, un `handoff` a una sesión nueva: una sesión de `main` larga se queda sin contexto y sin cuota.

### Verificación

Corré la verificación con los comandos de `verificacion` (`suite` y `typecheck`), sin cambiarles los flags. Si un comando puede tardar más de diez minutos, ponele un límite de tiempo; si se pasa, avisale al humano con lo último que mostró, en vez de quedarte esperando en segundo plano.

### Despacho

`orca-stack despachar <n> <agente>` crea el worktree con `orca worktree create` desde `origin/<ramaBase>`, escribe el brief del ticket desde la plantilla (número de issue, rama, agente, los comandos de `verificacion` y cómo abrir el PR), comprueba que cada ruta que cita el brief exista en el worktree, lanza el agente en una terminal de Orca y le manda el brief. Se niega si la rama o el worktree ya tienen un agente vivo. `orca-stack revisar <pr> <agente>` hace lo mismo para un review, en un worktree `revision-<pr>-<agente>` parado en el commit del PR. Agregá lo propio de un ticket con `--nota "<texto>"`; si citás un archivo, que sea una ruta del repo y no algo que `.gitignore` deja afuera del worktree.

El despacho es un handoff: el worker trabaja solo y no se lo supervisa con `orca orchestration`, salvo que el humano pida supervisar un Run. Si un comando falla, mostrá su error al humano; no armes el despacho a mano.

### PRs

- El cuerpo sigue la skill `pr`: `## Summary` con la vista más chica que deje claro el cambio, `## Evidencia` y `## Merge Danger` (puerta de una o dos vías y blast radius).
- Un PR de ticket lleva `Closes #<n>`, la línea `Implementador: <agente>`, `## Evidencia` con una fila por cada criterio de aceptación y cada modo de falla (el nombre exacto del test que lo prueba y la línea de la corrida en verde, o cómo se verificó si no hay test), más el antes y después cuando el cambio se ve (captura o salida), y `## Desvíos del ticket` (`ninguno`, o qué se hizo distinto y por qué).
- Un PR de orquestación (este contrato, scripts, ADRs) no lleva `Closes #`: su cuerpo dice qué se pidió y qué criterios cumple.
- El cuerpo de un PR o de un review se manda con `--body-file`, nunca por tubería: la consola de Windows rompe los acentos.
- Antes de commitear, leé `CODING_STANDARDS.md` y verificá tu cambio contra él.
- Los implementadores no editan `GLOSSARY.md` ni `docs/adr/`: lo proponen en el cuerpo del PR bajo `## Propuesta para GLOSSARY.md` o `## Propuesta de ADR`, y lo integra `main`.
- Si el diff proyecta más de 700 líneas, pará y avisá en el issue antes de seguir.

### Dónde vive cada regla

Cada regla del repo vive en un solo archivo; los demás apuntan a ella sin copiarla.

- **Mecánica** (la puede verificar una herramienta: formato de commits, secretos, tipos, lint): vive en la CI, con un hook local como aviso temprano. Cuenta la CI, porque un hook se saltea con `--no-verify`. Sale de `AGENTS.md` solo cuando el chequeo existe y se lo vio fallar con un caso malo.
- **De juicio sobre cómo se escribe el código**: vive en `CODING_STANDARDS.md`.
- **De producto o privacidad** (cambia qué se implementa): vive en `AGENTS.md`.

### Review

El review que cuenta es el cruzado. `/code-review` dentro de `implement`, y el review RDD de gentle-ai si alguien lo prende, son autochequeos del autor y no lo reemplazan.

Se revisa en tres ejes: **Standards** (el código cumple `CODING_STANDARDS.md` y `AGENTS.md`, y usa el vocabulario de `GLOSSARY.md`), **Spec** (hace lo que pide el issue, incluidos sus modos de falla; un PR de orquestación se mide contra su cuerpo) y **Modos de falla** (los de la lista del ticket, solo lo que el diff introduce o toca). La Evidencia se verifica, no se cree: abrí cada test de la tabla y comprobá que afirme lo que dice su criterio. Elegí uno de los tests nuevos y comprobá que falle sin el cambio: devolvé los archivos de código del diff (no los tests) a `origin/<ramaBase>` con `git checkout origin/<ramaBase> -- <archivos>`, corré ese test, comprobá que falla en una aserción y no en un import, y restaurá con `git checkout HEAD -- .`.

Bloquean: en Spec y Modos de falla, un criterio o un modo de falla del issue que el diff no cumple o no prueba; en Standards, solo una regla escrita en `CODING_STANDARDS.md` o en `AGENTS.md`, y el hallazgo cita archivo y línea tal como están en el commit revisado. No bloquean: los code smells de la base de `code-review` (van a `## SUGERENCIAS`), lo que digan otros documentos, una regla mecánica que ya tiene chequeo en la CI (si falla, la CI queda en rojo y la condición de merge ya frena el PR), ni un problema que ya estaba y el diff no toca ni empeora. Cada bloqueo dice si lo **introduce** o lo **empeora** el diff, y si su evidencia es **concreta** (una línea, un test que falla) o **inferida** (en ese caso, qué habría que correr para confirmarlo).

Escribí el review en un archivo UTF-8 y publicalo con `gh pr review <n> --comment --body-file <archivo>`. No apruebes, no mergees y no arregles el código. El formato es este, sin listas de lo que está bien:

```
Revisor: <agente>
Commit: <sha>

## BLOQUEA
1. `archivo:línea` (introducido|empeorado, concreta|inferida): el problema en una frase. Cómo se reproduce o qué criterio incumple. El arreglo, en una línea.

## SUGERENCIAS
(como mucho tres, una línea cada una)
```

Sin bloqueos, `## BLOQUEA` dice `nada`: así se distingue un review limpio de uno que no se corrió. Si el repo no tiene CI, corré la suite completa en tu worktree y agregá debajo de `Revisor:` la línea `Suite: <comando> en verde`. Si el diff es una puerta de una vía y el `## Merge Danger` del PR dice otra cosa, decilo en `## SUGERENCIAS`.

### Skills de Matt

| Situación | Skill |
|---|---|
| Implementar un ticket | `implement` (corre `tdd` y `code-review` por dentro) |
| Escribir el cuerpo de un PR | `pr` |
| Revisar un PR ajeno | `code-review`, con los ejes de arriba |
| Un bug difícil o una regresión de performance | `diagnosing-bugs` |
| Dudar de un modelo de estado o de una UI | `prototype` |
| Vocabulario del dominio o un ADR | `domain-modeling` |
| La interfaz de un módulo o dónde va un seam | `codebase-design` |
| Un paso que solo puede hacer un humano | `wizard` |

En Claude se invocan con `/mattpocock-skills:<skill>`, con el slash al principio del mensaje. En agy y codex se piden en prosa. `to-spec`, `to-tickets`, `wayfinder`, `triage`, `implement-spec`, `retro` y `ask-matt` solo las puede disparar el humano. Si una invocación no toma, abrí el `SKILL.md` por ruta y seguilo.

### Avances

Antes de una tarea larga, decí en una línea qué vas a hacer. Al terminar, cerrá con un resumen que se entienda solo: qué hiciste, qué encontraste y qué necesitás del humano.
