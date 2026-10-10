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

Cuando `modo` es `"un-agente"` no hay workers: la misma sesión planifica e implementa, y los pasos de despacho de este contrato no aplican. Con una spec que ya tiene tickets, proponé `implement-spec` (la dispara el humano): implementa la frontera de tickets con subagentes y deja todo en una rama de integración. El review que cuenta lo hace igual un contexto distinto del que escribió el código: un subagente de contexto limpio, de otra familia de modelos si hay una disponible, con el mismo formato `## BLOQUEA` / `## SUGERENCIAS` y antes de mergear. La sesión de `main` ejecuta `orca-stack brief-revision <pr> --modelo <modelo>`, le da al subagente la ruta del brief impresa por el comando. El comando imprime también la ruta de un archivo UTF-8 fuera del worktree, `~/orca/briefs/<repo>-revision-<pr>-subagente.review.md`; el subagente escribe allí el cuerpo del review. Después publica ese archivo con `gh pr review <n> --comment --body-file <file>` y remueve el worktree descartable con `git worktree remove <path>` (es detached y no tiene rama que borrar). El review mantiene las primeras líneas `Revisor: subagente (<modelo>)` y `Commit: <sha>`; la línea `Implementador:` del PR nombra al agente de esa sesión. Si `review` es `"humano"`, el review lo hace el humano y `main` solo registra su veredicto con las líneas `Revisor: humano` y `Commit: <sha>`. Sin un review hecho por otro contexto no se mergea, porque quien escribió el código comparte con él todos sus puntos ciegos.

### Permisos

Sin preguntar: crear ramas, commitear, pushear, abrir PRs, comentar y etiquetar issues, despachar, elegir revisor y, en `main`, mergear cuando se cumple la condición de merge. Se hace y después se cuenta.

Se pregunta: lo irreversible (reescribir historia, force push, borrar ramas o issues, tocar algo ya publicado), gastar plata, credenciales, mensajes a terceros y cambios al stack global. Si Pi discrepa en algo material, se le muestran al humano las dos posturas con sus razones.

Un worktree terminado se marca terminado; no se remueve, salvo el descartable detached creado por `brief-revision`, que `main` remueve después de publicar el review. `orca worktree rm` borra también la rama local, aunque tenga commits que no están en ningún otro lado: remové un worktree solo si el humano lo pide y `git branch --no-merged origin/<ramaBase>` no lista su rama.

Después de una llamada rechazada o interrumpida, revisá sus efectos (`orca worktree ps --json`, `git status`, `gh pr view`) antes de intentar lo mismo por otro camino: el despacho pudo haber salido igual.

### Ciclo de `main`

1. Una idea nueva o ambigua se trabaja con `grilling`, `to-spec` y `to-tickets`. Para cada story, pedí ejemplos concretos de lo que debería pasar y al menos un ejemplo negativo: cuándo debería rechazar o negarse. Esas skills las dispara el humano: proponé cuál corresponde y esperá.
2. Cada ticket lleva criterios de aceptación y una sección `## Reglas`: reglas numeradas que nombran sus ejemplos, bordes y errores. Cuando el cliente encuentra un problema, `main` lo clasifica como `requisito`, `integración`, `borde` o `bug` y aplica al issue una única etiqueta de clase (`cliente-requisito`, `cliente-integracion`, `cliente-borde` o `cliente-bug`). El ticket que corrige un problema encontrado por el cliente incluye en `## Reglas` una regla que lo reproduce con el ejemplo del cliente, etiquetada `cliente` y con la cita o ruta de su fuente. Si el cliente vuelve a reportar el mismo problema, vinculá el reporte al ticket existente en vez de abrir un duplicado; no lo cuentes otra vez. Si el cliente no dio un ejemplo reproducible, incluí la regla como `inferido` y agregala a la agenda de la próxima llamada con el cliente para confirmarla. Cada valor esperado se etiqueta `cliente` (con la cita o la ruta del artefacto fuente, como un email real, una captura de planilla o una fila de investigación) o `inferido`. Los valores `inferido` van a la agenda de la próxima llamada con el cliente y se marcan en el guion de demo hasta que el cliente los confirme. La lista genérica —qué pasa si falla o no responde una llamada externa, si algo falla entre dos escrituras, si llega null o vacío, o si se llama dos veces o en paralelo— es una checklist para preguntarte al escribir las reglas; solo las preguntas que aplican a ese ticket se convierten en reglas. `## Reglas` reemplaza a `## Modos de falla` como sección requerida; los tickets existentes con el formato anterior siguen siendo válidos. Incluí también `## ADRs que aplican`, `UNKNOWN / MUST VERIFY` para lo que no se sabe de una API externa, y los bloqueantes como dependencias nativas de GitHub. Los riesgos que conocés van al ticket, no al review: así el implementador los prueba en vez de enterarse por un rebote. Si a un ticket le faltan secciones, completalas vos editando el issue antes de despacharlo; si para completarlas hace falta una decisión de producto, preguntásela al humano.
3. Trabajás la **frontera**: los tickets abiertos, sin bloqueantes abiertos, sin assignee, sin `needs-info` y que no son paraguas (sin sub-issues). Leé cada issue con `gh issue view <n> --comments`: los comentarios dicen si sigue vivo, y el cuerpo de un ticket parqueado parece vigente.
4. Despachá la frontera como una **tanda** con `orca-stack despachar <n> <agente>`, un ticket por comando (ver "Despacho"). `despachar` asigna el issue antes de crear nada; no lo asignes a mano: el assignee es el cerrojo que evita despachar dos veces. Un issue que ya tiene assignee está tomado aunque el assignee sea tu propia cuenta, porque todas las sesiones y los workers usan la misma cuenta de `gh`. Por la misma razón, en cada repo trabaja una sola sesión de `main`.
5. Vigilá la tanda con un solo Monitor de fondo sobre el estado de sus PRs (`gh pr list --json number,headRefName,reviewDecision,statusCheckRollup`), no uno por worker. Antes de rearmarlo, matá el anterior: si sigue vivo, le roba los eventos al nuevo.
6. Con un PR nuevo, despachá el review con `orca-stack revisar <pr> <agente>` a un agente que no sea el autor. Si el diff toca una ruta de `riesgo` o el revisor marcó puerta de una vía en `## Merge Danger`, despachá también un segundo review a pi. Si el PR lo escribió pi, los dos reviews van a agentes de dos familias de modelo distintas que no sean la de pi (Claude): claude no cuenta, y un agente cuyo modelo no tiene una familia reconocida tampoco. Cuando falta uno, el deny de `puente-gentle` dice qué agente despachar según `agentes.usa`, los bloqueos y `preguntarAntes`. `puente-gentle` no deja mergear un PR de `riesgo` sin esos reviews.
7. Mergeá solo si se cumplen estas cosas, verificadas con `gh pr view <n> --comments` y `gh pr checks <n>`: (a) hay un comentario de review con `## BLOQUEA` en `nada` y su línea `Revisor:` nombra un agente distinto del de la línea `Implementador:` del PR, o, como alternativa a ese review limpio cuando el PR rebotó, un comentario publicado por `main` con `--body-file` y la línea `Verificado por main: hallazgos <n,…> corregidos en <sha>` (rebote mecánico, ver el paso 8) o, para cada hallazgo que siga en pie después de la segunda ronda, una línea `Decidido por main: <hallazgo> — <razón>`; (b) esos comentarios llevan una línea `Commit: <sha>` igual al `headRefOid` que muestra `gh pr view <n> --json headRefOid`: un review limpio de un commit anterior no cuenta, porque aprobó otro código; (c) la CI está en verde o, si el repo no tiene CI, el review dice que el revisor corrió la suite completa en verde; solo en un repo sin CI, después de un rebote, el comentario de `main` lleva también su propia línea `Suite: <comando> en verde`, corrida sobre ese mismo commit; (d) si hubo segundo review de pi (paso 6), o los dos reviews de un PR de pi, también está limpio. En un PR que toca `riesgo`, los reviews del paso 6 son siempre sobre el `headRefOid` (`Verificado por main` no los reemplaza), y un bloqueo sobre ese commit no se salda con `Decidido por main`: lo corrige el autor y se pide otro review, o lo decide el humano. Además, `merge` tiene que decir que `main` mergea sola; si no, le pedís el merge al humano. Si falta algo, no mergeás: despachás lo que falte. Si `gh pr merge` se niega porque la rama del PR está atrás de `ramaBase` (pasa cuando `ramaBase` está protegida y exige ramas al día), corré `gh pr update-branch <n>`, esperá la CI sobre el head nuevo y mergeá; no busques otra forma de rodearlo. Ese commit solo trae `ramaBase`, así que los comentarios de (a) siguen contando con el `Commit:` del commit anterior solo si el head nuevo es un merge hecho por GitHub: su committer es `web-flow`, su firma está verificada y su primer padre es ese commit. Lo comprobás con `gh api repos/<owner>/<repo>/commits/<headRefOid> --jq '{committer: .committer.login, verified: .commit.verification.verified, parents: [.parents[].sha]}'`, que tiene que mostrar `web-flow`, `true` y el commit revisado primero en `parents` (el chequeo vale para github.com). Un merge pusheado a mano no cuenta aunque su primer padre sea el commit revisado: el review tiene que ser sobre el `headRefOid`, como siempre. En un PR que toca `riesgo`, los reviews del paso 6 se piden de nuevo sobre el head nuevo. Con esa protección, los merges de una tanda van de a uno.
8. Un PR rebota una sola vez. Si el autor ya salió y hay bloqueos sobre el head actual, relanzalo en su worktree existente con `orca-stack rebote <pr>`; el comando publica `Rebote: <sha>` solo después de iniciar al autor. La segunda ronda lee solo el delta. Si el rebote fue mecánico (idioma, un nombre, un test que faltaba), el autor lo corrige y vos verificás el arreglo leyendo `gh pr diff` contra los hallazgos, sin pedir otro review; nunca lo arreglás vos. Dejás constancia con un comentario tuyo que lleve `Verificado por main: hallazgos <n,…> corregidos en <sha>` y `Commit: <sha>`. Si corrés la suite (paso 7 (c)), ese `Commit:` es el `git rev-parse HEAD` del checkout donde la corriste, tomado antes de correrla con `git status --porcelain` vacío, y no lo volvés a leer de `gh` al escribir el comentario: si el autor pushea durante la corrida, el paso 7 (b) frena el merge. Un bloqueo `inferido` podés mandarlo a refutar antes de rebotar. Lo que siga en pie después de la segunda ronda lo decidís vos, y lo dejás escrito con una línea `Decidido por main: <hallazgo> — <razón>` por hallazgo, más `Commit: <sha>`.
9. Después del merge: si la rama base no es la rama por defecto del repo, `Closes #` no cierra el issue y lo cerrás a mano. Integrá lo que el PR propuso bajo `## Propuesta para GLOSSARY.md` (o `## Propuesta para CONTEXT.md`, en un PR anterior al renombre) o `## Propuesta de ADR` (si `ramaBase` está protegida, en un PR de orquestación tuyo y no con un push directo a `ramaBase`, porque la protección lo rechaza), marcá el worktree como terminado y desplegá solo si `despliegue` dice cómo; después de cada deploy, también los que cambian solo configuración, ejecutá `despliegue.pruebaFuncional`: un recorrido real de punta a punta que atraviese los mismos controles que una llamada normal y llegue a un destino permitido. Si la verificación falla, avisale al humano de inmediato y no sigas como si hubiera salido bien. Con `{ "despues": false }` no se despliega ni se verifica.
10. La tanda se cierra cuando cada uno de sus PRs está mergeado o decidido. Al cerrarla, proponele al humano `retro` con el conteo de issues etiquetados y creados desde la fecha de corte registrada en la retro anterior, separados por clase de problema encontrado por el cliente (`cliente-requisito`, `cliente-integracion`, `cliente-borde`, `cliente-bug`); registrá la fecha de corte de esta retro para la siguiente. Contá issues, no reportes duplicados. Si todavía no hubo retro, el conteo empieza con el primer issue etiquetado. Si esta sesión ya cerró una tanda antes, proponé también un `handoff` a una sesión nueva: una sesión de `main` larga se queda sin contexto y sin cuota.

### Verificación

Corré la verificación con los comandos de `verificacion` (`suite` y `typecheck`), sin cambiarles los flags. Si un comando puede tardar más de diez minutos, ponele un límite de tiempo; si se pasa, avisale al humano con lo último que mostró, en vez de quedarte esperando en segundo plano.

### Despacho

`orca-stack despachar <n> <agente>` crea el worktree con `orca worktree create` desde `origin/<ramaBase>`, escribe el brief del ticket desde la plantilla (número de issue, rama, agente, los comandos de `verificacion` y cómo abrir el PR), comprueba que cada ruta que cita el brief exista en el worktree, lanza el agente en una terminal de Orca y le manda el brief. Se niega si la rama o el worktree ya tienen un agente vivo. `orca-stack revisar <pr> <agente>` hace lo mismo para un review, en un worktree `revision-<pr>-<agente>` parado en el commit del PR. Agregá lo propio de un ticket con `--nota "<texto>"`; si citás un archivo, que sea una ruta del repo y no algo que `.gitignore` deja afuera del worktree.

El despacho es un handoff: el worker trabaja solo y no se lo supervisa con `orca orchestration`, salvo que el humano pida supervisar un Run. Si un comando falla, mostrá su error al humano; no armes el despacho a mano.

### PRs

- El cuerpo sigue la skill `pr`: `## Summary` con la vista más chica que deje claro el cambio, `## Evidencia` y `## Merge Danger` (puerta de una o dos vías y blast radius).
- Un PR de ticket lleva `Closes #<n>`, la línea `Implementador: <agente>` y `## Evidencia` con una fila por cada regla (o, en tickets legacy, por cada criterio de aceptación y modo de falla usado como RED) y por cada entrada pública tocada (la definición está en el brief del ticket que arma `orca-stack despachar`). Cada fila incluye el nombre exacto del test y la línea de la corrida en verde, o cómo se verificó si no hay test. Si no se toca ninguna entrada pública existente, se indica `none touched` sin una fila de relleno. Agregá antes y después cuando el cambio se ve (captura o salida), y `## Desvíos del ticket` (`ninguno`, o qué se hizo distinto y por qué).
- Un PR de orquestación (este contrato, scripts, ADRs) no lleva `Closes #`: su cuerpo dice qué se pidió y qué criterios cumple.
- El cuerpo de un PR o de un review se manda con `--body-file`, nunca por tubería: la consola de Windows rompe los acentos.
- Si existe `CODING_STANDARDS.md`, leelo antes de commitear y verificá tu cambio contra él.
- Los implementadores no editan `GLOSSARY.md` ni `docs/adr/`: lo proponen en el cuerpo del PR bajo `## Propuesta para GLOSSARY.md` o `## Propuesta de ADR`, y lo integra `main`.
- Si el diff proyecta más de 700 líneas, pará y avisá en el issue antes de seguir.

### Dónde vive cada regla

Cada regla del repo vive en un solo archivo; los demás apuntan a ella sin copiarla.

- **Mecánica** (la puede verificar una herramienta: formato de commits, secretos, tipos, lint): vive en la CI, con un hook local como aviso temprano. Cuenta la CI, porque un hook se saltea con `--no-verify`. Sale de `AGENTS.md` solo cuando el chequeo existe y se lo vio fallar con un caso malo.
- **De juicio sobre cómo se escribe el código**: vive en `CODING_STANDARDS.md`, si existe.
- **De producto o privacidad** (cambia qué se implementa): vive en `AGENTS.md`.

### Review

El review que cuenta es el cruzado. `/code-review` dentro de `implement`, y el review RDD de gentle-ai si alguien lo prende, son autochequeos del autor y no lo reemplazan.

Los ejes, los tests derivados, la comprobación de que un test del autor falle sin el cambio y la limpieza de tests están en el brief de revisión que arman `orca-stack revisar` y `orca-stack brief-revision`.

Bloquean: en Spec y Modos de falla, un criterio o modo de falla del issue que el diff no cumple o no prueba; en Standards, solo una regla escrita en `CODING_STANDARDS.md` (si existe) o en `AGENTS.md`. No bloquean los code smells (van a `## SUGERENCIAS`), lo que digan otros documentos, una regla mecánica que ya tiene chequeo en la CI, ni los problemas que el diff no toca ni empeora.

Cada bloqueo dice si lo **introduce** o lo **empeora**, y si su evidencia es **concreta** o **inferida**. Se etiqueta `implementación` si el código rompe una regla clara, o `interpretación` si el autor y el reviewer leen la regla de manera distinta; los de interpretación se envían al humano y `main` no los resuelve con `Decidido por main`.

El formato es este, sin listas de lo que está bien:

```
Revisor: <agente>
Commit: <sha>

## BLOQUEA
1. `archivo:línea` (introducido|empeorado, concreta|inferida, implementación|interpretación): el problema en una frase. Cómo se reproduce o qué criterio incumple. Para un test del reviewer, incluí su código. El arreglo, en una línea.

## SUGERENCIAS
(como mucho tres, una línea cada una)
```

Sin bloqueos, `## BLOQUEA` dice `nada`. Si el repo no tiene CI, corré la suite completa en tu worktree y agregá debajo de `Revisor:` la línea `Suite: <comando> en verde`. Si el diff es una puerta de una vía y el `## Merge Danger` del PR dice otra cosa, decilo en `## SUGERENCIAS`.

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
