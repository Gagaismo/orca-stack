# Manual de uso de orca-stack

Este manual cuenta cómo se usa orca-stack día a día: qué hace cada comando, mod y skill, cuándo conviene usarlo y cuándo no, qué pasa en los bordes y cómo se opera y se arregla. No repite el setup: para instalar y configurar un proyecto, seguí la [guía de setup](guia-setup.md). Para el detalle de cada instalación y de cada clave de configuración, el [README](../README.md).

Versión de referencia: `orca-stack v0.11.0` más lo que hay en `main`. Todo lo que se mergeó después de ese tag lleva la marca **`[solo en main]`**: todavía no está publicado en un release, así que con `npx github:Gagaismo/orca-stack#v0.11.0` no lo vas a tener. Para usarlo, corré el CLI desde un checkout de `main` (`node bin/orca-stack.mjs <comando>`) o esperá al próximo release.

## Contenido

1. [Qué es y para qué sirve](#1-qué-es-y-para-qué-sirve)
2. [Los roles: `main`, worker y revisor](#2-los-roles-main-worker-y-revisor)
3. [Casos de uso: dónde sí y dónde no](#3-casos-de-uso-dónde-sí-y-dónde-no)
4. [Funcionalidades](#4-funcionalidades)
   - [4.1 Comandos del CLI](#41-comandos-del-cli)
   - [4.2 El ciclo de una tanda](#42-el-ciclo-de-una-tanda)
   - [4.3 Los mods de Claude Code](#43-los-mods-de-claude-code)
   - [4.4 Las skills que instala](#44-las-skills-que-instala)
   - [4.5 Configuración en tres capas](#45-configuración-en-tres-capas)
   - [4.6 Marchas](#46-marchas)
   - [4.7 Modos `multiagente` y `un-agente`](#47-modos-multiagente-y-un-agente)
   - [4.8 Review, rebote y merge](#48-review-rebote-y-merge)
   - [4.9 Arena y swarm](#49-arena-y-swarm)
   - [4.10 El chequeo de `## Evidencia` en CI](#410-el-chequeo-de--evidencia-en-ci-solo-en-main)
5. [Casos borde](#5-casos-borde)
6. [Manejo: operación y problemas](#6-manejo-operación-y-problemas)
7. [Qué hay solo en `main`](#7-qué-hay-solo-en-main)

---

## 1. Qué es y para qué sirve

orca-stack instala y mantiene el **stack de agentes** que se usa con [Orca](https://github.com/stablyai/orca): una política de trabajo (el contrato), skills propias, wrappers de proveedores (`claude`, `codex`, `agy`), Pi con Gentle Shell y ocho mods de Claude Code. Además trae comandos para despachar tickets a agentes, pedir reviews, relanzar autores y vigilar una tanda de PRs.

Lo esencial en tres líneas:

- **Una sesión orquesta** (`main`): planifica, despacha, vigila, revisa que se cumplan las condiciones y mergea. No implementa tickets.
- **Los workers implementan**, cada uno en su worktree, con un brief generado desde el ticket.
- **Un agente distinto revisa** (o un subagente de contexto limpio en modo `un-agente`), y la CI es la que cuenta para lo mecánico.

El contrato completo vive en `assets/stack/CONTRATO.md` y `init` lo copia al `AGENTS.md` de cada proyecto. Este manual explica cómo se usa; si hay una diferencia, manda el contrato.

## 2. Los roles: `main`, worker y revisor

El rol lo da el **checkout**, no el agente. Se compara `git rev-parse --git-dir` con `git rev-parse --git-common-dir`:

| Situación | Rol | Qué hace |
| --- | --- | --- |
| Iguales y en la rama `ramaBase` | Sesión de **`main`** | Orquesta, despacha, mergea, integra `GLOSSARY.md` y los ADRs. Nunca implementa tickets ni revisa PRs |
| Iguales pero en otra rama | `main`, sin mergear | Igual que `main`, pero no mergea hasta volver a `ramaBase` |
| Distintos, nombre del worktree empieza con `revision` | **Revisor** | Revisa un PR con el formato `## BLOQUEA` / `## SUGERENCIAS` |
| Distintos, cualquier otro nombre | **Worker** | Implementa el ticket de su brief, de punta a punta |

Reglas que sostienen todo lo demás:

- Una sola sesión de `main` por repo: todas las sesiones y los workers usan la misma cuenta de `gh`, así que el assignee de un issue es el cerrojo contra despachar dos veces.
- Nadie revisa su propio PR, y un worktree de ticket nunca revisa.
- Solo `main` ofrece el setup (`orca-setup`); un worker que lo encuentra pendiente sigue con su brief.

## 3. Casos de uso: dónde sí y dónde no

### Dónde sí conviene

| Situación | Por qué |
| --- | --- |
| Un repo en GitHub con tickets que se pueden escribir con reglas verificables, trabajado con Orca | Es el caso para el que está hecho: `despachar`, `revisar`, `rebote` y `vigilar` necesitan `gh`, Orca y issues |
| Varios tickets independientes en paralelo (una tanda) | Cada worker tiene su worktree y su brief; `vigilar` te resume la tanda con un solo Monitor |
| Querés que lo escrito por un agente lo revise otro de otra familia de modelos | El contrato y `revisar` lo imponen; `puente-gentle` frena merges de rutas de `riesgo` sin esos reviews |
| Trabajás con más de un agente (`claude`, `agy`, `codex`, `codex-cc`, `pi`) y necesitás controlar cuota y a quién se despacha | `agentes.usa`, `agentes.preguntarAntes` y `guardia.bloquear` |
| Trabajás solo con un agente pero querés el mismo método (ODD, tickets con `## Reglas`, review de contexto limpio) | Modo `un-agente` |
| Querés que un cambio de proceso quede en un PR y no en la cabeza de alguien | El contrato viaja en `AGENTS.md` y lo lee cualquier agente |

### Dónde no

| Situación | Por qué no |
| --- | --- |
| Un repo chico o descartable, de una sola vez | El setup (`orca-setup`, `AGENTS.md`, `.orca-stack*.json`) cuesta más que el trabajo. Un agente suelto alcanza |
| Un repo sin GitHub | `despachar` lee y asigna issues con `gh`; `revisar`, `rebote` y `vigilar` leen PRs con `gh`. El contrato da por hecho issues, PRs y `Closes #` |
| Sin Orca instalado | El despacho crea worktrees con `orca worktree create` y lanza el agente en una terminal de Orca. `global` solo detecta Orca, no lo instala |
| Una tarea exploratoria sin criterio de aceptación | El método parte de tickets con `## Reglas`; sin reglas no hay qué probar ni qué revisar |
| Si necesitás supervisar cada paso de cada worker | El despacho es un handoff: el worker trabaja solo y `main` no lee sus terminales |
| Equipos que no quieren que un bloque de contrato entre en su `AGENTS.md` | `init` lo escribe ahí; sin él, la metodología no llega al proyecto (`global` no instala texto de metodología) |

## 4. Funcionalidades

### 4.1 Comandos del CLI

`orca-stack <comando> [opciones]`, o `npx github:Gagaismo/orca-stack#v0.11.0 <comando>`. `-h` / `--help` funciona en cada comando y `-v` imprime la versión. Un comando desconocido o una opción desconocida salen con código 2; un error del comando, con código 1.

| Comando | Para qué | Dónde se corre |
| --- | --- | --- |
| `global` | Instalación a nivel usuario, idempotente, con respaldo | Cualquier carpeta |
| `init` | Cablea el proyecto actual (`AGENTS.md`, `CLAUDE.md`, `.orca-stack*.json`) | Dentro de un repo git |
| `doctor` | Verifica la instalación con sondeos reales | Idealmente la raíz del proyecto |
| `remove` | Deshace lo que instaló `global` | Cualquier carpeta |
| `despachar` | Despacha un ticket a un agente | Checkout principal (sesión de `main`) |
| `revisar` | Despacha el review de un PR a otro agente | Checkout principal |
| `rebote` | Relanza al autor de un PR bloqueado, con CI roja o en conflicto con la base | Checkout principal |
| `brief-revision` | Worktree y brief de review para un subagente (modo `un-agente`) | Checkout principal |
| `consultas` | Avisa comentarios `Consulta:` nuevos | Checkout principal |
| `avisar` | Le toca el timbre a un worker con el turno en curso | Checkout principal |
| `vigilar` | Monitor de una tanda de PRs `[solo en main]` | Checkout principal |
| `sesiones` | Lista sesiones recientes de Claude, Pi y agy (entrada de `/retro`) | Cualquier carpeta |

**Opciones generales.** `--dry-run` muestra cada acción sin escribir nada (vale en `global`, `init`, `remove`, `despachar`, `revisar`, `rebote`, `brief-revision`, `consultas`, `avisar` y `vigilar`). `--help` por comando da el detalle.

#### `global`

```bash
orca-stack global --dry-run          # mirá qué va a hacer
orca-stack global --humano "Ana"     # cómo te nombran los mods
orca-stack global --skip-pi          # sin tocar Pi
orca-stack global --force            # reemplaza archivos tuyos que se llamen igual (con respaldo)
orca-stack global --limpiar-sdd      # respalda y mueve restos SDD conocidos
```

Instala política, wrappers, skills, mods, Pi, el comando `orca-stack` y el registro `~/.orca-stack/state.json`. Cada archivo que modifica se respalda antes en `~/.orca-stack/backups/<fecha>/`. Una segunda corrida no cambia nada ni genera respaldos nuevos. El detalle de qué va dónde está en el [README](../README.md#qué-instala).

#### `init`

```bash
cd mi-proyecto
orca-stack init --dry-run
orca-stack init
```

Agrega el bloque `<!-- orca-stack:begin -->` … `<!-- orca-stack:end -->` a `AGENTS.md` (con el contrato completo) y uno corto con `@AGENTS.md` a `CLAUDE.md`; crea `.orca-stack.json` y `.orca-stack.local.json` si faltan y agrega este último a `.gitignore`. No pisa configuración existente.

#### `doctor`

```bash
orca-stack doctor            # con sondeos de red
orca-stack doctor --offline  # sin login de Pi ni gh auth status
orca-stack doctor --skip-pi
```

Sale con código 1 si hay una falla (`✖`); los avisos (`⚠`) no cambian el código. Mirá la sección [6](#6-manejo-operación-y-problemas) para leer sus resultados.

#### `remove`

```bash
orca-stack remove --dry-run
orca-stack remove            # deshace global
orca-stack remove --with-pi  # además desinstala lo de Pi que instaló global
```

Borra lo que `global` creó, restaura lo que había reemplazado, saca las entradas de `CLAUDE_CODE_PLUGIN_DIRS` y deja los respaldos. Sin `~/.orca-stack/state.json` dice que no hay nada que deshacer. Si editaste `~/.orca-stack/config.json`, se conserva.

#### `despachar`

```bash
orca-stack despachar 12 agy --dry-run
orca-stack despachar 12 agy
orca-stack despachar 12 codex-cc --confirmado            # el humano dijo que sí
orca-stack despachar 12 pi --perfil-pi opus-haiku
orca-stack despachar 12 claude --nota "Leé docs/adr/0007 antes de tocar el parser."
```

Agentes válidos: `claude`, `agy`, `codex`, `codex-cc`, `pi`. Orden de lo que hace:

1. Se niega si estás en un worktree, si el setup está pendiente, si `modo` es `un-agente`, si el agente no está en `agentes.usa`, si tiene una regla `guardia.bloquear` vigente, si está en `agentes.preguntarAntes` sin `--confirmado`, si el issue está cerrado o ya tiene assignee, o si ya hay un worktree o un agente vivo para ese ticket.
2. Hace `git fetch origin` y comprueba que **cada ruta que cita el brief exista** en `origin/<ramaBase>` y no esté ignorada por git. Si falta una, aborta sin asignar ni crear nada.
3. Asigna el issue (el assignee es el cerrojo: no lo asignes a mano), crea el worktree con `orca worktree create`, escribe el brief en `~/orca/briefs/`, lanza el agente en una terminal de Orca y le manda el brief.
4. Imprime `Rama: <rama>` con el nombre que devolvió Orca `[solo en main]`.
5. Lee la pantalla tres veces (pausas de 5 segundos, salvo con pi) y falla ante un mensaje de cuota o si el último renglón no vacío volvió al prompt de PowerShell `[solo en main]`.

Con `pi`, `--perfil-pi <nombre>` fija el perfil de modelos de gentle-pi para ese worktree (los perfiles viven en `~/.pi/gentle-ai/profiles.json`); la clave `agentes.pi.perfil` lo fija para todos los despachos a pi y el flag gana.

#### `revisar`

```bash
orca-stack revisar 15 pi --dry-run
orca-stack revisar 15 agy --nota "Mirá con cuidado la migración."
```

Igual que `despachar`, para un review: crea el worktree `revision-<pr>-<agente>` parado en la rama del PR. Se niega si el PR no trae la línea `Implementador: <agente>`, si el revisor es el implementador, o si los dos corren modelos de la misma familia (sale de `agentes.modelos`; pi y claude sí se revisan entre sí).

#### `rebote`

```bash
orca-stack rebote 15 --dry-run
orca-stack rebote 15 --nota "El segundo hallazgo es de interpretación: no lo toques, lo decide el humano."
```

Relanza al autor (línea `Implementador:`) en el worktree existente de la rama del PR. Exige un review bloqueante vigente o checks fallidos sobre el head, un worktree limpio y detenido en ese commit. En un repo sin reviews, el comentario bloqueante puede venir de una consulta confirmada. Si el worktree está limpio y solo está atrás del head (por ejemplo, después de `gh pr update-branch`), lo adelanta con `git merge --ff-only <sha>` y lo dice en una línea; si tiene commits que no están en el head, se niega. Con `--dry-run` igual trae la rama (`git fetch`, que solo toca las referencias remotas) para comprobarlo, pero no adelanta nada. Publica `Rebote: <sha>` (review) y/o `Rebote CI: <sha>` (CI roja); cada contador cuenta SHAs distintos. Un PR en conflicto con la base (`mergeable: CONFLICTING`) también rebota, aunque no tenga bloqueos y su CI esté verde, falte o siga pendiente (GitHub no corre los workflows de `pull_request` mientras hay conflicto): el brief suma una sección `## Merge conflict` con la rama base, los pasos (`git fetch origin`, `git merge origin/<base>`, nunca rebase ni force push), los archivos en conflicto y los commits de la base que los tocaron, y el comando publica `Rebote conflicto: <sha>`. Ese contador es propio: no gasta el rebote de review ni los de CI, y un segundo rebote por conflicto sobre el mismo head se niega. Con la mergeabilidad todavía en cálculo (`UNKNOWN`) se niega y pide repetir; un PR que solo está atrás (`BEHIND`) sin conflicto se niega y apunta a `gh pr update-branch <n>`. Detalle de los rechazos en [Casos borde](#5-casos-borde).

#### `brief-revision`

```bash
orca-stack brief-revision 15 --modelo claude-sonnet-5-5
```

Solo para el modo `un-agente`: crea un worktree detached en el head del PR y un brief UTF-8; imprime además la ruta donde el subagente escribe el review (`~/orca/briefs/<repo>-revision-<pr>-subagente.review.md`). `--modelo` es obligatorio.

#### `consultas`

```bash
orca-stack consultas 42 57
```

Busca comentarios que empiecen con `Consulta:` hechos por la cuenta de GitHub del stack (`gh api user`) en esos issues o PRs, e imprime `consulta nueva en #<n>` una sola vez por comentario. Lo reportado queda en `.git/orca-stack/consultas-reportadas.json`, así que repetirlo no duplica avisos.

#### `avisar`

```bash
orca-stack avisar 42 https://github.com/Gagaismo/orca-stack/issues/42#issuecomment-123 --dry-run
```

El timbre de Proactive: le escribe al worker una sola línea fija, `Message from main: <url>`, mientras su turno sigue en curso. Solo avisa a `claude`; se niega con pi, codex y agy, si el turno ya terminó, si la terminal muestra un shell o un diálogo, si hay más de un agente vivo, o si el comentario no es de la cuenta del stack o no empieza con `Respuesta de main:` o `Respuesta del humano:`. Nunca reintenta: sin recibo de entrega informa la falla.

#### `reanudar`

```bash
orca-stack reanudar 42 https://github.com/Gagaismo/orca-stack/issues/42#issuecomment-123 --dry-run
```

Si Orca todavía muestra el turno en `done`, reanuda el TUI con una sola línea que apunta a la respuesta. Si el agente salió y Orca ya no lo lista ni hay terminal de worker, identifica el mismo agente desde la línea de implementador del brief original y lo relanza en el worktree existente con el brief y la URL al principio. Se niega si Orca informa un estado de agente desconocido o si queda una terminal de worker que no muestra un shell prompt mientras Orca no lista su agente (por ejemplo, Pi headless). También se niega sin enviar el brief si Codex muestra su menú de actualización: elegí una opción en la terminal y relanzá con la misma respuesta de `main`. Rechaza un PR abierto, un worktree sucio, más de un agente vivo o una respuesta que no sea un comentario real de la cuenta del stack o del humano. Si ya intentó usar el mismo comentario, informa la hora registrada y no reenvía ni relanza: comprobá primero el agente y su terminal; si el intento no llegó, publicá una nueva `Respuesta de main:` y usá su URL. `--confirmado` habilita relanzar agentes de `preguntarAntes` solo después del OK humano; `--dry-run` no escribe ni envía nada.

#### `vigilar` `[solo en main]`

```bash
orca-stack vigilar 41 42 43                 # el Monitor de la tanda
orca-stack vigilar 41 42 43 --una-vez       # una consulta y sale
orca-stack vigilar 41 42 --cada 30          # cada 30 segundos (por defecto 60)
orca-stack vigilar 41 42 --consultas        # además corre el chequeo de consultas
orca-stack vigilar --merge-de-main 57       # registra que main está por mergear #57
```

Pensado para correr bajo el Monitor: **stdout lleva solo eventos, uno por línea; todo diagnóstico va a stderr**.

| Evento | Significa |
| --- | --- |
| `pr-abierto #<n> PR #<pr> <sha>` | Un PR del issue, visto por primera vez |
| `ci-verde #<n> PR #<pr> <sha>` | Todos los checks del head terminaron en verde |
| `ci-verde-retenido #<n> PR #<pr> <sha>: <agente> <estado>` | CI está verde, pero el worker sigue vivo; esperá a que termine antes de mergear |
| `ci-roja #<n> PR #<pr> <sha>: ...` | Un check terminado falló o venció; uno por corrida, también si un `gh run rerun --failed` vuelve a fallar en el mismo head |
| `ci-cancelada #<n> PR #<pr> <sha>: <check>=CANCELLED, ...` | No hay una corrida más nueva que reemplace a la cancelada y ninguna falla real previa en la corrida la explica; revisá la causa y re-ejecutá con `gh run rerun <run> --failed` |
| `pr-mergeado #<n> PR #<pr> <sha>` | Se mergeó y `main` no registró ese merge |
| `pr-cerrado #<n> PR #<pr>` | Se cerró sin mergear |
| `vigilar-ciego: <error>` | Tres vueltas seguidas sin poder leer GitHub (una vez por corte; nunca dice "no hay PRs") |
| `tanda-cerrada #<n> #<m>...` | Terminaron todos los items; sale con 0 |

Un PR es del issue por su referencia de cierre, por la rama del worktree de este repo enlazado al issue, o por una línea `Closes #<n>` en su cuerpo; nunca por adivinar el nombre de la rama. Con el PR abierto, `vigilar` sigue leyendo el worker del worktree enlazado al issue o, si no hay uno, el de la rama del PR. Un `ci-verde-retenido` mantiene visible que el autor todavía trabaja; el primer poll después de que termine emite `ci-verde`. Un issue cerrado sin PR cuenta como terminado. Lo emitido queda en `<git-common-dir>/orca-stack/vigilar.json`: si rearmás con los mismos argumentos, retoma sin repetir.

`--merge-de-main <pr>` existe porque todas las sesiones comparten la cuenta de `gh`: un merge de `main` se ve igual que uno del humano. `main` lo corre justo antes de cada `gh pr merge <pr>` (y otra vez tras `gh pr update-branch`); registra el head en `<git-common-dir>/orca-stack/vigilar-merges.json` y un merge de ese head visto dentro de los 30 minutos no emite `pr-mergeado`. Sale sin imprimir nada.

#### `sesiones`

```bash
orca-stack sesiones --desde 2026-10-13 --limite 5
```

Solo lectura. Lista sesiones recientes de Claude Code, Pi y agy (agy necesita Node 22.13 o más nuevo) con herramienta, carpeta, inicio y fin, llamadas, tus mensajes, llamadas con error y resultados de más de 15k caracteres. Por defecto, los últimos 2 días y 10 sesiones. Es la entrada de `/retro`.

### 4.2 El ciclo de una tanda

Resumen del "Ciclo de `main`" del contrato, con el comando de cada paso:

| # | Paso | Comando o regla |
| --- | --- | --- |
| 1 | Idea nueva o ambigua | Skills de Matt: `grilling`, `to-spec`, `to-tickets` (las dispara el humano; `main` propone cuál y espera) |
| 2 | Cada ticket con criterios y `## Reglas` | Reglas numeradas con ejemplos, bordes y errores; cada valor esperado va como `cliente` o `inferido` |
| 3 | Elegir la frontera | Issues abiertos, sin bloqueantes, sin assignee, sin `needs-info`, sin sub-issues. Leer con `gh issue view <n> --json title,body,comments` |
| 4 | Despachar la tanda | `orca-stack despachar <n> <agente>`, un ticket por comando |
| 5 | Vigilar con un solo Monitor | `orca-stack vigilar <n...>` `[solo en main]`; atiende `worker-en-pausa` respondiendo la `Consulta:` donde apareció y corriendo `orca-stack reanudar <issue> <url-del-comentario>`. En Proactive, con `--consultas`. Matá el Monitor anterior antes de rearmarlo |
| 6 | Review de cada PR nuevo | `orca-stack revisar <pr> <agente>`; segundo review de pi si toca `riesgo` |
| 7 | Mergear si se cumple la condición | Ver [4.8](#48-review-rebote-y-merge); antes de cada `gh pr merge`, `orca-stack vigilar --merge-de-main <n>` `[solo en main]` |
| 8 | Rebote | `orca-stack rebote <pr>`; una sola vez por review |
| 9 | Después del merge | Cerrar a mano el issue si la base no es la rama por defecto; integrar propuestas de `GLOSSARY.md` y ADR; desplegar solo si `despliegue` lo dice, y correr `despliegue.pruebaFuncional` |
| 10 | Cerrar la tanda | Proponer `retro` y, si ya cerró una antes, `handoff` a una sesión nueva |

### 4.3 Los mods de Claude Code

Son plugins de Claude Code que `global` deja en `~/.claude/mods/` y activa con `CLAUDE_CODE_PLUGIN_DIRS`. Se cargan **al iniciar la sesión**: después de actualizar, abrí una sesión nueva. Se los puede apagar de a uno con `claude plugin disable <mod>@inline --scope user|local|project`. El nombre de cada plugin es el de su carpeta (`name` en `mods/<mod>/.claude-plugin/plugin.json`), y el README documenta el patrón para `marchas`. Si dudás, `claude plugin list` muestra los nombres de tu instalación.

| Mod | Comando | Cuándo actúa | Cómo se apaga |
| --- | --- | --- | --- |
| `tablero-despacho` | `/tablero` | Abre un tablero de PRs, checks, reviews y worktrees (usa `gh`). Los atajos de despacho aparecen solo si hay `despacho` en la config | Deshabilitar el plugin |
| `guardia-despacho` | — | En cada llamada a Bash o PowerShell: niega `gh pr merge` si el worker de ese PR sigue activo; corrige o rechaza scripts de despacho/revisión según reglas; rechaza `orca worktree rm` y `git worktree remove` si la rama del worktree tiene commits que no están en ningún remoto; pregunta el perfil de pi (diálogo "Perfil Pi") cuando falta `--perfil-pi` | El bloqueo de merge, las reglas de protección de worktrees y perfil de pi están siempre activos; las reglas de `despacho` están apagadas salvo que haya `despacho` |
| `puente-gentle` | `/pi`, `/gentle`, herramienta `consultar_gentle_shell` | En un repo con `.orca-stack.json` o `.orca-stack.local.json`: consulta a Gentle Shell como par. Frena el merge de un PR de más de 400 líneas sin consulta (tema `pr-<n>`) y el de uno que toca `riesgo` sin sus reviews limpios sobre el último commit | Deshabilitar el plugin |
| `bandeja-mensajes` | `/mensajes` | Captura los bloques ` ```mensaje <destinatario> ` que redacta Claude y deja copiarlos o guardarlos | `mensajes.destinatarios` limita los nombres; deshabilitar el plugin |
| `grilling-ok` | — | Responde con un clic (o con `ok`) las preguntas Q1…Qn de un grilling | Deshabilitar el plugin |
| `modo-autonomo` | `/autonomo [meta \| off]` | Instrucción permanente de trabajar hasta la meta (por defecto `producción`) con recordatorio anti-parada acotado (máximo 3). Se apaga solo cuando el agente escribe `[AUTONOMO-LISTO]` | `/autonomo off` |
| `marchas` | `/marcha [lazy\|medium\|proactive]` | Solo en el checkout principal de un repo con `.orca-stack.json` o `.orca-stack.local.json` cuyo contrato incluye `Marchas`. Muestra o cambia la marcha | `claude plugin disable marchas@inline --scope user` (o `local`, o `project`) |
| `reloj-cache` | `/compactar-ya` | Muestra cuánto falta para que venza el caché del prompt (supone 1 hora), avisa 10 minutos antes y ofrece compactar | Deshabilitar el plugin |

`marchas` además ajusta el esfuerzo de cada solicitud de `main` (ver [4.6](#46-marchas)).

### 4.4 Las skills que instala

`global` las deja en `~/.claude/skills/` y `~/.agents/skills/`.

| Skill | Para qué |
| --- | --- |
| `orca-stack-policy` | Aplica la política local: autoridad, contrato de worker, Ponytail, límites de Caveman y rol de Engram |
| `orca-setup` | La sesión de `main` entrevista al humano en una ronda para completar `.orca-stack.json` (`"setup": "completo"`). La ofrece sola cuando falta |
| `ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-help` | Modo "dev perezoso": el cambio más chico que resuelve la tarea; review y auditoría de calidad; ledger de atajos (`shortcut:`); ayuda rápida. Nunca van contra un requisito explícito |
| `arena` | N candidatas en paralelo a la misma tarea, elegir una base e injertar lo mejor de las otras |
| `swarm` | Fan-out de N workers de solo lectura, que se resuelve en un informe |
| `principle-attack-the-premise` | Cuando dos arreglos con la misma premisa fallaron en el mismo gate: cuestionar la premisa antes de escribir otro arreglo |
| `principle-explain-the-number` | Antes de confiar o actuar sobre un número medido: encontrar qué lo limita y descartar que mida otra cosa |
| `principle-make-operations-idempotent` | Al diseñar comandos o loops que corren entre caídas y reintentos: converger al mismo estado final |

No instala las skills de Matt Pocock ni Caveman: ver el [README](../README.md#qué-no-instala-y-por-qué). `to-spec`, `to-tickets`, `wayfinder`, `triage`, `retro` y `ask-matt` solo las puede disparar el humano; en Claude se escriben `/mattpocock-skills:<skill>`.

### 4.5 Configuración en tres capas

Cada capa pisa a la anterior: los objetos se fusionan clave por clave y **una lista reemplaza a la anterior entera**. Excepción: las reglas `guardia.bloquear` de las tres capas se suman; una capa no puede borrar el bloqueo de otra.

| # | Archivo | Se commitea | Para qué |
| --- | --- | --- | --- |
| 1 | `~/.orca-stack/config.json` | No | Personal, por máquina: `humano`, `agentes.modelos`, `agentes.pi.claudeConfigDir`, `agentes.pi.perfil`, `gentle.orchestrator` |
| 2 | `<repo>/.orca-stack.json` | Sí | Reglas del proyecto |
| 3 | `<repo>/.orca-stack.local.json` | No (`init` lo agrega a `.gitignore`) | Locales o sensibles: destinatarios, bloqueos de agentes |

`<repo>` es el checkout principal (se resuelve con `git rev-parse --git-common-dir`), así que una sesión dentro de un worktree lee los archivos del checkout principal.

Claves del contrato: `setup`, `modo`, `ramaBase`, `agentes` (`usa`, `preguntarAntes`), `verificacion` (`suite`, `typecheck`, `cuerpoPR`), `riesgo`, `review`, `merge`, `despliegue`, `idioma`. `cuerpoPR` permite configurar un comando con placeholder `{file}` para pre-validar localmente el cuerpo del PR antes de crearlo; la validación de `## Evidencia` acepta títulos exactos declarados en `test()`/`it()`, describe paths aceptados por su último segmento y patrones de template, exigiendo que solo los nombres de test lleven backticks y las verificaciones sin test vayan en texto plano. Claves de los mods: `humano`, `mensajes.destinatarios`, `despacho.script`, `despacho.revisar`, `guardia.bloquear`, `guardia.modeloClaude`. La tabla completa está en el [README](../README.md#claves) y en la [guía de setup](guia-setup.md#parte-4-configuración-de-los-mods-dónde-va-cada-cosa).

Ejemplo: bloquear a un agente sin cuota hasta una fecha, en `.orca-stack.local.json`:

```json
{
  "guardia": {
    "bloquear": [
      { "agente": "codex", "hasta": "2026-10-29", "motivo": "Codex sin cuota: despachá a claude o agy." }
    ]
  }
}
```

La fecha `hasta` es local, a las 00:00. Mientras no llegue, `despachar`, `revisar` y `rebote` rechazan ese agente con el `motivo`.

#### Reviews de codex con ChatGPT Web, sin cuota de Codex

[codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web) suma los modelos de ChatGPT Web al selector de Codex, con slugs `chatgpt-web/<modelo>`, y los cobra contra los límites de ChatGPT en vez de la cuota de Codex. orca-stack no necesita nada especial: `agentes.modelos` ya separa el modelo con el que codex implementa del modelo con el que revisa. En `~/.orca-stack/config.json`:

```json
{
  "agentes": {
    "modelos": {
      "codex": {
        "implementar": { "modelo": "gpt-6-luna", "esfuerzo": "high" },
        "revisar": { "modelo": "chatgpt-web/gpt-6-sol", "esfuerzo": "high" }
      }
    }
  }
}
```

Con eso, `orca-stack revisar <pr> codex` lanza `--model chatgpt-web/gpt-6-sol -c model_reasoning_effort="high"`, y `despachar` sigue usando `gpt-6-luna`.

Todavía no se probó de punta a punta con orca-stack. El primer `orca-stack revisar <pr> codex` real que publique un review con `Revisor:` y `Commit:` es la prueba; hasta entonces, tomá esta sección como configuración esperada, no como algo verificado.

Antes, una vez y a mano, siguiendo el [Get started del launcher](https://github.com/miuuyy/codex-chatgpt-web#get-started):

1. Instalá el launcher.
2. Iniciá sesión en ChatGPT.
3. Instalá los modelos y reiniciá Codex.
4. Completá el [Full harness](https://github.com/miuuyy/codex-chatgpt-web#full-harness) (MCP) del launcher. El revisor lee archivos y corre la suite; sin el harness, el modelo responde sin herramientas locales.

Bordes:

- La familia sale del último tramo del slug: `chatgpt-web/gpt-6-sol` es `gpt`. Codex sigue sin poder revisar un PR de codex, ni uno de codex-cc si codex-cc corre un GPT.
- Según su arquitectura, el launcher enruta por su daemon local (`openai_base_url`) todas las llamadas de Codex, también las de los modelos nativos. Si el daemon no corre, fallan también los workers de codex. `codex-cc` fija su propio proveedor (`-c model_provider=cc`), así que probablemente siga andando (inferido, sin probar).
- El daemon guarda tu sesión de ChatGPT y le manda el código del repo a ChatGPT Web. Automatizar la web de ChatGPT probablemente va contra los términos de uso de OpenAI (inferido). Pensalo dos veces antes de usarlo con código de un cliente.
- Es automatización no oficial de la web de ChatGPT. Si la web cambia, falla de forma explícita; nunca cambia de modelo por su cuenta. Un pedido de aprobación inesperado del lado de ChatGPT falla cerrado, y un revisor desatendido no puede contestarlo.

### 4.6 Marchas

La marcha fija cuánto explora, delega, consulta y narra `main`. Solo toca la lista cerrada de perillas K1 a K11 de `ORCA-STACK.md`; está por debajo de las instrucciones del proyecto, los ADRs, la spec y el ticket.

| Marcha | Cuándo | Esfuerzo de `main` (mod `marchas`) |
| --- | --- | --- |
| **Lazy** | Solo queda trabajo ya especificado | Máximo `medium`. Un item que deja de estar especificado espera un cambio de marcha |
| **Medium** | Por defecto; cada sesión nueva empieza acá | No lo reescribe |
| **Proactive** | Planificación (grilling, `to-spec`, `to-tickets`) o una tanda que toca `riesgo` | Mínimo `xhigh`; `main` vigila los items en curso y contesta consultas |

- **Solo el humano cambia la marcha**, con `/marcha <lazy|medium|proactive>`. `main` nunca ejecuta `/marcha`: sugiere el cambio en una línea (por ejemplo `Sugiero subir a Proactive para #42 (toca riesgo): /marcha proactive`), como mucho una vez por item y señal.
- Sin un mensaje `Marcha:`, rige Medium. Al cerrar una tanda se propone volver a Medium.
- Un `/effort` manual gana hasta el siguiente cambio de marcha. Elegir en el menú de `/effort` el mismo nivel que ya estaba **no** cuenta como ajuste manual, porque el mod no lo distingue de cerrar el menú `[solo en main]`. Más detalle en `mods/marchas/README.md`.
- En modo autónomo, si solo quedan items esperando un cambio de marcha, `main` cierra sin escribir `[AUTONOMO-LISTO]` y deja `Esperando marcha: <items>`.
- El estado de marcha de una sesión caduca a los 30 días desde el último `/marcha <marcha>`; una sesión retomada con la clave vencida empieza en Medium.

### 4.7 Modos `multiagente` y `un-agente`

| | `multiagente` | `un-agente` |
| --- | --- | --- |
| Quién implementa | Workers despachados por `main` | La misma sesión, con ODD |
| `despachar`, `rebote` | Funcionan | Se niegan: "no hay workers" |
| Review de registro | Otro agente, con `revisar` | Un subagente de contexto limpio (idealmente de otra familia de modelos) o el humano, según `review` |
| Comando clave | `despachar`, `revisar`, `vigilar` | `brief-revision` |

En `un-agente`, `main` ejecuta `brief-revision <pr> --modelo <modelo>`, le da al subagente la ruta del brief, el subagente escribe el review en el archivo que el comando imprime, y `main` lo publica con `gh pr review <n> --comment --body-file <file>` y remueve el worktree detached con `git worktree remove <path>`. Si `review` es `"humano"`, `main` solo registra su veredicto (`Revisor: humano`, `Commit: <sha>`). **Sin un review de otro contexto no se mergea.**

### 4.8 Review, rebote y merge

**Quién revisa.** Por defecto, agy; si agy escribió el PR, codex (o codex-cc si codex no está disponible); si lo escribió codex o codex-cc, agy. Un revisor nunca corre un modelo de la misma familia que el autor. Pi es la excepción (corre sobre Claude y aporta otra metodología) y hace de segundo review en los PRs que tocan `riesgo`. Si el PR lo escribió pi, los dos reviews van a dos familias distintas que no sean la de pi.

**Formato del review** (marcas fijas, no se traducen):

```text
Revisor: <agente>
Commit: <sha>

## BLOQUEA
1. `archivo:línea` (introducido|empeorado, concreta|inferida, implementación|interpretación): el problema. Cómo se reproduce o qué criterio incumple. El arreglo, en una línea.

## SUGERENCIAS
(como mucho tres, una línea cada una)
```

Sin bloqueos, `## BLOQUEA` dice `nada`. Los bloqueos de **interpretación** van al humano; `main` no los resuelve con `Decidido por main`.

**Condición de merge** (la verifica `main` con `gh pr view <n> --json title,body,comments,reviews` y `gh pr checks <n>`):

1. Hay un review con `## BLOQUEA` en `nada` y un `Revisor:` distinto del `Implementador:`; o, tras un rebote mecánico, un comentario de `main` con `Verificado por main: hallazgos <n,…> corregidos en <sha>`; o `Decidido por main: <hallazgo> — <razón>` por cada hallazgo que siga en pie tras la segunda ronda.
2. Esos comentarios llevan `Commit: <sha>` igual al `headRefOid`: un review limpio de un commit anterior no cuenta.
3. CI en verde (o, sin CI, la suite completa en verde dicha por el revisor).
4. Si hubo segundo review de pi, también está limpio.
5. `merge` dice que `main` mergea sola; si no, le pide el merge al humano.

En un PR que toca `riesgo`, los reviews son siempre sobre el `headRefOid`, y un bloqueo sobre ese commit no se salda con `Decidido por main`.

> **Regla de este repo** (`AGENTS.md` del propio orca-stack): hoy no se despachan reviews; `main` mergea con la CI verde y el `## Evidencia` en el cuerpo del PR. Un PR de más de 400 líneas igual requiere consulta a Gentle Shell. Esto es una excepción del repo, no del stack.

**Rebote.** Un PR rebota una vez por review. Para CI roja, `rebote` se niega mientras haya checks pendientes (corrélo de nuevo cuando termine la CI). Los checks se comparan dentro de la corrida más nueva de cada workflow: las filas de una corrida anterior no cancelan ni justifican un rebote; si un check falta en la corrida más nueva, se considera pendiente. Ante un check `CANCELLED`, `rebote` consulta si ya hay una corrida más nueva de ese workflow: si existe, se niega como pendiente y espera; si no, muestra `gh run rerun <run> --failed` para que `main` la re-ejecute. Si la falla es de infraestructura, `main` re-ejecuta el job y no rebota al autor. Después del segundo rebote de CI, si vuelve a fallar, se lo pasa al humano. Después de un rebote por conflicto, el merge commit del autor es un push a mano: las líneas `Commit:` anteriores dejan de contar (paso 7 (b)) y main mergea con un review nuevo sobre el head nuevo o, fuera de `riesgo`, con `Verificado por main` escrito después de leer el diff de la resolución; en un PR que toca `riesgo`, los reviews del paso 6 se piden de nuevo sobre el head nuevo.

**Cuerpo del PR.** Sigue la skill `pr`: `## Summary`, `## Evidencia` y `## Merge Danger`. Un PR de ticket lleva `Closes #<n>`, `Implementador: <agente>` y una fila de `## Evidencia` por cada regla y por cada entrada pública tocada, con el nombre exacto del test y la línea de la corrida en verde. Un PR de orquestación no lleva `Closes #`.

### 4.9 Arena y swarm

| | Arena | Swarm |
| --- | --- | --- |
| Para qué | Elegir entre N candidaturas a un diseño o arreglo, cuando se conoce la causa | Diagnosticar o explorar con N lectores en paralelo |
| Escribe código | Sí, cada candidata en su worktree aislado (`worktree-agent-<id>`) | No: solo lectura, no publica nada |
| Autorización | Siempre el OK del humano (una línea: por qué, N, en qué se diferencian, rúbrica) | Un swarm chico de solo lectura sobre código, issues y PRs no requiere OK, pero nunca se hace en Lazy. Cualquier otro, sí |
| Resultado | `## Arena` en el artefacto; el veredicto del judge es una recomendación y decide el humano | `## Swarm` en el artefacto; no reemplaza CI ni `Verificado por main` |

Antes de cualquier fan-out se comprueba que git ignore `.claude/worktrees/` con `git check-ignore`; si no, no se ejecuta. Ultracode (solo lo activa el humano) autoriza la fan-out propia de `main`, pero nunca la nota de un worker y no sobrevive a un handoff. La arena nunca reemplaza el segundo review ni la consulta a Gentle Shell en una puerta de una vía.

### 4.10 El chequeo de `## Evidencia` en CI `[solo en main]`

`[solo en main]` (PR #202). El job `evidencia` de CI lee el cuerpo actual del PR y comprueba que **cada nombre de test citado en `## Evidencia` exista** en `test/*.test.mjs` o en `mods/*/tests/`; `ci-ok` lo exige. Un PR que cierra un issue necesita además una tabla con columna `Test` y al menos una fila. Se vuelve a correr cuando editás el cuerpo del PR (la CI ahora también escucha el evento `edited`).

Cómo se lee la tabla: busca tablas dentro de `## Evidencia` cuya segunda columna empiece con `Test`; en esa columna toma los textos entre backticks, y en la columna de la corrida los títulos de la forma `` `✔ nombre (12ms)` `` (runner de Node) o `` `(pass) nombre [12ms]` `` (runner de Bun). Se ignoran: los comandos (`npm ...`, `node ...`, `gh ...`, `orca-stack ...`, etc.), las rutas o archivos (`src/cli.mjs`), los bloques de código y los comentarios HTML. Salidas:

- Sin una referencia de cierre a un issue: si no hay nombres de test que comprobar, pasa con "Sin ## Evidencia: nada que comprobar". En cambio, si el PR cierra un issue y no hay una tabla `Test` con filas, falla con `Evidencia: el PR cierra #<n> pero no encuentro en ## Evidencia una tabla con columna Test`.
- Todos existen: `Evidencia OK: <n> nombres de test verificados`.
- Falta alguno: sale con 1 y dice `Evidencia fila <n>: no encuentro el test `<nombre>` en test/ ni mods/*/tests/`.

Para probarlo en local, con el cuerpo en un archivo: `node scripts/check-evidencia.mjs <archivo>`. Ver también la [sección 7](#7-qué-hay-solo-en-main).

## 5. Casos borde

Tomados del código, los tests y el contrato. Cada fila dice qué pasa y qué hacer.

| Caso | Qué pasa | Qué hacer |
| --- | --- | --- |
| Un agente sin cuota | `despachar`, `revisar` y `rebote` rechazan al agente con una regla `guardia.bloquear` vigente y muestran el `motivo`. Si ya se lanzó y la terminal muestra un mensaje de cuota, el comando falla | Agregá la regla `guardia.bloquear` en `.orca-stack.local.json` con la fecha de vuelta y despachá a otro agente |
| Ticket citando una ruta que no existe en `origin/<ramaBase>`, o ignorada por git | `despachar` aborta antes de asignar o crear nada | Citá una ruta versionada o pusheá el archivo |
| El issue ya tiene assignee, incluso si es tu propia cuenta | Está tomado: todas las sesiones usan la misma cuenta | No lo asignes a mano; si es un despacho viejo, revisá `orca worktree ps` |
| Falla algo después de crear el worktree | El mensaje lista lo que quedó (assignee, worktree, brief) y cómo recuperarlo; un reintento lo rechaza el cerrojo | Seguí la lista del mensaje antes de reintentar |
| Llamada rechazada o interrumpida | El despacho pudo haber salido igual | Antes de repetir: `orca worktree ps --json`, `git status`, `gh pr view` |
| La terminal del worker volvió al prompt de PowerShell o muestra cuota | `despachar`/`revisar`/`rebote` fallan tras tres lecturas de pantalla (no detectan prompts de bash ni `cmd.exe`) | Revisá la terminal a mano; el mensaje trae la pantalla |
| Codex pide confiar en la carpeta | Falla con una pista de cómo confiar y sin haber mandado el brief | Seguí la pista (`orca-stack doctor` también la avisa) |
| Un worker que se detuvo sin abrir PR | No hay PR que `vigilar` detecte; el issue queda con assignee y worktree | Mirá el worktree en Orca; no despaches de nuevo (el cerrojo lo rechaza). Releé el brief y decidí con el humano |
| Autor ya salió y hay bloqueos de review | `rebote <pr>` relanza en su worktree y publica `Rebote: <sha>` | Si el worktree no está limpio, o tiene commits que no están en el head del PR, `rebote` se niega; si solo está atrás del head, lo adelanta |
| Hallazgo de `interpretación` | Solo bloquea el rebote por review: va al humano | Pasale las dos lecturas con sus razones; no uses `Decidido por main` |
| CI con un check `CANCELLED` | Si ya hay una corrida más nueva, `rebote` se niega como pendiente; si no, lista los reruns | Esperá a la nueva corrida o, si no existe, corré `gh run rerun <run> --failed` |
| CI con checks pendientes | `rebote` se niega | Esperá a que termine |
| PR en conflicto con la base (`mergeable: CONFLICTING`) | `rebote <pr>` relanza al autor con la sección `## Merge conflict` y publica `Rebote conflicto: <sha>`, aunque no haya bloqueos y la CI esté verde, falte o siga pendiente; un segundo rebote por conflicto sobre el mismo head se niega. Con `UNKNOWN` se niega hasta que GitHub termine de calcular | Repetí si dijo `UNKNOWN`. Al volver, mergeá con un review nuevo sobre el head nuevo o, fuera de `riesgo`, con `Verificado por main` tras leer el diff de la resolución |
| CI roja dos veces | El contrato manda al humano; no se salda con `Decidido por main` | Leé `gh run view --job <job> --log-failed`; si es infra, re-ejecutá |
| PR atrás de `ramaBase` (BEHIND) con la rama protegida | `gh pr merge` se niega | `gh pr update-branch <n>`, esperá la CI del head nuevo, mergeá. El review anterior sigue valiendo solo si el head nuevo es un merge de GitHub (`web-flow`, firma verificada, primer padre el commit revisado). Un merge pusheado a mano no cuenta. En `riesgo`, los reviews se piden de nuevo |
| Dos sesiones de `main` en el mismo repo | Se pisan: el assignee es un cerrojo que ambas ven igual | Una sola sesión de `main` por repo |
| Monitor rearmado | Si el anterior sigue vivo, le roba los eventos al nuevo | Matá el anterior antes de rearmar. Con `vigilar`, rearmar con los mismos argumentos retoma sin repetir eventos `[solo en main]` |
| `main` mergea y el Monitor devuelve su propio merge | Un merge de `main` se ve igual que uno del humano | Correr `vigilar --merge-de-main <n>` antes de cada `gh pr merge` y de nuevo tras `update-branch`; vale 30 minutos `[solo en main]` |
| `vigilar` no puede leer GitHub | Emite `vigilar-ciego: <error>` tras tres vueltas fallidas, una vez por corte | Revisá `gh auth status` y la red; sigue vigilando solo. Un issue ilegible o un cursor que no se puede escribir no lo detienen `[solo en main]` |
| `avisar` con un worker que ya terminó, con pi, codex o agy | Se niega; no hay timbre | La respuesta queda como comentario: pi relee los comentarios antes de su PR |
| Cuerpo de PR o review con acentos desde la consola de Windows | La consola rompe los acentos si el texto viaja por tubería | Mandalo siempre con `--body-file`, nunca por tubería |
| Codex en Windows escribe cada letra acentuada como dos caracteres raros | PowerShell 5.1 lee UTF-8 sin BOM como cp1252 | `global` agrega la regla ASCII a `~/.codex/AGENTS.md`; sumá a mano la línea de `$PROFILE` (ver la [guía de setup](guia-setup.md#codex-en-windows-acentos-rotos)) |
| `gentle-ai sync` reescribió el bloque de `~/.claude/CLAUDE.md` | El bloque vuelve completo y `doctor` lo avisa | Volvé a correr `orca-stack global` |
| `orca worktree rm` o `git worktree remove` sobre una rama con commits sin pushear | `guardia-despacho` lo rechaza (y si no puede resolver la rama, también) | Pusheá la rama, o confirmá con `git branch --no-merged origin/<ramaBase>` que no se pierde nada |
| Una arena dejó ramas `worktree-agent-<id>` | El owner puede borrar las suyas de a una, sin `--force`, si no tienen upstream y la nota de síntesis ya está publicada | `git worktree remove` y después `git branch -D`; nunca por patrón ni con `orca worktree rm` |
| El setup quedó pendiente | `despachar`, `revisar` y `rebote` se niegan | Abrí una sesión de Claude en el checkout principal: `orca-setup` lo ofrece |
| Estás dentro de un worktree y corrés `despachar` | "Esto es un worktree" | Corrélo desde el checkout principal |
| `/effort` cambia el esfuerzo con una marcha activa | Cuenta como ajuste manual solo si abriste el menú o corriste `/effort auto` después del último `/marcha` | Ver `mods/marchas/README.md` |
| Rewind a antes de un cambio de marcha | La banda puede mostrar la marcha nueva aunque el mensaje de postura se haya ido (issue #163) | Repetí `/marcha <marcha>` |
| Una `ruta de riesgo` sin review limpio | `puente-gentle` frena el merge y dice qué agente despachar | Despachá el review que falta con `orca-stack revisar <pr> <agente>` |

## 6. Manejo: operación y problemas

### Día a día

```bash
orca-stack doctor                    # verificación diaria, desde la raíz del proyecto
orca-stack despachar 12 agy          # ticket -> worker
orca-stack vigilar 12 13 14          # Monitor de la tanda [solo en main]
orca-stack revisar 15 pi             # review del PR #15
orca-stack rebote 15                 # relanzar al autor
orca-stack sesiones                  # para /retro
```

`/tablero` en Claude Code muestra PRs, checks, reviews y worktrees de un vistazo; `/marcha` muestra la marcha actual.

### Cómo leer `doctor`

`✖` es una falla (código 1), `⚠` un aviso (código 0) con el comando que lo arregla. Revisa: autodiagnóstico de cada wrapper (`--orca-stack-self-test`), versiones de Pi (`1.2.0` o más nueva) y paquetes (gentle-pi `4.2.0`, pi-claude-bridge `0.9.2`), login de Pi (se omite con `--offline`), mods en `CLAUDE_CODE_PLUGIN_DIRS`; avisa si están activos los plugins `ponytail` o `caveman` de Claude Code (sus hooks duplican el control de Orca); scripts de `despacho` que no existen, deriva (plugin de Matt por debajo de 1.3.1, skills duplicadas, bloque viejo de `CLAUDE.md`, bloque de gentle-ai reescrito), `engram` anterior a 3.4.0, y en Windows con `codex` en uso, la lectura de acentos. También avisa si falta `"setup": "completo"`. **Corrélo desde la raíz del proyecto**: algunas comprobaciones dependen de la config de ese repo.

### Dónde vive el estado

| Qué | Dónde |
| --- | --- |
| Registro de lo instalado (lo usa `remove`) | `~/.orca-stack/state.json` |
| Configuración personal | `~/.orca-stack/config.json` |
| Respaldos | `~/.orca-stack/backups/<fecha>/` (nunca al lado del archivo) |
| Copia del CLI y de `gentle` | `~/.orca-stack/cli/`, `~/.orca-stack/gentle/orchestrator.md` |
| Política y wrappers | `~/orca/stack/` (`ORCA-STACK.md`, `ROLE-BRIEFS.md`, `scripts/`) |
| Briefs de despacho y review | `~/orca/briefs/` |
| Mods | `~/.claude/mods/` y `env.CLAUDE_CODE_PLUGIN_DIRS` en `~/.claude/settings.json` |
| Skills | `~/.claude/skills/` y `~/.agents/skills/` |
| Consultas ya reportadas | `<repo>/.git/orca-stack/consultas-reportadas.json` |
| Cursor de `vigilar` | `<git-common-dir>/orca-stack/vigilar.json` `[solo en main]` |
| Merges registrados por `main` | `<git-common-dir>/orca-stack/vigilar-merges.json` `[solo en main]` |
| Perfil de pi fijado por worktree | `.pi/gentle-ai/profile.json` (fuera de git, vía `info/exclude`) y `<git-common-dir>/gentle-ai/profile-pin.json` (el del clon gana) |

Para no tocar tu carpeta personal al probar: `ORCA_STACK_HOME=/ruta/temporal orca-stack global`.

### Problemas frecuentes

| Síntoma | Arreglo |
| --- | --- |
| Los mods no aparecen | Reiniciá Claude Code y corré `doctor` |
| Un mod viejo y uno nuevo cargan a la vez | Dejá solo las carpetas de `~/.claude/mods/` en `CLAUDE_CODE_PLUGIN_DIRS` |
| Gentle Shell no responde | `pi` y después `/login` |
| `pi install` de gentle-pi falla en Windows | Instalá Go 1.25.10 o más nuevo y ponelo en el `PATH` |
| `Hay más de un bloque orca-stack:begin` | Dejá uno solo y repetí el comando |
| La guardia no bloquea nada | No hay `despacho` en ninguna capa, o la fecha `hasta` ya pasó |
| Un agente no puede correr una skill de Matt | Esas skills solo se activan cuando una persona escribe el comando |

La tabla completa está en la [guía de setup](guia-setup.md#parte-6-problemas-comunes).

### Actualizar y desinstalar

- **Actualizar:** volvé a correr `global` con la versión nueva (`npx github:Gagaismo/orca-stack#<tag> global`). Es idempotente. Gentle Shell se actualiza así también. Tras `gentle-ai sync`, volvé a correr `global`. Abrí una sesión nueva de Claude Code para que carguen los mods.
- **Desinstalar:** `orca-stack remove` (y `--with-pi` si querés sacar lo de Pi). Conserva los respaldos y tu `config.json` editado.
- **Probar sin riesgo:** `--dry-run` en cualquier comando que escribe.

## 7. Qué hay solo en `main`

Marca usada en todo el manual: **`[solo en main]`** = mergeado después del tag `v0.11.0`, todavía no publicado en un release.

| Cambio | PR | Qué trae |
| --- | --- | --- |
| `/effort`: elegir en el menú el mismo nivel no cuenta como ajuste manual | #200 (#194) | Mod `marchas`; ver [4.6](#46-marchas) |
| Brief del worker: `gh issue view <n> --json title,body,comments` y la instrucción de `CODING_STANDARDS.md` solo si el repo lo tiene | #201 (#196) | `assets/stack/brief-ticket.md` y `brief-revision.md` |
| `despachar` imprime `Rama: <rama>`; despachar, revisar y rebote inspeccionan la pantalla de lanzamiento | #203 (#198) | Ver [4.1](#41-comandos-del-cli) |
| `orca-stack vigilar` y `vigilar --merge-de-main`; el contrato (pasos 5 y 7) los nombra | #204 (#195) | Ver [`vigilar`](#vigilar-solo-en-main) |
| `orca-stack reanudar` retoma workers pausados; el contrato nombra `worker-en-pausa` | #214 | Ver [`reanudar`](#reanudar) |
| Chequeo de nombres de test de `## Evidencia` en CI | #202 | Job `evidencia` de CI, exigido por `ci-ok`; ver [4.10](#410-el-chequeo-de--evidencia-en-ci-solo-en-main) |

Cuando salga el próximo release, esta sección se vacía y las marcas se sacan.
